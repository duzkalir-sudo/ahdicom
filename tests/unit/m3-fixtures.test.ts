/**
 * M3 comparison fixtures through the real parser and display-set builder: multi-volume series are split, the
 * orientation series share a Frame of Reference, the prior study does not.
 */
import { describe, expect, it } from 'vitest';
import { buildStudies, type InstanceRecord } from '@ahdicom/dicom-core';
import { filesIn, parseFile } from './helpers/fixtures.js';

function load(...dirs: string[]): InstanceRecord[] {
  return dirs.flatMap((d) =>
    filesIn(d).map((f) => {
      const r = parseFile(f);
      if (!r.ok) throw new Error(`${f}: ${r.error}`);
      return r.instance;
    }),
  );
}

describe('M3 fixtures', () => {
  it('dwi: one series split into b = 0 and b = 1000 volumes of 4 slices', () => {
    const sets = buildStudies(load('dwi'))[0]!.series[0]!.displaySets;
    expect(sets.map((d) => d.splitBy)).toEqual([
      { key: 'bValue', value: 0 },
      { key: 'bValue', value: 1000 },
    ]);
    expect(sets.map((d) => d.images.length)).toEqual([4, 4]);
    expect(sets.every((d) => !d.warnings.some((w) => w.code === 'duplicatePositions'))).toBe(true);
  });

  it('multiphase: three temporal volumes of 3 slices', () => {
    const sets = buildStudies(load('multiphase'))[0]!.series[0]!.displaySets;
    expect(sets.map((d) => d.splitBy)).toEqual([1, 2, 3].map((value) => ({ key: 'temporal', value })));
    expect(sets.map((d) => d.images.length)).toEqual([3, 3, 3]);
  });

  it('orientation series share a Frame of Reference; the prior study has its own', () => {
    const studies = buildStudies(load('orient-axial', 'orient-axial-thin', 'orient-sagittal', 'orient-prior'));
    expect(studies).toHaveLength(2);
    const forOf = (desc: string): string | undefined =>
      studies.flatMap((s) => s.series).find((s) => s.seriesDescription === desc)!.displaySets[0]!.firstInstance.frameOfReferenceUid;
    expect(forOf('AXIAL')).toBe(forOf('AXIAL THIN'));
    expect(forOf('AXIAL')).toBe(forOf('SAGITTAL'));
    expect(forOf('AXIAL PRIOR')).not.toBe(forOf('AXIAL'));
    expect(new Set(studies.map((s) => s.patientId))).toEqual(new Set(['CDV-ORIENT']));
  });
});
