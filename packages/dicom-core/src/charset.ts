/**
 * Specific Character Set (0008,0005) decoding, PS3.3 C.12.1.1.2 and PS3.5 §6.1.
 *
 * Supported reliably: default repertoire (ISO_IR 6), ISO_IR 100 (Latin-1), ISO_IR 148 (Latin-5, Turkish),
 * ISO_IR 192 (UTF-8), single-byte ISO_IR 101/109/110/126/127/138/144/166 and their ISO 2022 forms with
 * G1 code-extension escape sequences. Multi-byte ISO 2022 sets (IR 87/159/149/58) and GB18030/GBK are decoded
 * best-effort and flagged as uncertain.
 */

/** WHATWG encoding labels for single-byte DICOM terms (both the ISO_IR and ISO 2022 IR spelling). */
const SINGLE_BYTE: Record<string, string> = {
  'ISO_IR 100': 'iso-8859-1',
  'ISO 2022 IR 100': 'iso-8859-1',
  'ISO_IR 101': 'iso-8859-2',
  'ISO 2022 IR 101': 'iso-8859-2',
  'ISO_IR 109': 'iso-8859-3',
  'ISO 2022 IR 109': 'iso-8859-3',
  'ISO_IR 110': 'iso-8859-4',
  'ISO 2022 IR 110': 'iso-8859-4',
  'ISO_IR 144': 'iso-8859-5',
  'ISO 2022 IR 144': 'iso-8859-5',
  'ISO_IR 127': 'iso-8859-6',
  'ISO 2022 IR 127': 'iso-8859-6',
  'ISO_IR 126': 'iso-8859-7',
  'ISO 2022 IR 126': 'iso-8859-7',
  'ISO_IR 138': 'iso-8859-8',
  'ISO 2022 IR 138': 'iso-8859-8',
  'ISO_IR 148': 'iso-8859-9',
  'ISO 2022 IR 148': 'iso-8859-9',
  'ISO_IR 166': 'windows-874',
  'ISO 2022 IR 166': 'windows-874',
  'ISO_IR 13': 'shift_jis',
  'ISO 2022 IR 13': 'shift_jis',
};

/** G1 designation escape sequences (ESC 0x2D F) for 96-character sets → WHATWG label. */
const G1_ESCAPES: Record<string, string> = {
  '-A': 'iso-8859-1',
  '-B': 'iso-8859-2',
  '-C': 'iso-8859-3',
  '-D': 'iso-8859-4',
  '-L': 'iso-8859-5',
  '-G': 'iso-8859-6',
  '-F': 'iso-8859-7',
  '-H': 'iso-8859-8',
  '-M': 'iso-8859-9',
  '-T': 'windows-874',
};

const MULTI_BYTE: Record<string, string> = {
  'ISO_IR 192': 'utf-8',
  GB18030: 'gb18030',
  GBK: 'gbk',
  'ISO 2022 IR 87': 'iso-2022-jp',
  'ISO 2022 IR 159': 'iso-2022-jp',
  'ISO 2022 IR 149': 'euc-kr',
  'ISO 2022 IR 58': 'gb18030',
};

export interface DecodedText {
  text: string;
  /** True when the declared character set is unknown/unsupported or the bytes did not fit it. */
  uncertain: boolean;
}

const decoderCache = new Map<string, InstanceType<typeof TextDecoder>>();
function decoder(label: string, fatal: boolean): InstanceType<typeof TextDecoder> {
  const key = `${label}|${fatal ? 1 : 0}`;
  let d = decoderCache.get(key);
  if (!d) {
    d = new TextDecoder(label, { fatal });
    decoderCache.set(key, d);
  }
  return d;
}

/** Splits and normalizes the Specific Character Set value (multi-valued, value 1 may be empty = default). */
export function parseSpecificCharacterSet(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = typeof value === 'string' ? value.split('\\') : [...value];
  return parts.map((p) => p.trim().toUpperCase().replace(/\s+/g, ' ').replace(/^ISO_IR_/, 'ISO_IR '));
}

