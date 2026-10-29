/**
 * Minimal DICOM Part 10 writer for synthetic test fixtures.
 * Supports implicit/explicit VR, little/big endian, deflate, sequences and encapsulated pixel data.
 * It also allows deliberately malformed output (used by the malformed corpus).
 */
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

export type VR =
  | 'AE' | 'AS' | 'AT' | 'CS' | 'DA' | 'DS' | 'DT' | 'FL' | 'FD' | 'IS' | 'LO' | 'LT' | 'OB' | 'OD' | 'OF' | 'OL'
  | 'OW' | 'PN' | 'SH' | 'SL' | 'SQ' | 'SS' | 'ST' | 'TM' | 'UC' | 'UI' | 'UL' | 'UN' | 'UR' | 'US' | 'UT';

export interface Encapsulated {
  fragments: Uint8Array[];
}

export type Value = string | string[] | number | number[] | Uint8Array | Uint16Array | Item[] | Encapsulated;

export interface Element {
  tag: number;
  vr: VR;
  value: Value;
  /** Write SQ / item with undefined length (delimiters). */
  undefinedLength?: boolean;
}

export type Item = Element[];

export const TSUID = {
  implicitLE: '1.2.840.10008.1.2',
  explicitLE: '1.2.840.10008.1.2.1',
  deflated: '1.2.840.10008.1.2.1.99',
  explicitBE: '1.2.840.10008.1.2.2',
  jpegBaseline: '1.2.840.10008.1.2.4.50',
  jpegLosslessSV1: '1.2.840.10008.1.2.4.70',
  jpegLS: '1.2.840.10008.1.2.4.80',
  jpegLSNear: '1.2.840.10008.1.2.4.81',
  j2kLossless: '1.2.840.10008.1.2.4.90',
  j2k: '1.2.840.10008.1.2.4.91',
  htj2kLossless: '1.2.840.10008.1.2.4.201',
  rle: '1.2.840.10008.1.2.5',
} as const;

const LONG_VR = new Set<VR>(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT']);
const STRING_VR = new Set<VR>(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);

export const tag = (group: number, element: number): number => ((group << 16) | element) >>> 0;

/** Deterministic 2.25 UID derived from a seed string (no organization root needed). */
export function uid(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(h[i]!);
  return `2.25.${n.toString()}`;
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;
  constructor(private readonly le: boolean) {}
  bytes(b: Uint8Array): void {
    this.chunks.push(b);
    this.length += b.length;
  }
  u16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, this.le);
    this.bytes(b);
  }
  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, this.le);
    this.bytes(b);
  }
  ascii(s: string): void {
    this.bytes(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  }
  result(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

export interface EncodeOptions {
  explicit: boolean;
  littleEndian: boolean;
}

function binary(vr: VR, value: number | number[], le: boolean): Uint8Array {
  const arr = Array.isArray(value) ? value : [value];
  const size = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, AT: 4 }[vr as 'US'] ?? 2;
  const out = new Uint8Array(arr.length * size);
  const dv = new DataView(out.buffer);
  arr.forEach((v, i) => {
    const o = i * size;
    switch (vr) {
      case 'US': dv.setUint16(o, v, le); break;
      case 'SS': dv.setInt16(o, v, le); break;
      case 'UL': dv.setUint32(o, v, le); break;
      case 'SL': dv.setInt32(o, v, le); break;
      case 'FL': dv.setFloat32(o, v, le); break;
      case 'FD': dv.setFloat64(o, v, le); break;
      case 'AT': dv.setUint16(o, v >>> 16, le); dv.setUint16(o + 2, v & 0xffff, le); break;
      default: throw new Error(`binary VR ${vr}`);
    }
  });
  return out;
}

function stringBytes(vr: VR, value: Value): Uint8Array {
  if (value instanceof Uint8Array) return padEven(value, vr === 'UI' ? 0 : 0x20);
  const s = Array.isArray(value) ? (value as (string | number)[]).map(String).join('\\') : String(value);
  for (const c of s) if (c.charCodeAt(0) > 0x7f) throw new Error(`non-ASCII text for ${vr} must be given as bytes`);
  return padEven(Uint8Array.from(s, (c) => c.charCodeAt(0)), vr === 'UI' ? 0 : 0x20);
}

function padEven(b: Uint8Array, pad: number): Uint8Array {
  if (b.length % 2 === 0) return b;
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  out[b.length] = pad;
  return out;
}

function swap16(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i + 1 < b.length; i += 2) {
    out[i] = b[i + 1]!;
    out[i + 1] = b[i]!;
  }
  return out;
}

