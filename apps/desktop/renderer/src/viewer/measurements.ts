/**
 * Measurement and annotation tools. Cornerstone tools draw and edit the handles; every number shown comes from
 * @ahdicom/dicom-core, computed on image-pixel coordinates with the spacing basis (D-043).
 */
import { cache, metaData, type Types } from '@cornerstonejs/core';
import {
  AngleTool,
  ArrowAnnotateTool,
  CobbAngleTool,
  EllipticalROITool,
  LabelTool,
  LengthTool,
  PlanarFreehandROITool,
  RectangleROITool,
  SplineROITool,
  annotation as csAnnotation,
  drawing,
  type Types as ToolTypes,
} from '@cornerstonejs/tools';
import {
  type DisplayImage,
  type DisplaySet,
  type InstanceRecord,
  type MeasureScale,
  type Point2,
  type RoiStats,
  type Vec3,
  angleDeg,
  cobbAngleDeg,
  dicomDateTimeSeconds,
  ellipseArea,
  ellipseBBox,
  ellipseFromHandles,
  insideEllipse,
  insidePolygon,
  lengthDecimals,
  lengthRatio,
  parseImageOrientation,
  patientToPixel,
  pointLineDistance,
  polygonArea,
  polygonBBox,
  polygonPerimeter,
  polylineLength,
  roiStats,
  scaleFromBasis,
  segmentLength,
  spacingBasis,
  suvBwFactor,
  ultrasoundScale,
} from '@ahdicom/dicom-core';
import { i18next } from '../i18n';
import { useStore } from '../state/store';
import { modalityLutApplied } from './lut';

export type MeasureTool =
  | 'length'
  | 'angle'
  | 'cobb'
  | 'deviation'
  | 'ratio'
  | 'ellipse'
  | 'rectangle'
  | 'polygon'
  | 'polyline'
  | 'freehand'
  | 'arrow'
  | 'text'
  | 'calibrate';

export const MEASURE_TOOLS: readonly MeasureTool[] = [
  'length',
  'angle',
  'cobb',
  'deviation',
  'ratio',
  'ellipse',
  'rectangle',
  'polygon',
  'polyline',
  'freehand',
  'arrow',
  'text',
  'calibrate',
];

type AnyAnnotation = ToolTypes.Annotation;
type Data = AnyAnnotation['data'] & {
  handles?: { points?: Types.Point3[]; activeHandleIndex?: number | null };
  contour?: { polyline?: Types.Point3[]; closed?: boolean };
  label?: string;
  /** User-given name (measurement list rename). */
  cdvName?: string;
};

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

/** Point-to-line distance: the first two points define the reference line, the third is measured. */
class DeviationTool extends AngleTool {
  static override toolName = 'CdvDeviation';

  constructor(toolProps = {}) {
    super(toolProps);
    this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
      const { viewport } = enabledElement;
      const { element } = viewport;
      let annotations = csAnnotation.state.getAnnotations(this.getToolName(), element);
      if (!annotations?.length) return false;
      annotations = this.filterInteractableAnnotationsForElement(element, annotations) ?? [];
      // Stack viewports only (the app has no volume viewports yet); the type union is wider than the runtime value.
      const targetId = this.getTargetId(viewport as unknown as Types.IViewport) ?? '';
      let rendered = false;
      for (const a of annotations) {
        const uid = a.annotationUID!;
        const data = a.data as Data;
        const points = data.handles?.points ?? [];
        const styleSpecifier = { toolGroupId: this.toolGroupId, toolName: this.getToolName(), viewportId: viewport.id, annotationUID: uid };
        const { color, lineWidth, lineDash } = this.getAnnotationStyle({ annotation: a, styleSpecifier }) as {
          color: string;
          lineWidth: number;
          lineDash: string;
        };
        const canvas = points.map((p) => viewport.worldToCanvas(p));
        const active = data.handles?.activeHandleIndex;
        if (active !== null && active !== undefined && canvas[active]) {
          drawing.drawHandles(svgDrawingHelper, uid, '0', [canvas[active]], { color, lineDash, lineWidth });
        }
        if (canvas.length < 2) continue;
        drawing.drawLine(svgDrawingHelper, uid, '1', canvas[0]!, canvas[1]!, { color, width: lineWidth, lineDash });
        rendered = true;
        if (canvas.length < 3) continue;
        // Perpendicular foot of the measured point on the reference line (screen space keeps physical angles).
        const [a0, a1, p] = [canvas[0]!, canvas[1]!, canvas[2]!];
        const dx = a1[0] - a0[0];
        const dy = a1[1] - a0[1];
        const l2 = dx * dx + dy * dy || 1;
        const t = ((p[0] - a0[0]) * dx + (p[1] - a0[1]) * dy) / l2;
        const foot: Types.Point2 = [a0[0] + t * dx, a0[1] + t * dy];
        drawing.drawLine(svgDrawingHelper, uid, '2', p, foot, { color, width: lineWidth, lineDash: '4,3' });
        if (t < 0 || t > 1)
          drawing.drawLine(svgDrawingHelper, uid, '3', t < 0 ? a0 : a1, foot, { color, width: lineWidth, lineDash: '2,4' });
        const textLines = textLinesFor('deviation', data, targetId);
        if (textLines.length === 0) continue;
        this.renderLinkedTextBoxAnnotation({
          enabledElement,
          svgDrawingHelper,
          annotation: a,
          styleSpecifier,
          textLines,
          canvasCoordinates: canvas,
          placementPoints: [p, p],
        });
      }
      return rendered;
    };
  }
}

