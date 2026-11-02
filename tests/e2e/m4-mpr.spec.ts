/**
 * M4 MPR and 3D in the real app. Expected planes, labels and values follow from the fixture geometry:
 * ct-phantom: 512 × 512 × 64, 0.5 mm pixels, 2.5 mm slices; pixel (c, r) of slice k is at
 * x = −128 + 0.5c, y = −128 + 0.5r, z = −80 + 2.5k; a 1000 HU sphere (radius 10 mm) is centred at (−50, −40, 0).
 */
import { expect, test, type Page } from '@playwright/test';
import { cdvState, expectNoErrors, fixture, launch, openPaths, screenshot, vpState, waitReady, type Session } from './harness';

interface ReformatState {
  view: string;
  status: string;
  index: number;
  total: number;
  labels?: { top: string; bottom: string; left: string; right: string };
  probe?: { column: number; row: number; value?: number };
  reformat?: { spacing: number; location?: { mm: number; towards: string }; warnings: { code: string }[] };
  refusal?: string;
}

async function rs(page: Page, i: number): Promise<ReformatState> {
  return (await vpState(page, i)) as unknown as ReformatState;
}

async function pixelToClient(page: Page, i: number, column: number, row: number): Promise<{ x: number; y: number }> {
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

async function openMpr(s: Session): Promise<void> {
  await s.page.getByTestId('tb-view').click();
  await s.page.getByTestId('view-mpr').click();
  for (const i of [0, 1, 2]) await expect.poll(async () => (await rs(s.page, i)).status, { timeout: 30000 }).toBe('ready');
}

/** Scrolls viewport vp to an index with the keyboard (the viewport becomes active). */
async function scrollTo(s: Session, vp: number, index: number): Promise<void> {
  await s.page.getByTestId(`viewport-${vp}`).click({ position: { x: 5, y: 5 } });
  const cur = (await rs(s.page, vp)).index;
  const key = index > cur ? 'ArrowDown' : 'ArrowUp';
  for (let k = 0; k < Math.abs(index - cur); k++) await s.page.keyboard.press(key);
  await expect.poll(async () => (await rs(s.page, vp)).index).toBe(index);
}

test('MPR of the CT phantom: three reformats with patient-correct planes, labels and voxel values', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await openMpr(s);
    const st = await cdvState(s.page);
    expect(st.layout).toEqual({ kind: '1+2' });
    const [ax, cor, sag] = [await rs(s.page, 0), await rs(s.page, 1), await rs(s.page, 2)];
    expect([ax.view, cor.view, sag.view]).toEqual(['axial', 'coronal', 'sagittal']);
    // Axial: the original 64 slices, 2.5 mm apart; coronal and sagittal: 512 planes 0.5 mm apart.
    expect([ax.total, ax.reformat?.spacing]).toEqual([64, 2.5]);
    expect([cor.total, cor.reformat?.spacing]).toEqual([512, 0.5]);
    expect([sag.total, sag.reformat?.spacing]).toEqual([512, 0.5]);
    expect(ax.labels).toMatchObject({ top: 'A', bottom: 'P', left: 'R', right: 'L' });
    expect(cor.labels).toMatchObject({ top: 'H', bottom: 'F', left: 'R', right: 'L' });
    expect(sag.labels).toMatchObject({ top: 'H', bottom: 'F', left: 'A', right: 'P' });
    for (const r of [ax, cor, sag]) expect(r.reformat?.warnings).toEqual([]);

    // Sagittal plane through x = −50 (k = (−50 + 128) / 0.5 = 156) shows the 1000 HU sphere centred at y = −40, z = 0:
    // column (−40 + 128) / 0.5 = 176, row (77.5 − 0) / 0.5 = 155 (top row at the highest slice, z = 77.5).
    await scrollTo(s, 2, 156);
    expect((await rs(s.page, 2)).reformat?.location).toEqual({ mm: -50, towards: 'L' });
    const p = await pixelToClient(s.page, 2, 176, 155);
    await s.page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await rs(s.page, 2)).probe).toMatchObject({ column: 176, row: 155, value: 1000 });
    // Water (0 HU) at the centre of the axial middle slice, air (−1000 HU) in its corner.
    const axial = await rs(s.page, 0);
    expect(axial.index).toBe(31);
    const c = await pixelToClient(s.page, 0, 256, 256);
    await s.page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await rs(s.page, 0)).probe?.value).toBe(0);
    await screenshot(s.page, 'M4', 'mpr-ct-phantom-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

interface Crosshair {
  crosshair?: { line: [[number, number], [number, number]]; color: string; source: number }[];
  center?: [number, number];
}

async function crosshair(page: Page, i: number): Promise<Crosshair> {
  return (await page.evaluate((idx) => (window as unknown as { __cdv: { guides(i: number): unknown } }).__cdv.guides(idx), i)) as Crosshair;
}

test('MPR crosshair: a dragged line moves its plane, a dragged handle turns it (oblique), slab MIP', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await openMpr(s);
    // Axial shows the coronal (y = 0 → row 256) and sagittal (x = −0.5 → column 255) planes, crossing at (255, 256).
    await expect.poll(async () => (await crosshair(s.page, 0)).crosshair?.map((x) => x.source).sort()).toEqual([1, 2]);
    const g = await crosshair(s.page, 0);
    expect(g.center?.map((v) => Math.round(v * 10) / 10)).toEqual([255, 256]);

    // Drag the sagittal line (column 255) to column 156 (x = −50): the sagittal view follows.
    const from = await pixelToClient(s.page, 0, 255, 400);
    const to = await pixelToClient(s.page, 0, 156, 400);
    await s.page.mouse.move(from.x, from.y);
    await s.page.mouse.down();
    await s.page.mouse.move(to.x, to.y, { steps: 5 });
    await s.page.mouse.up();
    await expect.poll(async () => (await rs(s.page, 2)).index).toBe(156);
    expect((await rs(s.page, 2)).reformat?.location).toEqual({ mm: -50, towards: 'L' });

    // Turn the coronal plane: drag its handle 30° clockwise on screen around the centre (once the crosshair has
    // followed the sagittal move: guides are redrawn on the next frame).
    await expect.poll(async () => (await crosshair(s.page, 0)).center?.map((v) => Math.round(v))).toEqual([156, 256]);
    const center = (await crosshair(s.page, 0)).center!;
    const c = await pixelToClient(s.page, 0, center[0], center[1]);
    const coronalLine = (await crosshair(s.page, 0)).crosshair!.find((x) => x.source === 1)!.line;
    const dir = Math.sign(coronalLine[1][0] - coronalLine[0][0]);
    const r = 70; // handle distance (CSS px)
    await s.page.mouse.move(c.x + dir * r, c.y);
    await s.page.mouse.down();
    for (let k = 1; k <= 6; k++) {
      const a = ((5 * k) / 180) * Math.PI;
      await s.page.mouse.move(c.x + dir * r * Math.cos(a), c.y + dir * r * Math.sin(a));
    }
    await s.page.mouse.up();
    await expect
      .poll(async () => {
        const l = (await crosshair(s.page, 0)).crosshair!.find((x) => x.source === 1)!.line;
        const deg = (Math.atan2(l[1][1] - l[0][1], l[1][0] - l[0][0]) * 180) / Math.PI;
        return Math.round((((deg % 180) + 180) % 180) * 10) / 10;
      })
      .toBeCloseTo(30, 0);
    await screenshot(s.page, 'M4', 'mpr-oblique-1280x800-dark-en');

    // Slab: sagittal at x = −62 lies 2 mm outside the 1000 HU sphere (x −60…−40); a 20 mm MIP slab reaches into it.
    await scrollTo(s, 2, 132);
    const p = await pixelToClient(s.page, 2, 176, 155);
    await s.page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await rs(s.page, 2)).probe?.value).toBe(0);
    await s.page.getByTestId('tb-view').click();
    await s.page.getByTestId('slab-mip').click();
    await s.page.getByTestId('tb-view').click();
    await s.page.getByTestId('slab-mm-20').click();
    await expect(s.page.getByTestId('viewport-2').getByTestId('slab-text')).toHaveText('MIP 20.0 mm');
    await s.page.mouse.move(p.x + 1, p.y);
    await s.page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await rs(s.page, 2)).probe?.value).toBe(1000);
    await screenshot(s.page, 'M4', 'mpr-slab-mip-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }): Promise<void> {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

test('measurements on a reformat: lengths and ROI values from the volume; none on approximate geometry; refusals', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await openMpr(s);
    await scrollTo(s, 2, 156); // sagittal through x = −50, the centre of the 1000 HU sphere (radius 10 mm)
    const svgText = s.page.getByTestId('viewport-2').locator('svg text');
    // Ellipse ROI (centre → corner) of radius 8 px = 4 mm at the sphere centre: every voxel is 1000 HU. It starts on
    // the axial crosshair line: with a measurement tool selected, lines are not grabbed.
    await s.page.keyboard.press('e');
    await drag(s.page, await pixelToClient(s.page, 2, 176, 155), await pixelToClient(s.page, 2, 184, 163));
    // The text box is one SVG text whose lines are joined in its text content.
    await expect
      .poll(async () => (await svgText.allTextContents()).filter((x) => /Mean 1,000\.0 HU\s+SD 0\.0Min 1,000\.0\s+Max 1,000\.0/.test(x)))
      .toHaveLength(1);
    // Axial reformat (z = 0): horizontal diameter of the same sphere, columns 136…176 at row 176 (x = −60 … −40) =
    // 20 mm. Mouse events carry whole CSS pixels (0.75 mm at this zoom), so each end point can be half a pixel off.
    const axialText = s.page.getByTestId('viewport-0').locator('svg text');
    await s.page.keyboard.press('m');
    await drag(s.page, await pixelToClient(s.page, 0, 136, 176), await pixelToClient(s.page, 0, 176, 176));
    await expect.poll(async () => (await axialText.allTextContents()).filter((x) => x.endsWith(' mm'))).toHaveLength(1);
    const mmPerCssPx = (await vpState(s.page, 0)).mmPerCssPx!;
    const text = (await axialText.allTextContents()).find((x) => x.endsWith(' mm'))!;
    expect(Math.abs(Number(text.replace(' mm', '').replace(',', '')) - 20)).toBeLessThanOrEqual(mmPerCssPx + 0.05);
    // Each drawing shows on its own plane only: the sagittal ROI not on the axial view, the axial length not on the
    // sagittal view.
    expect((await axialText.allTextContents()).some((x) => x.includes('Mean'))).toBe(false);
    expect((await svgText.allTextContents()).some((x) => x.endsWith(' mm'))).toBe(false);
    // Reformat measurements are session-only: not in the measurement list (saved measurements).
    const listed = await s.page.evaluate(() => (window as unknown as { __cdv: { measurements(): unknown[] } }).__cdv.measurements());
    expect(listed).toEqual([]);
    await screenshot(s.page, 'M4', 'mpr-measure-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('MPR refusals and approximate geometry', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('gantry-tilt'), fixture('xa-cine')]);
    await waitReady(s.page);
    const st = await cdvState(s.page);
    const series = st.studies.flatMap((x) => x.series);
    const tilt = series.find((x) => x.displaySets[0]!.warnings.includes('gantryTilt'))!.displaySets[0]!;
    const xa = series.find((x) => x.displaySets[0]!.id !== tilt.id)!.displaySets[0]!;
    // XA run: one projection, no volume — refused with the reason, nothing changes.
    await s.page.locator(`[data-ds-id="${xa.id}"]`).click();
    await waitReady(s.page);
    await s.page.keyboard.press('Shift+M');
    await expect(s.page.getByText(/Cannot be shown as a volume: /)).toBeVisible();
    expect((await cdvState(s.page)).layout).toEqual({ kind: 'grid', rows: 1, cols: 1 });
    // Gantry tilt: reformats are shown with a warning and measurements on them give no values.
    await s.page.locator(`[data-ds-id="${tilt.id}"]`).click();
    await waitReady(s.page);
    await s.page.keyboard.press('Shift+M');
    for (const i of [0, 1, 2]) await expect.poll(async () => (await rs(s.page, i)).status, { timeout: 30000 }).toBe('ready');
    expect((await rs(s.page, 1)).reformat?.warnings.map((w) => w.code)).toEqual(['gantryTilt']);
    await expect(s.page.getByTestId('viewport-1').getByTestId('reformat-warning')).toBeVisible();
    await s.page.keyboard.press('m');
    const box = (await s.page.getByTestId('viewport-element-1').boundingBox())!;
    await drag(
      s.page,
      { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 },
      { x: box.x + box.width * 0.6, y: box.y + box.height * 0.45 },
    );
    await expect
      .poll(async () =>
        (await s.page.getByTestId('viewport-1').locator('svg text').allTextContents()).filter((x) => x.includes('No values')),
      )
      .toHaveLength(1);
    await screenshot(s.page, 'M4', 'mpr-tilt-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('MPR and 2D together: slice sync and the 3D cursor between reformats and the original images', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await openMpr(s);
    // Fourth viewport: the original axial images of the same series.
    await s.page.getByTestId('tb-layout').click();
    await s.page.getByTestId('layout-2x2').click();
    const ds = (await cdvState(s.page)).studies[0]!.series[0]!.displaySets[0]!;
    await s.page.getByTestId('viewport-3').click({ position: { x: 5, y: 5 } });
    await s.page.locator(`[data-ds-id="${ds.id}"]`).click();
    await waitReady(s.page, 3);
    expect((await cdvState(s.page)).views.slice(0, 4)).toEqual(['axial', 'coronal', 'sagittal', 'stack']);
    // Axial reformat plane k is at z = 77.5 − 2.5k (seen from the feet); original image i at z = −80 + 2.5i.
    await scrollTo(s, 0, 40); // z = −22.5
    await expect.poll(async () => (await vpState(s.page, 3)).index).toBe(23);
    // 3D cursor in the sagittal reformat at the sphere centre (−50, −40, 0): the 2D stack goes to z = 0 (image 32),
    // the axial reformat to plane 31 and the coronal reformat to y = −40 (plane (127.5 + 40) / 0.5 = 335).
    await scrollTo(s, 2, 156);
    await s.page.keyboard.press('x');
    const p = await pixelToClient(s.page, 2, 176, 155);
    await s.page.mouse.click(p.x, p.y);
    await expect.poll(async () => (await vpState(s.page, 3)).index).toBe(32);
    await expect.poll(async () => (await rs(s.page, 0)).index).toBe(31);
    await expect.poll(async () => (await rs(s.page, 1)).index).toBe(335);
    await screenshot(s.page, 'M4', 'mpr-with-2d-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});
