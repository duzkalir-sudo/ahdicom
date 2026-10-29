/**
 * Validates the synthetic fixtures with independent code paths:
 * - headers parse with dicom-core (dicom-parser based) and match the manifest expectations;
 * - compressed pixel data decodes with the Cornerstone codec builds back to the exact source pattern.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import dicomParser from 'dicom-parser';
import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { buildStudies, decodeText, parseSpecificCharacterSet, splitDeflatedPart10 } from '@clinic/dicom-core';
import { FIXTURES, ROOT, filesIn, inflater, manifest, parseFile } from './helpers/fixtures.js';

describe('deflated transfer syntax rewrite (used before Cornerstone ingestion)', () => {
  it('produces an Explicit VR LE file with identical pixel data', () => {
    const src = new Uint8Array(readFileSync(filesIn('ts-deflated')[0]!));
    const parts = splitDeflatedPart10(src);
    expect(parts).toBeDefined();
    const body = inflateRawSync(parts!.deflated);
    const out = new Uint8Array(parts!.header.length + body.length);
    out.set(parts!.header);
    out.set(body, parts!.header.length);
    const ds = dicomParser.parseDicom(out);
    expect(ds.string('x00020010')).toBe('1.2.840.10008.1.2.1');
    const pd = ds.elements.x7fe00010!;
    const ref = dicomParser.parseDicom(new Uint8Array(readFileSync(filesIn('ts-explicit-le')[0]!)));
    const rpd = ref.elements.x7fe00010!;
    expect(Buffer.from(out.subarray(pd.dataOffset, pd.dataOffset + pd.length))).toEqual(
      Buffer.from(ref.byteArray.subarray(rpd.dataOffset, rpd.dataOffset + rpd.length)),
    );
    expect(splitDeflatedPart10(new Uint8Array(readFileSync(filesIn('ts-explicit-le')[0]!)))).toBeUndefined();
    expect(splitDeflatedPart10(new Uint8Array(200))).toBeUndefined();
  });
});

const require = createRequire(import.meta.url);
const NM = path.join(ROOT, 'node_modules');

describe('fixture headers', () => {
  const entries = manifest();

  it('manifest lists every generated fixture group', () => {
    expect(entries.length).toBeGreaterThan(40);
  });

  for (const entry of entries.filter((e) => e.kind === 'valid' && e.id !== 'ct-large')) {
    it(`${entry.id}: all files parse`, () => {
      const files = filesIn(entry.dir).filter((f) => !/README|DICOMDIR$/i.test(f));
      expect(files.length).toBe(entry.id === 'dicomdir-set' ? 10 : entry.files);
      for (const f of files) {
        const r = parseFile(f);
        if (!r.ok) throw new Error(`${path.relative(FIXTURES, f)}: ${r.error} ${r.detail ?? ''}`);
      }
    });
  }

  it('ct-phantom: geometry and spacing from IPP', () => {
    const instances = filesIn('ct-phantom').map((f) => {
      const r = parseFile(f);
      if (!r.ok) throw new Error(r.error);
      return r.instance;
    });
    const [studyNode] = buildStudies(instances);
    const ds = studyNode!.series[0]!.displaySets[0]!;
    expect(ds.images).toHaveLength(64);
    expect(ds.geometry.sliceSpacing).toBeCloseTo(2.5, 6);
    expect(ds.warnings).toEqual([]);
    expect(ds.firstInstance.geometry.rescaleIntercept).toBe(-1024);
  });

  it('shuffled: spatial order independent of instance numbers and file names', () => {
    const instances = filesIn('shuffled').map((f) => (parseFile(f) as { ok: true; instance: never }).instance);
    const ds = buildStudies(instances)[0]!.series[0]!.displaySets[0]!;
    const z = ds.images.map((i) => i.geometry.imagePositionPatient![2]);
    expect(z).toEqual([...z].sort((a, b) => a - b));
    expect(ds.geometry.sliceSpacing).toBe(3);
  });

  it('gantry-tilt, nonuniform, no-geometry, mixed-orient warnings', () => {
    const load = (id: string) => buildStudies(filesIn(id).map((f) => (parseFile(f) as { ok: true; instance: never }).instance))[0]!.series[0]!;
    const tilt = load('gantry-tilt').displaySets[0]!;
    expect(tilt.geometry.tiltDeg).toBeCloseTo(15, 3);
    expect(tilt.warnings.map((w) => w.code)).toContain('gantryTilt');
    const nonu = load('nonuniform').displaySets[0]!.warnings.map((w) => w.code);
    expect(nonu).toEqual(expect.arrayContaining(['missingSlices', 'nonUniformSpacing']));
    const nog = load('no-geometry').displaySets[0]!;
    expect(nog.geometry.sortFallback).toBe(true);
    expect(nog.images.map((i) => i.instanceNumber)).toEqual([1, 2, 3, 4, 5]);
    const mixed = load('mixed-orient');
    expect(mixed.displaySets).toHaveLength(3);
    expect(mixed.displaySets[0]!.warnings.map((w) => w.code)).toContain('mixedOrientations');
  });

  it('enhanced-mr: per-frame positions are used and frames sorted spatially', () => {
    const r = parseFile(filesIn('enhanced-mr')[0]!);
    if (!r.ok) throw new Error(r.error);
    expect(r.instance.numberOfFrames).toBe(20);
    expect(r.instance.perFrame).toHaveLength(20);
    expect(r.instance.geometry.pixelSpacing).toEqual([2, 2]);
    const ds = buildStudies([r.instance])[0]!.series[0]!.displaySets[0]!;
    expect(ds.kind).toBe('multiframe');
    expect(ds.images[0]!.frame).toBe(20); // stored head → foot, sorted ascending z
    expect(ds.geometry.sliceSpacing).toBeCloseTo(8, 6);
    expect(ds.warnings).toEqual([]);
  });

  it('charsets: Turkish names decode exactly', () => {
    for (const id of ['turkish-148', 'turkish-192', 'iso2022', 'charset-undeclared']) {
      const entry = entries.find((e) => e.id === id)!;
      const r = parseFile(filesIn(id)[0]!);
      if (!r.ok) throw new Error(r.error);
      expect(r.instance.patientName).toBe(entry.expect!.patientName);
      expect(r.instance.charsetUncertain).toBe(entry.expect!.charsetUncertain);
    }
    const tr = parseFile(filesIn('turkish-148')[0]!);
    expect(tr.ok && tr.instance.studyDescription).toBe('BEYİN MR KONTRASTLI');
  });

  it('projection, PET and photometric metadata', () => {
    const cr = parseFile(filesIn('cr-mag')[0]!);
    expect(cr.ok && cr.instance.imagerPixelSpacing).toEqual([0.2, 0.2]);
    expect(cr.ok && cr.instance.estimatedRadiographicMagnificationFactor).toBe(1.1);
    expect(cr.ok && cr.instance.patientOrientation).toEqual(['L', 'F']);
    const us = parseFile(filesIn('us-regions')[0]!);
    expect(us.ok && us.instance.hasUltrasoundRegions).toBe(true);
    const ovl = parseFile(filesIn('overlay')[0]!);
    expect(ovl.ok && ovl.instance.overlayGroups).toEqual([0x6000]);
    const xa = parseFile(filesIn('xa-cine')[0]!);
    expect(xa.ok && xa.instance.numberOfFrames).toBe(30);
    expect(xa.ok && xa.instance.frameTime).toBeCloseTo(66.67, 2);
    const pad = parseFile(filesIn('signed-padding')[0]!);
    expect(pad.ok && pad.instance.pixelPaddingValue).toBe(-2000);
    const sr = parseFile(filesIn('sr')[0]!);
    expect(sr.ok && sr.instance.hasPixelData).toBe(false);
  });

  it('DICOMDIR: records reference every image', () => {
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, 'dicomdir-set', 'DICOMDIR')));
    const ds = dicomParser.parseDicom(bytes);
    const items = ds.elements.x00041220!.items!;
    const images = items.filter((i) => i.dataSet!.string('x00041430') === 'IMAGE');
    expect(images).toHaveLength(10);
    expect(images[0]!.dataSet!.string('x00041500')).toBe('DICOM\\PA000000\\ST000000\\SE000000\\IM000000');
    // Offset of the first root record points at an item tag (FFFE,E000)
    const off = ds.uint32('x00041200')!;
    expect([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]).toEqual([0xfe, 0xff, 0x00, 0xe0]);
    expect(decodeText(new Uint8Array([0x41]), parseSpecificCharacterSet(undefined)).text).toBe('A');
  });
});

describe('malformed corpus at header level', () => {
  const expectations = manifest().find((e) => e.id === 'malformed')!.expect as Record<string, string>;
  for (const [name, expected] of Object.entries(expectations)) {
    it(`${name} → ${expected}`, () => {
      const r = parseFile(path.join(FIXTURES, 'malformed', name));
      if (expected === 'decodeError') {
        // Header is valid; pixel decoding must fail gracefully later (covered by E2E).
        expect(r.ok).toBe(true);
      } else if (expected === 'okOrMalformed') {
        expect(r.ok || r.error === 'malformed').toBe(true);
      } else if (expected === 'malformed') {
        expect(r.ok).toBe(false);
        expect(['malformed', 'truncated', 'missingUids']).toContain(!r.ok && r.error);
      } else {
        expect(r.ok ? 'ok' : r.error).toBe(expected);
      }
    });
  }
});

// ------------------------------------------------------------------------------------------------
// Compressed pixel data round-trip through the Cornerstone codecs
// ------------------------------------------------------------------------------------------------

function firstFragment(file: string): { bytes: Uint8Array; rows: number; cols: number } {
  const ds = dicomParser.parseDicom(new Uint8Array(readFileSync(file)));
  const pd = ds.elements.x7fe00010!;
  const frag = pd.fragments![0]!;
  return {
    bytes: ds.byteArray.subarray(frag.position, frag.position + frag.length),
    rows: ds.uint16('x00280010')!,
    cols: ds.uint16('x00280011')!,
  };
}

function nativePixels(id: string): Uint16Array {
  const file = filesIn(id)[0]!;
  const ds = dicomParser.parseDicom(new Uint8Array(readFileSync(file)), { inflater });
  const pd = ds.elements.x7fe00010!;
  const out = new Uint16Array(pd.length / 2);
  const dv = new DataView(ds.byteArray.buffer, ds.byteArray.byteOffset + pd.dataOffset, pd.length);
  const le = id !== 'ts-explicit-be';
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, le);
  return out;
}

interface WasmDecoder {
  getEncodedBuffer(len: number): Uint8Array;
  getDecodedBuffer(): Uint8Array;
  decode(): void;
  getFrameInfo(): { width: number; height: number; bitsPerSample: number; componentCount: number };
  delete?(): void;
}

async function wasmDecode(file: string, cls: string, data: Uint8Array): Promise<Uint16Array> {
  const factory = require(path.join(NM, file)) as () => Promise<Record<string, new () => WasmDecoder>>;
  const mod = await factory();
  const d = new mod[cls]!();
  d.getEncodedBuffer(data.length).set(data);
  d.decode();
  const out = d.getDecodedBuffer();
  const copy = new Uint16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  d.delete?.();
  return copy;
}

describe('fixture transfer syntaxes decode losslessly to the reference image', () => {
  const reference = nativePixels('ts-explicit-le');

  for (const id of ['ts-implicit-le', 'ts-explicit-be', 'ts-deflated']) {
    it(`${id} pixel data equals reference`, () => {
      expect(nativePixels(id)).toEqual(reference);
    });
  }

  it('JPEG-LS (charls)', async () => {
    const { bytes } = firstFragment(filesIn('ts-jpeg-ls')[0]!);
    expect(await wasmDecode('@cornerstonejs/codec-charls/dist/charlswasm_decode.js', 'JpegLSDecoder', bytes)).toEqual(reference);
  });
  it('JPEG 2000 (openjpeg)', async () => {
    const { bytes } = firstFragment(filesIn('ts-j2k')[0]!);
    expect(await wasmDecode('@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.js', 'J2KDecoder', bytes)).toEqual(reference);
  });
  it('HTJ2K (openjph)', async () => {
    const { bytes } = firstFragment(filesIn('ts-htj2k')[0]!);
    expect(await wasmDecode('@cornerstonejs/codec-openjph/dist/openjphjs.js', 'HTJ2KDecoder', bytes)).toEqual(reference);
  });
  it('JPEG Lossless SV1 (jpeg-lossless-decoder-js)', async () => {
    const { bytes } = firstFragment(filesIn('ts-jpeg-lossless')[0]!);
    const mod = (await import('@cornerstonejs/jpeg-lossless-decoder-js')) as unknown as {
      Decoder: new () => { decode(buf: ArrayBuffer, off: number, len: number): ArrayBuffer | Uint8Array };
    };
    const out = new mod.Decoder().decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 0, bytes.length);
    const arr = out instanceof ArrayBuffer ? new Uint16Array(out) : new Uint16Array(out.buffer, out.byteOffset, out.byteLength / 2);
    expect(Array.from(arr)).toEqual(Array.from(reference));
  });
  it('RLE (reference PS3.5 Annex G decoder)', () => {
    const { bytes, rows, cols } = firstFragment(filesIn('ts-rle')[0]!);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nSeg = dv.getUint32(0, true);
    expect(nSeg).toBe(2);
    const planes: Uint8Array[] = [];
    for (let s = 0; s < nSeg; s++) {
      const start = dv.getUint32(4 + s * 4, true);
      const end = s + 1 < nSeg ? dv.getUint32(8 + s * 4, true) : bytes.length;
      const out = new Uint8Array(rows * cols);
      let o = 0;
      for (let i = start; i < end && o < out.length; ) {
        const n = (bytes[i++]! << 24) >> 24;
        if (n >= 0) for (let k = 0; k <= n; k++) out[o++] = bytes[i++]!;
        else if (n !== -128) {
          const b = bytes[i++]!;
          for (let k = 0; k < 1 - n; k++) out[o++] = b;
        }
      }
      planes.push(out);
    }
    const decoded = new Uint16Array(rows * cols);
    for (let p = 0; p < decoded.length; p++) decoded[p] = (planes[0]![p]! << 8) | planes[1]![p]!;
    expect(decoded).toEqual(reference);
  });
});
