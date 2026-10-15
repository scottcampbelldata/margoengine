/**
 * Area-weighted smooth vertex normals for an indexed triangle list. Vertices touched by no
 * non-degenerate triangle get (0, 0, 1).
 */
export function computeVertexNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const normals = new Float64Array(positions.length);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3,
      b = indices[t + 1] * 3,
      c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  const out = new Float32Array(positions.length);
  for (let v = 0; v < out.length; v += 3) {
    const length = Math.hypot(normals[v], normals[v + 1], normals[v + 2]);
    if (length > 0 && Number.isFinite(length)) {
      out[v] = normals[v] / length;
      out[v + 1] = normals[v + 1] / length;
      out[v + 2] = normals[v + 2] / length;
    } else out[v + 2] = 1;
  }
  return out;
}

/** Unit face normal of triangle `a, b, c` (vertex indices), or (0, 0, 1) when degenerate. */
export function faceNormal(positions: ArrayLike<number>, a: number, b: number, c: number): [number, number, number] {
  a *= 3;
  b *= 3;
  c *= 3;
  const ux = positions[b] - positions[a],
    uy = positions[b + 1] - positions[a + 1],
    uz = positions[b + 2] - positions[a + 2];
  const vx = positions[c] - positions[a],
    vy = positions[c + 1] - positions[a + 1],
    vz = positions[c + 2] - positions[a + 2];
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return length > 0 && Number.isFinite(length) ? [nx / length, ny / length, nz / length] : [0, 0, 1];
}
