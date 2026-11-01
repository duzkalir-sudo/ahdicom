import { parseImageOrientation, parseVec3, sameOrientation, sliceNormal, vec3, type ImageOrientation } from './geometry.js';
import { analyzeStack, parseDicomTime, sortImages } from './stack.js';
import type {
  DisplayImage,
  DisplaySet,
  InstanceRecord,
  SeriesNode,
  SortDirection,
  SortKey,
  StackWarning,
  StudyNode,
  VolumeSplitKey,
} from './types.js';

export interface BuildOptions {
  sortKey?: SortKey;
  sortDirection?: SortDirection;
  /** Series (SeriesInstanceUID) whose volumes are shown together instead of split. */
  combineVolumes?: ReadonlySet<string>;
}

/** Expands an instance into displayable images (one per frame). */
export function instanceImages(inst: InstanceRecord): DisplayImage[] {
  const base = {
    fileId: inst.fileId,
    sopInstanceUid: inst.sopInstanceUid,
    instanceNumber: inst.instanceNumber,
    fileName: inst.fileName,
    acquisitionTime: inst.acquisitionTime ?? inst.contentTime,
    acquisitionNumber: inst.acquisitionNumber,
  };
  if (inst.numberOfFrames <= 1) return [{ ...base, geometry: inst.geometry }];
  const images: DisplayImage[] = [];
  for (let f = 1; f <= inst.numberOfFrames; f++) {
    const pf = inst.perFrame?.[f - 1];
    images.push({ ...base, frame: f, geometry: pf ? { ...inst.geometry, ...pf } : inst.geometry });
  }
  return images;
}

function isImage(inst: InstanceRecord): boolean {
  return inst.hasPixelData && (inst.rows ?? 0) > 0 && (inst.columns ?? 0) > 0;
}

interface Group {
  orientation?: ImageOrientation;
  rows?: number;
  columns?: number;
  instances: InstanceRecord[];
}

const VOLUME_KEYS: { key: VolumeSplitKey; value: (i: InstanceRecord) => number | undefined }[] = [
  { key: 'temporal', value: (i) => i.geometry.temporalPositionIndex },
  { key: 'bValue', value: (i) => i.diffusionBValue },
  { key: 'echo', value: (i) => i.echoNumbers },
  { key: 'acquisition', value: (i) => i.acquisitionNumber },
];

/** Tolerance (mm) below which two slice positions count as the same location. */
const SAME_POSITION_MM = 0.01;

function distinctPositions(instances: readonly InstanceRecord[], o: ImageOrientation): number {
  const n = sliceNormal(o);
  const d = instances
    .map((i) => parseVec3(i.geometry.imagePositionPatient))
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
    .map((p) => vec3.dot(p, n))
    .sort((a, b) => a - b);
  let count = d.length > 0 ? 1 : 0;
  for (let k = 1; k < d.length; k++) if (d[k]! - d[k - 1]! >= SAME_POSITION_MM) count++;
  return count;
}

function hasDuplicatePositions(instances: readonly InstanceRecord[], o: ImageOrientation): boolean {
  const n = sliceNormal(o);
  const d = instances
    .map((i) => parseVec3(i.geometry.imagePositionPatient))
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
    .map((p) => vec3.dot(p, n))
    .sort((a, b) => a - b);
  for (let k = 1; k < d.length; k++) if (d[k]! - d[k - 1]! < SAME_POSITION_MM) return true;
  return false;
}

/**
 * A group of same-orientation images that repeats slice positions holds several volumes (multi-phase CT, DWI
 * b-values, multi-echo, repeated acquisitions). It is split by the first attribute that is present on every image,
 * takes at least two values and leaves no part with repeated positions, and only when every part covers at least two
 * positions (a real volume); otherwise it stays one group (and keeps its duplicate-position warning).
 */
