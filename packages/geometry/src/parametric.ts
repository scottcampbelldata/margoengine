import type { GeometryData } from './data.js';

/**
 * A surface point for parameters `u` and `v` in [0, 1]: return `[x, y, z]`, or write the point into `target` and return
 * nothing (Three.js `ParametricGeometry` functions write into their target the same way).
 */
export type ParametricFunction = (u: number, v: number, target: [number, number, number]) => ArrayLike<number> | void;

// Parameter step for the surface derivatives, and how far a degenerate point (a pole or cusp) looks inward instead.
const step = 1e-5,
  inset = 1e-4;

/**
 * Three.js `ParametricGeometry`: samples `fn(u, v)` on a `(slices + 1) x (stacks + 1)` grid, `u = i / slices` across
 * and `v = j / stacks` up, with UVs `(u, v)`. Normals come from the surface, `dP/du x dP/dv` by central differences
 * (one-sided at the borders), so a surface whose parameters run counter-clockwise seen from outside gets outward
 * normals, matching the winding. Where both derivatives cannot span a plane (a sphere's poles), the normal is taken a
 * small step inside the parameter square, and failing that from the neighbouring triangles. Seams and poles are not
 * welded; `mergeVertices` does that.
 */
export function parametricGeometry(fn: ParametricFunction, slices = 8, stacks = 8): GeometryData {
  if (typeof fn !== 'function')
    throw new TypeError('parametricGeometry needs a function (u, v) => [x, y, z]; pass a surface function');
  for (const [label, value] of [
    ['slices', slices],
    ['stacks', stacks],
  ] as const)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
      throw new RangeError(`parametricGeometry ${label} ${value} is invalid; pass a finite number >= 1`);
  const columns = Math.floor(slices),
    rows = Math.floor(stacks),
    count = (columns + 1) * (rows + 1),
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2),
    indices = new Uint32Array(columns * rows * 6),
    target: [number, number, number] = [0, 0, 0],
    a: number[] = [0, 0, 0],
    b: number[] = [0, 0, 0],
    c: number[] = [0, 0, 0],
    e: number[] = [0, 0, 0];
  const sample = (u: number, v: number, out: number[]) => {
    target[0] = target[1] = target[2] = 0;
    const result = fn(u, v, target),
      point = result === undefined || result === null ? target : result;
    if (!point || point.length !== 3 || ![point[0], point[1], point[2]].every(Number.isFinite))
      throw new RangeError(`parametricGeometry fn(${u}, ${v}) is not a finite point; return [x, y, z]`);
    out[0] = point[0];
    out[1] = point[1];
    out[2] = point[2];
  };
  // dP/du x dP/dv at (u, v) into normals at `at`; false when the derivatives are parallel or zero.
  const normal = (u: number, v: number, at: number): boolean => {
    sample(Math.min(1, u + step), v, a);
    sample(Math.max(0, u - step), v, b);
    sample(u, Math.min(1, v + step), c);
    sample(u, Math.max(0, v - step), e);
    const ux = a[0] - b[0],
      uy = a[1] - b[1],
      uz = a[2] - b[2],
      vx = c[0] - e[0],
      vy = c[1] - e[1],
      vz = c[2] - e[2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz);
    if (!(length > 1e-12 * Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || !Number.isFinite(length)) return false;
    normals[at] = nx / length;
    normals[at + 1] = ny / length;
    normals[at + 2] = nz / length;
    return true;
  };
  const degenerate: number[] = [];
  for (let j = 0, k = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++, k++) {
      const u = i / columns,
        v = j / rows;
      sample(u, v, a);
      positions[k * 3] = a[0];
      positions[k * 3 + 1] = a[1];
      positions[k * 3 + 2] = a[2];
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
      if (!normal(u, v, k * 3) && !normal(u + Math.sign(0.5 - u) * inset, v + Math.sign(0.5 - v) * inset, k * 3))
        degenerate.push(k);
    }
  for (let j = 0, t = 0; j < rows; j++)
    for (let i = 0; i < columns; i++, t += 6) {
      const p = j * (columns + 1) + i,
        q = p + 1,
        r = p + columns + 2,
        s = p + columns + 1;
      indices[t] = p;
      indices[t + 1] = q;
      indices[t + 2] = s;
      indices[t + 3] = q;
      indices[t + 4] = r;
      indices[t + 5] = s;
    }
  // Last resort: the area-weighted normals of the triangles around the vertex.
  if (degenerate.length) {
    const sum = new Float64Array(count * 3);
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t] * 3,
        i1 = indices[t + 1] * 3,
        i2 = indices[t + 2] * 3,
        x1 = positions[i1] - positions[i0],
        y1 = positions[i1 + 1] - positions[i0 + 1],
        z1 = positions[i1 + 2] - positions[i0 + 2],
        x2 = positions[i2] - positions[i0],
        y2 = positions[i2 + 1] - positions[i0 + 1],
        z2 = positions[i2 + 2] - positions[i0 + 2],
        n = [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2];
      for (const i of [i0, i1, i2]) for (let c = 0; c < 3; c++) sum[i + c] += n[c];
    }
    for (const k of degenerate) {
      const x = sum[k * 3],
        y = sum[k * 3 + 1],
        z = sum[k * 3 + 2],
        length = Math.hypot(x, y, z);
      normals.set(length > 0 ? [x / length, y / length, z / length] : [0, 0, 1], k * 3);
    }
  }
  return { positions, normals, uvs, indices };
}
