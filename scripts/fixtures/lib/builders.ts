/** Dataset builders for synthetic fixtures. All patient data is invented. */
import { type Element, type Item, type VR, tag, uid } from './writer.js';

export const SOP = {
  ct: '1.2.840.10008.5.1.4.1.1.2',
  mr: '1.2.840.10008.5.1.4.1.1.4',
  enhancedMr: '1.2.840.10008.5.1.4.1.1.4.1',
  pet: '1.2.840.10008.5.1.4.1.1.128',
  cr: '1.2.840.10008.5.1.4.1.1.1',
  us: '1.2.840.10008.5.1.4.1.1.6.1',
  xa: '1.2.840.10008.5.1.4.1.1.12.1',
  sc: '1.2.840.10008.5.1.4.1.1.7',
  basicTextSr: '1.2.840.10008.5.1.4.1.1.88.11',
  encapsulatedPdf: '1.2.840.10008.5.1.4.1.1.104.1',
} as const;

export const el = (group: number, element: number, vr: VR, value: Element['value']): Element => ({
  tag: tag(group, element),
  vr,
  value,
});

export const seq = (group: number, element: number, items: Item[], undefinedLength = false): Element => ({
  tag: tag(group, element),
  vr: 'SQ',
  value: items,
  undefinedLength,
});

export interface PatientStudy {
  patientName: string | Uint8Array;
  patientId: string;
  birthDate?: string;
  sex?: string;
  studyUid: string;
  studyDate: string;
  studyTime: string;
  studyDescription: string | Uint8Array;
  accession: string;
  charset?: string;
}

export interface SeriesInfo {
  seriesUid: string;
  seriesNumber: number;
  seriesDescription: string | Uint8Array;
  modality: string;
  frameOfReferenceUid?: string;
  bodyPart?: string;
}

export function patientStudySeries(ps: PatientStudy, s: SeriesInfo): Element[] {
  const e: Element[] = [
    el(0x0008, 0x0020, 'DA', ps.studyDate),
    el(0x0008, 0x0030, 'TM', ps.studyTime),
    el(0x0008, 0x0050, 'SH', ps.accession),
    el(0x0008, 0x0060, 'CS', s.modality),
    el(0x0008, 0x0070, 'LO', 'SYNTHETIC'),
    el(0x0008, 0x0090, 'PN', ''),
    el(0x0008, 0x1030, 'LO', ps.studyDescription),
    el(0x0008, 0x103e, 'LO', s.seriesDescription),
    el(0x0010, 0x0010, 'PN', ps.patientName),
    el(0x0010, 0x0020, 'LO', ps.patientId),
    el(0x0010, 0x0030, 'DA', ps.birthDate ?? '19700101'),
    el(0x0010, 0x0040, 'CS', ps.sex ?? 'O'),
    el(0x0020, 0x000d, 'UI', ps.studyUid),
    el(0x0020, 0x000e, 'UI', s.seriesUid),
    el(0x0020, 0x0010, 'SH', '1'),
    el(0x0020, 0x0011, 'IS', String(s.seriesNumber)),
  ];
  if (ps.charset) e.push(el(0x0008, 0x0005, 'CS', ps.charset));
  if (s.frameOfReferenceUid) e.push(el(0x0020, 0x0052, 'UI', s.frameOfReferenceUid));
  if (s.bodyPart) e.push(el(0x0018, 0x0015, 'CS', s.bodyPart));
  return e;
}

export function sopCommon(sopClass: string, sopInstance: string, instanceNumber: number): Element[] {
  return [
    el(0x0008, 0x0016, 'UI', sopClass),
    el(0x0008, 0x0018, 'UI', sopInstance),
    el(0x0020, 0x0013, 'IS', String(instanceNumber)),
  ];
}

export interface PixelDesc {
  rows: number;
  columns: number;
  bitsAllocated: 8 | 16;
  bitsStored: number;
  pixelRepresentation: 0 | 1;
  samplesPerPixel: 1 | 3;
  photometric: string;
  planarConfiguration?: 0 | 1;
  numberOfFrames?: number;
}

