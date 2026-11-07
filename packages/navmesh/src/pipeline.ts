// Navmesh generation from a triangle soup, in pure TypeScript. The pipeline is the textbook one for 2.5D walkable
// surfaces; each step names its source:
//  1. Voxelise into columns of solid spans: each triangle is clipped against every cell it overlaps (I. E. Sutherland
//     and G. W. Hodgman, "Reentrant polygon clipping", CACM 17, 1974) and the piece's height range becomes a span.
//  2. Filter: clearance (walkableHeight), ledges (drops beyond walkableClimb), low obstacles (steps within climb).
//  3. Erode by the agent radius with a chamfer distance transform (G. Borgefors, "Distance transformations in
//     digital images", CVGIP 34, 1986; weights 3 and 4).
//  4. Partition the walkable cells into hole-free regions with a monotone sweep: each region holds one run of cells
//     per row and consecutive runs overlap, so it is a simple polygon (monotone partitioning, de Berg et al.,
//     "Computational Geometry", ch. 3).
//  5. Trace region borders on the cell-corner lattice and simplify each border stretch with D. H. Douglas and
//     T. K. Peucker (Cartographica 10, 1973), splitting wall edges longer than maxEdgeLen. A stretch shared by two regions
//     is simplified once, in one canonical direction, so both keep the same vertices and NavMesh links them.
//  6. Triangulate each contour by ear clipping (G. H. Meisters, "Polygons have ears", AMM 82, 1975) and merge
//     triangles across diagonals into convex polygons (S. Hertel and K. Mehlhorn, "Fast triangulation of simple
//     polygons", FCT 1983).
//  7. Heights: vertices take the voxel surface height, or with detailSampleDist > 0 the original surface's height at
//     that point. Polygons merge only while planar, and while the original surface sampled every detailSampleDist
//     stays within detailSampleMaxError of the merged plane: NavMesh needs planar polygons, so uneven ground stays
//     split into smaller polygons rather than carrying a separate height function.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { NavMesh } from './index.js';

/**
 * Navmesh build settings. Units: "wu" world units, "vx" voxels (`cs` across, `ch` up). All finite and >= 0.
 * The names follow the long-standing voxel navmesh vocabulary so existing settings carry over.
 */
export interface NavigationOptions {
  /** Cell size on X and Z, wu, > 0. Default 0.2. */
  cs?: number;
  /** Cell height on Y, wu, > 0. Default 0.2. */
  ch?: number;
  /** Empty border around the voxel grid, vx. Accepted for compatibility: a single mesh only gains empty cells. Default 0. */
  borderSize?: number;
  /** Steepest walkable slope in degrees, 0 <= angle < 90. Default 60. */
  walkableSlopeAngle?: number;
  /** Minimum floor-to-ceiling clearance, vx. Default 2. */
  walkableHeight?: number;
  /** Highest ledge an agent steps up or down, vx. Default 2. */
  walkableClimb?: number;
  /** Agent radius the walkable area is eroded by, vx. Default 0.5. */
  walkableRadius?: number;
  /** Longest wall (outer border) edge of a contour, vx (0 = no limit); borders between regions are not split. Default 12. */
  maxEdgeLen?: number;
  /** Largest distance a simplified contour may stray from the cell border, vx. Default 1.3. */
  maxSimplificationError?: number;
  /** Isolated walkable islands smaller than this many cells are dropped. Default 8. */
  minRegionArea?: number;
  /** Regions smaller than this many cells merge into a neighbour where that keeps them hole-free. Default 20. */
  mergeRegionArea?: number;
  /** Most vertices per polygon, 3..6. Default 6. */
  maxVertsPerPoly?: number;
  /** Spacing of the surface samples that limit polygon merging, wu (0 = voxel heights, no sampling). Default 6. */
  detailSampleDist?: number;
  /** Largest height error between a polygon and the sampled surface, wu. Default 1. */
  detailSampleMaxError?: number;
  /** Build a spatial index for endpoint snapping (otherwise every polygon is scanned). Default true. */
  buildBvTree?: boolean;
  /**
   * Boxes carved out of the walkable area (crates, parked cars, a closed gate), world units: floor cells under a box
   * are removed before erosion, so the mesh keeps `walkableRadius` clear of them. Rebuild to move one. Default none.
   */
  obstacles?: readonly NavObstacle[];
  /**
   * Boxes of marked ground (water, a road, lava), world units: floor cells under a box take its `area` number, later
   * boxes over earlier ones, and the polygons there report it (`polygonArea`), for `route` filters. Default none.
   */
  areas?: readonly NavArea[];
}

/** An axis-aligned box carved out of the walkable area ({@link NavigationOptions.obstacles}), world units. */
export interface NavObstacle {
  /** Lowest corner [x, y, z]. */
  min: readonly [number, number, number];
  /** Highest corner [x, y, z]. */
  max: readonly [number, number, number];
}

/** A box of marked ground ({@link NavigationOptions.areas}), world units. */
export interface NavArea extends NavObstacle {
  /** Area number, 1 to 255 (0 is ground no box marks). */
  area: number;
}

const DEFAULTS: Required<NavigationOptions> = {
  cs: 0.2,
  ch: 0.2,
  borderSize: 0,
  walkableSlopeAngle: 60,
  walkableHeight: 2,
  walkableClimb: 2,
  walkableRadius: 0.5,
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
  buildBvTree: true,
  obstacles: [],
  areas: [],
};
const VOXEL_BUDGET = 16_000_000;
const FIX = 'check the geometry is walkable at these settings (cs, walkableSlopeAngle)';
/** Open space above the highest span of a column, in voxels. */
export const SKY = 1 << 30;
// Span link directions: -x, +z, +x, -z; the opposite of d is (d + 2) & 3.
const DX = [-1, 0, 1, 0],
  DZ = [0, 1, 0, -1];

/** Validated geometry and settings. */
export interface Input {
  points: Float32Array;
  triangles: Uint32Array;
  config: Required<NavigationOptions>;
  min: number[];
  max: number[];
}

