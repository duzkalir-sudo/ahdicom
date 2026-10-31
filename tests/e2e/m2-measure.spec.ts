/**
 * M2 measurements in the real app: tools drawn with the mouse on fixtures with known answers.
 * Values are read from the same lines the app shows next to the drawing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cdvState, expectNoErrors, fixture, launch, openPaths, screenshot, setSize, vpState, waitReady, type Session } from './harness';

interface Entry {
  uid: string;
  tool: string;
  imageId: string;
  lines: string[];
  label?: string;
  name?: string;
  pixels: [number, number][];
}

async function measurements(page: Page): Promise<Entry[]> {
  return page.evaluate(() => (window as unknown as { __cdv: { measurements(): Entry[] } }).__cdv.measurements());
}

async function pixelToClient(page: Page, column: number, row: number, i = 0): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    ([idx, c, r]) =>
      (
        window as unknown as { __cdv: { pixelToClient(i: number, c: number, r: number): { x: number; y: number } | undefined } }
      ).__cdv.pixelToClient(idx!, c!, r!),
    [i, column, row],
  );
  if (!p) throw new Error('pixelToClient failed');
  return p;
}

/** Drags with the left button between two image pixels. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await pixelToClient(page, ...from);
  const b = await pixelToClient(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(a.x + ((b.x - a.x) * k) / 8, a.y + ((b.y - a.y) * k) / 8);
  await page.mouse.up();
}

/**
 * Clicks an image pixel. Cornerstone treats a second press within 400 ms as a possible double-click, so separate
 * clicks are spaced like a person would click them.
 */
async function clickPixel(page: Page, p: [number, number]): Promise<void> {
  const c = await pixelToClient(page, ...p);
  await page.mouse.move(c.x, c.y, { steps: 3 });
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(450);
}

/** Mouse positions are whole CSS pixels, so a point can be off by up to half a CSS pixel in image pixels. */
function near(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected), `${actual} ≈ ${expected} ± ${tolerance}`).toBeLessThanOrEqual(tolerance);
}

/** First number in a line; Turkish uses a decimal comma and a thousands dot, English the reverse. */
function num(line: string | undefined, re = /(-?\d[\d.,]*)/, lang: 'tr' | 'en' = 'en'): number {
  const m = re.exec(line ?? '');
  if (!m) throw new Error(`no number in "${line}"`);
  const raw = m[1]!;
  return Number(lang === 'tr' ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''));
}

const numTr = (line: string | undefined, re?: RegExp): number => num(line, re, 'tr');

async function last(page: Page, tool: string): Promise<Entry> {
  await expect.poll(async () => (await measurements(page)).filter((m) => m.tool === tool && m.lines.length > 0).length).toBeGreaterThan(0);
  const all = (await measurements(page)).filter((m) => m.tool === tool);
  return all[all.length - 1]!;
}

async function openSeries(s: Session, dir: string, description?: string): Promise<void> {
  await openPaths(s, [fixture(dir)]);
  if (description) await showSeries(s, description);
  await waitReady(s.page);
}

/** Shows an already opened series (by description) in the active viewport. */
async function showSeries(s: Session, description: string): Promise<void> {
  const st = await cdvState(s.page);
  const ds = st.studies.flatMap((x) => x.series).find((x) => x.description === description)!.displaySets[0]!;
  await s.page.locator(`[data-ds-id="${ds.id}"]`).click();
  await expect.poll(async () => (await vpState(s.page)).displaySetId).toBe(ds.id);
  await waitReady(s.page);
}

async function scrollTo(s: Session, index: number): Promise<void> {
  await s.page.getByTestId('viewport-0').click({ position: { x: 5, y: 5 } });
  await s.page.keyboard.press('Home');
  for (let k = 0; k < index; k++) await s.page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await vpState(s.page)).index).toBe(index);
}

/**
 * A tool chosen within 450 ms of a viewport click takes effect after Cornerstone's double-click window (the held click
 * belongs to the previous tool); wait like a person moving to the next point would.
 */
async function pickTool(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
}

async function pickFromMenu(page: Page, tool: string): Promise<void> {
  await page.getByTestId('tb-measure-more').click();
  await page.getByTestId(`measure-${tool}`).click();
  await page.waitForTimeout(500);
}

