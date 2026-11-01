/**
 * M3 series comparison in the real app: slice sync, manual link with offset, reference lines, 3D cursor,
 * split volumes, window/level and zoom sync. Expected positions follow from the fixture geometry.
 */
import { expect, test, type Page } from '@playwright/test';
import { cdvState, expectNoErrors, fixture, launch, openPaths, screenshot, setSize, vpState, waitReady, type Session } from './harness';

interface Guides {
  lines: [[number, number], [number, number]][];
  marker?: [number, number];
}

async function guides(page: Page, i: number): Promise<Guides | undefined> {
  return page.evaluate((idx) => (window as unknown as { __cdv: { guides(i: number): Guides | undefined } }).__cdv.guides(idx), i);
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

async function layout(s: Session, id: string): Promise<void> {
  await s.page.getByTestId('tb-layout').click();
  await s.page.getByTestId(`layout-${id}`).click();
}

/** Shows a series (by description, optionally the n-th split part) in viewport vp. */
async function show(s: Session, description: string, vp: number, part = 0): Promise<void> {
  const st = await cdvState(s.page);
  const ds = st.studies.flatMap((x) => x.series).find((x) => x.description === description)!.displaySets[part]!;
  await s.page.getByTestId(`viewport-${vp}`).click({ position: { x: 5, y: 5 } });
  await s.page.locator(`[data-ds-id="${ds.id}"]`).click();
  await expect.poll(async () => (await vpState(s.page, vp)).displaySetId).toBe(ds.id);
  await waitReady(s.page, vp);
}

/** Scrolls viewport vp to an index with the keyboard (the viewport becomes active). */
async function scrollTo(s: Session, vp: number, index: number): Promise<void> {
  await s.page.getByTestId(`viewport-${vp}`).click({ position: { x: 5, y: 5 } });
  await s.page.keyboard.press('Home');
  for (let k = 0; k < index; k++) await s.page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await vpState(s.page, vp)).index).toBe(index);
}

async function syncMenu(s: Session, key: string): Promise<void> {
  await s.page.getByTestId('tb-sync').click();
  await s.page.getByTestId(`sync-${key}`).click();
  await s.page.keyboard.press('Escape');
}

