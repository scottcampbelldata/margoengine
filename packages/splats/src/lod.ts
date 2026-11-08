/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/splats/lod: hierarchical levels of detail for Gaussian splat captures, streamed by view. A capture is an
// octree of nodes (`SplatLodSource`): leaves hold the trained splats, each inner node a coarser cloud standing for its
// children (here moment-matched merges of the splats in a grid, `decimateSplats`). Each frame the view refines the
// tree where a node's error, projected to pixels, exceeds `maxError`, largest error first, until the GPU budget is
// full; only the chosen nodes are loaded (through the source's `load`, so they can come from a server node by node) and
// uploaded into fixed slots of one `Splats` cloud, so every chosen node sorts together. A node is swapped for its
// children only once all of them are loaded, so the capture never shows holes while it streams.
// Refinement by projected geometric error over a bounding-volume hierarchy: Luebke et al. 2003, "Level of Detail for
// 3D Graphics", ch. 4 (screen-space error); the same rule 3D Tiles 1.1 uses (geometricError, REPLACE refinement).
// Hierarchical Gaussians: Kerbl et al. 2024, "A Hierarchical 3D Gaussian Representation for Real-Time Rendering of
// Very Large Datasets", ACM TOG 43(4) (merged interior Gaussians, cut by projected size).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { validateSplats, type SplatData } from './data.js';
import { decimateSplats } from './edit.js';
import { Splats } from './index.js';

/** One node of a {@link SplatLodSource}: a bounding sphere, its error and its children. */
export interface SplatLodNode {
  /** Bounding sphere of the node's splat centres (and its children's), world units. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /** World-space size of the detail this node leaves out; 0 for a leaf (the trained splats). */
  readonly error: number;
  /** Splats in the node's own cloud. */
  readonly count: number;
  /** Indices of the child nodes; empty for a leaf. */
  readonly children: readonly number[];
}

/** A splat hierarchy: node 0 is the root. `load` returns a node's cloud; it may fetch it. */
export interface SplatLodSource {
  readonly nodes: readonly SplatLodNode[];
  /** Spherical-harmonics coefficients per channel of every node's cloud: 0, 4, 9 or 16. */
  readonly coefficients: number;
  load(index: number, signal: AbortSignal): Promise<SplatData>;
}

/** Options of {@link buildSplatLod}. */
export interface BuildSplatLodOptions {
  /** Most splats in one node, leaf or inner. Default 65,536. */
  leafSize?: number;
}

/**
 * Builds an in-memory hierarchy from a capture: an octree of its splat centres split until a cell holds at most
 * `leafSize` splats (leaves keep the splats untouched), and for each inner cell a moment-matched cloud of at most
 * `leafSize` splats from its leaves, with the grid cell it merged as its error. A server can store each node's cloud
 * (for instance with `encodeSplat`) and serve its own `SplatLodSource` with the same nodes.
 * @throws RangeError when `data` is invalid or `leafSize` is under 64.
 */
export function buildSplatLod(data: SplatData, options: BuildSplatLodOptions = {}): SplatLodSource {
  const count = validateSplats(data),
    leafSize = options.leafSize ?? 65536;
  if (!Number.isInteger(leafSize) || leafSize < 64) throw new RangeError('buildSplatLod leafSize must be an integer of 64 or more');
  const coefficients = data.sphericalHarmonics ? data.sphericalHarmonics.length / count / 3 : 0,
    nodes: SplatLodNode[] = [],
    clouds: SplatData[] = [],
    p = data.positions;
  const all = new Uint32Array(count);
  for (let i = 0; i < count; i++) all[i] = i;
  // Returns the node index. `min`/`size`: the octree cell.
  const build = (indices: Uint32Array, min: readonly number[], size: number, depth: number): number => {
    const at = nodes.length;
    nodes.push(undefined!);
    clouds.push(undefined!);
    let children: number[] = [];
    if (indices.length > leafSize && depth < 21) {
      const half = size / 2,
        octant = new Uint8Array(indices.length),
        counts = new Uint32Array(8);
      indices.forEach((s, k) => {
        let o = 0;
        for (let a = 0; a < 3; a++) if (p[s * 3 + a] >= min[a] + half) o |= 1 << a;
        octant[k] = o;
        counts[o]++;
      });
      for (let o = 0; o < 8; o++) {
        if (!counts[o]) continue;
        const part = new Uint32Array(counts[o]);
        let n = 0;
        indices.forEach((s, k) => {
          if (octant[k] === o) part[n++] = s;
        });
        children.push(build(part, [0, 1, 2].map((a) => min[a] + ((o >> a) & 1) * half), half, depth + 1));
      }
      // Every splat in one octant down to the depth cap: keep them together as a leaf.
      if (children.length === 1 && nodes[children[0]].children.length === 0 && depth >= 20) children = [];
    }
    const own = gather(data, indices, coefficients);
    let cloud = own,
      error = 0;
    if (children.length) {
      // The coarsest grid that still fits leafSize after merging: start from 1/64 of the cell and double.
      for (let cell = size / 64; ; cell *= 2) {
        cloud = decimateSplats(own, { cellSize: cell });
        error = cell;
        if (cloud.positions.length / 3 <= leafSize) break;
      }
    }
    const sphere = bound(cloud.positions, children.map((c) => nodes[c]));
    nodes[at] = { center: sphere.center, radius: sphere.radius, error, count: cloud.positions.length / 3, children };
    clouds[at] = cloud;
    return at;
  };
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[i * 3 + a]);
      hi[a] = Math.max(hi[a], p[i * 3 + a]);
    }
  build(all, lo, Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * (1 + 1e-6) || 1, 0);
  return {
    nodes,
    coefficients,
    load: (index, signal) =>
      signal.aborted
        ? Promise.reject(signal.reason)
        : clouds[index]
          ? Promise.resolve(clouds[index])
          : Promise.reject(new RangeError(`No splat node ${index}`)),
  };
}