export function splitVolumes(
  instances: readonly InstanceRecord[],
  o: ImageOrientation | undefined,
): { instances: InstanceRecord[]; splitBy?: { key: VolumeSplitKey; value: number } }[] {
  if (!o || instances.length < 2 || !hasDuplicatePositions(instances, o)) return [{ instances: [...instances] }];
  for (const { key, value } of VOLUME_KEYS) {
    const values = instances.map(value);
    if (values.some((v) => v === undefined)) continue;
    const byValue = new Map<number, InstanceRecord[]>();
    instances.forEach((inst, k) => byValue.set(values[k]!, [...(byValue.get(values[k]!) ?? []), inst]));
    if (byValue.size < 2) continue;
    const parts = [...byValue.entries()].sort((a, b) => a[0] - b[0]);
    if (parts.some(([, list]) => hasDuplicatePositions(list, o))) continue;
    // Only real volumes: a part with a single position is one frame of a dynamic/cine series at one location
    // (bolus tracking, single-slice cine), which must stay one scrollable stack.
    if (parts.some(([, list]) => distinctPositions(list, o) < 2)) continue;
    return parts.map(([v, list]) => ({ instances: list, splitBy: { key, value: v } }));
  }
  return [{ instances: [...instances] }];
}

/**
 * Splits a series into display sets:
 * - non-image instances (SR, PDF, …) → one 'nonImage' set each;
 * - multi-frame instances → one 'multiframe' set each;
 * - single-frame images → grouped by orientation and matrix size, multi-volume groups split per volume
 *   ({@link splitVolumes}), each group sorted and analyzed.
 */
export function buildDisplaySets(series: readonly InstanceRecord[], options: BuildOptions = {}): DisplaySet[] {
  const sortKey = options.sortKey ?? 'spatial';
  const sortDirection = options.sortDirection ?? 'asc';
  const result: DisplaySet[] = [];
  const first = series[0];
  if (!first) return result;

  const groups: Group[] = [];
  const multiframes: InstanceRecord[] = [];
  const nonImages: InstanceRecord[] = [];

  for (const inst of series) {
    if (!isImage(inst)) {
      nonImages.push(inst);
      continue;
    }
    if (inst.numberOfFrames > 1) {
      multiframes.push(inst);
      continue;
    }
    const o = parseImageOrientation(inst.geometry.imageOrientationPatient);
    const g = groups.find(
      (gr) =>
        gr.rows === inst.rows &&
        gr.columns === inst.columns &&
        ((gr.orientation === undefined && o === undefined) ||
          (gr.orientation !== undefined && o !== undefined && sameOrientation(gr.orientation, o))),
    );
    if (g) g.instances.push(inst);
    else groups.push({ orientation: o, rows: inst.rows, columns: inst.columns, instances: [inst] });
  }

  // Groups of equal orientation but different matrix are reported as mixedDimensions; different
  // orientations as mixedOrientations. Largest group first so the "main" stack is the first display set.
  groups.sort((a, b) => b.instances.length - a.instances.length);
  const splitWarnings: StackWarning[] = [];
  if (groups.length > 1) {
    const orientations = groups.map((g) => g.orientation);
    const distinctOrient = orientations.some((o, i) => i > 0 && !(o && orientations[0] && sameOrientation(o, orientations[0])));
    splitWarnings.push({ code: distinctOrient ? 'mixedOrientations' : 'mixedDimensions', value: groups.length });
  }

  let splitIndex = 0;
  const makeSet = (
    kind: DisplaySet['kind'],
    images: DisplayImage[],
    inst: InstanceRecord,
    extra: StackWarning[],
    splitBy?: DisplaySet['splitBy'],
  ): DisplaySet => {
    const sorted = sortImages(images, kind === 'multiframe' && sortKey === 'spatial' ? 'spatial' : sortKey, sortDirection);
    // Multi-frame without per-frame geometry keeps frame order without reporting a fallback.
    const isFrameOrder = kind === 'multiframe' && sorted.sortFallback;
    const { geometry, warnings } = analyzeStack(sorted.images, {
      sortedBy: isFrameOrder ? 'instanceNumber' : sorted.sortedBy,
      sortFallback: isFrameOrder ? false : sorted.sortFallback && images.length > 1,
    });
    if (inst.charsetUncertain) warnings.push({ code: 'charsetUncertain' });
    const ds: DisplaySet = {
      id: `${inst.seriesInstanceUid}#${splitIndex}`,
      studyInstanceUid: inst.studyInstanceUid,
      seriesInstanceUid: inst.seriesInstanceUid,
      splitIndex,
      modality: inst.modality,
      seriesNumber: inst.seriesNumber,
      seriesDescription: inst.seriesDescription,
      kind,
      images: sorted.images,
      firstInstance: inst,
      geometry,
      warnings: [...extra, ...warnings],
      ...(splitBy ? { splitBy } : {}),
    };
    splitIndex++;
    return ds;
  };

  for (const g of groups) {
    const parts = options.combineVolumes?.has(first.seriesInstanceUid)
      ? [{ instances: g.instances }]
      : splitVolumes(g.instances, g.orientation);
    for (const part of parts as { instances: InstanceRecord[]; splitBy?: DisplaySet['splitBy'] }[]) {
      const images = part.instances.flatMap(instanceImages);
      result.push(makeSet(images.length > 1 ? 'stack' : 'single', images, part.instances[0]!, splitWarnings, part.splitBy));
    }
  }
  multiframes.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
  for (const inst of multiframes) result.push(makeSet('multiframe', instanceImages(inst), inst, []));
  for (const inst of nonImages) {
    result.push({
      id: `${inst.seriesInstanceUid}#${splitIndex++}`,
      studyInstanceUid: inst.studyInstanceUid,
      seriesInstanceUid: inst.seriesInstanceUid,
      splitIndex: splitIndex - 1,
      modality: inst.modality,
      seriesNumber: inst.seriesNumber,
      seriesDescription: inst.seriesDescription,
      kind: 'nonImage',
      images: [],
      firstInstance: inst,
      geometry: { sortedBy: 'instanceNumber', sortFallback: false, spacings: [] },
      warnings: [{ code: 'nonImage' }],
    });
  }
  return result;
}

