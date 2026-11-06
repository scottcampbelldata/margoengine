// The `sdf` entry: concave obstacles. MeshVolume asks a MeshBVH for exact distances, by branch and bound over the tree
// with GJK on each triangle. SDFVolume reads a signed distance field, such as bakeSDF's, and finds a shape's smallest
// reading by branch and bound on the field's Lipschitz bound, the argument of J. C. Hart, "Sphere tracing", The Visual
// Computer 12(10), 1996: a field that changes no faster than L can be no lower than its value less L times the distance.
// Written clean room from that publication and the repository's own bvh package.
import type { MeshBVH } from '@margoengine/bvh';
import { pointInside } from '@margoengine/bvh/inside';
import { rangeError, typeError } from '../../shared/errors.js';
import { ConvexHullVolume, hullBoundsInto, hullCornerInto, setHullTriangle } from './hull.js';
import type { ConstraintVolume, MutableVec3View, Vec3View } from './types.js';
import { validateVector } from './types.js';

const IDENTITY = /* @__PURE__ */ Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A rotation, a uniform scale and a move, with its inverse. */
class Placement {
  readonly forward = new Float64Array(12);
  readonly inverse = new Float64Array(12);
  scale = 1;

  set(matrix: ArrayLike<number>): void {
    if (!matrix || matrix.length !== 16) throw typeError('A volume matrix must have 16 values', 'kinematics');
    for (let i = 0; i < 16; i++)
      if (!Number.isFinite(matrix[i])) throw rangeError('A volume matrix must be finite', 'kinematics');
    if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
      throw rangeError('A volume matrix must be affine; its last row must be 0, 0, 0, 1', 'kinematics');
    const f = this.forward;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) f[c * 3 + r] = matrix[c * 4 + r];
    const sx = Math.hypot(f[0], f[1], f[2]),
      sy = Math.hypot(f[3], f[4], f[5]),
      sz = Math.hypot(f[6], f[7], f[8]),
      square = Math.abs(f[0] * f[3] + f[1] * f[4] + f[2] * f[5]) + Math.abs(f[0] * f[6] + f[1] * f[7] + f[2] * f[8]) + Math.abs(f[3] * f[6] + f[4] * f[7] + f[5] * f[8]),
      handed =
        f[0] * (f[4] * f[8] - f[5] * f[7]) + f[1] * (f[5] * f[6] - f[3] * f[8]) + f[2] * (f[3] * f[7] - f[4] * f[6]);
    if (!(sx > 0) || Math.abs(sy - sx) > 1e-6 * sx || Math.abs(sz - sx) > 1e-6 * sx || square > 1e-6 * sx * sx || handed < 0)
      throw rangeError('A volume matrix must be a rotation, one uniform scale and a move: distances must survive it', 'kinematics');
    this.scale = sx;
    const inv = this.inverse,
      k = 1 / (sx * sx);
    // The inverse of s R is R^T / s, and R^T / s is the transpose over s squared.
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) inv[c * 3 + r] = f[r * 3 + c] * k;
    for (let r = 0; r < 3; r++) inv[9 + r] = -(inv[r] * f[9] + inv[3 + r] * f[10] + inv[6 + r] * f[11]);
  }

  toLocal(x: number, y: number, z: number, out: Float64Array, at: number): void {
    const m = this.inverse;
    out[at] = m[0] * x + m[3] * y + m[6] * z + m[9];
    out[at + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    out[at + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
  }

  toWorld(x: number, y: number, z: number, out: Float64Array, at: number): void {
    const m = this.forward;
    out[at] = m[0] * x + m[3] * y + m[6] * z + m[9];
    out[at + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    out[at + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
  }
}

/** A field a {@link SDFVolume} can read: `bakeSDF`'s `MeshSDF` is one, and so is any distance function. */
export interface DistanceField {
  /** Signed distance at a point in the field's own space: negative inside. */
  distance(point: ArrayLike<number>): number;
  /** Corner of a sampled grid. With `max` and `spacing`, the field is read as a trilinear grid. */
  min?: ArrayLike<number>;
  max?: ArrayLike<number>;
  /** World distance between samples, per axis. */
  spacing?: ArrayLike<number>;
}

/** Options of {@link SDFVolume}. */
export interface SDFVolumeOptions {
  field: DistanceField;
  /** Rotation, uniform scale and translation placing the field. Defaults to the identity. */
  matrix?: ArrayLike<number>;
  /**
   * Subtracted from every reading. A grid's default is one cell's diagonal, the most a trilinear reading can overstate
   * a true distance, so the volume never reads a gap the obstacle does not leave. A function's default is 0.
   */
  margin?: number;
  /** How close the smallest reading along a shape must be pinned down. Default a quarter of a cell, or 1e-3. */
  precision?: number;
  /** Fastest the field can change per unit of distance. A grid's default is the square root of 3, a function's 1. */
  lipschitz?: number;
  /** Most cells one query opens. A query that runs out still answers with a safe lower bound. Default 4,096. */
  maxCells?: number;
}

const outSurface = /* @__PURE__ */ new Float64Array(3),
  outNormal = /* @__PURE__ */ new Float64Array(3),
  outDistance = /* @__PURE__ */ new Float64Array(1);

function unitNormal(x: number, y: number, z: number, out: MutableVec3View): void {
  const size = Math.hypot(x, y, z);
  if (size > 0) {
    out[0] = x / size;
    out[1] = y / size;
    out[2] = z / size;
  } else {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
  }
}

/**
 * A signed distance field as an obstacle, for concave shapes at a fixed cost per reading: hand it `bakeSDF`'s result,
 * or any `{distance(point)}`. Every query answers a value no higher than the true gap, within the field's own bounds,
 * so a solver and a swept check stay safe. It keeps the field in its own space; move it with {@link setTransform}.
 *
 * @example
 * ```ts
 * import { SDFVolume } from 'margoengine/kinematics-constraints/sdf';
 *
 * // A ring of radius 1 and tube 0.2 about +Z, as a function.
 * const ring = new SDFVolume({
 *   field: { distance: ([x, y, z]) => Math.hypot(Math.hypot(x, y) - 1, z) - 0.2 },
 * });
 * const gap = ring.segmentClearance([0, 0, -2], [0, 0, 2], 0.1); // through the hole: 0.7
 * ```
 */
export class SDFVolume implements ConstraintVolume {
  /** Subtracted from every reading, in world units. */
  readonly margin: number;
  /** How close a shape's smallest reading is pinned down, in world units. */
  readonly precision: number;
  private readonly field: DistanceField;
  private readonly lipschitz: number;
  private readonly maxCells: number;
  private readonly placement = new Placement();
  private readonly grid: boolean;
  private readonly local = new Float64Array(3);
  private readonly stack: number[] = [];

  constructor(options: SDFVolumeOptions) {
    const field = options?.field;
    if (!field || typeof field.distance !== 'function')
      throw typeError('SDFVolume needs a field with a distance(point) method, such as bakeSDF gives', 'kinematics');
    this.field = field;
    this.grid = !!(field.min && field.max && field.spacing);
    const spacing = field.spacing;
    this.placement.set(options.matrix ?? IDENTITY);
    const s = this.placement.scale;
    const cell = spacing ? Math.hypot(spacing[0], spacing[1], spacing[2]) * s : 0,
      smallest = spacing ? Math.min(spacing[0], spacing[1], spacing[2]) * s : 0;
    this.margin = options.margin ?? (this.grid ? cell : 0);
    this.precision = options.precision ?? (this.grid ? smallest / 4 : 1e-3);
    this.lipschitz = options.lipschitz ?? (this.grid ? Math.sqrt(3) : 1);
    this.maxCells = options.maxCells ?? 4096;
    if (!(this.margin >= 0) || !Number.isFinite(this.margin)) throw rangeError('SDFVolume margin must be 0 or more', 'kinematics');
    if (!(this.precision > 0) || !Number.isFinite(this.precision)) throw rangeError('SDFVolume precision must be above 0', 'kinematics');
    if (!(this.lipschitz > 0) || !Number.isFinite(this.lipschitz)) throw rangeError('SDFVolume lipschitz must be above 0', 'kinematics');
    if (!Number.isSafeInteger(this.maxCells) || this.maxCells < 1)
      throw rangeError('SDFVolume maxCells must be a positive integer', 'kinematics');
  }

  /** Places the field: a column-major matrix of 16 values holding a rotation, one uniform scale and a move. */
  setTransform(matrix: ArrayLike<number>): this {
    this.placement.set(matrix);
    return this;
  }

  /** The reading at a world point, margin taken off. */
  private read(x: number, y: number, z: number): number {
    const { placement, local, field } = this;
    placement.toLocal(x, y, z, local, 0);
    let value: number;
    if (this.grid) {
      const min = field.min!,
        max = field.max!;
      let outside = 0;
      for (let k = 0; k < 3; k++) {
        const clamped = Math.min(Math.max(local[k], min[k]), max[k]);
        outside += (local[k] - clamped) ** 2;
        local[k] = clamped;
      }
      outside = Math.sqrt(outside);
      const inner = field.distance(local);
      // Past the grid the obstacle is at least as far as the grid is, and the field can drop no faster than the distance.
      value = outside > 0 ? Math.max(outside, inner - outside) : inner;
    } else value = field.distance(local);
    if (!Number.isFinite(value)) throw rangeError('A distance field gave no finite distance', 'kinematics');
    return value * placement.scale - this.margin;
  }

  /** Signed distance to the surface as the field sees it, less the margin, with the closest point and outward normal. */
  evaluate(point: Vec3View, outPoint: MutableVec3View, outDirection: MutableVec3View): number {
    validateVector(point, 'query point');
    const x = point[0],
      y = point[1],
      z = point[2],
      h = this.precision,
      distance = this.read(x, y, z);
    unitNormal(
      this.read(x + h, y, z) - this.read(x - h, y, z),
      this.read(x, y + h, z) - this.read(x, y - h, z),
      this.read(x, y, z + h) - this.read(x, y, z - h),
      outDirection,
    );
    outPoint[0] = x - outDirection[0] * distance;
    outPoint[1] = y - outDirection[1] * distance;
    outPoint[2] = z - outDirection[2] * distance;
    return distance;
  }

  /** Lowest reading on a segment, minus `radius`, never above the true value: branch and bound on the Lipschitz bound. */
  segmentClearance(start: Vec3View, end: Vec3View, radius: number): number {
    validateVector(start, 'segment start');
    validateVector(end, 'segment end');
    if (!(radius >= 0) || !Number.isFinite(radius)) throw rangeError('Segment radius must be 0 or more', 'kinematics');
    const ax = start[0],
      ay = start[1],
      az = start[2],
      dx = end[0] - ax,
      dy = end[1] - ay,
      dz = end[2] - az,
      slope = this.lipschitz * Math.hypot(dx, dy, dz),
      precision = this.precision,
      stack = this.stack;
    let best = Math.min(this.read(ax, ay, az), this.read(ax + dx, ay + dy, az + dz)),
      floor = Infinity,
      cells = 0;
    stack.length = 0;
    stack.push(0, 1);
    while (stack.length) {
      const high = stack.pop()!,
        low = stack.pop()!,
        middle = (low + high) / 2,
        value = this.read(ax + dx * middle, ay + dy * middle, az + dz * middle),
        bound = value - (slope * (high - low)) / 2;
      if (value < best) best = value;
      if (bound >= best - precision) continue;
      if (++cells >= this.maxCells) {
        if (bound < floor) floor = bound;
        continue;
      }
      stack.push(low, middle, middle, high);
    }
    return Math.min(best - precision, floor) - radius;
  }

  /** {@link segmentClearance} for a convex hull: branch and bound over cells of the hull's box. Writes to `out[0]`. */
  hullClearanceInto(hull: ConvexHullVolume, out: Float64Array): void {
    const box = new Float64Array(6);
    hullBoundsInto(hull, box);
    const precision = this.precision,
      lipschitz = this.lipschitz,
      stack = this.stack;
    let best = Infinity,
      floor = Infinity,
      cells = 0;
    stack.length = 0;
    stack.push(
      (box[0] + box[3]) / 2,
      (box[1] + box[4]) / 2,
      (box[2] + box[5]) / 2,
      Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2,
    );
    while (stack.length) {
      const half = stack.pop()!,
        z = stack.pop()!,
        y = stack.pop()!,
        x = stack.pop()!,
        reach = half * Math.sqrt(3),
        centre = Float64Array.of(x, y, z);
      hull.evaluateInto(centre, outSurface, outNormal, outDistance);
      if (outDistance[0] > reach) continue;
      // A point of the hull in this cell, for the best reading so far.
      const on = outDistance[0] > 0,
        value = on ? this.read(outSurface[0], outSurface[1], outSurface[2]) : this.read(x, y, z);
      if (value < best) best = value;
      const bound = (on ? this.read(x, y, z) : value) - lipschitz * reach;
      if (bound >= best - precision) continue;
      if (++cells >= this.maxCells) {
        if (bound < floor) floor = bound;
        continue;
      }
      const next = half / 2;
      for (let i = 0; i < 8; i++)
        stack.push(x + (i & 1 ? next : -next), y + (i & 2 ? next : -next), z + (i & 4 ? next : -next), next);
    }
    out[0] = Math.min(best - precision, floor);
  }
}

/** Options of {@link MeshVolume}. */
export interface MeshVolumeOptions {
  /** The obstacle's tree. Its triangles stay in the tree's own space. */
  bvh: MeshBVH;
  /** Rotation, uniform scale and translation placing the mesh. Defaults to the identity. */
  matrix?: ArrayLike<number>;
  /**
   * A closed mesh is solid: a point inside reads negative, by winding number. False treats the mesh as a thin sheet, for
   * open surfaces such as a terrain, and reads the plain distance. Default true.
   */
  solid?: boolean;
}

function boxGapSquared(
  boxMin: Float64Array,
  boxMax: Float64Array,
  queryMin: Float64Array,
  queryMax: Float64Array,
): number {
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const gap = Math.max(boxMin[k] - queryMax[k], queryMin[k] - boxMax[k], 0);
    sum += gap * gap;
  }
  return sum;
}

/**
 * A triangle mesh as an exact obstacle, concave or not: arm links, hulls and points measure against the real surface,
 * through a `MeshBVH`, so a bowl has an inside to reach into and a ring has a hole. Slower per query than a baked
 * {@link SDFVolume}, and exact, with no grid to bound.
 *
 * @example
 * ```ts
 * import { MeshBVH } from 'margoengine/bvh';
 * import { MeshVolume } from 'margoengine/kinematics-constraints/sdf';
 *
 * // One triangle in the plane z = 0; pass your own mesh's positions and indices.
 * const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
 * const bvh = MeshBVH.build({ positions, indices: new Uint32Array([0, 1, 2]) });
 * const sheet = new MeshVolume({ bvh, solid: false });
 * const gap = sheet.segmentClearance([0.5, 0.5, 1], [0.5, 0.5, 2], 0.25); // 0.75
 * ```
 */
export class MeshVolume implements ConstraintVolume {
  private readonly bvh: MeshBVH;
  private readonly solid: boolean;
  private readonly placement = new Placement();
  private readonly triangle = new ConvexHullVolume({ points: [0, 0, 0, 1, 0, 0, 0, 1, 0] });
  private readonly world = new Float64Array(9);
  private readonly local = new Float64Array(6);
  private readonly queryMin = new Float64Array(3);
  private readonly queryMax = new Float64Array(3);
  private readonly gap = new Float64Array(1);

  constructor(options: MeshVolumeOptions) {
    const bvh = options?.bvh;
    if (!bvh || typeof bvh.shapecast !== 'function') throw typeError('MeshVolume needs a MeshBVH', 'kinematics');
    this.bvh = bvh;
    this.solid = options.solid !== false;
    this.placement.set(options.matrix ?? IDENTITY);
  }

  /** Places the mesh: a column-major matrix of 16 values holding a rotation, one uniform scale and a move. */
  setTransform(matrix: ArrayLike<number>): this {
    this.placement.set(matrix);
    return this;
  }

  private inside(local: ArrayLike<number>): boolean {
    return this.solid && pointInside(this.bvh, local);
  }

  /** Signed distance to the surface, negative inside a solid mesh, with the closest point and the outward normal. */
  evaluate(point: Vec3View, outPoint: MutableVec3View, outDirection: MutableVec3View): number {
    validateVector(point, 'query point');
    const { placement, bvh, local, world } = this;
    placement.toLocal(point[0], point[1], point[2], local, 0);
    const near = bvh.closestPointToPoint(local);
    if (!near) throw rangeError('MeshVolume has no triangles', 'kinematics');
    const within = this.inside(local);
    placement.toWorld(near.point[0], near.point[1], near.point[2], world, 0);
    const distance = near.distance * placement.scale,
      x = point[0] - world[0],
      y = point[1] - world[1],
      z = point[2] - world[2];
    outPoint[0] = world[0];
    outPoint[1] = world[1];
    outPoint[2] = world[2];
    if (distance > 1e-12) unitNormal(within ? -x : x, within ? -y : y, within ? -z : z, outDirection);
    else {
      // On the surface there is no line to the point: the triangle's own normal, as wound, from its corners in the world.
      const { positions, stride, index, triangles } = bvh,
        slot = triangles.indexOf(near.faceIndex) * 3;
      for (let i = 0; i < 3; i++) {
        const at = index[slot + i] * stride;
        placement.toWorld(positions[at], positions[at + 1], positions[at + 2], world, i * 3);
      }
      for (let k = 0; k < 3; k++) {
        world[3 + k] -= world[k];
        world[6 + k] -= world[k];
      }
      unitNormal(
        world[4] * world[8] - world[5] * world[7],
        world[5] * world[6] - world[3] * world[8],
        world[3] * world[7] - world[4] * world[6],
        outDirection,
      );
    }
    return within ? -distance : distance;
  }

  /** Signed gap to a capsule round a segment. A segment that crosses the surface reads minus its radius. */
  segmentClearance(start: Vec3View, end: Vec3View, radius: number): number {
    validateVector(start, 'segment start');
    validateVector(end, 'segment end');
    if (!(radius >= 0) || !Number.isFinite(radius)) throw rangeError('Segment radius must be 0 or more', 'kinematics');
    const { placement, local, queryMin, queryMax, triangle, gap } = this;
    placement.toLocal(start[0], start[1], start[2], local, 0);
    placement.toLocal(end[0], end[1], end[2], local, 3);
    for (let k = 0; k < 3; k++) {
      queryMin[k] = Math.min(local[k], local[3 + k]);
      queryMax[k] = Math.max(local[k], local[3 + k]);
    }
    const a = local.subarray(0, 3),
      b = local.subarray(3, 6);
    let best = Infinity;
    const lower = (box: { min: Float64Array; max: Float64Array }): number =>
      Math.sqrt(boxGapSquared(box.min, box.max, queryMin, queryMax));
    this.bvh.shapecast({
      boundsTraverseOrder: lower,
      intersectsBounds: (box, _leaf, score) => (score ?? lower(box)) < best,
      intersectsTriangle: (t) => {
        setHullTriangle(triangle, t.a, t.b, t.c);
        triangle.segmentClearanceInto(a, b, 0, gap);
        if (gap[0] < best) best = gap[0];
        return best <= 0;
      },
    });
    if (best > 0) {
      if (this.inside(a)) return -best * placement.scale - radius;
      return best * placement.scale - radius;
    }
    return -radius;
  }

  /** Signed gap to a convex hull at its current transform, written to `out[0]`. */
  hullClearanceInto(hull: ConvexHullVolume, out: Float64Array): void {
    const { placement, local, queryMin, queryMax, triangle, gap, world } = this,
      box = new Float64Array(6);
    hullBoundsInto(hull, box);
    queryMin.fill(Infinity);
    queryMax.fill(-Infinity);
    for (let i = 0; i < 8; i++) {
      placement.toLocal(box[i & 1 ? 3 : 0], box[i & 2 ? 4 : 1], box[i & 4 ? 5 : 2], local, 0);
      for (let k = 0; k < 3; k++) {
        queryMin[k] = Math.min(queryMin[k], local[k]);
        queryMax[k] = Math.max(queryMax[k], local[k]);
      }
    }
    const scale = placement.scale;
    let best = Infinity;
    const lower = (node: { min: Float64Array; max: Float64Array }): number =>
      Math.sqrt(boxGapSquared(node.min, node.max, queryMin, queryMax)) * scale;
    this.bvh.shapecast({
      boundsTraverseOrder: lower,
      intersectsBounds: (node, _leaf, score) => (score ?? lower(node)) < best,
      intersectsTriangle: (t) => {
        placement.toWorld(t.a[0], t.a[1], t.a[2], world, 0);
        placement.toWorld(t.b[0], t.b[1], t.b[2], world, 3);
        placement.toWorld(t.c[0], t.c[1], t.c[2], world, 6);
        setHullTriangle(triangle, world.subarray(0, 3), world.subarray(3, 6), world.subarray(6, 9));
        triangle.hullClearanceInto(hull, gap);
        if (gap[0] < best) best = gap[0];
        return best <= 0;
      },
    });
    if (best > 0 && this.solid) {
      hullCornerInto(hull, local);
      placement.toLocal(local[0], local[1], local[2], local, 3);
      if (this.inside(local.subarray(3, 6))) best = -best;
    }
    out[0] = best;
  }
}
