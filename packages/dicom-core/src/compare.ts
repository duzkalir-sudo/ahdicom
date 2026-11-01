/**
 * Geometry for comparing series: image planes, slice matching, reference lines and the 3D cursor.
 * Pure functions on patient coordinates (DICOM LPS, mm); no DOM/Electron.
 */
import {
  type ImageOrientation,
  type Vec3,
  parseImageOrientation,
  parseVec3,
  patientToPixel,
  planeAngleDeg,
  sliceNormal,
  vec3,
} from './geometry.js';
import type { FrameGeometry } from './types.js';
import type { Point2 } from './measure.js';

/** One image's plane: pixel (column c, row r) centre is origin + row·columnSpacing·c + column·rowSpacing·r. */
export interface ImagePlane {
  /** Image Position (Patient): centre of pixel (0, 0). */
  origin: Vec3;
  orientation: ImageOrientation;
  normal: Vec3;
  /** Millimetres between rows / between columns (Pixel Spacing [0] / [1]). */
  rowSpacing: number;
  columnSpacing: number;
  rows: number;
  columns: number;
  frameOfReferenceUid?: string;
}

/** Plane of an image from its geometry, or undefined when position, orientation or spacing is missing. */
export function planeFromGeometry(g: FrameGeometry, rows: number, columns: number, frameOfReferenceUid?: string): ImagePlane | undefined {
  const origin = parseVec3(g.imagePositionPatient);
  const orientation = parseImageOrientation(g.imageOrientationPatient);
  const ps = g.pixelSpacing;
  if (!origin || !orientation || !ps || !(ps[0] > 0) || !(ps[1] > 0) || !(rows > 0) || !(columns > 0)) return undefined;
  return {
    origin,
    orientation,
    normal: sliceNormal(orientation),
    rowSpacing: ps[0],
    columnSpacing: ps[1],
    rows,
    columns,
    ...(frameOfReferenceUid ? { frameOfReferenceUid } : {}),
  };
}

/** Patient coordinate of a (continuous) pixel position. */
export function planePoint(plane: ImagePlane, column: number, row: number): Vec3 {
  return vec3.add(
    plane.origin,
    vec3.add(vec3.scale(plane.orientation.row, plane.columnSpacing * column), vec3.scale(plane.orientation.column, plane.rowSpacing * row)),
  );
}

/** Pixel position [column, row] of a patient point projected onto the plane. */
export function planePixel(plane: ImagePlane, p: Vec3): [number, number] {
  return patientToPixel(p, plane.origin, plane.orientation, [plane.rowSpacing, plane.columnSpacing]);
}

/** Centre of the image in patient coordinates. */
export function planeCenter(plane: ImagePlane): Vec3 {
  return planePoint(plane, (plane.columns - 1) / 2, (plane.rows - 1) / 2);
}

/** Signed distance (mm) of a point from the plane along its normal. */
export function distanceToPlane(plane: ImagePlane, p: Vec3): number {
  return vec3.dot(vec3.sub(p, plane.origin), plane.normal);
}

/** Angle between two image planes in degrees (0..90). */
export function planesAngleDeg(a: ImagePlane, b: ImagePlane): number {
  return planeAngleDeg(a.normal, b.normal);
}

/** Default tolerance for automatic slice sync: planes at most 5° apart (spec §3.5). */
export const SYNC_TOLERANCE_DEG = 5;

/**
 * Automatic slice sync is allowed between two display sets when both declare the same Frame of Reference and their
 * planes are within the tolerance. Without a Frame of Reference, positions are not comparable.
 */
export function canAutoSync(a: ImagePlane, b: ImagePlane, toleranceDeg = SYNC_TOLERANCE_DEG): boolean {
  return Boolean(a.frameOfReferenceUid) && a.frameOfReferenceUid === b.frameOfReferenceUid && planesAngleDeg(a, b) <= toleranceDeg;
}

export interface SliceMatch {
  /** Index of the slice closest to the point along the stack normal. */
  index: number;
  /** Distance (mm) from the point to that slice's plane. */
  distanceMm: number;
  /** False when the point lies beyond the first or last slice by more than half a slice spacing. */
  inside: boolean;
}

/** Median of the absolute distances between consecutive slices (mm), or undefined for fewer than two slices. */
function stackSpacing(planes: readonly ImagePlane[]): number | undefined {
  const n = planes[0]!.normal;
  const d: number[] = [];
  for (let i = 1; i < planes.length; i++) {
    const s = Math.abs(vec3.dot(vec3.sub(planes[i]!.origin, planes[i - 1]!.origin), n));
    if (s > 1e-3) d.push(s);
  }
  if (d.length === 0) return undefined;
  d.sort((x, y) => x - y);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m]! : (d[m - 1]! + d[m]!) / 2;
}

