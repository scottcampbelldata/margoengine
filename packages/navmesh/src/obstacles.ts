import { TiledNavMesh } from '@margoengine/navmesh/tiles';
import type { NavObstacle } from './build.js';
import type { Vec3 } from './index.js';

/** An upright cylinder, with its base center in world space. */
export interface NavCylinderObstacle {
  /** Shape discriminator. */
  type: 'cylinder';
  /** Base center [x,y,z]. */
  position: Vec3;
  /** Positive radius in world units. */
  radius: number;
  /** Positive height above the base, in world units. */
  height: number;
}

/** A box rotated around the world's Y axis. */
export interface NavRotatedBoxObstacle {
  /** Shape discriminator. */
  type: 'box';
  /** World-space center [x,y,z]. */
  center: Vec3;
  /** Positive half extents on the unrotated local X,Y,Z axes. */
  halfExtents: Vec3;
  /** Right-handed rotation about +Y, in radians. Default 0. */
  yRadians?: number;
}

/** Axis-aligned boxes, upright cylinders and Y-rotated boxes accepted by ObstacleNavMesh. */
export type NavTileObstacle = NavObstacle | NavCylinderObstacle | NavRotatedBoxObstacle;

const finitePoint = (p: Vec3 | undefined, label: string): Vec3 => {
  if (!p || p.length !== 3 || ![p[0], p[1], p[2]].every(Number.isFinite))
    throw new RangeError(`${label} must be finite [x,y,z]; pass three finite coordinates.`);
  return p;
};
// First integer for which a monotone predicate is true, or last+1. No coordinate tolerance is used.
const firstTrue = (first: number, last: number, test: (column: number) => boolean): number => {
  let low = first,
    high = last + 1;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (test(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
};

/**
 * Tiled navmesh with cylinder and rotated-box carving, using the same cell-center semantics, erosion and update queue
 * as ordinary box obstacles. One shape is one public id; internal horizontal cell runs remain private to it.
 */
export class ObstacleNavMesh extends TiledNavMesh {
  private readonly groups = new Map<number, number[]>();
  private nextShape = -1;
  private runs(shape: NavCylinderObstacle | NavRotatedBoxObstacle): NavObstacle[] {
    const cs = this.config.cs,
      [ox, , oz] = this.origin;
    let x: number,
      z: number,
      y0: number,
      y1: number,
      extentX: number,
      extentZ: number,
      interval: (dz: number, low: number, high: number) => readonly [number, number] | null;
    if (shape.type === 'cylinder') {
      const p = finitePoint(shape.position, 'Cylinder base');
      if (!(shape.radius > 0 && Number.isFinite(shape.radius) && shape.height > 0 && Number.isFinite(shape.height)))
        throw new RangeError('Cylinder radius and height must be finite and positive; pass world-unit dimensions.');
      [x, y0, z] = p;
      y1 = y0 + shape.height;
      extentZ = shape.radius;
      extentX = shape.radius;
      interval = (dz, low, high) => {
        const r2 = shape.radius ** 2,
          dz2 = dz ** 2;
        if (dz2 > r2) return null;
        const left = firstTrue(low, high, (col) => {
          const dx = ox + (col + 0.5) * cs - x;
          return dx >= 0 || dx ** 2 + dz2 <= r2;
        });
        const right =
          firstTrue(low, high, (col) => {
            const dx = ox + (col + 0.5) * cs - x;
            return dx > 0 && dx ** 2 + dz2 > r2;
          }) - 1;
        return left <= right ? [left, right] : null;
      };
    } else if (shape.type === 'box') {
      const p = finitePoint(shape.center, 'Box center'),
        h = finitePoint(shape.halfExtents, 'Box halfExtents'),
        angle = shape.yRadians ?? 0;
      if (!h.every((v) => v > 0) || !Number.isFinite(angle))
        throw new RangeError(
          'Box halfExtents must be positive and yRadians finite; pass local world-unit half sizes and a Y angle.',
        );
      [x, , z] = p;
      y0 = p[1] - h[1];
      y1 = p[1] + h[1];
      const c = Math.cos(angle),
        s = Math.sin(angle);
      extentZ = Math.abs(s) * h[0] + Math.abs(c) * h[2];
      extentX = Math.abs(c) * h[0] + Math.abs(s) * h[2];
      interval = (dz, low, high) => {
        // Inverse right-handed Y rotation: local x=c*dx-s*dz, local z=s*dx+c*dz.
        for (const [coefficient, offset, half] of [
          [c, -s * dz, h[0]],
          [s, c * dz, h[2]],
        ]) {
          if (coefficient === 0) {
            if (Math.abs(offset) > half) return null;
            continue;
          }
          const value = (col: number) => coefficient * (ox + (col + 0.5) * cs - x) + offset;
          low = firstTrue(low, high, (col) => (coefficient > 0 ? value(col) >= -half : value(col) <= half));
          high = firstTrue(low, high, (col) => (coefficient > 0 ? value(col) > half : value(col) < -half)) - 1;
          if (low > high) return null;
        }
        return [low, high];
      };
    } else throw new RangeError('Unsupported obstacle type; use cylinder, box, or an axis-aligned {min,max} box.');
    // The extra candidate ring covers rounding in the bounding box; exact predicates select the final cells.
    const first = Math.ceil((z - extentZ - oz) / cs - 0.5) - 1,
      last = Math.floor((z + extentZ - oz) / cs - 0.5) + 1,
      x0 = Math.ceil((x - extentX - ox) / cs - 0.5) - 1,
      x1 = Math.floor((x + extentX - ox) / cs - 0.5) + 1;
    if (
      ![x, z, y0, y1, extentX, extentZ].every(Number.isFinite) ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      !Number.isSafeInteger(x0) ||
      !Number.isSafeInteger(x1) ||
      last - first > 1000000
    )
      throw new RangeError(
        'Obstacle exceeds the finite lattice or 1000000 row limit; use smaller dimensions or larger cells.',
      );
    const runs: NavObstacle[] = [];
    for (let row = first; row <= last; row++) {
      const range = interval(oz + (row + 0.5) * cs - z, x0, x1);
      if (!range) continue;
      const [left, right] = range;
      if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right))
        throw new RangeError('Obstacle X range exceeds the lattice; move it nearer the origin or increase cell size.');
      if (left <= right) {
        const box: NavObstacle = {
          min: [ox + left * cs, y0, oz + row * cs],
          max: [ox + (right + 1) * cs, y1, oz + (row + 1) * cs],
        };
        if (![...box.min, ...box.max].every(Number.isFinite))
          throw new RangeError('Obstacle row exceeds finite world coordinates; use smaller dimensions.');
        runs.push(box);
      }
    }
    return runs;
  }
  /**
   * Adds a shape to the normal tile rebuild queue. New shape ids are negative; ordinary box ids are unchanged.
   * @throws RangeError for invalid or oversized shape dimensions; use finite positive dimensions and at most 1000000 rows.
   */
  override addObstacle(obstacle: NavTileObstacle): number {
    if ('min' in obstacle) return super.addObstacle(obstacle);
    super.update(0);
    const runs = this.runs(obstacle),
      id = this.nextShape--;
    this.groups.set(
      id,
      runs.map((box) => super.addObstacle(box)),
    );
    return id;
  }
  /** Adds an upright cylinder; position is its base center, radius and height are world units. */
  addCylinderObstacle(position: Vec3, radius: number, height: number): number {
    return this.addObstacle({ type: 'cylinder', position, radius, height });
  }
  /** Adds a Y-rotated box with world center and local half extents. */
  addBoxObstacle(center: Vec3, halfExtents: Vec3, yRadians = 0): number {
    return this.addObstacle({ type: 'box', center, halfExtents, yRadians });
  }
  /**
   * Replaces a cylinder/rotated box, retaining its id and queuing both footprints. False for a missing id.
   * Ordinary box ids may also change to a shaped obstacle.
   * @throws RangeError for an invalid replacement; pass finite positive dimensions. Validation precedes mutation.
   */
  override moveObstacle(id: number, obstacle: NavTileObstacle): boolean {
    if (!this.groups.has(id) && 'min' in obstacle) return super.moveObstacle(id, obstacle);
    super.update(0);
    let runs: NavObstacle[];
    if ('min' in obstacle) {
      const min = finitePoint(obstacle.min, 'Box min'),
        max = finitePoint(obstacle.max, 'Box max');
      if (min.some((v, i) => v > max[i])) throw new RangeError('Box min must not exceed max; order the corners.');
      runs = [{ min: [...min] as [number, number, number], max: [...max] as [number, number, number] }];
    } else runs = this.runs(obstacle);
    const group = this.groups.get(id);
    if (group) for (const child of group) super.removeObstacle(child);
    else if (!super.removeObstacle(id)) return false;
    this.groups.set(
      id,
      runs.map((box) => super.addObstacle(box)),
    );
    return true;
  }
  /** Removes one complete shape, or an ordinary box; false for a missing id. */
  override removeObstacle(id: number): boolean {
    const group = this.groups.get(id);
    if (!group) return super.removeObstacle(id);
    super.update(0);
    for (const child of group) super.removeObstacle(child);
    this.groups.delete(id);
    return true;
  }
  /** Releases grouped handles and the underlying tiled mesh. Idempotent. */
  override dispose(): void {
    this.groups.clear();
    super.dispose();
  }
}
