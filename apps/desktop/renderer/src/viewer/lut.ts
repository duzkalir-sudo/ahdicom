/**
 * Modality/VOI LUT Sequence support on top of Cornerstone's GPU path (which ignores them).
 * - Modality LUT: pixel values are mapped in place after decoding, so probes and windows use modality values.
 * - VOI LUT: exposed for the viewport controller, which applies it as an exact transfer function.
 */
import type { Types } from '@cornerstonejs/core';
import { applyLut, parseLutSequences, type LutSequences } from '@clinic/dicom-core';

const lutsByBase = new Map<string, LutSequences>();
const modalityApplied = new Set<string>();

function base(imageId: string): string {
  return imageId.replace(/[?&]frame=\d+$/, '');
}

export function registerLuts(baseImageId: string, bytes: Uint8Array): void {
  const luts = parseLutSequences(bytes);
  if (luts.modality || luts.voi.length > 0) lutsByBase.set(baseImageId, luts);
}

export function lutsFor(imageId: string): LutSequences | undefined {
  return lutsByBase.get(base(imageId));
}

export function modalityLutApplied(imageId: string): boolean {
  return modalityApplied.has(imageId);
}

export function forgetLuts(baseImageId: string): void {
  lutsByBase.delete(baseImageId);
  for (const id of modalityApplied) if (base(id) === baseImageId) modalityApplied.delete(id);
}

/** Applies a Modality LUT Sequence to decoded pixels in place when the output fits the pixel array type. */
export function applyLutSequences(image: Types.IImage, imageId: string): Types.IImage {
  const luts = lutsByBase.get(base(imageId));
  const lut = luts?.modality;
  if (!lut || modalityApplied.has(imageId) || image.color) return image;
  const pixels = image.getPixelData() as ArrayLike<number> & { [i: number]: number; constructor: unknown };
  const maxOut = 2 ** lut.bitsPerEntry - 1;
  const fits =
    pixels instanceof Uint16Array ||
    pixels instanceof Float32Array ||
    pixels instanceof Int32Array ||
    pixels instanceof Uint32Array ||
    (pixels instanceof Int16Array && maxOut <= 32767);
  if (!fits) return image;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = applyLut(pixels[i]!, lut);
    pixels[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  image.minPixelValue = min;
  image.maxPixelValue = max;
  image.slope = 1;
  image.intercept = 0;
  if (!image.windowWidth || (Array.isArray(image.windowWidth) && image.windowWidth.length === 0)) {
    image.windowCenter = (min + max + 1) / 2;
    image.windowWidth = Math.max(1, max - min + 1);
  }
  modalityApplied.add(imageId);
  return image;
}
