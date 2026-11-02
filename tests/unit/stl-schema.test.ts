/**
 * IPC payload for STL export (main validates every renderer request, CLAUDE.md rule 4): file name without a path, and
 * bytes that have the binary STL layout within the size limit.
 */
import { describe, expect, it } from 'vitest';
import { stlBinary } from '@ahdicom/dicom-core';
import { MAX_STL_BYTES, StlSaveSchema } from '../../apps/desktop/shared/schemas';

const triangle = stlBinary([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);

describe('StlSaveSchema', () => {
  it('accepts a plain .stl name with a binary STL', () => {
    expect(StlSaveSchema.safeParse({ name: 'surface-300.stl', data: triangle }).success).toBe(true);
    expect(StlSaveSchema.safeParse({ name: 'surface--500.5.STL', data: triangle }).success).toBe(true);
  });

  it('rejects names with a path, another extension or too long', () => {
    for (const name of ['../x.stl', `C:${String.fromCharCode(92)}x.stl`, 'dir/x.stl', 'x.exe', 'x.stl.exe', '', `${'a'.repeat(97)}.stl`]) {
      expect(StlSaveSchema.safeParse({ name, data: triangle }).success, name).toBe(false);
    }
  });

  it('rejects bytes that are not a binary STL or exceed the limit', () => {
    expect(StlSaveSchema.safeParse({ name: 'x.stl', data: triangle.subarray(0, 120) }).success).toBe(false);
    expect(StlSaveSchema.safeParse({ name: 'x.stl', data: new Uint8Array(50) }).success).toBe(false);
    const wrongCount = triangle.slice();
    new DataView(wrongCount.buffer).setUint32(80, 2, true);
    expect(StlSaveSchema.safeParse({ name: 'x.stl', data: wrongCount }).success).toBe(false);
    expect(StlSaveSchema.safeParse({ name: 'x.stl', data: 'not bytes' }).success).toBe(false);
    expect(MAX_STL_BYTES).toBe(84 + 50 * 10_000_000);
  });
});
