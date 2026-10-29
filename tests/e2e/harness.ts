/**
 * Playwright `_electron` harness: launches the BUILT app (out/main/index.js) with the Chromium sandbox on,
 * an isolated user-data folder, and collects every renderer/main console error, page error and CSP violation.
 */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'generated');
export const MAIN = path.join(ROOT, 'apps', 'desktop', 'out', 'main', 'index.js');

export type Theme = 'dark' | 'light';
export type Lang = 'tr' | 'en';

export interface LaunchOptions {
  lang?: Lang;
  theme?: Theme;
  width?: number;
  height?: number;
  settings?: Record<string, unknown>;
}

export interface Session {
  app: ElectronApplication;
  page: Page;
  errors: string[];
  userData: string;
  /** Allows console errors matching this pattern (used only by malformed-input tests). */
  allowErrors(re: RegExp): void;
  close(): Promise<void>;
}

export async function launch(opts: LaunchOptions = {}): Promise<Session> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cdv-e2e-'));
  const settings = {
    version: 1,
    theme: opts.theme ?? 'dark',
    language: opts.lang ?? 'tr',
    ...opts.settings,
  };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      CDV_E2E: '1',
      CDV_USER_DATA: userData,
      ...(process.env.CI ? { CDV_SWIFTSHADER: process.env.CDV_SWIFTSHADER ?? '0' } : {}),
    },
    chromiumSandbox: true,
    colorScheme: opts.theme ?? 'dark',
    locale: opts.lang === 'en' ? 'en-US' : 'tr-TR',
    timeout: 60_000,
  });
  const errors: string[] = [];
  const allowed: RegExp[] = [];
  const record = (msg: string): void => {
    if (!allowed.some((re) => re.test(msg))) errors.push(msg);
  };
  app.on('console', (m) => {
    if (m.type() === 'error') record(`[main] ${m.text()}`);
  });
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') record(`[renderer] ${m.text()}`);
  });
  page.on('pageerror', (e) => record(`[pageerror] ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  await setSize(app, opts.width ?? 1280, opts.height ?? 800);
  await page.waitForSelector('[data-testid="app"]');
  await expect(page.getByTestId('splash')).toHaveCount(0, { timeout: 30_000 });
  return {
    app,
    page,
    errors,
    userData,
    allowErrors: (re) => allowed.push(re),
    close: async () => {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

export async function setSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      win.setMinimumSize(800, 600);
      win.setContentSize(w, h);
      win.center();
    },
    [width, height] as const,
  );
  // Let layout and the rendering engine settle after the resize.
  await new Promise((r) => setTimeout(r, 400));
}

/** Replaces the native open dialog so tests can "pick" fixture paths. */
export async function stubOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as typeof dialog.showOpenDialog;
  }, paths);
}

export function fixture(...parts: string[]): string {
  return path.join(FIXTURES, ...parts);
}

export async function screenshot(page: Page, milestone: string, name: string): Promise<string> {
  const dir = path.join(ROOT, 'artifacts', 'screenshots', milestone);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, scale: 'css' });
  return file;
}

export interface CdvState {
  ready: boolean;
  studies: { patientName?: string; series: { description?: string; displaySets: { id: string; images: number; kind: string; warnings: string[] }[] }[] }[];
  slots: (string | null)[];
  activeIndex: number;
  scans: number;
  lastSummary?: { instances: number; notDicom: number; errors: Record<string, number>; archiveErrors: string[]; usedDicomdir: boolean };
}

export async function cdvState(page: Page): Promise<CdvState> {
  return page.evaluate(() => (window as unknown as { __cdv: { state(): CdvState } }).__cdv.state());
}

export interface VpState {
  status: string;
  displaySetId?: string;
  index: number;
  total: number;
  wl?: { width: number; center: number };
  voi?: { lower: number; upper: number };
  labels?: { top: string; bottom: string; left: string; right: string };
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  inverted: boolean;
  zoomPercent?: number;
  mmPerCssPx?: number;
  probe?: { column: number; row: number; value?: number | number[]; unit: string };
  voiLutName?: string;
  voiFn: string;
  cine: boolean;
  basis: { kind: string };
}

export async function vpState(page: Page, i = 0): Promise<VpState> {
  return page.evaluate((idx) => (window as unknown as { __cdv: { viewport(i: number): VpState } }).__cdv.viewport(idx), i);
}

/** Opens fixture folders/files through the stubbed dialog and waits for the scan to finish. */
export async function openPaths(s: Session, paths: string[], kind: 'files' | 'folder' | 'dicomdir' | 'zip' = 'folder'): Promise<void> {
  await stubOpenDialog(s.app, paths);
  const before = await cdvState(s.page);
  const testId = { files: 'tb-open-files', folder: 'tb-open-folder', dicomdir: 'tb-open-dicomdir', zip: 'tb-open-zip' }[kind];
  await s.page.getByTestId(testId).click();
  await expect.poll(async () => (await cdvState(s.page)).scans, { timeout: 60_000 }).toBe(0);
  await expect
    .poll(async () => JSON.stringify((await cdvState(s.page)).lastSummary) !== JSON.stringify(before.lastSummary), { timeout: 60_000 })
    .toBe(true);
}

export async function waitReady(page: Page, i = 0): Promise<VpState> {
  await expect.poll(async () => (await vpState(page, i))?.status, { timeout: 60_000 }).toBe('ready');
  // Allow one rendered frame for overlays to update.
  await page.waitForTimeout(300);
  return vpState(page, i);
}

export function expectNoErrors(s: Session): void {
  expect(s.errors, `console errors:\n${s.errors.join('\n')}`).toEqual([]);
}
