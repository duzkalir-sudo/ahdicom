/**
 * M4 3D volume rendering in the real app on the CT phantom (spheres of known HU in a water cylinder).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cdvState, expectNoErrors, fixture, launch, openPaths, screenshot, setSize, vpState, waitReady, type Session } from './harness';
import { grab, type Gray } from './pixels';

interface View3d {
  view: string;
  status: string;
  vr?: {
    preset: string;
    shift: number;
    opacity: number;
    clip?: { min: number[]; max: number[] };
    axes: [string, string][];
    scalpel?: string;
    cuts: number;
  };
  probe?: { value?: number };
}

/** Mean brightness of a rectangle given as fractions of the viewport. */
function mean(g: Gray, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.round(g.height * y0); y < g.height * y1; y += 2)
    for (let x = Math.round(g.width * x0); x < g.width * x1; x += 2) {
      sum += g.at(x, y);
      n++;
    }
  return sum / Math.max(1, n);
}

async function v(page: Page, i: number): Promise<View3d> {
  return (await vpState(page, i)) as unknown as View3d;
}

async function open3d(s: Session): Promise<void> {
  await s.page.getByTestId('tb-view').click();
  await s.page.getByTestId('view-3d').click();
  await expect.poll(async () => (await v(s.page, 0)).status, { timeout: 30000 }).toBe('ready');
  expect((await v(s.page, 0)).view).toBe('3d');
}

test('3D volume rendering of the CT phantom', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await open3d(s);
    // The 3D controls open in the right panel; CT starts with the bone preset.
    await expect(s.page.getByTestId('vr-panel')).toBeVisible();
    const vr = (await v(s.page, 0)).vr!;
    expect(vr.preset).toBe('bone');
    // Volume grid axes of an axial CT: columns R → L, rows A → P, slices F → H.
    expect(vr.axes).toEqual([
      ['R', 'L'],
      ['A', 'P'],
      ['F', 'H'],
    ]);
    const el = s.page.getByTestId('viewport-element-0');
    // Seen from the front: the 1000 HU sphere (patient right, x = −50) is on the screen's left, the 100 HU sphere
    // (x = +50) on its right. Bone shows the 1000 HU sphere.
    // The bone preset ramps opacity from about −16 HU to 641 HU with gradient opacity: the 1000 HU sphere is the
    // brightest object, the water cylinder a faint haze.
    const sphere = (g: Gray): number => mean(g, 0.26, 0.34, 0.45, 0.55);
    const water = (g: Gray): number => mean(g, 0.4, 0.6, 0.3, 0.4);
    await expect
      .poll(
        async () => {
          const g = await grab(el);
          return sphere(g) > 2 * water(g) && sphere(g) > 20;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    const before = await grab(el);
    await screenshot(s.page, 'M4', '3d-ct-phantom-1280x800-dark-en');
    // Clipping box keeping the patient's left half (R → L from 55 %): the 1000 HU sphere disappears.
    await s.page.getByTestId('vr-clip').check();
    await s.page.getByTestId('vr-clip-min-0').fill('55');
    await expect.poll(async () => (await v(s.page, 0)).vr?.clip?.min[0]).toBe(0.55);
    await expect.poll(async () => sphere(await grab(el))).toBeLessThan(sphere(before) * 0.2);
    await screenshot(s.page, 'M4', '3d-clip-1280x800-dark-en');
    // Removing the box shows it again; presets and the curve controls change the state.
    await s.page.getByTestId('vr-clip').uncheck();
    await expect.poll(async () => (await v(s.page, 0)).vr?.clip).toBeUndefined();
    await s.page.getByTestId('vr-preset').selectOption('mip');
    await s.page.getByTestId('vr-shift').fill('200');
    await s.page.getByTestId('vr-opacity').fill('150');
    await expect.poll(async () => (await v(s.page, 0)).vr).toMatchObject({ preset: 'mip', shift: 200, opacity: 1.5 });
    await expect(s.page.getByTestId('vr-text')).toHaveText('Maximum intensity (MIP)');
    await screenshot(s.page, 'M4', '3d-mip-1280x800-dark-en');
    await s.page.getByTestId('vr-reset').click();
    await expect.poll(async () => (await v(s.page, 0)).vr).toMatchObject({ preset: 'bone', shift: 0, opacity: 1 });
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('3D scalpel cuts only the 3D view and can be undone', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await open3d(s);
    const el = s.page.getByTestId('viewport-element-0');
    const sphere = (g: Gray): number => mean(g, 0.26, 0.34, 0.45, 0.55);
    await expect.poll(async () => sphere(await grab(el)), { timeout: 10000 }).toBeGreaterThan(20);
    const before = sphere(await grab(el));
    // Outline around the 1000 HU sphere (screen left), drawn with the scalpel armed.
    const box = (await el.boundingBox())!;
    const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy];
    const cutAroundSphere = async (): Promise<void> => {
      await s.page.getByTestId('vr-cut-inside').click();
      await expect.poll(async () => (await v(s.page, 0)).vr?.scalpel).toBe('inside');
      await s.page.mouse.move(...at(0.2, 0.35));
      await s.page.mouse.down();
      for (const [fx, fy] of [
        [0.4, 0.35],
        [0.4, 0.65],
        [0.2, 0.65],
        [0.2, 0.36],
      ] as const)
        await s.page.mouse.move(...at(fx, fy), { steps: 4 });
      await s.page.mouse.up();
    };
    await cutAroundSphere();
    await expect.poll(async () => (await v(s.page, 0)).vr).toMatchObject({ cuts: 1 });
    expect((await v(s.page, 0)).vr?.scalpel).toBeUndefined();
    await expect.poll(async () => sphere(await grab(el))).toBeLessThan(before * 0.2);
    await screenshot(s.page, 'M4', '3d-scalpel-1280x800-dark-en');
    // Undo restores the sphere.
    await s.page.getByTestId('vr-undo-cut').click();
    await expect.poll(async () => (await v(s.page, 0)).vr?.cuts).toBe(0);
    await expect.poll(async () => sphere(await grab(el))).toBeGreaterThan(before * 0.8);
    // Cut again: the original images are not changed — the 2D view of the same series still reads 1000 HU.
    await cutAroundSphere();
    await expect.poll(async () => (await v(s.page, 0)).vr?.cuts).toBe(1);
    await s.page.getByTestId('tb-layout').click();
    await s.page.getByTestId('layout-1x2').click();
    const ds = (await cdvState(s.page)).studies[0]!.series[0]!.displaySets[0]!;
    await s.page.getByTestId('viewport-1').click({ position: { x: 5, y: 5 } });
    await s.page.locator(`[data-ds-id="${ds.id}"]`).click();
    await waitReady(s.page, 1);
    await s.page.keyboard.press('Home');
    for (let k = 0; k < 32; k++) await s.page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await vpState(s.page, 1)).index).toBe(32);
    const p = await s.page.evaluate(() =>
      (window as unknown as { __cdv: { pixelToClient(i: number, c: number, r: number): { x: number; y: number } } }).__cdv.pixelToClient(
        1,
        156,
        176,
      ),
    );
    await s.page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await v(s.page, 1)).probe?.value).toBe(1000);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

