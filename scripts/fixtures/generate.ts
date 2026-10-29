/**
 * Synthetic DICOM fixture generator. Deterministic; no real patient data.
 * Output: tests/fixtures/generated/** and manifest.json (expected values used by tests).
 *
 * Usage: npm run fixtures            (regenerates only when generator sources changed)
 *        npm run fixtures -- --force
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, configure } from '@zip.js/zip.js';
import {
  SOP,
  el,
  fmtDS,
  patientStudySeries,
  pixelModule,
  planeModule,
  rescaleModule,
  rng,
  seq,
  series,
  sopCommon,
  study,
  u16le,
  windowModule,
  type PatientStudy,
  type PixelDesc,
  type SeriesInfo,
} from './lib/builders.js';
import {
  encodeHTJ2K,
  encodeJ2K,
  encodeJpegBaseline,
  encodeJpegLS,
  encodeJpegLosslessSV1,
  encodeRle,
} from './lib/encoders.js';
import { type Element, TSUID, encodeDataset, latin5, part10HeaderLength, tag, uid, utf8, writePart10 } from './lib/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'generated');
const STAMP = path.join(FIXTURE_DIR, '.stamp');

configure({ useWebWorkers: false });

type Vec3 = [number, number, number];

interface ManifestEntry {
  id: string;
  dir: string;
  description: string;
  kind: 'valid' | 'malformed' | 'nonDicom' | 'archive';
  files: number;
  expect?: Record<string, unknown>;
}
const manifest: ManifestEntry[] = [];

async function save(rel: string, bytes: Uint8Array): Promise<void> {
  const p = path.join(FIXTURE_DIR, rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, bytes);
}

function add(entry: ManifestEntry): void {
  manifest.push(entry);
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

const v = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dist2: (a: Vec3, b: Vec3): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
};

/** Samples f at each pixel centre of a plane: P = ipp + row·Δc·c + col·Δr·r. */
function renderPlane(
  rows: number,
  cols: number,
  ipp: Vec3,
  rowDir: Vec3,
  colDir: Vec3,
  spacing: number,
  f: (p: Vec3) => number,
): number[] {
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++) {
    const base = v.add(ipp, v.scale(colDir, spacing * r));
    for (let c = 0; c < cols; c++) out[r * cols + c] = f(v.add(base, v.scale(rowDir, spacing * c)));
  }
  return out;
}

function rotX(a: number, p: Vec3): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
}
function rotZ(a: number, p: Vec3): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
}

// ---------------------------------------------------------------------------------------------
// Phantoms
// ---------------------------------------------------------------------------------------------

/** CT phantom spheres (HU, centre, radius mm) inside a water cylinder (r = 100 mm) in air. */
export const CT_SPHERES: { hu: number; center: Vec3; radius: number }[] = [
  { hu: 1000, center: [-50, -40, 0], radius: 10 },
  { hu: 100, center: [50, -40, 0], radius: 15 },
  { hu: -100, center: [0, 50, 0], radius: 20 },
  { hu: 50, center: [0, 0, -40], radius: 7.5 },
];
function ctPhantomHU(p: Vec3): number {
  for (const s of CT_SPHERES) if (v.dist2(p, s.center) <= s.radius * s.radius) return s.hu;
  return p[0] * p[0] + p[1] * p[1] <= 100 * 100 ? 0 : -1000;
}

/** Asymmetric orientation phantom: big marker at Left-Anterior-Head, small one at Right-Posterior-Foot. */
export const ORIENT_MARKERS = {
  big: { center: [60, -60, 40] as Vec3, radius: 25, value: 1000 },
  small: { center: [-60, 40, -40] as Vec3, radius: 12, value: 600 },
};
function orientPhantom(p: Vec3): number {
  const { big, small } = ORIENT_MARKERS;
  if (v.dist2(p, big.center) <= big.radius ** 2) return big.value;
  if (v.dist2(p, small.center) <= small.radius ** 2) return small.value;
  const e = (p[0] / 100) ** 2 + (p[1] / 110) ** 2 + (p[2] / 90) ** 2;
  return e <= 1 ? 200 : 0;
}

/** Shepp-Logan-like 2D pattern, unsigned 12-bit. */
function pattern2D(rows: number, cols: number): number[] {
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c - cols / 2) / (cols / 2);
      const y = (r - rows / 2) / (rows / 2);
      let val = 0;
      if ((x / 0.69) ** 2 + (y / 0.92) ** 2 <= 1) val = 2000;
      if ((x / 0.62) ** 2 + ((y + 0.02) / 0.87) ** 2 <= 1) val = 1200;
      if (((x - 0.22) / 0.11) ** 2 + (y / 0.31) ** 2 <= 1) val = 600;
      if (((x + 0.22) / 0.16) ** 2 + (y / 0.41) ** 2 <= 1) val = 700;
      if ((x / 0.21) ** 2 + ((y + 0.35) / 0.25) ** 2 <= 1) val = 1600;
      if (x > 0.5 && y < -0.6) val = 4000; // asymmetric corner marker (top-right)
      out[r * cols + c] = Math.min(4095, val + ((r * 7 + c * 3) % 50));
    }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Generic writers
// ---------------------------------------------------------------------------------------------

interface SliceSpec {
  ipp?: Vec3;
  iop?: [number, number, number, number, number, number];
  instanceNumber: number;
  values: ArrayLike<number>;
  extra?: Element[];
  fileName?: string;
}

async function writeStack(
  dir: string,
  ps: PatientStudy,
  s: SeriesInfo,
  sopClass: string,
  pixel: Omit<PixelDesc, 'numberOfFrames'>,
  spacing: [number, number] | undefined,
  thickness: number | undefined,
  slices: SliceSpec[],
  common: Element[] = [],
  ts: string = TSUID.explicitLE,
): Promise<number> {
  for (const sl of slices) {
    const sop = uid(`sop:${s.seriesUid}:${sl.instanceNumber}:${sl.fileName ?? ''}`);
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(sopClass, sop, sl.instanceNumber),
      ...planeModule(sl.ipp, sl.ipp ? sl.iop : undefined, spacing, thickness),
      ...common,
      ...(sl.extra ?? []),
      ...pixelModule(pixel, pixel.bitsAllocated === 16 ? u16le(sl.values) : Uint8Array.from(sl.values)),
    ];
    await save(path.join(dir, sl.fileName ?? `IM${String(sl.instanceNumber).padStart(4, '0')}.dcm`), writePart10(ds, { transferSyntaxUid: ts }));
  }
  return slices.length;
}

const MONO16: Omit<PixelDesc, 'numberOfFrames'> = {
  rows: 0,
  columns: 0,
  bitsAllocated: 16,
  bitsStored: 12,
  pixelRepresentation: 0,
  samplesPerPixel: 1,
  photometric: 'MONOCHROME2',
};

// ---------------------------------------------------------------------------------------------
// Fixture groups
// ---------------------------------------------------------------------------------------------

async function ctPhantom(): Promise<void> {
  const ps = study('ctphantom', { studyDescription: 'CT PHANTOM' });
  const s = { ...series('ctphantom', 2, 'CT', 'PHANTOM 2.5mm'), bodyPart: 'HEAD' };
  const rows = 512, cols = 512, spacing = 0.5, origin: Vec3 = [-128, -128, -80];
  const slices: SliceSpec[] = [];
  for (let k = 0; k < 64; k++) {
    const ipp: Vec3 = [origin[0], origin[1], origin[2] + 2.5 * k];
    const hu = renderPlane(rows, cols, ipp, [1, 0, 0], [0, 1, 0], spacing, ctPhantomHU);
    slices.push({ ipp, iop: [1, 0, 0, 0, 1, 0], instanceNumber: k + 1, values: hu.map((h) => h + 1024) });
  }
  const n = await writeStack('ct-phantom', ps, s, SOP.ct, { ...MONO16, rows, columns: cols }, [spacing, spacing], 2.5, slices, [
    ...rescaleModule(-1024, 1, 'HU'),
    ...windowModule([40], [80], ['BRAIN']),
    el(0x0018, 0x0060, 'DS', '120'),
    el(0x0008, 0x0008, 'CS', ['ORIGINAL', 'PRIMARY', 'AXIAL']),
  ]);
  // Pixel (column c, row r) centre: x = −128 + 0.5c, y = −128 + 0.5r; slice k: z = −80 + 2.5k.
  add({
    id: 'ct-phantom',
    dir: 'ct-phantom',
    kind: 'valid',
    files: n,
    description: 'CT 512×512×64, 0.5 mm pixels, 2.5 mm slices; spheres of known HU in water cylinder',
    expect: {
      spheres: CT_SPHERES,
      pixelSpacing: 0.5,
      sliceSpacing: 2.5,
      probes: CT_SPHERES.filter((x) => (x.center[2] + 80) % 2.5 === 0).map((x) => ({
        slice: (x.center[2] + 80) / 2.5,
        column: (x.center[0] + 128) / 0.5,
        row: (x.center[1] + 128) / 0.5,
        hu: x.hu,
      })),
    },
  });
}

