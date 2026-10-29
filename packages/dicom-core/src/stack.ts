import {
  type ImageOrientation,
  type Vec3,
  angleBetweenDeg,
  parseImageOrientation,
  parseVec3,
  sameOrientation,
  sliceNormal,
  vec3,
} from './geometry.js';
import type {
  DisplayImage,
  SortDirection,
  SortKey,
  StackGeometrySummary,
  StackWarning,
} from './types.js';

/** Tolerances used by stack analysis. Documented in docs/VALIDATION_MATRIX.md. */
export const STACK_TOLERANCES = {
  /** Two positions closer than this along the normal are duplicates (mm). */
  duplicateMm: 0.001,
  /** Absolute spacing tolerance (mm) … */
  spacingAbsMm: 0.01,
  /** … or relative tolerance, whichever is larger. */
  spacingRel: 0.01,
  /** A gap larger than this multiple of the median spacing counts as missing slice(s). */
  gapFactor: 1.5,
  /** Orientation difference (degrees) beyond which images are considered differently oriented. */
  orientationDeg: 0.5,
  /** Angle between normal and slice progression above which gantry tilt / shear is reported (degrees). */
  tiltDeg: 0.5,
} as const;

function imageOrientation(img: DisplayImage): ImageOrientation | undefined {
  return parseImageOrientation(img.geometry.imageOrientationPatient);
}

function imagePosition(img: DisplayImage): Vec3 | undefined {
  return parseVec3(img.geometry.imagePositionPatient);
}

