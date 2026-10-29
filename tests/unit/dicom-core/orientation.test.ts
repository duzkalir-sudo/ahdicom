import { describe, expect, it } from 'vitest';
import {
  directionToLabel,
  edgeLabels,
  parseImageOrientation,
  patientOrientationToVector,
  screenAxes,
  sliceNormal,
  type Vec3,
  viewLabels,
  spacingBasis,
  planeKind,
  niceScaleLength,
  sliceLocation,
} from '@clinic/dicom-core';

const AXIAL = parseImageOrientation([1, 0, 0, 0, 1, 0])!;
const SAGITTAL = parseImageOrientation([0, 1, 0, 0, 0, -1])!;
const CORONAL = parseImageOrientation([1, 0, 0, 0, 0, -1])!;

function labels(rowDir: Vec3, colDir: Vec3, rotationDeg = 0, flipHorizontal = false, flipVertical = false) {
  const { right, down } = screenAxes(rowDir, colDir, { rotationDeg, flipHorizontal, flipVertical });
  return edgeLabels(right, down);
}

describe('directionToLabel', () => {
  it('labels the six cardinal LPS directions', () => {
    expect(directionToLabel([1, 0, 0])).toBe('L');
    expect(directionToLabel([-1, 0, 0])).toBe('R');
    expect(directionToLabel([0, 1, 0])).toBe('P');
    expect(directionToLabel([0, -1, 0])).toBe('A');
    expect(directionToLabel([0, 0, 1])).toBe('H');
    expect(directionToLabel([0, 0, -1])).toBe('F');
  });

  it('orders oblique letters by magnitude and drops components below the threshold', () => {
    const a = (20 * Math.PI) / 180;
    expect(directionToLabel([Math.cos(a), Math.sin(a), 0])).toBe('LP');
    expect(directionToLabel([-Math.sin(a), 0, Math.cos(a)])).toBe('HR');
    // 2° obliquity: secondary component 0.035 < 0.1 → primary only
    const b = (2 * Math.PI) / 180;
    expect(directionToLabel([Math.cos(b), 0, Math.sin(b)])).toBe('L');
  });
});

describe('edge labels for standard planes (radiological display, no transform)', () => {
  it('axial: patient right on screen left, anterior at top', () => {
    expect(labels(AXIAL.row, AXIAL.column)).toEqual({ left: 'R', right: 'L', top: 'A', bottom: 'P' });
  });
  it('sagittal: anterior on screen left, head at top', () => {
    expect(labels(SAGITTAL.row, SAGITTAL.column)).toEqual({ left: 'A', right: 'P', top: 'H', bottom: 'F' });
  });
  it('coronal: patient right on screen left, head at top', () => {
    expect(labels(CORONAL.row, CORONAL.column)).toEqual({ left: 'R', right: 'L', top: 'H', bottom: 'F' });
  });
});

describe('edge labels after rotate/flip (asymmetric phantom: every inversion changes the result)', () => {
  it('rotate 90° clockwise: former top (A) moves to the right', () => {
    expect(labels(AXIAL.row, AXIAL.column, 90)).toEqual({ right: 'A', bottom: 'L', left: 'P', top: 'R' });
  });
  it('rotate 180°', () => {
    expect(labels(AXIAL.row, AXIAL.column, 180)).toEqual({ right: 'R', left: 'L', top: 'P', bottom: 'A' });
  });
  it('rotate 270° clockwise', () => {
    expect(labels(AXIAL.row, AXIAL.column, 270)).toEqual({ right: 'P', left: 'A', top: 'L', bottom: 'R' });
  });
  it('flip horizontal swaps left/right only', () => {
    expect(labels(AXIAL.row, AXIAL.column, 0, true)).toEqual({ left: 'L', right: 'R', top: 'A', bottom: 'P' });
  });
  it('flip vertical swaps top/bottom only', () => {
    expect(labels(CORONAL.row, CORONAL.column, 0, false, true)).toEqual({
      left: 'R',
      right: 'L',
      top: 'F',
      bottom: 'H',
    });
  });
  it('flip H + flip V equals rotate 180°', () => {
    expect(labels(AXIAL.row, AXIAL.column, 0, true, true)).toEqual(labels(AXIAL.row, AXIAL.column, 180));
  });
  it('rotating 4 × 90° returns to the start', () => {
    expect(labels(SAGITTAL.row, SAGITTAL.column, 360)).toEqual(labels(SAGITTAL.row, SAGITTAL.column, 0));
  });
});

describe('slice normal and IOP parsing', () => {
  it('normal = row × column', () => {
    expect(sliceNormal(AXIAL)).toEqual([0, 0, 1]);
    expect(sliceNormal(SAGITTAL)).toEqual([-1, 0, 0]);
    expect(sliceNormal(CORONAL)).toEqual([0, 1, 0]);
  });
  it('rejects malformed IOP', () => {
    expect(parseImageOrientation([1, 0, 0, 1, 0, 0])).toBeUndefined();
    expect(parseImageOrientation([0, 0, 0, 0, 1, 0])).toBeUndefined();
    expect(parseImageOrientation([1, 0, 0, 0, 1])).toBeUndefined();
    expect(parseImageOrientation([1, 0, Number.NaN, 0, 1, 0])).toBeUndefined();
  });
});