async function ctLarge(): Promise<void> {
  const ps = study('ctlarge', { studyDescription: 'CT PERFORMANCE' });
  const s = series('ctlarge', 3, 'CT', 'LARGE 520 SLICES');
  const rows = 512, cols = 512, N = 520;
  const base = new Uint16Array(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const d2 = (r - 256) ** 2 + (c - 256) ** 2;
      base[r * cols + c] = d2 < 230 * 230 ? 1024 + 40 + ((r + c) % 20) : 24;
    }
  for (let k = 0; k < N; k++) {
    const vals = new Uint16Array(base);
    const cr = 256 + Math.round(120 * Math.sin(k / 40));
    for (let r = cr - 30; r < cr + 30; r++) for (let c = 226; c < 286; c++) vals[r * cols + c] = 1024 + 300;
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.ct, uid(`sop:ctlarge:${k}`), k + 1),
      ...planeModule([-128, -128, -300 + 0.6 * k], [1, 0, 0, 0, 1, 0], [0.5, 0.5], 0.6),
      ...rescaleModule(-1024, 1, 'HU'),
      ...windowModule([40], [400]),
      ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(vals)),
    ];
    await save(`ct-large/IM${String(k + 1).padStart(4, '0')}.dcm`, writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
  }
  add({ id: 'ct-large', dir: 'ct-large', kind: 'valid', files: N, description: 'CT 512×512×520 for performance measurement' });
}

async function orientationSeries(): Promise<void> {
  const ps = study('orient', { studyDescription: 'ORIENTATION PHANTOM' });
  const rows = 128, cols = 128, sp = 2;
  const planes: { id: string; n: number; desc: string; row: Vec3; col: Vec3; ipp: (t: number) => Vec3 }[] = [
    { id: 'orient-axial', n: 1, desc: 'AXIAL', row: [1, 0, 0], col: [0, 1, 0], ipp: (t) => [-127, -127, t] },
    { id: 'orient-sagittal', n: 2, desc: 'SAGITTAL', row: [0, 1, 0], col: [0, 0, -1], ipp: (t) => [t, -127, 127] },
    { id: 'orient-coronal', n: 3, desc: 'CORONAL', row: [1, 0, 0], col: [0, 0, -1], ipp: (t) => [-127, t, 127] },
  ];
  for (const pl of planes) {
    const s = series('orient', pl.n, 'MR', pl.desc);
    const slices: SliceSpec[] = [];
    let k = 0;
    for (let t = -88; t <= 88; t += 4) {
      const ipp = pl.ipp(t);
      slices.push({
        ipp,
        iop: [...pl.row, ...pl.col] as SliceSpec['iop'],
        instanceNumber: ++k,
        values: renderPlane(rows, cols, ipp, pl.row, pl.col, sp, orientPhantom),
      });
    }
    const n = await writeStack(pl.id, ps, s, SOP.mr, { ...MONO16, rows, columns: cols }, [sp, sp], 4, slices, windowModule([500], [1000]));
    add({
      id: pl.id,
      dir: pl.id,
      kind: 'valid',
      files: n,
      description: `${pl.desc} slices of the asymmetric phantom (big marker at L-A-H, small at R-P-F)`,
      expect: { markers: ORIENT_MARKERS, row: pl.row, column: pl.col, positions: 'from −88 to 88 step 4 mm along the normal axis' },
    });
  }

  // Oblique: rotate both axes by Rz(20°)·Rx(15°)
  const R = (p: Vec3): Vec3 => rotZ((20 * Math.PI) / 180, rotX((15 * Math.PI) / 180, p));
  const row = R([1, 0, 0]);
  const col = R([0, 1, 0]);
  const normal = v.cross(row, col);
  const s = series('orient', 4, 'MR', 'OBLIQUE 20/15');
  const slices: SliceSpec[] = [];
  let k = 0;
  for (let t = -60; t <= 60; t += 3) {
    const center = v.scale(normal, t);
    const ipp = v.add(center, v.add(v.scale(row, -127), v.scale(col, -127)));
    slices.push({
      ipp,
      iop: [...row, ...col] as SliceSpec['iop'],
      instanceNumber: ++k,
      values: renderPlane(rows, cols, ipp, row, col, sp, orientPhantom),
    });
  }
  const n = await writeStack('oblique', ps, s, SOP.mr, { ...MONO16, rows, columns: cols }, [sp, sp], 3, slices, windowModule([500], [1000]));
  add({ id: 'oblique', dir: 'oblique', kind: 'valid', files: n, description: 'Oblique stack (Rz 20°, Rx 15°)', expect: { row, column: col } });
}

async function geometryEdgeCases(): Promise<void> {
  const ps = study('geom', { studyDescription: 'GEOMETRY EDGE CASES' });
  const rows = 64, cols = 64;
  const vals = (k: number): number[] => Array.from({ length: rows * cols }, (_, i) => ((i % cols) + k * 10) % 4096);

  // Gantry tilt 15°: IOP column tilted, IPP progresses along z only.
  {
    const t = (15 * Math.PI) / 180;
    const iop: SliceSpec['iop'] = [1, 0, 0, 0, Math.cos(t), -Math.sin(t)];
    const s = series('geom', 1, 'CT', 'TILT 15');
    const slices = Array.from({ length: 20 }, (_, k): SliceSpec => ({
      ipp: [-32, -32, 5 * k],
      iop,
      instanceNumber: k + 1,
      values: vals(k),
    }));
    const n = await writeStack('gantry-tilt', ps, s, SOP.ct, { ...MONO16, rows, columns: cols }, [1, 1], 5, slices, [
      ...rescaleModule(-1024, 1),
      el(0x0018, 0x1120, 'DS', '15'),
    ]);
    add({ id: 'gantry-tilt', dir: 'gantry-tilt', kind: 'valid', files: n, description: 'CT with 15° gantry tilt', expect: { tiltDeg: 15, warning: 'gantryTilt' } });
  }
  // Non-uniform: one missing slice and one irregular gap
  {
    const zs = [0, 2, 4, 6, 10, 12, 14, 16.6, 18.6, 20.6];
    const s = series('geom', 2, 'CT', 'NONUNIFORM');
    const slices = zs.map((z, k): SliceSpec => ({ ipp: [-32, -32, z], iop: [1, 0, 0, 0, 1, 0], instanceNumber: k + 1, values: vals(k) }));
    const n = await writeStack('nonuniform', ps, s, SOP.ct, { ...MONO16, rows, columns: cols }, [1, 1], 2, slices, rescaleModule(-1024, 1));
    add({ id: 'nonuniform', dir: 'nonuniform', kind: 'valid', files: n, description: 'Missing slice + irregular spacing', expect: { warnings: ['missingSlices', 'nonUniformSpacing'] } });
  }
  // Shuffled instance numbers and random file names
  {
    const r = rng(42);
    const order = Array.from({ length: 30 }, (_, i) => i).sort(() => r() - 0.5);
    const s = series('geom', 3, 'MR', 'SHUFFLED');
    const slices = order.map((k, i): SliceSpec => ({
      ipp: [-32, -32, 3 * k],
      iop: [1, 0, 0, 0, 1, 0],
      instanceNumber: i + 1,
      values: vals(k),
      fileName: `${Math.floor(r() * 0xffffff).toString(16)}_${i}.dcm`,
    }));
    const n = await writeStack('shuffled', ps, s, SOP.mr, { ...MONO16, rows, columns: cols }, [1, 1], 3, slices);
    add({ id: 'shuffled', dir: 'shuffled', kind: 'valid', files: n, description: 'Instance numbers and file names unrelated to position', expect: { sliceSpacing: 3 } });
  }
  // No geometry
  {
    const s = series('geom', 4, 'OT', 'NO GEOMETRY');
    const slices = [3, 1, 2, 5, 4].map((inst, i): SliceSpec => ({ instanceNumber: inst, values: vals(inst), fileName: `F${i}.dcm` }));
    const n = await writeStack('no-geometry', ps, s, SOP.sc, { ...MONO16, rows, columns: cols }, undefined, undefined, slices);
    add({ id: 'no-geometry', dir: 'no-geometry', kind: 'valid', files: n, description: 'No IPP/IOP: InstanceNumber fallback', expect: { warning: 'sortFallbackInstanceNumber' } });
  }
  // Anisotropic pixels: rows 1.0 mm apart, columns 0.5 mm apart; a 25 mm circle must render round.
  {
    const s = series('geom', 6, 'MR', 'ANISOTROPIC 1.0x0.5');
    const r0 = 128, c0 = 128;
    const vals = Array.from({ length: r0 * c0 }, (_, i) => {
      const r = Math.floor(i / c0), c = i % c0;
      const x = -32 + 0.5 * c;
      const y = -64 + 1.0 * r;
      return x * x + y * y <= 25 * 25 ? 3000 : 200;
    });
    const n = await writeStack('aniso', ps, s, SOP.mr, { ...MONO16, rows: r0, columns: c0 }, [1.0, 0.5], 3, [
      { ipp: [-32, -64, 0], iop: [1, 0, 0, 0, 1, 0], instanceNumber: 1, values: vals },
    ], windowModule([1600], [3200]));
    add({ id: 'aniso', dir: 'aniso', kind: 'valid', files: n, description: 'Anisotropic pixels (row 1.0 mm, column 0.5 mm) with a 25 mm circle', expect: { circleRadiusMm: 25, pixelSpacing: [1.0, 0.5] } });
  }
  // Mixed orientations (3-plane localizer)
  {
    const s = series('geom', 5, 'MR', 'LOCALIZER 3-PLANE');
    const slices: SliceSpec[] = [
      { ipp: [-127, -127, 0], iop: [1, 0, 0, 0, 1, 0], instanceNumber: 1, values: renderPlane(128, 128, [-127, -127, 0], [1, 0, 0], [0, 1, 0], 2, orientPhantom) },
      { ipp: [0, -127, 127], iop: [0, 1, 0, 0, 0, -1], instanceNumber: 2, values: renderPlane(128, 128, [0, -127, 127], [0, 1, 0], [0, 0, -1], 2, orientPhantom) },
      { ipp: [-127, 0, 127], iop: [1, 0, 0, 0, 0, -1], instanceNumber: 3, values: renderPlane(128, 128, [-127, 0, 127], [1, 0, 0], [0, 0, -1], 2, orientPhantom) },
    ];
    const n = await writeStack('mixed-orient', ps, s, SOP.mr, { ...MONO16, rows: 128, columns: 128 }, [2, 2], 5, slices, windowModule([500], [1000]));
    add({ id: 'mixed-orient', dir: 'mixed-orient', kind: 'valid', files: n, description: '3-plane localizer split into 3 display sets', expect: { displaySets: 3 } });
  }
}

