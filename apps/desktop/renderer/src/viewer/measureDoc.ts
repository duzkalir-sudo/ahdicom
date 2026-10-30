/**
 * The measurement document: serialization to SOP Instance UID + pixel coordinates, per-study persistence through the
 * main process, restore into Cornerstone, and undo/redo as a history of document snapshots.
 */
import { cache, getRenderingEngines, type Types } from '@cornerstonejs/core';
import { annotation as csAnnotation, splines, type Types as ToolTypes } from '@cornerstonejs/tools';
import { useStore } from '../state/store';
import { MEASUREMENTS_VERSION, type MeasurementFile, type MeasurementItem } from '../../../shared/schemas';
import {
  clearPlaneCache,
  imageRef,
  measureToolOf,
  pixelsToWorld,
  planeOf,
  rememberImage,
  toolNameOf,
  worldToPixels,
  type MeasureTool,
} from './measurements';
import { loadImageMetadata } from './cornerstone';

type Annotation = ToolTypes.Annotation;
type Calibrations = Record<string, { rowMm: number; columnMm: number }>;

interface SavedItem extends MeasurementItem {
  study: string;
}

interface Snapshot {
  items: SavedItem[];
  calibrations: Calibrations;
}

interface AnnotationData {
  handles?: { points?: Types.Point3[] };
  contour?: { polyline?: Types.Point3[]; closed?: boolean };
  label?: string;
  cdvName?: string;
}

const MAX_HISTORY = 100;
let history: string[] = [];
let historyIndex = -1;
/** True while annotations are being added/removed by restore, undo or redo (their events are not user edits). */
let restoring = false;
/** Saved items whose image is not (yet) indexed, per study; kept so saving never drops them. */
const pending = new Map<string, MeasurementItem[]>();
const loadedStudies = new Set<string>();
const lastSaved = new Map<string, string>();

/** Last value lines per measurement, for images whose pixels are no longer in memory (ROI statistics need them). */
const lastLines = new Map<string, string[]>();

/** Value lines of a measurement; falls back to the last computed lines when its image is not in memory. */
export function linesWithFallback(uid: string, imageId: string, lines: string[]): string[] {
  if (cache.getImage(imageId)) {
    lastLines.set(uid, lines);
    return lines;
  }
  return lastLines.get(uid) ?? lines;
}

export function isRestoring(): boolean {
  return restoring;
}

function bump(): void {
  useStore.getState().bumpMeasureRev();
}

export function renderAll(): void {
  for (const engine of getRenderingEngines() ?? []) engine.render();
}

/** Measurement annotations (calibration lines excluded) currently held by Cornerstone. */
export function measurementAnnotations(): Annotation[] {
  return csAnnotation.state.getAllAnnotations().filter((a) => {
    const tool = measureToolOf(a.metadata?.toolName ?? '');
    return tool !== undefined && tool !== 'calibrate' && a.annotationUID !== undefined;
  });
}

/** World points that define a measurement's geometry for saving and values. */
export function definingPoints(tool: MeasureTool, data: AnnotationData): Types.Point3[] {
  if (tool === 'freehand') return data.contour?.polyline ?? [];
  return data.handles?.points ?? [];
}

function serialize(a: Annotation): SavedItem | undefined {
  const tool = measureToolOf(a.metadata?.toolName ?? '');
  const imageId = a.metadata?.referencedImageId;
  const ref = imageId ? imageRef(imageId) : undefined;
  if (!tool || tool === 'calibrate' || !ref || !imageId || !a.annotationUID) return undefined;
  const data = a.data as AnnotationData;
  const px = worldToPixels(imageId, definingPoints(tool, data));
  if (!px || px.length === 0) return undefined;
  return {
    study: ref.ds.studyInstanceUid,
    id: a.annotationUID,
    tool: tool as MeasurementItem['tool'],
    sopInstanceUid: ref.image.sopInstanceUid,
    ...(ref.image.frame ? { frame: ref.image.frame } : {}),
    points: px.map((p) => [p[0], p[1]] as [number, number]),
    ...(tool === 'freehand' ? { closed: data.contour?.closed !== false } : {}),
    ...(data.label ? { label: data.label.slice(0, 200) } : {}),
    ...(data.cdvName ? { name: data.cdvName.slice(0, 100) } : {}),
  };
}

