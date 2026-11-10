/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Batch, Engine, EnginePlugin, FrameGraph, Geometry, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { exactShader } from './pyramid.js';
import { localBox, SoftwareDepthBuffer } from './software-depth.js';
export { SoftwareDepthBuffer } from './software-depth.js';
export type { TriangleGeometry } from './software-depth.js';

/** Conservative CPU occlusion settings, usable on WebGL2's full compatibility layer and native WebGPU. */
export interface WebGL2CullingOptions {
  /** Square software depth resolution, 1 to 2048. Default 128; smaller buffers keep more visible candidates. */
  resolution?: number;
}
interface Slot {
  instances: GPUBuffer;
  args: GPUBuffer;
  packed: Float32Array;
  capacity: number;
  count: number;
}
let serial = 0;
/** Current-frame occlusion of opaque core meshes without GPU readbacks or delayed query results. */
export class WebGL2Culling implements EnginePlugin {
  readonly name = 'software-culling:' + ++serial;
  disposed = false;
  /** Toggle at runtime. Default true. */
  enabled = true;
  private engine?: Engine;
  private depth: SoftwareDepthBuffer;
  private boxes = new WeakMap<Geometry, Float64Array>();
  private slots = new Map<Geometry, Slot>();
  private views = new Map<string, Map<Geometry, Slot>>();
  private redirected: Batch[] = [];
  private args = new Uint32Array(5);
  constructor({ resolution = 128 }: WebGL2CullingOptions = {}) {
    this.depth = new SoftwareDepthBuffer(resolution, resolution);
  }
  /** Attach before starting the engine. Do not combine multiple redirect owners for the same batches. */
  static attach(engine: EngineKernel, options?: WebGL2CullingOptions): WebGL2Culling {
    const plugin = new WebGL2Culling(options);
    engine.use(plugin);
    return plugin;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'WebGL2Culling is disposed; create a new plugin');
    requireWebGPU(engine, 'WebGL2Culling');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: -999999, execute: (c) => this.cull(c) });
  }
  /** Number of kept instances in each batch in the last frame. No GPU readback. */
  readCounts(): Map<Geometry, number> {
    return new Map([...this.slots].map(([g, s]) => [g, s.count]));
  }
  private restore(): void {
    for (const batch of this.redirected) batch.redirect = undefined;
    this.redirected.length = 0;
  }
  private cull(c: PassContext): void {
    this.restore();
    if (c.backend !== 'webgpu') return;
    const view = c.view?.id ?? '';
    let slots = this.views.get(view);
    if (!slots) this.views.set(view, (slots = new Map()));
    this.slots = slots;
    const active = (c.batches ?? []).filter((b) => b.count && !b.claimed && !b.redirect),
      depth = this.depth,
      device = c.device;
    depth.clear(c.camera.matrix);
    const enabled = this.enabled && exactShader(c.shader);
    if (enabled)
      for (const batch of active)
        for (let i = 0; i < batch.count; i++) {
          const row = batch.instances.subarray(i * 24, i * 24 + 24);
          depth.rasterize(batch.geometry, row, row[22] >= 0.5);
        }
    const live = new Set<Geometry>();
    for (const batch of active) {
      const g = batch.geometry;
      live.add(g);
      let box = this.boxes.get(g);
      if (!box) {
        box = localBox(g);
        this.boxes.set(g, box);
      }
      let s = this.slots.get(g);
      if (!s || s.capacity < batch.count) {
        s?.instances.destroy();
        s?.args.destroy();
        const capacity = Math.max(1, batch.count * 2);
        s = {
          capacity,
          count: 0,
          packed: new Float32Array(capacity * 24),
          instances: device.createBuffer({ size: capacity * 96, usage: 32 | 8 }),
          args: device.createBuffer({ size: 20, usage: 256 | 128 | 4 | 8 }),
        };
        this.slots.set(g, s);
      }
      let kept = 0;
      for (let i = 0; i < batch.count; i++) {
        const row = batch.instances.subarray(i * 24, i * 24 + 24);
        if (!enabled || depth.visible(box, row)) s.packed.set(row, kept++ * 24);
      }
      s.count = kept;
      if (kept) device.queue.writeBuffer(s.instances, 0, s.packed as Float32Array<ArrayBuffer>, 0, kept * 24);
      this.args[0] = g.indices.length;
      this.args[1] = kept;
      device.queue.writeBuffer(s.args, 0, this.args as Uint32Array<ArrayBuffer>);
      batch.redirect = { instances: s.instances, args: s.args };
      this.redirected.push(batch);
    }
    for (const [g, s] of this.slots)
      if (!live.has(g)) {
        s.instances.destroy();
        s.args.destroy();
        this.slots.delete(g);
      }
  }
  private release(): void {
    this.restore();
    for (const slots of this.views.values())
      for (const s of slots.values()) {
        s.instances.destroy();
        s.args.destroy();
      }
    this.views.clear();
    this.slots.clear();
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
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
