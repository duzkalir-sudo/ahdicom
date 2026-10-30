/**
 * Body-weight SUV (SUVbw) for PET, following the QIBA vendor-neutral pseudo-code:
 * SUVbw = C [Bq/ml] × weight [g] / (injected dose [Bq] × 2^(−Δt / T½)),
 * Δt = scan reference time − radiopharmaceutical start time.
 * Refuses (never guesses) when a required attribute is missing or the image is not suitable.
 */
import type { InstanceRecord } from './types.js';

/** Seconds since midnight for a TM value ("HHMMSS.FFFFFF", partial forms, or legacy "HH:MM:SS"). */
export function parseDicomTimeSeconds(tm: string | undefined): number | undefined {
  if (!tm) return undefined;
  const m = /^(\d{2})(?::?(\d{2})(?::?(\d{2})(\.\d{1,6})?)?)?$/.exec(tm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0) + Number(m[4] ?? 0);
  if (h > 23 || mi > 59 || s >= 61) return undefined;
  return h * 3600 + mi * 60 + s;
}

/** Days since 1970-01-01 for a DA value, or undefined. */
function dayNumber(da: string | undefined): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(da?.trim().replace(/\./g, '') ?? '');
  if (!m) return undefined;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t / 86400000 : undefined;
}

/** Seconds since 1970 (time-zone offset ignored, as all times of one study share it) for DA + TM. */
export function dicomDateTimeSeconds(da: string | undefined, tm: string | undefined): number | undefined {
  const d = dayNumber(da);
  const t = parseDicomTimeSeconds(tm);
  return d === undefined || t === undefined ? undefined : d * 86400 + t;
}

/** Seconds since 1970 for a DT value ("YYYYMMDDHHMMSS.FFFFFF&ZZXX"); the offset is ignored like above. */
export function parseDicomDateTimeSeconds(dt: string | undefined): number | undefined {
  const m = /^(\d{8})(\d{2,6}(?:\.\d{1,6})?)?(?:[+-]\d{4})?$/.exec(dt?.trim() ?? '');
  if (!m) return undefined;
  return dicomDateTimeSeconds(m[1], m[2] ?? '00');
}

export type SuvRefusal =
  | { ok: false; reason: 'units'; units?: string }
  | { ok: false; reason: 'notCorrected' }
  | { ok: false; reason: 'decayCorrection'; decayCorrection?: string }
  | { ok: false; reason: 'missing'; missing: string[] }
  | { ok: false; reason: 'timing' };

export type SuvResult = { ok: true; factor: number; decaySeconds: number } | SuvRefusal;

/**
 * SUVbw factor: SUVbw = stored value in Bq/ml × factor.
 * `earliestAcquisition` (seconds since 1970) is the earliest acquisition time of the series; it replaces the series
 * time when the series time is later than the acquisition (some scanners rewrite Series Time after post-processing).
 */
export function suvBwFactor(inst: InstanceRecord, earliestAcquisition?: number): SuvResult {
  const units = inst.petUnits?.toUpperCase();
  if (units === 'GML') return { ok: true, factor: 1, decaySeconds: 0 };
  if (units !== 'BQML') return { ok: false, reason: 'units', ...(units ? { units } : {}) };

  const corrected = (inst.correctedImage ?? []).map((v) => v.toUpperCase());
  if (!corrected.includes('ATTN') || !corrected.includes('DECY')) return { ok: false, reason: 'notCorrected' };
  const decayCorrection = inst.decayCorrection?.toUpperCase();
  if (decayCorrection !== 'START' && decayCorrection !== 'ADMIN')
    return { ok: false, reason: 'decayCorrection', ...(decayCorrection ? { decayCorrection } : {}) };

  const rp = inst.radiopharmaceutical;
  const missing: string[] = [];
  if (!(inst.patientWeight !== undefined && inst.patientWeight > 0)) missing.push('PatientWeight');
  if (!(rp?.totalDose !== undefined && rp.totalDose > 0)) missing.push('RadionuclideTotalDose');
  if (!(rp?.halfLife !== undefined && rp.halfLife > 0)) missing.push('RadionuclideHalfLife');
  const explicitStart = parseDicomDateTimeSeconds(rp?.startDateTime);
  if (explicitStart === undefined && parseDicomTimeSeconds(rp?.startTime) === undefined) missing.push('RadiopharmaceuticalStartTime');
  let scan = dicomDateTimeSeconds(inst.seriesDate, inst.seriesTime);
  if (scan === undefined) missing.push('SeriesDate/SeriesTime');
  if (missing.length > 0) return { ok: false, reason: 'missing', missing };

  const acq = earliestAcquisition ?? dicomDateTimeSeconds(inst.acquisitionDate, inst.acquisitionTime);
  if (acq !== undefined && scan! > acq) scan = acq;

  let decaySeconds = 0;
  if (decayCorrection === 'START') {
    let start = explicitStart ?? dicomDateTimeSeconds(inst.seriesDate, rp!.startTime)!;
    // Start time without a date: an injection "later" than the scan happened the day before.
    if (explicitStart === undefined && start > scan!) start -= 86400;
    decaySeconds = scan! - start;
    if (decaySeconds < 0 || decaySeconds > 86400) return { ok: false, reason: 'timing' };
  }
  const decayedDose = rp!.totalDose! * 2 ** (-decaySeconds / rp!.halfLife!);
  return { ok: true, factor: (inst.patientWeight! * 1000) / decayedDose, decaySeconds };
}