async function enhancedMr(): Promise<void> {
  const ps = study('enhmr', { studyDescription: 'ENHANCED MR' });
  const s = series('enhmr', 1, 'MR', 'ENHANCED T1 20 FRAMES');
  const rows = 128, cols = 128, sp = 2, frames = 20;
  const zs = Array.from({ length: frames }, (_, i) => 76 - 8 * i); // stored head → foot (descending)
  const pixels: number[] = [];
  const perFrame: Element[][] = zs.map((z, i) => {
    const ipp: Vec3 = [-127, -127, z];
    pixels.push(...renderPlane(rows, cols, ipp, [1, 0, 0], [0, 1, 0], sp, orientPhantom));
    return [
      seq(0x0020, 0x9111, [[el(0x0020, 0x9157, 'UL', [1, i + 1]), el(0x0020, 0x9056, 'SH', '1'), el(0x0020, 0x9057, 'UL', i + 1)]]),
      seq(0x0020, 0x9113, [[el(0x0020, 0x0032, 'DS', ipp.map(fmtDS))]]),
      seq(0x0028, 0x9132, [[el(0x0028, 0x1050, 'DS', '500'), el(0x0028, 0x1051, 'DS', '1000')]]),
    ];
  });
  const shared: Element[] = [
    seq(0x0020, 0x9116, [[el(0x0020, 0x0037, 'DS', ['1', '0', '0', '0', '1', '0'])]]),
    seq(0x0028, 0x9110, [[el(0x0028, 0x0030, 'DS', ['2', '2']), el(0x0018, 0x0050, 'DS', '8')]]),
    seq(0x0028, 0x9145, [[el(0x0028, 0x1052, 'DS', '0'), el(0x0028, 0x1053, 'DS', '1'), el(0x0028, 0x1054, 'LO', 'US')]]),
  ];
  const ds: Element[] = [
    ...patientStudySeries(ps, s),
    ...sopCommon(SOP.enhancedMr, uid('sop:enhmr'), 1),
    el(0x0008, 0x0008, 'CS', ['ORIGINAL', 'PRIMARY', 'M', 'NONE']),
    seq(0x5200, 0x9229, [shared]),
    seq(0x5200, 0x9230, perFrame),
    ...pixelModule({ ...MONO16, rows, columns: cols, numberOfFrames: frames }, u16le(pixels)),
  ];
  await save('enhanced-mr/ENHMR.dcm', writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
  add({ id: 'enhanced-mr', dir: 'enhanced-mr', kind: 'valid', files: 1, description: 'Enhanced MR, 20 frames stored head→foot, per-frame positions', expect: { frames, sliceSpacing: 8 } });
}

async function pet(): Promise<void> {
  const rows = 128, cols = 128, sp = 4, N = 40;
  const write = async (id: string, complete: boolean): Promise<void> => {
    const ps = study(id, { studyDescription: 'PET-CT SYNTHETIC', ...(complete ? {} : { patientName: 'PHANTOM^PETMISSING' }) });
    const s = series(id, 1, 'PT', complete ? 'PET AC' : 'PET AC (MISSING SUV TAGS)');
    const radio = [
      el(0x0018, 0x0031, 'LO', 'Fluorodeoxyglucose'),
      el(0x0018, 0x1072, 'TM', '093000'),
      el(0x0018, 0x1075, 'DS', '6586.2'),
      el(0x0018, 0x1076, 'DS', '0.97'),
      ...(complete ? [el(0x0018, 0x1074, 'DS', '370000000')] : []),
    ];
    const common: Element[] = [
      el(0x0008, 0x0021, 'DA', '20240305'),
      el(0x0008, 0x0031, 'TM', '102000'),
      el(0x0008, 0x0022, 'DA', '20240305'),
      el(0x0008, 0x0032, 'TM', '102000'),
      el(0x0054, 0x1001, 'CS', 'BQML'),
      el(0x0054, 0x1102, 'CS', 'START'),
      el(0x0028, 0x0051, 'CS', ['ATTN', 'DECY']),
      el(0x0054, 0x1000, 'CS', ['WHOLE BODY', 'IMAGE']),
      seq(0x0054, 0x0016, [radio]),
      ...(complete ? [el(0x0010, 0x1030, 'DS', '70'), el(0x0010, 0x1020, 'DS', '1.75')] : []),
    ];
    for (let k = 0; k < N; k++) {
      const z = -78 + 4 * k;
      const act = renderPlane(rows, cols, [-254, -254, z], [1, 0, 0], [0, 1, 0], sp, (p) =>
        v.dist2(p, [0, 0, 0]) <= 30 * 30 ? 20000 : p[0] ** 2 + p[1] ** 2 <= 150 ** 2 ? 2000 : 0,
      );
      const max = Math.max(...act);
      const slope = max > 0 ? max / 30000 : 1;
      const ds: Element[] = [
        ...patientStudySeries(ps, s),
        ...sopCommon(SOP.pet, uid(`sop:${id}:${k}`), k + 1),
        ...planeModule([-254, -254, z], [1, 0, 0, 0, 1, 0], [sp, sp], 4),
        ...common,
        ...rescaleModule(0, slope),
        ...pixelModule({ ...MONO16, bitsStored: 16, rows, columns: cols }, u16le(act.map((a) => Math.round(a / slope)))),
      ];
      await save(`${id}/IM${String(k + 1).padStart(4, '0')}.dcm`, writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    }
    // SUVbw = C [Bq/ml] × weight [g] / (dose [Bq] × 2^(−Δt/T½)), Δt = series time − injection = 3000 s.
    const decay = 2 ** (-3000 / 6586.2);
    add({
      id,
      dir: id,
      kind: 'valid',
      files: N,
      description: complete ? 'PET BQML with complete SUV tags' : 'PET without patient weight and total dose',
      expect: complete
        ? { suvbwFactor: 70000 / (370000000 * decay), hotBqml: 20000, backgroundBqml: 2000 }
        : { suv: 'refuse', missing: ['PatientWeight', 'RadionuclideTotalDose'] },
    });
  };
  await write('pet', true);
  await write('pet-missing', false);
}

async function projection(): Promise<void> {
  const ps = study('proj', { studyDescription: 'RADIOGRAPHY AND US' });
  // CR: rows → L, columns → F; bright marker on patient Left + Head (screen top-right).
  {
    const rows = 600, cols = 500;
    const vals = Array.from({ length: rows * cols }, (_, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      if (r < 120 && c > 380) return 3800;
      return 800 + Math.round(1200 * Math.exp(-(((c - 250) / 160) ** 2) - ((r - 300) / 220) ** 2));
    });
    const s = series('proj', 1, 'CR', 'CHEST PA');
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.cr, uid('sop:cr'), 1),
      el(0x0018, 0x1164, 'DS', ['0.2', '0.2']),
      el(0x0018, 0x1114, 'DS', '1.1'),
      el(0x0020, 0x0020, 'CS', ['L', 'F']),
      el(0x0018, 0x5101, 'CS', 'PA'),
      ...windowModule([2000], [4000]),
      ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(vals)),
    ];
    await save('cr-mag/CR.dcm', writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id: 'cr-mag', dir: 'cr-mag', kind: 'valid', files: 1, description: 'CR with Imager Pixel Spacing 0.2 mm, magnification 1.1, PatientOrientation L\\F', expect: { imagerPixelSpacing: 0.2, magnification: 1.1, correctedSpacing: 0.2 / 1.1, labels: { left: 'R', right: 'L', top: 'H', bottom: 'F' } } });
  }
  // US RGB with calibrated region
  {
    const rows = 480, cols = 640;
    const rgb = new Uint8Array(rows * cols * 3);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        const inSector = r > 50 && r < 430 && c > 100 && c < 540;
        const g = inSector ? 40 + ((r * 13 + c * 7) % 90) : 0;
        const doppler = (r - 240) ** 2 + (c - 320) ** 2 < 40 ** 2;
        rgb[i] = doppler ? 220 : g;
        rgb[i + 1] = doppler ? 30 : g;
        rgb[i + 2] = doppler ? 30 : g;
      }
    const s = series('proj', 2, 'US', 'ABDOMEN US');
    const region = [
      el(0x0018, 0x6012, 'US', 1),
      el(0x0018, 0x6014, 'US', 1),
      el(0x0018, 0x6016, 'UL', 0),
      el(0x0018, 0x6018, 'UL', 100),
      el(0x0018, 0x601a, 'UL', 50),
      el(0x0018, 0x601c, 'UL', 540),
      el(0x0018, 0x601e, 'UL', 430),
      el(0x0018, 0x6024, 'US', 3),
      el(0x0018, 0x6026, 'US', 3),
      el(0x0018, 0x602c, 'FD', 0.02),
      el(0x0018, 0x602e, 'FD', 0.02),
    ];
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.us, uid('sop:us'), 1),
      seq(0x0018, 0x6011, [region]),
      ...pixelModule({ rows, columns: cols, bitsAllocated: 8, bitsStored: 8, pixelRepresentation: 0, samplesPerPixel: 3, photometric: 'RGB', planarConfiguration: 0 }, rgb),
    ];
    await save('us-regions/US.dcm', writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id: 'us-regions', dir: 'us-regions', kind: 'valid', files: 1, description: 'US RGB with one calibrated region (0.2 mm/px)', expect: { deltaCm: 0.02 } });
  }
}

