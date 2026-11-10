/// <reference lib="esnext.disposable" preserve="true" />
// Level-of-detail octrees for clouds too big to draw at once: `buildOctree` splits a cloud into a nested-sample octree
// (every node holds an even sample of its cube on a grid, its children hold the rest), and `OctreeCloud` draws the
// nodes the camera needs, largest on screen first, under a point budget, loading them from any `OctreeSource` (the
// built octree, or your own streamed one) and evicting the least recently used past a memory budget. The octree is
// additive: a parent's points stay drawn under its children, so detail only ever adds and nothing leaves a hole.
import type { EngineKernel, EnginePlugin, Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { PointCloud, type PointCloudOptions } from './cloud.js';
import { PointsMaterial, type PointsMaterialOptions } from './material.js';

/** One node: a cube, how many points it holds and its eight child slots. */
export interface OctreeNode {
  /** 'r' for the root, then one octant digit (0 to 7) per level: x is bit 0, y bit 1, z bit 2. */
  readonly id: string;
  readonly level: number;
  /** minX, minY, minZ, maxX, maxY, maxZ. */
  readonly bounds: Float64Array;
  /** Grid cell size of this node's sample (points are at least about this far apart). */
  readonly spacing: number;
  readonly count: number;
  readonly parent: OctreeNode | null;
  readonly children: readonly (OctreeNode | null)[];
}

/** A node's points, as `PointCloud` takes them. */
export interface OctreeNodeData {
  positions: Float32Array;
  colors?: Uint8Array | Float32Array | null;
  colorComponents?: 3 | 4;
  /** Point-major scalar or vector attributes, preserved in source point order. */
  attributes?: Readonly<Record<string, PointAttribute>>;
  /** Stable source rows, when supplied by an in-memory source. Otherwise use node id and point index. */
  rowIds?: ArrayLike<string | number>;
}

/** Numeric columns supported by octree sources. */
export type PointAttribute =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/** Where nodes come from: their hierarchy up front, their points on demand. */
export interface OctreeSource {
  readonly root: OctreeNode;
  /** Loads one node's points; honour `signal`. */
  load(node: OctreeNode, signal: AbortSignal): OctreeNodeData | Promise<OctreeNodeData>;
}

/** Options of `buildOctree`. */
export interface OctreeOptions {
  /** A node with this many points or fewer is a leaf. Default 20,000. */
  maxPointsPerNode?: number;
  /** Sample grid cells per axis of each node. Default 128. */
  grid?: number;
  /** Deepest level. Default 16. */
  maxDepth?: number;
  /** Shuffle seed (the sample of a node is the first point per grid cell in shuffled order). Default 1. */
  seed?: number;
}

/** An octree built in memory; it is its own `OctreeSource`. */
export class MemoryOctree implements OctreeSource {
  readonly root: OctreeNode;
  /** Point indices of each node into the source arrays. */
  readonly indices: ReadonlyMap<OctreeNode, Uint32Array>;
  constructor(
    root: OctreeNode,
    indices: Map<OctreeNode, Uint32Array>,
    private readonly positions: ArrayLike<number>,
    private readonly colors?: ArrayLike<number> | null,
    private readonly colorComponents: 3 | 4 = 3,
    private readonly attributes: Readonly<Record<string, PointAttribute>> = {},
    private readonly rowIds?: ArrayLike<string | number>,
  ) {
    this.root = root;
    this.indices = indices;
  }
  /** Every node, parents first. */
  *nodes(): IterableIterator<OctreeNode> {
    const queue: OctreeNode[] = [this.root];
    for (let i = 0; i < queue.length; i++) {
      yield queue[i];
      for (const child of queue[i].children) if (child) queue.push(child);
    }
  }
  load(node: OctreeNode): OctreeNodeData {
    const index = this.indices.get(node);
    if (!index)
      throw new TypeError(`Node ${node.id} is not part of this octree; pass a node reached from this octree's root`);
    const positions = new Float32Array(index.length * 3),
      c = this.colorComponents,
      colors = this.colors
        ? this.colors instanceof Float32Array
          ? new Float32Array(index.length * c)
          : new Uint8Array(index.length * c)
        : null;
    for (let i = 0; i < index.length; i++) {
      const p = index[i];
      positions[i * 3] = this.positions[p * 3];
      positions[i * 3 + 1] = this.positions[p * 3 + 1];
      positions[i * 3 + 2] = this.positions[p * 3 + 2];
      if (colors) for (let k = 0; k < c; k++) colors[i * c + k] = this.colors![p * c + k];
    }
    const attributes: Record<string, PointAttribute> = {};
    for (const [name, values] of Object.entries(this.attributes)) {
      const components = values.length / (this.positions.length / 3);
      const out = new (values.constructor as new (n: number) => PointAttribute)(index.length * components);
      for (let i = 0; i < index.length; i++)
        for (let k = 0; k < components; k++) out[i * components + k] = values[index[i] * components + k];
      attributes[name] = out;
    }
    const rowIds = this.rowIds ? Array.from(index, (i) => this.rowIds![i]) : index;
    return { positions, colors, colorComponents: colors ? c : undefined, attributes, rowIds };
  }
}

interface MutableNode extends OctreeNode {
  children: (OctreeNode | null)[];
}

/**
 * Builds a nested-sample octree over a cloud (positions xyz, optional colours with 3 or 4 components). Each node keeps
 * the first point per grid cell of its cube (in a seeded shuffle, so the sample is even and random), and passes the
 * rest to its octants. Every point lands in exactly one node.
 */
export function buildOctree(
  cloud: {
    positions: ArrayLike<number>;
    colors?: ArrayLike<number> | null;
    colorComponents?: 3 | 4;
    attributes?: Readonly<Record<string, PointAttribute>>;
    rowIds?: ArrayLike<string | number>;
  },
  options: OctreeOptions = {},
): MemoryOctree {
  const { positions } = cloud,
    n = positions.length / 3,
    maxPoints = options.maxPointsPerNode ?? 20_000,
    grid = options.grid ?? 128,
    maxDepth = options.maxDepth ?? 16;
  if (!Number.isInteger(n)) throw new RangeError('positions length must be a multiple of 3');
  for (const [name, values] of Object.entries(cloud.attributes ?? {}))
    if (n ? !Number.isInteger(values.length / n) || values.length < n : values.length !== 0)
      throw new RangeError(`Attribute ${name} must have a whole number of components per point`);
  if (cloud.rowIds && cloud.rowIds.length !== n) throw new RangeError('rowIds must have one key per point');
  if (!(maxPoints >= 1)) throw new RangeError('Invalid maxPointsPerNode; pass a number of 1 or more');
  if (!Number.isInteger(grid) || grid < 1 || grid > 1024)
    throw new RangeError('Invalid grid; pass a whole number from 1 to 1024');
  const components = cloud.colorComponents ?? (cloud.colors && n ? ((cloud.colors.length / n) as 3 | 4) : 3);
  if (cloud.colors && components !== 3 && components !== 4)
    throw new RangeError('colors must have 3 or 4 components per point');
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    const v = positions[i];
    if (!Number.isFinite(v))
      throw new RangeError(`Point ${Math.floor(i / 3)} is not finite; remove or fix it before building`);
    if (v < lo[i % 3]) lo[i % 3] = v;
    if (v > hi[i % 3]) hi[i % 3] = v;
  }
  if (!n) lo.fill(0), hi.fill(0);
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  // Seeded shuffle (mulberry32) of the point order.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  let state = (options.seed ?? 1) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)),
      t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const indices = new Map<OctreeNode, Uint32Array>(),
    stamps = new Uint32Array(grid * grid * grid);
  let serial = 0;
  const make = (
    id: string,
    level: number,
    min: number[],
    s: number,
    count: number,
    parent: OctreeNode | null,
  ): MutableNode => ({
    id,
    level,
    bounds: Float64Array.of(min[0], min[1], min[2], min[0] + s, min[1] + s, min[2] + s),
    spacing: s / grid,
    count,
    parent,
    children: [null, null, null, null, null, null, null, null],
  });
  const root = make('r', 0, lo, size, 0, null);
  const stack: { node: MutableNode; points: Uint32Array }[] = [{ node: root, points: order }];
  while (stack.length) {
    const { node, points } = stack.pop()!,
      b = node.bounds,
      s = b[3] - b[0];
    if (points.length <= maxPoints || node.level >= maxDepth) {
      indices.set(node, points);
      (node as { count: number }).count = points.length;
      continue;
    }
    serial++;
    const keep: number[] = [],
      rest: number[][] = [[], [], [], [], [], [], [], []],
      cx = b[0] + s / 2,
      cy = b[1] + s / 2,
      cz = b[2] + s / 2,
      scale = grid / s;
    for (let k = 0; k < points.length; k++) {
      const p = points[k],
        x = positions[p * 3],
        y = positions[p * 3 + 1],
        z = positions[p * 3 + 2];
      const gx = Math.min(grid - 1, Math.floor((x - b[0]) * scale)),
        gy = Math.min(grid - 1, Math.floor((y - b[1]) * scale)),
        gz = Math.min(grid - 1, Math.floor((z - b[2]) * scale)),
        cell = (gz * grid + gy) * grid + gx;
      if (stamps[cell] !== serial) {
        stamps[cell] = serial;
        keep.push(p);
      } else rest[(x >= cx ? 1 : 0) | (y >= cy ? 2 : 0) | (z >= cz ? 4 : 0)].push(p);
    }
    indices.set(node, Uint32Array.from(keep));
    (node as { count: number }).count = keep.length;
    for (let o = 0; o < 8; o++) {
      if (!rest[o].length) continue;
      const half = s / 2,
        min = [b[0] + (o & 1 ? half : 0), b[1] + (o & 2 ? half : 0), b[2] + (o & 4 ? half : 0)],
        child = make(node.id + o, node.level + 1, min, half, 0, node);
      node.children[o] = child;
      stack.push({ node: child, points: Uint32Array.from(rest[o]) });
    }
  }
  return new MemoryOctree(root, indices, positions, cloud.colors, components as 3 | 4, cloud.attributes, cloud.rowIds);
}

