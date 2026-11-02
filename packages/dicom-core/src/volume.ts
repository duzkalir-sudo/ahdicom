/**
 * Volume geometry for multiplanar reformats (MPR) and 3D: whether a display set can be shown as a volume, the volume
 * grid the renderer builds from it, and the stack of reformatted planes along any direction.
 * Pure functions on patient coordinates (DICOM LPS, mm); no DOM/Electron.
 */
import { type Vec3, parseImageOrientation, parseVec3, sliceNormal, vec3 } from './geometry.js';
import type { ImagePlane } from './compare.js';
import type { DisplaySet, StackWarning } from './types.js';

/** Why a display set cannot be shown as a volume. */
export type MprRefusal =
  'notImage' | 'tooFewSlices' | 'missingGeometry' | 'mixedOrientations' | 'mixedDimensions' | 'duplicatePositions' | 'color';

/** Geometry problems that still allow a volume, but make reformatted distances along the slice axis approximate. */
export type MprWarningCode = 'missingSlices' | 'nonUniformSpacing' | 'gantryTilt';

export interface MprCheck {
  ok: boolean;
  refusal?: MprRefusal;
  /** Present when ok: reformats are shown, but measurements in reformatted planes are not reliable. */
  warnings: StackWarning[];
}

/** Fewest slices that make a volume. */
export const MPR_MIN_SLICES = 3;

const WARNINGS: readonly MprWarningCode[] = ['missingSlices', 'nonUniformSpacing', 'gantryTilt'];

/**
 * Decides whether a display set can be shown as a volume. Mixed orientations or image sizes, repeated positions
 * (an unsplit multi-volume series), colour images and images without position/orientation/spacing are refused;
 * missing slices, irregular spacing and gantry tilt are allowed with a warning (the renderer places slices evenly).
 */
export function mprCheck(ds: DisplaySet): MprCheck {
  const refuse = (refusal: MprRefusal): MprCheck => ({ ok: false, refusal, warnings: [] });
  if (ds.kind === 'nonImage') return refuse('notImage');
  if (ds.images.length < MPR_MIN_SLICES) return refuse('tooFewSlices');
  const inst = ds.firstInstance;
  if ((inst.samplesPerPixel ?? 1) !== 1) return refuse('color');
  const codes = new Set(ds.warnings.map((w) => w.code));
  if (codes.has('mixedOrientations')) return refuse('mixedOrientations');
  if (codes.has('mixedDimensions')) return refuse('mixedDimensions');
  if (codes.has('duplicatePositions')) return refuse('duplicatePositions');
  const complete = ds.images.every(
    (img) =>
      parseVec3(img.geometry.imagePositionPatient) &&
      parseImageOrientation(img.geometry.imageOrientationPatient) &&
      (img.geometry.pixelSpacing?.[0] ?? 0) > 0 &&
      (img.geometry.pixelSpacing?.[1] ?? 0) > 0,
  );
  if (codes.has('missingGeometry') || !complete || !(inst.rows! > 0) || !(inst.columns! > 0)) return refuse('missingGeometry');
  return { ok: true, warnings: ds.warnings.filter((w) => (WARNINGS as readonly string[]).includes(w.code)) };
}

/** Regular voxel grid: voxel (i, j, k) centre is origin + i·spacing[0]·row + j·spacing[1]·column + k·spacing[2]·normal. */
export interface VolumeGeometry {
  origin: Vec3;
  /** Direction of increasing column index (i), row index (j) and slice index (k); k = row × column. */
  row: Vec3;
  column: Vec3;
  normal: Vec3;
  /** Millimetres between columns, between rows and between slices. */
  spacing: Vec3;
  /** Columns, rows, slices. */
  dimensions: readonly [number, number, number];
  frameOfReferenceUid?: string;
}

/**
 * The grid the renderer builds from a display set that passed mprCheck: slices ordered along normal = row × column,
 * origin at the slice with the smallest position along it, slice spacing = (last − first) / (n − 1). This matches
 * Cornerstone's volume construction, so reformatted planes computed here coincide with what is displayed.
 */
export function volumeGeometry(ds: DisplaySet): VolumeGeometry | undefined {
  const o = parseImageOrientation(ds.images[0]?.geometry.imageOrientationPatient);
  const ps = ds.images[0]?.geometry.pixelSpacing;
  const rows = ds.firstInstance.rows ?? 0;
  const columns = ds.firstInstance.columns ?? 0;
  if (!o || !ps || !(rows > 0) || !(columns > 0) || ds.images.length < 2) return undefined;
  const normal = sliceNormal(o);
  const positions = ds.images.map((img) => parseVec3(img.geometry.imagePositionPatient));
  if (positions.some((p) => !p)) return undefined;
  const d = (positions as Vec3[]).map((p) => vec3.dot(p, normal));
  let lo = 0;
  let hi = 0;
  d.forEach((v, k) => {
    if (v < d[lo]!) lo = k;
    if (v > d[hi]!) hi = k;
  });
  const sliceSpacing = (d[hi]! - d[lo]!) / (d.length - 1);
  if (!(sliceSpacing > 0)) return undefined;
  const fo = ds.firstInstance.frameOfReferenceUid;
  return {
    origin: positions[lo]!,
    row: o.row,
    column: o.column,
    normal,
    spacing: [ps[1], ps[0], sliceSpacing],
    dimensions: [columns, rows, ds.images.length],
    ...(fo ? { frameOfReferenceUid: fo } : {}),
  };
}

