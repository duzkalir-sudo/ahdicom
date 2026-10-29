/** IPC channel names. Imported by main, preload and renderer; contains no runtime dependencies. */
export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  openDialog: 'open:dialog',
  openPaths: 'open:paths',
  scanCancel: 'scan:cancel',
  fileRead: 'file:read',
  fileTags: 'file:tags',
  fileOverlays: 'file:overlays',
  fileLocation: 'file:location',
  fileReveal: 'file:reveal',
  zipPassword: 'zip:password',
  recentList: 'recent:list',
  recentOpen: 'recent:open',
  recentRemove: 'recent:remove',
  windowFullscreen: 'window:fullscreen',
  sessionClear: 'session:clear',
  clipboardWrite: 'clipboard:write',
} as const;

export const EVENTS = {
  scanProgress: 'scan:progress',
  scanBatch: 'scan:batch',
  scanDone: 'scan:done',
  zipNeedPassword: 'zip:need-password',
  fullscreenChanged: 'window:fullscreen-changed',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Product identity — the working name lives here only (see docs/DECISIONS.md D-001). */
export const APP_NAME = 'AHDicom';
export const APP_ID = 'org.ahdicom.viewer';
export const RENDERER_ORIGIN = 'app://bundle';
