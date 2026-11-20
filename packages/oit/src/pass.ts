/// <reference lib="esnext.disposable" preserve="true" />
// What every order-independent pass shares: the models it took over, its frame graph place and its life cycle.
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { PBRModel, PBRTransparency } from '@margoengine/gltf/pbr';
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

/**
 * KB3148e: sRGB transfer (IEC 61966-2-1) for the linear-light layers of the exact, peeled, moment and float32 passes,
 * and the over operator on linear values (Porter and Duff 1984): what a sorted `blendSpace: 'linear'` draw does, one
 * layer over the colour drawn so far.
 */
export const linearLight = /* wgsl */ `
fn decode(c:vec3f)->vec3f {let x=max(c,vec3f(0));return select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045));}
fn encode(c:vec3f)->vec3f {let x=max(c,vec3f(0));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>vec3f(0.0031308));}
fn overLinear(c:vec4f,d:vec4f)->vec4f {return vec4f(encode(decode(c.rgb)*c.a+decode(d.rgb)*(1-c.a)),c.a+d.a*(1-c.a));}
`;
/**
 * KB3148e: the composite of a weighted pass (moments, float32) over the pixels a linear layer touched, blending off.
 * `body` sets `avg` (encoded average colour), `cover` (coverage) and `mark` (1 where no linear layer drew).
 */
export const linearComposite = (maps: string, body: string) => /* wgsl */ `
${maps}
@group(0) @binding(9) var sceneMap:texture_2d<f32>;
${linearLight}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy); ${body}
  if(mark>=1.0){discard;}
  let d=textureLoad(sceneMap,q,0); let light=overLinear(vec4f(avg,cover),d);
  return vec4f(mix(light.rgb,avg*cover+d.rgb*(1-cover),mark),light.a);
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
  /** This frame's scene snapshot source, set when a `blendSpace: 'linear'` layer drew (KB3148d, KB3148e). */
  protected scene?: () => GPUTextureView;

  constructor(order: number) {
    if (!Number.isFinite(order) || order <= 0) throw new RangeError('OIT order must be > 0');
    this.order = order;
  }
  /** Draws a gltf\/pbr model's BLEND primitives (or a transparent materials mesh) order-independently. Returns a remover. */
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
  /**
   * @internal gltf/pbr transparency hook: a `blendSpace: 'linear'` layer drew this frame; `scene` copies the colour drawn
   * so far into the native glass snapshot and returns it (absent until the capture joins the frame graph).
   */
  linearLayers(scene?: () => GPUTextureView): void {
    if (scene) this.scene = scene;
  }
  /** @internal gltf\/pbr transparency hook. */
  abstract declarations(group: number): string;
  /** @internal gltf\/pbr transparency hook. */
  abstract bindings(): GPUBindGroupEntry[];
  /** @internal Effect hook: the declarations without what only a PBR surface has. */
  abstract surface(group: number): string;
  /** @internal Effect hook. */
  abstract readonly layout: readonly GPUBindGroupLayoutEntry[];
  /** @internal gltf\/pbr transparency hook: this frame's transparent pass, begun on the first transparent draw. */
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
    this.scene = undefined;
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
    this.engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