/** The camera in world coordinates, for `OctreeCloud.select`. */
export interface OctreeView {
  readonly position: ArrayLike<number>;
  /** 24 numbers, 6 planes (a x + b y + c z + d >= 0 inside); omit to keep every node. */
  readonly planes?: ArrayLike<number>;
  readonly screenHeight: number;
  /** Vertical field of view, degrees. Default 60. */
  readonly fov?: number;
}

/** Options of `OctreeCloud`. */
export interface OctreeCloudOptions {
  /** Most points drawn per frame. Default 2,000,000. */
  pointBudget?: number;
  /** Refine a node while its bounding sphere spans more than this many pixels. Default 150. */
  minNodePixels?: number;
  /** Points kept loaded (drawn or not); least recently used nodes past it are freed. Default 3 x pointBudget. */
  maxLoadedPoints?: number;
  /** Nodes loading at once. Default 4. */
  maxConcurrentLoads?: number;
  /** Material shared by every node's cloud. */
  material?: PointsMaterial | PointsMaterialOptions;
  /**
   * Grows each point to fill the gaps of the nodes drawn around it, so a subsampled part of a scan looks solid. The
   * material then measures in world units with `size` 1 and takes its size from each point; the size it had stays the
   * smallest a point draws, and `maxPixelSize` the largest. Under a transform `size` follows its longest axis, and a
   * world size counts in the cloud's own units. Default false.
   */
  adaptiveSize?: boolean | OctreeAdaptiveSize;
  /** Other `PointCloud` options for every node (colour space, block size). */
  cloud?: Omit<PointCloudOptions, 'positions' | 'colors' | 'colorComponents' | 'material'>;
}

