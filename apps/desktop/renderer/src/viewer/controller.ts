/**
 * One viewport: wraps a Cornerstone viewport and derives everything the overlay shows. It shows its display set as
 * the original image stack, as a reformat through the volume (axial / coronal / sagittal, MPR) or in 3D (D-059).
 * Clinical math (labels, spacing basis, VOI formulas, pixel mapping, reformat planes) comes from @ahdicom/dicom-core.
 */
import { Enums, cache, eventTarget, imageLoader, metaData, utilities as csUtils, type Types } from '@cornerstonejs/core';
import { utilities as toolUtils } from '@cornerstonejs/tools';
import {
  type ClipBox,
  type DisplaySet,
  type EdgeLabels,
  type ImagePlane,
  type MprRefusal,
  type ReformatStack,
  type SlabMode,
  type SpacingBasis,
  type StackWarning,
  type Vec3,
  type VolumeGeometry,
  type VoiLutFunction,
  type VoiRange,
  type WindowLevel,
  lutDomain,
  lutToNormalizedCurve,
  normalizeVoiLutFunction,
  parseImageOrientation,
  patientImageAxes,
  patientToPixel,
  STANDARD_VIEWS,
  mprCheck,
  nearestVoxel,
  planePixel,
  planePoint,
  rangeToWindow,
  reformatIndex,
  reformatStack,
  rotateAbout,
  sliceLocation,
  slabOffsets,
  slabProject,
  spacingBasis,
  vec3,
  viewLabels,
  volumeGeometry,
  windowToRange,
} from '@ahdicom/dicom-core';
import {
  RENDERING_ENGINE_ID,
  TOOL_GROUP_ID,
  VolumeLoadError,
  frameOf,
  fileIdOf,
  getEngine,
  getToolGroup,
  imageIdsFor,
  loadVolume,
  type ToolGroupKind,
} from './cornerstone';
import { lutsFor, modalityLutApplied } from './lut';
import { cancelDrawingOn, isDrawing } from './annotations';
import { definingPoints } from './measureDoc';
import { measureToolOf, type ReformatRef } from './measurements';
import { VolumeRendering, type CutMode, type VrPreset, type VrState } from './volume3d';
import { type ViewKind, useStore } from '../state/store';
import { planesOf } from './sync';

export type ViewStatus = 'empty' | 'loading' | 'ready' | 'error' | 'nonImage';

export interface ProbeValue {
  column: number;
  row: number;
  /** Modality value (or RGB triple for colour) — undefined when outside the image. */
  value?: number | [number, number, number];
  unit: ProbeUnit;
  padding?: boolean;
}

/** Why a display set cannot be shown as a volume (geometry, memory or decoding). */
export type VolumeRefusal = MprRefusal | 'tooLarge' | 'decodeFailed';

export interface ViewState {
  status: ViewStatus;
  view: ViewKind;
  /** Loading progress of a volume (0..1). */
  progress?: number;
  /** Set with status 'error' when the display set cannot be shown in a volume view. */
  refusal?: VolumeRefusal;
  /** Reformat details: slice position, spacing between reformatted slices, volume geometry warnings. */
  reformat?: { location?: { mm: number; towards: string }; spacing: number; warnings: StackWarning[] };
  /** Thick-slab projection of a reformat. */
  slab?: { mode: SlabMode; thickness: number };
  /** 3D view: preset, transfer-function shift/opacity and clipping box. */
  vr?: VrState;
  displaySetId?: string;
  index: number;
  total: number;
  imageId?: string;
  voi?: VoiRange;
  wl?: WindowLevel;
  voiFn: VoiLutFunction;
  voiLutName?: string;
  /** Device pixels per image pixel × 100 (100 % = 1:1). */
  zoomPercent?: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  inverted: boolean;
  labels?: EdgeLabels;
  basis: SpacingBasis;
  /** Millimetres per CSS pixel along the screen x axis (undefined when uncalibrated). */
  mmPerCssPx?: number;
  probe?: ProbeValue;
  /** Measurement under the cursor and where its delete button goes (canvas CSS pixels). */
  hover?: { uid: string; x: number; y: number };
  cine: boolean;
  fps: number;
}

const EMPTY: ViewState = {
  status: 'empty',
  view: 'stack',
  progress: undefined,
  refusal: undefined,
  reformat: undefined,
  slab: undefined,
  vr: undefined,
  displaySetId: undefined,
  imageId: undefined,
  voi: undefined,
  wl: undefined,
  voiLutName: undefined,
  zoomPercent: undefined,
  labels: undefined,
  mmPerCssPx: undefined,
  probe: undefined,
  hover: undefined,
  index: 0,
  total: 0,
  voiFn: 'LINEAR',
  rotation: 0,
  flipH: false,
  flipV: false,
  inverted: false,
  basis: { kind: 'none' },
  cine: false,
  fps: 15,
};

const VOI_LUT_COLORMAP_PREFIX = 'cdv-voilut-';
const OVERLAY_COLOR: [number, number, number] = [255, 214, 64];

type Listener = (s: ViewState) => void;

interface OverlayBitmap {
  bitmap: ImageBitmap;
  rows: number;
  columns: number;
  origin: [number, number];
}

export class ViewportController {
  readonly viewportId: string;
  private ds?: DisplaySet;
  private imageIds: string[] = [];
  private state: ViewState = { ...EMPTY };
  private readonly listeners = new Set<Listener>();
  private initialInvert = false;
  private pendingUpdate = false;
  private lastPointer?: { x: number; y: number };
  private readonly overlayCache = new Map<string, Promise<OverlayBitmap[]>>();
  private showOverlays = true;
  private loadToken = 0;
  private disposed = false;
  private kind: ViewKind = 'stack';
  /** Volume views: the volume grid and the stack of reformatted planes for the current camera. */
  private vol?: { volumeId: string; geometry: VolumeGeometry; warnings: StackWarning[]; stack?: ReformatStack };
  private vr?: VolumeRendering;

  constructor(
    readonly index: number,
    private readonly element: HTMLDivElement,
    private readonly overlayCanvas: HTMLCanvasElement,
    private readonly guideCanvas?: HTMLCanvasElement,
  ) {
    this.viewportId = `vp-${index}`;
    this.enable('stack');
    for (const ev of [Enums.Events.STACK_NEW_IMAGE, Enums.Events.VOI_MODIFIED, Enums.Events.CAMERA_MODIFIED, Enums.Events.IMAGE_RENDERED]) {
      element.addEventListener(ev, this.onViewportEvent);
    }
    eventTarget.addEventListener(Enums.Events.IMAGE_LOAD_FAILED, this.onLoadFailed);
    eventTarget.addEventListener(Enums.Events.IMAGE_LOAD_ERROR, this.onLoadFailed);
    element.addEventListener(Enums.Events.IMAGE_LOAD_ERROR, this.onLoadFailed);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerleave', this.onPointerLeave);
    element.addEventListener('pointerdown', this.onScalpelDown, true);
    element.addEventListener('pointermove', this.onScalpelMove, true);
    element.addEventListener('pointerup', this.onScalpelUp, true);
  }

