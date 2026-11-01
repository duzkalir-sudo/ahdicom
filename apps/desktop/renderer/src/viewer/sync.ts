/**
 * Series comparison engine: slice sync, manual links with offset, window/level and zoom/pan sync, reference lines and
 * the 3D cursor. All geometry comes from @ahdicom/dicom-core (D-054); this module only decides which viewport follows
 * which and avoids feedback loops (a change applied here is not propagated again).
 */
import {
  type DisplaySet,
  type ImagePlane,
  type Vec3,
  canAutoSync,
  cursorTarget,
  nearestSlice,
  planeCenter,
  planeFromGeometry,
  planePixel,
  planePoint,
  referenceLine,
  sliceAtPosition,
  slicePosition,
  vec3,
} from '@ahdicom/dicom-core';
import { useStore } from '../state/store';
import type { Guides, ViewportController, ViewState } from './controller';
import { allControllers, controllerAt, onControllersChanged } from './registry';

// ---------------------------------------------------------------------------------------------
// Planes of a display set
// ---------------------------------------------------------------------------------------------

const planeCache = new WeakMap<DisplaySet, (ImagePlane | undefined)[]>();

/** Plane of every image of a display set (undefined for images without geometry). */
export function planesOf(ds: DisplaySet): (ImagePlane | undefined)[] {
  let planes = planeCache.get(ds);
  if (!planes) {
    const i = ds.firstInstance;
    planes = ds.images.map((img) => planeFromGeometry(img.geometry, i.rows ?? 0, i.columns ?? 0, i.frameOfReferenceUid));
    planeCache.set(ds, planes);
  }
  return planes;
}

/** Planes with their image indices (images without geometry left out). */
function indexedPlanes(ds: DisplaySet): { planes: ImagePlane[]; indices: number[] } {
  const planes: ImagePlane[] = [];
  const indices: number[] = [];
  planesOf(ds).forEach((p, k) => {
    if (p) {
      planes.push(p);
      indices.push(k);
    }
  });
  return { planes, indices };
}

function currentPlane(c: ViewportController): ImagePlane | undefined {
  const ds = c.displaySet;
  const vs = c.getState();
  return ds && vs.status === 'ready' ? planesOf(ds)[vs.index] : undefined;
}

