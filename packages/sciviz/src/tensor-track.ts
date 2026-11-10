import { tensorEigen, tensorError, type TensorEigen } from './tensor-math.js';
import type { Bounds } from './layer.js';
import type { TriangleSet } from './grids.js';

/** Cell-centred regular tensor grid, x fastest; bounds are the outer voxel faces. */
export interface TensorField {
  readonly dims: readonly [number, number, number];
  readonly bounds: Bounds;
  /** Six xx,yy,zz,xy,xz,yz coefficients per voxel, in the bounds' coordinate basis. */
  readonly tensors: ArrayLike<number>;
  readonly mask?: ArrayLike<number>;
}
/** @internal Snapshot validation shared by tracking and glyph generation. */
export function checkTensorField(field: TensorField): number {
  if (
    field.dims.length !== 3 ||
    field.bounds.length !== 6 ||
    field.dims.some((n) => !Number.isSafeInteger(n) || n < 1) ||
    field.bounds.some((v) => !Number.isFinite(v)) ||
    [0, 1, 2].some((k) => field.bounds[2 * k + 1] <= field.bounds[2 * k])
  )
    tensorError('field needs three positive integer dimensions and finite increasing bounds');
  const n = field.dims.reduce((a, v) => a * v, 1);
  if (!Number.isSafeInteger(n) || field.tensors.length !== n * 6 || (field.mask && field.mask.length !== n))
    tensorError('field tensor and mask lengths must match its dimensions');
  return n;
}
const index = (f: TensorField, p: readonly number[]) => (p[2] * f.dims[1] + p[1]) * f.dims[0] + p[0];
function cellTensor(f: TensorField, cell: readonly number[]): Float64Array | null {
  if (cell.some((v, k) => v < 0 || v >= f.dims[k])) return null;
  const i = index(f, cell);
  if (f.mask && !f.mask[i]) return null;
  const t = Float64Array.from({ length: 6 }, (_, k) => f.tensors[i * 6 + k]);
  return t.every(Number.isFinite) ? t : null;
}
/** Trilinear interpolation of tensor coefficients; eigenvectors are decomposed after interpolation, never blended. */
export function sampleTensor(field: TensorField, position: readonly [number, number, number]): Float64Array | null {
  checkTensorField(field);
  if (position.length !== 3 || position.some((v) => !Number.isFinite(v)))
    tensorError('sample positions need three finite coordinates');
  if (position.some((v, k) => v < field.bounds[2 * k] || v > field.bounds[2 * k + 1])) return null;
  const q = position.map(
      (v, k) => ((v - field.bounds[2 * k]) / (field.bounds[2 * k + 1] - field.bounds[2 * k])) * field.dims[k] - 0.5,
    ),
    lo = q.map(Math.floor),
    t = q.map((v, k) => v - lo[k]),
    out = new Float64Array(6);
  for (let c = 0; c < 8; c++) {
    const bits = [c & 1, (c >> 1) & 1, c >> 2],
      w = bits.reduce((a, b, k) => a * (b ? t[k] : 1 - t[k]), 1);
    if (!w) continue;
    const cell = lo.map((v, k) => Math.max(0, Math.min(field.dims[k] - 1, v + bits[k]))),
      tensor = cellTensor(field, cell);
    if (!tensor) return null;
    for (let k = 0; k < 6; k++) out[k] += w * tensor[k];
  }
  return out;
}
/** Deterministic stopping and integration in physical field coordinates. */
export interface FiberTrackingOptions {
  /** FACT follows voxel-boundary crossings; Euler samples an interpolated tensor at fixed steps. Default FACT. */
  readonly method?: 'euler' | 'fact';
  /** Euler step, default one quarter of the smallest voxel spacing. FACT ignores it. */
  readonly stepSize?: number;
  /** Default .15. */
  readonly minFA?: number;
  /** Maximum turn at a sample, degrees, default 45. */
  readonly maxAngle?: number;
  /** Maximum physical length per direction, default 1000. */
  readonly maxLength?: number;
  /** Maximum boundary visits/Euler steps per direction, default 4096. */
  readonly maxSteps?: number;
  /** Default true. */
  readonly bidirectional?: boolean;
  /** Default 1,000,000 total returned points. */
  readonly maxPoints?: number;
  readonly signal?: AbortSignal;
}
/** One bidirectionally joined path and its original seed index. */
export interface TensorFiber {
  readonly seed: number;
  readonly positions: Float64Array;
  readonly fa: Float64Array;
  readonly length: number;
}
/** Euler and Mori's FACT with sign-continuous principal axes, FA/angle/domain/mask and length termination. */
export async function trackTensorFibers(
  field: TensorField,
  seeds: ArrayLike<number>,
  options: FiberTrackingOptions = {},
): Promise<readonly TensorFiber[]> {
  checkTensorField(field);
  options.signal?.throwIfAborted();
  const spacing = field.dims.map((n, k) => (field.bounds[2 * k + 1] - field.bounds[2 * k]) / n),
    step = options.stepSize ?? Math.min(...spacing) / 4,
    method = options.method ?? 'fact',
    minFA = options.minFA ?? 0.15,
    angle = options.maxAngle ?? 45,
    length = options.maxLength ?? 1000,
    steps = options.maxSteps ?? 4096,
    budget = options.maxPoints ?? 1_000_000;
  if (
    !['euler', 'fact'].includes(method) ||
    seeds.length % 3 ||
    Array.from(seeds).some((v) => !Number.isFinite(v)) ||
    !(step > 0) ||
    !Number.isFinite(step) ||
    minFA < 0 ||
    minFA > 1 ||
    !Number.isFinite(minFA) ||
    !(angle > 0 && angle <= 180) ||
    !(length > 0) ||
    !Number.isFinite(length) ||
    !Number.isSafeInteger(steps) ||
    steps < 1 ||
    !Number.isSafeInteger(budget) ||
    budget < 1
  )
    tensorError('check seeds, method, positive steps/length and finite FA/angle limits');
  const cosine = Math.cos((angle * Math.PI) / 180),
    cache = new Map<number, TensorEigen | null>();
  let total = 0;
  const acceptable = (e: TensorEigen) =>
    e.fa >= minFA && e.values[0] > 0 && e.values[2] >= 0 && e.values[0] - e.values[1] > e.values[0] * 1e-12;
  const nearest = (cell: number[]) => {
    const i = index(field, cell);
    if (cell.some((v, k) => v < 0 || v >= field.dims[k])) return null;
    if (!cache.has(i)) {
      const t = cellTensor(field, cell);
      cache.set(i, t ? tensorEigen(t) : null);
    }
    return cache.get(i)!;
  };
  function half(seed: number[], sign: number): { points: number[][]; fa: number[]; length: number } {
    let p = seed.slice(),
      travelled = 0,
      previous: number[] | undefined;
    const points = [p.slice()],
      fa: number[] = [],
      cell = p.map((v, k) => Math.floor((v - field.bounds[k * 2]) / spacing[k]));
    if (p.some((v, k) => v < field.bounds[k * 2] || v >= field.bounds[k * 2 + 1]))
      return { points: [], fa: [], length: 0 };
    for (let visit = 0; visit < steps; visit++) {
      if (visit % 128 === 0) options.signal?.throwIfAborted();
      const tensor = method === 'euler' ? sampleTensor(field, p as [number, number, number]) : null,
        e = method === 'euler' ? (tensor ? tensorEigen(tensor) : null) : nearest(cell);
      if (!e || !acceptable(e)) break;
      let direction = Array.from(e.vectors.subarray(0, 3));
      if (previous) {
        let dot = direction.reduce((a, v, k) => a + v * previous![k], 0);
        if (dot < 0) {
          direction = direction.map((v) => -v);
          dot = -dot;
        }
        if (dot < cosine) break;
      } else direction = direction.map((v) => v * sign);
      if (!fa.length) fa.push(e.fa);
      let distance = Math.min(step, length - travelled),
        crossings: number[] = [];
      if (method === 'fact') {
        const times = direction.map((v, k) =>
            v === 0 ? Infinity : (field.bounds[k * 2] + (cell[k] + (v > 0 ? 1 : 0)) * spacing[k] - p[k]) / v,
          ),
          exit = Math.min(...times);
        if (exit < 0) tensorError('FACT encountered an inconsistent voxel boundary');
        distance = Math.min(exit, length - travelled);
        crossings = times.map((v, k) => (v === exit ? k : -1)).filter((k) => k >= 0);
        if (distance === 0) {
          for (const k of crossings) cell[k] += direction[k] > 0 ? 1 : -1;
          previous = direction;
          continue;
        }
      }
      p = p.map((v, k) => v + direction[k] * distance);
      travelled += distance;
      points.push(p.slice());
      fa.push(e.fa);
      previous = direction;
      if (method === 'fact' && distance < length - travelled + distance)
        for (const k of crossings) {
          p[k] = field.bounds[k * 2] + (cell[k] + (direction[k] > 0 ? 1 : 0)) * spacing[k];
          cell[k] += direction[k] > 0 ? 1 : -1;
          points[points.length - 1][k] = p[k];
        }
      if (travelled >= length) break;
      if (method === 'euler' && p.some((v, k) => v < field.bounds[2 * k] || v > field.bounds[2 * k + 1])) {
        points.pop();
        fa.pop();
        travelled -= distance;
        break;
      }
    }
    return { points: fa.length ? points : [], fa, length: travelled };
  }
  const fibers: TensorFiber[] = [];
  for (let i = 0; i < seeds.length / 3; i++) {
    options.signal?.throwIfAborted();
    if (i % 32 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    const seed = [seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]],
      a = half(seed, 1),
      b = options.bidirectional === false ? { points: [], fa: [], length: 0 } : half(seed, -1),
      points = [...b.points.slice(1).reverse(), ...a.points],
      fa = [...b.fa.slice(1).reverse(), ...a.fa];
    if (points.length < 2) continue;
    total += points.length;
    if (total > budget) tensorError('fiber output exceeds maxPoints; reduce seeds or increase the explicit budget');
    fibers.push({
      seed: i,
      positions: Float64Array.from(points.flat()),
      fa: Float64Array.from(fa),
      length: a.length + b.length,
    });
  }
  options.signal?.throwIfAborted();
  return fibers;
}