/** Ratio of two independently drawn lengths (A ÷ B). */
class LengthRatioTool extends CobbAngleTool {
  static override toolName = 'CdvLengthRatio';
}

/** Closed polygon, clicked point by point (double-click or click on the first point closes it). */
class PolygonTool extends SplineROITool {
  static override toolName = 'CdvPolygon';
}

/** Open polyline, clicked point by point (double-click ends it). */
class PolylineTool extends SplineROITool {
  static override toolName = 'CdvPolyline';

  constructor(toolProps = {}) {
    super(toolProps);
    // SplineROITool draws its text box only for closed splines; an open polyline shows its length too.
    (this as unknown as { _renderStats: (a: AnyAnnotation, e: Types.IEnabledElement, svg: ToolTypes.SVGDrawingHelper) => void })._renderStats = (
      annotation,
      enabledElement,
      svgDrawingHelper,
    ) => {
      const { viewport } = enabledElement;
      const data = annotation.data as Data;
      const points = data.handles?.points ?? [];
      if (points.length < 2) return;
      const textLines = textLinesFor('polyline', data, this.getTargetId(viewport as unknown as Types.IViewport) ?? '');
      if (textLines.length === 0) return;
      this.renderLinkedTextBoxAnnotation({
        enabledElement,
        svgDrawingHelper,
        annotation,
        styleSpecifier: { toolGroupId: this.toolGroupId, toolName: this.getToolName(), viewportId: viewport.id, annotationUID: annotation.annotationUID },
        textLines,
        canvasCoordinates: points.map((p) => viewport.worldToCanvas(p)),
        textBoxUID: 'textBox',
      });
    };
  }
}

/** A line whose true length the user enters to calibrate the series. */
class CalibrationTool extends LengthTool {
  static override toolName = 'CdvCalibrate';
}

export const TOOL_CLASSES: Record<MeasureTool, { toolName: string }> = {
  length: LengthTool,
  angle: AngleTool,
  cobb: CobbAngleTool,
  deviation: DeviationTool,
  ratio: LengthRatioTool,
  ellipse: EllipticalROITool,
  rectangle: RectangleROITool,
  polygon: PolygonTool,
  polyline: PolylineTool,
  freehand: PlanarFreehandROITool,
  arrow: ArrowAnnotateTool,
  text: LabelTool,
  calibrate: CalibrationTool,
};

export const toolNameOf = (t: MeasureTool): string => TOOL_CLASSES[t].toolName;

export function measureToolOf(toolName: string): MeasureTool | undefined {
  return MEASURE_TOOLS.find((t) => TOOL_CLASSES[t].toolName === toolName);
}

/** Text entry for arrows and labels, provided by the UI (a modal dialog). */
let askText: (initial: string) => Promise<string | null> = () => Promise.resolve(null);

export function setTextPrompt(fn: (initial: string) => Promise<string | null>): void {
  askText = fn;
}

const textCallback = (done: (text: string) => void): void => {
  void askText('').then((t) => done(t?.trim() ?? ''));
};
const changeTextCallback = (data: { data?: { label?: string } }, _evt: unknown, done: (text: string) => void): void => {
  const current = data.data?.label ?? '';
  void askText(current).then((t) => done(t === null ? current : t.trim() || current));
};

