/**
 * Preload (sandboxed, CommonJS). Exposes the single typed, allow-listed API as window.api.
 * No Node APIs and no raw ipcRenderer are exposed to the page.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { EVENTS, IPC, type EventName } from '../shared/channels';
import type { Api } from '../shared/api';
import type { OpenKind, SettingsPatch } from '../shared/schemas';

const ALLOWED_EVENTS = new Set<string>(Object.values(EVENTS));

const api: Api = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  open: (kind: OpenKind) => ipcRenderer.invoke(IPC.openDialog, kind),
  openDropped: (files: File[]) => {
    const paths = files
      .map((f) => {
        try {
          return webUtils.getPathForFile(f);
        } catch {
          return '';
        }
      })
      .filter((p) => p !== '');
    if (paths.length === 0) return Promise.resolve({ started: false as const });
    return ipcRenderer.invoke(IPC.openPaths, { paths });
  },
  cancelScan: (scanId: string) => ipcRenderer.invoke(IPC.scanCancel, scanId),
  readFile: (fileId: string) => ipcRenderer.invoke(IPC.fileRead, { fileId }),
  readTags: (fileId: string) => ipcRenderer.invoke(IPC.fileTags, { fileId }),
  readOverlays: (fileId: string, frame: number) => ipcRenderer.invoke(IPC.fileOverlays, { fileId, frame }),
  fileLocation: (fileId: string) => ipcRenderer.invoke(IPC.fileLocation, { fileId }),
  revealFile: (fileId: string) => ipcRenderer.invoke(IPC.fileReveal, { fileId }),
  answerZipPassword: (requestId: string, password: string | null) => ipcRenderer.invoke(IPC.zipPassword, { requestId, password }),
  recentList: () => ipcRenderer.invoke(IPC.recentList),
  recentOpen: (id: string) => ipcRenderer.invoke(IPC.recentOpen, { id }),
  recentRemove: (id: string) => ipcRenderer.invoke(IPC.recentRemove, { id }),
  setFullscreen: (on: boolean | 'toggle') => ipcRenderer.invoke(IPC.windowFullscreen, { on }),
  clearSession: () => ipcRenderer.invoke(IPC.sessionClear),
  copyText: (text: string) => ipcRenderer.invoke(IPC.clipboardWrite, { text }),
  loadMeasurements: (studyInstanceUid: string) => ipcRenderer.invoke(IPC.measurementsLoad, { studyInstanceUid }),
  saveMeasurements: (file) => ipcRenderer.invoke(IPC.measurementsSave, file),
  on: ((event: EventName, cb: (payload: unknown) => void) => {
    if (!ALLOWED_EVENTS.has(event)) throw new Error('event not allowed');
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  }) as Api['on'],
};

contextBridge.exposeInMainWorld('api', api);