function colorWheel(rows: number, cols: number): Uint8Array {
  const out = new Uint8Array(rows * cols * 3);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      out[i] = Math.round((255 * c) / (cols - 1));
      out[i + 1] = Math.round((255 * r) / (rows - 1));
      out[i + 2] = r < rows / 4 && c > (3 * cols) / 4 ? 255 : 64;
    }
  return out;
}

async function photometric(): Promise<void> {
  const ps = study('photo', { studyDescription: 'PHOTOMETRIC VARIANTS' });
  const rows = 128, cols = 128;
  const rgb = colorWheel(rows, cols);
  const color = (pi: string, planar: 0 | 1 = 0): PixelDesc => ({ rows, columns: cols, bitsAllocated: 8, bitsStored: 8, pixelRepresentation: 0, samplesPerPixel: 3, photometric: pi, planarConfiguration: planar });
  const write = async (id: string, n: number, desc: string, ds: Element[]): Promise<void> => {
    const s = series('photo', n, 'OT', desc);
    const full: Element[] = [...patientStudySeries(ps, s), ...sopCommon(SOP.sc, uid(`sop:${id}`), 1), el(0x0008, 0x0064, 'CS', 'WSD'), ...ds];
    await save(`${id}/IMG.dcm`, writePart10(full, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id, dir: id, kind: 'valid', files: 1, description: desc });
  };
  await write('rgb', 1, 'RGB planar 0', pixelModule(color('RGB'), rgb));
  const planar = new Uint8Array(rgb.length);
  for (let i = 0; i < rows * cols; i++) for (let k = 0; k < 3; k++) planar[k * rows * cols + i] = rgb[i * 3 + k]!;
  await write('rgb-planar', 2, 'RGB planar 1', pixelModule(color('RGB', 1), planar));
  const ybr = new Uint8Array(rgb.length);
  for (let i = 0; i < rows * cols; i++) {
    const R = rgb[i * 3]!, G = rgb[i * 3 + 1]!, B = rgb[i * 3 + 2]!;
    const clamp = (x: number): number => Math.max(0, Math.min(255, Math.round(x)));
    ybr[i * 3] = clamp(0.299 * R + 0.587 * G + 0.114 * B);
    ybr[i * 3 + 1] = clamp(-0.168736 * R - 0.331264 * G + 0.5 * B + 128);
    ybr[i * 3 + 2] = clamp(0.5 * R - 0.418688 * G - 0.081312 * B + 128);
  }
  await write('ybr-full', 3, 'YBR_FULL', pixelModule(color('YBR_FULL'), ybr));
  // Palette colour: 8-bit indices, 256-entry 16-bit LUTs (red → green ramp)
  const idx = Uint8Array.from({ length: rows * cols }, (_, i) => i % cols * 2);
  const lut = (f: (i: number) => number): Uint8Array => u16le(Array.from({ length: 256 }, (_, i) => f(i) * 257));
  await write('palette', 4, 'PALETTE COLOR', [
    el(0x0028, 0x1101, 'US', [256, 0, 16]),
    el(0x0028, 0x1102, 'US', [256, 0, 16]),
    el(0x0028, 0x1103, 'US', [256, 0, 16]),
    { tag: tag(0x0028, 0x1201), vr: 'OW', value: lut((i) => 255 - i) },
    { tag: tag(0x0028, 0x1202), vr: 'OW', value: lut((i) => i) },
    { tag: tag(0x0028, 0x1203), vr: 'OW', value: lut(() => 40) },
    ...pixelModule({ rows, columns: cols, bitsAllocated: 8, bitsStored: 8, pixelRepresentation: 0, samplesPerPixel: 1, photometric: 'PALETTE COLOR' }, idx),
  ]);
  // MONOCHROME1 (low values display white)
  const mono1 = pattern2D(rows, cols);
  await write('mono1', 5, 'MONOCHROME1', [...windowModule([2048], [4096]), ...pixelModule({ ...MONO16, rows, columns: cols, photometric: 'MONOCHROME1' }, u16le(mono1))]);
}