/** Tool registration arguments for the shared tool group. */
export function measureToolConfigs(): { cls: unknown; name: string; config: Record<string, unknown> }[] {
  const lines = (kind: MeasureTool) => (data: Data, targetId: string | string[]) => textLinesFor(kind, data, targetId);
  const base = (kind: MeasureTool): Record<string, unknown> => ({ getTextLines: lines(kind) });
  return [
    { cls: LengthTool, name: LengthTool.toolName, config: base('length') },
    { cls: AngleTool, name: AngleTool.toolName, config: { ...base('angle'), showAngleArc: true } },
    { cls: CobbAngleTool, name: CobbAngleTool.toolName, config: base('cobb') },
    { cls: DeviationTool, name: DeviationTool.toolName, config: base('deviation') },
    { cls: LengthRatioTool, name: LengthRatioTool.toolName, config: base('ratio') },
    { cls: EllipticalROITool, name: EllipticalROITool.toolName, config: { ...base('ellipse'), calculateStats: false } },
    { cls: RectangleROITool, name: RectangleROITool.toolName, config: { ...base('rectangle'), calculateStats: false } },
    {
      cls: PolygonTool,
      name: PolygonTool.toolName,
      config: { ...base('polygon'), calculateStats: false, allowOpenSplines: false, spline: { type: 'LINEAR' } },
    },
    {
      cls: PolylineTool,
      name: PolylineTool.toolName,
      config: { ...base('polyline'), calculateStats: false, allowOpenSplines: true, spline: { type: 'LINEAR' } },
    },
    // PlanarFreehandROITool draws its text box only when calculateStats is on; Cornerstone's own statistics are computed
    // but never shown (the text comes from getTextLines).
    { cls: PlanarFreehandROITool, name: PlanarFreehandROITool.toolName, config: { ...base('freehand'), calculateStats: true } },
    { cls: ArrowAnnotateTool, name: ArrowAnnotateTool.toolName, config: { getTextCallback: textCallback, changeTextCallback } },
    { cls: LabelTool, name: LabelTool.toolName, config: { getTextCallback: textCallback, changeTextCallback } },
    { cls: CalibrationTool, name: CalibrationTool.toolName, config: base('calibrate') },
  ];
}

// ---------------------------------------------------------------------------------------------
// Image context: instance, plane mapping and scale
// ---------------------------------------------------------------------------------------------

interface ImageRef {
  ds: DisplaySet;
  image: DisplayImage;
  /**
   * The instance this image belongs to. Calibration (US regions, Imager Pixel Spacing, magnification), padding and
   * PET attributes can differ between the instances of one display set, so they are never taken from the first one.
   */
  inst: InstanceRecord;
  /** Earliest acquisition date/time of the display set (seconds), the QIBA reference for SUV decay correction. */
  earliestAcquisition?: number;
}

let refsFor: Record<string, DisplaySet> | undefined;
let refs = new Map<string, ImageRef>();

/** Display set, image and instance of a `cdv:` image id (rebuilt when the display sets change). */
export function imageRef(imageId: string): ImageRef | undefined {
  const { displaySets: sets, instances } = useStore.getState();
  if (sets !== refsFor) {
    refsFor = sets;
    refs = new Map();
    const byFile = new Map<string, InstanceRecord>();
    for (const inst of instances) byFile.set(inst.fileId, inst);
    for (const ds of Object.values(sets)) {
      let earliest: number | undefined;
      const members = ds.images.map((image) => byFile.get(image.fileId) ?? ds.firstInstance);
      for (const inst of members) {
        const t = dicomDateTimeSeconds(inst.acquisitionDate ?? inst.seriesDate, inst.acquisitionTime);
        if (t !== undefined && (earliest === undefined || t < earliest)) earliest = t;
      }
      ds.images.forEach((image, k) => {
        const id = image.frame ? `cdv:${image.fileId}?frame=${image.frame}` : `cdv:${image.fileId}`;
        refs.set(id, { ds, image, inst: members[k]!, ...(earliest !== undefined ? { earliestAcquisition: earliest } : {}) });
      });
    }
  }
  return refs.get(imageId);
}

interface Plane {
  ipp: Vec3;
  o: NonNullable<ReturnType<typeof parseImageOrientation>>;
  spacing: [number, number];
  frameOfReferenceUID?: string;
}

/**
 * Image planes by image id. Cornerstone drops an image's metadata when its series leaves every viewport, but its
 * measurements must still be saved and listed, so the plane is kept once known (cleared when studies are closed).
 */
const planes = new Map<string, Plane>();

export function clearPlaneCache(): void {
  planes.clear();
}

