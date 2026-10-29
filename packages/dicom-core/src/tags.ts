/**
 * DICOM tag tree for the tag browser, plus overlay-plane (60xx) extraction and DICOMDIR reading.
 * All functions take untrusted bytes and never throw; failures return structured errors.
 */
import dicomParser from 'dicom-parser';
import { CHARSET_VRS, decodeText, parseSpecificCharacterSet } from './charset.js';

type DataSet = dicomParser.DataSet;
type DicomElement = dicomParser.Element;

export interface TagNode {
  /** "(GGGG,EEEE)" */
  tag: string;
  name: string;
  vr: string;
  length: number;
  value: string;
  items?: TagNode[][];
}

export interface DictEntry {
  name: string;
  vr: string;
}
/** Looks up a tag given as "GGGGEEEE" (upper-case hex). */
export type DictLookup = (tag: string) => DictEntry | undefined;

export interface TagTreeOptions {
  lookup: DictLookup;
  inflater?: (bytes: Uint8Array, position: number) => Uint8Array;
  maxDepth?: number;
  maxValueChars?: number;
}

const BINARY_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);
const MAX_LIST = 16;

function fmtTag(key: string): string {
  const g = key.slice(1, 5).toUpperCase();
  const e = key.slice(5, 9).toUpperCase();
  return `(${g},${e})`;
}

function valueOf(ds: DataSet, el: DicomElement, vr: string, charset: string[], maxChars: number): string {
  if (el.length === 0) return '';
  if (el.length === 0xffffffff) {
    if (el.fragments) return `<encapsulated: ${el.fragments.length} fragment(s)>`;
    return '<undefined length>';
  }
  if (el.dataOffset + el.length > ds.byteArray.length) return '<truncated>';
  const bytes = ds.byteArray.subarray(el.dataOffset, el.dataOffset + el.length);
  const clip = (s: string): string => (s.length > maxChars ? `${s.slice(0, maxChars)}…` : s);
  const list = (n: number, get: (i: number) => number | string): string => {
    const parts: string[] = [];
    for (let i = 0; i < Math.min(n, MAX_LIST); i++) parts.push(String(get(i)));
    return parts.join('\\') + (n > MAX_LIST ? `\\… (${n})` : '');
  };
  switch (vr) {
    case 'US':
      return list(el.length / 2, (i) => ds.uint16(el.tag, i) ?? '');
    case 'SS':
      return list(el.length / 2, (i) => ds.int16(el.tag, i) ?? '');
    case 'UL':
      return list(el.length / 4, (i) => ds.uint32(el.tag, i) ?? '');
    case 'SL':
      return list(el.length / 4, (i) => ds.int32(el.tag, i) ?? '');
    case 'FL':
      return list(el.length / 4, (i) => ds.float(el.tag, i) ?? '');
    case 'FD':
      return list(el.length / 8, (i) => ds.double(el.tag, i) ?? '');
    case 'AT':
      return list(el.length / 4, (i) => {
        const g = ds.uint16(el.tag, i * 2) ?? 0;
        const e = ds.uint16(el.tag, i * 2 + 1) ?? 0;
        return `(${g.toString(16).padStart(4, '0')},${e.toString(16).padStart(4, '0')})`.toUpperCase();
      });
    default:
      break;
  }
  if (BINARY_VR.has(vr)) return `<binary ${el.length} bytes>`;
  const text = CHARSET_VRS.has(vr) ? decodeText(bytes, charset).text : String.fromCharCode(...bytes.subarray(0, 4096));
  return clip(text.replace(/[\0 ]+$/u, ''));
}

function buildLevel(ds: DataSet, opts: Required<Omit<TagTreeOptions, 'inflater'>>, charset: string[], depth: number): TagNode[] {
  const keys = Object.keys(ds.elements).sort();
  const nodes: TagNode[] = [];
  for (const key of keys) {
    const el = ds.elements[key]!;
    const tagHex = key.slice(1).toUpperCase();
    const dict = opts.lookup(tagHex);
    const isPrivate = parseInt(tagHex.slice(0, 4), 16) % 2 === 1;
    const isGroupLength = tagHex.endsWith('0000');
    const vr = el.vr ?? (el.items ? 'SQ' : dict?.vr?.split('|')[0] ?? 'UN');
    const name = dict?.name ?? (isGroupLength ? 'GroupLength' : isPrivate ? 'Private' : 'Unknown');
    const node: TagNode = { tag: fmtTag(key), name, vr, length: el.length, value: '' };
    if (el.items) {
      node.value = `${el.items.length} item(s)`;
      if (depth < opts.maxDepth) {
        node.items = el.items.map((it) => (it.dataSet ? buildLevel(it.dataSet, opts, charset, depth + 1) : []));
      } else node.value += ' (nesting limit)';
    } else {
      node.value = valueOf(ds, el, vr, charset, opts.maxValueChars);
    }
    nodes.push(node);
  }
  return nodes;
}

export type TagTreeResult = { ok: true; nodes: TagNode[] } | { ok: false; error: 'malformed'; nodes: TagNode[] };

