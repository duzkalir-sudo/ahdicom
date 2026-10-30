/**
 * Cornerstone3D bootstrap: rendering engine, the IPC-backed `cdv:` image loader and the shared tool group.
 * Pixel decoding runs in the dicom-image-loader web workers; file bytes arrive through window.api.readFile.
 */
import {
  Enums,
  RenderingEngine,
  cache,
  getShouldUseCPURendering,
  imageLoader,
  init as csInit,
  metaData,
  type Types,
} from '@cornerstonejs/core';
import {
  PanTool,
  StackScrollTool,
  ToolGroupManager,
  WindowLevelTool,
  ZoomTool,
  addTool,
  annotation as csAnnotation,
  init as toolsInit,
  Enums as ToolEnums,
  type Types as ToolTypes,
} from '@cornerstonejs/tools';
import { init as dicomLoaderInit, wadouri } from '@cornerstonejs/dicom-image-loader';
import { Enums as MetadataEnums, metaData as metadataStore, utilities as metadataUtils } from '@cornerstonejs/metadata';
import { normalizeVoiLutFunction, rleHeaderValid, splitDeflatedPart10, type DisplayImage, type DisplaySet } from '@ahdicom/dicom-core';
import dcmjs from 'dcmjs';
import { applyLutSequences, forgetLuts, registerLuts } from './lut';
import { MEASURE_TOOLS, measureToolConfigs, toolNameOf, type MeasureTool } from './measurements';
import { initAnnotationEvents } from './annotations';

export const RENDERING_ENGINE_ID = 'cdv-engine';
export const TOOL_GROUP_ID = 'cdv-stack-tools';
const SCHEME = 'cdv';
const NATURALIZED = MetadataEnums.MetadataModules.NATURALIZED;

let engine: RenderingEngine | undefined;
let toolGroup: ToolTypes.IToolGroup | undefined;

/** Cornerstone's double-click detection window (DOUBLE_CLICK_TOLERANCE_MS) plus a margin. */
const DOUBLE_CLICK_WINDOW_MS = 450;
/** End of the window in which Cornerstone may still replay a viewport click (a press released in place). */
let heldClickUntil = -Infinity;
let press: { time: number; x: number; y: number } | undefined;
let pendingToolSwitch: ReturnType<typeof setTimeout> | undefined;
window.addEventListener(
  'mousedown',
  (e) => {
    press =
      e.target instanceof Element && e.target.closest('.vp-element') ? { time: performance.now(), x: e.clientX, y: e.clientY } : undefined;
  },
  true,
);
window.addEventListener(
  'mouseup',
  (e) => {
    // Only a click (release within Cornerstone's 3 px drag tolerance) is held; a drag is handled immediately.
    if (press && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) <= 3) heldClickUntil = press.time + DOUBLE_CLICK_WINDOW_MS;
    press = undefined;
  },
  true,
);

export type NavigationTool = 'windowLevel' | 'pan' | 'zoom' | 'scroll';
export type LeftTool = NavigationTool | MeasureTool;

const NAV_TOOL_NAMES: Record<NavigationTool, string> = {
  windowLevel: WindowLevelTool.toolName,
  pan: PanTool.toolName,
  zoom: ZoomTool.toolName,
  scroll: StackScrollTool.toolName,
};

export function isMeasureTool(t: LeftTool): t is MeasureTool {
  return (MEASURE_TOOLS as readonly string[]).includes(t);
}

export function imageIdFor(img: DisplayImage): string {
  return img.frame ? `${SCHEME}:${img.fileId}?frame=${img.frame}` : `${SCHEME}:${img.fileId}`;
}

export function imageIdsFor(ds: DisplaySet): string[] {
  return ds.images.map(imageIdFor);
}

export function baseImageId(imageId: string): string {
  return imageId.replace(/[?&]frame=\d+$/, '');
}

export function fileIdOf(imageId: string): string {
  return baseImageId(imageId).slice(SCHEME.length + 1);
}

export function frameOf(imageId: string): number {
  const m = /[?&]frame=(\d+)$/.exec(imageId);
  return m ? Number(m[1]) : 1;
}

