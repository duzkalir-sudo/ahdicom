/**
 * Series comparison geometry against analytic planes with hand-computed answers (CLAUDE.md rule 9).
 */
import { describe, expect, it } from 'vitest';
import {
  canAutoSync,
  cursorTarget,
  nearestSlice,
  planeCenter,
  planeFromGeometry,
  planePixel,
  planePoint,
  referenceLine,
  sliceAtPosition,
  slicePosition,
  splitVolumes,
  type ImagePlane,
  type InstanceRecord,
} from '@ahdicom/dicom-core';

type V6 = [number, number, number, number, number, number];
type V3 = [number, number, number];

function plane(ipp: V3, iop: V6, rows: number, columns: number, spacing: [number, number] = [1, 1], forUid = '1.2.3'): ImagePlane {
  const p = planeFromGeometry({ imagePositionPatient: ipp, imageOrientationPatient: iop, pixelSpacing: spacing }, rows, columns, forUid);
  if (!p) throw new Error('plane');
  return p;
}

const AXIAL: V6 = [1, 0, 0, 0, 1, 0];
const SAGITTAL: V6 = [0, 1, 0, 0, 0, -1];
const CORONAL: V6 = [1, 0, 0, 0, 0, -1];

/** 255 × 255 axial image at height z, 1 mm pixels, centred on the z axis. */
const axialAt = (z: number): ImagePlane => plane([-127, -127, z], AXIAL, 255, 255);

describe('image planes', () => {
  it('maps pixels to patient coordinates and back', () => {
    const p = axialAt(10);
    expect(planePoint(p, 0, 0)).toEqual([-127, -127, 10]);
    expect(planeCenter(p)).toEqual([0, 0, 10]);
    const px = planePixel(p, [3, -4, 99]);
    expect(px[0]).toBeCloseTo(130, 12);
    expect(px[1]).toBeCloseTo(123, 12);
    // Anisotropic: rows 2 mm apart, columns 0.5 mm apart.
    const a = plane([0, 0, 0], AXIAL, 10, 10, [2, 0.5]);
    expect(planePoint(a, 4, 3)).toEqual([2, 6, 0]);
  });

  it('is undefined without position, orientation or spacing', () => {
    expect(planeFromGeometry({ imageOrientationPatient: AXIAL, pixelSpacing: [1, 1] }, 10, 10)).toBeUndefined();
    expect(planeFromGeometry({ imagePositionPatient: [0, 0, 0], pixelSpacing: [1, 1] }, 10, 10)).toBeUndefined();
    expect(planeFromGeometry({ imagePositionPatient: [0, 0, 0], imageOrientationPatient: AXIAL }, 10, 10)).toBeUndefined();
  });
});

describe('automatic sync eligibility', () => {
  const tilted = (deg: number): ImagePlane => {
    const t = (deg * Math.PI) / 180;
    return plane([0, 0, 0], [1, 0, 0, 0, Math.cos(t), Math.sin(t)], 10, 10);
  };
  it('requires the same Frame of Reference and planes within 5°', () => {
    expect(canAutoSync(axialAt(0), tilted(4))).toBe(true);
    expect(canAutoSync(axialAt(0), tilted(6))).toBe(false);
    expect(canAutoSync(axialAt(0), tilted(6), 7)).toBe(true);
    expect(canAutoSync(axialAt(0), plane([0, 0, 0], AXIAL, 10, 10, [1, 1], '9.9'))).toBe(false);
    const noFor = planeFromGeometry({ imagePositionPatient: [0, 0, 0], imageOrientationPatient: AXIAL, pixelSpacing: [1, 1] }, 10, 10)!;
    expect(canAutoSync(noFor, noFor)).toBe(false);
  });
});