/** Builds the complete tag tree of a Part 10 file. On parse failure returns what could be read. */
export function buildTagTree(bytes: Uint8Array, opts: TagTreeOptions): TagTreeResult {
  const full = { lookup: opts.lookup, maxDepth: opts.maxDepth ?? 32, maxValueChars: opts.maxValueChars ?? 512 };
  try {
    const ds = dicomParser.parseDicom(bytes, opts.inflater ? { inflater: opts.inflater } : {});
    const charset = parseSpecificCharacterSet(ds.string('x00080005'));
    return { ok: true, nodes: buildLevel(ds, full, charset, 0) };
  } catch (e) {
    const partial = (e as { dataSet?: DataSet })?.dataSet;
    return { ok: false, error: 'malformed', nodes: partial ? buildLevel(partial, full, [], 0) : [] };
  }
}

// ---------------------------------------------------------------------------------------------
// Overlays (PS3.3 C.9.2)
// ---------------------------------------------------------------------------------------------

export interface OverlayLayer {
  group: number;
  rows: number;
  columns: number;
  origin: [number, number];
  description?: string;
  bitmap: Uint8Array;
}

const MAX_OVERLAY_PIXELS = 16384 * 16384;

/**
 * Extracts graphics overlays for one (1-based) image frame. Overlays without frame information
 * (60xx,0015) are applied to every frame. Embedded (retired, bits-allocated ≠ 1) overlays are skipped.
 */
export function extractOverlays(bytes: Uint8Array, frame: number, inflater?: TagTreeOptions['inflater']): OverlayLayer[] {
  let ds: DataSet;
  try {
    ds = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010', ...(inflater ? { inflater } : {}) });
  } catch {
    return [];
  }
  const bigEndian = ds.string('x00020010') === '1.2.840.10008.1.2.2';
  const layers: OverlayLayer[] = [];
  for (let g = 0x6000; g <= 0x601e; g += 2) {
    const k = (e: number): string => `x${g.toString(16)}${e.toString(16).padStart(4, '0')}`;
    const data = ds.elements[k(0x3000)];
    if (!data || data.length === 0xffffffff) continue;
    const rows = ds.uint16(k(0x0010)) ?? 0;
    const columns = ds.uint16(k(0x0011)) ?? 0;
    const bitsAllocated = ds.uint16(k(0x0100)) ?? 1;
    if (!rows || !columns || bitsAllocated !== 1 || rows * columns > MAX_OVERLAY_PIXELS) continue;
    const framesInOverlay = Number(ds.string(k(0x0015)) ?? '') || 0;
    const frameOrigin = ds.uint16(k(0x0051)) ?? 1;
    let frameIndex = 0;
    if (framesInOverlay > 0) {
      frameIndex = frame - frameOrigin;
      if (frameIndex < 0 || frameIndex >= framesInOverlay) continue;
    }
    const n = rows * columns;
    const bitStart = frameIndex * n;
    if (Math.ceil((bitStart + n) / 8) > data.length || data.dataOffset + data.length > ds.byteArray.length) continue;
    const src = ds.byteArray.subarray(data.dataOffset, data.dataOffset + data.length);
    const bitmap = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const bit = bitStart + i;
      let byte = bit >> 3;
      if (bigEndian) byte = (byte & ~1) | (1 - (byte & 1));
      bitmap[i] = (src[byte]! >> (bit & 7)) & 1;
    }
    const originRow = ds.int16(k(0x0050), 0) ?? 1;
    const originCol = ds.int16(k(0x0050), 1) ?? 1;
    const description = ds.string(k(0x0022)) ?? ds.string(k(0x1500));
    layers.push({ group: g, rows, columns, origin: [originRow, originCol], bitmap, ...(description ? { description } : {}) });
  }
  return layers;
}

// ---------------------------------------------------------------------------------------------
// DICOMDIR
// ---------------------------------------------------------------------------------------------

export type DicomdirResult =
  | { ok: true; files: string[][]; fileSetId?: string }
  | { ok: false; error: 'notDicomdir' | 'malformed' };

const SAFE_COMPONENT = /^[^\\/:*?"<>|\0]{1,255}$/;

/** Reads Referenced File IDs (as path components) from a DICOMDIR. Unsafe components are dropped. */
export function readDicomdir(bytes: Uint8Array): DicomdirResult {
  let ds: DataSet;
  try {
    ds = dicomParser.parseDicom(bytes);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  const records = ds.elements.x00041220?.items;
  if (!records) return { ok: false, error: 'notDicomdir' };
  const files: string[][] = [];
  for (const item of records) {
    const ref = item.dataSet?.string('x00041500');
    if (!ref) continue;
    const parts = ref.split('\\').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0 || parts.some((p) => p === '.' || p === '..' || !SAFE_COMPONENT.test(p))) continue;
    files.push(parts);
  }
  const fileSetId = ds.string('x00041130');
  return { ok: true, files, ...(fileSetId ? { fileSetId } : {}) };
}