/** Options of `OctreeCloudOptions.adaptiveSize`. */
export interface OctreeAdaptiveSize {
  /** Point diameter as a multiple of the spacing around it; 1 only just touches on a perfect grid. Default 1.5. */
  scale?: number;
}

/** The part of `PointsPlugin` an `OctreeCloud` uses. */
export interface OctreePointsHost {
  add<T extends PointCloud>(cloud: T): T;
  remove(cloud: unknown): void;
}

interface Loaded {
  cloud?: PointCloud;
  controller?: AbortController;
  used: number;
  points: number;
  /** The drawn nodes under this one when its point sizes were last written. */
  shape?: string;
}

/** Point sizes rewritten per selection at most, so a jump of the camera spreads over a few frames. */
const SIZED_PER_SELECT = 500_000;

/** Points per square unit of a node's sample: its grid spacing, or wider when it holds fewer points than the grid. */
function nodeDensity(node: OctreeNode): number {
  const spacing = Math.max(node.spacing, (node.bounds[3] - node.bounds[0]) / Math.sqrt(Math.max(node.count, 1)));
  return 1 / (spacing * spacing);
}
/** The density of a node and every parent, all of which are drawn with it: refinement is additive. */
function chainDensity(node: OctreeNode): number {
  let density = 0;
  for (let n: OctreeNode | null = node; n; n = n.parent) density += nodeDensity(n);
  return density;
}
const sameNodes = (a: readonly OctreeNode[], b: readonly OctreeNode[]) =>
  a.length === b.length && a.every((node, i) => node === b[i]);

