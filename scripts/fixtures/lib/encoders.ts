/**
 * Pixel-data encoders for fixtures. RLE and JPEG Lossless (Process 14, SV1) are implemented here;
 * JPEG baseline, JPEG-LS, JPEG 2000 and HTJ2K use the MIT/ISC-licensed Cornerstone WASM codecs (encoder builds).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// The codec packages do not export their encoder builds, so load them by file path.
const NODE_MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../node_modules');

// ------------------------------------------------------------------------------------------------
// RLE Lossless (PS3.5 Annex G)
// ------------------------------------------------------------------------------------------------

function packBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    // Replicate run
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 2) {
      out.push((257 - run) & 0xff, src[i]!);
      i += run;
      continue;
    }
    // Literal run until the next repeat of ≥ 2 or 128 bytes
    const start = i;
    let len = 0;
    while (i < src.length && len < 128) {
      if (i + 1 < src.length && src[i] === src[i + 1]) break;
      i++;
      len++;
    }
    out.push(len - 1, ...src.subarray(start, start + len));
  }
  if (out.length % 2) out.push(0x80); // no-op padding byte
  return Uint8Array.from(out);
}

/**
 * Encodes one frame. `pixels` is little-endian sample data, interleaved (planar configuration 0) for colour.
 */
export function encodeRle(pixels: Uint8Array, width: number, height: number, bitsAllocated: 8 | 16, samples: 1 | 3): Uint8Array {
  const n = width * height;
  const bytesPerSample = bitsAllocated / 8;
  const segments: Uint8Array[] = [];
  for (let s = 0; s < samples; s++) {
    for (let b = bytesPerSample - 1; b >= 0; b--) {
      const plane = new Uint8Array(n);
      for (let p = 0; p < n; p++) plane[p] = pixels[(p * samples + s) * bytesPerSample + b]!;
      segments.push(packBits(plane));
    }
  }
  const header = new Uint8Array(64);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, segments.length, true);
  let offset = 64;
  segments.forEach((seg, i) => {
    dv.setUint32(4 + i * 4, offset, true);
    offset += seg.length;
  });
  const out = new Uint8Array(offset);
  out.set(header);
  let o = 64;
  for (const seg of segments) {
    out.set(seg, o);
    o += seg.length;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// JPEG Lossless, Non-Hierarchical, First-Order Prediction (Process 14, Selection Value 1)
// ------------------------------------------------------------------------------------------------

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1);
      this.n++;
      if (this.n === 8) this.flushByte();
    }
  }
  private flushByte(): void {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00); // byte stuffing
    this.acc = 0;
    this.n = 0;
  }
  finish(): number[] {
    if (this.n > 0) {
      while (this.n < 8) {
        this.acc = (this.acc << 1) | 1;
        this.n++;
      }
      this.flushByte();
    }
    return this.bytes;
  }
}

/** Grayscale unsigned samples (precision 2–16 bits). Uses a fixed 5-bit Huffman code for SSSS 0–16. */
export function encodeJpegLosslessSV1(samples: ArrayLike<number>, width: number, height: number, precision: number): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number): void => {
    out.push((v >> 8) & 0xff, v & 0xff);
  };
  out.push(0xff, 0xd8); // SOI
  // SOF3
  out.push(0xff, 0xc3);
  u16(11);
  out.push(precision);
  u16(height);
  u16(width);
  out.push(1, 1, 0x11, 0);
  // DHT: class 0 (DC/lossless), id 0, 17 codes of length 5
  out.push(0xff, 0xc4);
  u16(2 + 1 + 16 + 17);
  out.push(0x00);
  for (let l = 1; l <= 16; l++) out.push(l === 5 ? 17 : 0);
  for (let s = 0; s <= 16; s++) out.push(s);
  // SOS: Ns=1, Cs=1, Td/Ta=0, Ss=1 (predictor), Se=0, Ah/Al=0
  out.push(0xff, 0xda);
  u16(8);
  out.push(1, 1, 0x00, 1, 0, 0);

  const bw = new BitWriter();
  const mask = (1 << precision) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = samples[idx]! & mask;
      let pred: number;
      if (x === 0 && y === 0) pred = 1 << (precision - 1);
      else if (y === 0) pred = samples[idx - 1]! & mask;
      else if (x === 0) pred = samples[idx - width]! & mask;
      else pred = samples[idx - 1]! & mask;
      let diff = (v - pred) & 0xffff;
      if (diff >= 32768) diff -= 65536;
      const ssss = diff === 0 ? 0 : diff === 32768 ? 16 : Math.floor(Math.log2(Math.abs(diff))) + 1;
      bw.write(ssss, 5);
      if (ssss > 0 && ssss < 16) {
        const extra = diff > 0 ? diff : diff + (1 << ssss) - 1;
        bw.write(extra & ((1 << ssss) - 1), ssss);
      }
    }
  }
  out.push(...bw.finish());
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------------------------------------
// WASM codecs (Cornerstone codec packages, encoder builds)
// ------------------------------------------------------------------------------------------------

