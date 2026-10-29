/** Type of `window.api` exposed by the preload script. Types only — no runtime code. */
import type { InstanceRecord, OverlayLayer, TagNode } from '@clinic/dicom-core';
import type { OpenKind, RecentEntryPublic, Settings, SettingsPatch } from './schemas';

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  electron: string;
  chrome: string;
  node: string;
  isPackaged: boolean;
  e2e: boolean;
}

export type ScanErrorCode =
  | 'notDicom'
  | 'truncated'
  | 'malformed'
  | 'missingUids'
  | 'unsupportedDimensions'
  | 'truncatedPixelData'
  | 'deflateUnsupported'
  | 'readError'
  | 'tooLarge';

export interface ScanProgress {
  scanId: string;
  phase: 'listing' | 'extracting' | 'parsing';
  filesFound: number;
  filesDone: number;
  instances: number;
  skipped: number;
}

export interface ScanBatch {
  scanId: string;
  instances: InstanceRecord[];
}

export interface ScanSummary {
  scanId: string;
  instances: number;
  /** Files that were not DICOM (silently ignored). */
  notDicom: number;
  /** DICOM files that could not be indexed, by error code. */
  errors: Partial<Record<ScanErrorCode, number>>;
  archiveErrors: ('zipBomb' | 'zipTraversal' | 'zipPasswordCancelled' | 'zipPasswordWrong' | 'zipInvalid' | 'zipTooManyEntries')[];
  cancelled: boolean;
  usedDicomdir: boolean;
  durationMs: number;
}

export interface ZipPasswordRequest {
  requestId: string;
  archiveName: string;
  retry: boolean;
}

export type { TagNode, OverlayLayer } from '@clinic/dicom-core';

export type OpenResult = { started: true; scanId: string } | { started: false };

export interface Api {
  appInfo(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  setSettings(patch: SettingsPatch): Promise<Settings>;
  open(kind: OpenKind): Promise<OpenResult>;
  /** Files dropped on the window (paths resolved in the preload, never exposed to the page). */
  openDropped(files: File[]): Promise<OpenResult>;
  cancelScan(scanId: string): Promise<void>;
  readFile(fileId: string): Promise<Uint8Array>;
  readTags(fileId: string): Promise<TagNode[]>;
  readOverlays(fileId: string, frame: number): Promise<OverlayLayer[]>;
  fileLocation(fileId: string): Promise<string>;
  revealFile(fileId: string): Promise<void>;
  answerZipPassword(requestId: string, password: string | null): Promise<void>;
  recentList(): Promise<RecentEntryPublic[]>;
  recentOpen(id: string): Promise<OpenResult>;
  recentRemove(id: string): Promise<RecentEntryPublic[]>;
  setFullscreen(on: boolean): Promise<void>;
  clearSession(): Promise<void>;
  /** Writes plain text to the OS clipboard (tag browser copy). */
  copyText(text: string): Promise<void>;
  on(event: 'scan:progress', cb: (p: ScanProgress) => void): () => void;
  on(event: 'scan:batch', cb: (b: ScanBatch) => void): () => void;
  on(event: 'scan:done', cb: (s: ScanSummary) => void): () => void;
  on(event: 'zip:need-password', cb: (r: ZipPasswordRequest) => void): () => void;
  on(event: 'window:fullscreen-changed', cb: (on: boolean) => void): () => void;
}
