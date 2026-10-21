import type { GeometryData } from './data.js';

/** Options for {@link decalGeometry}. */
export interface DecalGeometryOptions {
  /**
   * World distance each decal vertex moves along its normal so it draws above the surface instead of depth fighting
   * with it. Default 1/1000 of the decal's smaller side (`size` x or y).
   */
  offset?: number;
  /** Also keep triangles that face away from the projector (the far side of a thin wall). Default false. */
  backfaces?: boolean;
}

const finite = (value: ArrayLike<number> | undefined, width: number, label: string): ArrayLike<number> => {
  if (!value || typeof value !== 'object' || value.length !== width)
    throw new TypeError(`decalGeometry ${label} needs ${width} numbers; pass an array of length ${width}`);
  for (let i = 0; i < width; i++)
    if (typeof value[i] !== 'number' || !Number.isFinite(value[i]))
      throw new RangeError(`decalGeometry ${label} has a non-finite value; pass finite numbers`);
  return value;
};

/** Unit quaternion [x, y, z, w] from a quaternion, or from Euler XYZ radians (the order of core `Mesh.setRotation`). */
function quaternion(value: ArrayLike<number>): number[] {
  if (value?.length === 3) {
    const [x, y, z] = finite(value, 3, 'orientation') as number[],
      c1 = Math.cos(x / 2),
      s1 = Math.sin(x / 2),
      c2 = Math.cos(y / 2),
      s2 = Math.sin(y / 2),
      c3 = Math.cos(z / 2),
      s3 = Math.sin(z / 2);
    return [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    ];
  }
  const q = finite(value, 4, 'orientation (a quaternion, or Euler XYZ radians)'),
    length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!length) throw new RangeError('decalGeometry orientation is a zero quaternion; pass a unit quaternion');
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/**
 * The part of a mesh inside a box, ready to draw a decal texture on. The box is centred on
 * `position`, turned by `orientation` (a quaternion [x, y, z, w], or Euler XYZ radians) and `size` across in its own
 * x, y and z; it projects along its own -z, so its +z side faces the surface. `target` is the mesh's geometry and
 * `matrix` its world matrix (column-major, as `mesh.matrix`). Every triangle that faces the projector is clipped to
 * the box's six planes (Sutherland-Hodgman) and fanned back into triangles, keeping the target's winding; UVs come from
 * the box (`u = x / size.x + 0.5`, `v = y / size.y + 0.5`, so 0 to 1 across it) and normals are the target's,
 * interpolated. The result is in world space (draw it with an identity transform), lifted `offset` along its normals.
 */
