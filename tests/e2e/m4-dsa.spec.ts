/**
 * M4 DSA in the real app on the xa-dsa fixture: smooth anatomy, contrast (−200) in a vessel from frame 4, patient
 * motion of 3 px right and 2 px up from frame 12; Pixel Intensity Relationship LOG (linear subtraction).
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, fixture, launch, openPaths, screenshot, vpState, waitReady, type Session } from './harness';

interface DsaState {
  index: number;
  dsa?: { mask: number; shift: [number, number]; mode: string };
}

async function ds(page: Page): Promise<DsaState> {
  return (await vpState(page, 0)) as unknown as DsaState;
}

async function pixel(page: Page, column: number, row: number): Promise<number | undefined> {
  return page.evaluate(
    ([c, r]) =>
      (window as unknown as { __cdv: { pixelValue(i: number, c: number, r: number): number | undefined } }).__cdv.pixelValue(0, c!, r!),
    [column, row],
  );
}

async function frame(s: Session, index: number): Promise<void> {
  await s.page.getByTestId('viewport-0').click({ position: { x: 5, y: 5 } });
  await s.page.keyboard.press('Home');
  for (let k = 0; k < index; k++) await s.page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await ds(s.page)).index).toBe(index);
}

test('DSA: subtraction, mask frame, manual and automatic pixel shift', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('xa-dsa')]);
    await waitReady(s.page);
    await frame(s, 8);
    await s.page.keyboard.press('Shift+A');
    await expect.poll(async () => (await ds(s.page)).dsa).toEqual({ mask: 0, shift: [0, 0], mode: 'linear' });
    await expect(s.page.getByTestId('dsa-panel')).toBeVisible();
    // Frame 8: background cancels, the vessel (y = 128 + 40·sin(x / 25) → row 98 at column 100) keeps −200.
    await expect.poll(() => pixel(s.page, 40, 40)).toBe(0);
    expect(await pixel(s.page, 100, 98)).toBe(-200);
    await expect(s.page.getByTestId('dsa-text')).toHaveText('DSA · mask 1 · shift 0.0, 0.0');
    // Frame 15: the patient moved; without a shift the background does not cancel.
    await frame(s, 15);
    await expect.poll(async () => Math.abs((await pixel(s.page, 40, 40)) ?? 0)).toBeGreaterThan(5);
    await screenshot(s.page, 'M4', 'dsa-motion-1280x800-dark-en');
    // Automatic pixel shift finds the motion; the background cancels again.
    await s.page.getByTestId('dsa-auto').click();
    await expect.poll(async () => (await ds(s.page)).dsa?.shift).toEqual([3, -2]);
    await expect.poll(() => pixel(s.page, 40, 40)).toBe(0);
    await screenshot(s.page, 'M4', 'dsa-shifted-1280x800-dark-en');
    // Manual shift with Ctrl/Cmd+arrows and the panel; reset.
    await s.page.keyboard.press('ControlOrMeta+ArrowLeft');
    await expect.poll(async () => (await ds(s.page)).dsa?.shift).toEqual([2, -2]);
    await s.page.getByTestId('dsa-down-01').click();
    await expect.poll(async () => (await ds(s.page)).dsa?.shift).toEqual([2, -1.9]);
    await s.page.getByTestId('dsa-reset-shift').click();
    await expect.poll(async () => (await ds(s.page)).dsa?.shift).toEqual([0, 0]);
    // Another mask frame: the frame shown (15) as mask → frame 15 subtracts to zero.
    await s.page.getByTestId('dsa-mask-current').click();
    await expect.poll(async () => (await ds(s.page)).dsa?.mask).toBe(15);
    await expect.poll(() => pixel(s.page, 100, 98)).toBe(0);
    // Off: the original frames again.
    await s.page.getByTestId('dsa-off').click();
    await expect.poll(async () => (await ds(s.page)).dsa).toBeUndefined();
    await expect.poll(async () => (await pixel(s.page, 40, 40)) ?? 0).toBeGreaterThan(100);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('DSA is refused for series that are not angiography runs', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('ct-phantom')]);
    await waitReady(s.page);
    await s.page.getByTestId('viewport-0').click({ position: { x: 5, y: 5 } });
    await s.page.keyboard.press('Shift+A');
    await expect(s.page.getByText('DSA needs an X-ray angiography run (XA or RF) of at least two frames.')).toBeVisible();
    expect((await ds(s.page)).dsa).toBeUndefined();
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});
