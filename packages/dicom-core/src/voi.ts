/**
 * Window/level (VOI) math, PS3.3 C.11.2.1.2.
 * Values are in modality units (after Modality LUT / rescale), e.g. HU for CT.
 */

export type VoiLutFunction = 'LINEAR' | 'LINEAR_EXACT' | 'SIGMOID';

export interface WindowLevel {
  center: number;
  width: number;
}

export interface VoiRange {
  lower: number;
  upper: number;
}

export function normalizeVoiLutFunction(v: string | undefined): VoiLutFunction {
  const s = (v ?? '').trim().toUpperCase();
  return s === 'LINEAR_EXACT' || s === 'SIGMOID' ? s : 'LINEAR';
}

/**
 * Converts window center/width to the input range that maps to the full output range.
 * LINEAR (C.11.2.1.2.1): values ≤ c − 0.5 − (w − 1)/2 → min; > c − 0.5 + (w − 1)/2 → max. Width must be ≥ 1.
 * LINEAR_EXACT (C.11.2.1.3.2): c − w/2 … c + w/2. Width must be > 0.
 * SIGMOID has no hard bounds; the conventional ±w/2 range is returned for display of numbers.
 */
export function windowToRange(wl: WindowLevel, fn: VoiLutFunction = 'LINEAR'): VoiRange {
  if (fn === 'LINEAR') {
    const w = Math.max(1, wl.width);
    return { lower: wl.center - 0.5 - (w - 1) / 2, upper: wl.center - 0.5 + (w - 1) / 2 };
  }
  const w = Math.max(Number.EPSILON, wl.width);
  return { lower: wl.center - w / 2, upper: wl.center + w / 2 };
}

/** Inverse of windowToRange. */
export function rangeToWindow(r: VoiRange, fn: VoiLutFunction = 'LINEAR'): WindowLevel {
  if (fn === 'LINEAR') {
    const width = r.upper - r.lower + 1;
    return { width, center: r.lower + 0.5 + (width - 1) / 2 };
  }
  return { width: r.upper - r.lower, center: (r.upper + r.lower) / 2 };
}

/**
 * Applies the VOI function to a single modality value, returning a normalized output 0..1.
 * Used for analytic tests and for the probe/legend; the GPU path in the renderer must agree with this.
 */
export function applyVoi(x: number, wl: WindowLevel, fn: VoiLutFunction = 'LINEAR'): number {
  if (fn === 'SIGMOID') {
    return 1 / (1 + Math.exp((-4 * (x - wl.center)) / wl.width));
  }
  if (fn === 'LINEAR_EXACT') {
    if (x <= wl.center - wl.width / 2) return 0;
    if (x > wl.center + wl.width / 2) return 1;
    return (x - wl.center) / wl.width + 0.5;
  }
  const w = Math.max(1, wl.width);
  if (x <= wl.center - 0.5 - (w - 1) / 2) return 0;
  if (x > wl.center - 0.5 + (w - 1) / 2) return 1;
  return (x - (wl.center - 0.5)) / (w - 1) + 0.5;
}

/** Modality LUT linear rescale (C.11.1.1.2). */
export function rescale(stored: number, slope = 1, intercept = 0): number {
  return stored * slope + intercept;
}

export interface WindowPreset {
  id: string;
  /** i18n key for the preset name. */
  labelKey: string;
  center: number;
  width: number;
  /** Default keyboard shortcut digit (1–9) where assigned. */
  key?: string;
}

/**
 * CT window presets in HU. Values follow widely used radiology teaching references
 * (e.g. Radiopaedia "Windowing (CT)"); they are display conventions, not diagnostic thresholds.
 */
export const CT_PRESETS: readonly WindowPreset[] = [
  { id: 'brain', labelKey: 'presets.brain', width: 80, center: 40, key: '1' },
  { id: 'subdural', labelKey: 'presets.subdural', width: 200, center: 75, key: '2' },
  { id: 'stroke', labelKey: 'presets.stroke', width: 40, center: 40, key: '3' },
  { id: 'bone', labelKey: 'presets.bone', width: 2000, center: 500, key: '4' },
  { id: 'lung', labelKey: 'presets.lung', width: 1500, center: -600, key: '5' },
  { id: 'abdomen', labelKey: 'presets.abdomen', width: 400, center: 50, key: '6' },
  { id: 'mediastinum', labelKey: 'presets.mediastinum', width: 350, center: 50, key: '7' },
  { id: 'angio', labelKey: 'presets.angio', width: 600, center: 170, key: '8' },
];

/** PET presets: fraction of the displayed range maximum (0 … max). */
export const PET_PERCENT_PRESETS: readonly { id: string; labelKey: string; upperPercent: number }[] = [
  { id: 'pet100', labelKey: 'presets.petPercent', upperPercent: 100 },
  { id: 'pet50', labelKey: 'presets.petPercent', upperPercent: 50 },
  { id: 'pet25', labelKey: 'presets.petPercent', upperPercent: 25 },
];

/** PET SUV presets (lower..upper SUVbw). Applied only when SUV scaling is available. */
export const PET_SUV_PRESETS: readonly { id: string; labelKey: string; lower: number; upper: number }[] = [
  { id: 'suv5', labelKey: 'presets.suvRange', lower: 0, upper: 5 },
  { id: 'suv10', labelKey: 'presets.suvRange', lower: 0, upper: 10 },
  { id: 'suv15', labelKey: 'presets.suvRange', lower: 0, upper: 15 },
];

/** Window for a percentage of a value range (e.g. PET 0 … 50 % of max). */
export function percentRange(min: number, max: number, upperPercent: number): VoiRange {
  return { lower: min, upper: min + ((max - min) * upperPercent) / 100 };
}

/** Full-dynamic-range window for images without a stored window (min..max). */
export function fullRange(min: number, max: number): VoiRange {
  return max > min ? { lower: min, upper: max } : { lower: min - 0.5, upper: min + 0.5 };
}