function snapshot(): Snapshot {
  const items: SavedItem[] = [];
  for (const a of measurementAnnotations()) {
    const it = serialize(a);
    if (it) items.push(it);
  }
  for (const [study, list] of pending) for (const it of list) items.push({ ...it, study });
  return { items, calibrations: { ...useStore.getState().calibrations } };
}

/** Image id of a saved item in the current session (file ids change between sessions; SOP UIDs do not). */
function imageIdFor(item: MeasurementItem): string | undefined {
  for (const ds of Object.values(useStore.getState().displaySets)) {
    for (const img of ds.images) {
      if (img.sopInstanceUid === item.sopInstanceUid && (img.frame ?? undefined) === (item.frame ?? undefined)) {
        return img.frame ? `cdv:${img.fileId}?frame=${img.frame}` : `cdv:${img.fileId}`;
      }
    }
  }
  return undefined;
}

function blankTextBox(): Record<string, unknown> {
  const z: Types.Point3 = [0, 0, 0];
  return { hasMoved: false, worldPosition: z, worldBoundingBox: { topLeft: z, topRight: z, bottomLeft: z, bottomRight: z } };
}

/** Adds a saved item to Cornerstone. Returns false when its image is not available. */
function restoreItem(item: MeasurementItem): boolean {
  const imageId = imageIdFor(item);
  if (!imageId) return false;
  const world = pixelsToWorld(imageId, item.points);
  const plane = planeOf(imageId);
  if (!world || !plane) return false;
  const r = plane.o.row;
  const c = plane.o.column;
  const normal = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]] as Types.Point3;
  const tool = item.tool;
  const base = { textBox: blankTextBox(), activeHandleIndex: null };
  let data: Record<string, unknown>;
  if (tool === 'freehand') {
    data = { handles: { points: [], ...base }, contour: { polyline: world, closed: item.closed !== false }, cachedStats: {} };
  } else if (tool === 'polygon' || tool === 'polyline') {
    data = {
      handles: { points: world, ...base },
      spline: { type: 'LINEAR', instance: new splines.LinearSpline() },
      contour: { polyline: [], closed: tool === 'polygon' },
      cachedStats: {},
    };
  } else {
    data = { handles: { points: world, ...base }, cachedStats: {} };
  }
  data.label = item.label ?? '';
  if (item.name) data.cdvName = item.name;
  const annotation = {
    annotationUID: item.id,
    highlighted: false,
    invalidated: true,
    isLocked: false,
    isVisible: true,
    autoGenerated: false,
    metadata: {
      toolName: toolNameOf(tool),
      referencedImageId: imageId,
      FrameOfReferenceUID: plane.frameOfReferenceUID,
      viewPlaneNormal: normal,
    },
    data,
  } as unknown as Annotation;
  csAnnotation.state.addAnnotation(annotation, plane.frameOfReferenceUID as string);
  rememberImage(annotation);
  return true;
}

function removeAllMeasurements(): void {
  for (const a of measurementAnnotations()) csAnnotation.state.removeAnnotation(a.annotationUID!);
}

function apply(json: string): void {
  const snap = JSON.parse(json) as Snapshot;
  restoring = true;
  try {
    removeAllMeasurements();
    pending.clear();
    for (const it of snap.items) {
      if (restoreItem(it)) continue;
      const { study, ...item } = it;
      pending.set(study, [...(pending.get(study) ?? []), item]);
    }
    useStore.getState().replaceCalibrations(snap.calibrations);
  } finally {
    restoring = false;
  }
  renderAll();
  bump();
}

/** Records the current document as a new undo step (no-op when nothing changed) and saves it. */
export function commit(): void {
  if (restoring) return;
  const json = JSON.stringify(snapshot());
  if (json === history[historyIndex]) {
    bump();
    return;
  }
  history = history.slice(0, historyIndex + 1);
  history.push(json);
  if (history.length > MAX_HISTORY) history.shift();
  historyIndex = history.length - 1;
  void save();
  bump();
}

export function canUndo(): boolean {
  return historyIndex > 0;
}

export function canRedo(): boolean {
  return historyIndex >= 0 && historyIndex < history.length - 1;
}

export function undo(): void {
  if (!canUndo()) return;
  historyIndex--;
  apply(history[historyIndex]!);
  void save();
}

export function redo(): void {
  if (!canRedo()) return;
  historyIndex++;
  apply(history[historyIndex]!);
  void save();
}

