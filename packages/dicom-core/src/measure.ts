/**
 * Measurement math on a single image plane. Pure functions, no DOM/Electron.
 *
 * Points are continuous image-pixel coordinates [column, row]; pixel centres are at integer coordinates
 * (pixel (c, r) covers [c − ½, c + ½] × [r − ½, r + ½]). Physical results use a {@link MeasureScale};
 * without one, results are in pixels and assume square pixels.
 */
import type { SpacingBasis } from './display.js';
import type { UltrasoundRegion } from './types.js';

export type Point2 = readonly [number, number];

/** How millimetres per pixel were obtained; shown next to every physical measurement. */
export type ScaleBasis = 'pixelSpacing' | 'imagerMagnified' | 'imagerPixelSpacing' | 'ultrasound' | 'manual';

export interface MeasureScale {
  basis: ScaleBasis;
  /** Millimetres between pixel centres along a column (adjacent rows). */
  rowMm: number;
  /** Millimetres between pixel centres along a row (adjacent columns). */
  columnMm: number;
}

/** A length, area or volume with its unit; `unit` is 'px'/'px²' when the image is uncalibrated. */
export interface Quantity {
  value: number;
  unit: 'mm' | 'px' | 'mm²' | 'px²' | 'mm³';
}

/** The image-wide scale from the spacing basis, or undefined (uncalibrated or per-region ultrasound). */
export function scaleFromBasis(basis: SpacingBasis): MeasureScale | undefined {
  switch (basis.kind) {
    case 'pixelSpacing':
    case 'imagerMagnified':
    case 'imagerPixelSpacing':
      return { basis: basis.kind, rowMm: basis.rowMm, columnMm: basis.columnMm };
    default:
      return undefined;
  }
}

/**
 * Manual calibration: the line from a to b is `trueMm` long. The pixel aspect ratio of `current` is kept
 * (anisotropic images stay anisotropic); without a current scale, pixels are assumed square.
 */
export function manualScale(a: Point2, b: Point2, trueMm: number, current?: MeasureScale): MeasureScale | undefined {
  if (!(trueMm > 0) || !Number.isFinite(trueMm)) return undefined;
  const aspect = current ? current.rowMm / current.columnMm : 1;
  const dc = b[0] - a[0];
  const dr = (b[1] - a[1]) * aspect;
  const lenInColumnUnits = Math.hypot(dc, dr);
  if (!(lenInColumnUnits > 0)) return undefined;
  const columnMm = trueMm / lenInColumnUnits;
  return { basis: 'manual', rowMm: columnMm * aspect, columnMm };
}

/** Converts a pixel point to millimetres in the image plane (origin at pixel (0, 0)). */
function toMm(p: Point2, s: MeasureScale | undefined): [number, number] {
  return s ? [p[0] * s.columnMm, p[1] * s.rowMm] : [p[0], p[1]];
}

export function segmentLength(a: Point2, b: Point2, s?: MeasureScale): Quantity {
  const [ax, ay] = toMm(a, s);
  const [bx, by] = toMm(b, s);
  return { value: Math.hypot(bx - ax, by - ay), unit: s ? 'mm' : 'px' };
}

export function polylineLength(points: readonly Point2[], s?: MeasureScale): Quantity {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += segmentLength(points[i - 1]!, points[i]!, s).value;
  return { value: sum, unit: s ? 'mm' : 'px' };
}

export function polygonPerimeter(points: readonly Point2[], s?: MeasureScale): Quantity {
  if (points.length < 2) return { value: 0, unit: s ? 'mm' : 'px' };
  const closing = segmentLength(points[points.length - 1]!, points[0]!, s).value;
  return { value: polylineLength(points, s).value + closing, unit: s ? 'mm' : 'px' };
}

/** Area of a simple polygon (shoelace formula), in mm² or px². */
export function polygonArea(points: readonly Point2[], s?: MeasureScale): Quantity {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = toMm(points[i]!, s);
    const [x2, y2] = toMm(points[(i + 1) % points.length]!, s);
    twice += x1 * y2 - x2 * y1;
  }
  return { value: Math.abs(twice) / 2, unit: s ? 'mm²' : 'px²' };
}

/**
 * An ellipse given by its centre and two conjugate semi-axis vectors (pixel units).
 * For an ellipse drawn on screen with axis-aligned handles, u and v are the half-width and half-height vectors.
 */
export interface Ellipse {
  center: Point2;
  u: Point2;
  v: Point2;
}

/** Ellipse from the four handle points Cornerstone uses (top, bottom, left, right), in pixel coordinates. */
export function ellipseFromHandles(top: Point2, bottom: Point2, left: Point2, right: Point2): Ellipse {
  return {
    center: [(top[0] + bottom[0] + left[0] + right[0]) / 4, (top[1] + bottom[1] + left[1] + right[1]) / 4],
    u: [(right[0] - left[0]) / 2, (right[1] - left[1]) / 2],
    v: [(bottom[0] - top[0]) / 2, (bottom[1] - top[1]) / 2],
  };
}

