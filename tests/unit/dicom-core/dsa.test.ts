/**
 * DSA subtraction and automatic pixel shift on synthetic frames with a known motion (CLAUDE.md rule 9).
 */
import { describe, expect, it } from 'vitest';
import { LOG_SCALE, autoShift, dsaModeFor, sampleAt, subtractFrames } from '@ahdicom/dicom-core';

const W = 128;
const H = 96;
/** Smooth "anatomy" texture; anatomy(sx, sy) is the content moved sx px right and sy px down. */
const anatomy = (sx: number, sy: number): Float32Array => {
  const f = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x - sx;
      const v = y - sy;
      f[y * W + x] = 500 + 120 * Math.sin(u / 7) + 90 * Math.cos(v / 5) + 60 * Math.sin((u + v) / 11);
    }
  return f;
};

function rms(a: Float32Array, margin: number): number {
  let s = 0;
  let n = 0;
  for (let y = margin; y < H - margin; y++)
    for (let x = margin; x < W - margin; x++) {
      s += a[y * W + x]! ** 2;
      n++;
    }
  return Math.sqrt(s / n);
}

describe('DSA', () => {
  it('chooses logarithmic subtraction for intensity-proportional (LIN) pixels', () => {
    expect(dsaModeFor('LIN')).toBe('log');
    expect(dsaModeFor('LOG')).toBe('linear');
    expect(dsaModeFor('DISP')).toBe('linear');
    expect(dsaModeFor(undefined)).toBe('linear');
  });

  it('subtracts the mask: background vanishes, the contrast-filled vessel remains', () => {
    const mask = anatomy(0, 0);
    const live = anatomy(0, 0);
    for (let y = 0; y < H; y++) live[y * W + 64] = live[y * W + 64]! - 200; // vessel (contrast absorbs)
    const d = subtractFrames(live, mask, W, H, [0, 0], 'linear');
    expect(d[10 * W + 20]).toBe(0);
    expect(d[10 * W + 64]).toBeCloseTo(-200, 3);
    // Logarithmic: the same 20 % absorption gives the same value on bright and dark background.
    const l = subtractFrames(new Float32Array([800, 80]), new Float32Array([1000, 100]), 2, 1, [0, 0], 'log');
    expect(l[0]).toBeCloseTo(LOG_SCALE * Math.log(0.8), 2);
    expect(l[1]).toBeCloseTo(LOG_SCALE * Math.log(0.8), 2);
  });

  it('a shifted mask cancels motion; uncovered borders are 0', () => {
    const mask = anatomy(0, 0);
    const live = anatomy(3, -2); // patient moved 3 px right and 2 px up
    expect(rms(subtractFrames(live, mask, W, H, [0, 0], 'linear'), 12)).toBeGreaterThan(30);
    const fixed = subtractFrames(live, mask, W, H, [3, -2], 'linear');
    expect(rms(fixed, 12)).toBeLessThan(1e-3);
    expect(fixed[0]).toBe(0); // the mask pixel (−3, 2) is outside
    // Bilinear sampling for sub-pixel shifts.
    expect(sampleAt(new Float32Array([0, 10, 20, 30]), 2, 2, 0.5, 0.5)).toBe(15);
    expect(sampleAt(new Float32Array([0, 10, 20, 30]), 2, 2, 1.5, 0)).toBeUndefined();
  });

  it('finds the motion automatically, to a tenth of a pixel', () => {
    expect(autoShift(anatomy(3, -2), anatomy(0, 0), W, H)).toEqual([3, -2]);
    const [dx, dy] = autoShift(anatomy(1.5, 0.5), anatomy(0, 0), W, H);
    expect(Math.abs(dx - 1.5)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(dy - 0.5)).toBeLessThanOrEqual(0.15);
    // A vessel appearing in the live frame does not disturb the match.
    const live = anatomy(-4, 2);
    for (let y = 0; y < H; y++) live[y * W + 60] = live[y * W + 60]! - 150;
    expect(autoShift(live, anatomy(0, 0), W, H)).toEqual([-4, 2]);
    expect(autoShift(anatomy(0, 0), anatomy(0, 0), W, H)).toEqual([0, 0]);
  });
});
