/// <reference lib="esnext.disposable" preserve="true" />
// Per-item frustum culling and levels of detail for a BatchedMesh. Each level of an item is its own item of the batch,
// and exactly one of them (or none, when the item is hidden or outside the view) has the batch's visible flag set, so
// the batch's compute pass, shadows and picking need nothing new. Every frame, before the batch uploads, the items'
// world boxes are tested against the drawing camera's frustum (through a bounding volume hierarchy once the batch is
// large) and each item in view picks its level from its distance to the camera, with a dead band around each switch.
// Sources (docs/clean-room.md, "Batched mesh item culling and levels of detail"): Clark 1976; Assarsson and
// Moller 2000; Funkhouser and Sequin 1993; Kay and Kajiya 1986; Wald, Boulos and Shirley 2007.
import type { EngineKernel } from '@margoengine/core';
import type { EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { ColorInput } from '@margoengine/math/color';
import type { MeshGeometry } from './built-material.js';
import type { BatchedItemOptions, BatchedMesh } from './batched.js';
import { pickLevel } from '../../shared/lod-pick.js';

/** Levels one item can have. */
export const MAX_BATCHED_LEVELS = 8;
/** Settings of a {@link BatchedLOD}. */
export interface BatchedLODOptions {
  /** Hide items whose world box is outside the drawing camera's frustum. Also settable later. Default true. */
  culling?: boolean;
  /**
   * World units added on every side of an item's box for the frustum test, 0 or more. A culled item casts no shadow,
   * so set it to the longest shadow that should still reach into view. Fixed. Default 0.
   */
  margin?: number;
  /** Dead band of a level that gives none, 0 to below 1 (see {@link BatchedLevel.hysteresis}). Fixed. Default 0.1. */
  hysteresis?: number;
  /** Multiplies every camera distance before the level is picked: above 1 drops detail sooner. Default 1. */
  bias?: number;
  /**
   * Item count from which culling walks a bounding volume hierarchy of the items instead of testing each one; below
   * it the hierarchy is not built. Fixed. Default 64.
   */
  bvhItems?: number;
}
/** One level of detail of an item, finest first. */
export interface BatchedLevel {
  /** The `createMesh` geometry shape, copied into the batch. */
  geometry: MeshGeometry;
  /**
   * World distance from the camera to the centre of the item's box from which this level shows. The first level
   * shows from 0 and takes none; later levels need one, each at least the one before.
   */
  distance?: number;
  /**
   * Coming back from this level to a finer one waits until the distance is below `distance * (1 - hysteresis)`, so
   * an item at a switch distance does not flicker. 0 to below 1. Default the `BatchedLOD`'s.
   */
  hysteresis?: number;
}
/** Work counts of the last {@link BatchedLOD.update} that ran. */
export interface BatchedLODStats {
  /** Items held. */
  items: number;
  /** Items drawn: visible and in view. */
  drawn: number;
  /** Visible items left out because their box is outside the frustum. */
  culled: number;
  /** Triangles of the levels drawn. */
  triangles: number;
  /** Boxes tested against the frustum (items, and hierarchy nodes when it is used). */
  tests: number;
}
/** The camera fields {@link BatchedLOD.update} reads; the engine's `Camera` is one. */
export interface BatchedLODCamera {
  /** Six world-space planes (nx, ny, nz, d), inside where n.p + d >= 0. */
  readonly planes: ArrayLike<number>;
  /** World position. */
  readonly position: ArrayLike<number>;
}

const L = MAX_BATCHED_LEVELS,
  LEAF = 4;
let serial = 0;

/**
 * 0 when the box at `o` of `b` (min xyz, max xyz) is wholly outside one of the six `planes`, 2 when it is wholly inside
 * all of them, else 1. Per plane, the box's reach along the normal decides (Assarsson and Moller 2000). The outside
 * test is padded by 1e-5 of the box's farthest coordinates, which never grows from a box to one inside it: a box
 * dropped with its hierarchy node is one the test would drop alone.
 */
function classify(b: Float64Array, o: number, planes: ArrayLike<number>): number {
  const cx = (b[o] + b[o + 3]) / 2,
    cy = (b[o + 1] + b[o + 4]) / 2,
    cz = (b[o + 2] + b[o + 5]) / 2,
    hx = (b[o + 3] - b[o]) / 2,
    hy = (b[o + 4] - b[o + 1]) / 2,
    hz = (b[o + 5] - b[o + 2]) / 2,
    mx = Math.max(Math.abs(b[o]), Math.abs(b[o + 3])),
    my = Math.max(Math.abs(b[o + 1]), Math.abs(b[o + 4])),
    mz = Math.max(Math.abs(b[o + 2]), Math.abs(b[o + 5]));
  let result = 2;
  for (let p = 0; p < 24; p += 4) {
    const ax = Math.abs(planes[p]),
      ay = Math.abs(planes[p + 1]),
      az = Math.abs(planes[p + 2]),
      reach = ax * hx + ay * hy + az * hz,
      d = planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3];
    if (d + reach < -1e-5 * (ax * mx + ay * my + az * mz)) return 0;
    if (!(d - reach >= 0)) result = 1;
  }
  return result;
}
/** Grows the box at `o` of `b` to hold the box at `from` of `a`. */
function join(b: Float64Array, o: number, a: Float64Array, from: number): void {
  for (let k = 0; k < 3; k++) {
    if (a[from + k] < b[o + k]) b[o + k] = a[from + k];
    if (a[from + 3 + k] > b[o + 3 + k]) b[o + 3 + k] = a[from + 3 + k];
  }
}
const empty = (b: Float64Array, o: number) => b.fill(Infinity, o, o + 3).fill(-Infinity, o + 3, o + 6);
const resized = <T extends Float64Array | Int32Array | Uint32Array | Int8Array | Uint8Array>(a: T, n: number): T => {
  const out = new (a.constructor as new (n: number) => T)(n);
  out.set(a);
  return out;
};