/** Every argument check, in the documented order, before any build work. */
export function validate(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: unknown,
  budget = true,
): Input {
  const count = positions == null ? Number.NaN : positions.length,
    indexCount = indices == null ? Number.NaN : indices.length;
  if (
    !(count >= 9) ||
    count % 3 !== 0 ||
    count > 3_000_000 ||
    !(indexCount >= 1) ||
    indexCount % 3 !== 0 ||
    indexCount > 6_000_000
  )
    throw new RangeError(
      'Invalid navigation geometry: give xyz positions (9 to 3,000,000 numbers, a multiple of 3) and triangle indices (3 to 6,000,000, a multiple of 3)',
    );
  const points = new Float32Array(count),
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const value = Math.fround(positions[i]);
    if (!Number.isFinite(value))
      throw new RangeError(
        'Navigation positions must be finite as 32-bit floats; remove NaN, Infinity and values beyond 3.4e38',
      );
    points[i] = value;
    const axis = i % 3;
    if (value < min[axis]) min[axis] = value;
    if (value > max[axis]) max[axis] = value;
  }
  const vertices = count / 3,
    triangles = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) {
    const index = indices[i];
    if (!Number.isInteger(index) || index < 0 || index >= vertices)
      throw new RangeError(`Invalid navigation indices: each index must be an integer from 0 to ${vertices - 1}`);
    triangles[i] = index;
  }
  const given = (options ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(given))
    if (!Object.hasOwn(DEFAULTS, key))
      throw new RangeError(`Unsupported Recast config "${key}": use only the NavigationOptions keys`);
  const config = { ...DEFAULTS, ...given } as Required<NavigationOptions>;
  if (!Array.isArray(config.obstacles))
    throw new RangeError('Invalid navigation obstacles: give an array of {min: [x, y, z], max: [x, y, z]} boxes');
  if (!Array.isArray(config.areas))
    throw new RangeError('Invalid navigation areas: give an array of {min: [x, y, z], max: [x, y, z], area} boxes');
  for (const box of [...config.obstacles, ...config.areas]) {
    const corner = (v: unknown) =>
      Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));
    if (!box || !corner(box.min) || !corner(box.max) || box.min.some((c: number, i: number) => c > box.max[i]))
      throw new RangeError('Invalid navigation obstacle: give {min: [x, y, z], max: [x, y, z]} with min <= max');
  }
  for (const { area } of config.areas)
    if (!Number.isInteger(area) || area < 1 || area > 255)
      throw new RangeError('Invalid navigation area: area must be a whole number from 1 to 255');
  for (const key of Object.keys(DEFAULTS) as (keyof NavigationOptions)[]) {
    if (key === 'obstacles' || key === 'areas') continue;
    const value = config[key];
    if (
      key === 'buildBvTree'
        ? typeof value !== 'boolean'
        : typeof value !== 'number' || !Number.isFinite(value) || value < 0
    )
      throw new RangeError(`Invalid Recast config ${key}: give a finite number >= 0 (buildBvTree: a boolean)`);
  }
  if (
    config.cs <= 0 ||
    config.ch <= 0 ||
    config.walkableSlopeAngle >= 90 ||
    config.maxVertsPerPoly < 3 ||
    config.maxVertsPerPoly >= 7 ||
    (budget && Math.ceil((max[0] - min[0]) / config.cs) * Math.ceil((max[2] - min[2]) / config.cs) > VOXEL_BUDGET)
  )
    throw new RangeError(
      'Recast voxel budget or config exceeded: cs and ch must be > 0, walkableSlopeAngle < 90, maxVertsPerPoly 3 to 6, and ceil(xSize / cs) * ceil(zSize / cs) at most 16,000,000 (raise cs)',
    );
  return { points, triangles, config, min, max };
}

/** Spans of solid voxels, linked bottom-up per column. Arrays grow by doubling. */
export class Spans {
  count = 0;
  bottom = new Int32Array(1024);
  top = new Int32Array(1024);
  next = new Int32Array(1024);
  walk = new Uint8Array(1024);
  /** Voxels a walkable surface rises across one cell (its gradient), so slopes are not mistaken for ledges. */
  rise = new Uint16Array(1024);
  readonly head: Int32Array;
  constructor(columns: number) {
    this.head = new Int32Array(columns).fill(-1);
  }
  private grow(): void {
    const size = this.bottom.length * 2;
    const widen = <T extends Int32Array | Uint8Array | Uint16Array>(from: T, to: T): T => {
      to.set(from);
      return to;
    };
    this.bottom = widen(this.bottom, new Int32Array(size));
    this.top = widen(this.top, new Int32Array(size));
    this.next = widen(this.next, new Int32Array(size));
    this.walk = widen(this.walk, new Uint8Array(size));
    this.rise = widen(this.rise, new Uint16Array(size));
  }
  /** Adds a span to a column, merging overlapping or touching spans; the higher top decides walkability. */
  add(column: number, low: number, high: number, walk: number, rise: number, climb: number): void {
    let before = -1,
      at = this.head[column];
    while (at >= 0 && this.top[at] < low) {
      before = at;
      at = this.next[at];
    }
    while (at >= 0 && this.bottom[at] <= high) {
      if (this.bottom[at] < low) low = this.bottom[at];
      const otherTop = this.top[at];
      if (Math.abs(otherTop - high) <= climb) {
        // Tops within a step of each other: walkable if either is.
        if (this.walk[at]) {
          rise = walk ? Math.max(rise, this.rise[at]) : this.rise[at];
          walk = 1;
        }
      } else if (otherTop > high) {
        walk = this.walk[at];
        rise = this.rise[at];
      }
      if (otherTop > high) high = otherTop;
      at = this.next[at];
    }
    if (this.count === this.bottom.length) this.grow();
    const span = this.count++;
    this.bottom[span] = low;
    this.top[span] = high;
    this.walk[span] = walk;
    this.rise[span] = rise;
    this.next[span] = at;
    if (before >= 0) this.next[before] = span;
    else this.head[column] = span;
  }
}

/** Walkable input triangles bucketed on a coarse XZ grid, for surface height queries. */
export class Surface {
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly size: number;
  private readonly columns: number;
  private readonly rows: number;
  constructor(
    private readonly points: Float32Array,
    private readonly triangles: Uint32Array,
    walkable: readonly number[],
    private readonly ox: number,
    private readonly oz: number,
    extentX: number,
    extentZ: number,
    cs: number,
  ) {
    // At most about 256 buckets per axis, so one huge ground triangle cannot fill millions of buckets.
    this.size = Math.max(cs * 8, extentX / 256, extentZ / 256);
    this.columns = Math.floor(extentX / this.size) + 1;
    this.rows = Math.floor(extentZ / this.size) + 1;
    const counts = new Int32Array(this.columns * this.rows + 1);
    const visit = (t: number, put: (bucket: number) => void) => {
      let x0 = Infinity,
        x1 = -Infinity,
        z0 = Infinity,
        z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = triangles[3 * t + k] * 3;
        x0 = Math.min(x0, points[v]);
        x1 = Math.max(x1, points[v]);
        z0 = Math.min(z0, points[v + 2]);
        z1 = Math.max(z1, points[v + 2]);
      }
      const c1 = this.column(x1),
        r1 = this.row(z1);
      for (let r = this.row(z0); r <= r1; r++) for (let c = this.column(x0); c <= c1; c++) put(r * this.columns + c);
    };
    for (const t of walkable) visit(t, (bucket) => counts[bucket + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    this.start = counts;
    this.items = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice();
    for (const t of walkable) visit(t, (bucket) => (this.items[fill[bucket]++] = t));
  }
  private column(x: number): number {
    return Math.min(this.columns - 1, Math.max(0, Math.floor((x - this.ox) / this.size)));
  }
  private row(z: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.oz) / this.size)));
  }
  /** Height of the walkable surface at (x, z) closest to `near` and within `tolerance` of it, or NaN. */
  height(x: number, z: number, near: number, tolerance: number): number {
    const bucket = this.row(z) * this.columns + this.column(x),
      points = this.points,
      triangles = this.triangles;
    let best = Number.NaN,
      gap = tolerance;
    for (let i = this.start[bucket], end = this.start[bucket + 1]; i < end; i++) {
      const t = this.items[i],
        a = triangles[3 * t] * 3,
        b = triangles[3 * t + 1] * 3,
        c = triangles[3 * t + 2] * 3;
      const ax = points[a],
        az = points[a + 2],
        e1x = points[b] - ax,
        e1z = points[b + 2] - az,
        e2x = points[c] - ax,
        e2z = points[c + 2] - az,
        area = e1x * e2z - e1z * e2x;
      if (area === 0) continue;
      const px = x - ax,
        pz = z - az,
        u = (px * e2z - pz * e2x) / area,
        v = (e1x * pz - e1z * px) / area;
      // Barycentric slack so points on a shared triangle edge find a triangle.
      if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
      const y = points[a + 1] + u * (points[b + 1] - points[a + 1]) + v * (points[c + 1] - points[a + 1]),
        off = Math.abs(y - near);
      if (off <= gap) {
        gap = off;
        best = y;
      }
    }
    return best;
  }
}