// ---------------------------------------------------------------------------------------------
// Image loader
// ---------------------------------------------------------------------------------------------

const inflight = new Map<string, Promise<void>>();
/** Bytes held in the NATURALIZED metadata cache, per base image id (not counted by Cornerstone's cache). */
const naturalizedBytes = new Map<string, number>();

/** Largest inflated dataset accepted from a deflated file (guards against decompression bombs). */
const MAX_INFLATED_BYTES = 1024 * 1024 * 1024;

/**
 * Cornerstone's naturalized reader cannot parse Deflated Explicit VR LE datasets, so they are inflated first
 * (DecompressionStream) into an equivalent Explicit VR LE file.
 */
async function inflateIfDeflated(bytes: Uint8Array): Promise<Uint8Array> {
  const parts = splitDeflatedPart10(bytes);
  if (!parts) return bytes;
  const stream = new Blob([parts.deflated.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel();
      throw new Error('inflated dataset too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(parts.header.length + total);
  out.set(parts.header);
  let o = parts.header.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function ensureNaturalized(base: string): Promise<void> {
  if (metaData.get(NATURALIZED, base)) return;
  let p = inflight.get(base);
  if (!p) {
    p = (async () => {
      const bytes = await inflateIfDeflated(await window.api.readFile(fileIdOf(base)));
      registerLuts(base, bytes);
      await metadataUtils.addDicomPart10Instance(base, bytes);
      naturalizedBytes.set(base, bytes.byteLength);
    })();
    inflight.set(base, p);
    p.finally(() => inflight.delete(base)).catch(() => undefined);
  }
  await p;
}

/**
 * Some WASM decoders report a corrupt stream only on the console and still resolve with an empty buffer.
 * Treat a pixel buffer that does not cover rows × columns × samples as a decode failure.
 */
function assertDecoded(image: Types.IImage): void {
  const pd = image.getPixelData() as ArrayLike<number> | undefined;
  const samples = image.color ? 3 : 1;
  const expected = image.rows * image.columns * samples;
  if (!pd || !(image.rows > 0) || !(image.columns > 0) || pd.length < expected) {
    throw new Error('decoded pixel data is incomplete');
  }
}

const RLE_TS = '1.2.840.10008.1.2.5';

/** Rejects RLE frames whose segment table is inconsistent (the JS decoder would silently return zeros). */
function validateRle(imageId: string, natural: { SamplesPerPixel?: number; BitsAllocated?: number }): void {
  const frameIndex = Math.max(0, frameOf(imageId) - 1);
  const frame = metaData.getTyped(MetadataEnums.MetadataModules.COMPRESSED_FRAME_DATA, imageId, { frameIndex }) as
    { pixelData?: ArrayBuffer | Uint8Array | (ArrayBuffer | Uint8Array)[] } | undefined;
  const raw = frame?.pixelData;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) return;
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first);
  const segments = (natural.SamplesPerPixel ?? 1) * Math.ceil((natural.BitsAllocated ?? 8) / 8);
  if (!rleHeaderValid(bytes, segments)) throw new Error('invalid RLE segment table');
}

/**
 * A pixel-data decode failure. The viewport shows it as "Image could not be decoded"; Cornerstone's internal cache
 * chain re-throws it without a handler, so the global handler in installDecodeErrorHandler() marks it as handled.
 */
export class ImageDecodeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : `decoder error ${String(cause)}`);
    this.name = 'ImageDecodeError';
  }
}

/** Marks rejected image loads (already shown in the viewport) as handled; everything else still surfaces. */
export function installDecodeErrorHandler(): void {
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    const decode =
      r instanceof ImageDecodeError || (r instanceof Object && 'error' in r && (r as { error: unknown }).error instanceof ImageDecodeError);
    if (decode) {
      e.preventDefault();
      console.warn(
        `Image decode failed (shown in the viewport): ${(r instanceof ImageDecodeError ? r : (r as { error: ImageDecodeError }).error).message}`,
      );
    }
  });
}

