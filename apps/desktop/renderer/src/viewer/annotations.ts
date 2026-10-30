/**
 * Annotation lifecycle: links Cornerstone annotation events to the app (calibration, text entry, measurement list).
 */
import { eventTarget, getRenderingEngines, type Types } from '@cornerstonejs/core';
import {
  Enums as ToolEnums,
  annotation as csAnnotation,
  cancelActiveManipulations,
  state as toolState,
  type Types as ToolTypes,
} from '@cornerstonejs/tools';
import { manualScale } from '@ahdicom/dicom-core';
import { i18next } from '../i18n';
import { useStore } from '../state/store';
import {
  baseScale,
  imageRef,
  measureToolOf,
  measurementValue,
  rememberImage,
  setTextPrompt,
  worldToPixels,
  type MeasureTool,
} from './measurements';
import { commit, definingPoints, isRestoring, linesWithFallback, measurementAnnotations, syncStudies } from './measureDoc';

type Annotation = ToolTypes.Annotation;

/** Parses a positive number typed with either decimal separator ("12,5" or "12.5"). */
export function parsePositive(text: string): number | undefined {
  const v = Number(text.trim().replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function ask(kind: 'text' | 'calibrate', initial: string, detail?: string): Promise<string | null> {
  return new Promise((resolve) => useStore.getState().setPrompt({ kind, initial, ...(detail ? { detail } : {}), resolve }));
}

/** Re-renders every viewport (annotation text depends on calibration and language). */
export function renderAllViewports(): void {
  for (const engine of getRenderingEngines() ?? []) engine.render();
}

async function calibrateFrom(a: Annotation): Promise<void> {
  const imageId = a.metadata?.referencedImageId;
  const ref = imageId ? imageRef(imageId) : undefined;
  const value = imageId ? measurementValue('calibrate', a.data, imageId) : undefined;
  csAnnotation.state.removeAnnotation(a.annotationUID!);
  renderAllViewports();
  if (!ref || !value?.pixelPoints) return;
  const answer = await ask('calibrate', '', i18next.t('measure.calibrateDetail', { current: value.lines[0] ?? '' }));
  const mm = answer === null ? undefined : parsePositive(answer);
  if (mm === undefined) return;
  const [p0, p1] = value.pixelPoints as [readonly [number, number], readonly [number, number]];
  const scale = manualScale(p0, p1, mm, baseScale(ref));
  if (!scale) return;
  useStore.getState().setCalibration(ref.ds.seriesInstanceUid, { rowMm: scale.rowMm, columnMm: scale.columnMm });
  commit();
  useStore.getState().notify('info', i18next.t('measure.calibrated', { series: ref.ds.seriesDescription ?? ref.ds.seriesNumber ?? '' }));
  renderAllViewports();
}

/** A measurement whose points all lie within one image pixel (a click without a drag) carries no information. */
function isDegenerate(a: Annotation): boolean {
  const imageId = a.metadata?.referencedImageId;
  const data = a.data as { handles?: { points?: Types.Point3[] }; contour?: { polyline?: Types.Point3[] } };
  const world = data.contour?.polyline?.length ? data.contour.polyline : (data.handles?.points ?? []);
  const px = imageId ? worldToPixels(imageId, world) : undefined;
  if (!px || px.length === 0) return false;
  return px.every((p) => Math.hypot(p[0] - px[0]![0], p[1] - px[0]![1]) < 1);
}

let modifyTimer: ReturnType<typeof setTimeout> | undefined;

/** Commits edits once the user has finished dragging (modified events fire continuously during a drag). */
function commitWhenIdle(): void {
  clearTimeout(modifyTimer);
  modifyTimer = setTimeout(() => {
    if (isDrawing()) commitWhenIdle();
    else commit();
  }, 250);
}

let initialized = false;

export function initAnnotationEvents(): void {
  if (initialized) return;
  initialized = true;
  setTextPrompt((initial) => ask('text', initial));
  const { Events } = ToolEnums;
  eventTarget.addEventListener(Events.ANNOTATION_ADDED, (e: Event) => {
    const a = (e as CustomEvent<{ annotation: Annotation }>).detail.annotation;
    rememberImage(a);
  });
  eventTarget.addEventListener(Events.ANNOTATION_COMPLETED, (e: Event) => {
    const a = (e as CustomEvent<{ annotation: Annotation }>).detail.annotation;
    rememberImage(a);
    const tool = measureToolOf(a.metadata?.toolName ?? '');
    if (tool === 'calibrate') {
      void calibrateFrom(a);
      return;
    }
    if (tool && tool !== 'arrow' && tool !== 'text' && a.annotationUID && isDegenerate(a)) {
      csAnnotation.state.removeAnnotation(a.annotationUID);
      renderAllViewports();
      return;
    }
    if (tool && !isRestoring()) commit();
  });
  eventTarget.addEventListener(Events.ANNOTATION_MODIFIED, (e: Event) => {
    const a = (e as CustomEvent<{ annotation: Annotation }>).detail.annotation;
    const tool = measureToolOf(a.metadata?.toolName ?? '');
    if (tool && tool !== 'calibrate' && !isRestoring()) commitWhenIdle();
  });
  eventTarget.addEventListener(Events.ANNOTATION_REMOVED, (e: Event) => {
    const a = (e as CustomEvent<{ annotation: Annotation }>).detail.annotation;
    const tool = measureToolOf(a.metadata?.toolName ?? '');
    if (tool && tool !== 'calibrate' && !isRestoring()) commitWhenIdle();
  });
  useStore.subscribe((s, prev) => {
    if (s.studies !== prev.studies) {
      syncStudies().catch(() => console.warn('Saved measurements could not be restored'));
    }
  });
}

/** True while a measurement is being drawn or edited (keys then belong to the tool, e.g. Backspace removes a point). */
export function isDrawing(): boolean {
  return Boolean(toolState.isInteractingWithTool);
}

/** Cancels a measurement that is being drawn on the given viewport element. Returns true when one was cancelled. */
export function cancelDrawingOn(element: HTMLDivElement): boolean {
  return Boolean(cancelActiveManipulations(element));
}

export interface MeasurementEntry {
  uid: string;
  tool: MeasureTool;
  imageId: string;
  lines: string[];
  label?: string;
  name?: string;
  /** Length in mm (length measurements with a physical scale). */
  lengthMm?: number;
  /** Defining points in image pixel coordinates [column, row]. */
  pixels: [number, number][];
}

/** Every measurement currently held by Cornerstone, with its value lines. */
export function listMeasurements(): MeasurementEntry[] {
  const out: MeasurementEntry[] = [];
  for (const a of measurementAnnotations()) {
    const tool = measureToolOf(a.metadata?.toolName ?? '')!;
    const imageId = a.metadata?.referencedImageId;
    if (!imageId) continue;
    const data = a.data as {
      label?: string;
      cdvName?: string;
      handles?: { points?: Types.Point3[] };
      contour?: { polyline?: Types.Point3[] };
    };
    const pixels = (worldToPixels(imageId, definingPoints(tool, data)) ?? []).map((p) => [p[0], p[1]] as [number, number]);
    const value = measurementValue(tool, a.data, imageId);
    out.push({
      uid: a.annotationUID!,
      tool,
      imageId,
      lines: linesWithFallback(a.annotationUID!, imageId, value?.lines ?? []),
      pixels,
      ...(value?.lengthMm !== undefined ? { lengthMm: value.lengthMm } : {}),
      ...(data.label ? { label: data.label } : {}),
      ...(data.cdvName ? { name: data.cdvName } : {}),
    });
  }
  return out;
}

/** Removes the selected measurements. Returns how many were removed. */
export function deleteSelected(): number {
  const selected = csAnnotation.selection.getAnnotationsSelected() ?? [];
  let n = 0;
  for (const uid of selected) {
    const a = csAnnotation.state.getAnnotation(uid);
    if (!a || !measureToolOf(a.metadata?.toolName ?? '')) continue;
    csAnnotation.state.removeAnnotation(uid);
    n++;
  }
  if (n > 0) renderAllViewports();
  return n;
}
