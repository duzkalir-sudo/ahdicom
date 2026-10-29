import { type Vec3, vec3 } from './geometry.js';

/**
 * Orientation labels in the DICOM patient coordinate system (LPS).
 * L/R = ±x, P/A = ±y, H/F = ±z. "H" (head) and "F" (foot) follow DICOM PatientOrientation letters.
 */
export type OrientationLetter = 'L' | 'R' | 'A' | 'P' | 'H' | 'F';

const LETTER_VECTORS: Record<OrientationLetter, Vec3> = {
  L: [1, 0, 0],
  R: [-1, 0, 0],
  P: [0, 1, 0],
  A: [0, -1, 0],
  H: [0, 0, 1],
  F: [0, 0, -1],
};

/**
 * Minimum absolute direction-cosine component for a secondary/tertiary letter to be shown.
 * 0.1 ≈ 5.7° of obliquity. The primary (largest) component is always shown.
 * Rationale recorded in docs/DECISIONS.md (D-012).
 */
export const SECONDARY_LETTER_THRESHOLD = 0.1;

/**
 * Converts a patient-space direction into a label such as "L", "LA", "HRP".
 * Letters are ordered by decreasing magnitude of the component.
 */
export function directionToLabel(direction: Vec3, threshold = SECONDARY_LETTER_THRESHOLD): string {
  const d = vec3.normalize(direction);
  if (vec3.length(d) === 0) return '';
  const parts: { letter: OrientationLetter; mag: number }[] = [
    { letter: d[0] >= 0 ? 'L' : 'R', mag: Math.abs(d[0]) },
    { letter: d[1] >= 0 ? 'P' : 'A', mag: Math.abs(d[1]) },
    { letter: d[2] >= 0 ? 'H' : 'F', mag: Math.abs(d[2]) },
  ];
  parts.sort((a, b) => b.mag - a.mag);
  return parts
    .filter((p, i) => i === 0 || p.mag >= threshold)
    .map((p) => p.letter)
    .join('');
}

/**
 * Parses one PatientOrientation (0020,0020) component, e.g. "A", "FL", "HR", into a unit vector.
 * Returns undefined for empty/unknown letters.
 */
export function patientOrientationToVector(value: string | undefined): Vec3 | undefined {
  if (!value) return undefined;
  const letters = value.trim().toUpperCase().split('');
  if (letters.length === 0) return undefined;
  let v: Vec3 = [0, 0, 0];
  for (const ch of letters) {
    const lv = LETTER_VECTORS[ch as OrientationLetter];
    if (!lv) return undefined;
    v = vec3.add(v, lv);
  }
  return vec3.normalize(v);
}

/** Labels for the four edges of a displayed image. */
export interface EdgeLabels {
  top: string;
  bottom: string;
  left: string;
  right: string;
}

/**
 * Edge labels for a displayed image given the patient-space directions of screen "right" and screen "down".
 * This is the single source of truth used by the viewer: the renderer derives `screenRight`/`screenDown`
 * from the actual camera (after rotation/flip), so labels always follow the rendered image.
 */
export function edgeLabels(screenRight: Vec3, screenDown: Vec3, threshold = SECONDARY_LETTER_THRESHOLD): EdgeLabels {
  return {
    right: directionToLabel(screenRight, threshold),
    left: directionToLabel(vec3.negate(screenRight), threshold),
    bottom: directionToLabel(screenDown, threshold),
    top: directionToLabel(vec3.negate(screenDown), threshold),
  };
}

/** In-plane display transform applied to an image whose unrotated screen axes are (row → right, column → down). */
export interface DisplayTransform {
  /** Clockwise rotation in degrees, multiple of 90 for the 2D viewer (any value accepted). */
  rotationDeg: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

/**
 * Screen axes (patient-space directions of screen right and screen down) after applying, in this order,
 * a horizontal/vertical flip of the image and then a clockwise rotation of the displayed result.
 * Used for projection images (PatientOrientation) and as an analytic reference in tests.
 */
export function screenAxes(rowDir: Vec3, colDir: Vec3, t: DisplayTransform): { right: Vec3; down: Vec3 } {
  // Image axes as seen on screen before rotation.
  let right = t.flipHorizontal ? vec3.negate(rowDir) : rowDir;
  let down = t.flipVertical ? vec3.negate(colDir) : colDir;
  // Clockwise rotation by θ on screen: new right = cosθ·right − sinθ·down … expressed for screen basis vectors.
  // A screen point (x, y) (y down) rotated clockwise by θ maps to (x cosθ − y sinθ, x sinθ + y cosθ).
  // The patient direction now displayed at screen-right is therefore the one previously at angle −θ.
  const theta = (t.rotationDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const newRight = vec3.add(vec3.scale(right, c), vec3.scale(down, -s));
  const newDown = vec3.add(vec3.scale(right, s), vec3.scale(down, c));
  right = roundVec(newRight);
  down = roundVec(newDown);
  return { right, down };
}

function roundVec(v: Vec3): Vec3 {
  const r = (x: number): number => (Math.abs(x) < 1e-12 ? 0 : x);
  return [r(v[0]), r(v[1]), r(v[2])];
}
