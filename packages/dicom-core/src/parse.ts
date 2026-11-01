/**
 * DICOM Part 10 header parsing into the normalized InstanceRecord.
 * Input is untrusted: every failure becomes a ParseError code, never an exception to the caller.
 */
import dicomParser from 'dicom-parser';
import { decodeText, parseSpecificCharacterSet } from './charset.js';
import type { FrameGeometry, InstanceRecord, Radiopharmaceutical, UltrasoundRegion } from './types.js';

type DataSet = dicomParser.DataSet;

/** Hard limits for untrusted input. Documented in docs/RISK_REGISTER.md (R-003). */
export const PARSE_LIMITS = {
  maxRows: 16384,
  maxColumns: 16384,
  maxFrames: 20000,
  /** Maximum uncompressed bytes of a single frame (512 MiB). */
  maxFrameBytes: 512 * 1024 * 1024,
  maxSamplesPerPixel: 4,
} as const;

export type ParseErrorCode =
  'notDicom' | 'truncated' | 'malformed' | 'missingUids' | 'unsupportedDimensions' | 'truncatedPixelData' | 'deflateUnsupported';

export type ParseResult = { ok: true; instance: InstanceRecord } | { ok: false; error: ParseErrorCode; detail?: string };

export interface ParseOptions {
  fileId: string;
  fileName: string;
  /** Size of the complete file; `bytes` may be only a prefix of it. */
  fileSize: number;
  /** Raw-deflate inflater for Deflated Explicit VR LE (1.2.840.10008.1.2.1.99). */
  inflater?: (bytes: Uint8Array, position: number) => Uint8Array;
}

export const TS = {
  implicitLE: '1.2.840.10008.1.2',
  explicitLE: '1.2.840.10008.1.2.1',
  deflated: '1.2.840.10008.1.2.1.99',
  explicitBE: '1.2.840.10008.1.2.2',
} as const;

const NATIVE_TS = new Set<string>([TS.implicitLE, TS.explicitLE, TS.deflated, TS.explicitBE]);

/** True when the buffer carries the "DICM" magic at offset 128. */
export function hasDicmPrefix(bytes: Uint8Array): boolean {
  return bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

// ---------------------------------------------------------------------------------------------
// Low-level value accessors
// ---------------------------------------------------------------------------------------------

export function tagKey(group: number, element: number): string {
  return `x${group.toString(16).padStart(4, '0')}${element.toString(16).padStart(4, '0')}`;
}

function rawBytes(ds: DataSet, tag: string): Uint8Array | undefined {
  const el = ds.elements[tag];
  if (!el || el.length === undefined || el.length <= 0 || el.length === 0xffffffff) return undefined;
  const end = el.dataOffset + el.length;
  if (end > ds.byteArray.length) return undefined;
  return ds.byteArray.subarray(el.dataOffset, end);
}

function trimValue(s: string): string {
  // DICOM pads with space (text) or NUL (UI); leading spaces are insignificant for most VRs.
  return s.replace(/[\0 ]+$/u, '').replace(/^ +/u, '');
}

function asciiString(ds: DataSet, tag: string): string | undefined {
  const b = rawBytes(ds, tag);
  if (!b) return undefined;
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  const t = trimValue(s);
  return t === '' ? undefined : t;
}

function asciiValues(ds: DataSet, tag: string): string[] | undefined {
  const s = asciiString(ds, tag);
  return s === undefined ? undefined : s.split('\\').map(trimValue);
}

function numbers(ds: DataSet, tag: string): number[] | undefined {
  const v = asciiValues(ds, tag);
  if (!v) return undefined;
  const n = v.map((x) => (x === '' ? Number.NaN : Number(x)));
  return n.every(Number.isFinite) ? n : undefined;
}

function number(ds: DataSet, tag: string): number | undefined {
  return numbers(ds, tag)?.[0];
}

function us(ds: DataSet, tag: string): number | undefined {
  const el = ds.elements[tag];
  if (!el || el.length < 2 || el.dataOffset + 2 > ds.byteArray.length) return undefined;
  return ds.uint16(tag);
}

function ss(ds: DataSet, tag: string): number | undefined {
  const el = ds.elements[tag];
  if (!el || el.length < 2 || el.dataOffset + 2 > ds.byteArray.length) return undefined;
  return ds.int16(tag);
}

function ul(ds: DataSet, tag: string): number | undefined {
  const el = ds.elements[tag];
  if (!el || el.length < 4 || el.dataOffset + 4 > ds.byteArray.length) return undefined;
  return ds.uint32(tag);
}

function fd(ds: DataSet, tag: string): number | undefined {
  const el = ds.elements[tag];
  if (!el || el.length < 8 || el.dataOffset + 8 > ds.byteArray.length) return undefined;
  const v = ds.double(tag);
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}

/** Sequence of Ultrasound Regions; items without bounds or deltas are skipped. */
function ultrasoundRegions(ds: DataSet): UltrasoundRegion[] | undefined {
  const items = ds.elements.x00186011?.items ?? [];
  const out: UltrasoundRegion[] = [];
  for (const it of items.slice(0, 16)) {
    const r = it.dataSet;
    if (!r) continue;
    const minX = ul(r, 'x00186018');
    const minY = ul(r, 'x0018601a');
    const maxX = ul(r, 'x0018601c');
    const maxY = ul(r, 'x0018601e');
    const unitsX = us(r, 'x00186024');
    const unitsY = us(r, 'x00186026');
    const deltaX = fd(r, 'x0018602c');
    const deltaY = fd(r, 'x0018602e');
    if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined) continue;
    if (unitsX === undefined || unitsY === undefined || deltaX === undefined || deltaY === undefined) continue;
    out.push(
      definedOnly({
        minX,
        minY,
        maxX,
        maxY,
        spatialFormat: us(r, 'x00186012'),
        dataType: us(r, 'x00186014'),
        unitsX,
        unitsY,
        deltaX,
        deltaY,
      }),
    );
  }
  return out.length > 0 ? out : undefined;
}

