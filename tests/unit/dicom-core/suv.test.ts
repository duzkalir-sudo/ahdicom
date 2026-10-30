/**
 * SUVbw against hand-computed references and vendor edge cases.
 */
import { describe, expect, it } from 'vitest';
import {
  dicomDateTimeSeconds,
  parseDicomDateTimeSeconds,
  parseDicomTimeSeconds,
  suvBwFactor,
  type InstanceRecord,
} from '@ahdicom/dicom-core';
import { filesIn, manifest, parseFile } from '../helpers/fixtures.js';

/** A PET instance with complete SUV attributes: 70 kg, 370 MBq F-18 at 09:30, series at 10:20 (Δt = 3000 s). */
function pet(over: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    fileId: 'f',
    fileName: 'IM1',
    fileSize: 1,
    transferSyntaxUid: '1.2.840.10008.1.2.1',
    sopClassUid: '1.2.840.10008.5.1.4.1.1.128',
    sopInstanceUid: '1.2.3',
    studyInstanceUid: '1.2',
    seriesInstanceUid: '1.2.4',
    numberOfFrames: 1,
    hasPixelData: true,
    geometry: {},
    charsetUncertain: false,
    modality: 'PT',
    petUnits: 'BQML',
    correctedImage: ['ATTN', 'DECY'],
    decayCorrection: 'START',
    patientWeight: 70,
    seriesDate: '20240305',
    seriesTime: '102000',
    acquisitionDate: '20240305',
    acquisitionTime: '102000',
    radiopharmaceutical: { startTime: '093000', totalDose: 370000000, halfLife: 6586.2 },
    ...over,
  };
}

const expected = (dtSeconds: number, weightKg = 70, dose = 370e6, halfLife = 6586.2): number =>
  (weightKg * 1000) / (dose * 2 ** (-dtSeconds / halfLife));

describe('DICOM time parsing', () => {
  it('TM, DA+TM and DT', () => {
    expect(parseDicomTimeSeconds('093000')).toBe(34200);
    expect(parseDicomTimeSeconds('093000.5')).toBe(34200.5);
    expect(parseDicomTimeSeconds('0930')).toBe(34200);
    expect(parseDicomTimeSeconds('09')).toBe(32400);
    expect(parseDicomTimeSeconds('09:30:00')).toBe(34200);
    expect(parseDicomTimeSeconds('2500')).toBeUndefined();
    expect(parseDicomTimeSeconds('abc')).toBeUndefined();
    expect(parseDicomTimeSeconds(undefined)).toBeUndefined();
    expect(dicomDateTimeSeconds('19700102', '000001')).toBe(86401);
    expect(parseDicomDateTimeSeconds('19700102000001')).toBe(86401);
    expect(parseDicomDateTimeSeconds('19700102000001.000000+0300')).toBe(86401);
    expect(parseDicomDateTimeSeconds('1970010')).toBeUndefined();
  });
});

