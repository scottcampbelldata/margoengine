/// <reference lib="esnext.disposable" preserve="true" />
// Multi-draw: the parts of one merged core geometry drawn as index ranges in one batch, each shown or hidden on its own,
// with no change to the geometry and no new upload of its vertices. Core draws a redirected batch's `draws` indirect
// argument sets in order (Batch.redirect, Batch.draws and Batch.multi), with one multiDrawIndexedIndirect call where the device has the
// multi-draw-indirect feature; this entry keeps the argument sets: one per range, its instance count the batch's
// count while shown and 0 while hidden. WebGPU spec: drawIndexedIndirect and its argument layout (indexCount,
// instanceCount, firstIndex, baseVertex, firstInstance, 5 x u32); the multi-draw-indirect proposal (gpuweb
// proposals/multi-draw-indirect.md), exposed by Chromium as 'chromium-experimental-multi-draw-indirect'.
import type { EngineKernel } from '@margoengine/core';
import { Geometry } from '@margoengine/core/extension';
import type { Batch, Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Redirect = NonNullable<Batch['redirect']>;

/** The WebGPU feature that draws every range in one call. Request it with `Engine.create(canvas, {features: [...]})`. */
export const MULTI_DRAW_FEATURE = 'chromium-experimental-multi-draw-indirect' as GPUFeatureName;

/** A run of a geometry's indices: `count` indices (a multiple of 3) from index `first`. */
export interface DrawRange {
  first: number;
  count: number;
}

/** Options for {@link MultiDraw}. */
export interface MultiDrawOptions {
  /**
   * Draw every range in one `multiDrawIndexedIndirect` call. Default true when the device has
   * {@link MULTI_DRAW_FEATURE}; elsewhere core draws the ranges one drawIndexedIndirect each (the same picture).
   * True on a device without the feature throws MargoError `unsupported`.
   */
  multi?: boolean;
}

let serial = 0;
const checkRanges = (geometry: Geometry, ranges: readonly DrawRange[]) => {
  if (!(geometry instanceof Geometry)) throw new TypeError('Invalid multi-draw geometry; pass a core Geometry');
  if (!Array.isArray(ranges) || !ranges.length)
    throw new TypeError('Invalid multi-draw ranges; pass one range or more');
  for (const range of ranges)
    if (
      !Number.isInteger(range?.first) ||
      !Number.isInteger(range.count) ||
      range.first < 0 ||
      range.count < 0 ||
      range.count % 3 ||
      range.first + range.count > geometry.indices.length
    )
      throw new RangeError(
        `Invalid multi-draw range; first and count are whole numbers, count a multiple of 3, inside the geometry's ${geometry.indices.length} indices`,
      );
};

/**
 * Index ranges of one merged core geometry drawn as one batch, each shown or hidden on its own: the many parts of a
 * building, a kit of props or a CAD assembly cost one core batch and one draw call (one per range where the device
 * has no multi-draw-indirect), and hiding a part writes 20 bytes instead of rebuilding the geometry. Every core mesh
 * of the geometry draws the shown ranges, so instance it as any core geometry. Runs on WebGPU and on the WebGL2
 * compatibility layer (one draw per range there).
 *
 * Shadows, replays and every other core draw of the batch draw the same ranges. Picking (`engine.pick`) draws the whole
 * geometry, hidden ranges included. A batch is redirected by one package at a time: do not also give the geometry
 * to `CulledMeshes`.
 *
 * @example
 * ```ts
 * import { MultiDraw } from '@margoengine/culling/multidraw';
 * const { geometry, ranges } = MultiDraw.merge([box(1, 1, 1), box(2, 0.2, 2), box(0.2, 3, 0.2)]);
 * engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial());
 * const parts = MultiDraw.attach(engine, geometry, ranges);
 * parts.setVisible(1, false); // the slab is hidden; the cube and the post draw
 * ```
 */
export class MultiDraw implements EnginePlugin {
  readonly name = 'multi-draw:' + ++serial;
  readonly geometry: Geometry;
  /** The ranges, in draw order (a copy of the ones given). */
  readonly ranges: readonly Readonly<DrawRange>[];
  disposed = false;
  private readonly asked?: boolean;
  private engine?: Engine;
  private device?: GPUDevice;
  private args?: GPUBuffer;
  private readonly redirect: Redirect;
  private readonly words: Uint32Array;
  private readonly shown: Uint8Array;
  private written = false;
  private oneCall = false;
  private batch?: Batch;

  /** Same as `engine.use(new MultiDraw(geometry, ranges, options))`; returns the plugin. */
  static attach(
    engine: EngineKernel,
    geometry: Geometry,
    ranges: readonly DrawRange[],
    options?: MultiDrawOptions,
  ): MultiDraw {
    const value = new MultiDraw(geometry, ranges, options);
    engine.use(value);
    return value;
  }
  /**
   * One geometry holding `geometries` one after another, and the index range of each, in order. Indices are offset
   * into the merged vertices, so a plain draw of the whole geometry (a pick) draws every part where it belongs.
   */
  static merge(geometries: readonly Geometry[]): { geometry: Geometry; ranges: DrawRange[] } {
    if (!Array.isArray(geometries) || !geometries.length || !geometries.every((g) => g instanceof Geometry))
      throw new TypeError('Invalid geometries to merge; pass one core Geometry or more');
    let vertices = 0,
      indices = 0;
    for (const g of geometries) {
      vertices += g.vertices.length / 6;
      indices += g.indices.length;
    }
    const positions = new Float32Array(vertices * 3),
      normals = new Float32Array(vertices * 3),
      merged = new Uint32Array(indices),
      ranges: DrawRange[] = [];
    let v = 0,
      i = 0;
    for (const g of geometries) {
      const n = g.vertices.length / 6;
      for (let k = 0; k < n; k++)
        for (let a = 0; a < 3; a++) {
          positions[(v + k) * 3 + a] = g.vertices[k * 6 + a];
          normals[(v + k) * 3 + a] = g.vertices[k * 6 + 3 + a];
        }
      for (let k = 0; k < g.indices.length; k++) merged[i + k] = g.indices[k] + v;
      ranges.push({ first: i, count: g.indices.length });
      v += n;
      i += g.indices.length;
    }
    return { geometry: new Geometry(positions, normals, merged), ranges };
  }
  constructor(geometry: Geometry, ranges: readonly DrawRange[], { multi }: MultiDrawOptions = {}) {
    checkRanges(geometry, ranges);
    if (multi !== undefined && typeof multi !== 'boolean')
      throw new TypeError('Invalid multi-draw options; set multi to true or false, or leave it out');
    this.geometry = geometry;
    this.ranges = ranges.map(({ first, count }) => Object.freeze({ first, count }));
    this.asked = multi;
    this.words = new Uint32Array(ranges.length * 5);
    this.shown = new Uint8Array(ranges.length).fill(1);
    for (let r = 0; r < ranges.length; r++) {
      this.words[r * 5] = ranges[r].count;
      this.words[r * 5 + 2] = ranges[r].first;
    }
    this.redirect = { instances: undefined as unknown as GPUBuffer, args: undefined as unknown as GPUBuffer };
  }
  /** True when the ranges draw in one multiDrawIndexedIndirect call (set at attach and at each device restore). */
  get multi(): boolean {
    return this.oneCall;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'MultiDraw is disposed; attach a new MultiDraw');
    const d = engine.gpu;
    if (!d)
      throw new MargoError(
        'unsupported',
        'MultiDraw requires WebGPU or the WebGL2 compatibility layer; see https://margoengine.com/errors#webgpu',
      );
    const has = d.features.has(MULTI_DRAW_FEATURE);
    if (this.asked && !has)
      throw new MargoError(
        'unsupported',
        `MultiDraw multi: true needs the '${MULTI_DRAW_FEATURE}' feature; request it in Engine.create features, or leave multi out`,
      );
    this.engine = engine;
    this.device = d;
    this.args = d.createBuffer({
      size: this.words.byteLength,
      usage: 264, // INDIRECT | COPY_DST
    });
    this.redirect.args = this.args;
    this.oneCall = this.asked ?? has;
    this.written = false;
  }
  registerPasses(graph: FrameGraph): void {
    // Before snapshot rendering's check (-1e-6), so a recording sees this frame's redirect.
    graph.add({
      name: this.name,
      order: -1e5,
      execute: (c) => {
        if (c.backend === 'webgpu' && c.batches) this.prepare(c);
      },
    });
  }
  /** Shows or hides range `index` for every mesh of the geometry. */
  setVisible(index: number, visible: boolean): this {
    this.check(index);
    if (typeof visible !== 'boolean') throw new TypeError('Invalid visible; pass true or false');
    if (this.shown[index] !== +visible) {
      this.shown[index] = +visible;
      this.written = false;
    }
    return this;
  }
  /** Whether range `index` draws. */
  isVisible(index: number): boolean {
    this.check(index);
    return this.shown[index] === 1;
  }
  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.ranges.length)
      throw new RangeError(`Invalid range index; pass 0 to ${this.ranges.length - 1}`);
  }
  /** Redirects the geometry's batch to the ranges and writes their instance counts when they changed. */
  private prepare(c: Context): void {
    const batches = c.batches!;
    let batch: Batch | undefined;
    for (let i = 0; i < batches.length && !batch; i++) if (batches[i].geometry === this.geometry) batch = batches[i];
    if (!batch || batch.claimed) return;
    const buffers = this.engine!.geometryBuffers(this.geometry);
    if (!buffers) return;
    const words = this.words,
      count = batch.count;
    for (let r = 0; r < this.ranges.length; r++) {
      const instances = this.shown[r] ? count : 0;
      if (words[r * 5 + 1] !== instances) {
        words[r * 5 + 1] = instances;
        this.written = false;
      }
    }
    if (!this.written) {
      this.device!.queue.writeBuffer(this.args!, 0, words as Uint32Array<ArrayBuffer>);
      this.written = true;
    }
    this.redirect.instances = buffers.instance;
    batch.redirect = this.redirect;
    batch.draws = this.ranges.length;
    batch.multi = this.oneCall;
    this.batch = batch;
  }
  private release(): void {
    if (this.batch?.redirect === this.redirect) this.batch.redirect = this.batch.draws = this.batch.multi = undefined;
    this.batch = undefined;
    this.args?.destroy();
    this.args = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
