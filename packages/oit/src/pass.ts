/// <reference lib="esnext.disposable" preserve="true" />
// What every order-independent pass shares: the models it took over, its frame graph place and its life cycle.
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { PBRModel, PBRTransparency } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import type { SurfaceTransparency } from '../../shared/pass.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
let serial = 0;

/** A drawable that is no PBR surface and can feed an order-independent pass: `VFX`, `Splats`, `PointsPlugin`. */
export interface TransparentEffect {
  /** Leaves the effect's own drawing for `drawTransparent`. Returns a remover; `released` runs if the effect is disposed first. */
  setTransparency(hook: SurfaceTransparency, released?: () => void): () => void;
  /** Draws into `hook`'s pass; a pass may ask twice in one frame. */
  drawTransparent(c: Context, hook: SurfaceTransparency): void;
}
/** What every PBR surface passes on to `margoTransparentAt`. */
export const pbrLayer = `fn margoTransparent(color:vec4f,i:Out)->MargoTransparent {
  return margoTransparentAt(color,i.clip,-(f.view*vec4f(i.position,1)).z);
}
`;

/** The part of an order-independent pass that `oit.add(model)` and `addMesh` work on: `OIT`, `ExactOIT` and `MomentOIT`. */
export abstract class TransparentPass implements EnginePlugin, PBRTransparency, SurfaceTransparency {
  readonly name = 'oit:' + serial++;
  readonly order: number;
  abstract readonly targets: readonly GPUColorTargetState[];
  protected engine?: Engine;
  /** Device of the current GPU resources, so a release after device restoration retires them on their own device. */
  protected device?: GPUDevice;
  protected disposed = false;
  protected readonly models = new Map<PBRModel, () => void>();
  /** @internal Effects added with `addEffect` (`@margoengine/oit/vfx`) and their removers. */
  readonly effects = new Map<TransparentEffect, () => void>();
  protected context?: Context;
  protected pass?: GPURenderPassEncoder;

  constructor(order: number) {
    if (!Number.isFinite(order) || order <= 0) throw new RangeError('OIT order must be > 0');
    this.order = order;
  }
  /** Draws a gltf-pro model's BLEND primitives (or a transparent materials mesh) order-independently. Returns a remover. */
  add(model: PBRModel): () => void {
    this.ready();
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
  /** @internal Throws unless the pass can take something to draw. */
  ready(): void {
    if (this.disposed || !this.engine)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        this.disposed ? 'OIT is disposed; create a new OIT' : 'OIT.add needs OIT.attach(engine) first',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'OIT is disposed; create a new OIT');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'OIT requires WebGPU; use a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
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
  /** @internal Effect hook: the declarations without what only a PBR surface has. */
  abstract surface(group: number): string;
  /** @internal Effect hook. */
  abstract readonly layout: readonly GPUBindGroupLayoutEntry[];
  /** @internal gltf-pro transparency hook: this frame's transparent pass, begun on the first transparent draw. */
  abstract begin(): GPURenderPassEncoder;
  protected abstract render(c: Context): void;
  /** Whether nothing was added. */
  protected get empty(): boolean {
    return !this.models.size && !this.effects.size;
  }
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
      for (const effect of this.effects.keys()) effect.drawTransparent(c, this);
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
    for (const release of [...this.models.values(), ...this.effects.values()]) release();
    this.freeDevice();
    this.engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
