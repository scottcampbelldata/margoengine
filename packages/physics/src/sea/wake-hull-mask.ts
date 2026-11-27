import { MargoError } from '@margoengine/math/errors';
import { transformPointChecked } from '@margoengine/math/mat4';
import type { QuayPotentialGrid } from '../loads/quay-potential.js';
import { requireWakeHullMesh } from '../seakeeping/wake-mesh.js';
import type { HullMesh } from '../seakeeping/wetted.js';
import { closedSurface, corners, weldMesh } from '../soft-volume.js';

export interface WakeHullMaskGrid extends Pick<QuayPotentialGrid, 'cells' | 'cellSize' | 'depths' | 'wet'> {
  /** Lower horizontal grid corner in the wake's world cell, in metres. Defaults to [0, 0]. */
  readonly origin?: readonly [number, number];
}

type Point = readonly [number, number, number];

function lowerBound(samples: Float64Array, target: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (samples[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Evaluate shared edges in the same arithmetic direction, then restore the triangle's directed sign.
// The half-open tie is the sign after a symbolic move (−d, −d²) in the projected (Y,Z) plane.
function edgeSide(a: Point, b: Point, y: number, z: number): boolean {
  const backwards = a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]);
  const [start, end] = backwards ? [b, a] : [a, b];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const edge = dz * (y - start[1]) - dy * (z - start[2]);
  const tie = dz === 0 ? dy : -dz;
  return (edge > 0 || (edge === 0 && tie > 0)) !== backwards;
}

function applyWorldTransform(vertices: number[], transform: ArrayLike<number>): void {
  if (
    transform.length !== 16 ||
    !Array.from(transform).every(Number.isFinite) ||
    transform[3] !== 0 ||
    transform[7] !== 0 ||
    transform[11] !== 0 ||
    transform[15] !== 1
  )
    throw new MargoError('state', 'Pass a finite affine column-major hull-to-wake matrix with final row [0, 0, 0, 1].');
  const a = transform[0]!,
    b = transform[1]!,
    c = transform[2]!;
  const d = transform[4]!,
    e = transform[5]!,
    f = transform[6]!;
  const g = transform[8]!,
    h = transform[9]!,
    i = transform[10]!;
  const determinant = a * (e * i - f * h) + b * (f * g - d * i) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || determinant === 0)
    throw new MargoError('state', 'Use an invertible affine transform for the wake hull.');
  for (let at = 0; at < vertices.length; at += 3) {
    const result = transformPointChecked(transform, [vertices[at]!, vertices[at + 1]!, vertices[at + 2]!]);
    if (!result.ok) throw new MargoError('state', 'Keep the transformed hull finite in the wake origin cell.');
    for (let axis = 0; axis < 3; axis++) vertices[at + axis] = result.point[axis]!;
  }
}

/**
 * Bake a closed indexed mean hull into the cell-centred FiniteQuayWake mask, with X fastest, then Z, then depth.
 * Exact seam copies are welded. Each layer uses its own physical centre, and existing dry cells stay outside the hull mask.
 * The optional matrix maps local vertices to metres in the wake's cell. The output is a binary centre sample of the solid.
 * Use non-self-intersecting shells. Closed cavities follow even–odd fill, as in Nooruddin and Turk (2003), §3.2.
 */