async function transferSyntaxes(): Promise<void> {
  const ps = study('ts', { studyDescription: 'TRANSFER SYNTAXES' });
  const rows = 256, cols = 256;
  const img = pattern2D(rows, cols);
  const bytes16 = u16le(img);
  const img8 = Uint8Array.from(img, (x) => Math.round(x / 16));
  const info12 = { width: cols, height: rows, bitsPerSample: 12, componentCount: 1, isSigned: false };
  const variants: { id: string; ts: string; desc: string; pixel: () => Promise<Element['value']>; bits?: 8 }[] = [
    { id: 'ts-implicit-le', ts: TSUID.implicitLE, desc: 'Implicit VR LE', pixel: async () => bytes16 },
    { id: 'ts-explicit-le', ts: TSUID.explicitLE, desc: 'Explicit VR LE', pixel: async () => bytes16 },
    { id: 'ts-explicit-be', ts: TSUID.explicitBE, desc: 'Explicit VR BE', pixel: async () => bytes16 },
    { id: 'ts-deflated', ts: TSUID.deflated, desc: 'Deflated explicit LE', pixel: async () => bytes16 },
    { id: 'ts-rle', ts: TSUID.rle, desc: 'RLE Lossless', pixel: async () => ({ fragments: [encodeRle(bytes16, cols, rows, 16, 1)] }) },
    { id: 'ts-jpeg-lossless', ts: TSUID.jpegLosslessSV1, desc: 'JPEG Lossless SV1', pixel: async () => ({ fragments: [encodeJpegLosslessSV1(img, cols, rows, 12)] }) },
    { id: 'ts-jpeg-ls', ts: TSUID.jpegLS, desc: 'JPEG-LS lossless', pixel: async () => ({ fragments: [await encodeJpegLS(bytes16, info12)] }) },
    { id: 'ts-j2k', ts: TSUID.j2kLossless, desc: 'JPEG 2000 lossless', pixel: async () => ({ fragments: [await encodeJ2K(bytes16, info12)] }) },
    { id: 'ts-htj2k', ts: TSUID.htj2kLossless, desc: 'HTJ2K lossless', pixel: async () => ({ fragments: [await encodeHTJ2K(bytes16, info12)] }) },
    {
      id: 'ts-jpeg-baseline',
      ts: TSUID.jpegBaseline,
      desc: 'JPEG baseline 8-bit',
      bits: 8,
      pixel: async () => ({ fragments: [await encodeJpegBaseline(img8, { width: cols, height: rows, bitsPerSample: 8, componentCount: 1, isSigned: false })] }),
    },
  ];
  let n = 0;
  for (const variant of variants) {
    n++;
    const s = series('ts', n, 'MR', variant.desc);
    const pixelDesc: PixelDesc = variant.bits === 8
      ? { rows, columns: cols, bitsAllocated: 8, bitsStored: 8, pixelRepresentation: 0, samplesPerPixel: 1, photometric: 'MONOCHROME2' }
      : { ...MONO16, rows, columns: cols };
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.mr, uid(`sop:${variant.id}`), 1),
      ...planeModule([-127, -127, 0], [1, 0, 0, 0, 1, 0], [1, 1], 3),
      ...windowModule(variant.bits === 8 ? [128] : [2048], variant.bits === 8 ? [256] : [4096]),
      ...pixelModule(pixelDesc, await variant.pixel()),
    ];
    await save(`${variant.id}/IMG.dcm`, writePart10(ds, { transferSyntaxUid: variant.ts }));
    add({ id: variant.id, dir: variant.id, kind: 'valid', files: 1, description: variant.desc, expect: { transferSyntaxUid: variant.ts, lossless: variant.bits !== 8, cornerValue: 4000 + ((0 * 7 + (cols - 1) * 3) % 50) } });
  }
  // Colour JPEG baseline (decoded through the browser image path in the loader)
  {
    const s = series('ts', n + 1, 'XC', 'JPEG baseline RGB');
    const rgb = colorWheel(128, 128);
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.sc, uid('sop:ts-jpeg-rgb'), 1),
      ...pixelModule({ rows: 128, columns: 128, bitsAllocated: 8, bitsStored: 8, pixelRepresentation: 0, samplesPerPixel: 3, photometric: 'YBR_FULL_422', planarConfiguration: 0 }, {
        fragments: [await encodeJpegBaseline(rgb, { width: 128, height: 128, bitsPerSample: 8, componentCount: 3, isSigned: false })],
      }),
    ];
    await save('ts-jpeg-baseline-rgb/IMG.dcm', writePart10(ds, { transferSyntaxUid: TSUID.jpegBaseline }));
    add({ id: 'ts-jpeg-baseline-rgb', dir: 'ts-jpeg-baseline-rgb', kind: 'valid', files: 1, description: 'JPEG baseline colour (YBR_FULL_422)' });
  }
}

async function valuePipeline(): Promise<void> {
  const ps = study('lut', { studyDescription: 'VALUE PIPELINE' });
  const rows = 128, cols = 128;
  const ramp = Array.from({ length: rows * cols }, (_, i) => Math.round(((i % cols) / (cols - 1)) * 4095));
  const write = async (id: string, n: number, modality: string, desc: string, ds: Element[], expect?: Record<string, unknown>): Promise<void> => {
    const s = series('lut', n, modality, desc);
    const full: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(modality === 'CT' ? SOP.ct : SOP.mr, uid(`sop:${id}`), 1),
      ...planeModule([-64, -64, 0], [1, 0, 0, 0, 1, 0], [1, 1], 1),
      ...ds,
    ];
    await save(`${id}/IMG.dcm`, writePart10(full, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id, dir: id, kind: 'valid', files: 1, description: desc, ...(expect ? { expect } : {}) });
  };
  // Modality LUT Sequence: output = 2 × stored (no rescale)
  await write('modality-lut', 1, 'MR', 'Modality LUT Sequence (x2)', [
    seq(0x0028, 0x3000, [[
      el(0x0028, 0x3002, 'US', [4096, 0, 16]),
      el(0x0028, 0x3004, 'LO', 'US'),
      { tag: tag(0x0028, 0x3006), vr: 'OW', value: u16le(Array.from({ length: 4096 }, (_, i) => 2 * i)) },
    ]]),
    ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(ramp)),
  ], { mapping: 'output = 2 × stored', lastColumnStored: 4095, lastColumnOutput: 8190 });
  // VOI LUT Sequence (gamma curve over 0..4095)
  await write('voi-lut', 2, 'MR', 'VOI LUT Sequence (gamma)', [
    seq(0x0028, 0x3010, [[
      el(0x0028, 0x3002, 'US', [4096, 0, 16]),
      el(0x0028, 0x3003, 'LO', 'GAMMA 0.5'),
      { tag: tag(0x0028, 0x3006), vr: 'OW', value: u16le(Array.from({ length: 4096 }, (_, i) => Math.round(65535 * Math.sqrt(i / 4095)))) },
    ]]),
    ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(ramp)),
  ]);
  await write('sigmoid', 3, 'MR', 'VOI LUT function SIGMOID', [...windowModule([2048], [2048], ['SIG'], 'SIGMOID'), ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(ramp))]);
  await write('multi-window', 4, 'CT', 'Multiple windows', [
    ...rescaleModule(-1024, 1, 'HU'),
    ...windowModule([40, 400], [80, 1800], ['BRAIN', 'BONE']),
    ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(ramp)),
  ], { windows: [{ center: 40, width: 80 }, { center: 400, width: 1800 }] });
  // Signed CT with pixel padding outside a circular FOV
  const signed = Array.from({ length: rows * cols }, (_, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    if ((r - 64) ** 2 + (c - 64) ** 2 > 60 ** 2) return -2000;
    return (r - 64) ** 2 + (c - 64) ** 2 < 20 ** 2 ? 60 : -5;
  });
  await write('signed-padding', 5, 'CT', 'Signed 16-bit with Pixel Padding -2000', [
    ...rescaleModule(0, 1, 'HU'),
    ...windowModule([40], [400]),
    el(0x0028, 0x0120, 'SS', -2000),
    el(0x0028, 0x1041, 'SS', -1),
    ...pixelModule({ ...MONO16, bitsStored: 16, pixelRepresentation: 1, rows, columns: cols }, u16le(signed)),
  ], { centerHU: 60, paddingValue: -2000 });
  await write('presentation-lut', 6, 'MR', 'Presentation LUT Shape INVERSE', [
    el(0x2050, 0x0020, 'CS', 'INVERSE'),
    ...windowModule([2048], [4096]),
    ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(ramp)),
  ]);
}

/** Packs a boolean bitmap into DICOM overlay bits (LSB first, little-endian words). */
function packOverlay(bits: boolean[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 16) * 2);
  bits.forEach((b, i) => {
    if (b) out[i >> 3]! |= 1 << (i & 7);
  });
  return out;
}

