/**
 * Electron main process entry. Creates the single window with a hardened configuration.
 * Privacy: no telemetry, no update checks, no network (see security.ts). No PHI is logged.
 */
import { BrowserWindow, Menu, app, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { APP_ID, APP_NAME, EVENTS, RENDERER_ORIGIN } from '../shared/channels';
import { FileRegistry } from './files';
import { registerIpc } from './ipc';
import { ScanManager } from './scan';
import { DEV_SERVER_URL, hardenSession, hardenWebContents, registerAppProtocol, registerSchemes } from './security';
import { RecentStore, SettingsStore } from './store';

const isE2E = process.env.CDV_E2E === '1' && !app.isPackaged;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
// Isolated profile for automated tests only (never honoured in packaged builds).
if (isE2E && process.env.CDV_USER_DATA) app.setPath('userData', process.env.CDV_USER_DATA);
// Software WebGL for GPU-less CI runners, opt-in and test-only (Chromium: not for untrusted content).
if (isE2E && process.env.CDV_SWIFTSHADER === '1') {
  app.commandLine.appendSwitch('use-angle', 'swiftshader-webgl');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

registerSchemes();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const TEMP_PREFIX = 'cdv-';
const tempRoot = path.join(app.getPath('temp'), `${TEMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);

/** Removes temp folders left behind by crashed sessions (older than 12 h). */
function cleanStaleTemp(): void {
  const dir = app.getPath('temp');
  const cutoff = Date.now() - 12 * 3600 * 1000;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const p = path.join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore folders we cannot inspect
    }
  }
}

let mainWindow: BrowserWindow | null = null;
const registry = new FileRegistry();
let scans: ScanManager;

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }, { role: 'reload' as const }])],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(settings: SettingsStore): Promise<void> {
  const s = settings.get();
  nativeTheme.themeSource = s.theme;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1116' : '#f4f5f7',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // Test-only: simulate a machine without WebGL to exercise the CPU-fallback warning.
      webgl: !(isE2E && process.env.CDV_DISABLE_WEBGL === '1'),
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send(EVENTS.fullscreenChanged, true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send(EVENTS.fullscreenChanged, false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  if (DEV_SERVER_URL) await mainWindow.loadURL(DEV_SERVER_URL);
  else await mainWindow.loadURL(`${RENDERER_ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  scans?.cancelAll();
  rmSync(tempRoot, { recursive: true, force: true });
});

hardenWebContents();

void app.whenReady().then(async () => {
  cleanStaleTemp();
  mkdirSync(tempRoot, { recursive: true });
  hardenSession();
  registerAppProtocol(path.join(__dirname, '../renderer'));

  const userData = app.getPath('userData');
  const settings = new SettingsStore(path.join(userData, 'settings.json'), (next) => {
    nativeTheme.themeSource = next.theme;
  });
  const recent = new RecentStore(path.join(userData, 'recent.json'));
  await settings.load();
  await recent.load();
  scans = new ScanManager(registry, recent, tempRoot);

  registerIpc({
    registry,
    scans,
    settings,
    recent,
    clearSession: async () => {
      scans.cancelAll();
      registry.clear();
      for (const d of scans.tempDirs) rmSync(d, { recursive: true, force: true });
      scans.tempDirs.clear();
    },
  });

  buildMenu();
  await createWindow(settings);
});