export function planeOf(imageId: string): Plane | undefined {
  const known = planes.get(imageId);
  if (known) return known;
  const p = metaData.get('imagePlaneModule', imageId) as
    | {
        imagePositionPatient?: number[];
        rowCosines?: number[];
        columnCosines?: number[];
        rowPixelSpacing?: number;
        columnPixelSpacing?: number;
      }
    | undefined;
  if (!p?.imagePositionPatient || !p.rowCosines || !p.columnCosines) return undefined;
  const o = parseImageOrientation([...p.rowCosines, ...p.columnCosines]);
  if (!o) return undefined;
  const plane: Plane = {
    ipp: [...p.imagePositionPatient] as unknown as Vec3,
    o,
    spacing: [p.rowPixelSpacing || 1, p.columnPixelSpacing || 1],
    frameOfReferenceUID: (p as { frameOfReferenceUID?: string }).frameOfReferenceUID,
  };
  planes.set(imageId, plane);
  return plane;
}

/** World points → image pixel coordinates [column, row] with the DICOM-correct inverse (R-002). */
export function worldToPixels(imageId: string, points: readonly Types.Point3[]): Point2[] | undefined {
  const plane = planeOf(imageId);
  if (!plane) return undefined;
  return points.map((w) => patientToPixel(w as unknown as Vec3, plane.ipp, plane.o, plane.spacing));
}

/** Image pixel coordinates → world points (for restoring saved measurements). */
export function pixelsToWorld(imageId: string, points: readonly Point2[]): Types.Point3[] | undefined {
  const plane = planeOf(imageId);
  if (!plane) return undefined;
  const [rs, cs] = plane.spacing;
  return points.map(
    ([c, r]) => [0, 1, 2].map((k) => plane.ipp[k]! + plane.o.row[k]! * cs * c + plane.o.column[k]! * rs * r) as unknown as Types.Point3,
  );
}

export type ScaleNote = 'uncalibrated' | 'usNoRegion' | 'usDifferentRegions' | 'usNotSpatial';

/** Scale for a measurement: manual calibration of the series, else the spacing basis, else ultrasound regions. */
export function scaleFor(ref: ImageRef, points: readonly Point2[]): { scale?: MeasureScale; note?: ScaleNote } {
  const manual = useStore.getState().calibrations[ref.ds.seriesInstanceUid];
  if (manual) return { scale: { basis: 'manual', rowMm: manual.rowMm, columnMm: manual.columnMm } };
  const inst = ref.inst;
  const basis = spacingBasis(inst, ref.image.geometry.pixelSpacing);
  const fromBasis = scaleFromBasis(basis);
  if (fromBasis) return { scale: fromBasis };
  if (basis.kind === 'ultrasound' && inst.ultrasoundRegions) {
    const us = ultrasoundScale(inst.ultrasoundRegions, points);
    if (us.ok) return { scale: us.scale };
    return { note: us.reason === 'noRegion' ? 'usNoRegion' : us.reason === 'differentRegions' ? 'usDifferentRegions' : 'usNotSpatial' };
  }
  return { note: 'uncalibrated' };
}

