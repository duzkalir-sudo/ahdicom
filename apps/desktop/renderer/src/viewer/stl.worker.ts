/**
 * STL export worker: iso-surface of a volume (optionally inside a clipping box) in patient coordinates, written as
 * binary STL with outward-facing triangles. Runs off the UI thread.
 */
import { type ClipBox, type VolumeGeometry, meshVolume, stlBinary, voxelToPatient } from '@ahdicom/dicom-core';
import { isoSurface } from './isosurface';

export interface StlRequest {
  scalars: ArrayLike<number>;
  geometry: VolumeGeometry;
  threshold: number;
  clip?: ClipBox;
  maxTriangles: number;
}

export type StlResponse = { ok: true; bytes: Uint8Array; triangles: number } | { ok: false; reason: 'empty' | 'tooLarge' | 'failed' };

function run(req: StlRequest): StlResponse {
  const g = req.geometry;
  const [n0, n1, n2] = g.dimensions;
  const field = Float32Array.from(req.scalars);
  if (req.clip) {
    // Voxels outside the box are pushed below the threshold, so the surface closes at the box faces.
    const lo = req.clip.min.map((f, a) => Math.ceil(f * (g.dimensions[a]! - 1)));
    const hi = req.clip.max.map((f, a) => Math.floor(f * (g.dimensions[a]! - 1)));
    const outside = req.threshold - 1e6;
    let v = 0;
    for (let k = 0; k < n2; k++)
      for (let j = 0; j < n1; j++)
        for (let i = 0; i < n0; i++, v++)
          if (i < lo[0]! || i > hi[0]! || j < lo[1]! || j > hi[1]! || k < lo[2]! || k > hi[2]!) field[v] = outside;
  }
  const s = isoSurface(field, [n0, n1, n2], req.threshold);
  const count = s.triangles.length / 3;
  if (count === 0) return { ok: false, reason: 'empty' };
  if (count > req.maxTriangles) return { ok: false, reason: 'tooLarge' };
  const world = new Float32Array(s.positions.length);
  for (let p = 0; p < s.positions.length; p += 3) {
    const w = voxelToPatient(g, [s.positions[p]!, s.positions[p + 1]!, s.positions[p + 2]!]);
    world[p] = w[0];
    world[p + 1] = w[1];
    world[p + 2] = w[2];
  }
  // Outward normals: reverse the winding when the enclosed volume comes out negative.
  if (meshVolume(world, s.triangles) < 0) {
    for (let t = 0; t < s.triangles.length; t += 3) {
      const b = s.triangles[t + 1]!;
      s.triangles[t + 1] = s.triangles[t + 2]!;
      s.triangles[t + 2] = b;
    }
  }
  return { ok: true, bytes: stlBinary(world, s.triangles), triangles: count };
}

self.onmessage = (e: MessageEvent<StlRequest>): void => {
  let res: StlResponse;
  try {
    res = run(e.data);
  } catch {
    res = { ok: false, reason: 'failed' };
  }
  if (res.ok) (self as unknown as Worker).postMessage(res, [res.bytes.buffer]);
  else (self as unknown as Worker).postMessage(res);
};
