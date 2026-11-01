/** Application state (zustand). Clinical logic lives in @ahdicom/dicom-core; this only orchestrates UI state. */
import { create } from 'zustand';
import { buildStudies, type DisplaySet, type InstanceRecord, type SortDirection, type SortKey, type StudyNode } from '@ahdicom/dicom-core';
import type { AppInfo, ScanProgress, ScanSummary, ZipPasswordRequest } from '../../../shared/api';
import type { RecentEntryPublic, Settings } from '../../../shared/schemas';
import type { LeftTool } from '../viewer/cornerstone';

export type LayoutSpec = { kind: 'grid'; rows: number; cols: number } | { kind: '1+2' } | { kind: '2+1' };
export type RightTab = 'measurements' | 'tags' | 'info';
export type DialogKind = 'about' | 'shortcuts' | 'settings' | 'windowLevel' | null;

export const MAX_VIEWPORTS = 25;

export function viewportCount(l: LayoutSpec): number {
  return l.kind === 'grid' ? l.rows * l.cols : 3;
}

/** Series comparison options (M3). */
export interface SyncOptions {
  /** Automatic slice sync between display sets in the same Frame of Reference with near-parallel planes. */
  slice: boolean;
  /** Reference lines of the active viewport's slice on the other viewports. */
  referenceLines: boolean;
  /** Manual link of all visible viewports, keeping the slice offset captured when linking. */
  linked: boolean;
  /** Window/level follows the active viewport (same modality only). */
  windowLevel: boolean;
  /** Zoom and pan follow the active viewport. */
  zoomPan: boolean;
}

/** A modal text/number question from a measurement tool (annotation text, calibration length). */
export interface PromptRequest {
  kind: 'text' | 'calibrate';
  initial: string;
  /** Extra context shown above the input (e.g. the measured length before calibration). */
  detail?: string;
  resolve(value: string | null): void;
}

export interface Notice {
  id: number;
  kind: 'info' | 'warning' | 'error';
  text: string;
}

interface State {
  ready: boolean;
  appInfo?: AppInfo;
  settings: Settings;
  instances: InstanceRecord[];
  studies: StudyNode[];
  displaySets: Record<string, DisplaySet>;
  sortKey: SortKey;
  sortDirection: SortDirection;
  scans: Record<string, ScanProgress>;
  lastSummary?: ScanSummary;
  layout: LayoutSpec;
  slots: (string | undefined)[];
  activeIndex: number;
  maximizedIndex: number | null;
  tool: LeftTool;
  leftOpen: boolean;
  rightOpen: boolean;
  rightTab: RightTab;
  fullscreen: boolean;
  dialog: DialogKind;
  showInfoOverlay: boolean;
  showDicomOverlays: boolean;
  zipRequest?: ZipPasswordRequest;
  notices: Notice[];
  recent: RecentEntryPublic[];
  pinnedTags: string[];
  /** Display sets currently playing cine, per viewport index. */
  cine: Record<number, boolean>;
  /** Manual calibrations per SeriesInstanceUID (mm per pixel). */
  calibrations: Record<string, { rowMm: number; columnMm: number }>;
  prompt?: PromptRequest;
  /** Incremented whenever measurements change (the measurement list re-reads them). */
  measureRev: number;
  sync: SyncOptions;
  /** Series whose volumes the user combined into one display set. */
  combinedSeries: string[];
}

interface Actions {
  setReady(ready: boolean): void;
  setAppInfo(info: AppInfo): void;
  setSettings(s: Settings): void;
  addInstances(list: InstanceRecord[]): void;
  clearAll(): void;
  setSort(key: SortKey, direction: SortDirection): void;
  setScan(p: ScanProgress): void;
  finishScan(s: ScanSummary): void;
  setLayout(l: LayoutSpec): void;
  assign(index: number, displaySetId: string | undefined): void;
  setActive(index: number): void;
  toggleMaximize(index: number): void;
  setTool(t: LeftTool): void;
  toggleLeft(): void;
  toggleRight(): void;
  setRightTab(t: RightTab): void;
  setFullscreen(on: boolean): void;
  setDialog(d: DialogKind): void;
  toggleInfoOverlay(): void;
  toggleDicomOverlays(): void;
  setZipRequest(r: ZipPasswordRequest | undefined): void;
  notify(kind: Notice['kind'], text: string): void;
  dismissNotice(id: number): void;
  setRecent(r: RecentEntryPublic[]): void;
  togglePin(tag: string): void;
  setCine(index: number, on: boolean): void;
  setCalibration(seriesInstanceUid: string, c: { rowMm: number; columnMm: number } | undefined): void;
  setPrompt(p: PromptRequest | undefined): void;
  replaceCalibrations(c: Record<string, { rowMm: number; columnMm: number }>): void;
  bumpMeasureRev(): void;
  setSync(patch: Partial<SyncOptions>): void;
  toggleCombined(seriesInstanceUid: string): void;
}