/** Writes every study whose saved content differs from the last write (an empty study deletes its file). */
async function save(): Promise<void> {
  const snap = JSON.parse(history[historyIndex] ?? JSON.stringify(snapshot())) as Snapshot;
  const seriesStudy = new Map<string, string>();
  for (const ds of Object.values(useStore.getState().displaySets)) seriesStudy.set(ds.seriesInstanceUid, ds.studyInstanceUid);
  const studies = new Set<string>([...lastSaved.keys(), ...snap.items.map((i) => i.study)]);
  for (const uid of Object.keys(snap.calibrations)) {
    const st = seriesStudy.get(uid);
    if (st) studies.add(st);
  }
  for (const study of studies) {
    const calibrations: Calibrations = {};
    for (const [series, c] of Object.entries(snap.calibrations)) if (seriesStudy.get(series) === study) calibrations[series] = c;
    const file: MeasurementFile = {
      version: MEASUREMENTS_VERSION,
      studyInstanceUid: study,
      calibrations,
      items: snap.items.filter((i) => i.study === study).map(({ study: _s, ...item }) => item),
    };
    const json = JSON.stringify(file);
    if (lastSaved.get(study) === json) continue;
    lastSaved.set(study, json);
    try {
      await window.api.saveMeasurements(file);
    } catch {
      lastSaved.delete(study);
      console.warn('Measurements could not be saved');
    }
  }
}

/** Makes the geometry of the images of these items known (reads headers of images not displayed yet). */
async function preparePlanes(items: readonly MeasurementItem[]): Promise<void> {
  const ids = new Set<string>();
  for (const it of items) {
    const id = imageIdFor(it);
    if (id && !planeOf(id)) ids.add(id);
  }
  await Promise.all([...ids].map((id) => loadImageMetadata(id).catch(() => undefined)));
}

/** Loads saved measurements of studies seen for the first time and restores items whose images are now indexed. */
export async function syncStudies(): Promise<void> {
  await preparePlanes([...pending.values()].flat());
  const studies = useStore.getState().studies.map((s) => s.studyInstanceUid);
  let changed = false;
  // Pending items whose images arrived in the meantime.
  restoring = true;
  try {
    for (const [study, list] of pending) {
      const still = list.filter((it) => !restoreItem(it));
      if (still.length !== list.length) changed = true;
      if (still.length) pending.set(study, still);
      else pending.delete(study);
    }
  } finally {
    restoring = false;
  }
  for (const study of studies) {
    if (loadedStudies.has(study) || !/^[0-9.]{1,64}$/.test(study)) continue;
    loadedStudies.add(study);
    const file = await window.api.loadMeasurements(study).catch(() => null);
    if (!file) continue;
    lastSaved.set(study, JSON.stringify(file));
    await preparePlanes(file.items);
    restoring = true;
    try {
      for (const it of file.items) {
        if (!restoreItem(it)) pending.set(study, [...(pending.get(study) ?? []), it]);
      }
      const cal = useStore.getState().calibrations;
      useStore.getState().replaceCalibrations({ ...cal, ...file.calibrations });
    } finally {
      restoring = false;
    }
    changed = true;
  }
  if (changed || historyIndex < 0) {
    // Loaded measurements are the new baseline: they cannot be undone.
    history = [JSON.stringify(snapshot())];
    historyIndex = 0;
    renderAll();
    bump();
  }
}

/** Saves, then forgets every measurement (used when all studies are closed). */
export async function resetMeasurements(): Promise<void> {
  await save();
  restoring = true;
  try {
    removeAllMeasurements();
  } finally {
    restoring = false;
  }
  pending.clear();
  loadedStudies.clear();
  lastSaved.clear();
  history = [];
  historyIndex = -1;
  lastLines.clear();
  clearPlaneCache();
  useStore.getState().replaceCalibrations({});
  bump();
}

/** Renames a measurement (shown in the list and above its value). */
export function renameMeasurement(uid: string, name: string): void {
  const a = csAnnotation.state.getAnnotation(uid);
  if (!a) return;
  const data = a.data as AnnotationData;
  const trimmed = name.trim().slice(0, 100);
  if (trimmed) data.cdvName = trimmed;
  else delete data.cdvName;
  a.invalidated = true;
  renderAll();
  commit();
}

export function removeMeasurement(uid: string): void {
  if (!csAnnotation.state.getAnnotation(uid)) return;
  csAnnotation.state.removeAnnotation(uid);
  renderAll();
  commit();
}
