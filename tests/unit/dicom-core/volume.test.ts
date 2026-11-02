/**
 * Volume geometry for MPR and 3D against analytic volumes with hand-computed answers (CLAUDE.md rule 9).
 */
import { describe, expect, it } from 'vitest';
import {
  STANDARD_VIEWS,
  buildDisplaySets,
  mprCheck,
  nearestVoxel,
  patientToVoxel,
  planePixel,
  planePoint,
  planesIntersection,
  reformatIndex,
  reformatStack,
  rotateAbout,
  slabOffsets,
  slabProject,
  spacingAlong,
  vec3,
  volumeCorners,
  volumeGeometry,
  voxelToPatient,
  type DisplaySet,
  type InstanceRecord,
  type Vec3,
} from '@ahdicom/dicom-core';

type V6 = [number, number, number, number, number, number];
const AXIAL: V6 = [1, 0, 0, 0, 1, 0];
const SAGITTAL: V6 = [0, 1, 0, 0, 0, -1];

let uid = 0;
function inst(ipp: Vec3, extra: Partial<InstanceRecord> & { iop?: V6; spacing?: [number, number] } = {}): InstanceRecord {
  const { iop, spacing, ...rest } = extra;
  const k = ++uid;
  return {
    fileId: `f${k}`,
    fileName: `IM${k}`,
    fileSize: 1,
    transferSyntaxUid: '1.2.840.10008.1.2.1',
    sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
    sopInstanceUid: `1.2.${k}`,
    studyInstanceUid: '1.2',
    seriesInstanceUid: '1.2.9',
    frameOfReferenceUid: '1.2.3',
    numberOfFrames: 1,
    hasPixelData: true,
    rows: 20,
    columns: 10,
    samplesPerPixel: 1,
    instanceNumber: k,
    geometry: { imagePositionPatient: [...ipp], imageOrientationPatient: iop ?? AXIAL, pixelSpacing: spacing ?? [0.5, 1] },
    charsetUncertain: false,
    ...rest,
  };
}

function displaySet(list: InstanceRecord[]): DisplaySet {
  const sets = buildDisplaySets(list);
  expect(sets).toHaveLength(1);
  return sets[0]!;
}

/** Axial stack: 10 columns × 20 rows, columns 1 mm apart, rows 0.5 mm apart, slices at the given z. */
const axialStack = (zs: number[], extra: Parameters<typeof inst>[1] = {}): DisplaySet =>
  displaySet(zs.map((z) => inst([-5, -5, z], extra)));

describe('MPR eligibility', () => {
  it('accepts a regular stack without warnings', () => {
    expect(mprCheck(axialStack([0, 2, 4, 6]))).toEqual({ ok: true, warnings: [] });
  });

  it('refuses stacks it cannot reconstruct', () => {
    expect(mprCheck(axialStack([0, 2])).refusal).toBe('tooFewSlices');
    expect(mprCheck(axialStack([0, 2, 4], { samplesPerPixel: 3, photometricInterpretation: 'RGB' })).refusal).toBe('color');
    const noGeometry = displaySet([0, 1, 2].map((z) => ({ ...inst([0, 0, z]), geometry: { pixelSpacing: [1, 1] } })));
    expect(mprCheck(noGeometry).refusal).toBe('missingGeometry');
    const noSpacing = displaySet(
      [0, 1, 2].map((z) => ({ ...inst([0, 0, z]), geometry: { imagePositionPatient: [0, 0, z], imageOrientationPatient: AXIAL } })),
    );
    expect(mprCheck(noSpacing).refusal).toBe('missingGeometry');
    // Same position twice without a separating attribute: an unsplit multi-volume series.
    expect(mprCheck(axialStack([0, 2, 2, 4])).refusal).toBe('duplicatePositions');
  });

  it('allows missing slices, irregular spacing and gantry tilt with a warning', () => {
    const gap = mprCheck(axialStack([0, 2, 4, 6, 10, 12, 14]));
    expect(gap.ok).toBe(true);
    expect(gap.warnings.map((w) => w.code)).toContain('missingSlices');
    // 15° tilt: positions shift along y by tan(15°)·z while the image plane stays axial.
    const t = Math.tan((15 * Math.PI) / 180);
    const tilt = mprCheck(displaySet([0, 2, 4, 6].map((z) => inst([-5, -5 + t * z, z]))));
    expect(tilt.ok).toBe(true);
    expect(tilt.warnings.map((w) => w.code)).toEqual(['gantryTilt']);
  });
});

