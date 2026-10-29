/** Screenshot pixel analysis helpers for E2E geometry checks. */
import type { Locator } from '@playwright/test';
import { PNG } from 'pngjs';

export interface Gray {
  width: number;
  height: number;
  at(x: number, y: number): number;
  rgb(x: number, y: number): [number, number, number];
}

export async function grab(locator: Locator): Promise<Gray> {
  const png = PNG.sync.read(await locator.screenshot({ scale: 'css' }));
  const { width, height, data } = png;
  return {
    width,
    height,
    at: (x, y) => {
      const i = (Math.round(y) * width + Math.round(x)) * 4;
      return (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    },
    rgb: (x, y) => {
      const i = (Math.round(y) * width + Math.round(x)) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    },
  };
}

/** Centroid and bounding box of pixels brighter than a threshold, ignoring a margin (overlay text). */
export function brightRegion(g: Gray, threshold: number, margin = 0.12): { cx: number; cy: number; w: number; h: number; n: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const x0 = Math.floor(g.width * margin);
  const x1 = Math.ceil(g.width * (1 - margin));
  const y0 = Math.floor(g.height * margin);
  const y1 = Math.ceil(g.height * (1 - margin));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, gr, b] = g.rgb(x, y);
      // Grey pixels only (overlay text is white/yellow on black, image is grey).
      if (Math.abs(r - gr) > 12 || Math.abs(gr - b) > 12) continue;
      if ((r + gr + b) / 3 < threshold) continue;
      sx += x;
      sy += y;
      n++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { cx: sx / Math.max(1, n), cy: sy / Math.max(1, n), w: maxX - minX + 1, h: maxY - minY + 1, n };
}