/** Hyperstreamline ellipse size and cross-section resolution. */
export interface HyperstreamlineOptions extends FiberTrackingOptions {
  /** Maximum generated triangles, default 1,000,000. */
  readonly maxTriangles?: number;
  /** Largest cross-section radius in field units, default half the smallest voxel spacing. */
  readonly radius?: number;
  /** Vertices around each ellipse, default 12, range 3..128. */
  readonly sides?: number;
}
/** Delmarcelle/Hesselink tubes: principal-axis paths, elliptical cross sections from the two transverse eigenvalues. */
export async function hyperstreamlines(
  field: TensorField,
  seeds: ArrayLike<number>,
  options: HyperstreamlineOptions = {},
): Promise<{ readonly fibers: readonly TensorFiber[]; readonly triangles: TriangleSet }> {
  const fibers = await trackTensorFibers(field, seeds, options),
    radius =
      options.radius ?? Math.min(...field.dims.map((n, k) => (field.bounds[2 * k + 1] - field.bounds[2 * k]) / n)) / 2,
    sides = options.sides ?? 12;
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isSafeInteger(sides) || sides < 3 || sides > 128)
    tensorError('hyperstreamlines need a positive radius and 3..128 sides');
  const maxTriangles = options.maxTriangles ?? 1_000_000;
  if (
    !Number.isSafeInteger(maxTriangles) ||
    maxTriangles < 1 ||
    fibers.reduce((n, f) => n + (f.positions.length / 3 - 1) * sides * 2, 0) > maxTriangles
  )
    tensorError('hyperstreamline mesh exceeds maxTriangles; reduce seeds/sides or increase its explicit budget');
  const positions: number[] = [],
    normals: number[] = [],
    values: number[] = [],
    cells: number[] = [],
    bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  fibers.forEach((fiber, fi) => {
    let previous: Float64Array | undefined, last: number[][] | undefined, lastNormals: number[][] | undefined;
    for (let i = 0; i < fiber.positions.length / 3; i++) {
      options.signal?.throwIfAborted();
      const p = Array.from(fiber.positions.subarray(i * 3, i * 3 + 3)),
        t = sampleTensor(field, p as [number, number, number]);
      if (!t) break;
      const e = tensorEigen(t),
        v = e.vectors;
      if (previous && v.slice(3, 6).reduce((sum, x, k) => sum + x * previous![k + 3], 0) < 0)
        for (let k = 3; k < 9; k++) v[k] *= -1;
      previous = v;
      const r2 = (radius * Math.max(0, e.values[1])) / e.values[0],
        r3 = (radius * Math.max(0, e.values[2])) / e.values[0],
        ring: number[][] = [],
        ns: number[][] = [];
      for (let k = 0; k < sides; k++) {
        const angle = (k / sides) * Math.PI * 2,
          c = Math.cos(angle),
          s = Math.sin(angle);
        ring.push(p.map((x, a) => x + r2 * c * v[a + 3] + r3 * s * v[a + 6]));
        const n = [0, 1, 2].map((a) => c * r3 * v[a + 3] + s * r2 * v[a + 6]),
          length = Math.hypot(...n);
        ns.push(n.map((x) => (length ? x / length : 0)));
      }
      if (last && lastNormals)
        for (let k = 0; k < sides; k++)
          for (const corners of [
            [
              [last[k], lastNormals[k]],
              [ring[k], ns[k]],
              [ring[(k + 1) % sides], ns[(k + 1) % sides]],
            ],
            [
              [last[k], lastNormals[k]],
              [ring[(k + 1) % sides], ns[(k + 1) % sides]],
              [last[(k + 1) % sides], lastNormals[(k + 1) % sides]],
            ],
          ]) {
            for (const [point, normal] of corners) {
              positions.push(...point);
              normals.push(...normal);
              values.push(e.fa);
              for (let a = 0; a < 3; a++) {
                bounds[a * 2] = Math.min(bounds[a * 2], point[a]);
                bounds[a * 2 + 1] = Math.max(bounds[a * 2 + 1], point[a]);
              }
            }
            cells.push(fi);
          }
      last = ring;
      lastNormals = ns;
    }
  });
  return {
    fibers,
    triangles: {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      values: new Float32Array(values),
      cells: new Uint32Array(cells),
      bounds: (cells.length ? bounds : [0, 0, 0, 0, 0, 0]) as unknown as Bounds,
    },
  };
}
