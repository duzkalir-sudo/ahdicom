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