/**
 * Per-item frustum culling and levels of detail for a `BatchedMesh`: `BatchedLOD.attach(engine, batch)`, then
 * `lod.add(geometry, {matrix})` for a culled item or `lod.add([{geometry: fine}, {geometry: coarse, distance: 30}])`
 * for one with levels. Every level takes an item and its vertices of the batch's capacity. Before each view is drawn,
 * items outside its camera's frustum are hidden and each item in view shows the level its distance picks. Items
 * are added, moved, tinted, hidden and removed through this object, by the id its `add` returned; items added to the
 * batch directly are left alone. A frame in which neither the camera nor an item changed does no work.
 */
export class BatchedLOD implements EnginePlugin {
  readonly name = 'batched-lod:' + serial++;
  /** The batch the items live in. */
  readonly batch: BatchedMesh;
  /** See {@link BatchedLODOptions.culling}. */
  culling: boolean;
  /** See {@link BatchedLODOptions.bias}. */
  bias: number;
  /** See {@link BatchedLODOptions.margin}. */
  readonly margin: number;
  /** See {@link BatchedLODOptions.hysteresis}. */
  readonly hysteresis: number;
  /** See {@link BatchedLODOptions.bvhItems}. */
  readonly bvhItems: number;
  /** Work counts of the last update that ran. */
  readonly stats: BatchedLODStats = { items: 0, drawn: 0, culled: 0, triangles: 0, tests: 0 };
  // Per item, indexed by its id (the batch id of its first level).
  private counts = new Uint8Array(0);
  private visible = new Uint8Array(0);
  private stale = new Uint8Array(0);
  private inView = new Uint8Array(0);
  /** The level picked last (kept while culled, for the dead band) and the level the batch shows now (-1 none). */
  private shown = new Int8Array(0);
  private drawn = new Int8Array(0);
  private boxes = new Float64Array(0);
  // Per item and level.
  private levels = new Int32Array(0);
  private triangles = new Uint32Array(0);
  // Float64, as LODSystem: a distance rounded to float32 can land above the distance that reaches it exactly.
  private thresholds = new Float64Array(0);
  private bands = new Float64Array(0);
  /** Batch id to the item it is a level of, or -1. */
  private owners = new Int32Array(0);
  private end = 0;
  private live = 0;
  // The hierarchy: node boxes, each node's run of `order`, and its first child (the second follows; -1 for a leaf).
  private nodes = 0;
  private nodeBoxes = new Float64Array(0);
  private nodeStart = new Int32Array(0);
  private nodeCount = new Int32Array(0);
  private nodeChild = new Int32Array(0);
  private order = new Int32Array(0);
  private builtArea = 0;
  private rebuild = true;
  private dirty = true;
  /** What the last update saw: planes, camera position, bias, culling, then the batch root's matrix. */
  private readonly seen = new Float64Array(45);
  private readonly stack = new Int32Array(128);
  private readonly box = new Float64Array(6);
  private unsubscribe?: () => void;
  private disposed = false;