/** Doubled signed area of the XZ triangle (a, b, c): positive when counter-clockwise. */
export const turn = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
  (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

/** Closed segment intersection on integer lattice points (touching counts). */
function crosses(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const d1 = Math.sign(turn(ax, az, bx, bz, cx, cz)),
    d2 = Math.sign(turn(ax, az, bx, bz, dx, dz)),
    d3 = Math.sign(turn(cx, cz, dx, dz, ax, az)),
    d4 = Math.sign(turn(cx, cz, dx, dz, bx, bz));
  if (d1 !== d2 && d3 !== d4) return true;
  const within = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) =>
    Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(pz, qz) <= rz && rz <= Math.max(pz, qz);
  return (
    (d1 === 0 && within(ax, az, bx, bz, cx, cz)) ||
    (d2 === 0 && within(ax, az, bx, bz, dx, dz)) ||
    (d3 === 0 && within(cx, cz, dx, dz, ax, az)) ||
    (d4 === 0 && within(cx, cz, dx, dz, bx, bz))
  );
}

/** A simple, counter-clockwise lattice polygon: no repeated points, no touching edges, no folds. */
function simple(xs: readonly number[], zs: readonly number[]): boolean {
  const n = xs.length;
  if (n < 3) return false;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n,
      k = (i + 2) % n;
    area += xs[i] * zs[j] - xs[j] * zs[i];
    if (xs[i] === xs[j] && zs[i] === zs[j]) return false;
    // Adjacent edges folding back onto each other.
    if (
      turn(xs[i], zs[i], xs[j], zs[j], xs[k], zs[k]) === 0 &&
      (xs[j] - xs[i]) * (xs[k] - xs[j]) + (zs[j] - zs[i]) * (zs[k] - zs[j]) < 0
    )
      return false;
  }
  if (area <= 0) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const i2 = (i + 1) % n,
        j2 = (j + 1) % n;
      if (crosses(xs[i], zs[i], xs[i2], zs[i2], xs[j], zs[j], xs[j2], zs[j2])) return false;
    }
  return true;
}

/** Ear clipping, taking the ear with the shortest diagonal each time; returns local index triples. */
function triangulate(xs: readonly number[], zs: readonly number[]): number[] {
  const n = xs.length,
    prev = new Int32Array(n),
    next = new Int32Array(n),
    ear = new Uint8Array(n),
    out: number[] = [];
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  const isEar = (b: number) => {
    const a = prev[b],
      c = next[b];
    if (turn(xs[a], zs[a], xs[b], zs[b], xs[c], zs[c]) <= 0) return 0;
    for (let v = next[c]; v !== a; v = next[v])
      if (
        turn(xs[a], zs[a], xs[b], zs[b], xs[v], zs[v]) >= 0 &&
        turn(xs[b], zs[b], xs[c], zs[c], xs[v], zs[v]) >= 0 &&
        turn(xs[c], zs[c], xs[a], zs[a], xs[v], zs[v]) >= 0
      )
        return 0;
    return 1;
  };
  for (let i = 0; i < n; i++) ear[i] = isEar(i);
  let left = n,
    any = 0;
  while (left > 3) {
    let best = -1,
      shortest = Infinity;
    for (let i = 0, v = any; i < left; i++, v = next[v])
      if (ear[v]) {
        const a = prev[v],
          c = next[v],
          length = (xs[c] - xs[a]) ** 2 + (zs[c] - zs[a]) ** 2;
        if (length < shortest) {
          shortest = length;
          best = v;
        }
      }
    if (best < 0) return out; // Only degenerate ears left: keep what was clipped.
    const a = prev[best],
      c = next[best];
    out.push(a, best, c);
    next[a] = c;
    prev[c] = a;
    any = a;
    left--;
    ear[a] = isEar(a);
    ear[c] = isEar(c);
  }
  const a = prev[any],
    c = next[any];
  if (turn(xs[a], zs[a], xs[any], zs[any], xs[c], zs[c]) > 0) out.push(a, any, c);
  return out;
}

/** What the pipeline returns: the mesh plus the polygon data that endpoint snapping needs. */
export interface Built {
  mesh: NavMesh;
  vertices: Vec3[];
  polygons: number[][];
  config: Required<NavigationOptions>;
  /** Voxels the steepest walkable surface rises across one cell. */
  maxRise: number;
}

type Keep = readonly [number, number, number, number];

/**
 * The voxel grid one build works on: `width` x `depth` cells starting `cx`, `cz` cells from the lattice origin
 * `ox`, `oy`, `oz`, so that a tile's cell borders are the same numbers as its neighbour's.
 */
export interface Grid {
  width: number;
  depth: number;
  ox: number;
  oy: number;
  oz: number;
  cx: number;
  cz: number;
  /**
   * Cells [x0, z0, x1, z1] (inclusive) kept after the filters and erosion, or null for all. The cells outside are
   * the tile's border: they let the filters see past the tile's edge, so the walkable area does not depend on the
   * tiling.
   */
  keep: Keep | null;
  /** Lowest span bottom in voxels: 0 for a whole level, -Infinity for a tile (a later mesh can reach below the origin). */
  floor: number;
}

/** The grid of a whole level. */
export function gridOf({ config, min, max }: Input): Grid {
  return {
    width: Math.max(1, Math.ceil((max[0] - min[0]) / config.cs)),
    depth: Math.max(1, Math.ceil((max[2] - min[2]) / config.cs)),
    ox: min[0],
    oy: min[1],
    oz: min[2],
    cx: 0,
    cz: 0,
    keep: null,
    floor: 0,
  };
}

/** Throws the `failed` error of a build that left nothing walkable. */
export function failed(reason: string): never {
  throw new MargoError('failed', `Navigation build failed: ${reason}; ${FIX}`);
}