export function decalGeometry(
  target: GeometryData,
  matrix: ArrayLike<number>,
  position: ArrayLike<number>,
  orientation: ArrayLike<number>,
  size: ArrayLike<number>,
  options: DecalGeometryOptions = {},
): GeometryData {
  const P = target?.positions,
    N = target?.normals,
    I = target?.indices;
  if (!P || !N || !I || P.length % 3 || N.length !== P.length || I.length % 3)
    throw new TypeError('decalGeometry target needs GeometryData: xyz positions and normals, whole triangles');
  const vertices = P.length / 3;
  for (let i = 0; i < I.length; i++)
    if (!(I[i] < vertices)) throw new RangeError(`decalGeometry target index ${I[i]} is out of range; fix the indices`);
  const m = finite(matrix, 16, 'matrix'),
    origin = finite(position, 3, 'position'),
    box = finite(size, 3, 'size'),
    q = quaternion(orientation);
  if (!(box[0] > 0 && box[1] > 0 && box[2] > 0))
    throw new RangeError('decalGeometry size must be > 0 on every axis; pass the box width, height and depth');
  const offset = options.offset ?? Math.min(box[0], box[1]) / 1000;
  if (typeof offset !== 'number' || !Number.isFinite(offset))
    throw new RangeError(`decalGeometry offset ${offset} is invalid; pass a finite distance`);
  // Decal rotation as columns: the box's x, y and z axes in world space.
  const [x, y, z, w] = q,
    R = [
      1 - 2 * (y * y + z * z),
      2 * (x * y + z * w),
      2 * (x * z - y * w),
      2 * (x * y - z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z + x * w),
      2 * (x * z + y * w),
      2 * (y * z - x * w),
      1 - 2 * (x * x + y * y),
    ];
  // Inverse-transpose of the world matrix's upper 3x3 (cofactors over the determinant) for normals.
  const c00 = m[5] * m[10] - m[9] * m[6],
    c01 = m[9] * m[2] - m[1] * m[10],
    c02 = m[1] * m[6] - m[5] * m[2],
    c10 = m[8] * m[6] - m[4] * m[10],
    c11 = m[0] * m[10] - m[8] * m[2],
    c12 = m[4] * m[2] - m[0] * m[6],
    c20 = m[4] * m[9] - m[8] * m[5],
    c21 = m[8] * m[1] - m[0] * m[9],
    c22 = m[0] * m[5] - m[4] * m[1],
    det = m[0] * c00 + m[4] * c01 + m[8] * c02;
  if (!det || !Number.isFinite(det))
    throw new RangeError('decalGeometry matrix is singular; pass the mesh world matrix');
  // Every target vertex in decal space, and its normal in world space (the cofactors over |det|: only the sign matters).
  const sign = Math.sign(det),
    local = new Float64Array(vertices * 3),
    normal = new Float64Array(vertices * 3);
  for (let i = 0; i < vertices; i++) {
    const px = P[i * 3],
      py = P[i * 3 + 1],
      pz = P[i * 3 + 2],
      wx = m[0] * px + m[4] * py + m[8] * pz + m[12] - origin[0],
      wy = m[1] * px + m[5] * py + m[9] * pz + m[13] - origin[1],
      wz = m[2] * px + m[6] * py + m[10] * pz + m[14] - origin[2];
    for (let c = 0; c < 3; c++) local[i * 3 + c] = R[c * 3] * wx + R[c * 3 + 1] * wy + R[c * 3 + 2] * wz;
    const nx = N[i * 3],
      ny = N[i * 3 + 1],
      nz = N[i * 3 + 2];
    normal[i * 3] = (c00 * nx + c01 * ny + c02 * nz) * sign;
    normal[i * 3 + 1] = (c10 * nx + c11 * ny + c12 * nz) * sign;
    normal[i * 3 + 2] = (c20 * nx + c21 * ny + c22 * nz) * sign;
  }
  const half = [box[0] / 2, box[1] / 2, box[2] / 2],
    flip = sign < 0,
    positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  // A clipped polygon: six numbers per corner, decal-space position then world normal.
  let polygon: number[] = [],
    next: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3,
      b = I[t + 1] * 3,
      c = I[t + 2] * 3;
    let outside = false;
    for (let k = 0; k < 3 && !outside; k++)
      outside =
        Math.min(local[a + k], local[b + k], local[c + k]) > half[k] ||
        Math.max(local[a + k], local[b + k], local[c + k]) < -half[k];
    if (outside) continue;
    // Facing the projector means the world-space face normal has +z in decal space (a mirroring matrix flips it).
    const facing =
      ((local[b] - local[a]) * (local[c + 1] - local[a + 1]) - (local[b + 1] - local[a + 1]) * (local[c] - local[a])) *
      (flip ? -1 : 1);
    if (!options.backfaces && !(facing > 0)) continue;
    polygon.length = 0;
    for (const v of [a, b, c])
      polygon.push(local[v], local[v + 1], local[v + 2], normal[v], normal[v + 1], normal[v + 2]);
    for (let k = 0; k < 6 && polygon.length; k++) {
      const axis = k >> 1,
        side = k & 1 ? -1 : 1,
        corners = polygon.length / 6;
      next.length = 0;
      for (let i = 0; i < corners; i++) {
        const p = i * 6,
          q = ((i + 1) % corners) * 6,
          dp = side * polygon[p + axis] - half[axis],
          dq = side * polygon[q + axis] - half[axis];
        if (dp <= 0) for (let j = 0; j < 6; j++) next.push(polygon[p + j]);
        if (dp <= 0 !== dq <= 0) {
          const s = dp / (dp - dq);
          for (let j = 0; j < 6; j++) next.push(polygon[p + j] + (polygon[q + j] - polygon[p + j]) * s);
          // The crossing lies on the plane exactly.
          next[next.length - 6 + axis] = side * half[axis];
        }
      }
      [polygon, next] = [next, polygon];
    }
    const corners = polygon.length / 6;
    if (corners < 3) continue;
    const first = positions.length / 3;
    for (let i = 0; i < corners; i++) {
      const p = i * 6,
        lx = polygon[p],
        ly = polygon[p + 1],
        lz = polygon[p + 2],
        nl = Math.hypot(polygon[p + 3], polygon[p + 4], polygon[p + 5]) || 1,
        nx = polygon[p + 3] / nl,
        ny = polygon[p + 4] / nl,
        nz = polygon[p + 5] / nl;
      positions.push(
        origin[0] + R[0] * lx + R[3] * ly + R[6] * lz + nx * offset,
        origin[1] + R[1] * lx + R[4] * ly + R[7] * lz + ny * offset,
        origin[2] + R[2] * lx + R[5] * ly + R[8] * lz + nz * offset,
      );
      normals.push(nx, ny, nz);
      uvs.push(Math.min(1, Math.max(0, lx / box[0] + 0.5)), Math.min(1, Math.max(0, ly / box[1] + 0.5)));
    }
    for (let i = 1; i + 1 < corners; i++)
      if (flip) indices.push(first, first + i + 1, first + i);
      else indices.push(first, first + i, first + i + 1);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}