async function overlaysAndCine(): Promise<void> {
  const ps = study('ovl', { studyDescription: 'OVERLAY AND CINE' });
  {
    const rows = 256, cols = 256;
    const bits = Array.from({ length: rows * cols }, (_, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const frame = (r === 20 || r === 235) && c >= 20 && c <= 235 ? true : (c === 20 || c === 235) && r >= 20 && r <= 235;
      const arrow = c >= 160 && c <= 200 && Math.abs(r - 60) <= (200 - c) / 2;
      return frame || arrow;
    });
    const s = series('ovl', 1, 'MR', 'OVERLAY 6000');
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.mr, uid('sop:overlay'), 1),
      ...planeModule([-127, -127, 0], [1, 0, 0, 0, 1, 0], [1, 1], 3),
      ...windowModule([2048], [4096]),
      el(0x6000, 0x0010, 'US', rows),
      el(0x6000, 0x0011, 'US', cols),
      el(0x6000, 0x0022, 'LO', 'SYNTHETIC ANNOTATION'),
      el(0x6000, 0x0040, 'CS', 'G'),
      el(0x6000, 0x0050, 'SS', [1, 1]),
      el(0x6000, 0x0100, 'US', 1),
      el(0x6000, 0x0102, 'US', 0),
      { tag: tag(0x6000, 0x3000), vr: 'OW', value: packOverlay(bits) },
      ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(pattern2D(rows, cols))),
    ];
    await save('overlay/IMG.dcm', writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id: 'overlay', dir: 'overlay', kind: 'valid', files: 1, description: 'MR with graphics overlay 6000 (frame + arrow)' });
  }
  {
    const rows = 256, cols = 256, frames = 30;
    const pixels = new Uint8Array(rows * cols * frames);
    const ovlBits: boolean[] = [];
    for (let f = 0; f < frames; f++) {
      const cx = 40 + f * 6;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const vessel = Math.abs(r - 128 - 30 * Math.sin((c + f * 4) / 30)) < 6;
          const blob = (r - 128) ** 2 + (c - cx) ** 2 < 15 ** 2;
          pixels[f * rows * cols + r * cols + c] = blob ? 20 : vessel ? 60 : 180 + ((r + c) % 20);
          ovlBits.push(r >= 10 && r <= 20 && c >= 10 && c <= 10 + f * 7);
        }
    }
    const s = series('ovl', 2, 'XA', 'DSA RUN 30 FRAMES');
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.xa, uid('sop:xa'), 1),
      el(0x0018, 0x1063, 'DS', '66.67'),
      el(0x0018, 0x0040, 'IS', '15'),
      el(0x0008, 0x2144, 'IS', '15'),
      el(0x0028, 0x0009, 'AT', tag(0x0018, 0x1063)),
      el(0x0020, 0x0020, 'CS', ['L', 'F']),
      el(0x6002, 0x0010, 'US', rows),
      el(0x6002, 0x0011, 'US', cols),
      el(0x6002, 0x0015, 'IS', String(frames)),
      el(0x6002, 0x0040, 'CS', 'G'),
      el(0x6002, 0x0050, 'SS', [1, 1]),
      el(0x6002, 0x0051, 'US', 1),
      el(0x6002, 0x0100, 'US', 1),
      el(0x6002, 0x0102, 'US', 0),
      { tag: tag(0x6002, 0x3000), vr: 'OW', value: packOverlay(ovlBits) },
      ...pixelModule({ rows, columns: cols, bitsAllocated: 8, bitsStored: 8, pixelRepresentation: 0, samplesPerPixel: 1, photometric: 'MONOCHROME2', numberOfFrames: frames }, pixels),
    ];
    await save('xa-cine/XA.dcm', writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id: 'xa-cine', dir: 'xa-cine', kind: 'valid', files: 1, description: 'XA 30 frames, 15 fps, per-frame overlay (progress bar)', expect: { frames, fps: 15 } });
  }
}

export const TURKISH_NAMES = {
  latin5: 'ÇAĞLAR^Şükrü İğneada',
  utf8: 'ÖZGÜL^Ayşe Işık',
  iso2022: 'YILMAZ^Gülşen',
};

async function charsets(): Promise<void> {
  const rows = 64, cols = 64;
  const px = u16le(pattern2D(rows, cols));
  const write = async (id: string, ps: PatientStudy, desc: string | Uint8Array, expectName: string, uncertain = false): Promise<void> => {
    const s = { ...series(id, 1, 'MR', ''), seriesDescription: desc };
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.mr, uid(`sop:${id}`), 1),
      ...planeModule([-32, -32, 0], [1, 0, 0, 0, 1, 0], [1, 1], 3),
      ...windowModule([2048], [4096]),
      ...pixelModule({ ...MONO16, rows, columns: cols }, px),
    ];
    await save(`${id}/IMG.dcm`, writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id, dir: id, kind: 'valid', files: 1, description: `Patient name charset: ${id}`, expect: { patientName: expectName, charsetUncertain: uncertain } });
  };
  await write('turkish-148', study('tr148', { patientName: latin5(TURKISH_NAMES.latin5), patientId: 'TR-148', charset: 'ISO_IR 148', studyDescription: latin5('BEYİN MR KONTRASTLI') }), latin5('AKSİYEL T1 ÖNCESİ'), TURKISH_NAMES.latin5);
  await write('turkish-192', study('tr192', { patientName: utf8(TURKISH_NAMES.utf8), patientId: 'TR-192', charset: 'ISO_IR 192', studyDescription: utf8('Kafa BT – ılık') }), utf8('Koronal ışın'), TURKISH_NAMES.utf8);
  const iso = Uint8Array.from([...utf8('YILMAZ^G'), 0x1b, 0x2d, 0x4d, ...latin5('ülşen')]);
  await write('iso2022', study('iso2022', { patientName: iso, patientId: 'TR-2022', charset: ['ISO 2022 IR 6', 'ISO 2022 IR 148'].join('\\') }), 'ISO 2022', TURKISH_NAMES.iso2022);
  // 8-bit bytes without Specific Character Set → shown with uncertainty indicator
  await write('charset-undeclared', study('undecl', { patientName: latin5('ŞAHİN^Ali'), patientId: 'TR-UND' }), 'NO CHARSET', 'ÞAHÝN^Ali', true);
}

async function nonImage(): Promise<void> {
  const ps = study('nonimg', { studyDescription: 'NON-IMAGE OBJECTS' });
  {
    const s = series('nonimg', 1, 'SR', 'BASIC TEXT SR');
    const code = (value: string, scheme: string, meaning: string): Element[] => [el(0x0008, 0x0100, 'SH', value), el(0x0008, 0x0102, 'SH', scheme), el(0x0008, 0x0104, 'LO', meaning)];
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.basicTextSr, uid('sop:sr'), 1),
      el(0x0040, 0xa040, 'CS', 'CONTAINER'),
      seq(0x0040, 0xa043, [code('11528-7', 'LN', 'Radiology Report')]),
      el(0x0040, 0xa050, 'CS', 'SEPARATE'),
      el(0x0040, 0xa491, 'CS', 'COMPLETE'),
      el(0x0040, 0xa493, 'CS', 'UNVERIFIED'),
      seq(0x0040, 0xa730, [[
        el(0x0040, 0xa010, 'CS', 'CONTAINS'),
        el(0x0040, 0xa040, 'CS', 'TEXT'),
        seq(0x0040, 0xa043, [code('121071', 'DCM', 'Finding')]),
        el(0x0040, 0xa160, 'UT', 'Synthetic finding text for testing.'),
      ]]),
    ];
    await save('sr/SR.dcm', writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id: 'sr', dir: 'sr', kind: 'valid', files: 1, description: 'Basic Text SR (non-image display set)' });
  }
  {
    const s = series('nonimg', 2, 'DOC', 'ENCAPSULATED PDF');
    const pdf = utf8('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const ds: Element[] = [
      ...patientStudySeries(ps, s),
      ...sopCommon(SOP.encapsulatedPdf, uid('sop:pdf'), 1),
      el(0x0042, 0x0010, 'ST', 'Synthetic PDF'),
      el(0x0042, 0x0012, 'LO', 'application/pdf'),
      el(0x0042, 0x0011, 'OB', pdf),
    ];
    await save('pdf/DOC.dcm', writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }));
    add({ id: 'pdf', dir: 'pdf', kind: 'valid', files: 1, description: 'Encapsulated PDF (non-image display set)' });
  }
}

