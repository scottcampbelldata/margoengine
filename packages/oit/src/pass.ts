/// <reference lib="esnext.disposable" preserve="true" />
// What every order-independent pass shares: the models it took over, its frame graph place and its life cycle.
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { PBRModel, PBRTransparency } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
let serial = 0;

/** The part of an order-independent pass that `oit.add(model)` and `addMesh` work on: `OIT`, `ExactOIT` and `MomentOIT`. */
export abstract class TransparentPass implements EnginePlugin, PBRTransparency {
  readonly name = 'oit:' + serial++;
  readonly order: number;
  abstract readonly targets: readonly GPUColorTargetState[];
  protected engine?: Engine;
  /** Device of the current GPU resources, so a release after device restoration retires them on their own device. */
  protected device?: GPUDevice;
  protected disposed = false;
  protected readonly models = new Map<PBRModel, () => void>();
  protected context?: Context;
  protected pass?: GPURenderPassEncoder;

  constructor(order: number) {
    if (!Number.isFinite(order) || order <= 0) throw new RangeError('OIT order must be > 0');
    this.order = order;
  }
  /** Draws a gltf-pro model's BLEND primitives (or a transparent materials mesh) order-independently. Returns a remover. */
  add(model: PBRModel): () => void {
    if (this.disposed || !this.engine)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        this.disposed ? 'OIT is disposed; create a new OIT' : 'OIT.add needs OIT.attach(engine) first',
      );
    let release = this.models.get(model);
    if (!release) {
      const restore = model.setTransparency(this),
        forget = model.onDispose(() => this.models.delete(model));
      release = () => {
        if (this.models.get(model) === release) {
          this.models.delete(model);
          forget();
          restore();
        }
      };
      this.models.set(model, release);
    }
    return release;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'OIT is disposed; create a new OIT');
    if (!engine.gpu) throw new MargoError('unsupported', 'OIT requires WebGPU; use a WebGPU engine');
    this.engine = engine;
    this.device = engine.gpu;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.render(c);
      },
    });
  }
  /** @internal gltf-pro transparency hook. */
  abstract declarations(group: number): string;
  /** @internal gltf-pro transparency hook. */
  abstract bindings(): GPUBindGroupEntry[];
  /** @internal gltf-pro transparency hook: this frame's transparent pass, begun on the first transparent draw. */
  abstract begin(): GPURenderPassEncoder;
  protected abstract render(c: Context): void;
  /** Frees what depends on the render size. */
  protected abstract release(): void;
  /** Frees everything held on the current device. */
  protected abstract freeDevice(): void;
  /** Draws the added models into the pass `begin` opens and ends it. False when nothing drew. */
  protected drawModels(c: Context): boolean {
    this.context = c;
    this.pass = undefined;
    try {
      for (const model of this.models.keys()) model.draw(c, 'transparent', c.color, c.depth);
    } catch (error) {
      (this.pass as GPURenderPassEncoder | undefined)?.end();
      this.pass = undefined;
      throw error;
    } finally {
      this.context = undefined;
    }
    const pass = this.pass as GPURenderPassEncoder | undefined;
    if (!pass) return false;
    pass.end();
    this.pass = undefined;
    return true;
  }
  onDeviceRestored(engine: Engine): void {
    this.freeDevice();
    this.setup(engine);
  }
  /** Restores sorted blending on every added model and frees the GPU resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.models.values()]) release();
    this.freeDevice();
    this.engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