/** Enclosed volume (mm³) and vertex centroid (patient LPS, mm) of the triangles of a binary STL. */
function stlVolume(bytes: Buffer): { triangles: number; volume: number; centroid: [number, number, number] } {
  const n = bytes.readUInt32LE(80);
  expect(bytes.length).toBe(84 + 50 * n);
  let v = 0;
  const sum = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    const o = 84 + 50 * t + 12;
    const p = Array.from({ length: 9 }, (_, k) => bytes.readFloatLE(o + 4 * k));
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = p as [number, number, number, number, number, number, number, number, number];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    for (let k = 0; k < 3; k++) sum[k] = sum[k]! + (p[k]! + p[k + 3]! + p[k + 6]!) / 3;
  }
  return { triangles: n, volume: v / 6, centroid: sum.map((x) => x / Math.max(1, n)) as [number, number, number] };
}

test('STL export of the iso-surface: the 1000 HU sphere at 500 HU encloses 4/3·π·r³', async () => {
  const s = await launch({ lang: 'en' });
  const out = path.join(s.userData, 'sphere.stl');
  try {
    await s.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as unknown as typeof dialog.showSaveDialog;
    }, out);
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await open3d(s);
    await s.page.getByTestId('vr-stl-threshold').fill('500');
    await s.page.getByTestId('vr-stl-export').click();
    await expect(s.page.getByTestId('vr-stl-status')).toHaveText(/^Saved: \d+ triangles\.$/, { timeout: 30000 });
    const { triangles, volume, centroid } = stlVolume(readFileSync(out));
    // In patient coordinates (LPS, mm): the surface sits around the sphere centre (−50, −40, 0), not mirrored.
    expect(Math.hypot(centroid[0] + 50, centroid[1] + 40, centroid[2])).toBeLessThan(1);
    expect(triangles).toBeGreaterThan(500);
    // Outward-facing triangles (positive volume); r = 10 mm → 4188.8 mm³. 0.5 × 0.5 × 2.5 mm voxels: within 10 %.
    expect(volume).toBeGreaterThan(0);
    expect(Math.abs(volume / ((4 / 3) * Math.PI * 1000) - 1)).toBeLessThan(0.1);
    // A threshold above every value gives no surface.
    await s.page.getByTestId('vr-stl-threshold').fill('5000');
    await s.page.getByTestId('vr-stl-export').click();
    await expect(s.page.getByTestId('vr-stl-status')).toHaveText('No surface at this threshold.');
    await screenshot(s.page, 'M4', '3d-stl-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('M4 screenshot matrix: MPR + 3D (sizes × themes × languages), view menu', async () => {
  test.setTimeout(600_000);
  for (const lang of ['tr', 'en'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      const s = await launch({ lang, theme });
      try {
        await openPaths(s, [fixture('ct-phantom')]);
        await waitReady(s.page);
        // Axial, coronal and sagittal reformats, then the fourth viewport in 3D with its panel open.
        await s.page.keyboard.press('Shift+M');
        for (const i of [0, 1, 2]) await expect.poll(async () => (await v(s.page, i)).status, { timeout: 30000 }).toBe('ready');
        await s.page.getByTestId('tb-layout').click();
        await s.page.getByTestId('layout-2x2').click();
        const ds = (await cdvState(s.page)).studies[0]!.series[0]!.displaySets[0]!;
        await s.page.getByTestId('viewport-3').click({ position: { x: 5, y: 5 } });
        await s.page.locator(`[data-ds-id="${ds.id}"]`).click();
        await waitReady(s.page, 3);
        await s.page.keyboard.press('Shift+D');
        await expect.poll(async () => (await v(s.page, 3)).status, { timeout: 30000 }).toBe('ready');
        await s.page.getByTestId('vr-cut-inside').click();
        for (const [w, h] of [
          [1280, 800],
          [1920, 1080],
        ] as const) {
          await setSize(s.app, w, h);
          await s.page.waitForTimeout(600);
          await screenshot(s.page, 'M4', `mpr-3d-${w}x${h}-${theme}-${lang}`);
        }
        await setSize(s.app, 1280, 800);
        await s.page.getByTestId('viewport-0').click({ position: { x: 5, y: 5 } });
        await s.page.getByTestId('tb-view').click();
        await expect(s.page.getByTestId('view-menu')).toBeVisible();
        await screenshot(s.page, 'M4', `view-menu-1280x800-${theme}-${lang}`);
        await s.page.keyboard.press('Escape');
        expectNoErrors(s);
      } finally {
        await s.close();
      }
    }
  }
});