async function dicomdir(): Promise<void> {
  const ps = study('dicomdir', { patientName: 'CDROM^PHANTOM', patientId: 'CD-0001', studyDescription: 'CD STUDY' });
  const rows = 64, cols = 64;
  const records: Element[][] = [];
  const files: { rel: string; ds: Element[] }[] = [];
  const seriesList = [series('dicomdir', 1, 'MR', 'CD MR'), series('dicomdir', 2, 'CT', 'CD CT')];
  seriesList.forEach((s, si) => {
    for (let k = 0; k < 5; k++) {
      const sop = uid(`sop:dicomdir:${si}:${k}`);
      const sopClass = s.modality === 'CT' ? SOP.ct : SOP.mr;
      files.push({
        rel: `DICOM/PA000000/ST000000/SE00000${si}/IM00000${k}`,
        ds: [
          ...patientStudySeries(ps, s),
          ...sopCommon(sopClass, sop, k + 1),
          ...planeModule([-32, -32, 4 * k], [1, 0, 0, 0, 1, 0], [1, 1], 4),
          ...windowModule([2048], [4096]),
          ...pixelModule({ ...MONO16, rows, columns: cols }, u16le(pattern2D(rows, cols))),
        ],
      });
    }
  });
  for (const f of files) await save(`dicomdir-set/${f.rel.toLowerCase()}`, writePart10(f.ds, { transferSyntaxUid: TSUID.explicitLE }));

  // Directory records: PATIENT → STUDY → SERIES → IMAGE (offsets filled in a second pass)
  const recordOf = (type: string, fields: Element[]): Element[] => [
    el(0x0004, 0x1400, 'UL', 0),
    el(0x0004, 0x1410, 'US', 0xffff),
    el(0x0004, 0x1420, 'UL', 0),
    el(0x0004, 0x1430, 'CS', type),
    ...fields,
  ];
  const get = (ds: Element[], g: number, e: number): Element['value'] => ds.find((x) => x.tag === tag(g, e))!.value;
  const first = files[0]!.ds;
  records.push(recordOf('PATIENT', [el(0x0010, 0x0010, 'PN', get(first, 0x0010, 0x0010)), el(0x0010, 0x0020, 'LO', get(first, 0x0010, 0x0020))]));
  records.push(recordOf('STUDY', [el(0x0008, 0x0020, 'DA', ps.studyDate), el(0x0008, 0x0030, 'TM', ps.studyTime), el(0x0008, 0x1030, 'LO', ps.studyDescription), el(0x0020, 0x000d, 'UI', ps.studyUid), el(0x0020, 0x0010, 'SH', '1'), el(0x0008, 0x0050, 'SH', ps.accession)]));
  const hierarchy: { index: number; parent?: number }[] = [{ index: 0 }, { index: 1, parent: 0 }];
  seriesList.forEach((s, si) => {
    const sIdx = records.length;
    records.push(recordOf('SERIES', [el(0x0008, 0x0060, 'CS', s.modality), el(0x0020, 0x000e, 'UI', s.seriesUid), el(0x0020, 0x0011, 'IS', String(s.seriesNumber))]));
    hierarchy.push({ index: sIdx, parent: 1 });
    files.filter((f) => f.rel.includes(`SE00000${si}`)).forEach((f) => {
      const iIdx = records.length;
      records.push(recordOf('IMAGE', [
        el(0x0004, 0x1500, 'CS', f.rel.split('/')),
        el(0x0004, 0x1510, 'UI', String(get(f.ds, 0x0008, 0x0016))),
        el(0x0004, 0x1511, 'UI', String(get(f.ds, 0x0008, 0x0018))),
        el(0x0004, 0x1512, 'UI', TSUID.explicitLE),
        el(0x0020, 0x0013, 'IS', String(get(f.ds, 0x0020, 0x0013))),
      ]));
      hierarchy.push({ index: iIdx, parent: sIdx });
    });
  });
  const opts = { transferSyntaxUid: TSUID.explicitLE, mediaStorageSopClassUid: '1.2.840.10008.1.3.10', mediaStorageSopInstanceUid: uid('fileset:dicomdir') };
  const head: Element[] = [
    el(0x0004, 0x1130, 'CS', 'SYNTHCD'),
    el(0x0004, 0x1200, 'UL', 0),
    el(0x0004, 0x1202, 'UL', 0),
    el(0x0004, 0x1212, 'US', 0),
  ];
  const headerLen = part10HeaderLength(head, opts);
  const headLen = encodeDataset(head, { explicit: true, littleEndian: true }).length;
  const sqValueStart = headerLen + headLen + 12;
  const itemOffsets: number[] = [];
  let pos = sqValueStart;
  for (const r of records) {
    itemOffsets.push(pos);
    pos += 8 + encodeDataset(r, { explicit: true, littleEndian: true }).length;
  }
  const setUL = (r: Element[], e: number, value: number): void => {
    r.find((x) => x.tag === tag(0x0004, e))!.value = value;
  };
  for (const h of hierarchy) {
    const siblings = hierarchy.filter((x) => x.parent === h.parent);
    const next = siblings[siblings.indexOf(h) + 1];
    if (next) setUL(records[h.index]!, 0x1400, itemOffsets[next.index]!);
    const child = hierarchy.find((x) => x.parent === h.index);
    if (child) setUL(records[h.index]!, 0x1420, itemOffsets[child.index]!);
  }
  head[1]!.value = itemOffsets[0]!;
  head[2]!.value = itemOffsets[0]!;
  const dicomdirDs: Element[] = [...head, seq(0x0004, 0x1220, records)];
  await save('dicomdir-set/DICOMDIR', writePart10(dicomdirDs, opts));
  await save('dicomdir-set/README.TXT', utf8('Synthetic CD for testing.\n'));
  add({ id: 'dicomdir-set', dir: 'dicomdir-set', kind: 'valid', files: 11, description: 'DICOMDIR with 2 series × 5 images (file names lower-case on disk, upper-case in DICOMDIR)', expect: { series: 2, images: 10 } });
}

async function archives(): Promise<void> {
  const src = path.join(FIXTURE_DIR, 'turkish-148', 'IMG.dcm');
  const src2 = path.join(FIXTURE_DIR, 'ts-explicit-le', 'IMG.dcm');
  const a = new Uint8Array(await readFile(src));
  const b = new Uint8Array(await readFile(src2));
  const make = async (name: string, entries: { name: string; data: Uint8Array }[], options: Record<string, unknown> = {}): Promise<void> => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    for (const e of entries) await writer.add(e.name, new Uint8ArrayReader(e.data));
    await save(`archives/${name}`, await writer.close());
  };
  const study2 = [{ name: 'study/a/IMG1.dcm', data: a }, { name: 'study/b/IMG2.dcm', data: b }, { name: 'study/readme.txt', data: utf8('not dicom') }];
  await make('plain.zip', study2);
  await make('aes.zip', study2, { password: 'test1234', encryptionStrength: 3 });
  await make('zipcrypto.zip', study2, { password: 'test1234', zipCrypto: true });
  // Zip bomb: 256 MiB of zeros in one entry (ratio ≈ 1000:1)
  {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 9 });
    await writer.add('bomb.dcm', new BlobReader(new Blob([new Uint8Array(256 * 1024 * 1024)])));
    await save('archives/bomb.zip', await writer.close());
  }
  await make('traversal.zip', [{ name: '../../escape.dcm', data: a }, { name: 'ok/IMG.dcm', data: b }]);
  add({ id: 'archives', dir: 'archives', kind: 'archive', files: 5, description: 'ZIP: plain, AES-256, ZipCrypto (password test1234), bomb, path traversal', expect: { password: 'test1234' } });
}