function gather(data: SplatData, indices: Uint32Array, coefficients: number): SplatData {
  const n = indices.length,
    positions = new Float32Array(n * 3),
    covariances = new Float32Array(n * 6),
    colors = new Float32Array(n * 4),
    sh = coefficients ? new Float32Array(n * coefficients * 3) : undefined,
    stride = coefficients * 3;
  indices.forEach((s, k) => {
    positions.set(data.positions.subarray(s * 3, s * 3 + 3), k * 3);
    covariances.set(data.covariances.subarray(s * 6, s * 6 + 6), k * 6);
    colors.set(data.colors.subarray(s * 4, s * 4 + 4), k * 4);
    if (sh) sh.set(data.sphericalHarmonics!.subarray(s * stride, s * stride + stride), k * stride);
  });
  return { positions, covariances, colors, ...(sh ? { sphericalHarmonics: sh } : {}) };
}

/** A sphere around `positions` and the children's spheres (centre: the box middle). */
function bound(positions: Float32Array, children: SplatLodNode[]): { center: [number, number, number]; radius: number } {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], positions[i + a]);
      hi[a] = Math.max(hi[a], positions[i + a]);
    }
  for (const c of children)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], c.center[a] - c.radius);
      hi[a] = Math.max(hi[a], c.center[a] + c.radius);
    }
  const center: [number, number, number] = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2) as [number, number, number];
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3)
    r2 = Math.max(r2, (positions[i] - center[0]) ** 2 + (positions[i + 1] - center[1]) ** 2 + (positions[i + 2] - center[2]) ** 2);
  let radius = Math.sqrt(r2);
  for (const c of children) radius = Math.max(radius, Math.hypot(c.center[0] - center[0], c.center[1] - center[1], c.center[2] - center[2]) + c.radius);
  return { center, radius };
}

/** The view a {@link chooseSplatNodes} call refines for. */
export interface SplatLodView {
  /** Camera position, world units. */
  readonly eye: readonly [number, number, number];
  /** Pixels per world unit at distance 1 (perspective: height / (2 tan(fov / 2))). */
  readonly focal: number;
  /** Nearest distance an error is projected from (the near plane). */
  readonly near: number;
}

/**
 * The cut of the tree to draw for `view`: starting at the root, the node with the largest projected error
 * (`error * focal / distance`, in pixels) is replaced by its children while that error exceeds `maxError`, all its
 * children are in `loaded` and the cut stays within `budget` splats. Returns the cut and the nodes to load next (the
 * children that held a refinement back, largest error first).
 */