let noticeId = 0;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State & Actions>()((set, get) => {
  const rebuild = (): void => {
    rebuildTimer = undefined;
    const { instances, sortKey, sortDirection, slots, combinedSeries } = get();
    const studies = buildStudies(instances, { sortKey, sortDirection, combineVolumes: new Set(combinedSeries) });
    const displaySets: Record<string, DisplaySet> = {};
    for (const st of studies) for (const se of st.series) for (const ds of se.displaySets) displaySets[ds.id] = ds;
    let nextSlots = slots;
    // Show the first image display set as soon as it exists (first image visible while the rest streams in).
    if (!slots.some((s) => s && displaySets[s])) {
      const first = studies.flatMap((s) => s.series.flatMap((se) => se.displaySets)).find((d) => d.kind !== 'nonImage');
      if (first) nextSlots = [first.id, ...slots.slice(1)];
    }
    set({ studies, displaySets, slots: nextSlots });
  };

  return {
    ready: false,
    settings: undefined as unknown as Settings,
    instances: [],
    studies: [],
    displaySets: {},
    sortKey: 'spatial',
    sortDirection: 'asc',
    scans: {},
    layout: { kind: 'grid', rows: 1, cols: 1 },
    slots: Array.from({ length: MAX_VIEWPORTS }, () => undefined),
    activeIndex: 0,
    maximizedIndex: null,
    tool: 'windowLevel',
    leftOpen: true,
    rightOpen: true,
    rightTab: 'info',
    fullscreen: false,
    dialog: null,
    showInfoOverlay: true,
    showDicomOverlays: true,
    notices: [],
    recent: [],
    pinnedTags: [],
    cine: {},
    calibrations: {},
    measureRev: 0,
    sync: { slice: true, referenceLines: true, linked: false, windowLevel: false, zoomPan: false },
    combinedSeries: [],

    setReady: (ready) => set({ ready }),
    setAppInfo: (appInfo) => set({ appInfo }),
    setSettings: (settings) => set({ settings }),
    addInstances: (list) => {
      set({ instances: get().instances.concat(list) });
      if (!rebuildTimer) rebuildTimer = setTimeout(rebuild, get().studies.length === 0 ? 0 : 150);
    },
    clearAll: () =>
      set({
        instances: [],
        studies: [],
        displaySets: {},
        slots: Array.from({ length: MAX_VIEWPORTS }, () => undefined),
        activeIndex: 0,
        maximizedIndex: null,
        lastSummary: undefined,
        cine: {},
        calibrations: {},
      }),
    setSort: (sortKey, sortDirection) => {
      set({ sortKey, sortDirection });
      rebuild();
    },
    setScan: (p) => set({ scans: { ...get().scans, [p.scanId]: p } }),
    finishScan: (s) => {
      const scans = { ...get().scans };
      delete scans[s.scanId];
      set({ scans, lastSummary: s });
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
        rebuild();
      }
    },
    setLayout: (layout) => {
      const n = viewportCount(layout);
      const { slots, displaySets, activeIndex } = get();
      const shown = new Set(slots.slice(0, n).filter(Boolean));
      const queue = Object.values(displaySets).filter((d) => d.kind !== 'nonImage' && !shown.has(d.id));
      const next = [...slots];
      for (let i = 0; i < n; i++) if (!next[i] || !displaySets[next[i]!]) next[i] = queue.shift()?.id;
      set({ layout, slots: next, maximizedIndex: null, activeIndex: Math.min(activeIndex, n - 1) });
    },
    assign: (index, id) => {
      const slots = [...get().slots];
      slots[index] = id;
      set({ slots, activeIndex: index });
    },
    setActive: (activeIndex) => set({ activeIndex }),
    toggleMaximize: (index) => set({ maximizedIndex: get().maximizedIndex === index ? null : index, activeIndex: index }),
    setTool: (tool) => set({ tool }),
    toggleLeft: () => set({ leftOpen: !get().leftOpen }),
    toggleRight: () => set({ rightOpen: !get().rightOpen }),
    setRightTab: (rightTab) => set({ rightTab, rightOpen: true }),
    setFullscreen: (fullscreen) => set({ fullscreen }),
    setDialog: (dialog) => set({ dialog }),
    toggleInfoOverlay: () => set({ showInfoOverlay: !get().showInfoOverlay }),
    toggleDicomOverlays: () => set({ showDicomOverlays: !get().showDicomOverlays }),
    setZipRequest: (zipRequest) => set({ zipRequest }),
    notify: (kind, text) => {
      const id = ++noticeId;
      set({ notices: [...get().notices, { id, kind, text }].slice(-4) });
      setTimeout(() => get().dismissNotice(id), kind === 'error' ? 12000 : 6000);
    },
    dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
    setRecent: (recent) => set({ recent }),
    togglePin: (tag) => {
      const p = get().pinnedTags;
      set({ pinnedTags: p.includes(tag) ? p.filter((t) => t !== tag) : [...p, tag] });
    },
    setCine: (index, on) => set({ cine: { ...get().cine, [index]: on } }),
    setPrompt: (prompt) => set({ prompt }),
    replaceCalibrations: (calibrations) => set({ calibrations }),
    bumpMeasureRev: () => set({ measureRev: get().measureRev + 1 }),
    setSync: (patch) => set({ sync: { ...get().sync, ...patch } }),
    toggleCombined: (uid) => {
      const cur = get().combinedSeries;
      set({ combinedSeries: cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid] });
      rebuild();
    },
    setCalibration: (uid, c) => {
      const next = { ...get().calibrations };
      if (c) next[uid] = c;
      else delete next[uid];
      set({ calibrations: next });
    },
  };
});

/** Display set shown in a viewport slot. */
export function displaySetAt(index: number): DisplaySet | undefined {
  const s = useStore.getState();
  const id = s.slots[index];
  return id ? s.displaySets[id] : undefined;
}