describe('slice matching', () => {
  const stack = [0, 2.5, 5, 7.5, 10].map(axialAt);

  it('nearest slice along the normal, inside within half a spacing', () => {
    expect(nearestSlice(stack, [0, 0, 3.1])).toMatchObject({ index: 1, inside: true });
    expect(nearestSlice(stack, [0, 0, 3.1])!.distanceMm).toBeCloseTo(0.6, 12);
    expect(nearestSlice(stack, [50, -20, 10.9])).toMatchObject({ index: 4, inside: true });
    expect(nearestSlice(stack, [0, 0, 11.5])).toMatchObject({ index: 4, inside: false });
    expect(nearestSlice(stack, [0, 0, -5])).toMatchObject({ index: 0, inside: false });
    expect(nearestSlice([], [0, 0, 0])).toBeUndefined();
  });

  it('works for a descending stack and an oblique stack', () => {
    const down = [10, 7.5, 5, 2.5, 0].map(axialAt);
    expect(nearestSlice(down, [0, 0, 7.4])!.index).toBe(1);
    // Coronal slices at y = −20, −10, 0, 10; a point at y = 4 belongs to y = 0.
    const cor = [-20, -10, 0, 10].map((y) => plane([-127, y, 127], CORONAL, 255, 255));
    expect(nearestSlice(cor, [33, 4, -50])).toMatchObject({ index: 2, inside: true });
  });

  it('manual link keeps a position offset', () => {
    const prior = [0, 3, 6, 9, 12].map(axialAt);
    const n: V3 = [0, 0, 1];
    // Linked when current slice z = 5 (index 2 of stack) showed prior z = 9: offset +4 mm.
    const offset = slicePosition(prior[3]!, n) - slicePosition(stack[2]!, n);
    expect(offset).toBe(4);
    // Current moves to z = 7.5 → prior target 11.5 → nearest prior slice z = 12.
    expect(sliceAtPosition(prior, n, slicePosition(stack[3]!, n) + offset)).toBe(4);
    expect(sliceAtPosition([], n, 0)).toBeUndefined();
  });
});

describe('reference lines', () => {
  it('sagittal on axial is a vertical line at the sagittal x position', () => {
    // Sagittal at x = 10 covering y −127…127, z 127…−127.
    const sag = plane([10, -127, 127], SAGITTAL, 255, 255);
    const line = referenceLine(sag, axialAt(0))!;
    expect(line).toBeDefined();
    for (const p of line) expect(p[0]).toBeCloseTo(137, 9);
    const rows = line.map((p) => p[1]).sort((a, b) => a - b);
    expect(rows[0]).toBeCloseTo(-0.5, 9);
    expect(rows[1]).toBeCloseTo(254.5, 9);
  });

  it('is limited to the extent of the source image', () => {
    // Small sagittal image: y 0…50 (51 columns), z 10…−10 (21 rows) → axial rows 126.5…177.5 at column 137.
    const sag = plane([10, 0, 10], SAGITTAL, 21, 51);
    const line = referenceLine(sag, axialAt(0))!;
    const rows = line.map((p) => p[1]).sort((a, b) => a - b);
    expect(rows[0]).toBeCloseTo(126.5, 9);
    expect(rows[1]).toBeCloseTo(177.5, 9);
    // The same image does not reach z = 20: no line.
    expect(referenceLine(sag, axialAt(20))).toBeUndefined();
  });

  it('axial on coronal is a horizontal line at the axial height', () => {
    // Coronal image: rows go from z = 127 downwards, so z = 27 is row 100.
    const cor = plane([-127, 0, 127], CORONAL, 255, 255);
    const line = referenceLine(axialAt(27), cor)!;
    for (const p of line) expect(p[1]).toBeCloseTo(100, 9);
  });

  it('oblique source: line with the expected slope', () => {
    // Source plane through the origin tilted 30° about z (normal (cos30, sin30, 0)) on an axial target at z = 0:
    // its trace satisfies x·cos30 + y·sin30 = 0 → column/row slope −cot30 in pixel units.
    const t = Math.PI / 6;
    const src = plane([0, 0, 50], [-Math.sin(t), Math.cos(t), 0, 0, 0, -1], 101, 300, [1, 1]);
    const [a, b] = referenceLine({ ...src, origin: planePoint(src, -150, 0) }, axialAt(0))!;
    const slope = (b[0] - a[0]) / (b[1] - a[1]);
    expect(slope).toBeCloseTo(-Math.sin(t) / Math.cos(t), 9);
    // Both ends satisfy the plane equation.
    for (const p of [a, b]) {
      const w = planePoint(axialAt(0), p[0], p[1]);
      expect(w[0] * Math.cos(t) + w[1] * Math.sin(t)).toBeCloseTo(0, 6);
    }
  });

  it('none for (near-)parallel planes', () => {
    expect(referenceLine(axialAt(0), axialAt(5))).toBeUndefined();
    const t = (1 * Math.PI) / 180;
    expect(referenceLine(plane([0, 0, 0], [1, 0, 0, 0, Math.cos(t), Math.sin(t)], 10, 10), axialAt(0))).toBeUndefined();
  });
});