function cdvLoader(imageId: string, options?: Record<string, unknown>): Types.IImageLoadObject {
  const promise = (async () => {
    try {
      return await loadCdvImage(imageId, options);
    } catch (e) {
      throw new ImageDecodeError(e);
    }
  })();
  return { promise } as Types.IImageLoadObject;
}

async function loadCdvImage(imageId: string, options?: Record<string, unknown>): Promise<Types.IImage> {
  {
    const base = baseImageId(imageId);
    await ensureNaturalized(base);
    const natural = metaData.get(NATURALIZED, base) as
      | {
          VOILUTFunction?: string;
          TransferSyntaxUID?: string;
          SamplesPerPixel?: number;
          BitsAllocated?: number;
        }
      | undefined;
    if (natural?.TransferSyntaxUID === RLE_TS) validateRle(imageId, natural);
    const image = (await wadouri.loadImageFromNaturalizedMetadata(imageId, options ?? {}).promise) as Types.IImage;
    assertDecoded(image);
    // Cornerstone 5.14 createImage indexes the VOI LUT Function string ("SIGMOID" → "S"); restore the real value.
    image.voiLUTFunction = normalizeVoiLutFunction(natural?.VOILUTFunction) as Enums.VOILUTFunctionType;
    return applyLutSequences(image, imageId);
  }
}

/** Loads an image's metadata (not its pixels) so its geometry is known, e.g. to restore saved measurements. */
export async function loadImageMetadata(imageId: string): Promise<void> {
  await ensureNaturalized(baseImageId(imageId));
}

/** Releases decoded images and raw bytes of a display set that is no longer shown. */
export function purgeImages(imageIds: readonly string[]): void {
  const bases = new Set<string>();
  for (const id of imageIds) {
    bases.add(baseImageId(id));
    if (cache.getImageLoadObject(id)) cache.removeImageLoadObject(id, { force: true });
  }
  for (const b of bases) {
    if (naturalizedBytes.has(b)) {
      metadataStore.clearQuery(NATURALIZED, b);
      naturalizedBytes.delete(b);
      forgetLuts(b);
    }
  }
}

/** Releases every decoded image and all raw file bytes (used by "close all"). */
export function purgeAll(): void {
  cache.purgeCache();
  for (const b of [...naturalizedBytes.keys()]) {
    metadataStore.clearQuery(NATURALIZED, b);
    forgetLuts(b);
  }
  naturalizedBytes.clear();
}