export function pixelModule(p: PixelDesc, pixelData: Element['value']): Element[] {
  const e: Element[] = [
    el(0x0028, 0x0002, 'US', p.samplesPerPixel),
    el(0x0028, 0x0004, 'CS', p.photometric),
    el(0x0028, 0x0010, 'US', p.rows),
    el(0x0028, 0x0011, 'US', p.columns),
    el(0x0028, 0x0100, 'US', p.bitsAllocated),
    el(0x0028, 0x0101, 'US', p.bitsStored),
    el(0x0028, 0x0102, 'US', p.bitsStored - 1),
    el(0x0028, 0x0103, 'US', p.pixelRepresentation),
  ];
  if (p.samplesPerPixel > 1) e.push(el(0x0028, 0x0006, 'US', p.planarConfiguration ?? 0));
  if (p.numberOfFrames !== undefined) e.push(el(0x0028, 0x0008, 'IS', String(p.numberOfFrames)));
  const isEncapsulated = typeof pixelData === 'object' && pixelData !== null && 'fragments' in pixelData;
  e.push({ tag: tag(0x7fe0, 0x0010), vr: isEncapsulated || p.bitsAllocated === 8 ? 'OB' : 'OW', value: pixelData });
  return e;
}

export function planeModule(
  ipp: readonly number[] | undefined,
  iop: readonly number[] | undefined,
  spacing: readonly [number, number] | undefined,
  thickness?: number,
): Element[] {
  const f = (v: readonly number[]): string[] => v.map((x) => fmtDS(x));
  const e: Element[] = [];
  if (ipp) e.push(el(0x0020, 0x0032, 'DS', f(ipp)));
  if (iop) e.push(el(0x0020, 0x0037, 'DS', f(iop)));
  if (spacing) e.push(el(0x0028, 0x0030, 'DS', f(spacing)));
  if (thickness !== undefined) e.push(el(0x0018, 0x0050, 'DS', fmtDS(thickness)));
  return e;
}

/** Formats a number as a DS string (max 16 chars). */
export function fmtDS(x: number): string {
  if (Number.isInteger(x)) return String(x);
  let s = x.toPrecision(10);
  if (s.includes('e')) s = x.toExponential(8);
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s.length > 16 ? x.toPrecision(8) : s;
}

export function windowModule(centers: number[], widths: number[], explanations?: string[], fn?: string): Element[] {
  const e: Element[] = [
    el(0x0028, 0x1050, 'DS', centers.map(fmtDS)),
    el(0x0028, 0x1051, 'DS', widths.map(fmtDS)),
  ];
  if (explanations) e.push(el(0x0028, 0x1055, 'LO', explanations));
  if (fn) e.push(el(0x0028, 0x1056, 'CS', fn));
  return e;
}

export function rescaleModule(intercept: number, slope: number, type?: string): Element[] {
  const e = [el(0x0028, 0x1052, 'DS', fmtDS(intercept)), el(0x0028, 0x1053, 'DS', fmtDS(slope))];
  if (type) e.push(el(0x0028, 0x1054, 'LO', type));
  return e;
}

/** Little-endian bytes of a 16-bit sample array (signed or unsigned). */
export function u16le(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint16(i * 2, values[i]! & 0xffff, true);
  return out;
}

export const study = (seed: string, overrides: Partial<PatientStudy> = {}): PatientStudy => ({
  patientName: 'PHANTOM^TEST',
  patientId: `CDV-${seed.toUpperCase().slice(0, 10)}`,
  studyUid: uid(`study:${seed}`),
  studyDate: '20240305',
  studyTime: '101500',
  studyDescription: 'SYNTHETIC PHANTOM STUDY',
  accession: `ACC${seed.length}${seed.charCodeAt(0)}`,
  ...overrides,
});

export const series = (seed: string, n: number, modality: string, description: string, forSeed?: string): SeriesInfo => ({
  seriesUid: uid(`series:${seed}:${n}`),
  seriesNumber: n,
  seriesDescription: description,
  modality,
  frameOfReferenceUid: uid(`for:${forSeed ?? seed}`),
});

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