describe('volume grid', () => {
  it('orders slices along row × column with the origin at the lowest slice', () => {
    // Stack listed head-first (descending z): the grid still starts at the lowest slice.
    const v = volumeGeometry(axialStack([6, 4, 2, 0]))!;
    expect(v.origin).toEqual([-5, -5, 0]);
    expect(v.normal).toEqual([0, 0, 1]);
    // spacing = [between columns, between rows, between slices]
    expect(v.spacing).toEqual([1, 0.5, 2]);
    expect(v.dimensions).toEqual([10, 20, 4]);
    expect(voxelToPatient(v, [9, 19, 3])).toEqual([4, 4.5, 6]);
    expect(patientToVoxel(v, [4, 4.5, 6])).toEqual([9, 19, 3]);
    expect(nearestVoxel(v, [0.4, 0.2, 3.1])).toEqual([5, 10, 2]);
    expect(nearestVoxel(v, [-5.6, 0, 0])).toBeUndefined();
  });

  it('uses the average slice spacing across gaps, as the renderer does', () => {
    const v = volumeGeometry(axialStack([0, 2, 4, 6, 10, 12, 14]))!;
    expect(v.spacing[2]).toBeCloseTo(14 / 6, 12);
  });

  it('follows the normal of a sagittal stack', () => {
    // Sagittal: row = +y (posterior), column = −z (feet); normal = row × column = −x (towards patient right).
    const v = volumeGeometry(displaySet([0, 3, 6].map((x) => inst([x, -5, 5], { iop: SAGITTAL }))))!;
    expect(v.normal).toEqual([-1, 0, 0]);
    expect(v.origin).toEqual([6, -5, 5]);
    expect(v.spacing[2]).toBe(3);
  });
});

describe('reformatted planes', () => {
  const v = volumeGeometry(axialStack([0, 2, 4, 6]))!; // x −5..4, y −5..4.5, z 0..6

  it('axial reformat of an axial volume reproduces the original slices', () => {
    const s = reformatStack(v, STANDARD_VIEWS.axial.normal, STANDARD_VIEWS.axial.viewUp)!;
    // Seen from the feet: the normal points to the feet, so plane 0 is the highest slice.
    expect(s.planes).toHaveLength(4);
    expect(s.spacing).toBe(2);
    expect(s.planes.map((p) => planePoint(p, 0, 0)[2])).toEqual([6, 4, 2, 0]);
    // Patient left (+x) on screen right, anterior (−y) at the top.
    expect(s.planes[0]!.orientation.row).toEqual([1, 0, 0]);
    expect(s.planes[0]!.orientation.column).toEqual([0, 1, 0]);
    // Square pixels of the finest spacing (0.5 mm): 9 mm → 19 columns, 9.5 mm → 20 rows.
    expect([s.planes[0]!.columns, s.planes[0]!.rows, s.planes[0]!.rowSpacing]).toEqual([19, 20, 0.5]);
    expect(planePoint(s.planes[0]!, 0, 0)).toEqual([-5, -5, 6]);
  });

  it('sagittal and coronal reformats span the volume with patient-correct screen axes', () => {
    const sag = reformatStack(v, STANDARD_VIEWS.sagittal.normal, STANDARD_VIEWS.sagittal.viewUp)!;
    // Normal +x: slices 1 mm apart from x = −5 to 4.
    expect(sag.planes).toHaveLength(10);
    expect(sag.spacing).toBe(1);
    const p = sag.planes[0]!;
    // Screen right = posterior (+y), screen down = feet (−z); top-left corner = anterior, head.
    expect(p.orientation.row).toEqual([0, 1, 0]);
    expect(p.orientation.column).toEqual([0, 0, -1]);
    expect(planePoint(p, 0, 0)).toEqual([-5, -5, 6]);
    expect([p.columns, p.rows]).toEqual([20, 13]);
    const cor = reformatStack(v, STANDARD_VIEWS.coronal.normal, STANDARD_VIEWS.coronal.viewUp)!;
    // Normal −y: plane 0 is the most posterior (y = 4.5), 0.5 mm apart.
    expect(cor.planes).toHaveLength(20);
    expect(planePoint(cor.planes[0]!, 0, 0)).toEqual([-5, 4.5, 6]);
  });

  it('finds the plane through a point and maps the point to its pixel', () => {
    const sag = reformatStack(v, STANDARD_VIEWS.sagittal.normal, STANDARD_VIEWS.sagittal.viewUp)!;
    const point: Vec3 = [1, 2, 3];
    const k = reformatIndex(sag, point);
    expect(k).toBe(6);
    const px = planePixel(sag.planes[k]!, point);
    expect(px[0]).toBeCloseTo(14, 12); // (2 − (−5)) / 0.5
    expect(px[1]).toBeCloseTo(6, 12); // (6 − 3) / 0.5
    expect(reformatIndex(sag, [99, 0, 0])).toBe(9);
  });

  it('oblique planes are orthonormal and cover every corner of the volume', () => {
    const a = (30 * Math.PI) / 180;
    const normal: Vec3 = [Math.sin(a), 0, Math.cos(a)];
    const s = reformatStack(v, normal, [0, -1, 0])!;
    const p = s.planes[0]!;
    expect(vec3.dot(p.orientation.row, p.orientation.column)).toBeCloseTo(0, 12);
    expect(vec3.dot(p.orientation.row, s.normal)).toBeCloseTo(0, 12);
    // Spacing along the normal: |(sin·1, 0, cos·2)| = √(0.25 + 3) mm.
    expect(s.spacing).toBeCloseTo(Math.sqrt(0.25 + 3), 12);
    expect(spacingAlong(v, normal)).toBeCloseTo(s.spacing, 12);
    for (const c of volumeCorners(v)) {
      const [col, row] = planePixel(p, c);
      expect(col).toBeGreaterThanOrEqual(-1e-9);
      expect(row).toBeGreaterThanOrEqual(-1e-9);
      expect(col).toBeLessThanOrEqual(p.columns - 1 + 0.5);
      expect(row).toBeLessThanOrEqual(p.rows - 1 + 0.5);
      const k = reformatIndex(s, c);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(s.planes.length);
    }
  });

  it('rejects a view-up parallel to the normal', () => {
    expect(reformatStack(v, [0, 0, 1], [0, 0, 1])).toBeUndefined();
  });
});

