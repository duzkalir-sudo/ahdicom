/**
 * Triangle meshes (iso-surfaces): binary STL writing and closed-mesh volume/area for verification.
 * Positions are xyz triples in patient coordinates (mm); triangles are index triples.
 */

/** Size of a binary STL file: 80-byte header, 4-byte triangle count, 50 bytes per triangle. */
export function stlByteLength(triangles: number): number {
  return 84 + 50 * triangles;
}

/** Binary STL of a triangle mesh; each facet's normal is computed from its vertex order (right-hand rule). */
export function stlBinary(positions: ArrayLike<number>, triangles: ArrayLike<number>, header = 'AHDicom iso-surface (mm)'): Uint8Array {
  const n = Math.floor(triangles.length / 3);
  const out = new Uint8Array(stlByteLength(n));
  const view = new DataView(out.buffer);
  for (let i = 0; i < Math.min(80, header.length); i++) out[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = triangles[3 * t]! * 3;
    const b = triangles[3 * t + 1]! * 3;
    const c = triangles[3 * t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const v of [nx, ny, nz]) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    for (const p of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        view.setFloat32(o, positions[p + k]!, true);
        o += 4;
      }
    }
    o += 2; // attribute byte count
  }
  return out;
}

/** Enclosed volume of a closed, consistently oriented mesh (divergence theorem); sign follows the orientation. */
export function meshVolume(positions: ArrayLike<number>, triangles: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t]! * 3;
    const b = triangles[t + 1]! * 3;
    const c = triangles[t + 2]! * 3;
    const [ax, ay, az] = [positions[a]!, positions[a + 1]!, positions[a + 2]!];
    const [bx, by, bz] = [positions[b]!, positions[b + 1]!, positions[b + 2]!];
    const [cx, cy, cz] = [positions[c]!, positions[c + 1]!, positions[c + 2]!];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Total surface area of a mesh. */
export function meshArea(positions: ArrayLike<number>, triangles: ArrayLike<number>): number {
  let s = 0;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t]! * 3;
    const b = triangles[t + 1]! * 3;
    const c = triangles[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}

/** Positions and triangles read back from a binary STL (vertices are not merged). */
export function parseStl(bytes: Uint8Array): { positions: Float32Array; triangles: Uint32Array } | undefined {
  if (bytes.length < 84) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(80, true);
  if (bytes.length !== stlByteLength(n)) return undefined;
  const positions = new Float32Array(n * 9);
  const triangles = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const o = 84 + 50 * t + 12;
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(o + 4 * k, true);
    for (let k = 0; k < 3; k++) triangles[t * 3 + k] = t * 3 + k;
  }
  return { positions, triangles };
}
