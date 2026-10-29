/**
 * M1 — core 2D viewer, exercised against the real built Electron app with synthetic fixtures.
 * Every test fails on any renderer/main console error (see harness.ts) unless explicitly allowed.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { brightRegion, grab } from './pixels';
import {
  FIXTURES,
  cdvState,
  expectNoErrors,
  fixture,
  launch,
  openPaths,
  screenshot,
  setSize,
  stubOpenDialog,
  vpState,
  waitReady,
  type Session,
  type VpState,
} from './harness';

interface ManifestEntry {
  id: string;
  kind: string;
  expect?: Record<string, unknown>;
}
const manifest = (JSON.parse(readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')) as { fixtures: ManifestEntry[] }).fixtures;

async function pixelToClient(page: Page, i: number, column: number, row: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    ([idx, c, r]) => (window as unknown as { __cdv: { pixelToClient(i: number, c: number, r: number): { x: number; y: number } | undefined } }).__cdv.pixelToClient(idx!, c!, r!),
    [i, column, row],
  );
  if (!p) throw new Error('pixelToClient failed');
  return p;
}

async function scrollTo(s: Session, index: number, vp = 0): Promise<void> {
  await s.page.getByTestId(`viewport-${vp}`).click({ position: { x: 5, y: 5 } });
  await s.page.keyboard.press('Home');
  for (let k = 0; k < index; k++) await s.page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await vpState(s.page, vp)).index).toBe(index);
}

async function selectSeries(s: Session, match: (d: { description?: string }) => boolean, vp = 0): Promise<void> {
  const st = await cdvState(s.page);
  const se = st.studies.flatMap((x) => x.series).find(match);
  if (!se) throw new Error('series not found');
  await s.page.getByTestId(`viewport-${vp}`).click({ position: { x: 5, y: 5 } });
  await s.page.locator(`[data-ds-id="${se.displaySets[0]!.id}"]`).click();
  await expect.poll(async () => (await vpState(s.page, vp)).displaySetId).toBe(se.displaySets[0]!.id);
}

async function showDisplaySet(s: Session, id: string, vp = 0): Promise<VpState> {
  await s.page.locator(`[data-ds-id="${id}"]`).click();
  await expect.poll(async () => (await vpState(s.page, vp)).displaySetId).toBe(id);
  await expect.poll(async () => (await vpState(s.page, vp)).status, { timeout: 30_000 }).toMatch(/ready|nonImage|error/);
  return vpState(s.page, vp);
}

// ---------------------------------------------------------------------------------------------

test('core flow: open folder → series → scroll → W/L → zoom/pan → layout → tag search → full screen', async () => {
  const s = await launch({ lang: 'tr', theme: 'dark' });
  try {
    const { page } = s;
    await openPaths(s, [fixture('ct-phantom')], 'folder');
    const first = await waitReady(page);
    expect(first.total).toBe(64);
    expect(first.wl).toEqual({ width: 80, center: 40 });
    await expect(page.getByTestId('series-item')).toHaveCount(1);
    await expect(page.getByTestId('corner-tl')).toContainText('PHANTOM, TEST');

    // Scroll: wheel, keyboard, Page Down, End/Home
    const el = page.getByTestId('viewport-element-0');
    await el.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(async () => (await vpState(page)).index).toBeGreaterThan(0);
    await page.keyboard.press('Home');
    await expect.poll(async () => (await vpState(page)).index).toBe(0);
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await vpState(page)).index).toBe(10);
    await page.keyboard.press('End');
    await expect.poll(async () => (await vpState(page)).index).toBe(63);
    await page.keyboard.press('Home');

    // W/L by left drag
    const box = (await el.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    const afterWl = await vpState(page);
    expect(afterWl.wl).not.toEqual({ width: 80, center: 40 });

    // CT presets (exact HU windows) and default window
    await page.keyboard.press('4');
    await expect.poll(async () => (await vpState(page)).wl).toEqual({ width: 2000, center: 500 });
    await page.keyboard.press('5');
    await expect.poll(async () => (await vpState(page)).wl).toEqual({ width: 1500, center: -600 });
    await page.keyboard.press('1');
    await expect.poll(async () => (await vpState(page)).wl).toEqual({ width: 80, center: 40 });
    await expect(page.getByTestId('wl-text')).toContainText('P: 80  S: 40');

    // Zoom by right drag, pan by middle drag, Ctrl+wheel zoom, fit
    const z0 = (await vpState(page)).zoomPercent!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 80, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await expect.poll(async () => (await vpState(page)).zoomPercent!).not.toBeCloseTo(z0, 0);
    await page.keyboard.press('f');
    await expect.poll(async () => Math.round((await vpState(page)).zoomPercent!)).toBe(Math.round(z0));
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await vpState(page)).zoomPercent!).toBeGreaterThan(z0 * 1.05);
    await page.keyboard.press('Alt+1');
    await expect.poll(async () => Math.round((await vpState(page)).zoomPercent!)).toBe(100);
    await page.keyboard.press('f');

    // Rotate / flip / invert / reset
    await page.keyboard.press('r');
    await expect.poll(async () => (await vpState(page)).rotation).toBe(90);
    await page.keyboard.press('h');
    await page.keyboard.press('i');
    await expect.poll(async () => {
      const v = await vpState(page);
      return [v.flipH, v.inverted];
    }).toEqual([true, true]);
    await page.keyboard.press('Backspace');
    await expect.poll(async () => {
      const v = await vpState(page);
      return [v.rotation, v.flipH, v.flipV, v.inverted, v.wl?.width, v.wl?.center];
    }).toEqual([0, false, false, false, 80, 40]);

    // Context menu on right click without drag
    await page.mouse.click(box.x + box.width / 3, box.y + box.height / 3, { button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await screenshot(page, 'M1', 'context-menu-1280x800-dark-tr');
    await page.keyboard.press('Escape');

    // Numeric W/L entry
    await page.keyboard.press('l');
    await expect(page.getByTestId('wl-dialog')).toBeVisible();
    await page.getByTestId('wl-a').fill('350');
    await page.getByTestId('wl-b').fill('45');
    await screenshot(page, 'M1', 'wl-dialog-1280x800-dark-tr');
    await page.getByTestId('wl-apply').click();
    await expect.poll(async () => (await vpState(page)).wl).toEqual({ width: 350, center: 45 });

    // Layouts 1×1 … 5×5 and presets — every cell visible and inside the grid
    for (const [id, n] of [['2x2', 4], ['1+2', 3], ['2+1', 3], ['3x3', 9], ['5x5', 25], ['1x1', 1]] as const) {
      await page.getByTestId('tb-layout').click();
      await page.getByTestId(`layout-${id}`).click();
      const grid = (await page.getByTestId('viewport-grid').boundingBox())!;
      const cells = page.locator('[data-testid^="viewport-"][data-status]');
      await expect(cells).toHaveCount(n);
      for (let i = 0; i < n; i++) {
        const b = (await page.getByTestId(`viewport-${i}`).boundingBox())!;
        expect(b.width).toBeGreaterThan(20);
        expect(b.height).toBeGreaterThan(20);
        expect(b.x).toBeGreaterThanOrEqual(grid.x - 1);
        expect(b.x + b.width).toBeLessThanOrEqual(grid.x + grid.width + 1);
        expect(b.y + b.height).toBeLessThanOrEqual(grid.y + grid.height + 1);
      }
      if (id === '5x5') await screenshot(page, 'M1', 'layout-5x5-1280x800-dark-tr');
    }
    // Double-click maximize / restore
    await page.getByTestId('tb-layout').click();
    await page.getByTestId('layout-2x2').click();
    await page.getByTestId('viewport-0').dblclick();
    await expect(page.getByTestId('viewport-1')).toBeHidden();
    await page.getByTestId('viewport-0').dblclick();
    await expect(page.getByTestId('viewport-1')).toBeVisible();
    await page.getByTestId('tb-layout').click();
    await page.getByTestId('layout-1x1').click();

    // Tag browser search
    await page.getByTestId('tab-tags').click();
    await page.getByTestId('tag-search').fill('PatientName');
    await expect(page.locator('[data-testid="tag-row"][data-tag="(0010,0010)"]')).toContainText('PHANTOM^TEST');
    await page.getByTestId('tag-search').fill('7FE0');
    await expect(page.locator('[data-testid="tag-row"][data-tag="(7FE0,0010)"]')).toBeVisible();
    await page.getByTestId('tag-search').fill('');
    await page.getByTestId('tag-location').click();
    await expect(page.getByTestId('tag-location-text')).toContainText('IM0001.dcm');

    // Full screen and distraction-free
    await page.keyboard.press('F11');
    await expect.poll(async () => s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen())).toBe(true);
    // On macOS the full-screen animation runs for ~1 s; wait until the app reports it (toolbar button pressed).
    await expect(page.getByTestId('tb-fullscreen')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('F11');
    await expect.poll(async () => s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen())).toBe(false);
    await page.keyboard.press('F10');
    await expect(page.getByTestId('toolbar')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('toolbar')).toBeVisible();
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('HU probe is exact at the phantom sphere centres; scale bar and spacing basis', async () => {
  const s = await launch();
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    const probes = manifest.find((m) => m.id === 'ct-phantom')!.expect!.probes as { slice: number; column: number; row: number; hu: number }[];
    expect(probes.length).toBeGreaterThanOrEqual(3);
    for (const p of probes) {
      await scrollTo(s, p.slice);
      const c = await pixelToClient(s.page, 0, p.column, p.row);
      await s.page.mouse.move(c.x, c.y);
      await expect.poll(async () => (await vpState(s.page)).probe).toEqual({ column: p.column, row: p.row, value: p.hu, unit: 'hu' });
    }
    // Air outside the cylinder
    const air = await pixelToClient(s.page, 0, 5, 5);
    await s.page.mouse.move(air.x, air.y);
    await expect.poll(async () => (await vpState(s.page)).probe?.value).toBe(-1000);
    await expect(s.page.getByTestId('probe')).toContainText('-1000 HU');
    const v = await vpState(s.page);
    expect(v.basis.kind).toBe('pixelSpacing');
    expect(v.mmPerCssPx).toBeGreaterThan(0);
    await expect(s.page.getByTestId('scale-bar')).toBeVisible();
    await s.page.getByTestId('tab-info').click();
    await expect(s.page.getByTestId('info-basis')).toContainText('Piksel aralığı');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('orientation markers follow rotate/flip and match the rendered asymmetric phantom', async () => {
  const s = await launch();
  try {
    await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal'), fixture('orient-coronal'), fixture('oblique')]);
    const cases = [
      { desc: 'AXIAL', slice: 32, base: { left: 'R', right: 'L', top: 'A', bottom: 'P' }, blob: ['L', 'A'] },
      { desc: 'SAGITTAL', slice: 7, // normal = row × column = patient Right, so ascending order starts at x = +88
      base: { left: 'A', right: 'P', top: 'H', bottom: 'F' }, blob: ['A', 'H'] },
      { desc: 'CORONAL', slice: 7, base: { left: 'R', right: 'L', top: 'H', bottom: 'F' }, blob: ['L', 'H'] },
    ];
    for (const c of cases) {
      await selectSeries(s, (d) => d.description === c.desc);
      await waitReady(s.page);
      await scrollTo(s, c.slice);
      expect((await vpState(s.page)).labels).toEqual(c.base);
      for (const step of ['none', 'r', 'r', 'r', 'r', 'h', 'v', 'h', 'v'] as const) {
        if (step !== 'none') await s.page.keyboard.press(step);
        await s.page.waitForTimeout(250);
        const labels = (await vpState(s.page)).labels!;
        await s.page.keyboard.press('o'); // hide text overlay for pixel analysis
        await s.page.waitForTimeout(150);
        const g = await grab(s.page.getByTestId('viewport-element-0'));
        await s.page.keyboard.press('o');
        const blob = brightRegion(g, 235);
        expect(blob.n, `${c.desc} ${step}: marker visible`).toBeGreaterThan(50);
        const dx = blob.cx - g.width / 2;
        const dy = blob.cy - g.height / 2;
        const horizontal = dx > 0 ? labels.right : labels.left;
        const vertical = dy > 0 ? labels.bottom : labels.top;
        // The bright marker lies towards c.blob directions; the label on its side must name one of them.
        expect(c.blob.some((l) => horizontal.includes(l)), `${c.desc} after ${step}: horizontal ${JSON.stringify(labels)} dx=${dx}`).toBe(true);
        expect(c.blob.some((l) => vertical.includes(l)), `${c.desc} after ${step}: vertical ${JSON.stringify(labels)} dy=${dy}`).toBe(true);
      }
      await s.page.keyboard.press('Backspace');
    }
    await selectSeries(s, (d) => d.description === 'OBLIQUE 20/15');
    const ob = await waitReady(s.page);
    expect(ob.labels!.right.length).toBeGreaterThan(1); // oblique → combined letters
    await screenshot(s.page, 'M1', 'oblique-1280x800-dark-tr');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('anisotropic pixels render with the correct aspect ratio', async () => {
  const s = await launch();
  try {
    await openPaths(s, [fixture('aniso')]);
    await waitReady(s.page);
    await s.page.keyboard.press('o');
    await s.page.waitForTimeout(200);
    const g = await grab(s.page.getByTestId('viewport-element-0'));
    const blob = brightRegion(g, 200, 0.02);
    expect(blob.n).toBeGreaterThan(500);
    expect(blob.w / blob.h).toBeGreaterThan(0.93);
    expect(blob.w / blob.h).toBeLessThan(1.07);
    await s.page.keyboard.press('o');
    await screenshot(s.page, 'M1', 'aniso-1280x800-dark-tr');
    // Probe at the circle centre (column 64, row 64) maps back to the same pixel.
    const c = await pixelToClient(s.page, 0, 64, 64);
    await s.page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await vpState(s.page)).probe).toEqual({ column: 64, row: 64, value: 3000, unit: 'raw' });
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('every fixture opens or shows a clear error; transfer syntaxes decode to identical values', async () => {
  const s = await launch({ lang: 'en' });
  try {
    const valid = manifest.filter((m) => m.kind === 'valid' && m.id !== 'ct-large' && m.id !== 'dicomdir-set').map((m) => fixture(m.id));
    await openPaths(s, valid);
    const st = await cdvState(s.page);
    const all = st.studies.flatMap((x) => x.series.flatMap((se) => se.displaySets.map((d) => ({ ...d, description: se.description }))));
    expect(all.length).toBeGreaterThanOrEqual(45);
    for (const d of all) {
      const v = await showDisplaySet(s, d.id);
      if (d.kind === 'nonImage') expect(v.status).toBe('nonImage');
      else expect(v.status, `${d.description} should render`).toBe('ready');
    }
    // Lossless transfer syntaxes: same stored value at the asymmetric corner marker (row 5, column 250).
    for (const desc of ['Implicit VR LE', 'Explicit VR LE', 'Explicit VR BE', 'Deflated explicit LE', 'RLE Lossless', 'JPEG Lossless SV1', 'JPEG-LS lossless', 'JPEG 2000 lossless', 'HTJ2K lossless']) {
      await selectSeries(s, (d) => d.description === desc);
      await waitReady(s.page);
      const c = await pixelToClient(s.page, 0, 250, 5);
      await s.page.mouse.move(c.x, c.y);
      await expect.poll(async () => (await vpState(s.page)).probe?.value, { message: desc }).toBe(4035);
      const c2 = await pixelToClient(s.page, 0, 128, 128);
      await s.page.mouse.move(c2.x, c2.y);
      await expect.poll(async () => (await vpState(s.page)).probe?.value, { message: desc }).toBe(1200 + ((128 * 7 + 128 * 3) % 50));
    }
    // Photometric interpretations decoded to the same colours
    const colourAt = async (desc: string, col: number, row: number): Promise<number[]> => {
      await selectSeries(s, (d) => d.description === desc);
      await waitReady(s.page);
      const c = await pixelToClient(s.page, 0, col, row);
      await s.page.mouse.move(c.x, c.y);
      await expect.poll(async () => Array.isArray((await vpState(s.page)).probe?.value)).toBe(true);
      return (await vpState(s.page)).probe!.value as number[];
    };
    expect(await colourAt('RGB planar 0', 127, 0)).toEqual([255, 0, 255]);
    expect(await colourAt('RGB planar 1', 127, 0)).toEqual([255, 0, 255]);
    const ybr = await colourAt('YBR_FULL', 127, 0);
    expect(Math.abs(ybr[0]! - 255) + Math.abs(ybr[1]! - 0) + Math.abs(ybr[2]! - 255)).toBeLessThanOrEqual(6);
    expect(await colourAt('PALETTE COLOR', 10, 3)).toEqual([235, 20, 40]);
    await screenshot(s.page, 'M1', 'palette-1280x800-dark-en');

    // Modality LUT Sequence (×2), VOI LUT (gamma), SIGMOID, multiple windows, padding, presentation LUT
    await selectSeries(s, (d) => d.description === 'Modality LUT Sequence (x2)');
    await waitReady(s.page);
    let c = await pixelToClient(s.page, 0, 127, 64);
    await s.page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await vpState(s.page)).probe?.value).toBe(8190);

    await selectSeries(s, (d) => d.description === 'VOI LUT Sequence (gamma)');
    const voi = await waitReady(s.page);
    expect(voi.voiLutName).toBe('GAMMA 0.5');
    await s.page.keyboard.press('o');
    await s.page.waitForTimeout(150);
    const g = await grab(s.page.getByTestId('viewport-element-0'));
    await s.page.keyboard.press('o');
    const q = await pixelToClient(s.page, 0, 32, 64); // 25 % of the ramp
    const box = (await s.page.getByTestId('viewport-element-0').boundingBox())!;
    const lum = g.at(q.x - box.x, q.y - box.y);
    expect(lum, 'gamma 0.5 maps 25 % input to ~50 % output').toBeGreaterThan(105);
    expect(lum).toBeLessThan(150);

    await selectSeries(s, (d) => d.description === 'VOI LUT function SIGMOID');
    const sig = await waitReady(s.page);
    expect(sig.voiFn).toBe('SIGMOID');
    expect(sig.voiLutName, 'VOI LUT of the previous series must not carry over').toBeUndefined();

    await selectSeries(s, (d) => d.description === 'Signed 16-bit with Pixel Padding -2000');
    await waitReady(s.page);
    c = await pixelToClient(s.page, 0, 64, 64);
    await s.page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await vpState(s.page)).probe).toEqual({ column: 64, row: 64, value: 60, unit: 'hu' });
    c = await pixelToClient(s.page, 0, 1, 1);
    await s.page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await vpState(s.page)).probe).toEqual({ column: 1, row: 1, value: -2000, unit: 'hu', padding: true });

    // Turkish names, uncertain charset indicator
    const series = await s.page.getByTestId('study-patient').allInnerTexts();
    expect(series).toEqual(expect.arrayContaining(['ÇAĞLAR, Şükrü İğneada', 'ÖZGÜL, Ayşe Işık', 'YILMAZ, Gülşen']));
    await selectSeries(s, (d) => d.description === 'NO CHARSET');
    await waitReady(s.page);
    await expect(s.page.getByTestId('corner-tl')).toContainText('Text encoding is uncertain');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('geometry warnings, sorting fallback, enhanced MR and series split are shown', async () => {
  const s = await launch();
  try {
    await openPaths(s, [fixture('gantry-tilt'), fixture('nonuniform'), fixture('no-geometry'), fixture('mixed-orient'), fixture('enhanced-mr'), fixture('shuffled')]);
    const st = await cdvState(s.page);
    const byDesc = (d: string) => st.studies.flatMap((x) => x.series).find((x) => x.description === d)!;
    expect(byDesc('TILT 15').displaySets[0]!.warnings).toContain('gantryTilt');
    expect(byDesc('NONUNIFORM').displaySets[0]!.warnings).toEqual(expect.arrayContaining(['missingSlices', 'nonUniformSpacing']));
    expect(byDesc('NO GEOMETRY').displaySets[0]!.warnings).toContain('sortFallbackInstanceNumber');
    expect(byDesc('LOCALIZER 3-PLANE').displaySets).toHaveLength(3);
    expect(byDesc('ENHANCED T1 20 FRAMES').displaySets[0]!.images).toBe(20);

    await selectSeries(s, (d) => d.description === 'TILT 15');
    await waitReady(s.page);
    await expect(s.page.getByTestId('viewport-warning')).toContainText('Gantri eğimi');
    await s.page.getByTestId('tab-info').click();
    await expect(s.page.getByTestId('info-warnings')).toContainText('15');
    await screenshot(s.page, 'M1', 'warnings-tilt-1280x800-dark-tr');

    await selectSeries(s, (d) => d.description === 'NO GEOMETRY');
    await waitReady(s.page);
    await expect(s.page.getByTestId('info-sorted')).toContainText('Instance Number');

    // Sorting keys and direction re-order the stack
    await selectSeries(s, (d) => d.description === 'SHUFFLED');
    await waitReady(s.page);
    await s.page.getByTestId('sort-direction').selectOption('desc');
    await s.page.getByTestId('sort-key').selectOption('fileName');
    await s.page.getByTestId('sort-key').selectOption('spatial');
    await expect.poll(async () => (await vpState(s.page)).total).toBe(30);

    await selectSeries(s, (d) => d.description === 'ENHANCED T1 20 FRAMES');
    const e = await waitReady(s.page);
    expect(e.total).toBe(20);
    expect(e.labels).toEqual({ left: 'R', right: 'L', top: 'A', bottom: 'P' });
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('DICOMDIR, ZIP (plain, AES, ZipCrypto) with password, bomb and traversal', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('dicomdir-set', 'DICOMDIR')], 'dicomdir');
    let st = await cdvState(s.page);
    expect(st.lastSummary!.usedDicomdir).toBe(true);
    expect(st.lastSummary!.instances).toBe(10);
    expect(st.studies[0]!.series).toHaveLength(2);
    await waitReady(s.page);

    await openPaths(s, [fixture('archives', 'plain.zip')], 'zip');
    st = await cdvState(s.page);
    expect(st.lastSummary!.instances).toBe(2);

    for (const name of ['aes.zip', 'zipcrypto.zip']) {
      await stubOpenDialog(s.app, [fixture('archives', name)]);
      await s.page.getByTestId('tb-open-zip').click();
      await expect(s.page.getByTestId('password-dialog')).toBeVisible();
      if (name === 'aes.zip') await screenshot(s.page, 'M1', 'zip-password-1280x800-dark-en');
      await s.page.getByTestId('password-input').fill('wrong');
      await s.page.getByTestId('password-ok').click();
      await expect(s.page.getByTestId('password-dialog')).toContainText('Wrong password');
      await s.page.getByTestId('password-input').fill('test1234');
      await s.page.getByTestId('password-ok').click();
      await expect.poll(async () => (await cdvState(s.page)).scans).toBe(0);
      st = await cdvState(s.page);
      expect(st.lastSummary!.instances, name).toBe(2);
    }

    await openPaths(s, [fixture('archives', 'bomb.zip')], 'zip');
    st = await cdvState(s.page);
    expect(st.lastSummary!.archiveErrors).toContain('zipBomb');
    expect(st.lastSummary!.instances).toBe(0);
    await expect(s.page.getByTestId('notice-error')).toContainText('safety limits');

    await openPaths(s, [fixture('archives', 'traversal.zip')], 'zip');
    st = await cdvState(s.page);
    // The whole archive is refused (zip.js rejects "../" entry names); nothing is extracted outside the temp folder.
    expect(st.lastSummary!.archiveErrors).toContain('zipTraversal');
    expect(st.lastSummary!.instances).toBe(0);
    await expect(s.page.getByTestId('notice-error').last()).toContainText('unsafe file paths');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('malformed files never crash the app and show readable errors', async () => {
  const s = await launch({ lang: 'en' });
  // Cornerstone logs decode failures of the deliberately corrupt streams to the console.
  // Expected diagnostics from the deliberately corrupt codec streams (exact messages observed from the decoders):
  // Cornerstone logs (console.error, possibly multi-line with stacks) each failed decode; nothing else may appear.
  s.allowErrors(
    /^\[renderer\] (Error executing method 'decodeTask' on worker 'dicomImageLoader': .*|\d+ cdv:[\w-]+|ojph error 0x[0-9A-F]+ at .*|Invalid JPEG-LS stream: .*|Error: ERROR: frame format error .*|(Image)?(Decode)?Error: (decoded pixel data is incomplete|invalid RLE segment table|decoder error .*|Invalid JPEG-LS stream: .*|ERROR: frame format error .*).*)$/s,
  );
  try {
    await openPaths(s, [fixture('malformed')]);
    const st = await cdvState(s.page);
    // Header-valid files with corrupt pixel streams are indexed; the rest are reported.
    // zero-byte, text and PNG files are silently ignored as non-DICOM; files with a DICM prefix are reported.
    expect(st.lastSummary!.notDicom).toBe(3);
    expect(Object.values(st.lastSummary!.errors).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
    await expect(s.page.getByTestId('notice-warning')).toBeVisible();
    const bad = st.studies.flatMap((x) => x.series).filter((x) => /^BAD|TRUNCATED/.test(x.description ?? ''));
    expect(bad.length).toBeGreaterThanOrEqual(6);
    for (const b of bad) {
      const v = await showDisplaySet(s, b.displaySets[0]!.id);
      expect(v.status, b.description).toBe('error');
    }
    await screenshot(s.page, 'M1', 'decode-error-1280x800-dark-en');
    // The app is still responsive and can open a good series afterwards.
    await openPaths(s, [fixture('ct-phantom')]);
    await selectSeries(s, (d) => d.description === 'PHANTOM 2.5mm');
    await waitReady(s.page);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('cine playback, DICOM overlays and non-image objects', async () => {
  const s = await launch();
  try {
    await openPaths(s, [fixture('xa-cine'), fixture('overlay'), fixture('sr'), fixture('pdf'), fixture('cr-mag'), fixture('mono1')]);
    await selectSeries(s, (d) => d.description === 'DSA RUN 30 FRAMES');
    const x = await waitReady(s.page);
    expect(x.total).toBe(30);
    expect(x.labels).toEqual({ left: 'R', right: 'L', top: 'H', bottom: 'F' }); // from PatientOrientation L\F
    await s.page.keyboard.press(' ');
    await expect.poll(async () => (await vpState(s.page)).cine).toBe(true);
    const i0 = (await vpState(s.page)).index;
    await expect.poll(async () => (await vpState(s.page)).index, { timeout: 5000 }).not.toBe(i0);
    await screenshot(s.page, 'M1', 'cine-xa-1280x800-dark-tr');
    await s.page.keyboard.press(' ');
    await expect.poll(async () => (await vpState(s.page)).cine).toBe(false);

    await selectSeries(s, (d) => d.description === 'OVERLAY 6000');
    await waitReady(s.page);
    await s.page.waitForTimeout(400);
    const box = (await s.page.getByTestId('viewport-element-0').boundingBox())!;
    const edge = await pixelToClient(s.page, 0, 128, 20); // overlay frame line (row 20)
    let g = await grab(s.page.getByTestId('viewport-0'));
    const [r, gg, b] = g.rgb(edge.x - box.x, edge.y - box.y);
    expect(r > 200 && gg > 170 && b < 120, `overlay colour at frame line: ${r},${gg},${b}`).toBe(true);
    await screenshot(s.page, 'M1', 'overlay-1280x800-dark-tr');
    await s.page.keyboard.press('Shift+O');
    await s.page.waitForTimeout(300);
    g = await grab(s.page.getByTestId('viewport-0'));
    const [r2, , b2] = g.rgb(edge.x - box.x, edge.y - box.y);
    expect(Math.abs(r2 - b2) < 30, 'overlay hidden').toBe(true);
    await s.page.keyboard.press('Shift+O');

    await selectSeries(s, (d) => d.description === 'BASIC TEXT SR');
    await expect.poll(async () => (await vpState(s.page)).status).toBe('nonImage');
    await expect(s.page.getByTestId('viewport-nonimage')).toBeVisible();

    await selectSeries(s, (d) => d.description === 'CHEST PA');
    const cr = await waitReady(s.page);
    expect(cr.basis.kind).toBe('imagerMagnified');
    await s.page.getByTestId('tab-info').click();
    await expect(s.page.getByTestId('info-basis')).toContainText('1.1');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('performance: first image, scroll rate and memory when opening/closing 20 series', async () => {
  test.setTimeout(400_000);
  const s = await launch({ width: 1280, height: 800 });
  try {
    const t0 = Date.now();
    await openPaths(s, [fixture('ct-large')]);
    const indexMs = Date.now() - t0;
    // First image: time from series selection to the rendered first image.
    await s.page.getByTestId('tb-layout').click();
    await s.page.getByTestId('layout-1x2').click();
    await s.page.getByTestId('viewport-1').click({ position: { x: 5, y: 5 } });
    const id = (await cdvState(s.page)).studies[0]!.series[0]!.displaySets[0]!.id;
    const tSel = Date.now();
    await s.page.locator(`[data-ds-id="${id}"]`).click();
    await waitReady(s.page, 1);
    const firstImageMs = Date.now() - tSel - 300; // waitReady adds a fixed 300 ms settle delay
    // Scroll 200 images once the series is cached (prefetch finished: cache size stable for 2 s).
    let last = -1;
    for (let k = 0; k < 60; k++) {
      const now = await s.page.evaluate(() => (window as unknown as { __cdv: { cacheBytes(): number } }).__cdv.cacheBytes());
      if (now === last) break;
      last = now;
      await s.page.waitForTimeout(2000);
    }
    const fps = await s.page.evaluate(() =>
      (window as unknown as { __cdv: { scrollBenchmark(i: number, n: number): Promise<number> } }).__cdv.scrollBenchmark(1, 200),
    );
    const cacheMB = async (): Promise<number> =>
      s.page.evaluate(() => Math.round((window as unknown as { __cdv: { cacheBytes(): number } }).__cdv.cacheBytes() / 1048576));
    const cacheWithLargeSeries = await cacheMB();
    const heap = async (): Promise<number> =>
      s.page.evaluate(() => (performance as Performance & { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576);
    await s.page.getByTestId('tb-close-all').click();
    await openPaths(s, [fixture('ts-explicit-le'), fixture('orient-axial'), fixture('orient-sagittal'), fixture('orient-coronal'), fixture('oblique'), fixture('pet'), fixture('shuffled'), fixture('gantry-tilt'), fixture('nonuniform'), fixture('mixed-orient')]);
    const ids = (await cdvState(s.page)).studies.flatMap((x) => x.series.flatMap((se) => se.displaySets.map((d) => d.id)));
    const h0 = await heap();
    for (let k = 0; k < 20; k++) {
      await s.page.locator(`[data-ds-id="${ids[k % ids.length]}"]`).click();
      await s.page.waitForTimeout(250);
    }
    await s.page.getByTestId('tb-close-all').click();
    await s.page.waitForTimeout(2000);
    const h1 = await heap();
    const cacheAfterCloseMB = await cacheMB();
    const result = {
      indexMs,
      firstImageMs,
      fps: Math.round(fps * 10) / 10,
      heapBeforeMB: Math.round(h0),
      heapAfterMB: Math.round(h1),
      cacheWithLargeSeriesMB: cacheWithLargeSeries,
      cacheAfterCloseMB,
    };
    console.log(`PERF ${JSON.stringify(result)}`);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/perf-m1.json', JSON.stringify(result, null, 2));
    // Spec §6 targets are defined for the development machine and enforced locally. Shared CI VMs (no or weak GPU)
    // only record the numbers and fail on catastrophic regressions (approved by the user, D-033).
    const ci = Boolean(process.env.CI);
    expect(firstImageMs).toBeLessThan(ci ? 10_000 : 1500);
    expect(fps).toBeGreaterThanOrEqual(ci ? 5 : 30);
    expect(h1).toBeLessThan(h0 + 150);
    expect(cacheAfterCloseMB).toBe(0);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Screenshot matrix for UX review
// ---------------------------------------------------------------------------------------------

test('viewer screenshot matrix (sizes × themes × languages)', async () => {
  test.setTimeout(600_000);
  for (const lang of ['tr', 'en'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      const s = await launch({ lang, theme });
      try {
        await openPaths(s, [fixture('ct-phantom'), fixture('turkish-148'), fixture('orient-axial'), fixture('orient-sagittal'), fixture('orient-coronal'), fixture('gantry-tilt')]);
        for (const [w, h] of [[1280, 800], [1920, 1080]] as const) {
          await setSize(s.app, w, h);
          const tag = `${w}x${h}-${theme}-${lang}`;
          await s.page.getByTestId('tb-layout').click();
          await s.page.getByTestId('layout-1x1').click();
          await selectSeries(s, (d) => d.description === 'PHANTOM 2.5mm');
          await waitReady(s.page);
          await scrollTo(s, 32);
          const c = await pixelToClient(s.page, 0, 156, 176);
          await s.page.mouse.move(c.x, c.y);
          await s.page.getByTestId('tab-info').click();
          await s.page.waitForTimeout(300);
          await screenshot(s.page, 'M1', `viewer-ct-${tag}`);
          await s.page.getByTestId('tab-tags').click();
          await expect(s.page.getByTestId('tag-row').first()).toBeVisible();
          await screenshot(s.page, 'M1', `tags-${tag}`);
          await s.page.getByTestId('tb-layout').click();
          await s.page.getByTestId('layout-2x2').click();
          for (const [i, d] of ['AXIAL', 'SAGITTAL', 'CORONAL', 'TILT 15'].entries()) {
            await selectSeries(s, (x) => x.description === d, i);
            await waitReady(s.page, i);
          }
          await s.page.getByTestId('tab-info').click();
          await s.page.waitForTimeout(300);
          await screenshot(s.page, 'M1', `viewer-2x2-${tag}`);
        }
        await setSize(s.app, 1280, 800);
        await s.page.getByTestId('tb-close-all').click();
        await expect(s.page.getByTestId('start-screen')).toBeVisible();
        await expect(s.page.getByTestId('recent-list')).toBeVisible();
        await screenshot(s.page, 'M1', `start-recent-1280x800-${theme}-${lang}`);
        expectNoErrors(s);
      } finally {
        await s.close();
      }
    }
  }
});