describe('SUVbw factor', () => {
  it('matches the hand-computed reference (decay from injection to series start)', () => {
    const r = suvBwFactor(pet());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decaySeconds).toBe(3000);
    expect(r.factor).toBeCloseTo(expected(3000), 12);
    // 20 000 Bq/ml, 70 kg, 370 MBq: 2^(−3000/6586.2) = 0.72927 → 269.83 MBq at scan → SUV = 5.1885.
    expect(20000 * r.factor).toBeCloseTo(5.1885, 3);
  });

  it('uses the acquisition time when the series time was rewritten later', () => {
    const r = suvBwFactor(pet({ seriesTime: '113000' }));
    expect(r.ok && r.decaySeconds).toBe(3000);
    const e = suvBwFactor(pet({ seriesTime: '113000' }), dicomDateTimeSeconds('20240305', '101000'));
    expect(e.ok && e.decaySeconds).toBe(2400);
  });

  it('prefers Radiopharmaceutical Start DateTime and handles injection before midnight', () => {
    const r = suvBwFactor(
      pet({
        seriesDate: '20240306',
        seriesTime: '001000',
        acquisitionDate: '20240306',
        acquisitionTime: '001000',
        radiopharmaceutical: { startDateTime: '20240305232000', totalDose: 370e6, halfLife: 6586.2 },
      }),
    );
    expect(r.ok && r.decaySeconds).toBe(3000);
    // Without the date the start time "23:20" is taken from the previous day.
    const t = suvBwFactor(
      pet({
        seriesDate: '20240306',
        seriesTime: '001000',
        acquisitionDate: '20240306',
        acquisitionTime: '001000',
        radiopharmaceutical: { startTime: '232000', totalDose: 370e6, halfLife: 6586.2 },
      }),
    );
    expect(t.ok && t.decaySeconds).toBe(3000);
  });

  it('ADMIN decay correction: no decay of the dose', () => {
    const r = suvBwFactor(pet({ decayCorrection: 'ADMIN' }));
    expect(r.ok && r.factor).toBeCloseTo(70000 / 370e6, 15);
  });

  it('GML images are already SUVbw', () => {
    expect(suvBwFactor(pet({ petUnits: 'GML' }))).toEqual({ ok: true, factor: 1, decaySeconds: 0 });
  });

  it('refuses instead of guessing', () => {
    expect(suvBwFactor(pet({ petUnits: 'CNTS' }))).toEqual({ ok: false, reason: 'units', units: 'CNTS' });
    expect(suvBwFactor(pet({ petUnits: undefined }))).toEqual({ ok: false, reason: 'units' });
    expect(suvBwFactor(pet({ correctedImage: ['ATTN'] }))).toEqual({ ok: false, reason: 'notCorrected' });
    expect(suvBwFactor(pet({ decayCorrection: 'NONE' }))).toEqual({ ok: false, reason: 'decayCorrection', decayCorrection: 'NONE' });
    expect(suvBwFactor(pet({ patientWeight: 0, radiopharmaceutical: { startTime: '093000', halfLife: 6586.2 } }))).toEqual({
      ok: false,
      reason: 'missing',
      missing: ['PatientWeight', 'RadionuclideTotalDose'],
    });
    expect(suvBwFactor(pet({ radiopharmaceutical: undefined, seriesTime: undefined }))).toEqual({
      ok: false,
      reason: 'missing',
      missing: ['RadionuclideTotalDose', 'RadionuclideHalfLife', 'RadiopharmaceuticalStartTime', 'SeriesDate/SeriesTime'],
    });
    // Injection more than a day before the scan is not plausible.
    expect(suvBwFactor(pet({ radiopharmaceutical: { startDateTime: '20240303093000', totalDose: 370e6, halfLife: 6586.2 } }))).toEqual({
      ok: false,
      reason: 'timing',
    });
  });
});

describe('PET fixtures', () => {
  const byId = (id: string): Record<string, unknown> => manifest().find((m) => m.id === id)!.expect!;

  it('pet: parsed attributes give the manifest SUV factor', () => {
    const r = parseFile(filesIn('pet')[0]!);
    if (!r.ok) throw new Error(r.error);
    expect(r.instance.radiopharmaceutical).toEqual({ startTime: '093000', totalDose: 370000000, halfLife: 6586.2 });
    expect(r.instance.decayCorrection).toBe('START');
    expect(r.instance.correctedImage).toEqual(['ATTN', 'DECY']);
    const s = suvBwFactor(r.instance);
    expect(s.ok && s.factor).toBeCloseTo(byId('pet').suvbwFactor as number, 12);
  });

  it('pet-missing: refused with the missing attributes named', () => {
    const r = parseFile(filesIn('pet-missing')[0]!);
    if (!r.ok) throw new Error(r.error);
    expect(suvBwFactor(r.instance)).toEqual({ ok: false, reason: 'missing', missing: byId('pet-missing').missing });
  });
});