function ready(c: ViewportController): boolean {
  return c.getState().status === 'ready' && c.displaySet !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------------------------

interface Seen {
  index?: number;
  displaySetId?: string;
  voi?: string;
  zoomPan?: string;
}

const seen = new Map<number, Seen>();
/** Values this engine just applied to a viewport; the resulting state change is not propagated. */
const expected = new Map<number, { index?: number; voi?: string; zoomPan?: string }>();
/** Manual link anchors: each viewport's slice position along its own normal when the link was made. */
const anchors = new Map<number, { position: number; normal: Vec3 }>();
/** 3D cursor: patient point and its Frame of Reference. */
let cursor: { point: Vec3; frameOfReferenceUid?: string } | undefined;

const voiKey = (vs: ViewState): string | undefined => (vs.voi ? `${vs.voi.lower.toFixed(3)}:${vs.voi.upper.toFixed(3)}` : undefined);

function zoomPanKey(c: ViewportController): string | undefined {
  const z = c.getZoomPan();
  return z ? `${z.zoom.toFixed(4)}:${z.pan[0].toFixed(2)}:${z.pan[1].toFixed(2)}` : undefined;
}

function expect(index: number, patch: { index?: number; voi?: string; zoomPan?: string }): void {
  expected.set(index, { ...expected.get(index), ...patch });
}

function consume(index: number, key: 'index' | 'voi' | 'zoomPan', value: number | string | undefined): boolean {
  const e = expected.get(index);
  if (!e || e[key] === undefined || e[key] !== value) return false;
  delete e[key];
  return true;
}

// ---------------------------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------------------------

function moveTo(target: ViewportController, index: number | undefined): void {
  if (index === undefined || index === target.getState().index) return;
  expect(target.index, { index });
  target.scrollTo(index);
}

/** Slice of `target` that matches the current slice of `source`, or undefined when they are not linked. */
function matchingSlice(source: ViewportController, target: ViewportController): number | undefined {
  const opts = useStore.getState().sync;
  const sp = currentPlane(source);
  const tds = target.displaySet;
  if (!sp || !tds) return undefined;
  const { planes, indices } = indexedPlanes(tds);
  const tp = currentPlane(target) ?? planes[0];
  if (!tp) return undefined;
  if (opts.slice && canAutoSync(sp, tp)) {
    const m = nearestSlice(planes, planeCenter(sp));
    return m?.inside ? indices[m.index] : undefined;
  }
  if (opts.linked) {
    const sa = anchors.get(source.index);
    const ta = anchors.get(target.index);
    if (!sa || !ta) return undefined;
    const delta = slicePosition(sp, sa.normal) - sa.position;
    const sign = vec3.dot(sa.normal, ta.normal) >= 0 ? 1 : -1;
    const k = sliceAtPosition(planes, ta.normal, ta.position + sign * delta);
    return k === undefined ? undefined : indices[k];
  }
  return undefined;
}

function propagateSlice(source: ViewportController): void {
  for (const c of allControllers()) {
    if (c === source || !ready(c)) continue;
    moveTo(c, matchingSlice(source, c));
  }
}

function sameModality(a: ViewportController, b: ViewportController): boolean {
  return Boolean(a.displaySet?.modality) && a.displaySet?.modality === b.displaySet?.modality;
}

function propagateVoi(source: ViewportController): void {
  const vs = source.getState();
  if (!vs.voi) return;
  for (const c of allControllers()) {
    if (c === source || !ready(c) || !sameModality(source, c)) continue;
    const key = voiKey(vs);
    if (key === voiKey(c.getState())) continue;
    expect(c.index, { voi: key });
    c.setRange(vs.voi);
  }
}

function propagateZoomPan(source: ViewportController): void {
  const z = source.getZoomPan();
  if (!z) return;
  for (const c of allControllers()) {
    if (c === source || !ready(c)) continue;
    c.setZoomPan(z);
    expect(c.index, { zoomPan: zoomPanKey(c) });
  }
}

function onState(c: ViewportController, vs: ViewState): void {
  const prev = seen.get(c.index) ?? {};
  const now: Seen = { index: vs.index, displaySetId: vs.displaySetId, voi: voiKey(vs), zoomPan: ready(c) ? zoomPanKey(c) : undefined };
  seen.set(c.index, now);
  if (vs.status !== 'ready') {
    scheduleGuides();
    return;
  }
  const opts = useStore.getState().sync;
  const active = controllerAt(useStore.getState().activeIndex);
  if (now.displaySetId !== prev.displaySetId) {
    // A series dropped into a viewport joins the others. With a manual link it joins at its own current slice (its
    // anchor); otherwise it is aligned to the active viewport when the geometry allows it.
    expected.delete(c.index);
    if (opts.linked) captureAnchor(c);
    else if (active && active !== c && ready(active)) moveTo(c, matchingSlice(active, c));
  } else if (now.index !== prev.index && !consume(c.index, 'index', now.index)) {
    propagateSlice(c);
  }
  if (now.voi !== prev.voi && !consume(c.index, 'voi', now.voi) && opts.windowLevel && c === active) propagateVoi(c);
  if (now.zoomPan !== prev.zoomPan && !consume(c.index, 'zoomPan', now.zoomPan) && opts.zoomPan && c === active) propagateZoomPan(c);
  scheduleGuides();
}

// ---------------------------------------------------------------------------------------------
// Manual link
// ---------------------------------------------------------------------------------------------

function captureAnchor(c: ViewportController): void {
  const p = currentPlane(c);
  if (p) anchors.set(c.index, { position: slicePosition(p, p.normal), normal: p.normal });
  else anchors.delete(c.index);
}

/** Links all visible viewports at their current slices (the offsets between them are kept while scrolling). */
export function setLinked(on: boolean): void {
  anchors.clear();
  if (on) for (const c of allControllers()) if (ready(c)) captureAnchor(c);
  useStore.getState().setSync({ linked: on });
}

// ---------------------------------------------------------------------------------------------
// Reference lines and 3D cursor
// ---------------------------------------------------------------------------------------------

let guidesQueued = false;

function scheduleGuides(): void {
  if (guidesQueued) return;
  guidesQueued = true;
  requestAnimationFrame(() => {
    guidesQueued = false;
    updateGuides();
  });
}

/** Guides each viewport should show now (exported for tests). */
export function computeGuides(): Map<number, Guides> {
  const s = useStore.getState();
  const active = controllerAt(s.activeIndex);
  const sp = active && ready(active) ? currentPlane(active) : undefined;
  const out = new Map<number, Guides>();
  for (const c of allControllers()) {
    const g: Guides = { lines: [] };
    const tp = ready(c) ? currentPlane(c) : undefined;
    if (tp && sp && c !== active && s.sync.referenceLines && sp.frameOfReferenceUid && sp.frameOfReferenceUid === tp.frameOfReferenceUid) {
      const line = referenceLine(sp, tp);
      if (line) g.lines.push(line);
    }
    if (tp && cursor && cursor.frameOfReferenceUid && cursor.frameOfReferenceUid === tp.frameOfReferenceUid) {
      const { planes, indices } = indexedPlanes(c.displaySet!);
      const m = nearestSlice(planes, cursor.point);
      // Only on the slice that contains the point (the nearest one, within half a slice spacing).
      if (m?.inside && indices[m.index] === c.getState().index) g.marker = planePixel(tp, cursor.point);
    }
    out.set(c.index, g);
  }
  return out;
}

function updateGuides(): void {
  const guides = computeGuides();
  for (const c of allControllers()) c.setGuides(guides.get(c.index) ?? { lines: [] });
}

/** Sets the 3D cursor at a canvas point of a viewport; linked viewports (same Frame of Reference) jump to it. */
export function setCursorAt(c: ViewportController, x: number, y: number): void {
  const plane = currentPlane(c);
  const px = c.canvasToPixel(x, y);
  if (!plane || !px) return;
  const point = planePoint(plane, px[0], px[1]);
  cursor = { point, ...(plane.frameOfReferenceUid ? { frameOfReferenceUid: plane.frameOfReferenceUid } : {}) };
  for (const t of allControllers()) {
    if (t === c || !ready(t)) continue;
    const tp = currentPlane(t);
    if (!tp || !plane.frameOfReferenceUid || tp.frameOfReferenceUid !== plane.frameOfReferenceUid) continue;
    const { planes, indices } = indexedPlanes(t.displaySet!);
    const m = cursorTarget(planes, point);
    if (m?.inside) moveTo(t, indices[m.index]);
  }
  scheduleGuides();
}

export function clearCursor(): void {
  cursor = undefined;
  scheduleGuides();
}

export function cursorPoint(): Vec3 | undefined {
  return cursor?.point;
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

const subscribed = new Map<ViewportController, () => void>();

function cursorDown(c: ViewportController, e: PointerEvent): void {
  if (useStore.getState().tool !== 'cursor3d' || e.button !== 0) return;
  const r = c.viewportElement.getBoundingClientRect();
  setCursorAt(c, e.clientX - r.left, e.clientY - r.top);
}

function cursorMove(c: ViewportController, e: PointerEvent): void {
  if (useStore.getState().tool !== 'cursor3d' || (e.buttons & 1) === 0) return;
  const r = c.viewportElement.getBoundingClientRect();
  setCursorAt(c, e.clientX - r.left, e.clientY - r.top);
}

function rewire(): void {
  const live = new Set(allControllers());
  for (const [c, off] of subscribed) {
    if (!live.has(c)) {
      off();
      subscribed.delete(c);
      seen.delete(c.index);
      expected.delete(c.index);
      anchors.delete(c.index);
    }
  }
  for (const c of live) {
    if (subscribed.has(c)) continue;
    const down = (e: PointerEvent): void => cursorDown(c, e);
    const move = (e: PointerEvent): void => cursorMove(c, e);
    c.viewportElement.addEventListener('pointerdown', down);
    c.viewportElement.addEventListener('pointermove', move);
    const unsub = c.subscribe((vs) => onState(c, vs));
    subscribed.set(c, () => {
      unsub();
      c.viewportElement.removeEventListener('pointerdown', down);
      c.viewportElement.removeEventListener('pointermove', move);
    });
  }
  scheduleGuides();
}

let started = false;

export function initSync(): void {
  if (started) return;
  started = true;
  onControllersChanged(rewire);
  rewire();
  useStore.subscribe((s, prev) => {
    if (s.activeIndex !== prev.activeIndex || s.sync !== prev.sync) scheduleGuides();
    if (s.tool !== prev.tool && prev.tool === 'cursor3d') clearCursor();
    if (s.studies.length === 0 && prev.studies.length > 0) {
      anchors.clear();
      cursor = undefined;
    }
  });
}