let count = 0;

/** Draws an octree under a point budget; attach it to the engine (it updates every frame) or call `select` yourself. */
export class OctreeCloud implements EnginePlugin {
  readonly name: string;
  readonly source: OctreeSource;
  /** The material every node draws with. */
  readonly material: PointsMaterial;
  /** Column-major model matrix of the whole octree, used when it is not attached to a mesh. Write to it freely. */
  readonly matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  pointBudget: number;
  minNodePixels: number;
  maxLoadedPoints: number;
  /** Nodes drawn in the last selection, largest on screen first. */
  visible: OctreeNode[] = [];
  /** Points drawn in the last selection, and points loaded. */
  stats = { drawn: 0, loaded: 0, loading: 0, failed: 0 };
  disposed = false;
  private engine?: EngineKernel;
  private mesh: Mesh | null = null;
  private readonly localPlanes = new Float64Array(24);
  private frame = 0;
  private readonly loaded = new Map<OctreeNode, Loaded>();
  private readonly failed = new Set<OctreeNode>();
  private readonly maxConcurrent: number;
  private readonly sizeScale: number = 0;
  /** Smallest world diameter of a point under `adaptiveSize`. */
  private readonly sizeFloor: number = 0;
  private sizesPending = false;
  private readonly cloudOptions: OctreeCloudOptions['cloud'];
  private errorListener?: (node: OctreeNode, error: unknown) => void;