describe('3D cursor', () => {
  it('finds the slice and pixel of a patient point', () => {
    const stack = [0, 2.5, 5, 7.5].map(axialAt);
    const c = cursorTarget(stack, [10, -20, 5.4])!;
    expect(c).toMatchObject({ index: 2, inside: true });
    expect(c.pixel[0]).toBeCloseTo(137, 12);
    expect(c.pixel[1]).toBeCloseTo(107, 12);
    expect(cursorTarget([], [0, 0, 0])).toBeUndefined();
  });
});

describe('multi-volume split', () => {
  const inst = (k: number, z: number, extra: Partial<InstanceRecord> & { temporal?: number } = {}): InstanceRecord => {
    const { temporal, ...rest } = extra;
    return {
      fileId: `f${k}`,
      fileName: `IM${k}`,
      fileSize: 1,
      transferSyntaxUid: '1.2.840.10008.1.2.1',
      sopClassUid: '1.2.840.10008.5.1.4.1.1.4',
      sopInstanceUid: `1.2.${k}`,
      studyInstanceUid: '1.2',
      seriesInstanceUid: '1.2.9',
      numberOfFrames: 1,
      hasPixelData: true,
      rows: 8,
      columns: 8,
      instanceNumber: k,
      geometry: {
        imagePositionPatient: [0, 0, z],
        imageOrientationPatient: AXIAL,
        pixelSpacing: [1, 1],
        ...(temporal !== undefined ? { temporalPositionIndex: temporal } : {}),
      },
      charsetUncertain: false,
      ...rest,
    };
  };
  const o = { row: [1, 0, 0] as const, column: [0, 1, 0] as const };

  it('DWI: one volume per b-value', () => {
    const list = [0, 1000].flatMap((b, j) => [0, 5, 10].map((z, k) => inst(j * 10 + k, z, { diffusionBValue: b })));
    const parts = splitVolumes(list, o);
    expect(parts.map((p) => p.splitBy)).toEqual([
      { key: 'bValue', value: 0 },
      { key: 'bValue', value: 1000 },
    ]);
    expect(parts.map((p) => p.instances.length)).toEqual([3, 3]);
  });

  it('multi-phase CT: temporal position wins over acquisition number', () => {
    const list = [1, 2, 3].flatMap((ph) => [0, 2].map((z, k) => inst(ph * 10 + k, z, { temporal: ph, acquisitionNumber: 1 })));
    expect(splitVolumes(list, o).map((p) => p.splitBy)).toEqual([1, 2, 3].map((v) => ({ key: 'temporal', value: v })));
  });

  it('skips an attribute that does not separate the volumes and uses the next one', () => {
    // Echo numbers identical, acquisitions differ.
    const list = [1, 2].flatMap((acq) => [0, 4].map((z, k) => inst(acq * 10 + k, z, { echoNumbers: 1, acquisitionNumber: acq })));
    expect(splitVolumes(list, o).map((p) => p.splitBy?.key)).toEqual(['acquisition', 'acquisition']);
  });

  it('stays one group without duplicates or without a separating attribute', () => {
    expect(
      splitVolumes(
        [0, 1, 2].map((z) => inst(z, z)),
        o,
      ),
    ).toHaveLength(1);
    const dup = [inst(1, 0), inst(2, 0), inst(3, 1)];
    const one = splitVolumes(dup, o);
    expect(one).toHaveLength(1);
    expect(one[0]!.splitBy).toBeUndefined();
    expect(splitVolumes(dup, undefined)).toHaveLength(1);
  });
});