export function chooseSplatNodes(
  nodes: readonly SplatLodNode[],
  view: SplatLodView,
  options: { maxError: number; budget: number; loaded: (index: number) => boolean },
): { selected: number[]; wanted: number[] } {
  const wanted: number[] = [];
  if (!nodes.length) return { selected: [], wanted };
  if (!options.loaded(0)) return { selected: [], wanted: [0] };
  const pixels = (i: number) => {
    const n = nodes[i];
    if (!n.children.length) return 0;
    const d = Math.hypot(n.center[0] - view.eye[0], n.center[1] - view.eye[1], n.center[2] - view.eye[2]) - n.radius;
    return (n.error * view.focal) / Math.max(d, view.near);
  };
  const heap: Array<[number, number]> = [[pixels(0), 0]],
    kept: number[] = [];
  let total = nodes[0].count;
  while (heap.length) {
    heap.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const [error, i] = heap.shift()!,
      n = nodes[i];
    if (error <= options.maxError) {
      kept.push(i, ...heap.map((h) => h[1]));
      break;
    }
    const missing = n.children.filter((c) => !options.loaded(c)),
      grown = total - n.count + n.children.reduce((s, c) => s + nodes[c].count, 0);
    if (missing.length || grown > options.budget) {
      if (missing.length && grown <= options.budget) wanted.push(...missing);
      kept.push(i);
      continue;
    }
    total = grown;
    for (const c of n.children) heap.push([pixels(c), c]);
  }
  return { selected: kept.sort((a, b) => a - b), wanted };
}

/** Options of {@link SplatLod}. */
export interface SplatLodOptions {
  /** Most splats drawn at once (the GPU pool, rounded up to whole node slots). Default 1,000,000. */
  budget?: number;
  /** Largest projected error left unrefined, in pixels. Default 2. */
  maxError?: number;
  /** Most node loads in flight. Default 4. */
  concurrency?: number;
  /** Most splats of loaded nodes kept on the CPU (drawn ones included). Default twice the budget. */
  cache?: number;
  /** Aborts every load; the hierarchy keeps what it has. */
  signal?: AbortSignal;
}

type Context = Extract<PassContext, { backend: 'webgpu' }>;

/**
 * A streamed splat hierarchy: `SplatLod.attach(engine, source, options)`. Each frame, before the splats project, the
 * view picks the cut (`chooseSplatNodes`), starts loads for the nodes it lacks, and writes changed nodes into the
 * slots of `cloud`, one `Splats` of `budget` splats that sorts every drawn node together. `attach` attaches `cloud`
 * too. WebGPU only.
 * @throws RangeError for invalid options or a source whose nodes are invalid or larger than the budget; MargoError
 * `'unsupported'` from attach on a WebGL engine.
 */
