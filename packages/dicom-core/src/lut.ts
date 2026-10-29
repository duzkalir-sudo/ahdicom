/**
 * Modality LUT Sequence (0028,3000) and VOI LUT Sequence (0028,3010), PS3.3 C.11.1 / C.11.2.
 * Parsed from the raw file bytes because the image loader's GPU path does not apply them.
 */
import dicomParser from 'dicom-parser';

export interface Lut {
  /** First input value mapped (in stored or modality units). */
  firstValueMapped: number;
  numberOfEntries: number;
  bitsPerEntry: number;
  data: Uint16Array;
  explanation?: string;
  type?: string;
}

export interface LutSequences {
  modality?: Lut;
  voi: Lut[];
}

const MAX_ENTRIES = 65536;

function readLut(item: dicomParser.DataSet, signedInput: boolean): Lut | undefined {
  const desc = item.elements.x00283002;
  const dataEl = item.elements.x00283006;
  if (!desc || !dataEl || desc.length < 6) return undefined;
  const n0 = item.uint16('x00283002', 0) ?? 0;
  const numberOfEntries = n0 === 0 ? MAX_ENTRIES : n0;
  let first = item.uint16('x00283002', 1) ?? 0;
  if (signedInput && first > 32767) first -= 65536;
  const bitsPerEntry = item.uint16('x00283002', 2) ?? 16;
  if (bitsPerEntry < 8 || bitsPerEntry > 16) return undefined;
  if (dataEl.dataOffset + dataEl.length > item.byteArray.length) return undefined;
  const available = Math.floor(dataEl.length / 2);
  if (available < numberOfEntries) return undefined;
  const data = new Uint16Array(numberOfEntries);
  for (let i = 0; i < numberOfEntries; i++) data[i] = item.uint16('x00283006', i) ?? 0;
  const explanation = item.string('x00283003');
  const type = item.string('x00283004');
  return {
    firstValueMapped: first,
    numberOfEntries,
    bitsPerEntry,
    data,
    ...(explanation ? { explanation } : {}),
    ...(type ? { type } : {}),
  };
}

/** Parses LUT sequences; returns an empty result for files without them or on any parse error. */
export function parseLutSequences(bytes: Uint8Array, inflater?: (b: Uint8Array, p: number) => Uint8Array): LutSequences {
  try {
    const ds = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010', ...(inflater ? { inflater } : {}) });
    const signed = ds.uint16('x00280103') === 1;
    const modalityItem = ds.elements.x00283000?.items?.[0]?.dataSet;
    const modality = modalityItem ? readLut(modalityItem, signed) : undefined;
    // VOI LUT input is the Modality LUT output (unsigned) when a Modality LUT Sequence is present.
    const voiSigned = modality ? false : signed;
    const voi = (ds.elements.x00283010?.items ?? [])
      .map((it) => (it.dataSet ? readLut(it.dataSet, voiSigned) : undefined))
      .filter((l): l is Lut => l !== undefined);
    return { ...(modality ? { modality } : {}), voi };
  } catch {
    return { voi: [] };
  }
}

/** Applies a LUT to one input value, clamping outside the table (PS3.3 C.11.1.1.1). */
export function applyLut(value: number, lut: Lut): number {
  const i = Math.round(value) - lut.firstValueMapped;
  if (i <= 0) return lut.data[0]!;
  if (i >= lut.numberOfEntries - 1) return lut.data[lut.numberOfEntries - 1]!;
  return lut.data[i]!;
}

/** Input domain of a LUT (first..last mapped value). */
export function lutDomain(lut: Lut): { lower: number; upper: number } {
  return { lower: lut.firstValueMapped, upper: lut.firstValueMapped + lut.numberOfEntries - 1 };
}

/**
 * Samples a VOI LUT into normalized [x, y] points (x over the input domain 0..1, y = output / max output),
 * for use as a piecewise-linear display transfer function.
 */
export function lutToNormalizedCurve(lut: Lut, samples = 256): [number, number][] {
  const maxOut = 2 ** lut.bitsPerEntry - 1;
  const pts: [number, number][] = [];
  const n = Math.min(samples, lut.numberOfEntries);
  for (let k = 0; k < n; k++) {
    const x = n === 1 ? 0 : k / (n - 1);
    const idx = Math.round(x * (lut.numberOfEntries - 1));
    pts.push([x, Math.min(1, lut.data[idx]! / maxOut)]);
  }
  return pts;
}

/**
 * Validates an RLE Lossless fragment header (PS3.5 G.3.1): segment count must equal samples × bytes per sample
 * and every segment offset must lie inside the fragment, in increasing order.
 */
export function rleHeaderValid(fragment: Uint8Array, expectedSegments: number): boolean {
  if (fragment.length < 64) return false;
  const dv = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
  const n = dv.getUint32(0, true);
  if (n !== expectedSegments || n < 1 || n > 15) return false;
  let prev = 63;
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(4 + i * 4, true);
    if (off <= prev || off >= fragment.length) return false;
    prev = off;
  }
  return true;
}