function radiopharmaceutical(ds: DataSet): Radiopharmaceutical | undefined {
  const r = item(ds, 'x00540016');
  if (!r) return undefined;
  const out = definedOnly({
    startTime: asciiString(r, 'x00181072'),
    startDateTime: asciiString(r, 'x00181078'),
    totalDose: number(r, 'x00181074'),
    halfLife: number(r, 'x00181075'),
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

function vec<N extends number>(ds: DataSet, tag: string, n: N): number[] | undefined {
  const v = numbers(ds, tag);
  return v && v.length === n ? v : undefined;
}

function item(ds: DataSet, tag: string, index = 0): DataSet | undefined {
  return ds.elements[tag]?.items?.[index]?.dataSet;
}

interface TextContext {
  charset: string[];
  uncertain: boolean;
}

function text(ds: DataSet, tag: string, ctx: TextContext): string | undefined {
  const b = rawBytes(ds, tag);
  if (!b) return undefined;
  const d = decodeText(b, ctx.charset);
  if (d.uncertain) ctx.uncertain = true;
  const t = trimValue(d.text);
  return t === '' ? undefined : t;
}

// ---------------------------------------------------------------------------------------------
// Functional groups (enhanced multi-frame)
// ---------------------------------------------------------------------------------------------

function frameGeometryFromGroups(group: DataSet | undefined): FrameGeometry {
  const g: FrameGeometry = {};
  if (!group) return g;
  const pos = item(group, 'x00209113');
  const ipp = pos && vec(pos, 'x00200032', 3);
  if (ipp) g.imagePositionPatient = ipp as [number, number, number];
  const ori = item(group, 'x00209116');
  const iop = ori && vec(ori, 'x00200037', 6);
  if (iop) g.imageOrientationPatient = iop as FrameGeometry['imageOrientationPatient'];
  const meas = item(group, 'x00289110');
  if (meas) {
    const ps = vec(meas, 'x00280030', 2);
    if (ps) g.pixelSpacing = ps as [number, number];
    const st = number(meas, 'x00180050');
    if (st !== undefined) g.sliceThickness = st;
  }
  const pvt = item(group, 'x00289145');
  if (pvt) {
    const slope = number(pvt, 'x00281053');
    const intercept = number(pvt, 'x00281052');
    if (slope !== undefined) g.rescaleSlope = slope;
    if (intercept !== undefined) g.rescaleIntercept = intercept;
  }
  const voi = item(group, 'x00289132');
  if (voi) {
    const wc = numbers(voi, 'x00281050');
    const ww = numbers(voi, 'x00281051');
    if (wc && ww) {
      g.windowCenter = wc;
      g.windowWidth = ww;
    }
  }
  const fc = item(group, 'x00209111');
  if (fc) {
    const tpi = fc.elements.x00209128 ? fc.uint32('x00209128') : undefined;
    if (tpi !== undefined) g.temporalPositionIndex = tpi;
    const stackId = asciiString(fc, 'x00209056');
    if (stackId) g.stackId = stackId;
    const isp = fc.elements.x00209057 ? fc.uint32('x00209057') : undefined;
    if (isp !== undefined) g.inStackPositionNumber = isp;
  }
  return g;
}

function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------

/**
 * Parses the header of a DICOM Part 10 file (stopping at Pixel Data) into an InstanceRecord.
 * `bytes` may be a prefix of the file; when it is too short the result is { ok:false, error:'truncated' }
 * and the caller may retry with more bytes.
 */
export function parseInstance(bytes: Uint8Array, opts: ParseOptions): ParseResult {
  if (!hasDicmPrefix(bytes)) return { ok: false, error: 'notDicom' };

  let ds: DataSet;
  try {
    ds = dicomParser.parseDicom(bytes, {
      untilTag: 'x7fe00010',
      ...(opts.inflater ? { inflater: opts.inflater } : {}),
    });
  } catch (e) {
    const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String((e as { exception?: unknown })?.exception ?? e);
    if (/inflat|deflate|zlib|pako/i.test(msg)) return { ok: false, error: 'deflateUnsupported' };
    if (/buffer overread|attempt to read past|position|truncat|eof/i.test(msg) && bytes.length < opts.fileSize) {
      return { ok: false, error: 'truncated' };
    }
    return { ok: false, error: bytes.length < opts.fileSize ? 'truncated' : 'malformed', detail: msg.slice(0, 200) };
  }

  const transferSyntaxUid = asciiString(ds, 'x00020010') ?? TS.implicitLE;
  const sopClassUid = asciiString(ds, 'x00080016') ?? asciiString(ds, 'x00020002');
  const sopInstanceUid = asciiString(ds, 'x00080018') ?? asciiString(ds, 'x00020003');
  const studyInstanceUid = asciiString(ds, 'x0020000d');
  const seriesInstanceUid = asciiString(ds, 'x0020000e');
  if (!sopClassUid || !sopInstanceUid || !studyInstanceUid || !seriesInstanceUid) {
    return { ok: false, error: 'missingUids' };
  }

  const charsetRaw = asciiString(ds, 'x00080005');
  const ctx: TextContext = { charset: parseSpecificCharacterSet(charsetRaw), uncertain: false };

  const rows = us(ds, 'x00280010');
  const columns = us(ds, 'x00280011');
  const pixel = ds.elements.x7fe00010 ?? ds.elements.x7fe00008 ?? ds.elements.x7fe00009;
  const hasPixelData = pixel !== undefined;
  const numberOfFramesRaw = number(ds, 'x00280008');
  const numberOfFrames = numberOfFramesRaw === undefined ? 1 : Math.trunc(numberOfFramesRaw);
  const bitsAllocated = us(ds, 'x00280100');
  const samplesPerPixel = us(ds, 'x00280002') ?? (hasPixelData ? 1 : undefined);

  if (hasPixelData) {
    if (
      !rows ||
      !columns ||
      rows > PARSE_LIMITS.maxRows ||
      columns > PARSE_LIMITS.maxColumns ||
      numberOfFrames < 1 ||
      numberOfFrames > PARSE_LIMITS.maxFrames ||
      !bitsAllocated ||
      ![1, 8, 16, 32, 64].includes(bitsAllocated) ||
      !samplesPerPixel ||
      samplesPerPixel > PARSE_LIMITS.maxSamplesPerPixel
    ) {
      return { ok: false, error: 'unsupportedDimensions' };
    }
    const frameBytes = Math.ceil((rows * columns * samplesPerPixel * bitsAllocated) / 8);
    if (frameBytes > PARSE_LIMITS.maxFrameBytes) return { ok: false, error: 'unsupportedDimensions' };
    // Native (uncompressed) pixel data must be fully present in the file. 1-bit frames are packed contiguously,
    // so the total is computed in bits before rounding up.
    if (NATIVE_TS.has(transferSyntaxUid) && transferSyntaxUid !== TS.deflated && pixel.length !== 0xffffffff) {
      const expected = Math.ceil((rows * columns * samplesPerPixel * bitsAllocated * numberOfFrames) / 8);
      if (pixel.length < expected || pixel.dataOffset + expected > opts.fileSize) {
        return { ok: false, error: 'truncatedPixelData' };
      }
    }
  }

  const shared = item(ds, 'x52009229');
  const perFrameEl = ds.elements.x52009230;
  const sharedGeometry = frameGeometryFromGroups(shared);
  let perFrame: FrameGeometry[] | undefined;
  if (perFrameEl?.items && perFrameEl.items.length > 0) {
    perFrame = perFrameEl.items.slice(0, numberOfFrames).map((it) => definedOnly(frameGeometryFromGroups(it.dataSet)));
  }

  const geometry: FrameGeometry = definedOnly({
    imagePositionPatient: vec(ds, 'x00200032', 3) as FrameGeometry['imagePositionPatient'],
    imageOrientationPatient: vec(ds, 'x00200037', 6) as FrameGeometry['imageOrientationPatient'],
    pixelSpacing: vec(ds, 'x00280030', 2) as FrameGeometry['pixelSpacing'],
    sliceThickness: number(ds, 'x00180050'),
    rescaleSlope: number(ds, 'x00281053'),
    rescaleIntercept: number(ds, 'x00281052'),
    windowCenter: numbers(ds, 'x00281050'),
    windowWidth: numbers(ds, 'x00281051'),
    // Single-frame multi-phase series: Temporal Position Index (UL) or the classic Temporal Position Identifier (IS).
    temporalPositionIndex: ul(ds, 'x00209128') ?? number(ds, 'x00200100'),
    ...definedOnly(sharedGeometry),
  });

  const overlayGroups: number[] = [];
  for (let g = 0x6000; g <= 0x601e; g += 2) {
    if (ds.elements[tagKey(g, 0x0010)] && ds.elements[tagKey(g, 0x3000)]) overlayGroups.push(g);
  }

  const mfi = item(ds, 'x00189117');
  const po = asciiValues(ds, 'x00200020');

  const instance: InstanceRecord = definedOnly({
    fileId: opts.fileId,
    fileName: opts.fileName,
    fileSize: opts.fileSize,
    transferSyntaxUid,
    sopClassUid,
    sopInstanceUid,
    studyInstanceUid,
    seriesInstanceUid,
    frameOfReferenceUid: asciiString(ds, 'x00200052'),

    patientName: text(ds, 'x00100010', ctx),
    patientId: text(ds, 'x00100020', ctx),
    patientBirthDate: asciiString(ds, 'x00100030'),
    patientSex: asciiString(ds, 'x00100040'),
    patientAge: asciiString(ds, 'x00101010'),
    patientWeight: number(ds, 'x00101030'),
    studyDate: asciiString(ds, 'x00080020'),
    studyTime: asciiString(ds, 'x00080030'),
    studyDescription: text(ds, 'x00081030', ctx),
    accessionNumber: text(ds, 'x00080050', ctx),
    studyId: text(ds, 'x00200010', ctx),
    institutionName: text(ds, 'x00080080', ctx),
    referringPhysicianName: text(ds, 'x00080090', ctx),

    modality: asciiString(ds, 'x00080060'),
    seriesNumber: number(ds, 'x00200011'),
    seriesDescription: text(ds, 'x0008103e', ctx),
    seriesDate: asciiString(ds, 'x00080021'),
    seriesTime: asciiString(ds, 'x00080031'),
    bodyPartExamined: asciiString(ds, 'x00180015'),
    protocolName: text(ds, 'x00181030', ctx),
    manufacturer: text(ds, 'x00080070', ctx),
    manufacturerModelName: text(ds, 'x00081090', ctx),
    stationName: text(ds, 'x00081010', ctx),

    instanceNumber: number(ds, 'x00200013'),
    acquisitionNumber: number(ds, 'x00200012'),
    acquisitionTime: asciiString(ds, 'x00080032'),
    contentTime: asciiString(ds, 'x00080033'),
    acquisitionDateTime: asciiString(ds, 'x0008002a'),
    imageType: asciiValues(ds, 'x00080008'),
    echoNumbers: number(ds, 'x00180086'),
    echoTime: number(ds, 'x00180081'),
    repetitionTime: number(ds, 'x00180080'),
    magneticFieldStrength: number(ds, 'x00180087'),
    // (0018,9087) Diffusion b-value is FD (binary).
    diffusionBValue: fd(ds, 'x00189087') ?? (mfi ? undefined : undefined),
    kvp: number(ds, 'x00180060'),
    xRayTubeCurrent: number(ds, 'x00181151'),
    exposureTime: number(ds, 'x00181150'),
    convolutionKernel: asciiString(ds, 'x00181210'),
    gantryDetectorTilt: number(ds, 'x00181120'),
    frameTime: number(ds, 'x00181063'),
    recommendedDisplayFrameRate: number(ds, 'x00082144'),
    cineRate: number(ds, 'x00180040'),

    rows,
    columns,
    numberOfFrames: hasPixelData ? numberOfFrames : 0,
    bitsAllocated,
    bitsStored: us(ds, 'x00280101'),
    highBit: us(ds, 'x00280102'),
    pixelRepresentation: us(ds, 'x00280103'),
    samplesPerPixel,
    photometricInterpretation: asciiString(ds, 'x00280004'),
    planarConfiguration: us(ds, 'x00280006'),
    hasPixelData,

    geometry,
    perFrame,

    imagerPixelSpacing: vec(ds, 'x00181164', 2) as [number, number] | undefined,
    estimatedRadiographicMagnificationFactor: number(ds, 'x00181114'),
    pixelSpacingCalibrationType: asciiString(ds, 'x00280a02'),
    patientOrientation: po && po.length === 2 ? (po as [string, string]) : undefined,
    rescaleType: asciiString(ds, 'x00281054'),
    petUnits: asciiString(ds, 'x00541001'),
    voiLutFunction: asciiString(ds, 'x00281056'),
    windowExplanation: asciiValues(ds, 'x00281055'),
    presentationLutShape: asciiString(ds, 'x20500020'),
    // US or SS depending on Pixel Representation (PS3.3 C.7.5.1.1.2).
    pixelPaddingValue: us(ds, 'x00280103') === 1 ? ss(ds, 'x00280120') : us(ds, 'x00280120'),
    hasModalityLutSequence: ds.elements.x00283000 ? true : undefined,
    hasVoiLutSequence: ds.elements.x00283010 ? true : undefined,
    overlayGroups: overlayGroups.length > 0 ? overlayGroups : undefined,
    hasUltrasoundRegions: ds.elements.x00186011 ? true : undefined,
    ultrasoundRegions: ultrasoundRegions(ds),
    radiopharmaceutical: radiopharmaceutical(ds),
    decayCorrection: asciiString(ds, 'x00541102'),
    correctedImage: asciiValues(ds, 'x00280051'),
    acquisitionDate: asciiString(ds, 'x00080022'),

    specificCharacterSet: charsetRaw,
    charsetUncertain: false,
  } satisfies InstanceRecord);
  instance.charsetUncertain = ctx.uncertain;
  return { ok: true, instance };
}

const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'UC', 'UR', 'OD', 'OL', 'OV']);

/**
 * Splits a Deflated Explicit VR Little Endian Part 10 file (TS 1.2.840.10008.1.2.1.99) into a rewritten
 * header that declares Explicit VR Little Endian and the raw-deflated dataset that follows it.
 * The caller inflates `deflated` and appends it to `header` to obtain an equivalent non-deflated file.
 * Returns undefined when the file is not deflated or its meta header cannot be rewritten safely.
 */
export function splitDeflatedPart10(bytes: Uint8Array): { header: Uint8Array; deflated: Uint8Array } | undefined {
  if (!hasDicmPrefix(bytes) || bytes.length < 144) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // (0002,0000) UL File Meta Information Group Length is the first meta element.
  if (dv.getUint16(132, true) !== 0x0002 || dv.getUint16(134, true) !== 0x0000) return undefined;
  const groupLength = dv.getUint32(140, true);
  const metaEnd = 144 + groupLength;
  if (metaEnd > bytes.length) return undefined;
  let pos = 144;
  while (pos + 8 <= metaEnd) {
    const group = dv.getUint16(pos, true);
    const element = dv.getUint16(pos + 2, true);
    const vr = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!);
    const long = LONG_VRS.has(vr);
    const len = long ? dv.getUint32(pos + 8, true) : dv.getUint16(pos + 6, true);
    const valueStart = pos + (long ? 12 : 8);
    if (group !== 0x0002 || valueStart + len > metaEnd) return undefined;
    if (element === 0x0010) {
      const ts = String.fromCharCode(...bytes.subarray(valueStart, valueStart + len)).replace(/[\0 ]+$/, '');
      if (ts !== TS.deflated) return undefined;
      const newValue = Uint8Array.from(`${TS.explicitLE}\0`, (c) => c.charCodeAt(0)); // 20 bytes, even length
      const delta = newValue.length - len;
      const header = new Uint8Array(metaEnd + delta);
      header.set(bytes.subarray(0, pos + 6));
      const hv = new DataView(header.buffer);
      hv.setUint16(pos + 6, newValue.length, true);
      header.set(newValue, valueStart);
      header.set(bytes.subarray(valueStart + len, metaEnd), valueStart + newValue.length);
      hv.setUint32(140, groupLength + delta, true);
      return { header, deflated: bytes.subarray(metaEnd) };
    }
    pos = valueStart + len;
  }
  return undefined;
}