describe('oblique MPR and slabs', () => {
  it('rotates about an axis by the right-hand rule', () => {
    const r = rotateAbout([1, 0, 0], [0, 0, 1], Math.PI / 2);
    expect(r[0]).toBeCloseTo(0, 12);
    expect(r[1]).toBeCloseTo(1, 12);
    expect(r[2]).toBeCloseTo(0, 12);
    // A vector on the axis does not move; lengths are kept.
    expect(rotateAbout([0, 0, 2], [0, 0, 1], 1.234)).toEqual([0, 0, 2]);
    const q = rotateAbout([1, 2, 3], vec3.normalize([1, 1, 0]), 0.7);
    expect(vec3.length(q)).toBeCloseTo(Math.sqrt(14), 12);
  });

  it('finds the point shared by three planes', () => {
    const p = planesIntersection(
      { normal: [1, 0, 0], point: [3, 9, 9] },
      { normal: [0, 1, 0], point: [9, -2, 9] },
      { normal: [0, 0, 1], point: [9, 9, 5] },
    )!;
    expect(p).toEqual([3, -2, 5]);
    // Oblique: x + y = 2, y = 1, z = 0 → (1, 1, 0).
    const q = planesIntersection(
      { normal: vec3.normalize([1, 1, 0]), point: [2, 0, 0] },
      { normal: [0, 1, 0], point: [0, 1, 0] },
      { normal: [0, 0, 1], point: [0, 0, 0] },
    )!;
    expect(q[0]).toBeCloseTo(1, 12);
    expect(q[1]).toBeCloseTo(1, 12);
    expect(q[2]).toBeCloseTo(0, 12);
    expect(
      planesIntersection(
        { normal: [0, 0, 1], point: [0, 0, 0] },
        { normal: [0, 0, 1], point: [0, 0, 1] },
        { normal: [1, 0, 0], point: [0, 0, 0] },
      ),
    ).toBeUndefined();
  });

  it('samples a slab symmetrically and projects MIP / MinIP / average', () => {
    expect(slabOffsets(10, 2.5)).toEqual([-5, -2.5, 0, 2.5, 5]);
    expect(slabOffsets(4, 2.5)).toEqual([0]);
    expect(slabOffsets(0, 1)).toEqual([0]);
    // A ray crossing a 1000 HU sphere edge, water and air.
    const ray = [0, 1000, 0, -1000, undefined];
    expect(slabProject(ray, 'mip')).toBe(1000);
    expect(slabProject(ray, 'minip')).toBe(-1000);
    expect(slabProject(ray, 'avg')).toBe(0);
    expect(slabProject([undefined], 'mip')).toBeUndefined();
  });
});
