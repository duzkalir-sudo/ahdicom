import { describe, expect, it } from 'vitest';
import {
  applyVoi,
  CT_PRESETS,
  decimalsForSpacing,
  decodeText,
  formatDicomDate,
  formatPersonName,
  parseSpecificCharacterSet,
  rangeToWindow,
  rescale,
  windowToRange,
} from '@clinic/dicom-core';

describe('VOI LUT functions (PS3.3 C.11.2.1.2)', () => {
  it('LINEAR window → range uses c − 0.5 ± (w − 1)/2', () => {
    expect(windowToRange({ center: 40, width: 80 }, 'LINEAR')).toEqual({ lower: 0, upper: 79 });
    expect(windowToRange({ center: -600, width: 1500 }, 'LINEAR')).toEqual({ lower: -1350, upper: 149 });
  });
  it('LINEAR_EXACT window → range uses c ± w/2', () => {
    expect(windowToRange({ center: 40, width: 80 }, 'LINEAR_EXACT')).toEqual({ lower: 0, upper: 80 });
  });
  it('round-trips range ↔ window', () => {
    for (const fn of ['LINEAR', 'LINEAR_EXACT'] as const) {
      const wl = { center: 37.5, width: 255 };
      const back = rangeToWindow(windowToRange(wl, fn), fn);
      expect(back.center).toBeCloseTo(wl.center, 10);
      expect(back.width).toBeCloseTo(wl.width, 10);
    }
  });
  it('LINEAR output: bounds and midpoint', () => {
    const wl = { center: 40, width: 80 };
    expect(applyVoi(0, wl)).toBe(0);
    expect(applyVoi(79.01, wl)).toBe(1);
    expect(applyVoi(39.5, wl)).toBeCloseTo(0.5, 10);
  });
  it('LINEAR_EXACT and SIGMOID midpoints are 0.5 at the center', () => {
    expect(applyVoi(40, { center: 40, width: 80 }, 'LINEAR_EXACT')).toBeCloseTo(0.5, 10);
    expect(applyVoi(40, { center: 40, width: 80 }, 'SIGMOID')).toBeCloseTo(0.5, 10);
    // SIGMOID: 1 / (1 + e^(−4(x−c)/w)); x = c + w/4 → 1/(1+e^−1)
    expect(applyVoi(60, { center: 40, width: 80 }, 'SIGMOID')).toBeCloseTo(1 / (1 + Math.exp(-1)), 10);
  });
  it('modality rescale gives HU', () => {
    expect(rescale(1024, 1, -1024)).toBe(0);
    expect(rescale(0, 1, -1024)).toBe(-1024);
    expect(rescale(100, 2.5, -10)).toBe(240);
  });
  it('CT presets are present with expected values', () => {
    const brain = CT_PRESETS.find((p) => p.id === 'brain')!;
    expect([brain.width, brain.center]).toEqual([80, 40]);
    expect(CT_PRESETS.map((p) => p.id)).toEqual([
      'brain',
      'subdural',
      'stroke',
      'bone',
      'lung',
      'abdomen',
      'mediastinum',
      'angio',
    ]);
  });
});

// Byte sequences for "ÇAĞLAR^Şükrü İğneada" in ISO-8859-9 (Latin-5).
const LATIN5 = Uint8Array.from([
  0xc7, 0x41, 0xd0, 0x4c, 0x41, 0x52, 0x5e, 0xde, 0xfc, 0x6b, 0x72, 0xfc, 0x20, 0xdd, 0xf0, 0x6e, 0x65, 0x61, 0x64,
  0x61,
]);
const EXPECTED = 'ÇAĞLAR^Şükrü İğneada';

describe('Specific Character Set decoding', () => {
  it('ISO_IR 148 (Turkish)', () => {
    expect(decodeText(LATIN5, parseSpecificCharacterSet('ISO_IR 148'))).toEqual({ text: EXPECTED, uncertain: false });
  });
  it('ISO_IR 192 (UTF-8)', () => {
    const bytes = new TextEncoder().encode('ÖZGÜL^Ayşe ıı');
    expect(decodeText(bytes, parseSpecificCharacterSet('ISO_IR 192'))).toEqual({
      text: 'ÖZGÜL^Ayşe ıı',
      uncertain: false,
    });
  });
  it('ISO_IR 100 (Latin-1)', () => {
    const bytes = Uint8Array.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]);
    expect(decodeText(bytes, ['ISO_IR 100']).text).toBe('Müller');
  });
  it('ISO 2022 IR 6 \\ ISO 2022 IR 148 with G1 escape ESC - M', () => {
    const bytes = Uint8Array.from([0x41, 0x1b, 0x2d, 0x4d, 0xde, 0xfc]);
    expect(decodeText(bytes, parseSpecificCharacterSet('\\ISO 2022 IR 148'))).toEqual({
      text: 'AŞü',
      uncertain: false,
    });
  });
  it('ISO 2022 IR 100 initial G1 without escape', () => {
    expect(decodeText(Uint8Array.from([0xe9]), parseSpecificCharacterSet('ISO 2022 IR 100'))).toEqual({
      text: 'é',
      uncertain: false,
    });
  });
  it('default repertoire with 8-bit bytes is flagged uncertain', () => {
    expect(decodeText(LATIN5, []).uncertain).toBe(true);
    expect(decodeText(Uint8Array.from([0x41, 0x42]), []).uncertain).toBe(false);
  });
  it('invalid UTF-8 is flagged uncertain', () => {
    expect(decodeText(Uint8Array.from([0xc3, 0x28]), ['ISO_IR 192']).uncertain).toBe(true);
  });
  it('unknown term is flagged uncertain', () => {
    expect(decodeText(Uint8Array.from([0xc7]), ['ISO_IR 999']).uncertain).toBe(true);
  });
  it('normalizes spelling variants', () => {
    expect(parseSpecificCharacterSet(' iso_ir 148 ')).toEqual(['ISO_IR 148']);
    expect(parseSpecificCharacterSet('ISO_IR_192')).toEqual(['ISO_IR 192']);
  });
});

describe('formatting', () => {
  it('person names use Turkish uppercasing (i → İ) in tr', () => {
    expect(formatPersonName('çiftçi^Şükrü', 'tr')).toBe('ÇİFTÇİ, Şükrü');
    expect(formatPersonName('çiftçi^Şükrü', 'en')).toBe('ÇIFTÇI, Şükrü');
    expect(formatPersonName('DOE^JOHN^Q^Dr^Jr', 'en')).toBe('DOE, Dr JOHN Q Jr');
    expect(formatPersonName('ONLYFAMILY', 'en')).toBe('ONLYFAMILY');
    expect(formatPersonName(undefined, 'tr')).toBe('');
  });
  it('dates follow locale', () => {
    expect(formatDicomDate('20240305', 'tr')).toBe('05.03.2024');
    expect(formatDicomDate('20240305', 'en')).toBe('2024-03-05');
    expect(formatDicomDate('2024.03.05', 'tr')).toBe('05.03.2024');
    expect(formatDicomDate('garbage', 'tr')).toBe('garbage');
  });
  it('length precision follows pixel spacing', () => {
    expect(decimalsForSpacing(1.2)).toBe(1);
    expect(decimalsForSpacing(0.5)).toBe(2);
    expect(decimalsForSpacing(0.05)).toBe(3);
    expect(decimalsForSpacing(undefined)).toBe(0);
  });
});