function encodeValue(el: Element, opts: EncodeOptions): Uint8Array {
  const { vr, value } = el;
  if (STRING_VR.has(vr)) return stringBytes(vr, value);
  if (vr === 'OB' || vr === 'UN') return padEven(value as Uint8Array, 0);
  if (vr === 'OW') {
    const v = value instanceof Uint16Array ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : (value as Uint8Array);
    // Input is always little-endian bytes; swap for big endian.
    return opts.littleEndian ? padEven(v, 0) : swap16(padEven(v, 0));
  }
  if (vr === 'OF' || vr === 'OD' || vr === 'OL') return padEven(value as Uint8Array, 0);
  return binary(vr, value as number | number[], opts.littleEndian);
}

function writeHeader(w: ByteWriter, t: number, vr: VR, length: number, opts: EncodeOptions): void {
  w.u16(t >>> 16);
  w.u16(t & 0xffff);
  if (opts.explicit) {
    w.ascii(vr);
    if (LONG_VR.has(vr)) {
      w.u16(0);
      w.u32(length);
    } else {
      w.u16(length);
    }
  } else {
    w.u32(length);
  }
}

export function encodeDataset(elements: Element[], opts: EncodeOptions): Uint8Array {
  const w = new ByteWriter(opts.littleEndian);
  const sorted = [...elements].sort((a, b) => a.tag - b.tag);
  for (const el of sorted) {
    if (el.vr === 'SQ') {
      const items = el.value as Item[];
      const encodedItems = items.map((it) => encodeDataset(it, opts));
      if (el.undefinedLength) {
        writeHeader(w, el.tag, 'SQ', 0xffffffff, opts);
        for (const it of encodedItems) {
          w.u16(0xfffe); w.u16(0xe000); w.u32(0xffffffff);
          w.bytes(it);
          w.u16(0xfffe); w.u16(0xe00d); w.u32(0);
        }
        w.u16(0xfffe); w.u16(0xe0dd); w.u32(0);
      } else {
        const len = encodedItems.reduce((s, it) => s + 8 + it.length, 0);
        writeHeader(w, el.tag, 'SQ', len, opts);
        for (const it of encodedItems) {
          w.u16(0xfffe); w.u16(0xe000); w.u32(it.length);
          w.bytes(it);
        }
      }
      continue;
    }
    if (typeof el.value === 'object' && el.value !== null && 'fragments' in el.value) {
      // Encapsulated pixel data: undefined length, empty Basic Offset Table, one fragment per frame.
      writeHeader(w, el.tag, 'OB', 0xffffffff, opts);
      w.u16(0xfffe); w.u16(0xe000); w.u32(0);
      for (const f of el.value.fragments) {
        const p = padEven(f, 0);
        w.u16(0xfffe); w.u16(0xe000); w.u32(p.length);
        w.bytes(p);
      }
      w.u16(0xfffe); w.u16(0xe0dd); w.u32(0);
      continue;
    }
    const v = encodeValue(el, opts);
    writeHeader(w, el.tag, el.vr, v.length, opts);
    w.bytes(v);
  }
  return w.result();
}