describe('PatientOrientation (projection images)', () => {
  it('parses single and combined letters', () => {
    expect(patientOrientationToVector('A')).toEqual([0, -1, 0]);
    const fl = patientOrientationToVector('FL')!;
    expect(fl[0]).toBeCloseTo(Math.SQRT1_2);
    expect(fl[2]).toBeCloseTo(-Math.SQRT1_2);
    expect(patientOrientationToVector('X')).toBeUndefined();
    expect(patientOrientationToVector('')).toBeUndefined();
  });
  it('PA chest (rows → L, columns → F) shows R on screen left, H on top', () => {
    const row = patientOrientationToVector('L')!;
    const col = patientOrientationToVector('F')!;
    expect(labels(row, col)).toEqual({ left: 'R', right: 'L', top: 'H', bottom: 'F' });
  });
});

describe('camera-based labels (viewer path)', () => {
  // Cornerstone stack camera for an image: viewUp = −column, viewPlaneNormal = column × row.
  const camFor = (row: Vec3, col: Vec3) => ({
    viewUp: [-col[0], -col[1], -col[2]] as Vec3,
    vpn: [col[1] * row[2] - col[2] * row[1], col[2] * row[0] - col[0] * row[2], col[0] * row[1] - col[1] * row[0]] as Vec3,
  });
  it('matches the analytic labels for axial, sagittal and coronal', () => {
    for (const o of [AXIAL, SAGITTAL, CORONAL]) {
      const { viewUp, vpn } = camFor(o.row, o.column);
      expect(viewLabels(viewUp, vpn, o.row, o.column, { row: o.row, column: o.column })).toEqual(labels(o.row, o.column));
    }
  });
  it('maps projection images through PatientOrientation using the synthetic world plane', () => {
    const worldRow: Vec3 = [1, 0, 0];
    const worldCol: Vec3 = [0, 1, 0];
    const { viewUp, vpn } = camFor(worldRow, worldCol);
    const axes = { row: patientOrientationToVector('P')!, column: patientOrientationToVector('F')! };
    expect(viewLabels(viewUp, vpn, worldRow, worldCol, axes)).toEqual({ left: 'A', right: 'P', top: 'H', bottom: 'F' });
  });
});

describe('spacing basis and helpers', () => {
  const base = { fileId: 'x', fileName: 'x', fileSize: 1, transferSyntaxUid: '', sopClassUid: '', sopInstanceUid: '', studyInstanceUid: '', seriesInstanceUid: '', numberOfFrames: 1, hasPixelData: true, charsetUncertain: false };
  it('prefers Pixel Spacing, then magnification-corrected Imager Pixel Spacing', () => {
    expect(spacingBasis({ ...base, geometry: { pixelSpacing: [0.5, 0.4] } })).toEqual({ kind: 'pixelSpacing', rowMm: 0.5, columnMm: 0.4 });
    const mag = spacingBasis({ ...base, geometry: {}, imagerPixelSpacing: [0.2, 0.2], estimatedRadiographicMagnificationFactor: 1.1 });
    expect(mag.kind).toBe('imagerMagnified');
    expect(mag.kind === 'imagerMagnified' && mag.rowMm).toBeCloseTo(0.2 / 1.1, 12);
    expect(spacingBasis({ ...base, geometry: {}, imagerPixelSpacing: [0.2, 0.2] }).kind).toBe('imagerPixelSpacing');
    expect(spacingBasis({ ...base, geometry: {}, hasUltrasoundRegions: true }).kind).toBe('ultrasound');
    expect(spacingBasis({ ...base, geometry: {} }).kind).toBe('none');
  });
  it('classifies planes', () => {
    expect(planeKind({ ...base, geometry: { imageOrientationPatient: [1, 0, 0, 0, 1, 0] } })).toBe('axial');
    expect(planeKind({ ...base, geometry: { imageOrientationPatient: [0, 1, 0, 0, 0, -1] } })).toBe('sagittal');
    expect(planeKind({ ...base, geometry: { imageOrientationPatient: [1, 0, 0, 0, 0, -1] } })).toBe('coronal');
    const c = Math.cos(0.6), s = Math.sin(0.6);
    expect(planeKind({ ...base, geometry: { imageOrientationPatient: [1, 0, 0, 0, c, s] } })).toBe('oblique');
    expect(planeKind({ ...base, geometry: {}, patientOrientation: ['L', 'F'] })).toBe('projection');
  });
  it('nice scale lengths', () => {
    expect(niceScaleLength(73)).toBe(50);
    expect(niceScaleLength(19.9)).toBe(10);
    expect(niceScaleLength(2.1)).toBe(2);
    expect(niceScaleLength(0.6)).toBe(0.5);
  });
});

describe('slice location along the normal', () => {
  it('projects IPP on the normal and names the positive direction', () => {
    expect(sliceLocation([10, 20, 30], [0, 0, 1])).toEqual({ mm: 30, towards: 'H' });
    // Sagittal normal = row x column = patient Right: x = +60 (Left) is -60 mm towards R
    expect(sliceLocation([60, -127, 127], [-1, 0, 0])).toEqual({ mm: -60, towards: 'R' });
    expect(sliceLocation(undefined, [0, 0, 1])).toBeUndefined();
  });
});