export function naturalizedCacheBytes(): number {
  let s = 0;
  for (const v of naturalizedBytes.values()) s += v;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------------------------

export function initCornerstone(cacheSizeMB: number): void {
  if (engine) return;
  installDecodeErrorHandler();
  routeSvgTextStyleThroughCssom();
  // dcmjs reports "Invalid vr type ox/xs" for every valid Implicit VR file whose dictionary VR is ambiguous
  // (OB/OW, US/SS) at error level. These are parser diagnostics, not failures; keep them out of the console.
  dcmjs.log.getLogger('validation.dcmjs').setLevel('silent');
  csInit({
    rendering: {
      renderingEngineMode: Enums.RenderingEngineModeEnum.ContextPool,
      webGlContextCount: 7,
    },
    debug: {},
  } as Parameters<typeof csInit>[0]);
  dicomLoaderInit({
    maxWebWorkers: Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
  });
  toolsInit();
  imageLoader.registerImageLoader(SCHEME, cdvLoader as unknown as Types.ImageLoaderFn);
  cache.setMaxCacheSize(cacheSizeMB * 1024 * 1024);

  for (const T of [WindowLevelTool, PanTool, ZoomTool, StackScrollTool]) addTool(T);
  toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  if (!toolGroup) throw new Error('tool group');
  toolGroup.addTool(WindowLevelTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName, { loop: false });
  for (const m of measureToolConfigs()) {
    addTool(m.cls as Parameters<typeof addTool>[0]);
    toolGroup.addTool(m.name, m.config);
    // Cornerstone binds plain "z"/"y" keys to its own undo/redo; the app has its own history (Ctrl+Z / Ctrl+Y).
    const actions = (toolGroup.getToolInstance(m.name) as { configuration?: { actions?: Record<string, unknown> } }).configuration?.actions;
    if (actions) {
      delete actions.undo;
      delete actions.redo;
    }
  }
  applyLeftTool('windowLevel');
  initAnnotationEvents();
  // Measurement text on a dark translucent box stays readable over bright structures (bone, contrast).
  csAnnotation.config.style.setDefaultToolStyles({
    global: { ...csAnnotation.config.style.getDefaultToolStyles()?.global, textBoxBackground: 'rgba(0, 0, 0, 0.75)' },
  });
  engine = new RenderingEngine(RENDERING_ENGINE_ID);
}

/**
 * Cornerstone's text boxes set an inline `style` attribute on SVG <text>, which the strict CSP (style-src 'self')
 * blocks and reports as an error. Setting the same declarations through CSSOM is allowed by CSP, so the `style`
 * attribute of SVG text elements is routed to `style.cssText` (D-044).
 */
function routeSvgTextStyleThroughCssom(): void {
  const proto = SVGTextElement.prototype;
  const original = proto.setAttribute;
  proto.setAttribute = function setAttribute(this: SVGTextElement, name: string, value: string): void {
    if (name.toLowerCase() === 'style') {
      this.style.cssText = value;
      return;
    }
    original.call(this, name, value);
  };
}

export function setCacheSize(cacheSizeMB: number): void {
  cache.setMaxCacheSize(cacheSizeMB * 1024 * 1024);
}

/**
 * Default mouse bindings: left = selected tool, right = zoom, middle = pan, wheel = scroll.
 * Measurement tools that are not selected stay passive, so their annotations remain visible and editable.
 */
export function setLeftTool(tool: LeftTool): void {
  // Cornerstone holds a viewport click for up to 400 ms to detect a double-click and then replays it to the tool that
  // is active at that moment. A tool switched within that window (click, then a shortcut key) would receive the old
  // click and start a phantom measurement, so the switch takes effect once the held click has been handled.
  clearTimeout(pendingToolSwitch);
  const wait = heldClickUntil - performance.now();
  if (wait > 0) {
    pendingToolSwitch = setTimeout(() => applyLeftTool(tool), wait);
    return;
  }
  applyLeftTool(tool);
}

function applyLeftTool(tool: LeftTool): void {
  if (!toolGroup) return;
  const { MouseBindings } = ToolEnums;
  const bindings: Record<string, ToolTypes.IToolBinding[]> = {
    [WindowLevelTool.toolName]: [],
    [PanTool.toolName]: [{ mouseButton: MouseBindings.Auxiliary }],
    [ZoomTool.toolName]: [{ mouseButton: MouseBindings.Secondary }],
    [StackScrollTool.toolName]: [{ mouseButton: MouseBindings.Wheel }],
  };
  for (const m of MEASURE_TOOLS) bindings[toolNameOf(m)] = [];
  bindings[isMeasureTool(tool) ? toolNameOf(tool) : NAV_TOOL_NAMES[tool]]!.push({ mouseButton: MouseBindings.Primary });
  // setToolActive with an empty list does not remove an existing binding: clear all bindings first.
  for (const name of Object.keys(bindings)) toolGroup.setToolPassive(name, { removeAllBindings: true });
  for (const [name, b] of Object.entries(bindings)) if (b.length > 0) toolGroup.setToolActive(name, { bindings: b });
}

export function getEngine(): RenderingEngine {
  if (!engine) throw new Error('Cornerstone not initialized');
  return engine;
}

export function getToolGroup(): ToolTypes.IToolGroup {
  if (!toolGroup) throw new Error('Cornerstone not initialized');
  return toolGroup;
}

export function usesCpuRendering(): boolean {
  return getShouldUseCPURendering();
}

export function cacheUsage(): { used: number; max: number } {
  return {
    used: cache.getCacheSize() + naturalizedCacheBytes(),
    max: cache.getMaxCacheSize(),
  };
}
