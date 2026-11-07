/// <reference lib="esnext.disposable" preserve="true" />
// Navmesh generation from a triangle soup: the public entry over the pipeline in pipeline.ts.
import type { Vec3, Vec3Like } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { NavMesh } from './index.js';
import { generate, turn, type Built, type NavigationOptions } from './pipeline.js';

export type { NavigationOptions, NavObstacle } from './pipeline.js';

/**
 * Builds a {@link NavMesh} from a triangle soup: voxelises the walkable triangles, filters by agent height, climb
 * and radius, and returns convex polygons linked by shared edges. Y is up; triangles are two-sided.
 * @param positions Flat xyz positions.
 * @param indices Flat triangle indices into `positions`.
 * @throws RangeError for invalid geometry, options or limits (see `NavigationOptions`), or a result above the
 * NavMesh limits (4096 polygons, 100,000 vertices).
 * @throws MargoError `failed` when nothing walkable is left.
 */
export function buildNavMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options?: NavigationOptions,
): NavMesh {
  return generate(positions, indices, options).mesh;
}

/**
 * A navmesh built from level triangles, with a path query that snaps both ends onto the walkable area.
 * Disposable; `dispose` only drops references (there is no native memory).
 */
export class Navigation {
  private mesh: NavMesh | null;
  private readonly vertices: Vec3[];
  private readonly polygons: number[][];
  private readonly planes: Float64Array;
  /** Snap search box half-extents: XZ (walkableRadius + 4) cells, Y (walkableHeight + walkableClimb + 2) voxels. */
  private readonly reach: number;
  private readonly lift: number;
  /** Polygon buckets on a uniform XZ grid when `buildBvTree` is on. */
  private readonly grid: {
    x: number;
    z: number;
    size: number;
    columns: number;
    rows: number;
    cells: number[][];
  } | null;
  private readonly seen: Uint32Array;
  private stamp = 0;
  private constructor(built: Built) {
    const { config, vertices, polygons } = built;
    this.mesh = built.mesh;
    this.vertices = vertices;
    this.polygons = polygons;
    this.reach = (config.walkableRadius + 4) * config.cs;
    this.lift = (config.walkableHeight + config.walkableClimb + 2) * config.ch;
    this.planes = new Float64Array(polygons.length * 4);
    this.seen = new Uint32Array(polygons.length);
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    polygons.forEach((polygon, p) => {
      const a = vertices[polygon[0]],
        b = vertices[polygon[1]],
        c = vertices[polygon[2]];
      const ux = b[0] - a[0],
        uy = b[1] - a[1],
        uz = b[2] - a[2],
        wx = c[0] - a[0],
        wy = c[1] - a[1],
        wz = c[2] - a[2];
      const nx = uy * wz - uz * wy,
        ny = uz * wx - ux * wz,
        nz = ux * wy - uy * wx;
      this.planes.set([nx, ny, nz, -(nx * a[0] + ny * a[1] + nz * a[2])], p * 4);
      for (const v of polygon) {
        x0 = Math.min(x0, vertices[v][0]);
        x1 = Math.max(x1, vertices[v][0]);
        z0 = Math.min(z0, vertices[v][2]);
        z1 = Math.max(z1, vertices[v][2]);
      }
    });
    if (!config.buildBvTree) {
      this.grid = null;
      return;
    }
    // About one bucket per polygon, and never smaller than the snap box.
    const size = Math.max(this.reach, Math.sqrt(((x1 - x0) * (z1 - z0)) / polygons.length), 1e-6),
      columns = Math.floor((x1 - x0) / size) + 1,
      rows = Math.floor((z1 - z0) / size) + 1,
      cells: number[][] = Array.from({ length: columns * rows }, () => []);
    polygons.forEach((polygon, p) => {
      let a = Infinity,
        b = -Infinity,
        c = Infinity,
        d = -Infinity;
      for (const v of polygon) {
        a = Math.min(a, vertices[v][0]);
        b = Math.max(b, vertices[v][0]);
        c = Math.min(c, vertices[v][2]);
        d = Math.max(d, vertices[v][2]);
      }
      for (let r = Math.floor((c - z0) / size); r <= Math.floor((d - z0) / size); r++)
        for (let k = Math.floor((a - x0) / size); k <= Math.floor((b - x0) / size); k++) cells[r * columns + k].push(p);
    });
    this.grid = { x: x0, z: z0, size, columns, rows, cells };
  }
  /**
   * Builds the navmesh from a triangle soup. Async for compatibility; the work runs synchronously in this call, and
   * every invalid argument rejects the promise.
   * @param positions Flat xyz positions (Y up).
   * @param indices Flat triangle indices into `positions`.
   * @throws RangeError (as a rejection) for invalid geometry or options; MargoError `failed` when nothing is walkable.
   */
  static async create(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    options?: NavigationOptions,
  ): Promise<Navigation> {
    return new Navigation(generate(positions, indices, options));
  }
  /** Polygons whose bounds may meet the snap box around (x, z), each once, passed to `visit`. */
  private near(x: number, z: number, visit: (polygon: number) => void): void {
    const grid = this.grid;
    if (!grid) {
      for (let p = 0; p < this.polygons.length; p++) visit(p);
      return;
    }
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const k0 = Math.max(0, Math.floor((x - this.reach - grid.x) / grid.size)),
      k1 = Math.min(grid.columns - 1, Math.floor((x + this.reach - grid.x) / grid.size)),
      r0 = Math.max(0, Math.floor((z - this.reach - grid.z) / grid.size)),
      r1 = Math.min(grid.rows - 1, Math.floor((z + this.reach - grid.z) / grid.size));
    for (let r = r0; r <= r1; r++)
      for (let k = k0; k <= k1; k++)
        for (const p of grid.cells[r * grid.columns + k])
          if (this.seen[p] !== this.stamp) {
            this.seen[p] = this.stamp;
            visit(p);
          }
  }
  /** The point itself when it stands on the mesh, else the nearest mesh point within the snap box, else null. */
  private snap(point: Vec3Like): Vec3 | null {
    const { x, y, z } = point,
      vertices = this.vertices,
      planes = this.planes;
    let onMesh = false,
      best: Vec3 | null = null,
      bestDistance = Infinity;
    this.near(x, z, (p) => {
      const polygon = this.polygons[p],
        n = polygon.length,
        surface = (px: number, pz: number) =>
          -(planes[4 * p] * px + planes[4 * p + 2] * pz + planes[4 * p + 3]) / planes[4 * p + 1];
      let inside = true;
      for (let i = 0; i < n && inside; i++) {
        const a = vertices[polygon[i]],
          b = vertices[polygon[(i + 1) % n]];
        if (turn(a[0], a[2], b[0], b[2], x, z) < -1e-9) inside = false;
      }
      if (inside) {
        if (Math.abs(surface(x, z) - y) <= this.lift) onMesh = true;
        return;
      }
      for (let i = 0; i < n; i++) {
        const a = vertices[polygon[i]],
          b = vertices[polygon[(i + 1) % n]],
          ex = b[0] - a[0],
          ez = b[2] - a[2],
          t = Math.min(1, Math.max(0, ((x - a[0]) * ex + (z - a[2]) * ez) / (ex * ex + ez * ez))),
          qx = a[0] + t * ex,
          qz = a[2] + t * ez,
          qy = surface(qx, qz);
        if (Math.abs(qx - x) > this.reach || Math.abs(qz - z) > this.reach || Math.abs(qy - y) > this.lift) continue;
        const distance = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = [qx, qy, qz];
        }
      }
    });
    return onMesh ? [x, y, z] : best;
  }
  /**
   * Shortest walkable path from `start` to `end`: corner points including both ends, where an end off the mesh is
   * first snapped to the nearest walkable point (within walkableRadius + 4 cells across and
   * walkableHeight + walkableClimb + 2 voxels up or down). One point when both ends meet; null when an end has
   * no walkable point nearby or no route connects them.
   * @throws MargoError `disposed` after `dispose()`.
   * @throws RangeError when an end has a non-finite component.
   */
  path(start: Vec3Like, end: Vec3Like): Vec3Like[] | null {
    const mesh = this.mesh;
    if (!mesh) throw new MargoError('disposed', 'Navigation is disposed; create a new Navigation');
    for (const p of [start, end])
      if (p == null || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))
        throw new RangeError('Invalid path endpoint: give {x, y, z} with finite numbers');
    const from = this.snap(start),
      to = this.snap(end);
    if (!from || !to) return null;
    const points = from[0] === to[0] && from[1] === to[1] && from[2] === to[2] ? [from] : mesh.path(from, to);
    return points ? points.map((p) => ({ x: p[0], y: p[1], z: p[2] })) : null;
  }
  /** Drops the mesh. Idempotent. */
  dispose(): void {
    this.mesh = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