  /** The Cornerstone viewport. Typed as a stack viewport; stack-only methods are used only in the stack view. */
  get viewport(): Types.IStackViewport {
    return getEngine().getViewport(this.viewportId) as Types.IStackViewport;
  }

  private get volumeViewport(): Types.IVolumeViewport {
    return getEngine().getViewport(this.viewportId) as Types.IVolumeViewport;
  }

  get view(): ViewKind {
    return this.kind;
  }

  private enable(kind: ViewKind): void {
    getEngine().enableElement({
      viewportId: this.viewportId,
      type: viewportType(kind),
      element: this.element,
      defaultOptions: { background: [0, 0, 0] },
    });
    getToolGroup(toolGroupKind(kind)).addViewport(this.viewportId, RENDERING_ENGINE_ID);
  }

  /** Changes the Cornerstone viewport type when the view needs another one (stack, orthographic, 3D). */
  private switchKind(kind: ViewKind): void {
    if (viewportType(kind) !== viewportType(this.kind)) {
      try {
        toolUtils.stackPrefetch.disable(this.element);
      } catch {
        // prefetch was not enabled
      }
      getToolGroup(toolGroupKind(this.kind)).removeViewports(RENDERING_ENGINE_ID, this.viewportId);
      getEngine().disableElement(this.viewportId);
      this.enable(kind);
    }
    this.kind = kind;
  }

  get displaySet(): DisplaySet | undefined {
    return this.ds;
  }