  /** Same as `engine.use(new OctreeCloud(points, source, options))`. */
  static attach(
    engine: EngineKernel,
    points: OctreePointsHost,
    source: OctreeSource,
    options?: OctreeCloudOptions,
  ): OctreeCloud {
    const cloud = new OctreeCloud(points, source, options);
    engine.use(cloud);
    return cloud;
  }
  constructor(
    private readonly points: OctreePointsHost,
    source: OctreeSource,
    options: OctreeCloudOptions = {},
  ) {
    this.name = `octree-cloud-${++count}`;
    this.source = source;
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.minNodePixels = options.minNodePixels ?? 150;
    this.maxLoadedPoints = options.maxLoadedPoints ?? this.pointBudget * 3;
    this.maxConcurrent = options.maxConcurrentLoads ?? 4;
    if (!(this.pointBudget > 0) || !(this.minNodePixels > 0) || !(this.maxLoadedPoints > 0))
      throw new RangeError(
        'Invalid OctreeCloud option; pointBudget, minNodePixels and maxLoadedPoints must be above 0',
      );
    const material =
      options.material instanceof PointsMaterial ? options.material : new PointsMaterial(options.material);
    this.material = material;
    this.cloudOptions = options.cloud;
    if (options.adaptiveSize) {
      const scale = options.adaptiveSize === true ? 1.5 : (options.adaptiveSize.scale ?? 1.5);
      if (!(scale > 0) || !Number.isFinite(scale))
        throw new RangeError('Invalid adaptiveSize.scale; pass a finite number above 0');
      this.sizeScale = scale;
      if (material.sizeUnits === 'world') this.sizeFloor = material.size;
      else material.minPixelSize = Math.min(Math.max(material.minPixelSize, material.size), material.maxPixelSize);
      material.sizeUnits = 'world';
      material.size = 1;
    }
  }
  setup(engine: EngineKernel): void {
    this.engine = engine;
  }
  /** The mesh whose world matrix the octree follows, or null. */
  get attachedMesh(): Mesh | null {
    return this.mesh;
  }
  /**
   * Follows a core mesh's world matrix and its visibility, so a scan can be placed, rotated and animated in the scene;
   * pass null to use `matrix` again. A hidden mesh hides the octree and stops its loading.
   */
  attach(mesh: Mesh | null): this {
    this.mesh = mesh;
    for (const entry of this.loaded.values()) entry.cloud?.attach(mesh);
    return this;
  }
  /** Called with the node and error when a node fails to load (it is then skipped until `retry()`). */
  onError(listener: (node: OctreeNode, error: unknown) => void): void {
    this.errorListener = listener;
  }
  /** Forgets failed nodes so they load again. */
  retry(): void {
    this.failed.clear();
    this.stats.failed = 0;
  }
  onPreUpdate(): void {
    const engine = this.engine;
    if (!engine || this.disposed) return;
    this.select({
      position: engine.camera.position,
      planes: engine.camera.planes,
      screenHeight: engine.canvas.height || 1,
      fov: engine.camera.fov,
    });
  }