/** Normalizes a patient key so that the same patient groups together across studies. */
export function patientKey(inst: InstanceRecord): string {
  return `${(inst.patientId ?? '').trim()}|${(inst.patientName ?? '').trim()}|${(inst.patientBirthDate ?? '').trim()}`;
}

/**
 * Builds Study → Series → DisplaySet trees. De-duplicates by SOPInstanceUID (first occurrence wins).
 * Studies are ordered by date/time descending (newest first); series by SeriesNumber.
 */
export function buildStudies(instances: readonly InstanceRecord[], options: BuildOptions = {}): StudyNode[] {
  const seen = new Set<string>();
  const byStudy = new Map<string, Map<string, InstanceRecord[]>>();
  for (const inst of instances) {
    if (seen.has(inst.sopInstanceUid)) continue;
    seen.add(inst.sopInstanceUid);
    let study = byStudy.get(inst.studyInstanceUid);
    if (!study) byStudy.set(inst.studyInstanceUid, (study = new Map()));
    let series = study.get(inst.seriesInstanceUid);
    if (!series) study.set(inst.seriesInstanceUid, (series = []));
    series.push(inst);
  }

  const studies: StudyNode[] = [];
  for (const [studyUid, seriesMap] of byStudy) {
    const seriesNodes: SeriesNode[] = [];
    let ref: InstanceRecord | undefined;
    const modalities = new Set<string>();
    for (const [seriesUid, list] of seriesMap) {
      const first = list[0]!;
      ref ??= first;
      if (first.modality) modalities.add(first.modality);
      seriesNodes.push({
        seriesInstanceUid: seriesUid,
        modality: first.modality,
        seriesNumber: first.seriesNumber,
        seriesDescription: first.seriesDescription,
        instanceCount: list.length,
        displaySets: buildDisplaySets(list, options),
      });
    }
    seriesNodes.sort(
      (a, b) =>
        (a.seriesNumber ?? Number.MAX_SAFE_INTEGER) - (b.seriesNumber ?? Number.MAX_SAFE_INTEGER) ||
        (a.seriesDescription ?? '').localeCompare(b.seriesDescription ?? ''),
    );
    const r = ref!;
    studies.push({
      studyInstanceUid: studyUid,
      patientKey: patientKey(r),
      patientName: r.patientName,
      patientId: r.patientId,
      patientBirthDate: r.patientBirthDate,
      patientSex: r.patientSex,
      studyDate: r.studyDate,
      studyTime: r.studyTime,
      studyDescription: r.studyDescription,
      accessionNumber: r.accessionNumber,
      modalities: [...modalities].sort(),
      series: seriesNodes,
    });
  }
  studies.sort((a, b) => {
    const da = `${a.studyDate ?? ''}${String(parseDicomTime(a.studyTime) ?? 0).padStart(8, '0')}`;
    const db = `${b.studyDate ?? ''}${String(parseDicomTime(b.studyTime) ?? 0).padStart(8, '0')}`;
    return db.localeCompare(da);
  });
  return studies;
}