export function bakeWakeHullMask(mesh: HullMesh, grid: WakeHullMaskGrid, transform?: ArrayLike<number>): Uint8Array {
  const { vertices, indices } = requireWakeHullMesh(mesh);
  if (!grid?.cells || grid.cells.length !== 2 || !grid.depths)
    throw new MargoError('state', 'Give the hull mask the finite wake grid and its layer faces.');
  const {
    cells: [nx, nz],
    cellSize: dx,
    depths,
    origin = [0, 0],
    wet,
  } = grid;
  const layers = depths.length - 1;
  const plane = nx * nz;
  const count = plane * layers;
  if (
    ![nx, nz].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !(Number.isFinite(dx) && dx > 0) ||
    layers < 1 ||
    depths[0] !== 0 ||
    depths.some((depth, i) => !Number.isFinite(depth) || (i > 0 && depth <= depths[i - 1]!)) ||
    origin.length !== 2 ||
    !origin.every(Number.isFinite) ||
    !Number.isSafeInteger(count) ||
    count > 0x1fffffff ||
    (wet && (wet.length !== count || Array.prototype.some.call(wet, (v: number) => v !== 0 && v !== 1)))
  )
    throw new MargoError(
      'state',
      'Match the finite wake grid, increasing depth faces, origin and optional binary wet mask.',
    );

  const welded = weldMesh(vertices, indices, 3, 0);
  const { positions, triangles } = welded;
  if (positions.length < 12 || triangles.length !== indices.length || !closedSurface(triangles))
    throw new MargoError(
      'state',
      'Use a closed, consistently wound hull with noncollapsed triangles and paired edges.',
    );
  if (transform) applyWorldTransform(positions, transform);

  const xs = Float64Array.from({ length: nx }, (_, i) => origin[0] + (i + 0.5) * dx);
  const zs = Float64Array.from({ length: nz }, (_, i) => origin[1] + (i + 0.5) * dx);
  // Ascending Y for binary search. Array index j therefore represents physical layer layers−1−j.
  const ys = Float64Array.from({ length: layers }, (_, i) => -depths[layers - i]! / 2 - depths[layers - 1 - i]! / 2);
  if ([xs, ys, zs].some((axis) => axis.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= axis[i - 1]!))))
    throw new MargoError(
      'state',
      'Space hull-mask cell centres at resolvable, finite distances in the wake origin cell.',
    );

  const rays = new Map<number, number[]>();
  for (let t = 0; t < triangles.length / 3; t++) {
    // Geometry chooses the plane arithmetic, even after vertex, triangle and corner reindexing.
    const [a, b, c] = corners(positions, triangles, t).sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const [normalX, normalY, normalZ] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    if (!(normalX || normalY || normalZ) || ![normalX, normalY, normalZ].every(Number.isFinite))
      throw new MargoError('state', 'Remove zero-area triangles and keep hull dimensions finite before baking.');
    if (!normalX) continue;
    const maxY = Math.max(a[1], b[1], c[1]);
    const maxZ = Math.max(a[2], b[2], c[2]);
    const firstZ = lowerBound(zs, Math.min(a[2], b[2], c[2]));
    for (let j = lowerBound(ys, Math.min(a[1], b[1], c[1])); j < layers && ys[j]! <= maxY; j++) {
      const y = ys[j]!;
      for (let k = firstZ; k < nz && zs[k]! <= maxZ; k++) {
        const z = zs[k]!;
        const side = edgeSide(a, b, y, z);
        if (side !== edgeSide(b, c, y, z) || side !== edgeSide(c, a, y, z)) continue;
        const x = a[0] - (normalY * (y - a[1]) + normalZ * (z - a[2])) / normalX;
        if (!Number.isFinite(x))
          throw new MargoError('state', 'Keep hull face intersections finite in the wake origin cell.');
        const key = k + (layers - 1 - j) * nz;
        const crossings = rays.get(key);
        if (crossings) crossings.push(x);
        else rays.set(key, [x]);
      }
    }
  }
  const mask = new Uint8Array(count);
  for (const [row, crossings] of rays) {
    if (crossings.length % 2) throw new MargoError('state', 'Use a clean closed hull with paired solid crossings.');
    crossings.sort((a, b) => a - b);
    for (let i = 0; i < crossings.length; i += 2) {
      const start = lowerBound(xs, crossings[i]!);
      const end = lowerBound(xs, crossings[i + 1]!);
      for (let x = start; x < end; x++) {
        const cell = row * nx + x;
        if (wet?.[cell] !== 0) mask[cell] = 1;
      }
    }
  }
  return mask;
}