test('crosshair stays on the reformat after a window resize with a 3D view in the layout', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await s.page.keyboard.press('Shift+M');
    for (const i of [0, 1, 2]) await expect.poll(async () => (await v(s.page, i)).status, { timeout: 30000 }).toBe('ready');
    await s.page.getByTestId('tb-layout').click();
    await s.page.getByTestId('layout-2x2').click();
    const ds = (await cdvState(s.page)).studies[0]!.series[0]!.displaySets[0]!;
    await s.page.getByTestId('viewport-3').click({ position: { x: 5, y: 5 } });
    await s.page.locator(`[data-ds-id="${ds.id}"]`).click();
    await waitReady(s.page, 3);
    await s.page.keyboard.press('Shift+D');
    await expect.poll(async () => (await v(s.page, 3)).status, { timeout: 30000 }).toBe('ready');
    await setSize(s.app, 1920, 1080);
    await setSize(s.app, 1280, 800);
    // The axial crosshair centre (column 255, row 256) is the middle of the fitted image, i.e. of the viewport.
    const centre = async (): Promise<number> => {
      const p = await s.page.evaluate(() => {
        const w = window as unknown as {
          __cdv: { guides(i: number): { center?: number[] }; pixelToClient(i: number, c: number, r: number): { x: number; y: number } };
        };
        const c = w.__cdv.guides(0).center!;
        return w.__cdv.pixelToClient(0, c[0]!, c[1]!);
      });
      const box = (await s.page.getByTestId('viewport-element-0').boundingBox())!;
      return Math.hypot(p.x - (box.x + box.width / 2), p.y - (box.y + box.height / 2));
    };
    await expect.poll(centre).toBeLessThan(3);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});