/** Image-wide scale without ultrasound regions (used by manual calibration to keep the pixel aspect ratio). */
export function baseScale(ref: ImageRef): MeasureScale | undefined {
  return scaleFromBasis(spacingBasis(ref.inst, ref.image.geometry.pixelSpacing));
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

export type StatsUnit = 'hu' | 'bqml' | 'suv' | 'raw';

export interface MeasurementValue {
  tool: MeasureTool;
  /** Text lines shown next to the drawing and in the measurement list (first line is the headline). */
  lines: string[];
  /** Length in mm (lengths and calibration lines) — used for ellipsoid volume and calibration. */
  lengthMm?: number;
  /** Length in image pixels assuming the base aspect ratio — used by calibration. */
  pixelPoints?: Point2[];
  note?: ScaleNote;
}

function nf(value: number, decimals: number): string {
  const locale = i18next.language === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

function basisSuffix(scale: MeasureScale | undefined): string {
  if (!scale || scale.basis === 'pixelSpacing') return '';
  return ` (${i18next.t(`measure.basis.${scale.basis}`)})`;
}

function formatLength(mm: number, scale: MeasureScale | undefined): string {
  return scale ? `${nf(mm, lengthDecimals(scale))} mm${basisSuffix(scale)}` : `${nf(mm, 1)} px`;
}

function formatArea(value: number, scale: MeasureScale | undefined): string {
  if (!scale) return `${nf(value, 0)} px²`;
  return value >= 100 ? `${nf(value / 100, 2)} cm²${basisSuffix(scale)}` : `${nf(value, 1)} mm²${basisSuffix(scale)}`;
}

function noteLine(note: ScaleNote | undefined): string[] {
  return note ? [`⚠ ${i18next.t(`measure.note.${note}`)}`] : [];
}

/** Modality value reader for ROI statistics (grayscale only); padding pixels are skipped. */
function valueReader(ref: ImageRef, image: Types.IImage): ((c: number, r: number) => number | undefined) | undefined {
  if (image.color) return undefined;
  const pd = image.getPixelData() as ArrayLike<number>;
  const scaled = Boolean((image as { preScale?: { scaled?: boolean } }).preScale?.scaled) || modalityLutApplied(image);
  const slope = scaled ? 1 : (image.slope ?? 1);
  const intercept = scaled ? 0 : (image.intercept ?? 0);
  const inst = ref.inst;
  const g = ref.image.geometry;
  const pad = inst.pixelPaddingValue;
  const padValue =
    pad === undefined
      ? undefined
      : pad * (g.rescaleSlope ?? inst.geometry.rescaleSlope ?? 1) + (g.rescaleIntercept ?? inst.geometry.rescaleIntercept ?? 0);
  const cols = image.columns;
  return (c, r) => {
    const v = pd[r * cols + c]! * slope + intercept;
    return padValue !== undefined && v === padValue ? undefined : v;
  };
}

function statsUnit(ref: ImageRef): { unit: StatsUnit; factor: number; refusal?: string } {
  const inst = ref.inst;
  if (inst.modality === 'CT' || inst.rescaleType === 'HU') return { unit: 'hu', factor: 1 };
  if (inst.modality === 'PT') {
    const suv = suvBwFactor(inst, ref.earliestAcquisition);
    if (suv.ok) return { unit: 'suv', factor: suv.factor };
    const refusal =
      suv.reason === 'missing'
        ? i18next.t('measure.suvMissing', { tags: suv.missing.join(', ') })
        : i18next.t(`measure.suvRefused.${suv.reason}`);
    return (inst.petUnits ?? '').toUpperCase() === 'BQML' ? { unit: 'bqml', factor: 1, refusal } : { unit: 'raw', factor: 1, refusal };
  }
  return { unit: 'raw', factor: 1 };
}

function statsLines(ref: ImageRef, s: RoiStats | undefined): string[] {
  if (!s) return [];
  const { unit, factor, refusal } = statsUnit(ref);
  const u = i18next.t(`measure.unit.${unit}`);
  const d = unit === 'suv' ? 2 : unit === 'hu' || unit === 'bqml' ? 1 : 1;
  const f = (v: number): string => nf(v * factor, d);
  const out = [
    `${i18next.t('measure.mean')} ${f(s.mean)} ${u}  ${i18next.t('measure.sd')} ${f(s.sd)}`,
    `${i18next.t('measure.min')} ${f(s.min)}  ${i18next.t('measure.max')} ${f(s.max)}  (n = ${s.count})`,
  ];
  if (refusal) out.push(`⚠ ${refusal}`);
  return out;
}

function areaStats(
  ref: ImageRef,
  imageId: string,
  bbox: Parameters<typeof roiStats>[2],
  inside: (c: number, r: number) => boolean,
): RoiStats | undefined {
  const image = cache.getImage(imageId);
  if (!image) return undefined;
  const read = valueReader(ref, image);
  if (!read) return undefined;
  return roiStats(image.columns, image.rows, bbox, inside, read);
}

/** Sorts four rectangle corners around their centroid so they form a simple polygon. */
function ringOrder(points: Point2[]): Point2[] {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  return [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

const dataImage = new WeakMap<object, string>();

/** Remembers which image an annotation belongs to (Cornerstone passes only `data` to getTextLines). */
export function rememberImage(a: AnyAnnotation): void {
  const id = a.metadata?.referencedImageId;
  if (id) dataImage.set(a.data, id);
}

function imageIdFromTarget(data: Data, targetId: string | string[] | undefined): string | undefined {
  const known = dataImage.get(data);
  if (known) return known;
  const t = Array.isArray(targetId) ? targetId[0] : targetId;
  return t?.startsWith('imageId:') ? t.slice('imageId:'.length) : undefined;
}

/** Value of one annotation; undefined when its image is unknown (e.g. the study was closed). */
export function measurementValue(tool: MeasureTool, data: Data, imageId: string): MeasurementValue | undefined {
  const ref = imageRef(imageId);
  if (!ref) return undefined;
  if (tool === 'arrow' || tool === 'text') return { tool, lines: data.label ? [data.label] : [] };
  // Freehand contours are their polyline; everything else (incl. linear-spline polygons) is defined by its handles.
  const world = tool === 'freehand' ? (data.contour?.polyline ?? []) : (data.handles?.points ?? []);
  const px = worldToPixels(imageId, world);
  if (!px) return undefined;
  const { scale, note } = scaleFor(ref, px);
  const notes = noteLine(note);
  switch (tool) {
    case 'length':
    case 'calibrate': {
      if (px.length < 2) return undefined;
      const len = segmentLength(px[0]!, px[1]!, scale).value;
      return { tool, lines: [formatLength(len, scale), ...notes], lengthMm: scale ? len : undefined, pixelPoints: [px[0]!, px[1]!], note };
    }
    case 'angle':
      if (px.length < 3) return undefined;
      return { tool, lines: [`${nf(angleDeg(px[0]!, px[1]!, px[2]!, scale), 1)}°`, ...(note === 'uncalibrated' ? [] : notes)], note };
    case 'cobb': {
      if (px.length < 4) return undefined;
      const c = cobbAngleDeg(px[0]!, px[1]!, px[2]!, px[3]!, scale);
      return { tool, lines: [`${nf(c.acute, 1)}°`, ...(note === 'uncalibrated' ? [] : notes)], note };
    }
    case 'deviation': {
      if (px.length < 3) return undefined;
      return { tool, lines: [formatLength(pointLineDistance(px[0]!, px[1]!, px[2]!, scale).value, scale), ...notes], note };
    }
    case 'ratio': {
      if (px.length < 4) return undefined;
      const a = segmentLength(px[0]!, px[1]!, scale).value;
      const b = segmentLength(px[2]!, px[3]!, scale).value;
      const r = lengthRatio(px[0]!, px[1]!, px[2]!, px[3]!, scale);
      return {
        tool,
        lines: [`A/B = ${Number.isFinite(r) ? nf(r, 2) : '—'}`, `A ${formatLength(a, scale)}  B ${formatLength(b, scale)}`, ...notes],
        note,
      };
    }
    case 'ellipse': {
      if (px.length < 4) return undefined;
      const [bottom, top, left, right] = px as [Point2, Point2, Point2, Point2];
      const e = ellipseFromHandles(top, bottom, left, right);
      const s = areaStats(ref, imageId, ellipseBBox(e), (c, r) => insideEllipse(e, c, r));
      return {
        tool,
        lines: [`${i18next.t('measure.area')} ${formatArea(ellipseArea(e, scale).value, scale)}`, ...statsLines(ref, s), ...notes],
        note,
      };
    }
    case 'rectangle': {
      if (px.length < 4) return undefined;
      const ring = ringOrder(px);
      const s = areaStats(ref, imageId, polygonBBox(ring), (c, r) => insidePolygon(ring, c, r));
      return {
        tool,
        lines: [`${i18next.t('measure.area')} ${formatArea(polygonArea(ring, scale).value, scale)}`, ...statsLines(ref, s), ...notes],
        note,
      };
    }
    case 'polygon':
    case 'polyline':
    case 'freehand': {
      if (px.length < 2) return undefined;
      const closed = tool === 'polygon' || (tool === 'freehand' && data.contour?.closed !== false);
      if (!closed || px.length < 3)
        return { tool, lines: [`${i18next.t('measure.length')} ${formatLength(polylineLength(px, scale).value, scale)}`, ...notes], note };
      const s = areaStats(ref, imageId, polygonBBox(px), (c, r) => insidePolygon(px, c, r));
      return {
        tool,
        lines: [
          `${i18next.t('measure.area')} ${formatArea(polygonArea(px, scale).value, scale)}`,
          `${i18next.t('measure.perimeter')} ${formatLength(polygonPerimeter(px, scale).value, scale)}`,
          ...statsLines(ref, s),
          ...notes,
        ],
        note,
      };
    }
  }
}

function textLinesFor(tool: MeasureTool, data: Data, targetId: string | string[]): string[] {
  const imageId = imageIdFromTarget(data, targetId);
  if (!imageId) return [];
  try {
    const lines = measurementValue(tool, data, imageId)?.lines ?? [];
    return data.cdvName && lines.length > 0 ? [data.cdvName, ...lines] : lines;
  } catch {
    return [];
  }
}