  getState(): ViewState {
    return this.state;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.state);
    return () => this.listeners.delete(l);
  }

  private emit(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  // ------------------------------------------------------------------------------------------
  // Display set
  // ------------------------------------------------------------------------------------------

  async setDisplaySet(ds: DisplaySet | undefined, view: ViewKind = 'stack'): Promise<void> {
    if (!ds) view = 'stack';
    const ids = ds ? imageIdsFor(ds) : [];
    if (ds && this.ds?.id === ds.id && view === this.kind && view !== 'stack') {
      // A volume is built once; images arriving later do not change it.
      this.ds = ds;
      return;
    }
    if (ds && this.ds?.id === ds.id && view === this.kind) {
      if (ids.join('|') === this.imageIds.join('|')) return;
      // Same series, more images arrived (or re-sorted): keep the current image.
      const current = this.imageIds[this.viewport.getCurrentImageIdIndex()];
      this.ds = ds;
      this.imageIds = ids;
      const idx = Math.max(0, current ? ids.indexOf(current) : 0);
      await this.viewport.setStack(ids, idx).catch(() => undefined);
      this.update();
      return;
    }
    this.stopCine();
    // A VOI LUT transfer function of the previous series must not carry over.
    if (this.state.voiLutName) this.clearVoiLut();
    const token = ++this.loadToken;
    this.switchKind(view);
    this.ds = ds;
    this.imageIds = view === 'stack' ? ids : [];
    this.vol = undefined;
    this.vr?.release();
    this.vr = undefined;
    this.lasso = undefined;
    this.overlayCache.clear();
    if (!ds) {
      this.emit({ ...EMPTY });
      this.clearOverlayCanvas();
      return;
    }
    if (ds.kind === 'nonImage' || ids.length === 0) {
      this.emit({ ...EMPTY, status: 'nonImage', displaySetId: ds.id });
      this.clearOverlayCanvas();
      return;
    }
    if (view !== 'stack') {
      await this.loadVolumeView(ds, view, token);
      return;
    }
    this.emit({
      ...EMPTY,
      status: 'loading',
      displaySetId: ds.id,
      total: ids.length,
      basis: spacingBasis(ds.firstInstance),
      fps: defaultFps(ds),
    });
    try {
      // Load the first image explicitly: setStack resolves even when decoding fails.
      await imageLoader.loadAndCacheImage(ids[0]!);
      if (token !== this.loadToken || this.disposed) return;
      await this.viewport.setStack(ids, 0);
      if (token !== this.loadToken || this.disposed) return;
      this.applyInitialDisplay();
      toolUtils.stackPrefetch.enable(this.element);
      this.viewport.render();
      this.emit({ status: 'ready' });
      this.update();
    } catch {
      if (token === this.loadToken) this.emit({ status: 'error' });
    }
  }

  /** Builds the volume of a display set and shows it as a reformat or in 3D. */
  private async loadVolumeView(ds: DisplaySet, view: ViewKind, token: number): Promise<void> {
    const base: ViewState = { ...EMPTY, view, displaySetId: ds.id };
    this.clearOverlayCanvas();
    const check = mprCheck(ds);
    const geometry = check.ok ? volumeGeometry(ds) : undefined;
    if (!geometry) {
      this.emit({ ...base, status: 'error', refusal: check.refusal ?? 'missingGeometry' });
      return;
    }
    const px = Math.min(geometry.spacing[0], geometry.spacing[1], geometry.spacing[2]);
    this.emit({ ...base, status: 'loading', progress: 0, basis: { kind: 'pixelSpacing', rowMm: px, columnMm: px } });
    const stale = (): boolean => token !== this.loadToken || this.disposed;
    try {
      const volume = await loadVolume(
        ds,
        (f) => {
          if (!stale() && Math.round(f * 100) !== Math.round((this.state.progress ?? 0) * 100)) this.emit({ progress: f });
        },
        stale,
      );
      if (stale()) return;
      this.vol = { volumeId: volume.volumeId, geometry, warnings: check.warnings };
      await this.volumeViewport.setVolumes([{ volumeId: volume.volumeId }]);
      if (stale()) return;
      if (view === '3d') this.apply3dDefaults();
      else this.applyStandardView(view);
      this.viewport.render();
      this.emit({ status: 'ready', progress: undefined });
      this.update();
    } catch (e) {
      if (stale()) return;
      this.emit({ status: 'error', progress: undefined, refusal: e instanceof VolumeLoadError ? e.reason : 'decodeFailed' });
    }
  }

  /** Axial / coronal / sagittal camera through the middle of the volume. */
  private applyStandardView(view: ViewKind): void {
    const vol = this.vol;
    if (!vol || view === 'stack' || view === '3d') return;
    const { normal, viewUp } = STANDARD_VIEWS[view];
    this.volumeViewport.setOrientation({ viewPlaneNormal: [...normal], viewUp: [...viewUp] } as Types.OrientationVectors);
    vol.stack = reformatStack(vol.geometry, normal, viewUp);
    const n = vol.stack?.planes.length ?? 0;
    if (n > 0) this.moveToSlice(Math.floor((n - 1) / 2));
  }

  private apply3dDefaults(): void {
    const vp = this.volumeViewport;
    if (!this.vol) return;
    this.vr ??= new VolumeRendering(() => this.volumeViewport, this.vol.volumeId, this.vol.geometry, this.ds?.modality);
    const vr = this.vr;
    // Seen from the front, head up, with a parallel projection (the scalpel projects voxels along straight rays).
    vp.setCamera({ viewPlaneNormal: [0, -1, 0], viewUp: [0, 0, 1], parallelProjection: true });
    vp.resetCamera();
    void vr.reset().then(() => {
      if (this.vr === vr) this.emit({ vr: vr.state });
    });
    this.emit({ vr: vr.state });
  }

  /** 3D view: arms the scalpel; the next outline drawn on the view cuts (undefined disarms). */
  armScalpel(mode: CutMode | undefined): void {
    if (this.kind !== '3d' || !this.vr) return;
    this.vr.armScalpel(mode);
    this.emit({ vr: this.vr.state });
  }

  /** 3D view: undoes the last scalpel cut. */
  undoCut(): void {
    if (this.kind !== '3d' || !this.vr) return;
    this.vr.undoCut();
    this.emit({ vr: this.vr.state });
  }

  /** Outline being drawn with the scalpel (canvas CSS pixels). */
  private lasso?: [number, number][];

  private readonly onScalpelDown = (e: PointerEvent): void => {
    if (this.kind !== '3d' || !this.vr?.state.scalpel || e.button !== 0) return;
    // The outline replaces rotation for this press.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.element.setPointerCapture(e.pointerId);
    const r = this.element.getBoundingClientRect();
    this.lasso = [[e.clientX - r.left, e.clientY - r.top]];
  };

  private readonly onScalpelMove = (e: PointerEvent): void => {
    if (!this.lasso) return;
    e.stopImmediatePropagation();
    const r = this.element.getBoundingClientRect();
    this.lasso.push([e.clientX - r.left, e.clientY - r.top]);
    this.drawLasso();
  };

  private readonly onScalpelUp = (e: PointerEvent): void => {
    const outline = this.lasso;
    const vr = this.vr;
    if (!outline || !vr) return;
    e.stopImmediatePropagation();
    this.lasso = undefined;
    if (this.element.hasPointerCapture(e.pointerId)) this.element.releasePointerCapture(e.pointerId);
    this.drawGuides();
    const mode = vr.state.scalpel;
    if (!mode || outline.length < 3) return;
    void vr.cut(outline, mode, this.element.clientWidth, this.element.clientHeight).then((ok) => {
      if (this.vr !== vr) return;
      if (!ok) vr.armScalpel(undefined);
      this.emit({ vr: vr.state });
    });
  };

  private drawLasso(): void {
    const canvas = this.guideCanvas;
    const ctx = canvas?.getContext('2d');
    const pts = this.lasso;
    if (!canvas || !ctx || !pts || pts.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = SCALPEL_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** 3D view: rendering preset. */
  setVolumePreset(preset: VrPreset): void {
    if (this.kind !== '3d' || !this.vr) return;
    this.vr.setPreset(preset);
    this.emit({ vr: this.vr.state });
  }

  /** 3D view: shift the transfer functions along the value axis and scale their opacity. */
  setVolumeCurves(patch: { shift?: number; opacity?: number }): void {
    if (this.kind !== '3d' || !this.vr) return;
    this.vr.set(patch);
    this.emit({ vr: this.vr.state });
  }

  /** 3D view: clipping box (fractions of the volume grid), undefined removes it. */
  setClipBox(box: ClipBox | undefined): void {
    if (this.kind !== '3d' || !this.vr) return;
    this.vr.setClip(box);
    this.emit({ vr: this.vr.state });
  }

  /** Moves the reformat camera along its normal onto plane k (keeping zoom and pan). */
  private moveToSlice(k: number): void {
    const stack = this.vol?.stack;
    if (!stack) return;
    const vp = this.viewport;
    const cam = vp.getCamera();
    if (!cam.focalPoint || !cam.position) return;
    const i = Math.min(stack.planes.length - 1, Math.max(0, k));
    const d = stack.start + i * stack.spacing - vec3.dot(cam.focalPoint as unknown as Vec3, stack.normal);
    const shift = vec3.scale(stack.normal, d);
    vp.setCamera({
      focalPoint: vec3.add(cam.focalPoint as unknown as Vec3, shift) as unknown as Types.Point3,
      position: vec3.add(cam.position as unknown as Vec3, shift) as unknown as Types.Point3,
    });
    vp.render();
  }

  private isReformat(): boolean {
    return this.kind !== 'stack' && this.kind !== '3d' && this.hasImage();
  }

  /**
   * Thick slab of a reformat: maximum, minimum or average intensity over `thickness` mm centred on the slice;
   * undefined returns to the single slice.
   */
  setSlab(mode: SlabMode | undefined, thickness = 10): void {
    if (!this.isReformat()) return;
    const vp = this.volumeViewport;
    const { BlendModes } = Enums;
    const blend =
      mode === 'mip'
        ? BlendModes.MAXIMUM_INTENSITY_BLEND
        : mode === 'minip'
          ? BlendModes.MINIMUM_INTENSITY_BLEND
          : mode === 'avg'
            ? BlendModes.AVERAGE_INTENSITY_BLEND
            : BlendModes.COMPOSITE;
    vp.setBlendMode(blend);
    if (mode) vp.setSlabThickness(thickness);
    else vp.resetSlabThickness();
    vp.render();
    this.emit({ slab: mode ? { mode, thickness } : undefined });
  }

  /** Moves a reformat onto the slice nearest to a patient point. */
  moveThrough(point: Vec3): void {
    const stack = this.vol?.stack;
    if (this.isReformat() && stack) this.moveToSlice(reformatIndex(stack, point));
  }

  /** Turns a reformat rigidly about an axis through a patient point (oblique MPR); zoom and pan are kept. */
  rotateView(axis: Vec3, angle: number, center: Vec3): void {
    if (!this.isReformat() || angle === 0) return;
    const vp = this.viewport;
    const cam = vp.getCamera();
    if (!cam.focalPoint || !cam.position || !cam.viewUp || !cam.viewPlaneNormal) return;
    const turn = (p: Vec3): Vec3 => vec3.add(center, rotateAbout(vec3.sub(p, center), axis, angle));
    vp.setCamera({
      focalPoint: turn(cam.focalPoint as unknown as Vec3) as unknown as Types.Point3,
      position: turn(cam.position as unknown as Vec3) as unknown as Types.Point3,
      viewUp: rotateAbout(cam.viewUp as unknown as Vec3, axis, angle) as unknown as Types.Point3,
      viewPlaneNormal: rotateAbout(cam.viewPlaneNormal as unknown as Vec3, axis, angle) as unknown as Types.Point3,
    });
    vp.render();
  }

  /** The reformat shown now, for measurements drawn on it (undefined for original images and 3D). */
  reformatRef(): ReformatRef | undefined {
    const plane = this.currentPlane();
    const vol = this.vol;
    if (!this.isReformat() || !plane || !vol?.stack || !this.ds) return undefined;
    const slab = this.state.slab;
    return {
      ds: this.ds,
      plane,
      geometry: vol.geometry,
      volumeId: vol.volumeId,
      spacing: vol.stack.spacing,
      ...(slab ? { slab } : {}),
      approximate: vol.warnings.length > 0,
    };
  }

  /** Patient point under a canvas point (on the displayed slice). */
  canvasToPatient(x: number, y: number): Vec3 | undefined {
    if (!this.hasImage()) return undefined;
    return this.viewport.canvasToWorld([x, y]) as unknown as Vec3;
  }

  /** Canvas point of a patient point. */
  patientToCanvas(p: Vec3): [number, number] | undefined {
    if (!this.hasImage()) return undefined;
    const c = this.viewport.worldToCanvas(p as unknown as Types.Point3);
    return [c[0], c[1]];
  }

  /** Plane of the image shown now (original or reformatted); undefined in 3D or before the image is ready. */
  currentPlane(): ImagePlane | undefined {
    if (this.state.status !== 'ready' || !this.ds) return undefined;
    if (this.kind === 'stack') return planesOf(this.ds)[this.state.index];
    return this.kind === '3d' ? undefined : this.vol?.stack?.planes[this.state.index];
  }

  /** Planes of all images this viewport can scroll through, with their indices (images without geometry left out). */
  slicePlanes(): { planes: ImagePlane[]; indices: number[] } {
    if (this.kind === 'stack') {
      const planes: ImagePlane[] = [];
      const indices: number[] = [];
      if (this.ds)
        planesOf(this.ds).forEach((p, k) => {
          if (p) {
            planes.push(p);
            indices.push(k);
          }
        });
      return { planes, indices };
    }
    const planes = this.kind === '3d' ? [] : (this.vol?.stack?.planes ?? []);
    return { planes, indices: planes.map((_, k) => k) };
  }

  /** VOI LUT Sequence (when no window is stored) and Presentation LUT Shape INVERSE. */
  private applyInitialDisplay(): void {
    const ds = this.ds;
    if (!ds) return;
    const vp = this.viewport;
    const imageId = this.imageIds[vp.getCurrentImageIdIndex()];
    const hasWindow = (ds.firstInstance.geometry.windowWidth?.length ?? 0) > 0 || (ds.images[0]?.geometry.windowWidth?.length ?? 0) > 0;
    const voiLut = imageId ? lutsFor(imageId)?.voi[0] : undefined;
    if (voiLut && !hasWindow) this.applyVoiLut(0);
    // Cornerstone's metadata path does not carry VOI LUT Function (0028,1056): apply it here.
    const fn = normalizeVoiLutFunction(ds.firstInstance.voiLutFunction);
    if (fn !== 'LINEAR' && hasWindow) {
      vp.setProperties({ VOILUTFunction: fn as Enums.VOILUTFunctionType });
      const g = ds.images[0]?.geometry ?? ds.firstInstance.geometry;
      const center = g.windowCenter?.[0] ?? ds.firstInstance.geometry.windowCenter?.[0];
      const width = g.windowWidth?.[0] ?? ds.firstInstance.geometry.windowWidth?.[0];
      if (center !== undefined && width !== undefined) {
        vp.setProperties({ voiRange: windowToRange({ center, width }, fn === 'LINEAR_EXACT' ? 'LINEAR_EXACT' : 'LINEAR') });
      }
    }
    if (ds.firstInstance.presentationLutShape?.toUpperCase() === 'INVERSE') {
      vp.setProperties({ invert: !vp.getProperties().invert });
    }
    this.initialInvert = Boolean(vp.getProperties().invert);
  }

  /** Applies VOI LUT n of the current image as a 256-point piecewise-linear transfer function over its input domain. */
  applyVoiLut(n: number): boolean {
    const imageId = this.currentImageId();
    const lut = imageId ? lutsFor(imageId)?.voi[n] : undefined;
    if (!lut) return false;
    const name = `${VOI_LUT_COLORMAP_PREFIX}${fileIdOf(imageId!)}-${n}`;
    const RGBPoints: number[] = [];
    for (const [x, y] of lutToNormalizedCurve(lut, 256)) RGBPoints.push(x, y, y, y);
    csUtils.colormap.registerColormap({ ColorSpace: 'RGB', Name: name, RGBPoints } as unknown as Parameters<
      typeof csUtils.colormap.registerColormap
    >[0]);
    const vp = this.viewport;
    vp.setProperties({ voiRange: lutDomain(lut) });
    vp.setProperties({ colormap: { name } });
    vp.render();
    this.emit({ voiLutName: lut.explanation ?? '' });
    return true;
  }

  private clearVoiLut(): void {
    if (!this.state.voiLutName) return;
    this.viewport.setProperties({ colormap: { name: 'Grayscale' } });
    this.emit({ voiLutName: undefined });
  }

  // ------------------------------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------------------------------

  currentImageId(): string | undefined {
    if (this.kind !== 'stack') return undefined;
    return this.imageIds[this.viewport.getCurrentImageIdIndex()];
  }

  hasImage(): boolean {
    return this.state.status === 'ready';
  }

  scrollBy(delta: number): void {
    if (!this.hasImage()) return;
    if (this.kind !== 'stack') {
      // From the camera, not the (asynchronously updated) state: repeated key presses must each move one slice.
      const stack = this.vol?.stack;
      const fp = this.viewport.getCamera().focalPoint;
      if (stack && fp) this.moveToSlice(reformatIndex(stack, fp as unknown as Vec3) + delta);
      return;
    }
    const vp = this.viewport;
    const i = Math.min(this.imageIds.length - 1, Math.max(0, vp.getCurrentImageIdIndex() + delta));
    void vp.setImageIdIndex(i);
  }

  scrollTo(i: number): void {
    if (!this.hasImage()) return;
    if (this.kind !== 'stack') {
      this.moveToSlice(i);
      return;
    }
    void this.viewport.setImageIdIndex(Math.min(this.imageIds.length - 1, Math.max(0, i)));
  }

  setWindow(wl: WindowLevel): void {
    if (!this.hasImage()) return;
    this.clearVoiLut();
    const fn = this.state.voiFn;
    // Cornerstone maps SIGMOID with the LINEAR range convention.
    this.viewport.setProperties({ voiRange: windowToRange(wl, fn === 'LINEAR_EXACT' ? 'LINEAR_EXACT' : 'LINEAR') });
    this.viewport.render();
  }

  setRange(r: VoiRange): void {
    if (!this.hasImage() || !(r.upper > r.lower)) return;
    this.clearVoiLut();
    this.viewport.setProperties({ voiRange: r });
    this.viewport.render();
  }

  /** Restores the window from the DICOM file (first stored window, VOI LUT or full range). */
  defaultWindow(): void {
    if (!this.hasImage()) return;
    this.clearVoiLut();
    const vp = this.viewport;
    const invert = vp.getProperties().invert;
    vp.resetProperties();
    vp.setProperties({ invert });
    const hasWindow = (this.ds?.firstInstance.geometry.windowWidth?.length ?? 0) > 0;
    if (!hasWindow) this.applyVoiLut(0);
    vp.render();
  }

  imageRange(): { min: number; max: number } | undefined {
    const id = this.currentImageId();
    const img = id ? cache.getImage(id) : undefined;
    return img ? { min: img.minPixelValue, max: img.maxPixelValue } : undefined;
  }

  rotate(deg: number): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    const cur = vp.getViewPresentation().rotation ?? 0;
    vp.setViewPresentation({ rotation: (((cur + deg) % 360) + 360) % 360 });
    vp.render();
  }

  flip(axis: 'h' | 'v'): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    // Cornerstone 5.14 setViewPresentation() only flips when asked for `true`, so it can never un-flip.
    // setCamera() compares with the current state and toggles correctly.
    const cam = vp.getCamera();
    vp.setCamera(axis === 'h' ? { flipHorizontal: !cam.flipHorizontal } : { flipVertical: !cam.flipVertical });
    vp.render();
  }

  invert(): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    vp.setProperties({ invert: !vp.getProperties().invert });
    vp.render();
  }

  fit(): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    vp.setPan([0, 0]);
    vp.setZoom(1);
    vp.render();
  }

  /** One image pixel per device (physical) pixel. Canvas coordinates are CSS pixels, so the target is dpr image px per CSS px. */
  oneToOne(): void {
    if (!this.hasImage()) return;
    const ratio = this.imagePixelsPerCssPx();
    if (!ratio) return;
    const target = window.devicePixelRatio || 1;
    const vp = this.viewport;
    vp.setZoom(vp.getZoom() * (ratio / target));
    vp.render();
  }

  zoomBy(factor: number): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    vp.setZoom(Math.min(64, Math.max(0.05, vp.getZoom() * factor)));
    vp.render();
  }

  reset(): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    if (this.kind !== 'stack') {
      if (this.state.slab) this.setSlab(undefined);
      vp.resetProperties();
      if (this.kind === '3d') this.apply3dDefaults();
      else this.applyStandardView(this.kind);
      vp.render();
      return;
    }
    this.clearVoiLut();
    vp.resetCamera();
    vp.resetProperties();
    vp.setViewPresentation({ rotation: 0 });
    vp.setCamera({ flipHorizontal: false, flipVertical: false });
    this.applyInitialDisplay();
    vp.render();
  }

  toggleCine(fps: number, mode: 'loop' | 'bounce'): boolean {
    if (!this.hasImage() || this.kind !== 'stack' || this.imageIds.length < 2) return false;
    if (this.state.cine) {
      this.stopCine();
      return false;
    }
    toolUtils.cine.playClip(this.element, { framesPerSecond: fps, loop: true, bounce: mode === 'bounce' });
    this.emit({ cine: true, fps });
    return true;
  }

  stopCine(): void {
    if (!this.state.cine) return;
    toolUtils.cine.stopClip(this.element);
    this.emit({ cine: false });
  }

  /** Cancels a measurement being drawn on this viewport. */
  cancelDrawing(): boolean {
    const cancelled = cancelDrawingOn(this.element);
    if (cancelled) this.viewport.render();
    return cancelled;
  }

  setShowOverlays(on: boolean): void {
    this.showOverlays = on;
    void this.drawOverlays();
  }

  resizeOverlay(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.element.clientWidth * dpr);
    const h = Math.round(this.element.clientHeight * dpr);
    for (const c of [this.overlayCanvas, this.guideCanvas]) {
      if (c && (c.width !== w || c.height !== h)) {
        c.width = w;
        c.height = h;
      }
    }
    void this.drawOverlays();
    this.drawGuides();
  }

  // ------------------------------------------------------------------------------------------
  // Guides: reference lines and the 3D cursor marker (image pixel coordinates, drawn by the sync engine's request)
  // ------------------------------------------------------------------------------------------

  private guides: Guides = { lines: [] };

  setGuides(g: Guides): void {
    const same = JSON.stringify(g) === JSON.stringify(this.guides);
    this.guides = g;
    if (!same) this.drawGuides();
  }

  /** Crosshair lines in canvas coordinates with their rotation handles (for drawing and hit testing). */
  crosshairOnCanvas(): { source: number; color: string; a: [number, number]; b: [number, number]; handles: [number, number][] }[] {
    const center = this.guides.center ? this.pixelToCanvas(this.guides.center[0], this.guides.center[1]) : undefined;
    const out: ReturnType<ViewportController['crosshairOnCanvas']> = [];
    for (const x of this.guides.crosshair ?? []) {
      const a = this.pixelToCanvas(x.line[0][0], x.line[0][1]);
      const b = this.pixelToCanvas(x.line[1][0], x.line[1][1]);
      if (!a || !b) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1) continue;
      const u: [number, number] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      // Handles sit a fixed distance from the crosshair centre (or near the line ends), clamped to the line.
      const c = center ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const t0 = (c[0] - a[0]) * u[0] + (c[1] - a[1]) * u[1];
      const handles = [-HANDLE_DISTANCE_PX, HANDLE_DISTANCE_PX].map((d): [number, number] => {
        const t = Math.min(len - 8, Math.max(8, t0 + d));
        return [a[0] + u[0] * t, a[1] + u[1] * t];
      });
      out.push({ source: x.source, color: x.color, a, b, handles });
    }
    return out;
  }

  getGuides(): Guides {
    return this.guides;
  }

  private drawGuides(): void {
    const canvas = this.guideCanvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.state.status !== 'ready') return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = GUIDE_LINE_COLOR;
    for (const [a, b] of this.guides.lines) {
      const p = this.pixelToCanvas(a[0], a[1]);
      const q = this.pixelToCanvas(b[0], b[1]);
      if (!p || !q) continue;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
      ctx.stroke();
    }
    // MPR crosshair: the planes of the other reformats of this volume, in their colours, with rotation handles.
    for (const x of this.crosshairOnCanvas()) {
      ctx.strokeStyle = x.color;
      ctx.fillStyle = x.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x.a[0], x.a[1]);
      ctx.lineTo(x.b[0], x.b[1]);
      ctx.stroke();
      for (const h of x.handles) {
        ctx.beginPath();
        ctx.arc(h[0], h[1], 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    const center = this.guides.center ? this.pixelToCanvas(this.guides.center[0], this.guides.center[1]) : undefined;
    if (center) {
      ctx.strokeStyle = GUIDE_CENTER_COLOR;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(center[0], center[1], 6, 0, 2 * Math.PI);
      ctx.stroke();
    }
    const m = this.guides.marker ? this.pixelToCanvas(this.guides.marker[0], this.guides.marker[1]) : undefined;
    if (m) {
      // Crosshair with a gap so the point itself stays visible.
      ctx.strokeStyle = GUIDE_CURSOR_COLOR;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        ctx.moveTo(m[0] + dx * 4, m[1] + dy * 4);
        ctx.lineTo(m[0] + dx * 14, m[1] + dy * 14);
      }
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Zoom factor and pan of the camera (for zoom/pan sync). */
  getZoomPan(): { zoom: number; pan: [number, number] } | undefined {
    if (!this.hasImage()) return undefined;
    const vp = this.viewport;
    const pan = vp.getPan();
    return { zoom: vp.getZoom(), pan: [pan[0], pan[1]] };
  }

  setZoomPan(z: { zoom: number; pan: [number, number] }): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    vp.setZoom(z.zoom);
    vp.setPan(z.pan as Types.Point2);
    vp.render();
  }

  get viewportElement(): HTMLDivElement {
    return this.element;
  }

  // ------------------------------------------------------------------------------------------
  // Derived state
  // ------------------------------------------------------------------------------------------

  private readonly onViewportEvent = (): void => {
    if (this.pendingUpdate) return;
    this.pendingUpdate = true;
    requestAnimationFrame(() => {
      this.pendingUpdate = false;
      if (!this.disposed) this.update();
    });
  };

  private readonly onLoadFailed = (evt: Event): void => {
    const detail = (evt as CustomEvent<{ imageId?: string }>).detail;
    if (detail?.imageId && detail.imageId === this.currentImageIdSafe()) this.emit({ status: 'error' });
  };

  private currentImageIdSafe(): string | undefined {
    try {
      return this.currentImageId();
    } catch {
      return undefined;
    }
  }

  /** Millimetres per CSS pixel along the screen x axis, from the camera. */
  private mmPerCssPx(): number | undefined {
    const vp = this.viewport;
    const p0 = vp.canvasToWorld([0, 0]);
    const p1 = vp.canvasToWorld([100, 0]);
    const mm = vec3.length(vec3.sub(p1 as unknown as Vec3, p0 as unknown as Vec3)) / 100;
    return mm > 0 ? mm : undefined;
  }

  private imagePixelsPerCssPx(): number | undefined {
    if (this.kind !== 'stack') {
      const plane = this.currentPlane();
      const mm = this.mmPerCssPx();
      return plane && mm ? mm / plane.columnSpacing : undefined;
    }
    const vp = this.viewport;
    const id = this.currentImageId();
    const plane = id ? (metaData.get('imagePlaneModule', id) as { columnPixelSpacing?: number } | undefined) : undefined;
    const csSpacing = plane?.columnPixelSpacing || 1;
    const p0 = vp.canvasToWorld([0, 0]);
    const p1 = vp.canvasToWorld([100, 0]);
    const world = vec3.length(vec3.sub(p1 as unknown as Vec3, p0 as unknown as Vec3)) / 100;
    return world > 0 ? world / csSpacing : undefined;
  }

  private update(): void {
    if (this.state.status !== 'ready' || !this.ds) return;
    if (this.kind !== 'stack') {
      this.updateVolume();
      return;
    }
    const vp = this.viewport;
    const index = vp.getCurrentImageIdIndex();
    const imageId = this.imageIds[index];
    const props = vp.getProperties();
    const pres = vp.getViewPresentation();
    const voiFn = normalizeVoiLutFunction(String(props.VOILUTFunction ?? this.ds.firstInstance.voiLutFunction ?? 'LINEAR'));
    const voi = props.voiRange;
    const wl = voi ? rangeToWindow(voi, voiFn === 'LINEAR_EXACT' ? 'LINEAR_EXACT' : 'LINEAR') : undefined;
    const img = this.ds.images[index];
    const basis = spacingBasis(this.ds.firstInstance, img?.geometry.pixelSpacing);
    const ratio = this.imagePixelsPerCssPx();
    const manual = useStore.getState().calibrations[this.ds.seriesInstanceUid];
    const colMm =
      manual?.columnMm ??
      (basis.kind === 'pixelSpacing' || basis.kind === 'imagerMagnified' || basis.kind === 'imagerPixelSpacing'
        ? basis.columnMm
        : undefined);
    let labels: EdgeLabels | undefined;
    if (imageId) {
      const cam = vp.getCamera();
      const plane = metaData.get('imagePlaneModule', imageId) as { rowCosines?: number[]; columnCosines?: number[] } | undefined;
      const axes = patientImageAxes(this.ds.firstInstance, img?.geometry.imageOrientationPatient);
      if (cam.viewUp && cam.viewPlaneNormal && plane?.rowCosines && plane.columnCosines) {
        labels = viewLabels(
          cam.viewUp as unknown as Vec3,
          cam.viewPlaneNormal as unknown as Vec3,
          plane.rowCosines as unknown as Vec3,
          plane.columnCosines as unknown as Vec3,
          axes,
        );
      }
    }
    this.emit({
      index,
      total: this.imageIds.length,
      imageId,
      voi,
      wl,
      voiFn,
      // Device pixels per image pixel × 100 (100 % = 1:1 on the physical display).
      zoomPercent: ratio ? (100 * (window.devicePixelRatio || 1)) / ratio : undefined,
      rotation: pres.rotation ?? 0,
      flipH: Boolean(pres.flipHorizontal),
      flipV: Boolean(pres.flipVertical),
      inverted: Boolean(props.invert) !== this.initialInvert,
      labels,
      basis,
      mmPerCssPx: ratio && colMm ? ratio * colMm : undefined,
    });
    if (this.lastPointer) this.probeAt(this.lastPointer.x, this.lastPointer.y);
    void this.drawOverlays();
    this.drawGuides();
  }

  /** Reformat/3D state: current reformatted plane (recomputed when the camera direction changes), labels, W/L. */
  private updateVolume(): void {
    const vol = this.vol;
    if (!vol || !this.ds) return;
    const vp = this.viewport;
    const props = vp.getProperties();
    const voiFn = normalizeVoiLutFunction(String(props.VOILUTFunction ?? 'LINEAR'));
    const voi = props.voiRange;
    const wl = voi ? rangeToWindow(voi, voiFn === 'LINEAR_EXACT' ? 'LINEAR_EXACT' : 'LINEAR') : undefined;
    if (this.kind === '3d') {
      this.emit({ index: 0, total: 0, voi, wl, voiFn, labels: undefined, zoomPercent: undefined, mmPerCssPx: undefined });
      return;
    }
    const cam = vp.getCamera();
    if (!cam.viewPlaneNormal || !cam.viewUp || !cam.focalPoint) return;
    const n = cam.viewPlaneNormal as unknown as Vec3;
    const up = cam.viewUp as unknown as Vec3;
    let stack = vol.stack;
    const sameDirection =
      stack && vec3.dot(stack.normal, n) > 1 - 1e-9 && vec3.dot(vec3.negate(stack.planes[0]!.orientation.column), up) > 1 - 1e-9;
    if (!sameDirection) stack = vol.stack = reformatStack(vol.geometry, n, up);
    if (!stack) return;
    const index = reformatIndex(stack, cam.focalPoint as unknown as Vec3);
    const plane = stack.planes[index]!;
    const axes = { row: plane.orientation.row, column: plane.orientation.column };
    const mm = this.mmPerCssPx();
    const pres = vp.getViewPresentation();
    // Location along the patient axis the normal is closest to, signed towards L / P / H (as for original stacks).
    const major = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
    const towards = n[major]! < 0 ? vec3.negate(n) : n;
    this.emit({
      index,
      total: stack.planes.length,
      imageId: undefined,
      voi,
      wl,
      voiFn,
      zoomPercent: mm ? (100 * (window.devicePixelRatio || 1) * plane.columnSpacing) / mm : undefined,
      rotation: pres.rotation ?? 0,
      flipH: Boolean(pres.flipHorizontal),
      flipV: Boolean(pres.flipVertical),
      inverted: Boolean(props.invert),
      labels: viewLabels(up, n, axes.row, axes.column, axes),
      basis: { kind: 'pixelSpacing', rowMm: plane.rowSpacing, columnMm: plane.columnSpacing },
      mmPerCssPx: mm,
      reformat: { location: sliceLocation(planePoint(plane, 0, 0), towards), spacing: stack.spacing, warnings: vol.warnings },
    });
    if (this.lastPointer) this.probeAt(this.lastPointer.x, this.lastPointer.y);
    this.drawGuides();
  }

  // ------------------------------------------------------------------------------------------
  // Probe (value under cursor, modality units)
  // ------------------------------------------------------------------------------------------

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
    this.lastPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.probeAt(this.lastPointer.x, this.lastPointer.y);
    this.hoverAt(this.lastPointer.x, this.lastPointer.y);
  };

  private readonly onPointerLeave = (): void => {
    this.lastPointer = undefined;
    if (this.state.probe) this.emit({ probe: undefined });
    if (this.state.hover) this.emit({ hover: undefined });
  };

  /** Finds the measurement under the cursor; its delete button sits at the top-right corner of its outline. */
  private hoverAt(x: number, y: number): void {
    let next: ViewState['hover'];
    if (this.state.status === 'ready' && !isDrawing()) {
      const a = toolUtils.getAnnotationNearPoint(this.element, [x, y], 6);
      const tool = a ? measureToolOf(a.metadata?.toolName ?? '') : undefined;
      if (a?.annotationUID && tool && tool !== 'calibrate') {
        const pts = definingPoints(tool, a.data).map((p) => this.viewport.worldToCanvas(p));
        if (pts.length > 0) {
          const size = 24;
          const maxX = Math.max(...pts.map((p) => p[0]));
          const minY = Math.min(...pts.map((p) => p[1]));
          next = {
            uid: a.annotationUID,
            x: Math.round(Math.min(Math.max(0, maxX + 6), this.element.clientWidth - size)),
            y: Math.round(Math.min(Math.max(0, minY - size - 6), this.element.clientHeight - size)),
          };
        }
      }
    }
    const cur = this.state.hover;
    if (next?.uid !== cur?.uid || next?.x !== cur?.x || next?.y !== cur?.y) this.emit({ hover: next });
  }

  /** Image (column,row) of a canvas point using the DICOM-correct inverse mapping (not csUtils.worldToImageCoords). */
  canvasToPixel(x: number, y: number): [number, number] | undefined {
    if (this.kind !== 'stack') {
      const plane = this.currentPlane();
      return plane ? planePixel(plane, this.viewport.canvasToWorld([x, y]) as unknown as Vec3) : undefined;
    }
    const id = this.currentImageId();
    if (!id) return undefined;
    const plane = metaData.get('imagePlaneModule', id) as
      | {
          imagePositionPatient?: number[];
          rowCosines?: number[];
          columnCosines?: number[];
          rowPixelSpacing?: number;
          columnPixelSpacing?: number;
        }
      | undefined;
    if (!plane?.imagePositionPatient || !plane.rowCosines || !plane.columnCosines) return undefined;
    const o = parseImageOrientation([...plane.rowCosines, ...plane.columnCosines]);
    if (!o) return undefined;
    const world = this.viewport.canvasToWorld([x, y]) as unknown as Vec3;
    return patientToPixel(world, plane.imagePositionPatient as unknown as Vec3, o, [
      plane.rowPixelSpacing || 1,
      plane.columnPixelSpacing || 1,
    ]);
  }

  /** Canvas point of an image pixel centre (inverse of canvasToPixel). */
  pixelToCanvas(column: number, row: number): [number, number] | undefined {
    if (this.kind !== 'stack') {
      const plane = this.currentPlane();
      if (!plane) return undefined;
      const c = this.viewport.worldToCanvas(planePoint(plane, column, row) as unknown as Types.Point3);
      return [c[0], c[1]];
    }
    const id = this.currentImageId();
    if (!id) return undefined;
    const plane = metaData.get('imagePlaneModule', id) as
      | {
          imagePositionPatient?: number[];
          rowCosines?: number[];
          columnCosines?: number[];
          rowPixelSpacing?: number;
          columnPixelSpacing?: number;
        }
      | undefined;
    if (!plane?.imagePositionPatient || !plane.rowCosines || !plane.columnCosines) return undefined;
    const rs = plane.rowPixelSpacing || 1;
    const cs = plane.columnPixelSpacing || 1;
    const ipp = plane.imagePositionPatient;
    const world = [0, 1, 2].map((k) => ipp[k]! + plane.rowCosines![k]! * cs * column + plane.columnCosines![k]! * rs * row);
    const c = this.viewport.worldToCanvas(world as Types.Point3);
    return [c[0], c[1]];
  }

  /** Value of the voxel nearest to the point under the cursor in a reformat (no interpolation). */
  private probeVolume(x: number, y: number): void {
    const plane = this.currentPlane();
    const vol = this.vol;
    const volume = vol ? cache.getVolume(vol.volumeId) : undefined;
    if (!plane || !vol || !volume || !this.ds) return;
    const world = this.viewport.canvasToWorld([x, y]) as unknown as Vec3;
    const [c, r] = planePixel(plane, world);
    const column = Math.round(c);
    const row = Math.round(r);
    const inst = this.ds.firstInstance;
    const unit = probeUnit(inst);
    const ijk = nearestVoxel(vol.geometry, world);
    if (!ijk) {
      this.emit({ probe: { column, row, unit } });
      return;
    }
    const at = (p: Vec3): number | undefined => {
      const v = nearestVoxel(vol.geometry, p);
      return v ? Number(volume.voxelManager?.getAtIJK(v[0], v[1], v[2])) : undefined;
    };
    const slab = this.state.slab;
    const stack = vol.stack;
    // In a thick slab the value is the projection of the voxels along the normal through the point.
    const v =
      slab && stack
        ? (slabProject(
            slabOffsets(slab.thickness, stack.spacing).map((d) => at(vec3.add(world, vec3.scale(stack.normal, d)))),
            slab.mode,
          ) ?? Number.NaN)
        : Number(volume.voxelManager?.getAtIJK(ijk[0], ijk[1], ijk[2]));
    const pad = inst.pixelPaddingValue;
    const padding = pad !== undefined && v === pad * (inst.geometry.rescaleSlope ?? 1) + (inst.geometry.rescaleIntercept ?? 0);
    this.emit({ probe: { column, row, unit, value: Math.round(v * 100) / 100, ...(padding ? { padding } : {}) } });
  }

  private probeAt(x: number, y: number): void {
    if (this.state.status !== 'ready' || !this.ds) return;
    if (this.kind !== 'stack') {
      if (this.kind !== '3d') this.probeVolume(x, y);
      return;
    }
    const id = this.currentImageId();
    const image = id ? cache.getImage(id) : undefined;
    const px = this.canvasToPixel(x, y);
    if (!image || !px || !id) return;
    const column = Math.round(px[0]);
    const row = Math.round(px[1]);
    const inst = this.ds.firstInstance;
    const unit = probeUnit(inst);
    if (column < 0 || row < 0 || column >= image.columns || row >= image.rows) {
      this.emit({ probe: { column, row, unit } });
      return;
    }
    const pd = image.getPixelData();
    const i = row * image.columns + column;
    if (image.color) {
      const spp = pd.length / (image.rows * image.columns) >= 4 ? 4 : 3;
      this.emit({ probe: { column, row, unit: 'raw', value: [pd[i * spp]!, pd[i * spp + 1]!, pd[i * spp + 2]!] } });
      return;
    }
    let v = pd[i]!;
    const scaled = Boolean((image as { preScale?: { scaled?: boolean } }).preScale?.scaled) || modalityLutApplied(image);
    if (!scaled) v = v * (image.slope ?? 1) + (image.intercept ?? 0);
    const pad = inst.pixelPaddingValue;
    const g = this.ds.images[this.state.index]?.geometry ?? inst.geometry;
    const padding =
      pad !== undefined &&
      v === pad * (g.rescaleSlope ?? inst.geometry.rescaleSlope ?? 1) + (g.rescaleIntercept ?? inst.geometry.rescaleIntercept ?? 0);
    this.emit({ probe: { column, row, unit, value: v, ...(padding ? { padding } : {}) } });
  }

  // ------------------------------------------------------------------------------------------
  // DICOM overlays (60xx)
  // ------------------------------------------------------------------------------------------

  private clearOverlayCanvas(): void {
    const ctx = this.overlayCanvas.getContext('2d');
    ctx?.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  private loadOverlays(imageId: string): Promise<OverlayBitmap[]> {
    let p = this.overlayCache.get(imageId);
    if (!p) {
      p = (async () => {
        const layers = await window.api.readOverlays(fileIdOf(imageId), frameOf(imageId));
        const out: OverlayBitmap[] = [];
        for (const l of layers) {
          const data = new ImageData(l.columns, l.rows);
          for (let k = 0; k < l.bitmap.length; k++) {
            if (!l.bitmap[k]) continue;
            data.data.set([...OVERLAY_COLOR, 255], k * 4);
          }
          out.push({ bitmap: await createImageBitmap(data), rows: l.rows, columns: l.columns, origin: l.origin });
        }
        return out;
      })().catch(() => []);
      this.overlayCache.set(imageId, p);
    }
    return p;
  }

  private async drawOverlays(): Promise<void> {
    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) return;
    const id = this.currentImageIdSafe();
    if (!this.showOverlays || !id || !this.ds?.firstInstance.overlayGroups?.length || this.state.status !== 'ready') {
      this.clearOverlayCanvas();
      return;
    }
    const layers = await this.loadOverlays(id);
    if (id !== this.currentImageIdSafe()) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ctx.imageSmoothingEnabled = false;
    for (const l of layers) {
      // Overlay pixel (0,0) sits on image pixel (origin − 1); its outer corner is half a pixel before the centre.
      const c0 = l.origin[1] - 1 - 0.5;
      const r0 = l.origin[0] - 1 - 0.5;
      const a = this.pixelToCanvas(c0, r0);
      const b = this.pixelToCanvas(c0 + l.columns, r0);
      const c = this.pixelToCanvas(c0, r0 + l.rows);
      if (!a || !b || !c) continue;
      ctx.setTransform(
        (dpr * (b[0] - a[0])) / l.columns,
        (dpr * (b[1] - a[1])) / l.columns,
        (dpr * (c[0] - a[0])) / l.rows,
        (dpr * (c[1] - a[1])) / l.rows,
        dpr * a[0],
        dpr * a[1],
      );
      ctx.drawImage(l.bitmap, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ------------------------------------------------------------------------------------------

  destroy(): void {
    this.disposed = true;
    this.stopCine();
    for (const ev of [Enums.Events.STACK_NEW_IMAGE, Enums.Events.VOI_MODIFIED, Enums.Events.CAMERA_MODIFIED, Enums.Events.IMAGE_RENDERED]) {
      this.element.removeEventListener(ev, this.onViewportEvent);
    }
    eventTarget.removeEventListener(Enums.Events.IMAGE_LOAD_FAILED, this.onLoadFailed);
    eventTarget.removeEventListener(Enums.Events.IMAGE_LOAD_ERROR, this.onLoadFailed);
    this.element.removeEventListener(Enums.Events.IMAGE_LOAD_ERROR, this.onLoadFailed);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerleave', this.onPointerLeave);
    this.element.removeEventListener('pointerdown', this.onScalpelDown, true);
    this.element.removeEventListener('pointermove', this.onScalpelMove, true);
    this.element.removeEventListener('pointerup', this.onScalpelUp, true);
    this.vr?.release();
    try {
      toolUtils.stackPrefetch.disable(this.element);
    } catch {
      // prefetch may not have been enabled
    }
    getToolGroup(toolGroupKind(this.kind)).removeViewports(RENDERING_ENGINE_ID, this.viewportId);
    getEngine().disableElement(this.viewportId);
    this.listeners.clear();
  }
}

function viewportType(kind: ViewKind): Enums.ViewportType {
  if (kind === 'stack') return Enums.ViewportType.STACK;
  return kind === '3d' ? Enums.ViewportType.VOLUME_3D : Enums.ViewportType.ORTHOGRAPHIC;
}

function toolGroupKind(kind: ViewKind): ToolGroupKind {
  if (kind === 'stack') return 'stack';
  return kind === '3d' ? '3d' : 'mpr';
}

/** Lines (pairs of image pixel points) and an optional cursor marker drawn over the image. */
export interface Guides {
  lines: [readonly [number, number], readonly [number, number]][];
  marker?: readonly [number, number];
  /** MPR crosshair: each other reformat's plane on this one (its colour, its viewport index) and their common point. */
  crosshair?: { line: [readonly [number, number], readonly [number, number]]; color: string; source: number }[];
  center?: readonly [number, number];
}

const GUIDE_LINE_COLOR = 'rgba(56, 189, 248, 0.9)';
const GUIDE_CENTER_COLOR = 'rgba(255, 255, 255, 0.9)';
const SCALPEL_COLOR = 'rgba(250, 204, 21, 0.95)';
/** Distance of the crosshair rotation handles from the crosshair centre (CSS pixels). */
export const HANDLE_DISTANCE_PX = 70;
const GUIDE_CURSOR_COLOR = 'rgba(74, 222, 128, 0.95)';

export type ProbeUnit = 'hu' | 'bqml' | 'cnts' | 'gml' | 'raw';

/** Unit of modality values: HU for CT, PET Units (0054,1001) for PT; never guessed for unknown PET units. */
export function probeUnit(inst: DisplaySet['firstInstance']): ProbeUnit {
  if (inst.modality === 'CT' || inst.rescaleType === 'HU') return 'hu';
  if (inst.modality === 'PT') {
    const u = (inst.petUnits ?? '').toUpperCase();
    if (u === 'BQML') return 'bqml';
    if (u === 'CNTS') return 'cnts';
    if (u === 'GML') return 'gml';
  }
  return 'raw';
}

/** Default cine rate: Recommended Display Frame Rate, Cine Rate, 1000 / Frame Time, else 15 fps. */
export function defaultFps(ds: DisplaySet): number {
  const i = ds.firstInstance;
  const fps = i.recommendedDisplayFrameRate ?? i.cineRate ?? (i.frameTime ? 1000 / i.frameTime : undefined);
  return fps && fps > 0 && fps <= 120 ? Math.round(fps * 10) / 10 : 15;
}

export { TOOL_GROUP_ID };