export class SplatLod implements EnginePlugin {
  private static next = 0;
  readonly name = 'splats-lod:' + SplatLod.next++;
  /** The cloud every drawn node is written into. */
  readonly cloud: Splats;
  readonly source: SplatLodSource;
  readonly maxError: number;
  private readonly slot: number;
  private readonly concurrency: number;
  private readonly cacheSize: number;
  private readonly abort = new AbortController();
  private readonly loaded = new Map<number, SplatData>();
  private readonly pending = new Set<number>();
  private readonly failures: unknown[] = [];
  private readonly slots: Array<number | undefined>;
  private readonly at = new Map<number, number>();
  private cut: number[] = [];
  private used = 0;
  private waiters: Array<() => void> = [];
  private disposed = false;
  private engine?: Engine;
  constructor(source: SplatLodSource, options: SplatLodOptions = {}) {
    const nodes = source?.nodes;
    if (!Array.isArray(nodes) || !nodes.length || typeof source.load !== 'function')
      throw new TypeError('SplatLod needs a source with nodes and load(index, signal)');
    if (![0, 4, 9, 16].includes(source.coefficients)) throw new RangeError('SplatLod source coefficients must be 0, 4, 9 or 16');
    const budget = options.budget ?? 1_000_000;
    this.maxError = options.maxError ?? 2;
    this.concurrency = options.concurrency ?? 4;
    for (const [name, value, min] of [
      ['budget', budget, 1],
      ['maxError', this.maxError, 0],
      ['concurrency', this.concurrency, 1],
    ] as const)
      if (!(value >= min) || !Number.isFinite(value)) throw new RangeError(`SplatLod ${name} must be ${min} or more`);
    let largest = 0;
    nodes.forEach((n: SplatLodNode, i: number) => {
      if (!(n.count >= 1) || !Number.isInteger(n.count) || !(n.radius >= 0) || !(n.error >= 0) || n.children.some((c: number) => !(c > i && c < nodes.length)))
        throw new RangeError(`SplatLod node ${i} is invalid (count, radius, error, or a child that is not a later node); give each node a count of 1 or more and only later children`);
      largest = Math.max(largest, n.count);
    });
    if (largest > budget) throw new RangeError(`SplatLod budget ${budget} is under the largest node, ${largest} splats; raise the budget or split the node`);
    this.source = source;
    this.slot = largest;
    this.slots = new Array(Math.floor(budget / largest)).fill(undefined);
    this.cacheSize = options.cache ?? this.slots.length * largest * 2;
    this.cloud = Splats.reserve(this.slots.length * largest, source.coefficients);
    options.signal?.addEventListener('abort', () => this.abort.abort(options.signal!.reason), { once: true });
  }
  static attach(engine: EngineKernel, source: SplatLodSource, options: SplatLodOptions = {}): SplatLod {
    const lod = new SplatLod(source, options),
      runtime = engineRuntime(engine);
    runtime.use(lod.cloud);
    runtime.use(lod);
    return lod;
  }
  /** The nodes drawn now, in index order. */
  get selected(): readonly number[] {
    return this.cut;
  }
  /** Where each drawn node sits in `cloud`: node index to the pool index of its first splat (for picking or editing). */
  get placement(): ReadonlyMap<number, number> {
    const out = new Map<number, number>();
    for (const [node, slot] of this.at) out.set(node, slot * this.slot);
    return out;
  }
  /** Splats drawn now (sum of the selected nodes). */
  get drawn(): number {
    return this.used;
  }
  /** Loads in flight. */
  get loading(): number {
    return this.pending.size;
  }
  /** Errors of loads that failed (the node stays unloaded and is not asked for again). */
  get errors(): readonly unknown[] {
    return this.failures;
  }
  /** Resolves after the next frame that drew a cut needing no load (the view is fully streamed in). */
  settled(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'SplatLod needs WebGPU and a live hierarchy; attach a new SplatLod to a WebGPU engine',
      );
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -8,
      execute: (c) => {
        if (c.backend === 'webgpu') this.update(c);
      },
    });
  }
  private update(c: Context): void {
    const focal = c.height / (2 * Math.tan((c.camera.fov * Math.PI) / 360)),
      view = { eye: c.camera.position, focal, near: c.camera.near },
      { selected, wanted } = chooseSplatNodes(this.source.nodes, view, {
        maxError: this.maxError,
        budget: this.slots.length * this.slot,
        loaded: (i) => this.loaded.has(i),
      });
    for (const i of wanted) this.request(i);
    const keep = new Set(selected);
    for (const i of this.cut)
      if (!keep.has(i)) {
        const s = this.at.get(i)!;
        this.cloud.clear(s * this.slot, this.slot);
        this.slots[s] = undefined;
        this.at.delete(i);
      }
    for (const i of selected)
      if (!this.at.has(i)) {
        const s = this.slots.indexOf(undefined);
        this.slots[s] = i;
        this.at.set(i, s);
        this.cloud.clear(s * this.slot, this.slot);
        this.cloud.write(s * this.slot, this.loaded.get(i)!);
      }
    this.cut = selected;
    this.used = selected.reduce((sum, i) => sum + this.source.nodes[i].count, 0);
    this.evict(keep);
    if (!wanted.length && !this.pending.size && this.waiters.length) {
      const done = this.waiters;
      this.waiters = [];
      for (const resolve of done) resolve();
    }
  }
  private request(index: number): void {
    if (this.pending.has(index) || this.pending.size >= this.concurrency || this.abort.signal.aborted) return;
    if (this.failures.some((f) => (f as { node?: number }).node === index)) return;
    this.pending.add(index);
    this.source.load(index, this.abort.signal).then(
      (data) => {
        this.pending.delete(index);
        if (this.disposed) return;
        const n = validateSplats(data),
          coefficients = data.sphericalHarmonics ? data.sphericalHarmonics.length / n / 3 : 0;
        if (n !== this.source.nodes[index].count || coefficients !== this.source.coefficients)
          this.failures.push(Object.assign(new RangeError(`Splat node ${index} loaded ${n} splats with ${coefficients} SH coefficients, not ${this.source.nodes[index].count} with ${this.source.coefficients}`), { node: index }));
        else this.loaded.set(index, data);
      },
      (error) => {
        this.pending.delete(index);
        if (!this.abort.signal.aborted) this.failures.push(Object.assign(error instanceof Error ? error : new Error(String(error)), { node: index }));
      },
    );
  }
  /** Drops loaded nodes that are not drawn, oldest first, while the cache holds more than `cache` splats. */
  private evict(keep: Set<number>): void {
    let total = 0;
    for (const i of this.loaded.keys()) total += this.source.nodes[i].count;
    for (const i of [...this.loaded.keys()]) {
      if (total <= this.cacheSize) break;
      // The root stays: without it nothing can be drawn.
      if (keep.has(i) || i === 0) continue;
      this.loaded.delete(i);
      total -= this.source.nodes[i].count;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort(new MargoError('disposed', 'The SplatLod was disposed'));
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
    this.cloud.dispose();
    this.loaded.clear();
    for (const resolve of this.waiters) resolve();
    this.waiters = [];
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
