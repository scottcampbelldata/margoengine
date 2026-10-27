/// <reference lib="esnext.disposable" preserve="true" />
// Level-of-detail octrees for clouds too big to draw at once: `buildOctree` splits a cloud into a nested-sample octree
// (every node holds an even sample of its cube on a grid, its children hold the rest), and `OctreeCloud` draws the
// nodes the camera needs, largest on screen first, under a point budget, loading them from any `OctreeSource` (the
// built octree, or your own streamed one) and evicting the least recently used past a memory budget. The octree is
// additive: a parent's points stay drawn under its children, so detail only ever adds and nothing leaves a hole.
import type { EngineKernel } from '@margoengine/core';
import type { EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { PointCloud, type PointCloudOptions } from './cloud.js';
import type { PointsMaterialOptions } from './material.js';

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
}

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
    return { positions, colors, colorComponents: colors ? c : undefined };
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
  cloud: { positions: ArrayLike<number>; colors?: ArrayLike<number> | null; colorComponents?: 3 | 4 },
  options: OctreeOptions = {},
): MemoryOctree {
  const { positions } = cloud,
    n = positions.length / 3,
    maxPoints = options.maxPointsPerNode ?? 20_000,
    grid = options.grid ?? 128,
    maxDepth = options.maxDepth ?? 16;
  if (!Number.isInteger(n)) throw new RangeError('positions length must be a multiple of 3');
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
  return new MemoryOctree(root, indices, positions, cloud.colors, components as 3 | 4);
}

/** The camera, in the cloud's coordinates, for `OctreeCloud.select`. */
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
  /** Material of every node's cloud. */
  material?: PointsMaterialOptions;
  /** Other `PointCloud` options for every node (colour space, block size). */
  cloud?: Omit<PointCloudOptions, 'positions' | 'colors' | 'colorComponents' | 'material'>;
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
}

let count = 0;

/** Draws an octree under a point budget; attach it to the engine (it updates every frame) or call `select` yourself. */
export class OctreeCloud implements EnginePlugin {
  readonly name: string;
  readonly source: OctreeSource;
  pointBudget: number;
  minNodePixels: number;
  maxLoadedPoints: number;
  /** Nodes drawn in the last selection, largest on screen first. */
  visible: OctreeNode[] = [];
  /** Points drawn in the last selection, and points loaded. */
  stats = { drawn: 0, loaded: 0, loading: 0, failed: 0 };
  disposed = false;
  private engine?: EngineKernel;
  private frame = 0;
  private readonly loaded = new Map<OctreeNode, Loaded>();
  private readonly failed = new Set<OctreeNode>();
  private readonly maxConcurrent: number;
  private readonly material?: PointsMaterialOptions;
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
    this.material = options.material;
    this.cloudOptions = options.cloud;
  }
  setup(engine: EngineKernel): void {
    this.engine = engine;
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
    this.frame++;
    const k = view.screenHeight / (2 * Math.tan(((view.fov ?? 60) * Math.PI) / 180 / 2)),
      p = view.position;
    const size = (node: OctreeNode) => {
      const b = node.bounds,
        r = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2,
        d = Math.hypot((b[0] + b[3]) / 2 - p[0], (b[1] + b[4]) / 2 - p[1], (b[2] + b[5]) / 2 - p[2]);
      return d <= r ? Infinity : (r * k) / (d - r);
    };
    const inside = (node: OctreeNode) => {
      const pl = view.planes;
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
    this.visible = chosen;
    this.stats.drawn = drawn;
    this.request(wanted);
    this.evict();
    return chosen;
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
      const cloud = new PointCloud({ ...this.cloudOptions, ...data, material: this.material });
      cloud.visible = false;
      this.points.add(cloud);
      entry.cloud = cloud;
      entry.points = cloud.count;
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
