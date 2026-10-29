/**
 * Fuzz tests: seeded mutations of valid fixtures (bit flips, truncation, length-field corruption, random
 * splices) and the malformed corpus are fed to every parser that handles untrusted input.
 * Each parser must return a result (never throw) and finish quickly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTagTree,
  extractOverlays,
  parseInstance,
  parseLutSequences,
  readDicomdir,
  rleHeaderValid,
  splitDeflatedPart10,
} from '@clinic/dicom-core';
import { safeZipPath } from '../../apps/desktop/main/zip-path';
import { FIXTURES, filesIn, inflater } from '../unit/helpers/fixtures.js';

const SEEDS = Number(process.env.FUZZ_ITERATIONS ?? 60);
const MAX_MS_PER_CASE = 2000;

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

function mutate(src: Uint8Array, seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(src);
  const kind = seed % 5;
  if (kind === 0) {
    // random bit flips (header area is most interesting)
    for (let k = 0; k < 1 + Math.floor(r() * 16); k++) {
      const i = 128 + Math.floor(r() * Math.min(out.length - 128, 4096));
      out[i]! ^= 1 << Math.floor(r() * 8);
    }
    return out;
  }
  if (kind === 1) return out.subarray(0, Math.floor(r() * out.length)); // truncation
  if (kind === 2) {
    // corrupt 16/32-bit length fields with extreme values
    const dv = new DataView(out.buffer);
    for (let k = 0; k < 4; k++) {
      const i = 132 + Math.floor(r() * Math.min(out.length - 140, 2048));
      dv.setUint32(i, [0xffffffff, 0x7fffffff, 0, 0xfffe][Math.floor(r() * 4)]!, true);
    }
    return out;
  }
  if (kind === 3) {
    // splice random bytes into the dataset
    const at = 132 + Math.floor(r() * Math.min(out.length - 132, 2048));
    const junk = Uint8Array.from({ length: 1 + Math.floor(r() * 64) }, () => Math.floor(r() * 256));
    const res = new Uint8Array(out.length + junk.length);
    res.set(out.subarray(0, at));
    res.set(junk, at);
    res.set(out.subarray(at), at + junk.length);
    return res;
  }
  // duplicate a header chunk (nested/odd structures)
  const a = 132 + Math.floor(r() * Math.min(out.length - 132, 1024));
  const len = Math.min(Math.floor(r() * 256), out.length - a);
  const res = new Uint8Array(out.length + len);
  res.set(out.subarray(0, a + len));
  res.set(out.subarray(a, a + len), a + len);
  res.set(out.subarray(a + len), a + 2 * len);
  return res;
}

const lookup = (): undefined => undefined;

function runAll(bytes: Uint8Array): void {
  const opts = { fileId: 'fuzz0000', fileName: 'fuzz', fileSize: bytes.length, inflater };
  const t0 = performance.now();
  const r = parseInstance(bytes, opts);
  expect(typeof r.ok).toBe('boolean');
  expect(buildTagTree(bytes, { lookup, inflater }).nodes).toBeInstanceOf(Array);
  expect(extractOverlays(bytes, 1, inflater)).toBeInstanceOf(Array);
  expect(readDicomdir(bytes).ok === true || readDicomdir(bytes).ok === false).toBe(true);
  expect(parseLutSequences(bytes).voi).toBeInstanceOf(Array);
  splitDeflatedPart10(bytes);
  rleHeaderValid(bytes, 2);
  expect(performance.now() - t0).toBeLessThan(MAX_MS_PER_CASE);
}

const SOURCES = [
  'ts-explicit-le',
  'ts-implicit-le',
  'ts-explicit-be',
  'ts-deflated',
  'ts-rle',
  'ts-j2k',
  'enhanced-mr',
  'overlay',
  'modality-lut',
  'turkish-148',
  'iso2022',
  'sr',
  'us-regions',
];

describe('fuzz: mutated fixtures never throw or hang', () => {
  for (const id of SOURCES) {
    it(id, () => {
      const file = filesIn(id).find((f) => f.endsWith('.dcm'))!;
      const src = new Uint8Array(readFileSync(file));
      for (let seed = 1; seed <= SEEDS; seed++) runAll(mutate(src, seed * 7919 + id.length));
    });
  }
  it('DICOMDIR', () => {
    const src = new Uint8Array(readFileSync(path.join(FIXTURES, 'dicomdir-set', 'DICOMDIR')));
    for (let seed = 1; seed <= SEEDS; seed++) runAll(mutate(src, seed));
  });
});

describe('malformed corpus', () => {
  it('every file is handled without throwing', () => {
    const dir = path.join(FIXTURES, 'malformed');
    for (const name of readdirSync(dir)) runAll(new Uint8Array(readFileSync(path.join(dir, name))));
  });
});

describe('ZIP entry names', () => {
  it('rejects absolute and traversal paths, accepts nested relative paths', () => {
    for (const bad of ['../x.dcm', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'a\\..\\..\\x', '..', 'a/b:c', '']) {
      expect(safeZipPath(bad), bad).toBeUndefined();
    }
    expect(safeZipPath('study/a/IMG1.dcm')).toEqual(['study', 'a', 'IMG1.dcm']);
    expect(safeZipPath('./x/y.dcm')).toEqual(['x', 'y.dcm']);
    const r = rng(99);
    for (let k = 0; k < 2000; k++) {
      const name = Array.from({ length: 1 + Math.floor(r() * 24) }, () => String.fromCharCode(32 + Math.floor(r() * 95))).join('');
      const parts = safeZipPath(name);
      if (parts) for (const p of parts) expect(p === '..' || p === '' || /[\\/]/.test(p)).toBe(false);
    }
  });
});