/** Area of an ellipse: π·|u × v| (exact for conjugate semi-axes), scaled to mm² when a scale is given. */
export function ellipseArea(e: Ellipse, s?: MeasureScale): Quantity {
  const [ux, uy] = toMm(e.u, s);
  const [vx, vy] = toMm(e.v, s);
  return { value: Math.PI * Math.abs(ux * vy - uy * vx), unit: s ? 'mm²' : 'px²' };
}

/** True when pixel centre (c, r) lies inside or on the ellipse. */
export function insideEllipse(e: Ellipse, c: number, r: number): boolean {
  const det = e.u[0] * e.v[1] - e.u[1] * e.v[0];
  if (det === 0) return false;
  const dx = c - e.center[0];
  const dy = r - e.center[1];
  // Solve [u v]·[a b]ᵀ = d; inside when a² + b² ≤ 1.
  const a = (dx * e.v[1] - dy * e.v[0]) / det;
  const b = (e.u[0] * dy - e.u[1] * dx) / det;
  return a * a + b * b <= 1 + 1e-9;
}

/** True when pixel centre (c, r) lies inside the polygon (even-odd rule; points on an edge count as inside). */
export function insidePolygon(points: readonly Point2[], c: number, r: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    // On-edge test (collinear and within the segment's bounding box).
    const cross = (xj - xi) * (r - yi) - (yj - yi) * (c - xi);
    if (
      Math.abs(cross) < 1e-9 &&
      c >= Math.min(xi, xj) - 1e-9 &&
      c <= Math.max(xi, xj) + 1e-9 &&
      r >= Math.min(yi, yj) - 1e-9 &&
      r <= Math.max(yi, yj) + 1e-9
    )
      return true;
    if (yi > r !== yj > r && c < ((xj - xi) * (r - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Angle ABC at vertex B in degrees (0..180), computed in physical space so anisotropic pixels are handled. */
export function angleDeg(a: Point2, b: Point2, c: Point2, s?: MeasureScale): number {
  const [ax, ay] = toMm(a, s);
  const [bx, by] = toMm(b, s);
  const [cx, cy] = toMm(c, s);
  return vectorAngleDeg([ax - bx, ay - by], [cx - bx, cy - by]);
}

function vectorAngleDeg(u: readonly [number, number], v: readonly [number, number]): number {
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  if (lu === 0 || lv === 0) return Number.NaN;
  const cos = Math.min(1, Math.max(-1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Cobb angle between line A (a1→a2) and line B (b1→b2), in degrees 0..90.
 * Lines are undirected: the acute angle between them is reported, which is the clinical Cobb angle for
 * curves below 90°; `obtuse` (= 180 − acute) is returned for the rare larger curve.
 */
export function cobbAngleDeg(a1: Point2, a2: Point2, b1: Point2, b2: Point2, s?: MeasureScale): { acute: number; obtuse: number } {
  const [p1x, p1y] = toMm(a1, s);
  const [p2x, p2y] = toMm(a2, s);
  const [q1x, q1y] = toMm(b1, s);
  const [q2x, q2y] = toMm(b2, s);
  const raw = vectorAngleDeg([p2x - p1x, p2y - p1y], [q2x - q1x, q2y - q1y]);
  const acute = raw > 90 ? 180 - raw : raw;
  return { acute, obtuse: 180 - acute };
}

/** Perpendicular distance from point p to the infinite line through a and b (deviation distance). */
export function pointLineDistance(a: Point2, b: Point2, p: Point2, s?: MeasureScale): Quantity {
  const [ax, ay] = toMm(a, s);
  const [bx, by] = toMm(b, s);
  const [px, py] = toMm(p, s);
  const len = Math.hypot(bx - ax, by - ay);
  const unit = s ? 'mm' : 'px';
  if (len === 0) return { value: Math.hypot(px - ax, py - ay), unit };
  return { value: Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len, unit };
}

/** Ratio of two lengths (first ÷ second); NaN when the second has zero length. */
export function lengthRatio(a1: Point2, a2: Point2, b1: Point2, b2: Point2, s?: MeasureScale): number {
  const la = segmentLength(a1, a2, s).value;
  const lb = segmentLength(b1, b2, s).value;
  return lb === 0 ? Number.NaN : la / lb;
}

/** Ellipsoid volume from three orthogonal diameters: π/6 · d1 · d2 · d3. */
export function ellipsoidVolume(d1Mm: number, d2Mm: number, d3Mm: number): Quantity {
  return { value: (Math.PI / 6) * d1Mm * d2Mm * d3Mm, unit: 'mm³' };
}

/** Bullet volume from three orthogonal diameters: 5π/24 · d1 · d2 · d3. */
export function bulletVolume(d1Mm: number, d2Mm: number, d3Mm: number): Quantity {
  return { value: ((5 * Math.PI) / 24) * d1Mm * d2Mm * d3Mm, unit: 'mm³' };
}

export interface RoiStats {
  /** Number of pixels whose centre lies inside the region. */
  count: number;
  mean: number;
  min: number;
  max: number;
  /** Population standard deviation (σ, divisor n). */
  sd: number;
}

/**
 * Statistics of the pixels whose centre lies inside a region (pixel-centre inclusion rule).
 * `value(c, r)` returns the modality value (e.g. HU) of pixel (c, r), or undefined to skip it (e.g. padding).
 * The bounding box is clipped to the image. Returns undefined when no pixel centre is inside.
 */
export function roiStats(
  width: number,
  height: number,
  bbox: { minC: number; minR: number; maxC: number; maxR: number },
  inside: (c: number, r: number) => boolean,
  value: (c: number, r: number) => number | undefined,
): RoiStats | undefined {
  const c0 = Math.max(0, Math.ceil(bbox.minC - 1e-9));
  const r0 = Math.max(0, Math.ceil(bbox.minR - 1e-9));
  const c1 = Math.min(width - 1, Math.floor(bbox.maxC + 1e-9));
  const r1 = Math.min(height - 1, Math.floor(bbox.maxR + 1e-9));
  let n = 0;
  let mean = 0;
  let m2 = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!inside(c, r)) continue;
      const v = value(c, r);
      if (v === undefined || !Number.isFinite(v)) continue;
      // Welford's algorithm: numerically stable for large regions.
      n++;
      const d = v - mean;
      mean += d / n;
      m2 += d * (v - mean);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (n === 0) return undefined;
  return { count: n, mean, min, max, sd: Math.sqrt(m2 / n) };
}

export function polygonBBox(points: readonly Point2[]): { minC: number; minR: number; maxC: number; maxR: number } {
  return {
    minC: Math.min(...points.map((p) => p[0])),
    minR: Math.min(...points.map((p) => p[1])),
    maxC: Math.max(...points.map((p) => p[0])),
    maxR: Math.max(...points.map((p) => p[1])),
  };
}

export function ellipseBBox(e: Ellipse): { minC: number; minR: number; maxC: number; maxR: number } {
  const hx = Math.hypot(e.u[0], e.v[0]);
  const hy = Math.hypot(e.u[1], e.v[1]);
  return { minC: e.center[0] - hx, minR: e.center[1] - hy, maxC: e.center[0] + hx, maxR: e.center[1] + hy };
}

/** PS3.3 C.8.5.5.1.15 Physical Units: 3 = cm. */
const US_UNIT_CM = 3;

export type UltrasoundScaleResult =
  { ok: true; scale: MeasureScale; regionIndex: number } | { ok: false; reason: 'noRegion' | 'differentRegions' | 'notSpatial' };

/** The region containing pixel (c, r) — the first match, as regions may overlap — or -1. */
export function ultrasoundRegionAt(regions: readonly UltrasoundRegion[], c: number, r: number): number {
  return regions.findIndex((g) => c >= g.minX - 0.5 && c <= g.maxX + 0.5 && r >= g.minY - 0.5 && r <= g.maxY + 0.5);
}

/**
 * Scale for a measurement whose points all lie in one calibrated ultrasound region with spatial (cm) units.
 * Measurements across regions or in non-spatial regions (Doppler, M-mode time axes) are refused.
 */
export function ultrasoundScale(regions: readonly UltrasoundRegion[], points: readonly Point2[]): UltrasoundScaleResult {
  if (points.length === 0) return { ok: false, reason: 'noRegion' };
  const idx = points.map((p) => ultrasoundRegionAt(regions, p[0], p[1]));
  if (idx.some((i) => i < 0)) return { ok: false, reason: 'noRegion' };
  if (idx.some((i) => i !== idx[0])) return { ok: false, reason: 'differentRegions' };
  const g = regions[idx[0]!]!;
  if (g.unitsX !== US_UNIT_CM || g.unitsY !== US_UNIT_CM || !(g.deltaX > 0) || !(g.deltaY > 0)) return { ok: false, reason: 'notSpatial' };
  return {
    ok: true,
    scale: { basis: 'ultrasound', columnMm: Math.abs(g.deltaX) * 10, rowMm: Math.abs(g.deltaY) * 10 },
    regionIndex: idx[0]!,
  };
}

/**
 * Decimal places for a length given the pixel size: enough to resolve one pixel, between 1 and 3
 * (0.5 mm → 1, 0.08 mm → 2). Uncalibrated (px) values use 1.
 */
export function lengthDecimals(s?: MeasureScale): number {
  if (!s) return 1;
  const px = Math.min(s.rowMm, s.columnMm);
  if (!(px > 0)) return 1;
  return Math.min(3, Math.max(1, Math.ceil(-Math.log10(px) - 1e-9)));
}
