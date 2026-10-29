/**
 * Patient-coordinate geometry helpers (DICOM LPS: +x = patient Left, +y = Posterior, +z = Head/Superior).
 * Pure functions, no DOM/Electron.
 */

export type Vec3 = readonly [number, number, number];

export const vec3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  negate: (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]],
  normalize(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l === 0 || !Number.isFinite(l)) return [0, 0, 0];
    // "+ 0" normalizes −0 to 0 so results compare and serialize cleanly.
    return [a[0] / l + 0, a[1] / l + 0, a[2] / l + 0];
  },
};

/** Row (first three values) and column (last three) direction cosines of ImageOrientationPatient. */
export interface ImageOrientation {
  row: Vec3;
  column: Vec3;
}

/**
 * Validates and normalizes an ImageOrientationPatient value.
 * Returns undefined for missing, non-finite, degenerate or clearly non-orthogonal input.
 */
export function parseImageOrientation(iop: readonly number[] | undefined): ImageOrientation | undefined {
  if (!iop || iop.length !== 6 || !iop.every(Number.isFinite)) return undefined;
  const row = vec3.normalize([iop[0]!, iop[1]!, iop[2]!]);
  const column = vec3.normalize([iop[3]!, iop[4]!, iop[5]!]);
  if (vec3.length(row) === 0 || vec3.length(column) === 0) return undefined;
  // Real-world data has small rounding errors; reject only clearly non-orthogonal vectors (> ~1.15°).
  if (Math.abs(vec3.dot(row, column)) > 0.02) return undefined;
  return { row, column };
}

export function parseVec3(v: readonly number[] | undefined): Vec3 | undefined {
  if (!v || v.length !== 3 || !v.every(Number.isFinite)) return undefined;
  return [v[0]!, v[1]!, v[2]!];
}

/** Slice normal = row × column (right-handed, as used by DICOM for slice ordering). */
export function sliceNormal(o: ImageOrientation): Vec3 {
  return vec3.normalize(vec3.cross(o.row, o.column));
}

/** Angle between two unit vectors in degrees (0..180). */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const c = Math.min(1, Math.max(-1, vec3.dot(vec3.normalize(a), vec3.normalize(b))));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Angle between two planes given their normals, in degrees (0..90). */
export function planeAngleDeg(n1: Vec3, n2: Vec3): number {
  const a = angleBetweenDeg(n1, n2);
  return a > 90 ? 180 - a : a;
}

/** True when two orientations describe the same image plane and in-plane axes (within toleranceDeg). */
export function sameOrientation(a: ImageOrientation, b: ImageOrientation, toleranceDeg = 0.5): boolean {
  return angleBetweenDeg(a.row, b.row) <= toleranceDeg && angleBetweenDeg(a.column, b.column) <= toleranceDeg;
}

/**
 * Patient coordinate of the centre of pixel (column c, row r), both 0-based,
 * per PS3.3 C.7.6.2.1.1: P = IPP + row·Δc·c + column·Δr·r, where pixelSpacing = [Δr (row spacing), Δc (column spacing)].
 */
export function pixelToPatient(
  ipp: Vec3,
  o: ImageOrientation,
  pixelSpacing: readonly [number, number],
  column: number,
  row: number,
): Vec3 {
  const [rowSpacing, colSpacing] = pixelSpacing;
  return vec3.add(ipp, vec3.add(vec3.scale(o.row, colSpacing * column), vec3.scale(o.column, rowSpacing * row)));
}

/**
 * Inverse of pixelToPatient: continuous (column, row) of a patient point projected onto the image plane.
 * Pixel centres are at integer coordinates; the containing pixel is (round(column), round(row)).
 */
export function patientToPixel(
  p: Vec3,
  ipp: Vec3,
  o: ImageOrientation,
  pixelSpacing: readonly [number, number],
): [number, number] {
  const [rowSpacing, colSpacing] = pixelSpacing;
  const d = vec3.sub(p, ipp);
  return [vec3.dot(d, o.row) / colSpacing, vec3.dot(d, o.column) / rowSpacing];
}
