/**
 * One stack viewport: wraps a Cornerstone StackViewport and derives everything the overlay shows.
 * Clinical math (labels, spacing basis, VOI formulas, pixel mapping) comes from @ahdicom/dicom-core.
 */
import { Enums, cache, eventTarget, imageLoader, metaData, utilities as csUtils, type Types } from '@cornerstonejs/core';
import { utilities as toolUtils } from '@cornerstonejs/tools';
import {
  type DisplaySet,
  type EdgeLabels,
  type SpacingBasis,
  type Vec3,
  type VoiLutFunction,
  type VoiRange,
  type WindowLevel,
  lutDomain,
  lutToNormalizedCurve,
  normalizeVoiLutFunction,
  parseImageOrientation,
  patientImageAxes,
  patientToPixel,
  rangeToWindow,
  spacingBasis,
  vec3,
  viewLabels,
  windowToRange,
} from '@ahdicom/dicom-core';
import { RENDERING_ENGINE_ID, TOOL_GROUP_ID, frameOf, fileIdOf, getEngine, getToolGroup, imageIdsFor } from './cornerstone';
import { lutsFor, modalityLutApplied } from './lut';
import { cancelDrawingOn, isDrawing } from './annotations';
import { definingPoints } from './measureDoc';
import { measureToolOf } from './measurements';
import { useStore } from '../state/store';

export type ViewStatus = 'empty' | 'loading' | 'ready' | 'error' | 'nonImage';

export interface ProbeValue {
  column: number;
  row: number;
  /** Modality value (or RGB triple for colour) — undefined when outside the image. */
  value?: number | [number, number, number];
  unit: ProbeUnit;
  padding?: boolean;
}

export interface ViewState {
  status: ViewStatus;
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

  constructor(
    readonly index: number,
    private readonly element: HTMLDivElement,
    private readonly overlayCanvas: HTMLCanvasElement,
    private readonly guideCanvas?: HTMLCanvasElement,
  ) {
    this.viewportId = `vp-${index}`;
    getEngine().enableElement({
      viewportId: this.viewportId,
      type: Enums.ViewportType.STACK,
      element,
      defaultOptions: { background: [0, 0, 0] },
    });
    getToolGroup().addViewport(this.viewportId, RENDERING_ENGINE_ID);
    for (const ev of [Enums.Events.STACK_NEW_IMAGE, Enums.Events.VOI_MODIFIED, Enums.Events.CAMERA_MODIFIED, Enums.Events.IMAGE_RENDERED]) {
      element.addEventListener(ev, this.onViewportEvent);
    }
    eventTarget.addEventListener(Enums.Events.IMAGE_LOAD_FAILED, this.onLoadFailed);
    eventTarget.addEventListener(Enums.Events.IMAGE_LOAD_ERROR, this.onLoadFailed);
    element.addEventListener(Enums.Events.IMAGE_LOAD_ERROR, this.onLoadFailed);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerleave', this.onPointerLeave);
  }

  get viewport(): Types.IStackViewport {
    return getEngine().getViewport(this.viewportId) as Types.IStackViewport;
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

  async setDisplaySet(ds: DisplaySet | undefined): Promise<void> {
    const ids = ds ? imageIdsFor(ds) : [];
    if (ds && this.ds?.id === ds.id) {
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
    this.ds = ds;
    this.imageIds = ids;
    this.overlayCache.clear();
    const token = ++this.loadToken;
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
    return this.imageIds[this.viewport.getCurrentImageIdIndex()];
  }

  hasImage(): boolean {
    return this.state.status === 'ready';
  }

  scrollBy(delta: number): void {
    if (!this.hasImage()) return;
    const vp = this.viewport;
    const i = Math.min(this.imageIds.length - 1, Math.max(0, vp.getCurrentImageIdIndex() + delta));
    void vp.setImageIdIndex(i);
  }

  scrollTo(i: number): void {
    if (!this.hasImage()) return;
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
    this.clearVoiLut();
    vp.resetCamera();
    vp.resetProperties();
    vp.setViewPresentation({ rotation: 0 });
    vp.setCamera({ flipHorizontal: false, flipVertical: false });
    this.applyInitialDisplay();
    vp.render();
  }

  toggleCine(fps: number, mode: 'loop' | 'bounce'): boolean {
    if (!this.hasImage() || this.imageIds.length < 2) return false;
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
    const same =
      g.marker?.[0] === this.guides.marker?.[0] &&
      g.marker?.[1] === this.guides.marker?.[1] &&
      JSON.stringify(g.lines) === JSON.stringify(this.guides.lines);
    this.guides = g;
    if (!same) this.drawGuides();
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

  private imagePixelsPerCssPx(): number | undefined {
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

  private probeAt(x: number, y: number): void {
    if (this.state.status !== 'ready' || !this.ds) return;
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
    try {
      toolUtils.stackPrefetch.disable(this.element);
    } catch {
      // prefetch may not have been enabled
    }
    getToolGroup().removeViewports(RENDERING_ENGINE_ID, this.viewportId);
    getEngine().disableElement(this.viewportId);
    this.listeners.clear();
  }
}

/** Lines (pairs of image pixel points) and an optional cursor marker drawn over the image. */
export interface Guides {
  lines: [readonly [number, number], readonly [number, number]][];
  marker?: readonly [number, number];
}

const GUIDE_LINE_COLOR = 'rgba(56, 189, 248, 0.9)';
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
