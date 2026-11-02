/**
 * Iso-surface meshes: binary STL layout and closed-mesh volume/area on analytic shapes (CLAUDE.md rule 9), and the
 * marching-cubes surface of a sphere against 4/3·π·r³.
 */
import { describe, expect, it } from 'vitest';
import { meshArea, meshVolume, parseStl, stlBinary, stlByteLength } from '@ahdicom/dicom-core';
import { isoSurface } from '../../../apps/desktop/renderer/src/viewer/isosurface';

// Unit cube, outward-facing triangles (counter-clockwise seen from outside).
const P = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const T = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];

describe('meshes', () => {
  it('volume and area of a closed cube', () => {
    expect(meshVolume(P, T)).toBeCloseTo(1, 12);
    expect(meshArea(P, T)).toBeCloseTo(6, 12);
    // Reversed orientation gives a negative volume.
    const rev = T.map((_, i) => T[i - (i % 3) + 2 - (i % 3)]!);
    expect(meshVolume(P, rev)).toBeCloseTo(-1, 12);
  });

  it('writes and reads a binary STL', () => {
    const bytes = stlBinary(P, T);
    expect(bytes.length).toBe(stlByteLength(12));
    expect(new DataView(bytes.buffer).getUint32(80, true)).toBe(12);
    // First facet (0, 2, 1) lies in z = 0 facing −z.
    const dv = new DataView(bytes.buffer);
    expect([dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true)]).toEqual([0, 0, -1]);
    const back = parseStl(bytes)!;
    expect(meshVolume(back.positions, back.triangles)).toBeCloseTo(1, 6);
    expect(parseStl(bytes.subarray(0, 100))).toBeUndefined();
  });
});

describe('marching cubes iso-surface', () => {
  it('a sphere of radius 10 voxels encloses 4/3·π·r³ within 1 %', () => {
    const n = 32;
    const c = 15.5;
    const r = 10;
    const scalars = new Float32Array(n * n * n);
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) scalars[i + n * (j + n * k)] = r - Math.hypot(i - c, j - c, k - c);
    const s = isoSurface(scalars, [n, n, n], 0);
    expect(s.triangles.length / 3).toBeGreaterThan(1000);
    const vol = Math.abs(meshVolume(s.positions, s.triangles));
    expect(Math.abs(vol / ((4 / 3) * Math.PI * r ** 3) - 1)).toBeLessThan(0.01);
    expect(Math.abs(meshArea(s.positions, s.triangles) / (4 * Math.PI * r * r) - 1)).toBeLessThan(0.02);
  });

  it('is empty when the threshold is not crossed', () => {
    const s = isoSurface(new Float32Array(27).fill(5), [3, 3, 3], 10);
    expect(s.triangles.length).toBe(0);
  });
});