test('automatic slice sync in one Frame of Reference; prior study only after a manual link, keeping the offset', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('orient-axial'), fixture('orient-axial-thin'), fixture('orient-prior')]);
    await layout(s, '1x2');
    await show(s, 'AXIAL', 0); // z = −88 + 4k
    await show(s, 'AXIAL THIN', 1); // z = −88 + 2k
    // Scrolling the 4 mm stack to z = −48 (index 10) moves the 2 mm stack to z = −48 (index 20).
    await scrollTo(s, 0, 10);
    await expect.poll(async () => (await vpState(s.page, 1)).index).toBe(20);
    // And the other way round: thin index 31 (z = −26) → nearest 4 mm slice z = −28 (index 15).
    await scrollTo(s, 1, 31);
    await expect.poll(async () => (await vpState(s.page, 0)).index).toBe(15);

    // The prior study (other Frame of Reference) does not follow automatically.
    await show(s, 'AXIAL PRIOR', 1); // z = −80 + 4k
    const priorBefore = (await vpState(s.page, 1)).index;
    await scrollTo(s, 0, 12);
    await s.page.waitForTimeout(400);
    expect((await vpState(s.page, 1)).index).toBe(priorBefore);

    // Align by hand (prior index 12 = z −32 shows the same anatomy as current z −40, index 12), then link.
    await scrollTo(s, 1, 12);
    await syncMenu(s, 'linked');
    await expect
      .poll(
        async () => (await s.page.evaluate(() => (window as unknown as { __cdv: { sync(): { linked: boolean } } }).__cdv.sync())).linked,
      )
      .toBe(true);
    // Current +5 slices (+20 mm) → prior +20 mm → index 17.
    await scrollTo(s, 0, 17);
    await expect.poll(async () => (await vpState(s.page, 1)).index).toBe(17);
    await screenshot(s.page, 'M3', 'linked-prior-1280x800-dark-en');

    // A series dropped into the linked layout joins at its own slice and then moves with the others step by step
    // (here a 2 mm series of the current study, linked to the prior study in the other Frame of Reference).
    await show(s, 'AXIAL THIN', 0);
    const thin = (await vpState(s.page, 0)).index;
    const prior = (await vpState(s.page, 1)).index;
    expect(prior).toBe(17); // the prior viewport did not move when the series was dropped
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('ArrowDown'); // +4 mm on the 2 mm stack
    await expect.poll(async () => (await vpState(s.page, 0)).index).toBe(thin + 2);
    await expect.poll(async () => (await vpState(s.page, 1)).index).toBe(prior + 1); // +4 mm = one prior slice
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('reference line of the active sagittal slice on the axial viewport, and the 3D cursor', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal')]);
    await layout(s, '1x2');
    await show(s, 'AXIAL', 0);
    // Sagittal normal = row × column = −x (patient right), so spatial order runs from x = +88: x = 88 − 4k.
    await show(s, 'SAGITTAL', 1);
    // Active sagittal at x = 0 (index 22): on the axial image (2 mm pixels from −127) the line is column 63.5.
    await scrollTo(s, 1, 22);
    await expect.poll(async () => (await guides(s.page, 0))?.lines.length).toBe(1);
    const [a, b] = (await guides(s.page, 0))!.lines[0]!;
    expect(a[0]).toBeCloseTo(63.5, 6);
    expect(b[0]).toBeCloseTo(63.5, 6);
    expect(Math.abs(b[1] - a[1])).toBeCloseTo(128, 6); // full image height (−0.5 … 127.5)
    expect((await guides(s.page, 1))!.lines).toHaveLength(0); // none on the active viewport
    await screenshot(s.page, 'M3', 'reference-line-1280x800-dark-en');

    // Reference lines can be switched off.
    await syncMenu(s, 'referenceLines');
    await expect.poll(async () => (await guides(s.page, 0))?.lines.length).toBe(0);
    await syncMenu(s, 'referenceLines');

    // 3D cursor on the axial image at pixel (80, 40) of slice z = −40 (index 12): point (33, −47, −40).
    await scrollTo(s, 0, 12);
    await s.page.keyboard.press('x');
    await expect(s.page.getByTestId('tb-cursor3d')).toHaveAttribute('aria-pressed', 'true');
    await s.page.waitForTimeout(500);
    const c = await pixelToClient(s.page, 0, 80, 40);
    await s.page.mouse.click(c.x, c.y);
    // Sagittal jumps to x = 32 (index (88 − 32) / 4 = 14, nearest to 33) and marks y = −47 → column 40, z = −40 → row 83.5.
    await expect.poll(async () => (await vpState(s.page, 1)).index).toBe(14);
    await expect.poll(async () => (await guides(s.page, 1))?.marker).toBeDefined();
    const m = (await guides(s.page, 1))!.marker!;
    expect(m[0]).toBeCloseTo(40, 0);
    expect(m[1]).toBeCloseTo(83.5, 0);
    const own = (await guides(s.page, 0))!.marker!;
    expect(own[0]).toBeCloseTo(80, 0);
    expect(own[1]).toBeCloseTo(40, 0);
    await screenshot(s.page, 'M3', 'cursor3d-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('multi-volume series are split into labelled volumes', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('dwi'), fixture('multiphase')]);
    const st = await cdvState(s.page);
    const dwi = st.studies.flatMap((x) => x.series).find((x) => x.description === 'DWI')!;
    const phases = st.studies.flatMap((x) => x.series).find((x) => x.description === 'LIVER 3 PHASE')!;
    expect(dwi.displaySets.map((d) => d.images)).toEqual([4, 4]);
    expect(phases.displaySets.map((d) => d.images)).toEqual([3, 3, 3]);
    await expect(s.page.locator(`[data-ds-id="${dwi.displaySets[1]!.id}"]`)).toContainText('b=1000');
    await expect(s.page.locator(`[data-ds-id="${phases.displaySets[2]!.id}"]`)).toContainText('Phase 3');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('window/level and zoom follow the active viewport when enabled', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('orient-axial'), fixture('orient-axial-thin')]);
    await layout(s, '1x2');
    await show(s, 'AXIAL', 0);
    await show(s, 'AXIAL THIN', 1);
    await syncMenu(s, 'windowLevel');
    await syncMenu(s, 'zoomPan');
    // W/L drag on viewport 0.
    await s.page.getByTestId('viewport-0').click({ position: { x: 5, y: 5 } });
    const box = (await s.page.getByTestId('viewport-element-0').boundingBox())!;
    await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
    await s.page.mouse.up();
    // Both values are read in the same poll: the active viewport updates on the next animation frame too.
    await expect
      .poll(async () => {
        const [a, b] = [await vpState(s.page, 0), await vpState(s.page, 1)];
        return JSON.stringify(a.wl) === JSON.stringify(b.wl) && a.wl !== undefined;
      })
      .toBe(true);
    // Zoom in with the keyboard on viewport 0.
    const before = (await vpState(s.page, 0)).zoomPercent ?? 0;
    await s.page.keyboard.press('+');
    await s.page.keyboard.press('+');
    await expect
      .poll(async () => {
        const [a, b] = [await vpState(s.page, 0), await vpState(s.page, 1)];
        return a.zoomPercent! > before * 1.5 && Math.round(a.zoomPercent!) === Math.round(b.zoomPercent!);
      })
      .toBe(true);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('split volumes can be shown together and separately again', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('dwi')]);
    const parts = async (): Promise<number[]> =>
      (await cdvState(s.page)).studies
        .flatMap((x) => x.series)
        .find((x) => x.description === 'DWI')!
        .displaySets.map((d) => d.images);
    expect(await parts()).toEqual([4, 4]);
    await s.page.getByTestId('series-volumes').click();
    await expect.poll(parts).toEqual([8]);
    await expect(s.page.getByTestId('series-volumes')).toHaveText('Show volumes separately');
    await s.page.getByTestId('series-volumes').click();
    await expect.poll(parts).toEqual([4, 4]);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('compare with prior: matching series of the earlier study side by side, linked', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal'), fixture('orient-prior')]);
    const st = await cdvState(s.page);
    const axial = st.studies.flatMap((x) => x.series).find((x) => x.description === 'AXIAL')!.displaySets[0]!.id;
    const prior = st.studies.flatMap((x) => x.series).find((x) => x.description === 'AXIAL PRIOR')!.displaySets[0]!.id;
    // The active series is the axial one: the comparison picks the axial prior (not the sagittal).
    await show(s, 'AXIAL', 0);
    await scrollTo(s, 0, 20);
    const button = s.page.getByTestId('compare-prior');
    await expect(button).toHaveCount(1); // only on the newer study
    await expect(button).toContainText('2023-03-05');
    await button.click();
    await expect.poll(async () => (await cdvState(s.page)).slots.slice(0, 2)).toEqual([axial, prior]);
    await waitReady(s.page, 1);
    await expect
      .poll(
        async () => (await s.page.evaluate(() => (window as unknown as { __cdv: { sync(): { linked: boolean } } }).__cdv.sync())).linked,
      )
      .toBe(true);
    // Same relative position (index 20 of 45 → 20 of 45), then linked scrolling keeps the offset.
    await expect.poll(async () => (await vpState(s.page, 1)).index).toBe(20);
    await scrollTo(s, 0, 25);
    await expect.poll(async () => (await vpState(s.page, 1)).index).toBe(25);
    await screenshot(s.page, 'M3', 'compare-prior-1280x800-dark-en');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('gating: nothing crosses Frames of Reference or modalities; non-parallel planes do not sync; maximize keeps zoom', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal'), fixture('orient-prior'), fixture('ct-phantom')]);
    await layout(s, '1x2');
    // Same FoR but perpendicular: scrolling the sagittal does not move the axial (reference line only).
    await show(s, 'AXIAL', 0);
    await show(s, 'SAGITTAL', 1);
    await scrollTo(s, 0, 7);
    await scrollTo(s, 1, 30);
    await s.page.waitForTimeout(400);
    expect((await vpState(s.page, 0)).index).toBe(7);

    // Other Frame of Reference: no reference line and no 3D cursor jump on the prior study.
    await show(s, 'AXIAL PRIOR', 0);
    await scrollTo(s, 0, 9);
    await scrollTo(s, 1, 22); // active sagittal (current FoR)
    await s.page.waitForTimeout(400);
    expect((await guides(s.page, 0))!.lines).toHaveLength(0);
    await s.page.keyboard.press('x');
    await s.page.waitForTimeout(500);
    const c = await pixelToClient(s.page, 1, 64, 64);
    await s.page.mouse.click(c.x, c.y);
    await s.page.waitForTimeout(400);
    expect((await vpState(s.page, 0)).index).toBe(9);
    expect((await guides(s.page, 0))!.marker).toBeUndefined();
    expect((await guides(s.page, 1))!.marker).toBeDefined();
    await s.page.keyboard.press('w');

    // Window/level sync only between the same modality: a CT preset does not change the MR window.
    await show(s, 'AXIAL', 0);
    await show(s, 'PHANTOM 2.5mm', 1);
    await syncMenu(s, 'windowLevel');
    const mrBefore = (await vpState(s.page, 0)).wl;
    await s.page.getByTestId('viewport-1').click({ position: { x: 5, y: 5 } });
    await s.page.keyboard.press('4'); // bone preset on the CT
    await expect.poll(async () => (await vpState(s.page, 1)).wl).toEqual({ width: 2000, center: 500 });
    await s.page.waitForTimeout(400);
    expect((await vpState(s.page, 0)).wl).toEqual(mrBefore);

    // Double-click maximize and restore keep the user's zoom: the on-screen scale (Zoom %, screen pixels per image
    // pixel) stays the same instead of being refitted to the new size.
    await s.page.keyboard.press('+');
    await s.page.keyboard.press('+');
    await s.page.waitForTimeout(300);
    const zoom = async (): Promise<number> => (await vpState(s.page, 1)).zoomPercent ?? 0;
    const z0 = await zoom();
    await s.page.getByTestId('viewport-1').dblclick({ position: { x: 5, y: 5 } });
    await expect(s.page.getByTestId('viewport-0')).toBeHidden();
    await s.page.waitForTimeout(400);
    expect(Math.abs((await zoom()) / z0 - 1)).toBeLessThan(0.01);
    await s.page.getByTestId('viewport-1').dblclick({ position: { x: 5, y: 5 } });
    await expect(s.page.getByTestId('viewport-0')).toBeVisible();
    await s.page.waitForTimeout(400);
    expect(Math.abs((await zoom()) / z0 - 1)).toBeLessThan(0.01);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('M3 screenshot matrix (sizes × themes × languages)', async () => {
  test.setTimeout(600_000);
  for (const lang of ['tr', 'en'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      const s = await launch({ lang, theme });
      try {
        await openPaths(s, [fixture('orient-axial'), fixture('orient-sagittal'), fixture('orient-prior'), fixture('dwi')]);
        await layout(s, '1x2');
        await show(s, 'AXIAL', 0);
        await show(s, 'SAGITTAL', 1);
        await scrollTo(s, 1, 20);
        // 3D cursor on the axial image.
        await scrollTo(s, 0, 24);
        await s.page.keyboard.press('x');
        await s.page.waitForTimeout(500);
        const c = await pixelToClient(s.page, 0, 70, 50);
        await s.page.mouse.click(c.x, c.y);
        await s.page.waitForTimeout(400);
        for (const [w, h] of [
          [1280, 800],
          [1920, 1080],
        ] as const) {
          await setSize(s.app, w, h);
          await s.page.waitForTimeout(400);
          await screenshot(s.page, 'M3', `sync-${w}x${h}-${theme}-${lang}`);
        }
        await setSize(s.app, 1280, 800);
        await s.page.keyboard.press('w');
        await s.page.getByTestId('tb-sync').click();
        await expect(s.page.getByTestId('sync-menu')).toBeVisible();
        await screenshot(s.page, 'M3', `sync-menu-1280x800-${theme}-${lang}`);
        await s.page.keyboard.press('Escape');
        await s.page.getByTestId('compare-prior').click();
        await waitReady(s.page, 1);
        await s.page.waitForTimeout(500);
        await screenshot(s.page, 'M3', `compare-prior-1280x800-${theme}-${lang}`);
        expectNoErrors(s);
      } finally {
        await s.close();
      }
    }
  }
});
