// Clean-room trilinear inverse mapping and stackless cell bounds, see docs/clean-room.md.
import { rangeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';

/** Structured node coordinates, x index fastest. Cells must be injective trilinear hexahedra. */
export interface CurvilinearGrid {
  /** Number of nodes on each computational axis, each at least two. */
  readonly dims: readonly [number, number, number];
  /** Interleaved physical xyz, one triple per node. Snapshotted at creation. */
  readonly points: ArrayLike<number>;
}
/** Exact spherical coordinates: x=r cos(lat) cos(lon), y=r cos(lat) sin(lon), z=r sin(lat). */
export interface SphericalGrid {
  /** Strictly increasing positive radii in data units. */
  readonly radius: ArrayLike<number>;
  /** Strictly increasing unwrapped radians, spanning at most 2 pi. Include both seam endpoints for a globe. */
  readonly longitude: ArrayLike<number>;
  /** Strictly increasing radians in [-pi/2,pi/2]. */
  readonly latitude: ArrayLike<number>;
  /** Physical centre, default [0,0,0]. */
  readonly center?: readonly [number, number, number];
}
/** @internal Immutable mapping uploaded by the optional layer. Coordinates are normalised to the physical bounds. */
export interface MappedGrid {
  readonly dims: readonly [number, number, number];
  readonly bounds: Bounds;
  readonly points: Float32Array;
  readonly nodes: Float32Array;
  readonly axes: Float32Array;
  readonly spherical: boolean;
  readonly center: readonly [number, number, number];
  readonly reference: number;
}
/** @internal Trilinear point and Jacobian, in bitwise xyz corner order. */
export function trilinear(corners: ArrayLike<number>, q: readonly number[]): { point: number[]; jacobian: number[][] } {
  const point = [0, 0, 0],
    jacobian = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
  for (let k = 0; k < 8; k++) {
    const b = [k & 1, (k >> 1) & 1, k >> 2],
      w = b.map((v, a) => (v ? q[a] : 1 - q[a]));
    for (let a = 0; a < 3; a++) {
      point[a] += corners[k * 3 + a] * w[0] * w[1] * w[2];
      for (let j = 0; j < 3; j++)
        jacobian[j][a] += corners[k * 3 + a] * (b[j] ? 1 : -1) * w[(j + 1) % 3] * w[(j + 2) % 3];
    }
  }
  return { point, jacobian };
}
function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}
/** Invert one trilinear cell. Returns null outside or on a singular mapping; never extrapolates. */
export function inverseCurvilinearCell(
  corners: ArrayLike<number>,
  point: readonly [number, number, number],
): readonly [number, number, number] | null {
  if (corners.length !== 24 || !Array.from(corners).every(Number.isFinite) || !point.every(Number.isFinite))
    throw rangeError('Inverse mapping needs eight finite xyz corners and a finite point', 'sciviz');
  const q = [0.5, 0.5, 0.5];
  let scale = 0;
  for (let a = 0; a < 3; a++) {
    const v = Array.from({ length: 8 }, (_, k) => corners[k * 3 + a]);
    scale = Math.max(scale, Math.max(...v) - Math.min(...v));
  }
  for (let i = 0; i < 24; i++) {
    const { point: p, jacobian: j } = trilinear(corners, q),
      r = p.map((v, a) => v - point[a]),
      det = dot(j[0], cross(j[1], j[2]));
    if (!Number.isFinite(det) || Math.abs(det) <= 1e-14 * scale ** 3) return null;
    if (Math.hypot(...r) <= 1e-9 * scale)
      return q.every((v) => v >= -1e-8 && v <= 1 + 1e-8)
        ? (q.map((v) => Math.max(0, Math.min(1, v))) as [number, number, number])
        : null;
    const delta = [dot(r, cross(j[1], j[2])), dot(r, cross(j[2], j[0])), dot(r, cross(j[0], j[1]))].map((v) => v / det);
    for (let a = 0; a < 3; a++) q[a] -= delta[a];
    if (q.some((v) => Math.abs(v) > 4)) return null;
  }
  return null;
}
/** @internal Snapshot, validate and spatially index a structured mapping. */
export function mappedGrid(input: CurvilinearGrid | SphericalGrid): MappedGrid {
  const spherical = 'radius' in input;
  let dims: readonly [number, number, number],
    points: Float64Array,
    axes = new Float32Array(4),
    center: readonly [number, number, number] = [0, 0, 0],
    bounds: Bounds;
  if (spherical) {
    const arrays = [input.longitude, input.latitude, input.radius].map((a) => Array.from(a));
    if (
      arrays.some((a) => a.length < 2 || a.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= a[i - 1]))) ||
      arrays[0].at(-1)! - arrays[0][0] > 2 * Math.PI + 1e-8 ||
      arrays[1][0] < -Math.PI / 2 ||
      arrays[1].at(-1)! > Math.PI / 2 ||
      arrays[2][0] <= 0
    )
      throw rangeError(
        'Spherical axes need increasing finite samples, positive radius and valid radian angles',
        'sciviz',
      );
    center = input.center ?? center;
    if (center.length !== 3 || !center.every(Number.isFinite))
      throw rangeError('Spherical centre needs three finite coordinates', 'sciviz');
    dims = arrays.map((a) => a.length) as [number, number, number];
    axes = new Float32Array(Math.max(...dims) * 4);
    arrays.forEach((a, k) => a.forEach((v, i) => (axes[i * 4 + k] = v)));
    const radius = arrays[2].at(-1)!;
    bounds = [
      center[0] - radius,
      center[0] + radius,
      center[1] - radius,
      center[1] + radius,
      center[2] - radius,
      center[2] + radius,
    ];
    points = new Float64Array(dims[0] * dims[1] * dims[2] * 3);
    for (let z = 0; z < dims[2]; z++)
      for (let y = 0; y < dims[1]; y++)
        for (let x = 0; x < dims[0]; x++) {
          const lon = arrays[0][x],
            lat = arrays[1][y],
            r = arrays[2][z],
            k = (x + dims[0] * (y + dims[1] * z)) * 3;
          points.set(
            [
              center[0] + r * Math.cos(lat) * Math.cos(lon),
              center[1] + r * Math.cos(lat) * Math.sin(lon),
              center[2] + r * Math.sin(lat),
            ],
            k,
          );
        }
  } else {
    dims = [...input.dims];
    points = Float64Array.from(input.points);
    bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (let k = 0; k < points.length; k++) {
      const a = k % 3;
      bounds[a * 2] = Math.min(bounds[a * 2], points[k]);
      bounds[a * 2 + 1] = Math.max(bounds[a * 2 + 1], points[k]);
    }
  }
  if (
    dims.some((n) => !Number.isInteger(n) || n < 2) ||
    points.length !== dims[0] * dims[1] * dims[2] * 3 ||
    !points.every(Number.isFinite) ||
    [0, 1, 2].some((a) => !(bounds[a * 2 + 1] > bounds[a * 2]))
  )
    throw rangeError(
      'Structured volume needs finite xyz at every node, three dimensions >=2 and nonzero physical bounds',
      'sciviz',
    );
  const packed = new Float32Array((points.length / 3) * 4);
  for (let k = 0; k < points.length / 3; k++)
    for (let a = 0; a < 3; a++)
      packed[k * 4 + a] = (points[k * 3 + a] - bounds[a * 2]) / (bounds[a * 2 + 1] - bounds[a * 2]);
  const cells: { id: number; lo: number[]; hi: number[] }[] = [];
  let reference = Infinity;
  for (let z = 0; z < dims[2] - 1; z++)
    for (let y = 0; y < dims[1] - 1; y++)
      for (let x = 0; x < dims[0] - 1; x++) {
        const c = new Float64Array(24),
          lo = [Infinity, Infinity, Infinity],
          hi = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < 8; k++) {
          const index = x + (k & 1) + dims[0] * (y + ((k >> 1) & 1) + dims[1] * (z + (k >> 2)));
          for (let a = 0; a < 3; a++) {
            const v = packed[index * 4 + a];
            c[k * 3 + a] = v;
            lo[a] = Math.min(lo[a], v);
            hi[a] = Math.max(hi[a], v);
          }
        }
        for (let k = 0; k < 8; k++)
          for (let a = 0; a < 3; a++)
            if (!(k & (1 << a))) {
              const length = Math.hypot(
                ...[0, 1, 2].map(
                  (b) => (c[k * 3 + b] - c[(k | (1 << a)) * 3 + b]) * (bounds[b * 2 + 1] - bounds[b * 2]),
                ),
              );
              if (length > 1e-7) reference = Math.min(reference, length);
            }
        if (!spherical) {
          let sign = 0;
          for (let k = 0; k < 9; k++) {
            const j = trilinear(c, k === 8 ? [0.5, 0.5, 0.5] : [k & 1, (k >> 1) & 1, k >> 2]).jacobian,
              det = dot(j[0], cross(j[1], j[2]));
            const relative = Math.hypot(...j[0]) * Math.hypot(...j[1]) * Math.hypot(...j[2]);
            if (Math.abs(det) <= relative * 1e-7 || !relative || (sign && sign * det < 0))
              throw rangeError('Curvilinear cell is singular or folded; supply an injective grid', 'sciviz');
            sign = Math.sign(det);
          }
          cells.push({ id: x + (dims[0] - 1) * (y + (dims[1] - 1) * z), lo, hi });
        }
      }
  if (spherical)
    for (let i = 1; i < dims[2]; i++) reference = Math.min(reference, axes[i * 4 + 2] - axes[(i - 1) * 4 + 2]);
  const nodes: number[] = [];
  function build(list: typeof cells): void {
    const at = nodes.length,
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const cell of list)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], cell.lo[a]);
        hi[a] = Math.max(hi[a], cell.hi[a]);
      }
    nodes.push(...lo, 0, ...hi, list.length === 1 ? list[0].id + 1 : 0);
    if (list.length > 1) {
      const axis = hi.map((v, a) => v - lo[a]).indexOf(Math.max(...hi.map((v, a) => v - lo[a])));
      list.sort((a, b) => a.lo[axis] + a.hi[axis] - b.lo[axis] - b.hi[axis]);
      const mid = list.length >> 1;
      build(list.slice(0, mid));
      build(list.slice(mid));
    }
    nodes[at + 3] = nodes.length / 8;
  }
  if (cells.length) build(cells);
  return {
    dims,
    bounds,
    points: packed,
    nodes: Float32Array.from(nodes.length ? nodes : [0, 0, 0, 1, 1, 1, 1, 0]),
    axes,
    spherical,
    center: [...center],
    reference,
  };
}