interface FrameInfo {
  width: number;
  height: number;
  bitsPerSample: number;
  componentCount: number;
  isSigned: boolean;
}

interface WasmEncoder {
  getDecodedBuffer(info: FrameInfo): Uint8Array;
  getEncodedBuffer(): Uint8Array;
  encode(): void;
  setQuality?(...args: unknown[]): void;
  setInterleaveMode?(mode: number): void;
  delete?(): void;
}

type CodecModule = Record<string, new () => WasmEncoder>;

const codecCache = new Map<string, Promise<CodecModule>>();
function loadCodec(pkgFile: string): Promise<CodecModule> {
  let p = codecCache.get(pkgFile);
  if (!p) {
    const factory = require(path.join(NODE_MODULES, pkgFile)) as () => Promise<CodecModule>;
    p = factory();
    codecCache.set(pkgFile, p);
  }
  return p;
}

async function wasmEncode(
  pkgFile: string,
  className: string,
  pixels: Uint8Array,
  info: FrameInfo,
  configure?: (e: WasmEncoder) => void,
): Promise<Uint8Array> {
  const mod = await loadCodec(pkgFile);
  const Ctor = mod[className];
  if (!Ctor) throw new Error(`${className} missing in ${pkgFile}`);
  const enc = new Ctor();
  try {
    configure?.(enc);
    const buf = enc.getDecodedBuffer({ isUsingColorTransform: false, ...info } as FrameInfo);
    buf.set(pixels);
    enc.encode();
    return new Uint8Array(enc.getEncodedBuffer()); // copy out of WASM memory
  } finally {
    enc.delete?.();
  }
}

export const encodeJpegLS = (pixels: Uint8Array, info: FrameInfo): Promise<Uint8Array> =>
  wasmEncode('@cornerstonejs/codec-charls/dist/charlswasm.js', 'JpegLSEncoder', pixels, info, (e) =>
    e.setInterleaveMode?.(info.componentCount > 1 ? 2 : 0),
  );

export const encodeJ2K = (pixels: Uint8Array, info: FrameInfo): Promise<Uint8Array> =>
  wasmEncode('@cornerstonejs/codec-openjpeg/dist/openjpegwasm.js', 'J2KEncoder', pixels, info);

export const encodeHTJ2K = (pixels: Uint8Array, info: FrameInfo): Promise<Uint8Array> =>
  wasmEncode('@cornerstonejs/codec-openjph/dist/openjphjs.js', 'HTJ2KEncoder', pixels, info, (e) =>
    e.setQuality?.(true, 0),
  );

export const encodeJpegBaseline = (pixels: Uint8Array, info: FrameInfo): Promise<Uint8Array> =>
  wasmEncode('@cornerstonejs/codec-libjpeg-turbo-8bit/dist/libjpegturbowasm.js', 'JPEGEncoder', pixels, info, (e) =>
    e.setQuality?.(false, 95),
  );