/** Validates and builds a whole level. */
export function generate(positions: ArrayLike<number>, indices: ArrayLike<number>, options: unknown): Built {
  const input = validate(positions, indices, options),
    built = solve(input.points, input.triangles, input.config, gridOf(input));
  return typeof built === 'string' ? failed(built) : built;
}

/** Voxelises triangles and builds the polygons of `grid`; a string says why nothing is walkable there. */
export function solve(
  points: Float32Array,
  triangles: Uint32Array,
  config: Required<NavigationOptions>,
  grid: Grid,
): Built | string {
  const { spans, walkableTriangles, maxRise } = voxelise(points, triangles, config, grid);
  if (!walkableTriangles.length) return 'no triangle is flatter than walkableSlopeAngle';
  const surface =
    config.detailSampleDist > 0
      ? new Surface(
          points,
          triangles,
          walkableTriangles,
          grid.ox + grid.cx * config.cs,
          grid.oz + grid.cz * config.cs,
          grid.width * config.cs,
          grid.depth * config.cs,
          config.cs,
        )
      : null;
  return polygonise(spans, config, grid, surface, maxRise);
}

/** Step 1 of the pipeline: the solid spans of `grid`. */
function voxelise(
  points: Float32Array,
  triangles: Uint32Array,
  config: Required<NavigationOptions>,
  grid: Grid,
): { spans: Spans; walkableTriangles: number[]; maxRise: number } {
  const { width, depth, ox, oy, oz, cx, cz, floor } = grid,
    cs = config.cs,
    ch = config.ch,
    climb = config.walkableClimb;

  // 1. Voxelise. Cell ranges are half-open, so a triangle ending exactly on a cell border does not claim the next
  // cell; a clipped piece with no area only counts for (near-)vertical triangles, which are walls.
  const spans = new Spans(width * depth),
    cosSlope = Math.cos((config.walkableSlopeAngle * Math.PI) / 180),
    walkableTriangles: number[] = [],
    buffers = [0, 1, 2, 3].map(() => new Float64Array(3 * 12));
  let maxRise = 0;
  const clip = (from: Float64Array, n: number, to: Float64Array, axis: number, bound: number, sign: number) => {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n,
        di = sign * (from[3 * i + axis] - bound),
        dj = sign * (from[3 * j + axis] - bound);
      if (di >= 0) {
        to[3 * m] = from[3 * i];
        to[3 * m + 1] = from[3 * i + 1];
        to[3 * m + 2] = from[3 * i + 2];
        m++;
      }
      if (di >= 0 !== dj >= 0) {
        const t = di / (di - dj);
        for (let k = 0; k < 3; k++) to[3 * m + k] = from[3 * i + k] + t * (from[3 * j + k] - from[3 * i + k]);
        m++;
      }
    }
    return m;
  };
  const [corners, slab, strip, piece] = buffers;
  for (let t = 0; t < triangles.length / 3; t++) {
    const a = triangles[3 * t] * 3,
      b = triangles[3 * t + 1] * 3,
      c = triangles[3 * t + 2] * 3;
    const ux = points[b] - points[a],
      uy = points[b + 1] - points[a + 1],
      uz = points[b + 2] - points[a + 2],
      vx = points[c] - points[a],
      vy = points[c + 1] - points[a + 1],
      vz = points[c + 2] - points[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) continue;
    // Two-sided: the normal taken pointing up decides the slope.
    const up = Math.abs(ny) / length,
      walk = up > cosSlope ? 1 : 0,
      rise = walk ? Math.min(65535, Math.ceil((cs * Math.hypot(nx, nz)) / Math.abs(ny) / ch - 1e-9)) : 0,
      wall = up < 1e-3;
    if (walk) {
      walkableTriangles.push(t);
      if (rise > maxRise) maxRise = rise;
    }
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = triangles[3 * t + k] * 3;
      corners[3 * k] = points[v];
      corners[3 * k + 1] = points[v + 1];
      corners[3 * k + 2] = points[v + 2];
      x0 = Math.min(x0, points[v]);
      x1 = Math.max(x1, points[v]);
      z0 = Math.min(z0, points[v + 2]);
      z1 = Math.max(z1, points[v + 2]);
    }
    // A triangle wholly outside a tile's grid has no cell there; a whole level's grid holds every triangle.
    if (grid.keep && (Math.ceil((x1 - ox) / cs) - cx <= 0 || Math.floor((x0 - ox) / cs) - cx >= width)) continue;
    if (grid.keep && (Math.ceil((z1 - oz) / cs) - cz <= 0 || Math.floor((z0 - oz) / cs) - cz >= depth)) continue;
    const cx0 = Math.min(width - 1, Math.max(0, Math.floor((x0 - ox) / cs) - cx)),
      cx1 = Math.min(width - 1, Math.max(cx0, Math.ceil((x1 - ox) / cs) - 1 - cx)),
      cz0 = Math.min(depth - 1, Math.max(0, Math.floor((z0 - oz) / cs) - cz)),
      cz1 = Math.min(depth - 1, Math.max(cz0, Math.ceil((z1 - oz) / cs) - 1 - cz));
    for (let z = cz0; z <= cz1; z++) {
      const rows = clip(slab, clip(corners, 3, slab, 2, oz + (cz + z) * cs, 1), strip, 2, oz + (cz + z + 1) * cs, -1);
      if (!rows) continue;
      for (let x = cx0; x <= cx1; x++) {
        const m = clip(slab, clip(strip, rows, slab, 0, ox + (cx + x) * cs, 1), piece, 0, ox + (cx + x + 1) * cs, -1);
        if (!m) continue;
        let low = Infinity,
          high = -Infinity,
          area = 0;
        for (let i = 0; i < m; i++) {
          const y = piece[3 * i + 1],
            j = (i + 1) % m;
          if (y < low) low = y;
          if (y > high) high = y;
          area += piece[3 * i] * piece[3 * j + 2] - piece[3 * j] * piece[3 * i + 2];
        }
        if (!wall && Math.abs(area) <= 1e-9 * cs * cs) continue;
        const bottom = Math.max(floor, Math.floor((low - oy) / ch)),
          top = Math.max(bottom + 1, Math.floor((high - oy) / ch) + 1);
        spans.add(z * width + x, bottom, top, walk, rise, climb);
      }
    }
  }
  return { spans, walkableTriangles, maxRise };
}

