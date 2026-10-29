/**
 * Display geometry helpers used by the viewer: patient directions of screen axes, pixel-spacing basis,
 * plane classification and scale-bar lengths. Pure functions, unit-tested against analytic cases.
 */
import { type Vec3, parseImageOrientation, sliceNormal, vec3 } from './geometry.js';
import { edgeLabels, patientOrientationToVector, type EdgeLabels } from './orientation.js';
import type { InstanceRecord } from './types.js';

/**
 * Screen axes of a rendering camera: right = viewUp × viewPlaneNormal, down = −viewUp
 * (VTK convention: the camera looks along −viewPlaneNormal).
 */
export function cameraScreenAxes(viewUp: Vec3, viewPlaneNormal: Vec3): { right: Vec3; down: Vec3 } {
  return { right: vec3.normalize(vec3.cross(viewUp, viewPlaneNormal)), down: vec3.normalize(vec3.negate(viewUp)) };
}

/**
 * Patient-space directions of the screen axes.
 * `worldRow`/`worldColumn` are the image axes in the renderer's world space (for cross-sectional images these equal
 * IOP; for projection images the renderer uses a synthetic plane). `patientRow`/`patientColumn` are the true patient
 * directions of the image axes (from IOP or PatientOrientation).
 */
export function screenPatientAxes(
  screen: { right: Vec3; down: Vec3 },
  worldRow: Vec3,
  worldColumn: Vec3,
  patientRow: Vec3,
  patientColumn: Vec3,
): { right: Vec3; down: Vec3 } {
  const map = (v: Vec3): Vec3 =>
    vec3.add(vec3.scale(patientRow, vec3.dot(v, worldRow)), vec3.scale(patientColumn, vec3.dot(v, worldColumn)));
  return { right: map(screen.right), down: map(screen.down) };
}

/** Patient directions of the image row/column axes, from IOP or (projection images) PatientOrientation. */
export function patientImageAxes(inst: InstanceRecord, iop?: readonly number[]): { row: Vec3; column: Vec3 } | undefined {
  const o = parseImageOrientation(iop ?? inst.geometry.imageOrientationPatient);
  if (o) return { row: o.row, column: o.column };
  const po = inst.patientOrientation;
  if (po) {
    const row = patientOrientationToVector(po[0]);
    const column = patientOrientationToVector(po[1]);
    if (row && column) return { row, column };
  }
  return undefined;
}

/** Orientation labels for a rendered image, or undefined when the patient orientation is unknown. */
export function viewLabels(
  viewUp: Vec3,
  viewPlaneNormal: Vec3,
  worldRow: Vec3,
  worldColumn: Vec3,
  axes: { row: Vec3; column: Vec3 } | undefined,
): EdgeLabels | undefined {
  if (!axes) return undefined;
  const screen = cameraScreenAxes(viewUp, viewPlaneNormal);
  const p = screenPatientAxes(screen, worldRow, worldColumn, axes.row, axes.column);
  return edgeLabels(p.right, p.down);
}

export type SpacingBasis =
  | { kind: 'pixelSpacing'; rowMm: number; columnMm: number }
  | { kind: 'imagerMagnified'; rowMm: number; columnMm: number; magnification: number }
  | { kind: 'imagerPixelSpacing'; rowMm: number; columnMm: number }
  | { kind: 'ultrasound' }
  | { kind: 'none' };

/**
 * Which pixel spacing a length measurement must use (PS3.3 C.7.6.2.1.1, C.8.11.4, C.8.5.5):
 * Pixel Spacing (patient plane) when present; otherwise Imager Pixel Spacing corrected by
 * Estimated Radiographic Magnification Factor when present; otherwise Imager Pixel Spacing (at the detector);
 * otherwise ultrasound regions; otherwise uncalibrated.
 */
export function spacingBasis(inst: InstanceRecord, frameSpacing?: readonly [number, number]): SpacingBasis {
  const ps = frameSpacing ?? inst.geometry.pixelSpacing;
  if (ps && ps[0] > 0 && ps[1] > 0) return { kind: 'pixelSpacing', rowMm: ps[0], columnMm: ps[1] };
  const ips = inst.imagerPixelSpacing;
  if (ips && ips[0] > 0 && ips[1] > 0) {
    const mag = inst.estimatedRadiographicMagnificationFactor;
    if (mag && mag > 0) return { kind: 'imagerMagnified', rowMm: ips[0] / mag, columnMm: ips[1] / mag, magnification: mag };
    return { kind: 'imagerPixelSpacing', rowMm: ips[0], columnMm: ips[1] };
  }
  if (inst.hasUltrasoundRegions) return { kind: 'ultrasound' };
  return { kind: 'none' };
}

export type PlaneKind = 'axial' | 'sagittal' | 'coronal' | 'oblique' | 'projection' | 'unknown';

/** Classifies an image plane by its normal; "oblique" when no axis dominates by ≥ cos(30°)… simplified to > 0.9. */
export function planeKind(inst: InstanceRecord): PlaneKind {
  const o = parseImageOrientation(inst.geometry.imageOrientationPatient ?? inst.perFrame?.[0]?.imageOrientationPatient);
  if (!o) return inst.patientOrientation ? 'projection' : 'unknown';
  const n = sliceNormal(o).map(Math.abs) as [number, number, number];
  const max = Math.max(...n);
  if (max < 0.9) return 'oblique';
  return n[2] === max ? 'axial' : n[0] === max ? 'sagittal' : 'coronal';
}

/** Largest "nice" length (1, 2, 5 × 10^k mm) not exceeding maxMm. */
export function niceScaleLength(maxMm: number): number {
  if (!(maxMm > 0)) return 0;
  const exp = Math.floor(Math.log10(maxMm));
  for (const m of [5, 2, 1]) {
    const v = m * 10 ** exp;
    if (v <= maxMm) return v;
  }
  return 10 ** exp;
}
