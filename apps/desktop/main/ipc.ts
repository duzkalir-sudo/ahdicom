/**
 * IPC handlers. Every handler: (1) checks the sender frame origin, (2) validates the payload with zod,
 * (3) never accepts file-system paths from the renderer except paths the preload resolved from dropped files.
 */
import { BrowserWindow, app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import dcmjs from 'dcmjs';
import { buildTagTree, extractOverlays, type DictEntry } from '@ahdicom/dicom-core';
import { APP_NAME, IPC } from '../shared/channels';
import pkg from '../package.json';
import {
  FileOverlaysSchema,
  FileReadSchema,
  ClipboardWriteSchema,
  FullscreenSchema,
  OpenKindSchema,
  OpenPathsSchema,
  RecentIdSchema,
  ScanIdSchema,
  SettingsPatchSchema,
  ZipPasswordSchema,
} from '../shared/schemas';
import type { AppInfo, OpenResult } from '../shared/api';
import type { FileRegistry } from './files';
import type { ScanManager } from './scan';
import type { RecentStore, SettingsStore } from './store';
import { isTrustedSender } from './security';

const MAX_READ_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * The tag browser and overlays parse on the Electron main thread, so they read only a bounded prefix
 * (all headers and overlay data precede Pixel Data) and inflate at most MAX_INFLATED bytes.
 */
const MAX_HEADER_READ = 64 * 1024 * 1024;
const MAX_INFLATED = 256 * 1024 * 1024;

async function readPrefix(p: string, max: number): Promise<Uint8Array> {
  const fh = await open(p, 'r');
  try {
    const size = Math.min((await fh.stat()).size, max);
    const buf = Buffer.allocUnsafe(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

class IpcError extends Error {}

function handle<S extends z.ZodType>(
  channel: string,
  schema: S,
  fn: (event: IpcMainInvokeEvent, payload: z.infer<S>) => unknown,
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (!isTrustedSender(event.senderFrame)) throw new IpcError('forbidden');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new IpcError('invalid payload');
    return fn(event, parsed.data);
  });
}

const inflater = (bytes: Uint8Array, position: number): Uint8Array => {
  const head = bytes.subarray(0, position);
  const body = inflateRawSync(bytes.subarray(position), { maxOutputLength: MAX_INFLATED });
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
};

const dictionary = dcmjs.data.DicomMetaDictionary.dictionary;

function lookup(tag: string): DictEntry | undefined {
  const g = tag.slice(0, 4);
  const e = tag.slice(4);
  const direct = dictionary[`(${g},${e})`];
  if (direct) return { name: direct.name, vr: direct.vr };
  // Repeating groups (curves 50xx, overlays 60xx)
  const rep = dictionary[`(${g.slice(0, 2)}xx,${e})`];
  return rep ? { name: rep.name, vr: rep.vr } : undefined;
}

export interface IpcDeps {
  registry: FileRegistry;
  scans: ScanManager;
  settings: SettingsStore;
  recent: RecentStore;
  clearSession: () => Promise<void>;
}

export function registerIpc(deps: IpcDeps): void {
  const { registry, scans, settings, recent } = deps;
  const noPayload = z.undefined();

  const filePath = async (fileId: string): Promise<string> => {
    const p = registry.path(fileId);
    if (!p) throw new IpcError('unknown file');
    const st = await stat(p);
    if (!st.isFile() || st.size > MAX_READ_BYTES) throw new IpcError('file too large');
    return p;
  };

  handle(IPC.appInfo, noPayload, (): AppInfo => ({
    name: APP_NAME,
    version: pkg.version,
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    isPackaged: app.isPackaged,
    e2e: process.env.CDV_E2E === '1' && !app.isPackaged,
  }));

  handle(IPC.settingsGet, noPayload, () => settings.get());
  handle(IPC.settingsSet, SettingsPatchSchema, (_e, patch) => settings.patch(patch));

  handle(IPC.openDialog, OpenKindSchema, async (event, kind): Promise<OpenResult> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const props: Electron.OpenDialogOptions['properties'] =
      kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
    const filters: Electron.FileFilter[] | undefined =
      kind === 'zip' ? [{ name: 'ZIP', extensions: ['zip'] }] : kind === 'dicomdir' ? [{ name: 'DICOMDIR', extensions: ['*'] }] : undefined;
    const options: Electron.OpenDialogOptions = { properties: props, ...(filters ? { filters } : {}) };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (res.canceled || res.filePaths.length === 0) return { started: false };
    return { started: true, scanId: scans.start(event.sender, res.filePaths, kind) };
  });

  handle(IPC.openPaths, OpenPathsSchema, (event, { paths }): OpenResult => {
    const abs = paths.filter((p) => path.isAbsolute(p));
    if (abs.length === 0) return { started: false };
    return { started: true, scanId: scans.start(event.sender, abs, 'drop') };
  });

  handle(IPC.scanCancel, ScanIdSchema, (_e, scanId) => scans.cancel(scanId));

  handle(IPC.fileRead, FileReadSchema, async (_e, { fileId }) => new Uint8Array(await readFile(await filePath(fileId))));

  handle(IPC.fileTags, FileReadSchema, async (_e, { fileId }) => {
    const bytes = await readPrefix(await filePath(fileId), MAX_HEADER_READ);
    try {
      return buildTagTree(bytes, { lookup, inflater }).nodes;
    } catch {
      return [];
    }
  });

  handle(IPC.fileOverlays, FileOverlaysSchema, async (_e, { fileId, frame }) => {
    const bytes = await readPrefix(await filePath(fileId), MAX_HEADER_READ);
    try {
      return extractOverlays(bytes, frame, inflater);
    } catch {
      return [];
    }
  });

  handle(IPC.fileLocation, FileReadSchema, async (_e, { fileId }) => filePath(fileId));
  handle(IPC.fileReveal, FileReadSchema, async (_e, { fileId }) => shell.showItemInFolder(await filePath(fileId)));

  handle(IPC.zipPassword, ZipPasswordSchema, (_e, { requestId, password }) => scans.answerPassword(requestId, password));

  handle(IPC.recentList, noPayload, () => recent.list());
  handle(IPC.recentOpen, RecentIdSchema, (event, { id }): OpenResult => {
    const entry = recent.get(id);
    if (!entry) return { started: false };
    return { started: true, scanId: scans.start(event.sender, entry.roots, entry.kind) };
  });
  handle(IPC.recentRemove, RecentIdSchema, async (_e, { id }) => {
    await recent.remove(id);
    return recent.list();
  });

  handle(IPC.windowFullscreen, FullscreenSchema, (event, { on }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // 'toggle' uses the window's real state: on macOS the renderer only learns about the change after the animation.
    win?.setFullScreen(on === 'toggle' ? !win.isFullScreen() : on);
  });

  handle(IPC.sessionClear, noPayload, () => deps.clearSession());

  handle(IPC.clipboardWrite, ClipboardWriteSchema, (_e, { text }) => clipboard.writeText(text));
}