/** Steps 2 to 7 of the pipeline on solid spans; a string says why nothing is walkable. */
export function polygonise(
  spans: Spans,
  config: Required<NavigationOptions>,
  grid: Grid,
  surface: Surface | null,
  maxRise: number,
): Built | string {
  const { width, depth, ox, oy, oz, cx, cz } = grid,
    cs = config.cs,
    ch = config.ch,
    climb = config.walkableClimb,
    clearance = config.walkableHeight,
    nvp = Math.floor(config.maxVertsPerPoly);
  // Live spans (merged-away records stay in the arrays but are unlinked) and their cells.
  const total = spans.count,
    { bottom, top, next, walk, rise, head } = spans,
    spanX = new Int32Array(total),
    spanZ = new Int32Array(total);
  for (let z = 0; z < depth; z++)
    for (let x = 0; x < width; x++)
      for (let s = head[z * width + x]; s >= 0; s = next[s]) {
        spanX[s] = x;
        spanZ[s] = z;
      }
  const ceiling = (s: number) => (next[s] >= 0 ? bottom[next[s]] : SKY);

  // 2. Filters. Low obstacles first (an unwalkable top within a step above a walkable one is walkable), then
  // clearance and ledges, both judged on the same state.
  for (let column = 0; column < width * depth; column++) {
    let below = 0,
      belowTop = 0,
      belowRise = 0;
    for (let s = head[column]; s >= 0; s = next[s]) {
      const was = walk[s],
        wasRise = rise[s];
      if (!was && below && top[s] - belowTop <= climb) {
        walk[s] = 1;
        rise[s] = belowRise;
      }
      below = was;
      belowTop = top[s];
      belowRise = wasRise;
    }
  }
  const open = new Uint8Array(total);
  for (let z = 0; z < depth; z++)
    for (let x = 0; x < width; x++)
      for (let s = head[z * width + x]; s >= 0; s = next[s]) {
        if (!walk[s]) continue;
        const floor = top[s],
          roof = ceiling(s);
        if (roof - floor < clearance) continue;
        let ledge = false;
        for (let d = 0; d < 4 && !ledge; d++) {
          const nx = x + DX[d],
            nz = z + DZ[d];
          if (nx < 0 || nz < 0 || nx >= width || nz >= depth) {
            ledge = true;
            break;
          }
          let n = head[nz * width + nx];
          // The open space under the neighbour's lowest span reaches down forever.
          if (Math.min(roof, n >= 0 ? bottom[n] : SKY) - floor >= clearance) ledge = true;
          for (; n >= 0 && !ledge; n = next[n]) {
            const gap = Math.min(roof, ceiling(n)) - Math.max(floor, top[n]);
            if (gap >= clearance && top[n] < floor - climb - Math.max(rise[s], rise[n])) ledge = true;
          }
        }
        if (!ledge) open[s] = 1;
      }
  // Carve obstacles: a floor cell whose centre is under a box (within a step below its bottom) is not walkable.
  for (const box of config.obstacles) {
    const x0 = Math.max(0, Math.ceil((box.min[0] - ox) / cs - 0.5) - cx),
      x1 = Math.min(width - 1, Math.floor((box.max[0] - ox) / cs - 0.5) - cx),
      z0 = Math.max(0, Math.ceil((box.min[2] - oz) / cs - 0.5) - cz),
      z1 = Math.min(depth - 1, Math.floor((box.max[2] - oz) / cs - 0.5) - cz);
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        for (let s = head[z * width + x]; s >= 0; s = next[s]) {
          const floor = oy + top[s] * ch;
          if (floor >= box.min[1] - climb * ch && floor <= box.max[1]) open[s] = 0;
        }
  }

  // Marked ground: the same reach as an obstacle, later boxes over earlier ones.
  const area = new Uint8Array(total);
  for (const box of config.areas) {
    const x0 = Math.max(0, Math.ceil((box.min[0] - ox) / cs - 0.5) - cx),
      x1 = Math.min(width - 1, Math.floor((box.max[0] - ox) / cs - 0.5) - cx),
      z0 = Math.max(0, Math.ceil((box.min[2] - oz) / cs - 0.5) - cz),
      z1 = Math.min(depth - 1, Math.floor((box.max[2] - oz) / cs - 0.5) - cz);
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        for (let s = head[z * width + x]; s >= 0; s = next[s]) {
          const floor = oy + top[s] * ch;
          if (floor >= box.min[1] - climb * ch && floor <= box.max[1]) area[s] = box.area;
        }
  }

  // Links between open spans of neighbouring cells: tops within a step (plus the slope's own rise) and room to
  // pass. Only mutual links are kept, so region borders look the same from both sides.
  const link = new Int32Array(total * 4);
  const relink = () => {
    link.fill(-1);
    for (let s = 0; s < total; s++) {
      if (!open[s]) continue;
      const x = spanX[s],
        z = spanZ[s],
        floor = top[s],
        roof = ceiling(s);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d],
          nz = z + DZ[d];
        if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
        let best = -1,
          bestStep = Infinity;
        for (let n = head[nz * width + nx]; n >= 0; n = next[n]) {
          if (!open[n]) continue;
          const step = Math.abs(top[n] - floor);
          if (
            step <= climb + Math.max(rise[s], rise[n]) &&
            Math.min(roof, ceiling(n)) - Math.max(floor, top[n]) >= clearance &&
            step < bestStep
          ) {
            best = n;
            bestStep = step;
          }
        }
        link[4 * s + d] = best;
      }
    }
    for (let s = 0; s < total; s++)
      for (let d = 0; d < 4; d++) {
        const n = link[4 * s + d];
        if (n >= 0 && link[4 * n + ((d + 2) & 3)] !== s) link[4 * s + d] = -2;
      }
    for (let i = 0; i < link.length; i++) if (link[i] === -2) link[i] = -1;
  };
  relink();

  // 3. Erosion: chamfer distance (3 per cell across, 4 diagonally) from the nearest cell an agent cannot stand on;
  // a span stays when its centre is at least `walkableRadius` cells from that cell's edge.
  if (config.walkableRadius > 0) {
    const distance = new Uint16Array(total);
    for (let s = 0; s < total; s++) {
      if (!open[s]) continue;
      let d = 0xffff;
      for (let k = 0; k < 4; k++) {
        if (link[4 * s + k] < 0) d = 3;
        const along = link[4 * s + k],
          side = (k + 1) & 3;
        if (along >= 0 && link[4 * along + side] < 0) d = Math.min(d, 4);
      }
      distance[s] = d;
    }
    const relax = (s: number, first: number, second: number) => {
      const n = link[4 * s + first];
      if (n < 0) return;
      distance[s] = Math.min(distance[s], distance[n] + 3);
      const m = link[4 * n + second];
      if (m >= 0) distance[s] = Math.min(distance[s], distance[m] + 4);
    };
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++)
        for (let s = head[z * width + x]; s >= 0; s = next[s])
          if (open[s]) {
            relax(s, 0, 3);
            relax(s, 3, 2);
          }
    for (let z = depth - 1; z >= 0; z--)
      for (let x = width - 1; x >= 0; x--)
        for (let s = head[z * width + x]; s >= 0; s = next[s])
          if (open[s]) {
            relax(s, 2, 1);
            relax(s, 1, 0);
          }
    const limit = 3 * config.walkableRadius + 1.5;
    for (let s = 0; s < total; s++) if (open[s] && distance[s] < limit) open[s] = 0;
    relink();
  }

  // Islands smaller than minRegionArea cells are dropped.
  if (config.minRegionArea > 0) {
    const island = new Int32Array(total).fill(-1),
      stack: number[] = [];
    for (let s = 0; s < total; s++) {
      if (!open[s] || island[s] >= 0) continue;
      const members: number[] = [];
      island[s] = s;
      stack.push(s);
      while (stack.length) {
        const v = stack.pop() as number;
        members.push(v);
        for (let d = 0; d < 4; d++) {
          const n = link[4 * v + d];
          if (n >= 0 && island[n] < 0) {
            island[n] = s;
            stack.push(n);
          }
        }
      }
      // Past a tile's edge an island's size is not known here, and both tiles must agree: it stays.
      const whole =
        !grid.keep ||
        members.every(
          (v) =>
            spanX[v] >= (grid.keep as Keep)[0] &&
            spanZ[v] >= (grid.keep as Keep)[1] &&
            spanX[v] <= (grid.keep as Keep)[2] &&
            spanZ[v] <= (grid.keep as Keep)[3],
        );
      if (whole && members.length < config.minRegionArea) for (const v of members) open[v] = 0;
    }
    relink();
  }

  // A tile keeps only its own cells, now that the filters have seen past its edge.
  if (grid.keep) {
    const [x0, z0, x1, z1] = grid.keep;
    for (let s = 0; s < total; s++) if (spanX[s] < x0 || spanX[s] > x1 || spanZ[s] < z0 || spanZ[s] > z1) open[s] = 0;
    relink();
  }

  // 4. Monotone regions. A run is a maximal +x chain of linked spans of one area in one row. A run continues the region
  // below when that region is the only one it touches, it is the only run touching that region, and wherever both rows
  // have a cell of the region in the same column those cells are linked (no slit inside a region). A region holds one
  // area: a neighbour of another area counts as a gap in the rows, as a wall would.
  const sameArea = (a: number, b: number) => b >= 0 && area[a] === area[b];
  const region = new Int32Array(total).fill(-1);
  interface Region {
    spans: number[];
    firstRow: number;
    lastRow: number;
    first: number[];
    last: number[];
    x0: number;
    x1: number;
    alive: boolean;
  }
  const regions: Region[] = [];
  for (let z = 0; z < depth; z++) {
    const runs: number[][] = [];
    for (let x = 0; x < width; x++)
      for (let s = head[z * width + x]; s >= 0; s = next[s]) {
        if (!open[s] || sameArea(s, link[4 * s])) continue;
        const run = [s];
        for (let v = s; sameArea(v, link[4 * v + 2]); ) run.push((v = link[4 * v + 2]));
        runs.push(run);
      }
    const touching = new Map<number, number>(),
      belowOf: number[] = [];
    for (const run of runs) {
      let only = -1;
      for (const s of run) {
        const n = link[4 * s + 3];
        if (!sameArea(s, n)) continue;
        const r = region[n];
        if (only === -1) only = r;
        else if (only !== r) only = -2;
      }
      belowOf.push(only);
      if (only >= 0) touching.set(only, (touching.get(only) ?? 0) + 1);
      else if (only === -2)
        for (const s of run) if (sameArea(s, link[4 * s + 3])) touching.set(region[link[4 * s + 3]], 2);
    }
    runs.forEach((run, i) => {
      let id = belowOf[i];
      if (id >= 0 && touching.get(id) === 1) {
        const r = regions[id];
        for (const s of run) {
          const n = link[4 * s + 3];
          if (spanX[s] >= r.x0 && spanX[s] <= r.x1 && (!sameArea(s, n) || region[n] !== id)) {
            id = -1;
            break;
          }
        }
      } else id = -1;
      if (id < 0) {
        id = regions.length;
        regions.push({ spans: [], firstRow: z, lastRow: z, first: run, last: run, x0: 0, x1: 0, alive: true });
      }
      const r = regions[id];
      for (const s of run) {
        region[s] = id;
        r.spans.push(s);
      }
      r.lastRow = z;
      r.last = run;
      r.x0 = spanX[run[0]];
      r.x1 = spanX[run[run.length - 1]];
    });
  }
  // Small regions stack onto a region that starts in the row above or ends in the row below; the result still has
  // one run per row with consecutive runs overlapping, so it stays hole-free.
  if (config.mergeRegionArea > 0) {
    const fits = (lower: number[], upper: number[], upperId: number) => {
      const u0 = spanX[upper[0]],
        u1 = spanX[upper[upper.length - 1]];
      let links = 0;
      for (const s of lower) {
        if (spanX[s] < u0 || spanX[s] > u1) continue;
        const n = link[4 * s + 1];
        if (!sameArea(s, n) || region[n] !== upperId) return 0;
        links++;
      }
      return links;
    };
    const order = regions.map((_, i) => i).sort((a, b) => regions[a].spans.length - regions[b].spans.length || a - b);
    for (const id of order) {
      const r = regions[id];
      if (!r.alive || r.spans.length >= config.mergeRegionArea) continue;
      let target = -1,
        best = 0,
        above = false;
      for (const s of r.last) {
        const n = link[4 * s + 1];
        if (!sameArea(s, n)) continue;
        const q = regions[region[n]];
        if (region[n] === id || q.firstRow !== r.lastRow + 1) continue;
        const score = fits(r.last, q.first, region[n]);
        if (score > best) {
          best = score;
          target = region[n];
          above = true;
        }
      }
      for (const s of r.first) {
        const n = link[4 * s + 3];
        if (!sameArea(s, n)) continue;
        const q = regions[region[n]];
        if (region[n] === id || q.lastRow !== r.firstRow - 1) continue;
        const score = fits(q.last, r.first, id);
        if (score > best) {
          best = score;
          target = region[n];
          above = false;
        }
      }
      if (target < 0) continue;
      const q = regions[target];
      for (const s of r.spans) {
        region[s] = target;
        q.spans.push(s);
      }
      if (above) {
        q.firstRow = r.firstRow;
        q.first = r.first;
      } else {
        q.lastRow = r.lastRow;
        q.last = r.last;
        q.x0 = r.x0;
        q.x1 = r.x1;
      }
      r.alive = false;
    }
  }

  // 5. Contours on the corner lattice. Vertices are keyed by corner and voxel height; a corner's height is the
  // highest top among the linked cells around it, so neighbouring regions agree on it.
  const corner = (cx: number, cz: number) => cx * (depth + 1) + cz,
    vertexKey = new Map<string, number>(),
    vx: number[] = [],
    vz: number[] = [],
    vh: number[] = [],
    vorder: number[] = [];
  const vertexAt = (cx: number, cz: number, h: number) => {
    const key = `${corner(cx, cz)}:${h}`;
    let id = vertexKey.get(key);
    if (id === undefined) {
      id = vx.length;
      vertexKey.set(key, id);
      vx.push(cx);
      vz.push(cz);
      vh.push(h);
      vorder.push(id);
    }
    return id;
  };
  // Lower first: corner index, then height. Decides the canonical direction of shared border stretches.
  const before = (a: number, b: number) => {
    const ca = corner(vx[a], vz[a]),
      cb = corner(vx[b], vz[b]);
    return ca !== cb ? ca < cb : vh[a] < vh[b];
  };
  const heightAt = (s: number, sideX: number, sideZ: number) => {
    let h = top[s];
    for (const [first, second] of [
      [sideX, sideZ],
      [sideZ, sideX],
    ]) {
      const n = link[4 * s + first];
      if (n < 0) continue;
      h = Math.max(h, top[n]);
      const m = link[4 * n + second];
      if (m >= 0) h = Math.max(h, top[m]);
    }
    return h;
  };
  // Edge d of cell (x, z), counter-clockwise with the cell on the left: start corner offsets per direction.
  const startX = [0, 1, 1, 0],
    startZ = [1, 1, 0, 0],
    endX = [0, 0, 1, 1],
    endZ = [0, 1, 1, 0];
  interface Border {
    ids: number[];
    neighbour: number[];
  }
  const borders = new Map<number, Border>();
  for (let id = 0; id < regions.length; id++) {
    const r = regions[id];
    if (!r.alive) continue;
    const from = new Map<number, number>(),
      edgeStart: number[] = [],
      edgeEnd: number[] = [],
      edgeNeighbour: number[] = [];
    let broken = false;
    for (const s of r.spans) {
      const x = spanX[s],
        z = spanZ[s];
      for (let d = 0; d < 4; d++) {
        const n = link[4 * s + d],
          neighbour = n >= 0 ? region[n] : -1;
        if (neighbour === id) continue;
        const sx = x + startX[d],
          sz = z + startZ[d],
          key = corner(sx, sz);
        if (from.has(key)) broken = true;
        from.set(key, edgeStart.length);
        // Height of the start corner: look across the two cell sides that meet there.
        const sideX = startX[d] ? 2 : 0,
          sideZ = startZ[d] ? 1 : 3;
        edgeStart.push(vertexAt(sx, sz, heightAt(s, sideX, sideZ)));
        edgeEnd.push(corner(x + endX[d], z + endZ[d]));
        edgeNeighbour.push(neighbour >= 0 && regions[neighbour].alive ? neighbour : -1);
      }
    }
    if (broken || !edgeStart.length) {
      r.alive = false;
      continue;
    }
    let firstEdge = 0;
    for (let e = 1; e < edgeStart.length; e++) if (before(edgeStart[e], edgeStart[firstEdge])) firstEdge = e;
    const ids: number[] = [],
      neighbour: number[] = [];
    for (let e = firstEdge, steps = 0; steps <= edgeStart.length; steps++) {
      ids.push(edgeStart[e]);
      neighbour.push(edgeNeighbour[e]);
      const following = from.get(edgeEnd[e]);
      if (following === undefined) {
        broken = true;
        break;
      }
      e = following;
      if (e === firstEdge) break;
    }
    if (broken || ids.length !== edgeStart.length) {
      r.alive = false;
      continue;
    }
    borders.set(id, { ids, neighbour });
  }

  // Simplification of one stretch (both ends kept). Exact mode only drops points on straight runs.
  const tolerance = config.maxSimplificationError,
    longest = config.maxEdgeLen;
  const simplify = (ids: number[], exact: boolean, wall: boolean): number[] => {
    const n = ids.length,
      keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    if (exact) {
      for (let i = 1; i < n - 1; i++) {
        const a = ids[i - 1],
          b = ids[i],
          c = ids[i + 1];
        if (turn(vx[a], vz[a], vx[b], vz[b], vx[c], vz[c]) !== 0) keep[i] = 1;
      }
    } else {
      const stack = [0, n - 1];
      while (stack.length) {
        const j = stack.pop() as number,
          i = stack.pop() as number,
          a = ids[i],
          b = ids[j],
          ex = vx[b] - vx[a],
          ez = vz[b] - vz[a],
          length2 = ex * ex + ez * ez;
        let far = -1,
          farthest = tolerance * tolerance;
        for (let k = i + 1; k < j; k++) {
          const p = ids[k],
            t = length2 > 0 ? Math.min(1, Math.max(0, ((vx[p] - vx[a]) * ex + (vz[p] - vz[a]) * ez) / length2)) : 0,
            gx = vx[a] + t * ex - vx[p],
            gz = vz[a] + t * ez - vz[p],
            d2 = gx * gx + gz * gz;
          if (d2 > farthest) {
            farthest = d2;
            far = k;
          }
        }
        if (far >= 0) {
          keep[far] = 1;
          stack.push(i, far, far, j);
        }
      }
    }
    if (wall && longest > 0)
      for (let changed = true; changed; ) {
        changed = false;
        for (let i = 0, j = 1; j < n; j++) {
          if (!keep[j]) continue;
          const a = ids[i],
            b = ids[j];
          if (j - i > 1 && Math.hypot(vx[b] - vx[a], vz[b] - vz[a]) > longest) {
            keep[(i + j) >> 1] = 1;
            changed = true;
          }
          i = j;
        }
      }
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(ids[i]);
    return out;
  };
  const shared = new Map<string, number[]>(),
    exactShared = new Set<string>(),
    exactWalls = new Set<number>();
  const contourOf = (id: number, keys: string[]): number[] => {
    const { ids, neighbour } = borders.get(id) as Border,
      n = ids.length,
      marks: number[] = [];
    for (let i = 0; i < n; i++) if (neighbour[(i + n - 1) % n] !== neighbour[i]) marks.push(i);
    if (!marks.length) {
      let far = 0,
        farthest = -1;
      for (let i = 0; i < n; i++) {
        const d = (vx[ids[i]] - vx[ids[0]]) ** 2 + (vz[ids[i]] - vz[ids[0]]) ** 2;
        if (d > farthest) {
          farthest = d;
          far = i;
        }
      }
      marks.push(0, far);
    }
    const contour: number[] = [];
    for (let m = 0; m < marks.length; m++) {
      const i = marks[m],
        j = marks[(m + 1) % marks.length],
        stretch: number[] = [];
      for (let k = i; ; k = (k + 1) % n) {
        stretch.push(ids[k]);
        if (k === j && stretch.length > 1) break;
      }
      const other = neighbour[i];
      let kept: number[];
      if (other >= 0) {
        const flip = before(stretch[stretch.length - 1], stretch[0]);
        if (flip) stretch.reverse();
        const key = `${Math.min(id, other)}:${Math.max(id, other)}:${stretch[0]}:${stretch[stretch.length - 1]}:${stretch.length}`;
        keys.push(key);
        const exact = exactShared.has(key);
        let cached = exact ? undefined : shared.get(key);
        if (!cached) {
          cached = simplify(stretch, exact, false);
          if (!exact) shared.set(key, cached);
        }
        kept = flip ? cached.slice().reverse() : cached;
      } else kept = simplify(stretch, exactWalls.has(id), true);
      for (let k = 0; k < kept.length - 1; k++) contour.push(kept[k]);
    }
    return contour;
  };
  const contours = new Map<number, number[]>();
  for (let round = 0; round < 8; round++) {
    contours.clear();
    let changed = false;
    const failing: number[] = [];
    for (const id of borders.keys()) {
      const keys: string[] = [],
        contour = contourOf(id, keys);
      if (
        simple(
          contour.map((v) => vx[v]),
          contour.map((v) => vz[v]),
        )
      ) {
        contours.set(id, contour);
        continue;
      }
      failing.push(id);
      if (!exactWalls.has(id)) {
        exactWalls.add(id);
        changed = true;
      }
      for (const key of keys)
        if (!exactShared.has(key)) {
          exactShared.add(key);
          changed = true;
        }
    }
    if (!changed) break;
  }
  if (!contours.size) return 'no walkable area is left after the clearance, ledge and radius filters';

  // World positions of the lattice vertices; with detail sampling, heights come from the original surface.
  const reach = (climb + maxRise + 2) * ch,
    world: Vec3[] = [];
  const position = (id: number): Vec3 => {
    let p = world[id];
    if (!p) {
      const x = ox + (cx + vx[id]) * cs,
        z = oz + (cz + vz[id]) * cs,
        voxel = oy + vh[id] * ch,
        exact = surface ? surface.height(x, z, voxel, reach) : Number.NaN;
      p = world[id] = [x, Number.isNaN(exact) ? voxel : exact, z];
    }
    return p;
  };

  // 6. Triangulate and merge into convex, planar polygons of at most maxVertsPerPoly vertices.
  const planeOf = (polygon: readonly number[]) => {
    const a = position(polygon[0]),
      b = position(polygon[1]),
      c = position(polygon[2]);
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      wx = c[0] - a[0],
      wy = c[1] - a[1],
      wz = c[2] - a[2];
    const nx = uy * wz - uz * wy,
      ny = uz * wx - ux * wz,
      nz = ux * wy - uy * wx,
      length = Math.hypot(nx, ny, nz);
    return [nx / length, ny / length, nz / length, -(nx * a[0] + ny * a[1] + nz * a[2]) / length];
  };
  const acceptable = (polygon: readonly number[]) => {
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % n],
        c = polygon[(i + 2) % n];
      if (turn(vx[a], vz[a], vx[b], vz[b], vx[c], vz[c]) <= 0) return false;
    }
    const plane = planeOf(polygon);
    for (const v of polygon) {
      const p = position(v);
      if (Math.abs(plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] + plane[3]) > 1e-5) return false;
    }
    if (!surface) return true;
    // Sample the original surface on a grid of about detailSampleDist (at most 16 x 16 samples).
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const v of polygon) {
      const p = position(v);
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[2]);
      z1 = Math.max(z1, p[2]);
    }
    const along = Math.min(16, Math.max(1, Math.ceil((x1 - x0) / config.detailSampleDist))),
      across = Math.min(16, Math.max(1, Math.ceil((z1 - z0) / config.detailSampleDist)));
    for (let i = 0; i < along; i++)
      for (let j = 0; j < across; j++) {
        const x = x0 + ((i + 0.5) * (x1 - x0)) / along,
          z = z0 + ((j + 0.5) * (z1 - z0)) / across;
        let inside = true;
        for (let k = 0; k < n && inside; k++) {
          const a = position(polygon[k]),
            b = position(polygon[(k + 1) % n]);
          if (turn(a[0], a[2], b[0], b[2], x, z) < 0) inside = false;
        }
        if (!inside) continue;
        const flat = -(plane[0] * x + plane[2] * z + plane[3]) / plane[1],
          y = surface.height(x, z, flat, reach + config.detailSampleMaxError);
        if (!Number.isNaN(y) && Math.abs(y - flat) > config.detailSampleMaxError) return false;
      }
    return true;
  };
  const polygons: number[][] = [],
    polygonAreas: number[] = [];
  for (const [id, contour] of contours) {
    const corners = triangulate(
      contour.map((v) => vx[v]),
      contour.map((v) => vz[v]),
    );
    let pieces: number[][] = [];
    for (let i = 0; i < corners.length; i += 3)
      pieces.push([contour[corners[i]], contour[corners[i + 1]], contour[corners[i + 2]]]);
    const refused = new Set<string>();
    for (let merged = true; merged && nvp > 3; ) {
      merged = false;
      const owner = new Map<string, number>(),
        candidates: [number, number, number, number, number][] = [];
      pieces.forEach((piece, p) => {
        for (let i = 0; i < piece.length; i++) {
          const a = piece[i],
            b = piece[(i + 1) % piece.length],
            reverse = owner.get(`${b}:${a}`);
          if (reverse === undefined) owner.set(`${a}:${b}`, p * 64 + i);
          else
            candidates.push([
              (vx[a] - vx[b]) ** 2 + (vz[a] - vz[b]) ** 2,
              Math.floor(reverse / 64),
              reverse % 64,
              p,
              i,
            ]);
        }
      });
      candidates.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[3] - b[3]);
      for (const [, q, j, p, i] of candidates) {
        const one = pieces[p],
          two = pieces[q];
        if (one.length + two.length - 2 > nvp) continue;
        // one has a -> b at i, two has b -> a at j: walk one from b round to a, then two past a up to b.
        const joined: number[] = [];
        for (let k = 0; k < one.length; k++) joined.push(one[(i + 1 + k) % one.length]);
        for (let k = 2; k < two.length; k++) joined.push(two[(j + k) % two.length]);
        const key = joined.join(',');
        if (refused.has(key)) continue;
        if (!acceptable(joined)) {
          refused.add(key);
          continue;
        }
        pieces = pieces.filter((_, k) => k !== p && k !== q);
        pieces.push(joined);
        merged = true;
        break;
      }
    }
    polygons.push(...pieces);
    for (let i = 0; i < pieces.length; i++) polygonAreas.push(area[regions[id].spans[0]]);
  }
  if (!polygons.length) return 'no walkable polygon could be built';
  if (polygons.length > 4096 || vx.length > 100_000)
    throw new RangeError(
      `Navigation mesh too large: ${polygons.length} polygons and ${vx.length} vertices exceed the NavMesh limits of 4096 and 100,000; raise cs or maxEdgeLen, or use @margoengine/navmesh/tiles`,
    );
  // Only vertices some polygon uses go into the mesh.
  const remap = new Int32Array(vx.length).fill(-1),
    vertices: Vec3[] = [];
  const indexed = polygons.map((polygon) =>
    polygon.map((v) => {
      if (remap[v] < 0) {
        remap[v] = vertices.length;
        vertices.push(position(v));
      }
      return remap[v];
    }),
  );
  let mesh: NavMesh;
  try {
    mesh = new NavMesh(vertices, indexed);
  } catch (error) {
    return failed(`the polygons were rejected (${(error as Error).message})`);
  }
  polygonAreas.forEach((value, p) => value && mesh.setPolygonArea(p, value));
  return { mesh, vertices, polygons: indexed, config, maxRise };
}