function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b > 0x7f) return false;
  return true;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * Decodes a text value's raw bytes using the dataset's Specific Character Set.
 * Never throws; returns `uncertain: true` and a Latin-1 rendering when decoding is not trustworthy.
 */
export function decodeText(bytes: Uint8Array, specificCharacterSet: readonly string[]): DecodedText {
  const terms = specificCharacterSet.filter((t) => t !== '');
  const first = specificCharacterSet[0] ?? '';

  if (terms.length === 0 || (terms.length === 1 && (first === 'ISO_IR 6' || first === 'ISO 2022 IR 6'))) {
    // Default repertoire is ASCII. Bytes > 0x7F are a violation; show them as Latin-1 but flag them.
    return isAscii(bytes) ? { text: latin1(bytes), uncertain: false } : { text: latin1(bytes), uncertain: true };
  }

  const hasEscape = bytes.includes(0x1b);
  if (!hasEscape) {
    // Without code extensions the first value (or the only non-empty value) applies.
    const term = first !== '' ? first : terms[0]!;
    return decodeWith(bytes, term);
  }
  return decodeIso2022(bytes, specificCharacterSet);
}

function decodeWith(bytes: Uint8Array, term: string): DecodedText {
  const single = SINGLE_BYTE[term];
  if (single) return { text: decoder(single, false).decode(bytes), uncertain: false };
  const multi = MULTI_BYTE[term];
  if (multi) {
    try {
      return { text: decoder(multi, true).decode(bytes), uncertain: multi !== 'utf-8' };
    } catch {
      return { text: decoder(multi, false).decode(bytes), uncertain: true };
    }
  }
  if (term === 'ISO_IR 6' || term === 'ISO 2022 IR 6') {
    return { text: latin1(bytes), uncertain: !isAscii(bytes) };
  }
  return { text: latin1(bytes), uncertain: true };
}

/**
 * ISO 2022 decoding with escape sequences. G0 is ASCII unless redesignated; G1 starts as the set of the
 * first Specific Character Set value and is switched by ESC 0x2D F sequences. Multi-byte designations
 * (ESC $ ...) are passed to the browser's iso-2022-jp decoder best-effort and flagged uncertain.
 */
function decodeIso2022(bytes: Uint8Array, scs: readonly string[]): DecodedText {
  const initial = SINGLE_BYTE[scs[0] ?? ''];
  let g1: string | undefined = initial;
  let uncertain = false;
  let out = '';
  let run: number[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const chunk = Uint8Array.from(run);
    if (g1) out += decoder(g1, false).decode(chunk);
    else {
      out += latin1(chunk);
      if (!isAscii(chunk)) uncertain = true;
    }
    run = [];
  };

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b !== 0x1b) {
      run.push(b);
      continue;
    }
    flush();
    const i1 = bytes[i + 1];
    const i2 = bytes[i + 2];
    if (i1 === undefined || i2 === undefined) {
      uncertain = true;
      break;
    }
    const seq = String.fromCharCode(i1, i2);
    if (seq === '(B' || seq === '(J') {
      // G0 ASCII / JIS-Roman: nothing to change for our single-byte handling.
      i += 2;
    } else if (G1_ESCAPES[seq]) {
      g1 = G1_ESCAPES[seq];
      i += 2;
    } else if (i1 === 0x24) {
      // Multi-byte designation (Japanese/Korean/Chinese): decode the rest best-effort.
      const rest = bytes.subarray(i);
      out += decoder('iso-2022-jp', false).decode(rest);
      uncertain = true;
      i = bytes.length;
    } else {
      uncertain = true;
      i += 2;
    }
  }
  flush();
  return { text: out, uncertain };
}

/** Text VRs whose values are affected by Specific Character Set (PS3.5 §6.1.2.3). */
export const CHARSET_VRS: ReadonlySet<string> = new Set(['SH', 'LO', 'ST', 'LT', 'UT', 'PN', 'UC']);
