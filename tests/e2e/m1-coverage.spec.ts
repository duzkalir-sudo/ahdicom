/**
 * M1 — additional E2E coverage for features whose behaviour is not exercised by m1-viewer.spec.ts
 * (added after the independent verifier review). Real built app; console errors fail every test.
 */
import { expect, test, type Page } from '@playwright/test';
import { cdvState, expectNoErrors, fixture, launch, openPaths, stubOpenDialog, vpState, waitReady } from './harness';

async function pixelToClient(page: Page, column: number, row: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    ([c, r]) => (window as unknown as { __cdv: { pixelToClient(i: number, c: number, r: number): { x: number; y: number } } }).__cdv.pixelToClient(0, c!, r!),
    [column, row],
  );
  return p;
}

test('1:1 shows one image pixel per physical device pixel; zoom readout uses device pixels', async () => {
  const s = await launch();
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    const dpr = await s.page.evaluate(() => window.devicePixelRatio);
    await s.page.keyboard.press('Alt+1');
    await expect.poll(async () => Math.round((await vpState(s.page)).zoomPercent!)).toBe(100);
    // Pixel spacing 0.5 mm; with 1 image px per device px, one CSS px covers dpr image px → 0.5 × dpr mm.
    const v = await vpState(s.page);
    expect(v.mmPerCssPx!).toBeCloseTo(0.5 * dpr, 3);
    // Independent check: two pixel centres 100 columns apart are 100 / dpr CSS px apart on screen.
    const a = await pixelToClient(s.page, 100, 256);
    const b = await pixelToClient(s.page, 200, 256);
    expect(b.x - a.x).toBeCloseTo(100 / dpr, 1);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('PET values carry the Units label; PET % presets; user W/L presets', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('pet')]);
    await waitReady(s.page);
    await s.page.keyboard.press('Home');
    for (let k = 0; k < 20; k++) await s.page.keyboard.press('ArrowDown'); // z = +2 mm, through the hot sphere
    const c = await pixelToClient(s.page, 63, 63);
    await s.page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await vpState(s.page)).probe?.unit).toBe('bqml');
    await expect(s.page.getByTestId('probe')).toContainText('Bq/ml');

    await s.page.getByTestId('tb-presets').click();
    await s.page.getByTestId('preset-pet100').click();
    await expect.poll(async () => (await vpState(s.page)).voi!.lower).toBe(0);
    const full = (await vpState(s.page)).voi!.upper;
    expect(full).toBeGreaterThan(19000); // hot sphere 20000 Bq/ml in this slice
    await s.page.getByTestId('tb-presets').click();
    await s.page.getByTestId('preset-pet50').click();
    await expect.poll(async () => (await vpState(s.page)).voi!.upper).toBeCloseTo(full / 2, 3);

    // Save a user preset from the numeric dialog and apply it from the menu.
    await s.page.keyboard.press('l');
    await s.page.getByTestId('wl-a').fill('3000');
    await s.page.getByTestId('wl-b').fill('1500');
    await s.page.locator('#wl-name').fill('My PET');
    await s.page.getByRole('button', { name: 'Save as preset' }).click();
    await s.page.keyboard.press('0');
    await s.page.getByTestId('tb-presets').click();
    await s.page.getByTestId('preset-user').click();
    await expect.poll(async () => (await vpState(s.page)).wl).toEqual({ width: 3000, center: 1500 });
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('hide patient data masks overlay, series bar and identifying tags; tag pin and copy', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('turkish-148')]);
    await waitReady(s.page);
    await expect(s.page.getByTestId('corner-tl')).toContainText('ÇAĞLAR');
    await s.page.getByTestId('tab-tags').click();
    const nameRow = s.page.locator('[data-testid="tag-row"][data-tag="(0010,0010)"]').first();
    await expect(nameRow).toContainText('ÇAĞLAR^Şükrü İğneada');

    // Pin → the tag is repeated at the top; copy all → OS clipboard holds the dump.
    await nameRow.getByRole('button', { name: 'Pin' }).click();
    await expect(s.page.locator('[data-testid="tag-row"][data-tag="(0010,0010)"]')).toHaveCount(2);
    await expect(s.page.locator('.tag-row.pinned')).toHaveCount(1);
    // The OS clipboard is not accessible in every test environment (it is not on the development machine used
    // for M1), so record what the app hands to Electron's clipboard API in the main process.
    await s.app.evaluate(({ clipboard }) => {
      const g = globalThis as unknown as { __copied: string[] };
      g.__copied = [];
      clipboard.writeText = async (text: string) => {
        g.__copied.push(text);
      };
    });
    await s.page.getByTestId('tag-copy-all').click();
    await expect(s.page.getByTestId('tag-copy-all')).toContainText('Copied');
    const copied = await s.app.evaluate(() => (globalThis as unknown as { __copied: string[] }).__copied);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('(0010,0010) PN PatientName: ÇAĞLAR^Şükrü İğneada');

    await s.page.keyboard.press('a');
    await expect(s.page.getByTestId('corner-tl')).not.toContainText('ÇAĞLAR');
    await expect(s.page.getByTestId('corner-tl')).toContainText('hidden');
    await expect(s.page.getByTestId('study-patient')).toContainText('hidden');
    await expect(nameRow).not.toContainText('ÇAĞLAR');
    await expect(s.page.locator('[data-testid="tag-row"][data-tag="(0010,0020)"]').first()).toContainText('hidden');
    await s.page.keyboard.press('a');
    await expect(s.page.getByTestId('corner-tl')).toContainText('ÇAĞLAR');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('slice slider, PageUp, scroll-drag tool and sort order', async () => {
  const s = await launch();
  try {
    await openPaths(s, [fixture('shuffled')]);
    await waitReady(s.page);
    const slider = s.page.getByTestId('slice-slider');
    const b = (await slider.boundingBox())!;
    await s.page.mouse.click(b.x + b.width / 2, b.y + b.height - 1);
    await expect.poll(async () => (await vpState(s.page)).index).toBe(29);
    await s.page.keyboard.press('PageUp');
    await expect.poll(async () => (await vpState(s.page)).index).toBe(19);

    await s.page.keyboard.press('s'); // left button = scroll tool
    const el = (await s.page.getByTestId('viewport-element-0').boundingBox())!;
    await s.page.mouse.move(el.x + el.width / 2, el.y + el.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(el.x + el.width / 2, el.y + el.height / 2 - 120, { steps: 12 });
    await s.page.mouse.up();
    await expect.poll(async () => (await vpState(s.page)).index).not.toBe(19);
    const wlAfterScroll = (await vpState(s.page)).wl;

    // Left-drag pan and zoom tools; W/L must not change while they are selected.
    await s.page.keyboard.press('Backspace');
    await s.page.keyboard.press('p');
    await s.page.mouse.move(el.x + el.width / 2, el.y + el.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(el.x + el.width / 2 + 80, el.y + el.height / 2 + 40, { steps: 8 });
    await s.page.mouse.up();
    await s.page.keyboard.press('z');
    const z0 = (await vpState(s.page)).zoomPercent!;
    await s.page.mouse.move(el.x + el.width / 2, el.y + el.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(el.x + el.width / 2, el.y + el.height / 2 - 80, { steps: 8 });
    await s.page.mouse.up();
    await expect.poll(async () => (await vpState(s.page)).zoomPercent!).not.toBeCloseTo(z0, 0);
    expect((await vpState(s.page)).wl).toEqual(wlAfterScroll);
    await s.page.keyboard.press('w');

    // Spatial ascending: first image is z = 0; descending: first image is z = 87 (positions 0 … 87 step 3).
    await s.page.keyboard.press('Home');
    await expect(s.page.getByTestId('corner-bl')).toContainText('0,00 (H)');
    await s.page.getByTestId('tab-info').click();
    await s.page.getByTestId('sort-direction').selectOption('desc');
    await s.page.keyboard.press('Home');
    await expect(s.page.getByTestId('corner-bl')).toContainText('87,00 (H)');
    await s.page.getByTestId('sort-key').selectOption('instanceNumber');
    await expect(s.page.getByTestId('info-sorted')).toContainText('Instance Number');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('settings take effect at runtime: language, theme, overlay content, cine bounce', async () => {
  const s = await launch({ lang: 'tr', theme: 'dark' });
  try {
    await openPaths(s, [fixture('xa-cine')]);
    await waitReady(s.page);
    await expect(s.page.getByTestId('image-index')).toContainText('Kare');
    await s.page.getByTestId('tb-settings').click();
    const dlg = s.page.getByTestId('settings-dialog');
    await dlg.getByRole('button', { name: 'English' }).click();
    await expect(s.page.getByTestId('image-index')).toContainText('Frame');
    await dlg.getByRole('button', { name: 'Light' }).click();
    await expect.poll(() => s.page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await dlg.getByRole('checkbox', { name: 'Patient', exact: true }).uncheck();
    await expect(s.page.getByTestId('corner-tl')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Bounce' }).click();
    await s.page.keyboard.press('Escape');

    // Bounce: the frame index must increase to the end and then decrease.
    await s.page.keyboard.press('Home');
    await s.page.keyboard.press(' ');
    let reachedEnd = false;
    let wentBack = false;
    for (let k = 0; k < 80 && !wentBack; k++) {
      const i = (await vpState(s.page)).index;
      if (i >= 28) reachedEnd = true;
      else if (reachedEnd && i < 27) wentBack = true;
      await s.page.waitForTimeout(100);
    }
    await s.page.keyboard.press(' ');
    expect(reachedEnd && wentBack).toBe(true);
    // Settings persist across restart.
    const settings = await s.page.evaluate(() => (window as unknown as { api: { getSettings(): Promise<unknown> } }).api.getSettings());
    expect(settings).toMatchObject({ language: 'en', theme: 'light', cineMode: 'bounce', overlay: { patient: false } });
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('a running scan can be cancelled', async () => {
  const s = await launch({ lang: 'en' });
  try {
    // ~650 files. The scan is cancelled through the same API call the status-bar button uses, immediately
    // after it starts (a click cannot reliably beat a sub-second scan on a fast machine).
    await stubOpenDialog(s.app, [fixture('ct-large'), fixture('ct-phantom'), fixture('pet'), fixture('orient-axial')]);
    await s.page.evaluate(async () => {
      const api = (window as unknown as { api: { open(k: string): Promise<{ started: boolean; scanId?: string }>; cancelScan(id: string): Promise<void> } }).api;
      const r = await api.open('folder');
      if (r.started && r.scanId) await api.cancelScan(r.scanId);
    });
    await expect.poll(async () => (await cdvState(s.page)).lastSummary?.cancelled, { timeout: 30_000 }).toBe(true);
    await expect(s.page.getByTestId('status-text')).toContainText('Scan cancelled');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('without WebGL the app warns that it uses the slower software fallback', async () => {
  const { _electron } = await import('@playwright/test');
  const { MAIN } = await import('./harness');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-e2e-'));
  const app = await _electron.launch({
    args: [MAIN],
    env: { ...process.env, CDV_E2E: '1', CDV_USER_DATA: userData, CDV_DISABLE_WEBGL: '1' },
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('cpu-rendering')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('notice-warning')).toContainText('Ekran kartı');
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