  /** Chooses, shows and loads the nodes for a view; returns the nodes drawn. */
  select(view: OctreeView): OctreeNode[] {
    if (this.disposed) throw new MargoError('disposed', 'OctreeCloud is disposed; create a new one');
    const m = this.mesh && this.engine ? meshWorldMatrix(this.engine, this.mesh) : this.matrix;
    if (!m) return this.visible;
    this.frame++;
    // The longest axis of the transform: a node's sphere stays inside this radius under it.
    const stretch = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
    if (this.sizeScale) this.material.size = stretch;
    const k = view.screenHeight / (2 * Math.tan(((view.fov ?? 60) * Math.PI) / 180 / 2)),
      p = view.position,
      pl = view.planes && this.planesInCloud(view.planes, m);
    const size = (node: OctreeNode) => {
      const b = node.bounds,
        r = (Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2) * stretch,
        x = (b[0] + b[3]) / 2,
        y = (b[1] + b[4]) / 2,
        z = (b[2] + b[5]) / 2,
        d = Math.hypot(
          m[0] * x + m[4] * y + m[8] * z + m[12] - p[0],
          m[1] * x + m[5] * y + m[9] * z + m[13] - p[1],
          m[2] * x + m[6] * y + m[10] * z + m[14] - p[2],
        );
      return d <= r ? Infinity : (r * k) / (d - r);
    };
    const inside = (node: OctreeNode) => {
      if (!pl) return true;
      const b = node.bounds;
      for (let i = 0; i < 6; i++) {
        const a = pl[i * 4],
          bb = pl[i * 4 + 1],
          c = pl[i * 4 + 2],
          d = pl[i * 4 + 3];
        // The box corner furthest along the plane normal.
        if (a * (a >= 0 ? b[3] : b[0]) + bb * (bb >= 0 ? b[4] : b[1]) + c * (c >= 0 ? b[5] : b[2]) + d < 0)
          return false;
      }
      return true;
    };
    const chosen: OctreeNode[] = [],
      wanted: { node: OctreeNode; size: number }[] = [];
    const heap: { node: OctreeNode; size: number }[] = [{ node: this.source.root, size: size(this.source.root) }];
    let drawn = 0;
    while (heap.length) {
      // Largest on screen first (a short list: a linear pick keeps this simple and fast enough).
      let best = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i].size > heap[best].size) best = i;
      const { node, size: s } = heap[best];
      heap[best] = heap[heap.length - 1];
      heap.pop();
      if (!inside(node) || this.failed.has(node)) continue;
      if (drawn + node.count > this.pointBudget) break;
      const entry = this.loaded.get(node);
      if (!entry?.cloud) {
        wanted.push({ node, size: s });
        continue; // children wait for their parent (it carries the coarse sample they add to)
      }
      entry.used = this.frame;
      chosen.push(node);
      drawn += node.count;
      if (s > this.minNodePixels)
        for (const child of node.children) if (child) heap.push({ node: child, size: size(child) });
    }
    const shown = new Set(chosen);
    for (const [node, entry] of this.loaded) if (entry.cloud) entry.cloud.visible = shown.has(node);
    if (this.sizeScale && (this.sizesPending || !sameNodes(chosen, this.visible))) this.fitSizes(chosen, shown);
    this.visible = chosen;
    this.stats.drawn = drawn;
    this.request(wanted);
    this.evict();
    return chosen;
  }

  /** World planes in the cloud's own coordinates: a plane times the matrix tests the local point it maps to. */
  private planesInCloud(planes: ArrayLike<number>, m: ArrayLike<number>): Float64Array {
    const out = this.localPlanes;
    for (let i = 0; i < 24; i += 4) {
      const a = planes[i],
        b = planes[i + 1],
        c = planes[i + 2];
      out[i] = a * m[0] + b * m[1] + c * m[2];
      out[i + 1] = a * m[4] + b * m[5] + c * m[6];
      out[i + 2] = a * m[8] + b * m[9] + c * m[10];
      out[i + 3] = a * m[12] + b * m[13] + c * m[14] + planes[i + 3];
    }
    return out;
  }

  /** Diameter in the cloud's own units of a point in a place of this many points per square unit. */
  private pointSize(density: number): number {
    return Math.max(this.sizeFloor, this.sizeScale / Math.sqrt(density));
  }

  /** Rewrites the point sizes of drawn nodes whose drawn children changed, largest on screen first. */
  private fitSizes(chosen: OctreeNode[], shown: Set<OctreeNode>): void {
    const shapes = new Map<OctreeNode, string>(),
      shape = (node: OctreeNode): string => {
        let text = '';
        for (let o = 0; o < 8; o++) {
          const child = node.children[o];
          if (child && shown.has(child)) text += `${o}(${shape(child)})`;
        }
        shapes.set(node, text);
        return text;
      };
    for (const node of chosen) if (!node.parent || !shown.has(node.parent)) shape(node);
    let room = SIZED_PER_SELECT;
    this.sizesPending = false;
    for (const node of chosen) {
      const entry = this.loaded.get(node)!,
        text = shapes.get(node)!;
      if (entry.shape === text) continue;
      if (room <= 0) {
        this.sizesPending = true;
        break;
      }
      room -= node.count;
      entry.shape = text;
      this.sizeNode(node, entry.cloud!, shown);
    }
  }

  /** Sizes each point of a drawn node by the density where it lies: this node's chain, then drawn nodes below it. */
  private sizeNode(node: OctreeNode, cloud: PointCloud, shown: Set<OctreeNode>): void {
    const { positions, sizes } = cloud,
      base = chainDensity(node);
    if (!sizes) return;
    for (let i = 0; i < cloud.count; i++) {
      const x = positions[i * 3],
        y = positions[i * 3 + 1],
        z = positions[i * 3 + 2];
      let density = base,
        at = node;
      for (;;) {
        const b = at.bounds,
          octant =
            (x >= (b[0] + b[3]) / 2 ? 1 : 0) | (y >= (b[1] + b[4]) / 2 ? 2 : 0) | (z >= (b[2] + b[5]) / 2 ? 4 : 0),
          child = at.children[octant];
        if (!child || !shown.has(child)) break;
        density += nodeDensity(child);
        at = child;
      }
      sizes[i] = this.pointSize(density);
    }
    cloud.markDirty('sizes');
  }

  private request(wanted: { node: OctreeNode; size: number }[]): void {
    // Loads no longer wanted are aborted; the largest wanted start first.
    const want = new Set(wanted.map((w) => w.node));
    for (const [node, entry] of this.loaded)
      if (!entry.cloud && entry.controller && !want.has(node)) {
        entry.controller.abort(new DOMException('Node no longer needed', 'AbortError'));
        this.loaded.delete(node);
        this.stats.loading--;
      }
    wanted.sort((a, b) => b.size - a.size);
    for (const { node } of wanted) {
      if (this.stats.loading >= this.maxConcurrent) break;
      if (this.loaded.has(node)) continue;
      const controller = new AbortController(),
        entry: Loaded = { controller, used: this.frame, points: 0 };
      this.loaded.set(node, entry);
      this.stats.loading++;
      void this.load(node, entry, controller.signal);
    }
  }

  private async load(node: OctreeNode, entry: Loaded, signal: AbortSignal): Promise<void> {
    try {
      const data = await this.source.load(node, signal);
      signal.throwIfAborted();
      if (this.disposed) return;
      const cloud = new PointCloud({
        ...this.cloudOptions,
        ...data,
        material: this.material,
        matrix: this.matrix,
        // Until the first selection that draws it, a node has no drawn children.
        sizes: this.sizeScale
          ? new Float32Array(data.positions.length / 3).fill(this.pointSize(chainDensity(node)))
          : undefined,
      });
      cloud.visible = false;
      cloud.attach(this.mesh);
      this.points.add(cloud);
      entry.cloud = cloud;
      entry.points = cloud.count;
      entry.shape = '';
      this.stats.loaded += cloud.count;
    } catch (error) {
      if (signal.aborted) return;
      this.loaded.delete(node);
      this.failed.add(node);
      this.stats.failed++;
      if (this.errorListener) this.errorListener(node, error);
      else this.engine?.onError(error);
    } finally {
      if (!signal.aborted) this.stats.loading--;
      entry.controller = undefined;
    }
  }

  private evict(): void {
    if (this.stats.loaded <= this.maxLoadedPoints) return;
    const ready = [...this.loaded].filter(([, e]) => e.cloud && e.used !== this.frame);
    // Least recently used first, deepest first among equals (children before the parents they refine).
    ready.sort(([a, x], [b, y]) => x.used - y.used || b.level - a.level);
    for (const [node, entry] of ready) {
      if (this.stats.loaded <= this.maxLoadedPoints) break;
      this.points.remove(entry.cloud);
      this.stats.loaded -= entry.points;
      this.loaded.delete(node);
    }
  }

  /** Frees every node's cloud and stops loading. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.loaded.values()) {
      entry.controller?.abort(new DOMException('OctreeCloud disposed', 'AbortError'));
      if (entry.cloud) this.points.remove(entry.cloud);
    }
    this.loaded.clear();
    const engine = this.engine;
    this.engine = undefined;
    if (engine?.hasPlugin(this.name)) engine.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