/**
 * The slice of a stack whose plane is nearest to a patient point. Distances are measured along each slice's own
 * normal, so tilted or slightly non-parallel stacks are handled. Single images count as inside within 1 mm.
 */
export function nearestSlice(planes: readonly ImagePlane[], p: Vec3): SliceMatch | undefined {
  if (planes.length === 0) return undefined;
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  planes.forEach((pl, i) => {
    const d = Math.abs(distanceToPlane(pl, p));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const half = (stackSpacing(planes) ?? 2) / 2;
  return { index: best, distanceMm: bestD, inside: bestD <= half + 1e-6 };
}

/**
 * Clips the parametric segment p0 + t·(p1 − p0), t ∈ [t0, t1], to the pixel rectangle of an image
 * (pixel edges at −½ and size − ½). Returns the clipped parameter range or undefined (Liang–Barsky).
 */
function clipToImage(p0: Point2, p1: Point2, columns: number, rows: number, t0 = 0, t1 = 1): [number, number] | undefined {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const edges: [number, number][] = [
    [-dx, p0[0] + 0.5],
    [dx, columns - 0.5 - p0[0]],
    [-dy, p0[1] + 0.5],
    [dy, rows - 0.5 - p0[1]],
  ];
  let lo = t0;
  let hi = t1;
  for (const [q, r] of edges) {
    if (Math.abs(q) < 1e-12) {
      if (r < 0) return undefined;
      continue;
    }
    const t = r / q;
    if (q < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return undefined;
  }
  return [lo, hi];
}

/** Reference lines are not drawn between planes closer than this to parallel (they would be unstable). */
export const REFERENCE_MIN_ANGLE_DEG = 2;

/**
 * Reference (scout) line: where the source image intersects the target image, as a segment in target pixel
 * coordinates. The segment is the intersection of both image rectangles; undefined when the planes are (nearly)
 * parallel or the images do not intersect.
 */
export function referenceLine(source: ImagePlane, target: ImagePlane, minAngleDeg = REFERENCE_MIN_ANGLE_DEG): [Point2, Point2] | undefined {
  if (planesAngleDeg(source, target) < minAngleDeg) return undefined;
  // Source plane n·(x − o) = 0 on target pixels: a·c + b·r + k = 0.
  const n = source.normal;
  const a = target.columnSpacing * vec3.dot(n, target.orientation.row);
  const b = target.rowSpacing * vec3.dot(n, target.orientation.column);
  const k = vec3.dot(n, vec3.sub(target.origin, source.origin));
  if (Math.abs(a) < 1e-12 && Math.abs(b) < 1e-12) return undefined;
  // Two far-apart points on that line, then clip to the target image and to the source image.
  const span = 4 * (target.rows + target.columns);
  const base: Point2 = Math.abs(a) >= Math.abs(b) ? [-k / a, 0] : [0, -k / b];
  const dir: Point2 = [-b, a];
  const len = Math.hypot(dir[0], dir[1]);
  const p0: Point2 = [base[0] - (dir[0] / len) * span, base[1] - (dir[1] / len) * span];
  const p1: Point2 = [base[0] + (dir[0] / len) * span, base[1] + (dir[1] / len) * span];
  const inTarget = clipToImage(p0, p1, target.columns, target.rows);
  if (!inTarget) return undefined;
  const s0 = planePixel(source, planePoint(target, p0[0], p0[1]));
  const s1 = planePixel(source, planePoint(target, p1[0], p1[1]));
  const both = clipToImage(s0, s1, source.columns, source.rows, inTarget[0], inTarget[1]);
  if (!both) return undefined;
  const at = (t: number): Point2 => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  return [at(both[0]), at(both[1])];
}

export interface CursorTarget extends SliceMatch {
  /** Pixel position of the point projected onto the matched slice. */
  pixel: [number, number];
}

/** 3D cursor: the slice of a stack nearest to a patient point and the point's pixel position on it. */
export function cursorTarget(planes: readonly ImagePlane[], p: Vec3): CursorTarget | undefined {
  const m = nearestSlice(planes, p);
  if (!m) return undefined;
  return { ...m, pixel: planePixel(planes[m.index]!, p) };
}

/**
 * Position of a slice along a reference normal (mm), used to keep a fixed offset when two stacks of different studies
 * are linked manually: offset = position(target) − position(source) at the moment of linking.
 */
export function slicePosition(plane: ImagePlane, normal: Vec3): number {
  return vec3.dot(plane.origin, normal);
}

/**
 * Manual link: the slice whose position along `normal` is closest to `position` (mm). Used for stacks of different
 * studies or Frames of Reference, where patient coordinates are not comparable but a fixed offset is.
 */
export function sliceAtPosition(planes: readonly ImagePlane[], normal: Vec3, position: number): number | undefined {
  let best: number | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  planes.forEach((pl, i) => {
    const d = Math.abs(slicePosition(pl, normal) - position);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