test('length, ellipse ROI (HU), angle and rectangle on the CT phantom', async () => {
  const s = await launch();
  try {
    await openSeries(s, 'ct-phantom');
    await scrollTo(s, 32); // z = 0: the 1000 HU sphere (r = 10 mm) is centred at pixel (156, 176)

    await pickTool(s.page, 'm');
    await expect(s.page.getByTestId('tb-measure-length')).toHaveAttribute('aria-pressed', 'true');
    await drag(s.page, [136, 260], [176, 260]); // in water, away from the ROI drawn next
    const len = await last(s.page, 'length');
    near(numTr(len.lines[0]), 20, 0.3); // 40 px × 0.5 mm
    expect(len.lines[0]).toMatch(/mm$/);

    await pickTool(s.page, 'e');
    await drag(s.page, [156, 176], [164, 184]); // centre → corner: radius 8 px = 4 mm, inside the sphere
    const roi = await last(s.page, 'ellipse');
    // Expected area from the handles actually placed (mouse positions snap to whole CSS pixels): π · a · b, 0.5 mm pixels.
    const [bottom, top, left, right] = roi.pixels as [number, number][];
    const semiA = (Math.abs(right![0] - left![0]) / 2) * 0.5;
    const semiB = (Math.abs(top![1] - bottom![1]) / 2) * 0.5;
    near(numTr(roi.lines[0]), Math.PI * semiA * semiB, 0.06);
    near(Math.PI * semiA * semiB, Math.PI * 16, 5); // ≈ the intended 4 mm radius
    expect(roi.lines[0]).toContain('mm²');
    expect(numTr(roi.lines[1])).toBe(1000);
    expect(roi.lines[1]).toContain('HU');
    expect(numTr(roi.lines[1], /(?:SS|SD) (-?\d[\d.,]*)/)).toBe(0);

    await pickTool(s.page, 'n');
    const a = await pixelToClient(s.page, 300, 300);
    const v = await pixelToClient(s.page, 350, 300);
    const c = await pixelToClient(s.page, 350, 250);
    await s.page.mouse.move(a.x, a.y);
    await s.page.mouse.down();
    for (let k = 1; k <= 6; k++) await s.page.mouse.move(a.x + ((v.x - a.x) * k) / 6, a.y);
    await s.page.mouse.up();
    await s.page.mouse.move(c.x, c.y, { steps: 4 });
    await s.page.mouse.click(c.x, c.y);
    await s.page.waitForTimeout(500); // Cornerstone holds a click 400 ms for double-click detection (R-024)
    const ang = await last(s.page, 'angle');
    near(numTr(ang.lines[0]), 90, 1);

    // Rectangle over water and the −100 HU sphere edge: area only depends on the corners.
    await pickFromMenu(s.page, 'rectangle');
    await drag(s.page, [200, 300], [240, 320]); // 40 × 20 px = 20 × 10 mm
    const rect = await last(s.page, 'rectangle');
    near(numTr(rect.lines[0]), 2, 0.1); // 200 mm² is shown as 2,00 cm²
    expect(rect.lines[0]).toContain('cm²');

    await screenshot(s.page, 'M2', 'measure-ct-1280x800-dark-tr');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('anisotropic pixels: the 25 mm circle measures 50 mm in both directions', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openSeries(s, 'aniso');
    await pickTool(s.page, 'm');
    // Centre (x, y) = (0, 0) is pixel (64, 64); columns are 0.5 mm apart, rows 1.0 mm.
    await drag(s.page, [14, 64], [114, 64]);
    await drag(s.page, [64, 39], [64, 89]);
    const all = (await measurements(s.page)).filter((m) => m.tool === 'length');
    expect(all).toHaveLength(2);
    near(num(all[0]!.lines[0]), 50, 0.3);
    near(num(all[1]!.lines[0]), 50, 0.6);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('projection radiograph uses Imager Pixel Spacing corrected for magnification; manual calibration', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openSeries(s, 'cr-mag');
    await pickTool(s.page, 'm');
    await drag(s.page, [100, 200], [210, 200]); // 110 px × 0.2 mm / 1.1 = 20 mm
    const len = await last(s.page, 'length');
    near(num(len.lines[0]), 20, 0.3);
    expect(len.lines[0]).toContain('(magnification corrected)');

    // Calibrate: a 100 px line is declared to be 50 mm.
    await pickFromMenu(s.page, 'calibrate');
    await drag(s.page, [100, 300], [200, 300]);
    await expect(s.page.getByTestId('prompt-dialog')).toBeVisible();
    await s.page.getByTestId('prompt-input').fill('50');
    await s.page.getByTestId('prompt-ok').click();
    await expect(s.page.getByTestId('prompt-dialog')).toHaveCount(0);
    await expect.poll(async () => (await measurements(s.page)).filter((m) => m.tool === 'calibrate')).toHaveLength(0);
    // The existing 110 px line is now 55 mm.
    await expect.poll(async () => (await measurements(s.page)).find((m) => m.tool === 'length')?.lines[0]).toContain('(calibrated)');
    near(num((await measurements(s.page)).find((m) => m.tool === 'length')!.lines[0]), 55, 0.6);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('ultrasound: calibrated region gives mm, outside the region falls back to pixels with a warning', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openSeries(s, 'us-regions');
    await pickTool(s.page, 'm');
    await drag(s.page, [150, 100], [150, 400]); // 300 px × 0.2 mm = 60 mm
    const inside = await last(s.page, 'length');
    near(num(inside.lines[0]), 60, 0.3);
    expect(inside.lines[0]).toContain('(US region)');
    await drag(s.page, [20, 20], [80, 20]);
    const all = (await measurements(s.page)).filter((m) => m.tool === 'length');
    expect(all[1]!.lines[0]).toMatch(/px$/);
    expect(all[1]!.lines[1]).toContain('Outside the calibrated US region');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('PET ROI reports SUVbw; missing tags refuse SUV and name them', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openSeries(s, 'pet');
    await scrollTo(s, 20); // z = 2 mm, inside the 30 mm hot sphere (20 000 Bq/ml)
    await pickTool(s.page, 'e');
    await drag(s.page, [64, 64], [67, 67]);
    const roi = await last(s.page, 'ellipse');
    expect(roi.lines[1]).toContain('SUVbw');
    expect(num(roi.lines[1], /Mean (-?\d[\d.,]*)/)).toBeCloseTo(5.19, 2);

    // A click on the viewport with the ellipse tool would start an ROI: navigate with the W/L tool.
    await pickTool(s.page, 'w');
    await openSeries(s, 'pet-missing', 'PET AC (MISSING SUV TAGS)');
    await scrollTo(s, 20);
    await pickTool(s.page, 'e');
    await drag(s.page, [64, 64], [67, 67]);
    const all = (await measurements(s.page)).filter((m) => m.tool === 'ellipse');
    const missing = all.find((m) => m.lines.some((l) => l.includes('SUV not available')))!;
    expect(missing.lines.join(' ')).toContain('PatientWeight, RadionuclideTotalDose');
    expect(missing.lines[1]).toContain('Bq/ml');
    expect(num(missing.lines[1], /Mean (-?\d[\d.,]*)/)).toBeCloseTo(20000, 0);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('arrow with text, Esc cancels an unfinished polygon, Delete removes the selected measurement', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openSeries(s, 'ct-phantom');
    await pickTool(s.page, 't');
    await drag(s.page, [100, 100], [160, 150]);
    await expect(s.page.getByTestId('prompt-dialog')).toBeVisible();
    await s.page.getByTestId('prompt-input').fill('Lezyon İğne');
    await s.page.getByTestId('prompt-ok').click();
    await expect.poll(async () => (await measurements(s.page)).find((m) => m.tool === 'arrow')?.label).toBe('Lezyon İğne');

    await pickFromMenu(s.page, 'polygon');
    await clickPixel(s.page, [300, 300]);
    await clickPixel(s.page, [340, 300]);
    await clickPixel(s.page, [340, 340]);
    await s.page.keyboard.press('Escape');
    await expect.poll(async () => (await measurements(s.page)).filter((m) => m.tool === 'polygon')).toHaveLength(0);

    // A finished polygon: click back on the first point to close it.
    await clickPixel(s.page, [300, 300]);
    await clickPixel(s.page, [340, 300]);
    await clickPixel(s.page, [340, 340]);
    await clickPixel(s.page, [300, 340]);
    await clickPixel(s.page, [300, 300]);
    const poly = await last(s.page, 'polygon');
    near(num(poly.lines[0]), 4, 0.15); // 40 × 40 px = 20 × 20 mm = 4.00 cm²
    expect(poly.lines[0]).toContain('cm²');

    // Select the length line and delete it.
    await pickTool(s.page, 'm');
    await drag(s.page, [100, 400], [200, 400]);
    await expect.poll(async () => (await measurements(s.page)).filter((m) => m.tool === 'length')).toHaveLength(1);
    await pickTool(s.page, 'w');
    await clickPixel(s.page, [150, 400]);
    await s.page.keyboard.press('Delete');
    await expect.poll(async () => (await measurements(s.page)).filter((m) => m.tool === 'length')).toHaveLength(0);

    // A single click starts an ellipse that follows the mouse; Esc cancels it.
    await pickTool(s.page, 'e');
    await clickPixel(s.page, [400, 120]);
    await s.page.keyboard.press('Escape');
    await expect.poll(async () => (await measurements(s.page)).filter((m) => m.tool === 'ellipse')).toHaveLength(0);

    // Two clicks on the same point finish a zero-length line, which is discarded.
    await pickTool(s.page, 'm');
    await clickPixel(s.page, [420, 120]);
    await clickPixel(s.page, [420, 120]);
    await expect.poll(async () => (await measurements(s.page)).filter((m) => m.tool === 'length')).toHaveLength(0);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('measurement list: rename, volume from three diameters, delete, undo/redo, jump, and persistence across restart', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cdv-e2e-persist-'));
  try {
    const s = await launch({ lang: 'en', userData });
    let saved: Entry[];
    try {
      await openSeries(s, 'ct-phantom');
      await scrollTo(s, 32);
      await pickTool(s.page, 'm');
      await drag(s.page, [100, 260], [160, 260]); // 30 mm
      await drag(s.page, [100, 280], [140, 280]); // 20 mm
      await drag(s.page, [100, 300], [120, 300]); // 10 mm
      await pickTool(s.page, 'e');
      await drag(s.page, [300, 300], [310, 310]);
      await expect.poll(async () => (await measurements(s.page)).length).toBe(4);

      await s.page.getByTestId('tab-measurements').click();
      await expect(s.page.getByTestId('measure-row')).toHaveCount(4);
      await expect(s.page.getByTestId('measure-count')).toHaveText('4 measurements');

      // Rename the first length; the name is shown in the list and above the value on the image.
      const first = s.page.getByTestId('measure-row').first();
      await first.getByTestId('measure-rename').click();
      await s.page.getByTestId('measure-rename-input').fill('Tumour AP');
      await s.page.getByTestId('measure-rename-input').press('Enter');
      await expect(first).toContainText('Tumour AP');
      await expect.poll(async () => (await measurements(s.page)).find((m) => m.name === 'Tumour AP')?.tool).toBe('length');

      // Volume from the three lengths (values taken from the app's own lengths in mm).
      const lengths = (await measurements(s.page)).filter((m) => m.tool === 'length').map((m) => num(m.lines[0]));
      for (const box of await s.page.getByTestId('measure-check').all()) await box.check();
      await expect(s.page.getByTestId('volume-box')).toBeVisible();
      const prod = lengths.reduce((p, v) => p * v, 1);
      near(num(await s.page.getByTestId('volume-ellipsoid').innerText()), ((Math.PI / 6) * prod) / 1000, 0.05);
      near(num(await s.page.getByTestId('volume-bullet').innerText()), (((5 * Math.PI) / 24) * prod) / 1000, 0.05);

      // Delete from the list, then undo / redo with the keyboard.
      await s.page.getByTestId('measure-row').last().getByTestId('measure-delete').click();
      await expect(s.page.getByTestId('measure-row')).toHaveCount(3);
      await s.page.getByTestId('viewport-0').hover();
      await s.page.keyboard.press('Control+z');
      await expect(s.page.getByTestId('measure-row')).toHaveCount(4);
      await s.page.keyboard.press('Control+y');
      await expect(s.page.getByTestId('measure-row')).toHaveCount(3);
      await s.page.keyboard.press('Control+z');
      await expect(s.page.getByTestId('measure-row')).toHaveCount(4);

      // Jump: from another slice, clicking a row shows the measurement's image.
      await s.page.keyboard.press('Home');
      await expect.poll(async () => (await vpState(s.page)).index).toBe(0);
      await s.page.getByTestId('measure-row').first().click();
      await expect.poll(async () => (await vpState(s.page)).index).toBe(32);

      await screenshot(s.page, 'M2', 'measure-list-1280x800-dark-en');
      saved = await measurements(s.page);
      // Saving is asynchronous; give the last write a moment before quitting.
      await s.page.waitForTimeout(500);
      expectNoErrors(s);
    } finally {
      await s.close();
    }

    // Restart with the same app data: the measurements come back with their names and values.
    const s2 = await launch({ lang: 'en', userData });
    try {
      await openSeries(s2, 'ct-phantom');
      await expect.poll(async () => (await measurements(s2.page)).length).toBe(4);
      const restored = await measurements(s2.page);
      const key = (m: Entry): string => `${m.tool}|${m.name ?? ''}|${m.lines[0]}`;
      expect(restored.map(key).sort()).toEqual(saved.map(key).sort());
      for (const m of restored) {
        const before = saved.find((x) => x.uid === m.uid)!;
        m.pixels.forEach((p, k) => {
          near(p[0], before.pixels[k]![0], 1e-6);
          near(p[1], before.pixels[k]![1], 1e-6);
        });
      }
      // Undo cannot remove measurements loaded from disk.
      await s2.page.getByTestId('tab-measurements').click();
      await expect(s2.page.getByTestId('measure-undo')).toHaveAttribute('aria-disabled', 'true');
      expectNoErrors(s2);
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('manual calibration is saved with the study and shown in the Info panel', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cdv-e2e-persist-'));
  try {
    const s = await launch({ lang: 'en', userData });
    try {
      await openSeries(s, 'cr-mag');
      await pickFromMenu(s.page, 'calibrate');
      await drag(s.page, [100, 300], [200, 300]);
      await s.page.getByTestId('prompt-input').fill('50,0'); // a decimal comma is accepted too
      await s.page.getByTestId('prompt-ok').click();
      await s.page.getByTestId('tab-info').click();
      await expect(s.page.getByTestId('info-calibration')).toContainText('(calibrated)');
      // The 100 px line declared 50 mm gives 0.5 mm per pixel in both directions.
      const cal = await s.page.evaluate(() =>
        (window as unknown as { __cdv: { calibrations(): Record<string, { rowMm: number; columnMm: number }> } }).__cdv.calibrations(),
      );
      const [only] = Object.values(cal);
      near(only!.columnMm, 0.5, 0.01);
      near(only!.rowMm, 0.5, 0.01);
      await s.page.waitForTimeout(500);
      expectNoErrors(s);
    } finally {
      await s.close();
    }
    const s2 = await launch({ lang: 'en', userData });
    try {
      await openSeries(s2, 'cr-mag');
      await s2.page.getByTestId('tab-info').click();
      await expect(s2.page.getByTestId('info-calibration')).toContainText('(calibrated)');
      await pickTool(s2.page, 'm');
      await drag(s2.page, [100, 400], [210, 400]); // 110 px at 0.5 mm/px (calibrated) = 55 mm
      const len = await last(s2.page, 'length');
      expect(len.lines[0]).toContain('(calibrated)');
      near(num(len.lines[0]), 55, 0.6);
      await s2.page.getByTestId('tab-measurements').click();
      await expect(s2.page.getByTestId('calibration-list')).toBeVisible();
      expectNoErrors(s2);
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('a measurement on a series that left the viewport stays listed and saved', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cdv-e2e-persist-'));
  try {
    const s = await launch({ lang: 'en', userData });
    try {
      await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal')]);
      await showSeries(s, 'AXIAL');
      await pickTool(s.page, 'm');
      await drag(s.page, [40, 64], [100, 64]);
      const before = await last(s.page, 'length');
      // Show another series in the same (only) viewport: the axial images and metadata are released.
      await pickTool(s.page, 'w');
      await showSeries(s, 'SAGITTAL');
      await s.page.getByTestId('tab-measurements').click();
      await expect(s.page.getByTestId('measure-row')).toHaveCount(1);
      await expect(s.page.getByTestId('measure-value')).toHaveText(before.lines[0]!);
      // Any later change triggers a save; the axial measurement must still be in it.
      await pickTool(s.page, 'm');
      await drag(s.page, [40, 64], [100, 64]);
      await expect(s.page.getByTestId('measure-row')).toHaveCount(2);
      await s.page.waitForTimeout(500);
      expectNoErrors(s);
    } finally {
      await s.close();
    }
    const s2 = await launch({ lang: 'en', userData });
    try {
      await openPaths(s2, [fixture('orient-axial'), fixture('orient-sagittal')]);
      await waitReady(s2.page);
      await expect.poll(async () => (await measurements(s2.page)).length).toBe(2);
      expectNoErrors(s2);
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('each image of a series is measured with its own calibration (US at two depths)', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openSeries(s, 'us-multi');
    expect((await vpState(s.page)).total).toBe(2); // one display set with both images
    await pickTool(s.page, 'm');
    await drag(s.page, [150, 100], [250, 100]); // image 1: 100 px × 0.2 mm
    await s.page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await vpState(s.page)).index).toBe(1);
    await drag(s.page, [150, 200], [250, 200]); // image 2: 100 px × 0.4 mm
    await expect.poll(async () => (await measurements(s.page)).filter((m) => m.tool === 'length' && m.lines.length > 0).length).toBe(2);
    const all = (await measurements(s.page)).filter((m) => m.tool === 'length');
    const values = all.map((m) => num(m.lines[0])).sort((a, b) => a - b);
    near(values[0]!, 20, 0.6);
    near(values[1]!, 40, 1.2);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('a calibration survives a save made while only part of its study is open', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cdv-e2e-persist-'));
  try {
    // 1: calibrate the sagittal series of the orientation study.
    let s = await launch({ lang: 'en', userData });
    try {
      await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal')]);
      await showSeries(s, 'SAGITTAL');
      await pickFromMenu(s.page, 'calibrate');
      await drag(s.page, [20, 20], [120, 20]);
      await s.page.getByTestId('prompt-input').fill('25');
      await s.page.getByTestId('prompt-ok').click();
      await s.page.getByTestId('tab-info').click();
      await expect(s.page.getByTestId('info-calibration')).toBeVisible();
      await s.page.waitForTimeout(500);
      expectNoErrors(s);
    } finally {
      await s.close();
    }
    // 2: open only the axial series of the same study and change something, which rewrites the study file.
    s = await launch({ lang: 'en', userData });
    try {
      await openPaths(s, [fixture('orient-axial')]);
      await waitReady(s.page);
      await pickTool(s.page, 'm');
      await drag(s.page, [40, 64], [100, 64]);
      await expect.poll(async () => (await measurements(s.page)).length).toBe(1);
      await s.page.waitForTimeout(500);
      expectNoErrors(s);
    } finally {
      await s.close();
    }
    // 3: the sagittal calibration is still there.
    s = await launch({ lang: 'en', userData });
    try {
      await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal')]);
      await showSeries(s, 'SAGITTAL');
      await s.page.getByTestId('tab-info').click();
      await expect(s.page.getByTestId('info-calibration')).toContainText('(calibrated)');
      expectNoErrors(s);
    } finally {
      await s.close();
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('dialogs take keyboard input at once: calibration typed after click-move-click, Esc cancels, text prompt', async () => {
  const s = await launch({ lang: 'tr' });
  try {
    await openSeries(s, 'cr-mag');
    // Draw the calibration line the way a person often does: click, move, click.
    await pickFromMenu(s.page, 'calibrate');
    const a = await pixelToClient(s.page, 100, 300);
    const b = await pixelToClient(s.page, 200, 300);
    await s.page.mouse.click(a.x, a.y);
    await s.page.mouse.move(b.x, b.y, { steps: 10 });
    await s.page.waitForTimeout(450);
    await s.page.mouse.click(b.x, b.y);
    await expect(s.page.getByTestId('prompt-dialog')).toBeVisible();
    // Typed keys go straight into the field (no click needed); an invalid entry explains itself.
    await expect(s.page.getByTestId('prompt-input')).toBeFocused();
    await s.page.keyboard.type('abc');
    await expect(s.page.getByTestId('prompt-error')).toBeVisible();
    await expect(s.page.getByTestId('prompt-ok')).toBeDisabled();
    await screenshot(s.page, 'M2', 'calibrate-invalid-1280x800-dark-tr');
    await s.page.keyboard.press('Control+a');
    await s.page.keyboard.type('50');
    await expect(s.page.getByTestId('prompt-error')).toHaveCount(0);
    await s.page.keyboard.press('Enter');
    await expect(s.page.getByTestId('prompt-dialog')).toHaveCount(0);
    const cal = await s.page.evaluate(() =>
      (window as unknown as { __cdv: { calibrations(): Record<string, { rowMm: number; columnMm: number }> } }).__cdv.calibrations(),
    );
    near(Object.values(cal)[0]!.columnMm, 0.5, 0.01);

    // Esc cancels the dialog without calibrating.
    await pickFromMenu(s.page, 'calibrate');
    await drag(s.page, [100, 400], [150, 400]);
    await expect(s.page.getByTestId('prompt-input')).toBeFocused();
    await s.page.keyboard.type('7');
    await s.page.keyboard.press('Escape');
    await expect(s.page.getByTestId('prompt-dialog')).toHaveCount(0);
    const after = await s.page.evaluate(() =>
      (window as unknown as { __cdv: { calibrations(): Record<string, { rowMm: number; columnMm: number }> } }).__cdv.calibrations(),
    );
    near(Object.values(after)[0]!.columnMm, 0.5, 0.01);

    // Arrow text is typed directly as well.
    await pickTool(s.page, 't');
    await drag(s.page, [300, 100], [250, 150]);
    await expect(s.page.getByTestId('prompt-input')).toBeFocused();
    await s.page.keyboard.type('Kırık şüphesi');
    await s.page.keyboard.press('Enter');
    await expect.poll(async () => (await measurements(s.page)).find((m) => m.tool === 'arrow')?.label).toBe('Kırık şüphesi');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('M2 screenshot matrix (sizes × themes × languages)', async () => {
  test.setTimeout(600_000);
  for (const lang of ['tr', 'en'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      const s = await launch({ lang, theme });
      try {
        await openPaths(s, [fixture('ct-phantom'), fixture('pet-missing')]);
        await showSeries(s, 'PHANTOM 2.5mm');
        await scrollTo(s, 32);
        await pickTool(s.page, 'm');
        await drag(s.page, [136, 260], [176, 260]);
        await pickTool(s.page, 'e');
        await drag(s.page, [156, 176], [164, 184]);
        await pickTool(s.page, 'n');
        const a = await pixelToClient(s.page, 300, 330);
        const v = await pixelToClient(s.page, 350, 330);
        const c = await pixelToClient(s.page, 350, 280);
        await s.page.mouse.move(a.x, a.y);
        await s.page.mouse.down();
        await s.page.mouse.move(v.x, v.y, { steps: 6 });
        await s.page.mouse.up();
        await s.page.mouse.move(c.x, c.y, { steps: 4 });
        await s.page.mouse.click(c.x, c.y);
        await s.page.waitForTimeout(500);
        await pickTool(s.page, 't');
        await drag(s.page, [380, 120], [330, 160]);
        await s.page.getByTestId('prompt-input').fill(lang === 'tr' ? 'Kalsifikasyon şüphesi' : 'Suspected calcification');
        await screenshot(s.page, 'M2', `text-prompt-1280x800-${theme}-${lang}`);
        await s.page.getByTestId('prompt-ok').click();
        await s.page.getByTestId('tab-measurements').click();
        const first = s.page.getByTestId('measure-row').first();
        await first.getByTestId('measure-rename').click();
        await s.page
          .getByTestId('measure-rename-input')
          .fill(lang === 'tr' ? 'Sağ lezyon çapı (aksiyel)' : 'Right lesion diameter (axial)');
        await s.page.getByTestId('measure-rename-input').press('Enter');
        await pickTool(s.page, 'w');
        for (const [w, h] of [
          [1280, 800],
          [1920, 1080],
        ] as const) {
          await setSize(s.app, w, h);
          await s.page.waitForTimeout(400);
          await screenshot(s.page, 'M2', `measure-${w}x${h}-${theme}-${lang}`);
        }
        await setSize(s.app, 1280, 800);
        await s.page.getByTestId('tb-measure-more').click();
        await expect(s.page.getByTestId('measure-menu')).toBeVisible();
        await screenshot(s.page, 'M2', `measure-menu-1280x800-${theme}-${lang}`);
        await s.page.keyboard.press('Escape');
        // PET without SUV tags: the refusal text is the longest line a ROI shows.
        await showSeries(s, 'PET AC (MISSING SUV TAGS)');
        await scrollTo(s, 20);
        await pickTool(s.page, 'e');
        await drag(s.page, [64, 64], [70, 70]);
        await pickTool(s.page, 'w');
        await s.page.waitForTimeout(300);
        await screenshot(s.page, 'M2', `pet-refusal-1280x800-${theme}-${lang}`);
        expectNoErrors(s);
      } finally {
        await s.close();
      }
    }
  }
});