  /**
   * Culling and levels of detail for `batch`. Throws TypeError for something that is not a live `BatchedMesh`,
   * RangeError for an option out of range.
   */
  static attach(engine: EngineKernel, batch: BatchedMesh, options: BatchedLODOptions = {}): BatchedLOD {
    const lod = new BatchedLOD(batch, options);
    engine.use(lod);
    // The batch is already gone when its mesh says so: there is nothing left to take the items out of.
    lod.unsubscribe = batch.mesh.onDispose(() => lod.close(false));
    return lod;
  }
  private constructor(batch: BatchedMesh, options: BatchedLODOptions) {
    if (typeof batch?.add !== 'function' || !batch.mesh || batch.mesh.disposed)
      throw new TypeError('BatchedLOD needs a live BatchedMesh; pass BatchedMesh.attach(engine, material, {...})');
    if (!options || typeof options !== 'object')
      throw new TypeError('BatchedLOD options must be an object; pass {culling, margin, hysteresis, bias}');
    const { culling = true, margin = 0, hysteresis = 0.1, bias = 1, bvhItems = 64 } = options;
    if (typeof culling !== 'boolean') throw new TypeError('BatchedLOD culling must be a boolean; pass true or false');
    if (!(margin >= 0 && margin < Infinity))
      throw new RangeError('BatchedLOD margin must be 0 or more world units; pass a finite distance');
    if (!(hysteresis >= 0 && hysteresis < 1))
      throw new RangeError('BatchedLOD hysteresis must be 0 or more and below 1; pass for example 0.1');
    if (!(bias > 0 && bias < Infinity)) throw new RangeError('BatchedLOD bias must be above 0; pass for example 1');
    if (!(bvhItems >= 0)) throw new RangeError('BatchedLOD bvhItems must be 0 or more; pass an item count');
    this.batch = batch;
    this.culling = culling;
    this.margin = margin;
    this.hysteresis = hysteresis;
    this.bias = bias;
    this.bvhItems = bvhItems;
  }
  /** Items held. */
  get count(): number {
    return this.live;
  }
  /**
   * Adds an item: one geometry (culled only) or its levels, finest first, each a copy in the batch. Returns the item's
   * id. Throws RangeError for levels out of order or range, and what `BatchedMesh.add` throws when the batch is full
   * (nothing is added then).
   */
  add(levels: MeshGeometry | readonly BatchedLevel[], options: BatchedItemOptions = {}): number {
    this.check();
    const list: readonly BatchedLevel[] = Array.isArray(levels) ? levels : [{ geometry: levels as MeshGeometry }],
      n = list.length;
    if (n < 1 || n > L) throw new RangeError(`BatchedLOD needs 1 to ${L} levels; pass fewer levels`);
    let previous = 0;
    for (let l = 0; l < n; l++) {
      if (!list[l] || typeof list[l] !== 'object')
        throw new TypeError('BatchedLOD level must be an object; pass {geometry, distance} per level');
      const { distance = 0, hysteresis = this.hysteresis } = list[l];
      if ((l === 0 ? distance !== 0 : list[l].distance === undefined) || !(distance >= previous && distance < Infinity))
        throw new RangeError(
          'BatchedLOD levels need distances that do not decrease, none (or 0) on the first; pass finest first',
        );
      if (!(hysteresis >= 0 && hysteresis < 1))
        throw new RangeError('BatchedLOD level hysteresis must be 0 or more and below 1; pass for example 0.1');
      previous = distance;
    }
    if (options.visible !== undefined && typeof options.visible !== 'boolean')
      throw new TypeError('BatchedLOD visibility must be a boolean; pass true or false');
    const { batch } = this,
      ids: number[] = [];
    try {
      for (const level of list) ids.push(batch.add(level.geometry, { ...options, visible: false }));
    } catch (error) {
      for (const id of ids) batch.remove(id);
      throw error;
    }
    const id = ids[0],
      top = Math.max(...ids) + 1;
    if (top > this.counts.length) this.grow(Math.max(16, top, this.counts.length * 2));
    for (let l = 0; l < n; l++) {
      const g = list[l].geometry;
      this.levels[id * L + l] = ids[l];
      this.owners[ids[l]] = id;
      this.triangles[id * L + l] = (g.indices?.length ?? g.positions.length / 3) / 3;
      this.thresholds[id * L + l] = list[l].distance ?? 0;
      this.bands[id * L + l] = list[l].hysteresis ?? this.hysteresis;
    }
    this.counts[id] = n;
    this.visible[id] = +(options.visible ?? true);
    this.stale[id] = 1;
    this.shown[id] = this.drawn[id] = -1;
    this.end = Math.max(this.end, id + 1);
    this.live++;
    this.rebuild = this.dirty = true;
    return id;
  }
  /** Removes item `id` and every level of it from the batch. Throws RangeError for an id `add` did not return. */
  remove(id: number): void {
    const n = this.item(id);
    for (let l = 0; l < n; l++) {
      this.batch.remove(this.levels[id * L + l]);
      this.owners[this.levels[id * L + l]] = -1;
    }
    this.counts[id] = 0;
    this.live--;
    this.rebuild = this.dirty = true;
  }
  /** Whether `id` is an item of this object. */
  has(id: number): boolean {
    return Number.isInteger(id) && this.counts[id] > 0;
  }
  /** Sets item `id`'s column-major matrix (16 finite numbers), relative to `batch.mesh.root`, on all its levels. */
  setMatrix(id: number, matrix: ArrayLike<number>): this {
    const n = this.item(id);
    for (let l = 0; l < n; l++) this.batch.setMatrix(this.levels[id * L + l], matrix);
    this.stale[id] = 1;
    this.dirty = true;
    return this;
  }
  /** Item `id`'s matrix, written into `out` (16 numbers) when given. */
  getMatrix(id: number, out?: Float32Array | number[]): Float32Array | number[] {
    this.item(id);
    return this.batch.getMatrix(id, out);
  }
  /** Sets item `id`'s tint on all its levels (as `BatchedMesh.setColor`). */
  setColor(id: number, color: ColorInput): this {
    const n = this.item(id);
    for (let l = 0; l < n; l++) this.batch.setColor(this.levels[id * L + l], color);
    return this;
  }
  /** Item `id`'s linear rgb tint, written into `out` when given. */
  getColor(id: number, out?: Float32Array | number[]): Float32Array | number[] {
    this.item(id);
    return this.batch.getColor(id, out);
  }
  /** Shows or hides item `id`. A shown item still draws only while it is in view. */
  setVisible(id: number, visible: boolean): this {
    this.item(id);
    if (typeof visible !== 'boolean')
      throw new TypeError('BatchedLOD visibility must be a boolean; pass true or false');
    this.visible[id] = +visible;
    this.dirty = true;
    return this;
  }
  /** Whether item `id` is shown (as set; `levelOf` tells whether it draws). */
  isVisible(id: number): boolean {
    this.item(id);
    return this.visible[id] > 0;
  }
  /** The level of item `id` drawn since the last update, or -1 when it is hidden or outside the view. */
  levelOf(id: number): number {
    this.item(id);
    return this.drawn[id];
  }
  /** The item a vertex of `batch.mesh` belongs to (as a picking hit's vertex index gives), or -1 when it is none of this object's. */
  itemOf(vertex: number): number {
    const id = this.batch.itemOf(vertex);
    return id < 0 || id >= this.owners.length ? -1 : this.owners[id];
  }
  setup(): void {
    this.check();
  }
  registerPasses(graph: FrameGraph): void {
    // Before the batch's own pass (-10), which uploads the flags set here, and so before every pass that draws it.
    graph.add({ name: this.name, order: -11, execute: (c) => this.update(c.camera) });
  }
  /**
   * Culls and picks levels for `camera` (its planes and position as they stand). Runs by itself before each view is
   * drawn; call it by hand only to read `stats` or `levelOf` without drawing.
   */
  update(camera: BatchedLODCamera): void {
    if (this.disposed || this.batch.mesh.disposed) return;
    const { batch, seen, boxes, counts, stats } = this,
      { planes, position } = camera,
      root = batch.mesh.primitives[0].node.matrix;
    let same = !this.dirty;
    for (let k = 0; k < 45; k++) {
      const v =
        k < 24 ? planes[k] : k < 27 ? position[k - 24] : k < 28 ? this.bias : k < 29 ? +this.culling : root[k - 29];
      if (seen[k] !== v) {
        seen[k] = v;
        same = false;
        if (k >= 29) this.stale.fill(1, 0, this.end);
      }
    }
    if (same) return;
    this.dirty = false;
    // World boxes of the items that moved: every level's box through the item's matrix and the root, joined.
    let moved = false;
    for (let id = 0; id < this.end; id++) {
      if (!counts[id] || !this.stale[id]) continue;
      this.stale[id] = 0;
      moved = true;
      empty(boxes, id * 6);
      for (let l = 0; l < counts[id]; l++) join(boxes, id * 6, batch.boundsInto(this.box, this.levels[id * L + l]), 0);
      for (let k = 0; k < 3; k++) {
        boxes[id * 6 + k] -= this.margin;
        boxes[id * 6 + 3 + k] += this.margin;
      }
    }
    stats.tests = 0;
    if (!this.culling) this.inView.fill(1, 0, this.end);
    else if (this.live < Math.max(1, this.bvhItems)) {
      for (let id = 0; id < this.end; id++)
        if (counts[id]) {
          stats.tests++;
          this.inView[id] = +(classify(boxes, id * 6, planes) > 0);
        }
    } else {
      if (this.rebuild) this.build();
      else if (moved) this.refit();
      this.walk(planes);
    }
    const ex = position[0],
      ey = position[1],
      ez = position[2];
    let drawn = 0,
      culled = 0,
      triangles = 0;
    for (let id = 0; id < this.end; id++) {
      if (!counts[id]) continue;
      let want = -1;
      if (this.visible[id]) {
        if (!this.inView[id]) culled++;
        else {
          const o = id * 6,
            dx = (boxes[o] + boxes[o + 3]) / 2 - ex,
            dy = (boxes[o + 1] + boxes[o + 4]) / 2 - ey,
            dz = (boxes[o + 2] + boxes[o + 5]) / 2 - ez;
          want = this.shown[id] = pickLevel(
            this.thresholds,
            this.bands,
            id * L,
            counts[id],
            this.shown[id],
            Math.sqrt(dx * dx + dy * dy + dz * dz) * this.bias,
          );
          drawn++;
          triangles += this.triangles[id * L + want];
        }
      }
      const was = this.drawn[id];
      if (want === was) continue;
      if (was >= 0) batch.setVisible(this.levels[id * L + was], false);
      if (want >= 0) batch.setVisible(this.levels[id * L + want], true);
      this.drawn[id] = want;
    }
    stats.items = this.live;
    stats.drawn = drawn;
    stats.culled = culled;
    stats.triangles = triangles;
  }
  /**
   * Builds the hierarchy top down: each node's items are split at the median of their box centres along the axis
   * those centres spread most (Kay and Kajiya 1986), down to leaves of at most 4 items.
   */
  private build(): void {
    const { boxes, counts } = this,
      n = this.live;
    if (this.order.length < n) {
      const size = Math.max(n, this.order.length * 2);
      this.order = new Int32Array(size);
      this.nodeBoxes = new Float64Array(size * 12);
      this.nodeStart = new Int32Array(size * 2);
      this.nodeCount = new Int32Array(size * 2);
      this.nodeChild = new Int32Array(size * 2);
    }
    const { order, nodeStart, nodeCount, nodeChild } = this;
    for (let id = 0, k = 0; id < this.end; id++) if (counts[id]) order[k++] = id;
    nodeStart[0] = 0;
    nodeCount[0] = n;
    this.nodes = 1;
    const centres = this.box;
    for (let node = 0; node < this.nodes; node++) {
      const start = nodeStart[node],
        count = nodeCount[node];
      nodeChild[node] = -1;
      if (count <= LEAF) continue;
      empty(centres, 0);
      for (let k = start; k < start + count; k++)
        for (let a = 0, o = order[k] * 6; a < 3; a++) {
          const c = boxes[o + a] + boxes[o + 3 + a];
          if (c < centres[a]) centres[a] = c;
          if (c > centres[a + 3]) centres[a + 3] = c;
        }
      let axis = 0;
      for (let a = 1; a < 3; a++) if (centres[a + 3] - centres[a] > centres[axis + 3] - centres[axis]) axis = a;
      // Items whose centres all coincide cannot be told apart by a split: they stay one leaf.
      if (!(centres[axis + 3] > centres[axis])) continue;
      // ponytail: a full sort per node, O(n log^2 n) a build; a selection (nth element) if builds ever show up.
      order
        .subarray(start, start + count)
        .sort((p, q) => boxes[p * 6 + axis] + boxes[p * 6 + 3 + axis] - boxes[q * 6 + axis] - boxes[q * 6 + 3 + axis]);
      const half = count >> 1,
        child = (nodeChild[node] = this.nodes);
      nodeStart[child] = start;
      nodeCount[child] = half;
      nodeStart[child + 1] = start + half;
      nodeCount[child + 1] = count - half;
      this.nodes += 2;
    }
    this.builtArea = Infinity;
    this.builtArea = this.refit();
    this.rebuild = false;
  }
  /**
   * Recomputes every node's box bottom up with the tree as built (Wald, Boulos and Shirley 2007); children always
   * follow their parent, so one backward loop does it. Returns the summed surface area of the nodes; once items have
   * moved enough to double it since the build, the next update builds anew.
   */
  private refit(): number {
    const { nodeBoxes, nodeChild, nodeStart, nodeCount, order, boxes } = this;
    let area = 0;
    for (let node = this.nodes - 1; node >= 0; node--) {
      const o = node * 6,
        child = nodeChild[node];
      empty(nodeBoxes, o);
      if (child >= 0) {
        join(nodeBoxes, o, nodeBoxes, child * 6);
        join(nodeBoxes, o, nodeBoxes, child * 6 + 6);
      } else
        for (let k = nodeStart[node], to = k + nodeCount[node]; k < to; k++) join(nodeBoxes, o, boxes, order[k] * 6);
      const x = nodeBoxes[o + 3] - nodeBoxes[o],
        y = nodeBoxes[o + 4] - nodeBoxes[o + 1],
        z = nodeBoxes[o + 5] - nodeBoxes[o + 2];
      if (nodeCount[node]) area += x * y + y * z + z * x;
    }
    if (area > this.builtArea * 2) this.rebuild = true;
    return area;
  }
  /**
   * Marks the items in view by walking the hierarchy: a node outside the frustum drops its items untested, a node
   * wholly inside keeps them untested (Clark 1976), and only a node crossing a plane goes on to its children or items.
   */
  private walk(planes: ArrayLike<number>): void {
    const { stack, nodeBoxes, nodeChild, nodeStart, nodeCount, order, boxes, inView, stats } = this;
    inView.fill(0, 0, this.end);
    if (!this.live) return;
    let top = 0;
    stack[top++] = 0;
    while (top) {
      const node = stack[--top],
        side = classify(nodeBoxes, node * 6, planes),
        child = nodeChild[node];
      stats.tests++;
      if (!side) continue;
      if (side === 1 && child >= 0) {
        stack[top++] = child;
        stack[top++] = child + 1;
        continue;
      }
      for (let k = nodeStart[node], to = k + nodeCount[node]; k < to; k++) {
        const id = order[k];
        if (side === 2) inView[id] = 1;
        else {
          stats.tests++;
          inView[id] = +(classify(boxes, id * 6, planes) > 0);
        }
      }
    }
  }
  private grow(size: number): void {
    const from = this.owners.length;
    this.counts = resized(this.counts, size);
    this.visible = resized(this.visible, size);
    this.stale = resized(this.stale, size);
    this.inView = resized(this.inView, size);
    this.shown = resized(this.shown, size);
    this.drawn = resized(this.drawn, size);
    this.boxes = resized(this.boxes, size * 6);
    this.levels = resized(this.levels, size * L);
    this.triangles = resized(this.triangles, size * L);
    this.thresholds = resized(this.thresholds, size * L);
    this.bands = resized(this.bands, size * L);
    this.owners = resized(this.owners, size).fill(-1, from);
  }
  private check(): void {
    if (this.disposed || this.batch.mesh.disposed)
      throw new MargoError('disposed', 'BatchedLOD is disposed; create a new one on a live batch');
  }
  /** The level count of item `id`, which must be one of this object's. */
  private item(id: number): number {
    this.check();
    const n = Number.isInteger(id) ? this.counts[id] : 0;
    if (!n) throw new RangeError(`BatchedLOD has no item ${id}; use an id that add returned`);
    return n;
  }
  /** Removes its items from the batch (when the batch is still alive) and stops culling. The batch itself stays. */
  dispose(): void {
    this.close(!this.batch.mesh.disposed);
  }
  private close(removeItems: boolean): void {
    if (this.disposed) return;
    if (removeItems) for (let id = 0; id < this.end; id++) if (this.counts[id]) this.remove(id);
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // The scene this object was attached to, not whichever scene is active now.
    this.batch.mesh.root.engine.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