/** The eight corner voxel centres of the grid. */
export function volumeCorners(v: VolumeGeometry): Vec3[] {
  const out: Vec3[] = [];
  for (const i of [0, v.dimensions[0] - 1])
    for (const j of [0, v.dimensions[1] - 1]) for (const k of [0, v.dimensions[2] - 1]) out.push(voxelToPatient(v, [i, j, k]));
  return out;
}

export function voxelToPatient(v: VolumeGeometry, ijk: Vec3): Vec3 {
  return vec3.add(
    v.origin,
    vec3.add(
      vec3.scale(v.row, ijk[0] * v.spacing[0]),
      vec3.add(vec3.scale(v.column, ijk[1] * v.spacing[1]), vec3.scale(v.normal, ijk[2] * v.spacing[2])),
    ),
  );
}

/** Continuous voxel index (i, j, k) of a patient point. Row and column are orthonormal; k is along the normal. */
export function patientToVoxel(v: VolumeGeometry, p: Vec3): Vec3 {
  const d = vec3.sub(p, v.origin);
  return [vec3.dot(d, v.row) / v.spacing[0], vec3.dot(d, v.column) / v.spacing[1], vec3.dot(d, v.normal) / v.spacing[2]];
}

/** Nearest voxel of a patient point, or undefined outside the grid (more than half a voxel beyond its edge). */
export function nearestVoxel(v: VolumeGeometry, p: Vec3): [number, number, number] | undefined {
  const c = patientToVoxel(v, p);
  const ijk = c.map(Math.round) as [number, number, number];
  return ijk.every((x, a) => x >= 0 && x < v.dimensions[a]!) ? ijk : undefined;
}

/**
 * Spacing between reformatted slices along a direction, as Cornerstone scrolls a volume: the length of the voxel
 * spacing vector projected component-wise on that direction (equals the voxel spacing for axis-aligned directions).
 */
export function spacingAlong(v: VolumeGeometry, direction: Vec3): number {
  const n = vec3.normalize(direction);
  return Math.hypot(vec3.dot(v.row, n) * v.spacing[0], vec3.dot(v.column, n) * v.spacing[1], vec3.dot(v.normal, n) * v.spacing[2]);
}

/** Stack of reformatted planes through a volume. */
export interface ReformatStack {
  /** Plane k is the k-th slice along `normal`, from the volume's lowest to its highest position along it. */
  planes: ImagePlane[];
  normal: Vec3;
  /** Position along the normal (patient point · normal) of plane 0, and the spacing between planes. */
  start: number;
  spacing: number;
}

/**
 * Reformatted planes of a volume seen with the given camera directions (screen up = `viewUp`, the viewer looks
 * against `normal`, screen right = viewUp × normal). Each plane covers the whole volume projected onto it, with
 * square pixels of the finest in-plane voxel spacing; row 0 is at the top of the screen, column 0 at the left.
 */
export function reformatStack(v: VolumeGeometry, normal: Vec3, viewUp: Vec3): ReformatStack | undefined {
  const n = vec3.normalize(normal);
  // Screen axes orthogonal to the normal (viewUp may be slightly off after rotations).
  const right = vec3.normalize(vec3.cross(viewUp, n));
  if (vec3.length(right) === 0) return undefined;
  // right × normal = −viewUp: screen down.
  const down = vec3.normalize(vec3.cross(right, n));
  const corners = volumeCorners(v);
  const range = (axis: Vec3): [number, number] => {
    const p = corners.map((c) => vec3.dot(c, axis));
    return [Math.min(...p), Math.max(...p)];
  };
  const [x0, x1] = range(right);
  const [y0, y1] = range(down);
  const [z0, z1] = range(n);
  const spacing = spacingAlong(v, n);
  const pixel = Math.min(v.spacing[0], v.spacing[1], v.spacing[2]);
  if (!(spacing > 0) || !(pixel > 0)) return undefined;
  const columns = Math.max(1, Math.round((x1 - x0) / pixel) + 1);
  const rows = Math.max(1, Math.round((y1 - y0) / pixel) + 1);
  const count = Math.max(1, Math.round((z1 - z0) / spacing) + 1);
  const planes: ImagePlane[] = [];
  for (let k = 0; k < count; k++) {
    const z = z0 + k * spacing;
    const origin = vec3.add(vec3.add(vec3.scale(right, x0), vec3.scale(down, y0)), vec3.scale(n, z));
    planes.push({
      origin,
      orientation: { row: right, column: down },
      normal: n,
      rowSpacing: pixel,
      columnSpacing: pixel,
      rows,
      columns,
      ...(v.frameOfReferenceUid ? { frameOfReferenceUid: v.frameOfReferenceUid } : {}),
    });
  }
  return { planes, normal: n, start: z0, spacing };
}

/** Index of the reformatted plane nearest to a patient point (clamped to the stack). */
export function reformatIndex(stack: ReformatStack, p: Vec3): number {
  const k = Math.round((vec3.dot(p, stack.normal) - stack.start) / stack.spacing);
  return Math.min(stack.planes.length - 1, Math.max(0, k));
}

/** Standard reformat directions in patient coordinates: [normal towards the viewer, screen up]. */
export const STANDARD_VIEWS: Record<'axial' | 'coronal' | 'sagittal', { normal: Vec3; viewUp: Vec3 }> = {
  // Axial: seen from the feet (patient left on screen right), anterior up.
  axial: { normal: [0, 0, -1], viewUp: [0, -1, 0] },
  // Coronal: seen from the front, head up.
  coronal: { normal: [0, -1, 0], viewUp: [0, 0, 1] },
  // Sagittal: seen from the patient's left, head up, anterior on screen left.
  sagittal: { normal: [1, 0, 0], viewUp: [0, 0, 1] },
};