/** Parses DICOM TM (HHMMSS.FFFFFF, also legacy HH:MM:SS) to seconds since midnight. */
export function parseDicomTime(tm: string | undefined): number | undefined {
  if (!tm) return undefined;
  const s = tm.trim().replace(/:/g, '');
  const m = /^(\d{2})(\d{2})?(\d{2})?(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const sec = m[3] ? Number(m[3]) : 0;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  if (h > 23 || min > 59 || sec > 60) return undefined;
  return h * 3600 + min * 60 + sec + frac;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareOptionalNumbers(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/** Stable tie-breaker: instance number, then frame number, then file name. */
function tieBreak(a: DisplayImage, b: DisplayImage): number {
  return (
    compareOptionalNumbers(a.instanceNumber, b.instanceNumber) ||
    compareOptionalNumbers(a.frame, b.frame) ||
    collator.compare(a.fileName, b.fileName)
  );
}

/** Returns the common orientation of all images, or undefined if any is missing or they differ. */
export function commonOrientation(images: readonly DisplayImage[]): ImageOrientation | undefined {
  let ref: ImageOrientation | undefined;
  for (const img of images) {
    const o = imageOrientation(img);
    if (!o) return undefined;
    if (!ref) ref = o;
    else if (!sameOrientation(ref, o, STACK_TOLERANCES.orientationDeg)) return undefined;
  }
  return ref;
}

export interface SortResult {
  images: DisplayImage[];
  sortedBy: SortKey;
  sortFallback: boolean;
}

/**
 * Sorts images for display.
 * 'spatial' projects ImagePositionPatient onto the slice normal (row × column). If geometry is missing or
 * orientations differ, it falls back to InstanceNumber and reports `sortFallback`.
 */
export function sortImages(
  images: readonly DisplayImage[],
  key: SortKey = 'spatial',
  direction: SortDirection = 'asc',
): SortResult {
  const list = [...images];
  let sortedBy: SortKey = key;
  let sortFallback = false;

  if (key === 'spatial') {
    const o = commonOrientation(list);
    const positions = list.map(imagePosition);
    if (o && positions.every((p) => p !== undefined)) {
      const n = sliceNormal(o);
      const d = new Map<DisplayImage, number>();
      list.forEach((img, i) => d.set(img, vec3.dot(positions[i]!, n)));
      list.sort((a, b) => d.get(a)! - d.get(b)! || tieBreak(a, b));
    } else {
      sortedBy = 'instanceNumber';
      sortFallback = true;
      list.sort(tieBreak);
    }
  } else if (key === 'instanceNumber') {
    list.sort(tieBreak);
  } else if (key === 'acquisitionTime') {
    list.sort(
      (a, b) =>
        compareOptionalNumbers(parseDicomTime(a.acquisitionTime), parseDicomTime(b.acquisitionTime)) ||
        tieBreak(a, b),
    );
  } else {
    list.sort((a, b) => collator.compare(a.fileName, b.fileName) || tieBreak(a, b));
  }

  if (direction === 'desc') list.reverse();
  return { images: list, sortedBy, sortFallback };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Analyzes slice geometry of an (already sorted) stack.
 * Spacing is computed from IPP differences projected on the normal — never from SliceThickness.
 */
export function analyzeStack(
  sorted: readonly DisplayImage[],
  sort: { sortedBy: SortKey; sortFallback: boolean },
): { geometry: StackGeometrySummary; warnings: StackWarning[] } {
  const warnings: StackWarning[] = [];
  const geometry: StackGeometrySummary = { sortedBy: sort.sortedBy, sortFallback: sort.sortFallback, spacings: [] };
  if (sort.sortFallback) warnings.push({ code: 'sortFallbackInstanceNumber' });
  if (sorted.length === 0) return { geometry, warnings };

  const orientations = sorted.map(imageOrientation);
  const positions = sorted.map(imagePosition);
  const withGeometry = orientations.filter((o, i) => o && positions[i]).length;
  if (withGeometry < sorted.length) {
    // Only a mix is suspicious; projection images and secondary captures legitimately have no geometry.
    if (withGeometry > 0) warnings.push({ code: 'missingGeometry' });
    return { geometry, warnings };
  }

  const ref = orientations[0]!;
  if (orientations.some((o) => !sameOrientation(ref, o!, STACK_TOLERANCES.orientationDeg))) {
    warnings.push({ code: 'mixedOrientations' });
    return { geometry, warnings };
  }

  const n = sliceNormal(ref);
  geometry.normal = [n[0], n[1], n[2]];
  if (sorted.length < 2) return { geometry, warnings };

  const d = positions.map((p) => vec3.dot(p!, n));
  const spacings: number[] = [];
  for (let i = 1; i < d.length; i++) spacings.push(d[i]! - d[i - 1]!);
  geometry.spacings = spacings;

  const abs = spacings.map(Math.abs);
  const duplicates = abs.filter((s) => s < STACK_TOLERANCES.duplicateMm).length;
  if (duplicates > 0) warnings.push({ code: 'duplicatePositions', value: duplicates });

  const nonZero = abs.filter((s) => s >= STACK_TOLERANCES.duplicateMm);
  const med = median(nonZero);
  if (med !== undefined) {
    geometry.sliceSpacing = med;
    const tol = Math.max(STACK_TOLERANCES.spacingAbsMm, STACK_TOLERANCES.spacingRel * med);
    const gaps = nonZero.filter((s) => s > STACK_TOLERANCES.gapFactor * med).length;
    if (gaps > 0) warnings.push({ code: 'missingSlices', value: gaps });
    if (nonZero.some((s) => Math.abs(s - med) > tol)) warnings.push({ code: 'nonUniformSpacing' });

    // Tilt/shear: angle between normal and the overall slice progression (first → last distinct position).
    const first = positions[0]!;
    const last = positions[positions.length - 1]!;
    const progression = vec3.sub(last, first);
    if (vec3.length(progression) > STACK_TOLERANCES.duplicateMm) {
      const tilt = angleBetweenDeg(progression, vec3.dot(progression, n) >= 0 ? n : vec3.negate(n));
      geometry.tiltDeg = tilt;
      if (tilt > STACK_TOLERANCES.tiltDeg) warnings.push({ code: 'gantryTilt', value: round(tilt, 2) });
    }
  }

  const acqNumbers = new Set(sorted.map((i) => i.acquisitionNumber).filter((v) => v !== undefined));
  if (acqNumbers.size > 1 && duplicates > 0) warnings.push({ code: 'multipleAcquisitions', value: acqNumbers.size });

  return { geometry, warnings };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
