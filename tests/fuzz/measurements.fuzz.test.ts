/**
 * Saved measurement files are read back from disk and arrive over IPC, so they are untrusted input.
 * Seeded mutations of a valid file must be accepted only when they still satisfy the schema and must never throw;
 * the store must turn unreadable, oversized or foreign files into "no measurements".
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MeasurementFileSchema, type MeasurementFile } from '../../apps/desktop/shared/schemas';
import { MeasurementStore } from '../../apps/desktop/main/measurements';

const SEEDS = Number(process.env.FUZZ_ITERATIONS ?? 60) * 5;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALID: MeasurementFile = {
  version: 1,
  studyInstanceUid: '1.2.826.0.1.3680043.8.498.1',
  calibrations: { '1.2.826.0.1.3680043.8.498.2': { rowMm: 0.5, columnMm: 0.5 } },
  items: [
    {
      id: 'a1',
      tool: 'length',
      sopInstanceUid: '1.2.3.4',
      points: [
        [10, 20],
        [30.5, 40.25],
      ],
    },
    {
      id: 'a2',
      tool: 'freehand',
      sopInstanceUid: '1.2.3.5',
      frame: 3,
      closed: true,
      points: [
        [1, 1],
        [5, 1],
        [5, 5],
      ],
    },
    {
      id: 'a3',
      tool: 'arrow',
      sopInstanceUid: '1.2.3.4',
      label: 'Lezyon İğne',
      name: 'Not',
      points: [
        [0, 0],
        [9, 9],
      ],
    },
  ],
};

/** Replaces a random value somewhere in the JSON tree with a hostile one. */
function mutate(seed: number): unknown {
  const r = rng(seed);
  const doc = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
  const hostile: unknown[] = [
    null,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    '',
    'x'.repeat(10_000),
    '../../etc/passwd',
    '__proto__',
    [],
    {},
    { __proto__: { polluted: true } },
    [[Number.MAX_VALUE, 1]],
    Array.from({ length: 6000 }, () => [0, 0]),
    true,
  ];
  const paths: (string | number)[][] = [];
  const walk = (v: unknown, p: (string | number)[]): void => {
    paths.push(p);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i]));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], [...p, k]);
  };
  walk(doc, []);
  const target = paths[1 + Math.floor(r() * (paths.length - 1))]!;
  let parent: Record<string | number, unknown> = doc;
  for (const k of target.slice(0, -1)) parent = parent[k] as Record<string | number, unknown>;
  parent[target[target.length - 1]!] = hostile[Math.floor(r() * hostile.length)];
  return doc;
}

describe('measurement file schema under mutation', () => {
  it('accepts the valid file', () => {
    expect(MeasurementFileSchema.safeParse(VALID).success).toBe(true);
  });

  it(`never throws and rejects out-of-range values (${SEEDS} cases)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = mutate(seed);
      const r = MeasurementFileSchema.safeParse(doc);
      if (!r.success) continue;
      // Anything accepted must still be within the documented limits.
      expect(r.data.items.length).toBeLessThanOrEqual(5000);
      for (const it of r.data.items) {
        expect(it.points.length).toBeLessThanOrEqual(5000);
        for (const p of it.points) for (const v of p) expect(Number.isFinite(v)).toBe(true);
        expect(it.sopInstanceUid).toMatch(/^[0-9.]{1,64}$/);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });
});

describe('measurement store', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cdv-measure-fuzz-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const store = new MeasurementStore(dir);

  it('round-trips a file and deletes it when empty', async () => {
    await store.save(VALID);
    expect(await store.load(VALID.studyInstanceUid)).toEqual(VALID);
    await store.save({ ...VALID, calibrations: {}, items: [] });
    expect(await store.load(VALID.studyInstanceUid)).toBeNull();
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('treats corrupt, mismatched and oversized files as absent', async () => {
    await store.save(VALID);
    const file = path.join(
      dir,
      readdirSync(dir).find((f) => f.endsWith('.json'))!,
    );
    for (const content of [
      '',
      '{',
      'null',
      '[]',
      JSON.stringify({ ...VALID, version: 2 }),
      JSON.stringify({ ...VALID, studyInstanceUid: '9.9' }),
    ]) {
      writeFileSync(file, content);
      expect(await store.load(VALID.studyInstanceUid)).toBeNull();
    }
    writeFileSync(file, ' '.repeat(17 * 1024 * 1024));
    expect(await store.load(VALID.studyInstanceUid)).toBeNull();
    for (let seed = 1; seed <= 40; seed++) {
      writeFileSync(file, JSON.stringify(mutate(seed)));
      const loaded = await store.load(VALID.studyInstanceUid);
      expect(loaded === null || MeasurementFileSchema.safeParse(loaded).success).toBe(true);
    }
  });
});
