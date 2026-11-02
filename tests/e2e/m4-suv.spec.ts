/**
 * M4 SUV window values on the pet fixture: hot sphere 20 000 Bq/ml, SUVbw factor 70000 / (370 MBq × decay) → 5.19.
 */
import { expect, test } from '@playwright/test';
import { expectNoErrors, fixture, launch, openPaths, screenshot, vpState, waitReady } from './harness';

interface SuvState {
  index: number;
  suv?: number;
  voi?: { lower: number; upper: number };
}

test('PET window, presets, probe and W/L dialog in SUVbw', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('pet')]);
    await waitReady(s.page);
    await s.page.getByTestId('viewport-0').click({ position: { x: 5, y: 5 } });
    await s.page.keyboard.press('Home');
    for (let k = 0; k < 20; k++) await s.page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await vpState(s.page)).index).toBe(20);
    const st = (await vpState(s.page)) as unknown as SuvState;
    expect(st.suv! * 20000).toBeCloseTo(5.1885, 3);
    // Preset SUV 0–10: the window text is in SUVbw.
    await s.page.getByTestId('tb-presets').click();
    await s.page.getByTestId('preset-suv10').click();
    await expect(s.page.getByTestId('wl-text')).toHaveText('W: 10.00  L: 5.00 SUVbw');
    // Probe in the hot sphere: Bq/ml and SUVbw.
    const p = await s.page.evaluate(() =>
      (window as unknown as { __cdv: { pixelToClient(i: number, c: number, r: number): { x: number; y: number } } }).__cdv.pixelToClient(
        0,
        64,
        64,
      ),
    );
    await s.page.mouse.move(p.x, p.y);
    await expect(s.page.getByTestId('probe')).toContainText('SUVbw 5.19');
    await screenshot(s.page, 'M4', 'pet-suv-1280x800-dark-en');
    // W/L dialog in SUVbw: width 6, centre 3 → range 0…6 SUV.
    // The dialog opens in stored values (Bq/ml, as saved presets); switch it to SUVbw.
    await s.page.keyboard.press('l');
    await expect(s.page.getByTestId('wl-suv-hint')).toHaveCount(0);
    await s.page.getByTestId('wl-dialog').getByRole('button', { name: 'SUVbw' }).click();
    await expect(s.page.getByTestId('wl-suv-hint')).toBeVisible();
    await expect(s.page.getByTestId('wl-a')).toHaveValue('10');
    await expect(s.page.getByTestId('wl-b')).toHaveValue('5');
    await s.page.getByTestId('wl-a').fill('6');
    await s.page.getByTestId('wl-b').fill('3');
    await s.page.getByTestId('wl-apply').click();
    await expect(s.page.getByTestId('wl-text')).toHaveText('W: 6.00  L: 3.00 SUVbw');
    const voi = ((await vpState(s.page)) as unknown as SuvState).voi!;
    expect(voi.lower * st.suv!).toBeCloseTo(0, 6);
    expect(voi.upper * st.suv!).toBeCloseTo(6, 6);
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});

test('PET without SUV tags keeps Bq/ml and offers no SUV presets', async () => {
  const s = await launch({ lang: 'en' });
  try {
    await openPaths(s, [fixture('pet-missing')]);
    await waitReady(s.page);
    expect(((await vpState(s.page)) as unknown as SuvState).suv).toBeUndefined();
    await s.page.getByTestId('tb-presets').click();
    await expect(s.page.getByTestId('preset-suv10')).toBeDisabled();
    await s.page.keyboard.press('Escape');
    await expect(s.page.getByTestId('wl-text')).not.toContainText('SUV');
    expectNoErrors(s);
  } finally {
    await s.close();
  }
});
