/** Display formatting of DICOM value representations. Locale-aware; no clinical math. */

export type UiLocale = 'tr' | 'en';

/**
 * Formats a PN value ("Family^Given^Middle^Prefix^Suffix", optionally "=ideographic=phonetic")
 * as "FAMILY, Given Middle" using the alphabetic component group only.
 * Uppercasing uses the Turkish locale rules when locale is 'tr' (i → İ).
 */
export function formatPersonName(pn: string | undefined, locale: UiLocale = 'tr'): string {
  if (!pn) return '';
  const alphabetic = pn.split('=')[0] ?? '';
  const [family = '', given = '', middle = '', prefix = '', suffix = ''] = alphabetic
    .split('^')
    .map((s) => s.trim());
  const tag = locale === 'tr' ? 'tr-TR' : 'en-US';
  const givenPart = [prefix, given, middle].filter(Boolean).join(' ');
  const fam = family.toLocaleUpperCase(tag);
  let out = fam && givenPart ? `${fam}, ${givenPart}` : fam || givenPart;
  if (suffix) out += ` ${suffix}`;
  return out;
}

/** Parses DA (YYYYMMDD, also legacy YYYY.MM.DD) into its parts. */
export function parseDicomDate(da: string | undefined): { y: number; m: number; d: number } | undefined {
  if (!da) return undefined;
  const s = da.trim().replace(/\./g, '');
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return { y, m: mo, d };
}

/** DD.MM.YYYY for Turkish, YYYY-MM-DD (ISO) for English. Unparseable input is returned verbatim. */
export function formatDicomDate(da: string | undefined, locale: UiLocale): string {
  const p = parseDicomDate(da);
  if (!p) return da?.trim() ?? '';
  const dd = String(p.d).padStart(2, '0');
  const mm = String(p.m).padStart(2, '0');
  return locale === 'tr' ? `${dd}.${mm}.${p.y}` : `${p.y}-${mm}-${dd}`;
}

/** HH:MM:SS from TM. */
export function formatDicomTime(tm: string | undefined): string {
  if (!tm) return '';
  const s = tm.trim().replace(/:/g, '');
  const m = /^(\d{2})(\d{2})?(\d{2})?/.exec(s);
  if (!m) return tm.trim();
  return [m[1], m[2] ?? '00', m[3] ?? '00'].join(':');
}

/** Formats a number with fixed decimals using the locale decimal separator (tabular in UI via CSS). */
export function formatNumber(v: number, decimals: number, locale: UiLocale): string {
  return v.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
}

/**
 * Decimal places appropriate to a pixel spacing for length display:
 * spacing ≥ 1 mm → 1 decimal, ≥ 0.1 mm → 2, finer → 3.
 */
export function decimalsForSpacing(spacingMm: number | undefined): number {
  if (spacingMm === undefined || !(spacingMm > 0)) return 0;
  if (spacingMm >= 1) return 1;
  if (spacingMm >= 0.1) return 2;
  return 3;
}
