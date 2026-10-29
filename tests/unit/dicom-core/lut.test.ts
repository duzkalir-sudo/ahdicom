import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyLut, lutDomain, lutToNormalizedCurve, parseLutSequences } from '@ahdicom/dicom-core';
import { FIXTURES } from '../helpers/fixtures.js';

const load = (id: string) => new Uint8Array(readFileSync(path.join(FIXTURES, id, 'IMG.dcm')));

describe('LUT sequences', () => {
  it('reads the Modality LUT Sequence (output = 2 × stored)', () => {
    const luts = parseLutSequences(load('modality-lut'));
    expect(luts.modality?.numberOfEntries).toBe(4096);
    expect(applyLut(0, luts.modality!)).toBe(0);
    expect(applyLut(1000, luts.modality!)).toBe(2000);
    expect(applyLut(4095, luts.modality!)).toBe(8190);
    expect(applyLut(99999, luts.modality!)).toBe(8190); // clamped
    expect(applyLut(-5, luts.modality!)).toBe(0);
  });
  it('reads the VOI LUT Sequence and samples a normalized curve', () => {
    const luts = parseLutSequences(load('voi-lut'));
    expect(luts.voi).toHaveLength(1);
    const lut = luts.voi[0]!;
    expect(lut.explanation).toBe('GAMMA 0.5');
    expect(lutDomain(lut)).toEqual({ lower: 0, upper: 4095 });
    const curve = lutToNormalizedCurve(lut, 5);
    expect(curve[0]).toEqual([0, 0]);
    expect(curve[4]).toEqual([1, 1]);
    expect(curve[1]![1]).toBeCloseTo(Math.sqrt(0.25), 2);
  });
  it('returns nothing for files without LUTs or garbage', () => {
    expect(parseLutSequences(load('ts-explicit-le'))).toEqual({ voi: [] });
    expect(parseLutSequences(new Uint8Array(10))).toEqual({ voi: [] });
  });
});

describe('RLE header validation', () => {
  it('accepts the RLE fixture header and rejects corrupt ones', async () => {
    const { rleHeaderValid } = await import('@ahdicom/dicom-core');
    const dicomParser = (await import('dicom-parser')).default;
    const ds = dicomParser.parseDicom(load('ts-rle'));
    const frag = ds.elements.x7fe00010!.fragments![0]!;
    const bytes = ds.byteArray.subarray(frag.position, frag.position + frag.length);
    expect(rleHeaderValid(bytes, 2)).toBe(true);
    expect(rleHeaderValid(bytes, 1)).toBe(false);
    const bad = new Uint8Array(bytes);
    new DataView(bad.buffer).setUint32(8, 0x7ffffff0, true);
    expect(rleHeaderValid(bad, 2)).toBe(false);
    expect(rleHeaderValid(new Uint8Array(10), 1)).toBe(false);
  });
});
