/**
 * MPR crosshair interaction. In a reformat, the planes of the other reformats of the same volume are drawn as
 * coloured lines (computed by the sync engine). Dragging a line moves that plane, dragging one of its handles turns
 * it about this view's normal through the crosshair centre (oblique MPR), and dragging the centre moves both other
 * planes. This works whatever the left-button tool is: the hit test runs on pointerdown, before Cornerstone sees the
 * (then suppressed) mouse events. With a measurement tool selected only the handles and the centre can be grabbed,
 * so a measurement can start anywhere on a line.
 */
import type { Vec3 } from '@ahdicom/dicom-core';
import { useStore } from '../state/store';
import type { ViewportController } from './controller';
import { MEASURE_TOOLS } from './measurements';
import { allControllers, controllerAt, onControllersChanged } from './registry';
import { crosshairCenter, mprPartners } from './sync';

type Grab =
  | { kind: 'move'; target: number }
  | { kind: 'center' }
  | { kind: 'rotate'; target: number; center: Vec3; centerCanvas: [number, number]; last: number };

const LINE_PX = 6;
const HANDLE_PX = 9;
const CENTER_PX = 10;

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** What a press at canvas (x, y) of viewport c grabs: the centre, a rotation handle or a line. */
export function crosshairHit(c: ViewportController, x: number, y: number): Grab | undefined {
  const lines = c.crosshairOnCanvas();
  if (lines.length === 0) return undefined;
  const g = c.getGuides();
  const center = g.center ? c.pixelToCanvas(g.center[0], g.center[1]) : undefined;
  if (center && Math.hypot(x - center[0], y - center[1]) <= CENTER_PX) return { kind: 'center' };
  const centerWorld = crosshairCenter(c);
  for (const l of lines) {
    for (const h of l.handles) {
      if (center && centerWorld && Math.hypot(x - h[0], y - h[1]) <= HANDLE_PX) {
        return {
          kind: 'rotate',
          target: l.source,
          center: centerWorld,
          centerCanvas: center,
          last: Math.atan2(y - center[1], x - center[0]),
        };
      }
    }
  }
  const measuring = (MEASURE_TOOLS as readonly string[]).includes(useStore.getState().tool);
  if (measuring) return undefined;
  for (const l of lines) if (distanceToSegment([x, y], l.a, l.b) <= LINE_PX) return { kind: 'move', target: l.source };
  return undefined;
}

function drag(c: ViewportController, grab: Grab, x: number, y: number): void {
  if (grab.kind === 'rotate') {
    const angle = Math.atan2(y - grab.centerCanvas[1], x - grab.centerCanvas[0]);
    let delta = angle - grab.last;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    grab.last = angle;
    const normal = c.currentPlane()?.normal;
    // Canvas angles grow clockwise (y down); the camera normal points at the viewer, so a clockwise turn on screen
    // is a negative rotation about it.
    if (normal) controllerAt(grab.target)?.rotateView(normal, -delta, grab.center);
    return;
  }
  const p = c.canvasToPatient(x, y);
  if (!p) return;
  if (grab.kind === 'move') controllerAt(grab.target)?.moveThrough(p);
  else for (const o of mprPartners(c)) o.moveThrough(p);
}

const wired = new Map<ViewportController, () => void>();

function wire(c: ViewportController): () => void {
  const el = c.viewportElement;
  let grab: Grab | undefined;
  const local = (e: PointerEvent): [number, number] => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const down = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const [x, y] = local(e);
    grab = crosshairHit(c, x, y);
    if (!grab) return;
    // Keeps Cornerstone (mouse events) from starting its own tool on this press.
    e.preventDefault();
    e.stopImmediatePropagation();
    el.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent): void => {
    const [x, y] = local(e);
    if (grab && e.buttons & 1) {
      e.stopImmediatePropagation();
      drag(c, grab, x, y);
      return;
    }
    const hover = crosshairHit(c, x, y);
    el.style.cursor = hover ? (hover.kind === 'rotate' ? 'grab' : 'move') : '';
  };
  const up = (e: PointerEvent): void => {
    if (!grab) return;
    grab = undefined;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };
  el.addEventListener('pointerdown', down, true);
  el.addEventListener('pointermove', move, true);
  el.addEventListener('pointerup', up, true);
  el.addEventListener('pointercancel', up, true);
  return () => {
    el.removeEventListener('pointerdown', down, true);
    el.removeEventListener('pointermove', move, true);
    el.removeEventListener('pointerup', up, true);
    el.removeEventListener('pointercancel', up, true);
  };
}

function rewire(): void {
  const live = new Set(allControllers());
  for (const [c, off] of wired) {
    if (!live.has(c)) {
      off();
      wired.delete(c);
    }
  }
  for (const c of live) if (!wired.has(c)) wired.set(c, wire(c));
}

let started = false;

export function initCrosshair(): void {
  if (started) return;
  started = true;
  onControllersChanged(rewire);
  rewire();
}
