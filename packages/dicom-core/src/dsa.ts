/**
 * Digital subtraction angiography (DSA) for viewing (D-058): a mask frame is subtracted from each live frame, with an
 * optional mask shift to correct patient motion (pixel shift). Pure functions on frame pixel arrays (row-major).
 */

/**
 * Subtraction of pixel values proportional to X-ray intensity (Pixel Intensity Relationship LIN) is logarithmic, so
 * the contrast of a vessel does not depend on the overlying tissue; LOG and display-ready (DISP) values are
 * subtracted linearly.
 */
export type DsaMode = 'linear' | 'log';

export function dsaModeFor(pixelIntensityRelationship: string | undefined): DsaMode {
  return pixelIntensityRelationship?.trim().toUpperCase() === 'LIN' ? 'log' : 'linear';
}

/** Scale of logarithmic differences, so that window values stay in a familiar range (ln ratio × 1000). */
export const LOG_SCALE = 1000;

/** Value of a frame at a continuous position (bilinear), or undefined outside the frame. */
export function sampleAt(frame: ArrayLike<number>, width: number, height: number, x: number, y: number): number | undefined {
  if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return undefined;
  if (width < 2 || height < 2) return frame[Math.round(y) * width + Math.round(x)];
  const x0 = Math.min(width - 2, Math.floor(x));
  const y0 = Math.min(height - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * width + x0;
  const top = frame[i]! * (1 - fx) + frame[i + 1]! * fx;
  const bottom = frame[i + width]! * (1 - fx) + frame[i + width + 1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * live − mask, with the mask moved by `shift` pixels (+x right, +y down): output pixel (x, y) uses the mask at
 * (x − dx, y − dy). Where the moved mask does not cover the frame the result is 0.
 */
export function subtractFrames(
  live: ArrayLike<number>,
  mask: ArrayLike<number>,
  width: number,
  height: number,
  shift: readonly [number, number],
  mode: DsaMode,
): Float32Array {
  const out = new Float32Array(width * height);
  const [dx, dy] = shift;
  const whole = Number.isInteger(dx) && Number.isInteger(dy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mx = x - dx;
      const my = y - dy;
      let m: number | undefined;
      if (whole) m = mx >= 0 && my >= 0 && mx < width && my < height ? mask[my * width + mx] : undefined;
      else m = sampleAt(mask, width, height, mx, my);
      if (m === undefined) continue;
      const l = live[y * width + x]!;
      out[y * width + x] = mode === 'log' ? LOG_SCALE * (Math.log(Math.max(l, 1)) - Math.log(Math.max(m, 1))) : l - m;
    }
  }
  return out;
}

interface Roi {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function meanAbsoluteDifference(
  live: ArrayLike<number>,
  mask: ArrayLike<number>,
  width: number,
  height: number,
  dx: number,
  dy: number,
  roi: Roi,
  step: number,
): number {
  let sum = 0;
  let n = 0;
  for (let y = roi.y0; y < roi.y1; y += step) {
    for (let x = roi.x0; x < roi.x1; x += step) {
      const m = sampleAt(mask, width, height, x - dx, y - dy);
      if (m === undefined) continue;
      const d = live[y * width + x]! - m;
      sum += Math.abs(d);
      n++;
    }
  }
  return n > 0 ? sum / n : Infinity;
}

/**
 * Automatic pixel shift: the mask shift (within ±range pixels) that best matches the live frame in its central
 * region (least mean absolute difference, which a
 * contrast-filled vessel in the live frame disturbs less than squared differences), refined to a tenth of a pixel by a parabola through the neighbours.
 */
export function autoShift(
  live: ArrayLike<number>,
  mask: ArrayLike<number>,
  width: number,
  height: number,
  range = 10,
): [number, number] {
  // Central 60 % of the frame: the borders are often collimated or carry labels.
  const roi: Roi = {
    x0: Math.max(range + 1, Math.floor(width * 0.2)),
    x1: Math.min(width - range - 1, Math.ceil(width * 0.8)),
    y0: Math.max(range + 1, Math.floor(height * 0.2)),
    y1: Math.min(height - range - 1, Math.ceil(height * 0.8)),
  };
  if (roi.x1 <= roi.x0 || roi.y1 <= roi.y0) return [0, 0];
  // Large frames are compared on a sparser grid (every pixel of a 256-pixel frame).
  const step = Math.max(1, Math.floor(Math.min(width, height) / 256));
  let best: [number, number] = [0, 0];
  let bestCost = Infinity;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const c = meanAbsoluteDifference(live, mask, width, height, dx, dy, roi, step * 2);
      if (c < bestCost) {
        bestCost = c;
        best = [dx, dy];
      }
    }
  }
  const cost = (dx: number, dy: number): number => meanAbsoluteDifference(live, mask, width, height, dx, dy, roi, step);
  const refine = (c0: number, cm: number, cp: number): number => {
    const denom = cm - 2 * c0 + cp;
    return denom > 0 ? Math.max(-0.5, Math.min(0.5, (cm - cp) / (2 * denom))) : 0;
  };
  const [bx, by] = best;
  const c0 = cost(bx, by);
  const sx = refine(c0, cost(bx - 1, by), cost(bx + 1, by));
  const sy = refine(c0, cost(bx, by - 1), cost(bx, by + 1));
  return [Math.round((bx + sx) * 10) / 10 + 0, Math.round((by + sy) * 10) / 10 + 0];
}