async function malformed(): Promise<void> {
  const good = new Uint8Array(await readFile(path.join(FIXTURE_DIR, 'ts-explicit-le', 'IMG.dcm')));
  const jpegGood = new Uint8Array(await readFile(path.join(FIXTURE_DIR, 'ts-jpeg-baseline', 'IMG.dcm')));
  const r = rng(7);
  const cases: { name: string; bytes: Uint8Array; expect: string }[] = [];
  cases.push({ name: 'zero-byte.dcm', bytes: new Uint8Array(0), expect: 'notDicom' });
  cases.push({ name: 'truncated-pixels.dcm', bytes: good.subarray(0, good.length - 50000), expect: 'truncatedPixelData' });
  cases.push({ name: 'truncated-header.dcm', bytes: good.subarray(0, 400), expect: 'malformed' });
  cases.push({ name: 'random-with-dicm.dcm', bytes: (() => { const x = Uint8Array.from({ length: 4096 }, () => Math.floor(r() * 256)); x.set([0x44, 0x49, 0x43, 0x4d], 128); return x; })(), expect: 'malformed' });
  cases.push({ name: 'not-dicom.txt', bytes: utf8('This is a text file.\n'), expect: 'notDicom' });
  cases.push({ name: 'fake.png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(0)]), expect: 'notDicom' });
  // Element with a huge length field inside the dataset (LO 0x0008,0x0070 manufacturer)
  {
    const x = new Uint8Array(good);
    const idx = findTag(x, 0x0008, 0x0070);
    if (idx > 0) new DataView(x.buffer).setUint16(idx + 6, 0xfff0, true);
    cases.push({ name: 'wrong-length.dcm', bytes: x, expect: 'malformed' });
  }
  // Huge dimensions
  {
    const ps = study('malformed');
    const s = series('malformed', 1, 'OT', 'HUGE');
    const ds: Element[] = [...patientStudySeries(ps, s), ...sopCommon(SOP.sc, uid('sop:huge'), 1), ...pixelModule({ ...MONO16, rows: 65535, columns: 65535 }, new Uint8Array(16))];
    cases.push({ name: 'huge-dims.dcm', bytes: writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }), expect: 'unsupportedDimensions' });
    const ds2: Element[] = [...patientStudySeries(ps, s), ...sopCommon(SOP.sc, uid('sop:frames'), 2), ...pixelModule({ ...MONO16, rows: 64, columns: 64, numberOfFrames: 999999 }, new Uint8Array(16))];
    cases.push({ name: 'huge-frames.dcm', bytes: writePart10(ds2, { transferSyntaxUid: TSUID.explicitLE }), expect: 'unsupportedDimensions' });
  }
  // Corrupt compressed streams (header parses; decoding must fail gracefully in the viewer)
  {
    const ps = study('malformed');
    const mk = (n: number, ts: string, desc: string, frag: Uint8Array, bits: 8 | 16 = 16): Uint8Array => {
      const s = series('malformed', 10 + n, 'MR', desc);
      const pd: PixelDesc = bits === 8 ? { rows: 256, columns: 256, bitsAllocated: 8, bitsStored: 8, pixelRepresentation: 0, samplesPerPixel: 1, photometric: 'MONOCHROME2' } : { ...MONO16, rows: 256, columns: 256 };
      const ds: Element[] = [...patientStudySeries(ps, s), ...sopCommon(SOP.mr, uid(`sop:bad:${n}`), 1), ...windowModule([2048], [4096]), ...pixelModule(pd, { fragments: [frag] })];
      return writePart10(ds, { transferSyntaxUid: ts });
    };
    const junk = (len: number, prefix: number[] = []): Uint8Array => Uint8Array.from([...prefix, ...Array.from({ length: len }, () => Math.floor(r() * 256))]);
    const jpegFrag = extractFirstFragment(jpegGood);
    const corruptJpeg = new Uint8Array(jpegFrag);
    for (let i = 600; i < corruptJpeg.length - 2; i += 37) corruptJpeg[i] = 0xff;
    cases.push({ name: 'bad-jpeg-baseline.dcm', bytes: mk(1, TSUID.jpegBaseline, 'BAD JPEG', corruptJpeg, 8), expect: 'decodeError' });
    cases.push({ name: 'bad-jpeg-truncated.dcm', bytes: mk(2, TSUID.jpegBaseline, 'TRUNCATED JPEG', jpegFrag.subarray(0, 300), 8), expect: 'decodeError' });
    cases.push({ name: 'bad-j2k.dcm', bytes: mk(3, TSUID.j2kLossless, 'BAD J2K', junk(2000, [0xff, 0x4f, 0xff, 0x51])), expect: 'decodeError' });
    cases.push({ name: 'bad-htj2k.dcm', bytes: mk(4, TSUID.htj2kLossless, 'BAD HTJ2K', junk(2000, [0xff, 0x4f, 0xff, 0x51])), expect: 'decodeError' });
    cases.push({ name: 'bad-jpegls.dcm', bytes: mk(5, TSUID.jpegLS, 'BAD JPEG-LS', junk(2000, [0xff, 0xd8, 0xff, 0xf7])), expect: 'decodeError' });
    cases.push({ name: 'bad-lossless.dcm', bytes: mk(6, TSUID.jpegLosslessSV1, 'BAD LOSSLESS', junk(2000, [0xff, 0xd8, 0xff, 0xc3])), expect: 'decodeError' });
    const rleBad = new Uint8Array(64);
    new DataView(rleBad.buffer).setUint32(0, 2, true);
    new DataView(rleBad.buffer).setUint32(4, 64, true);
    new DataView(rleBad.buffer).setUint32(8, 0x7ffffff0, true);
    cases.push({ name: 'bad-rle.dcm', bytes: mk(7, TSUID.rle, 'BAD RLE', rleBad), expect: 'decodeError' });
  }
  // Deeply nested sequences
  {
    let inner: Element[] = [el(0x0008, 0x0100, 'SH', 'X')];
    for (let d = 0; d < 300; d++) inner = [seq(0x0040, 0xa730, [inner], d % 2 === 0)];
    const ps = study('malformed');
    const s = series('malformed', 30, 'SR', 'DEEP');
    const ds: Element[] = [...patientStudySeries(ps, s), ...sopCommon(SOP.basicTextSr, uid('sop:deep'), 1), ...inner];
    cases.push({ name: 'deep-nesting.dcm', bytes: writePart10(ds, { transferSyntaxUid: TSUID.explicitLE }), expect: 'okOrMalformed' });
  }
  for (const c of cases) await save(`malformed/${c.name}`, c.bytes);
  add({ id: 'malformed', dir: 'malformed', kind: 'malformed', files: cases.length, description: 'Malformed corpus', expect: Object.fromEntries(cases.map((c) => [c.name, c.expect])) });
}

function findTag(bytes: Uint8Array, group: number, element: number): number {
  for (let i = 132; i + 4 < bytes.length; i += 2) {
    if (bytes[i] === (group & 0xff) && bytes[i + 1] === group >> 8 && bytes[i + 2] === (element & 0xff) && bytes[i + 3] === element >> 8) return i;
  }
  return -1;
}

/** Returns the first pixel-data fragment of an encapsulated explicit-LE file. */
function extractFirstFragment(file: Uint8Array): Uint8Array {
  const i = findTag(file, 0x7fe0, 0x0010);
  // tag(4) VR(2) reserved(2) length(4) = 12; then BOT item header 8 + 0; then fragment header 8
  const dv = new DataView(file.buffer, file.byteOffset);
  const botLen = dv.getUint32(i + 12 + 4, true);
  const fragHeader = i + 12 + 8 + botLen;
  const len = dv.getUint32(fragHeader + 4, true);
  return file.subarray(fragHeader + 8, fragHeader + 8 + len);
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export const GENERATOR_VERSION = 1;

async function sourceHash(): Promise<string> {
  const h = createHash('sha256').update(String(GENERATOR_VERSION));
  const files = (await readdir(here, { recursive: true })).filter((f) => f.endsWith('.ts')).sort();
  for (const f of files) h.update(f).update(await readFile(path.join(here, f)));
  return h.digest('hex');
}

export async function generateAll(): Promise<void> {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  manifest.length = 0;
  const steps: [string, () => Promise<void>][] = [
    ['ct-phantom', ctPhantom],
    ['orientation', orientationSeries],
    ['geometry', geometryEdgeCases],
    ['enhanced-mr', enhancedMr],
    ['pet', pet],
    ['projection', projection],
    ['photometric', photometric],
    ['transfer syntaxes', transferSyntaxes],
    ['value pipeline', valuePipeline],
    ['overlays/cine', overlaysAndCine],
    ['charsets', charsets],
    ['non-image', nonImage],
    ['dicomdir', dicomdir],
    ['archives', archives],
    ['malformed', malformed],
    ['ct-large', ctLarge],
  ];
  for (const [name, fn] of steps) {
    const t = performance.now();
    await fn();
    console.log(`  ${name.padEnd(18)} ${(performance.now() - t).toFixed(0)} ms`);
  }
  await writeFile(path.join(FIXTURE_DIR, 'manifest.json'), JSON.stringify({ generatorVersion: GENERATOR_VERSION, fixtures: manifest }, null, 2));
}

export async function ensureFixtures(force = false): Promise<void> {
  const hash = await sourceHash();
  if (!force && existsSync(STAMP) && (await readFile(STAMP, 'utf8')) === hash) return;
  console.log('Generating synthetic DICOM fixtures…');
  await generateAll();
  await writeFile(STAMP, hash);
  console.log(`Fixtures written to ${path.relative(ROOT, FIXTURE_DIR)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureFixtures(process.argv.includes('--force')).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