export interface Part10Options {
  transferSyntaxUid: string;
  /** Media Storage SOP Class/Instance; default: (0008,0016)/(0008,0018) of the dataset. */
  mediaStorageSopClassUid?: string;
  mediaStorageSopInstanceUid?: string;
  /** Overrides used by the malformed corpus. */
  omitPreamble?: boolean;
}

/** Byte length of the preamble + "DICM" + File Meta Information for the given options. */
export function part10HeaderLength(dataset: Element[], opts: Part10Options): number {
  return writePart10([], { ...opts, ...mediaIds(dataset, opts) }).length;
}

function mediaIds(dataset: Element[], opts: Part10Options): { mediaStorageSopClassUid: string; mediaStorageSopInstanceUid: string } {
  const find = (t: number): string => {
    const el = dataset.find((e) => e.tag === t);
    if (!el) throw new Error(`missing ${t.toString(16)}`);
    return String(el.value);
  };
  return {
    mediaStorageSopClassUid: opts.mediaStorageSopClassUid ?? find(tag(0x0008, 0x0016)),
    mediaStorageSopInstanceUid: opts.mediaStorageSopInstanceUid ?? find(tag(0x0008, 0x0018)),
  };
}

/** Writes a complete Part 10 file. */
export function writePart10(dataset: Element[], opts: Part10Options): Uint8Array {
  const ids = mediaIds(dataset, opts);
  const ts = opts.transferSyntaxUid;
  const meta: Element[] = [
    { tag: tag(0x0002, 0x0001), vr: 'OB', value: Uint8Array.from([0, 1]) },
    { tag: tag(0x0002, 0x0002), vr: 'UI', value: ids.mediaStorageSopClassUid },
    { tag: tag(0x0002, 0x0003), vr: 'UI', value: ids.mediaStorageSopInstanceUid },
    { tag: tag(0x0002, 0x0010), vr: 'UI', value: ts },
    { tag: tag(0x0002, 0x0012), vr: 'UI', value: uid('clinic-dicom-viewer-fixture-generator') },
    { tag: tag(0x0002, 0x0013), vr: 'SH', value: 'CDV_FIXTURES' },
  ];
  const metaBody = encodeDataset(meta, { explicit: true, littleEndian: true });
  const groupLength = encodeDataset([{ tag: tag(0x0002, 0x0000), vr: 'UL', value: metaBody.length }], {
    explicit: true,
    littleEndian: true,
  });

  let body: Uint8Array;
  if (ts === TSUID.implicitLE) body = encodeDataset(dataset, { explicit: false, littleEndian: true });
  else if (ts === TSUID.explicitBE) body = encodeDataset(dataset, { explicit: true, littleEndian: false });
  else if (ts === TSUID.deflated) body = deflateRawSync(encodeDataset(dataset, { explicit: true, littleEndian: true }));
  else body = encodeDataset(dataset, { explicit: true, littleEndian: true });

  const preamble = opts.omitPreamble ? new Uint8Array(0) : new Uint8Array(128);
  const magic = opts.omitPreamble ? new Uint8Array(0) : Uint8Array.from([0x44, 0x49, 0x43, 0x4d]);
  const out = new Uint8Array(preamble.length + magic.length + groupLength.length + metaBody.length + body.length);
  let o = 0;
  for (const part of [preamble, magic, groupLength, metaBody, body]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Encodes text in ISO-8859-9 (Latin-5, Turkish) for ISO_IR 148 fixtures. */
export function latin5(s: string): Uint8Array {
  const special: Record<string, number> = { Ğ: 0xd0, İ: 0xdd, Ş: 0xde, ğ: 0xf0, ı: 0xfd, ş: 0xfe };
  return Uint8Array.from(s, (c) => {
    if (special[c] !== undefined) return special[c]!;
    const code = c.charCodeAt(0);
    if (code > 0xff || [0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe].includes(code)) throw new Error(`not in Latin-5: ${c}`);
    return code;
  });
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
