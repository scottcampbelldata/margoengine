/// <reference lib="esnext.disposable" preserve="true" />
// DepthDownsample: the scene depth at a lower resolution, for effects that run there. Every output texel keeps one of
// the depths of its footprint, never a blend (a blend belongs to no surface). 'near' and 'far' are the conservative
// pyramid reductions (N. Greene, M. Kass and G. Miller, "Hierarchical Z-Buffer Visibility", SIGGRAPH 1993);
// 'checkerboard' alternates them so a depth-aware upsample finds both sides of an edge (L. Bavoil and J. Andersson,
// "Stable SSAO in Battlefield 3 with Selective Temporal Filtering", GDC 2012); 'representative' keeps the median
// depth, the sample on the surface that covers most of the footprint. J. Kopf et al., "Joint Bilateral Upsampling",
// SIGGRAPH 2007, is the upsampling such a depth guides.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { fullscreen, group } from '../../shared/gpu.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { viewLoadOp, viewRect } from '../../shared/view-rect.js';
import { DepthTexture } from './depth.js';
import type { SSRModel } from './ssr.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
const MODES = ['representative', 'near', 'far', 'checkerboard'] as const;
/** Which depth of a footprint a texel keeps: the median ('representative'), the nearest, the farthest, or the nearest
 * and farthest on alternate texels. */
export type DepthDownsampleMode = (typeof MODES)[number];

/** Options of {@link DepthDownsample}; all are read each frame (`order` at attachment). */
export interface DepthDownsampleOptions {
  /** `() => texture`: the depth to reduce, one sample a texel, a depth format or `r32float`, reversed Z (1 near, 0
   * far). Nothing is written while it returns undefined. Default a `DepthTexture` capture of its own. */
  depth?: () => GPUTexture | undefined;
  /** `() => texture`: normals, any size, such as a `SceneTargets` normal output; the normal at each kept texel is
   * written to {@link DepthDownsample.normalTexture}. Default none. */
  normal?: () => GPUTexture | undefined;
  /** Output size as a share of the source's, 0.0625 to 1. Default 0.5. */
  scale?: number;
  /** Output size in texels, overriding `scale` on that axis: whole numbers from 1/16 of the source up to the source.
   * Default from `scale`. */
  width?: number;
  /** As `width`. */
  height?: number;
  /** Default 'representative'. The other modes read the whole footprint; 'representative' takes the median of up to
   * 4 x 4 texels spread evenly over it. */
  mode?: DepthDownsampleMode;
  /** Frame-graph order of the pass. Default -4: after its own depth capture (at `order - 1`) and before the main pass,
   * so this frame's materials can read the result. A `depth` drawn by a later pass needs a later order. */
  order?: number;
  /** False writes nothing (the textures keep their last content). Default true. */
  enabled?: boolean;
}

const shader = (depth: boolean, normal: boolean) => `${fullscreen}
@group(0) @binding(0) var source:${depth ? 'texture_depth_2d' : 'texture_2d<f32>'};
@group(0) @binding(1) var<uniform> u:vec4u;
${normal ? '@group(0) @binding(2) var normals:texture_2d<f32>;' : ''}
struct Out {@location(0) depth:vec4f${normal ? ',@location(1) normal:vec4f' : ''}}
fn load(p:vec2u)->f32{return textureLoad(source,vec2i(p),0)${depth ? '' : '.x'};}
@fragment fn fragment(@builtin(position) at:vec4f)->Out {
 let size=vec2u(textureDimensions(source));let o=vec2u(at.xy);
 let begin=o*size/u.xy;let extent=max((o+vec2u(1))*size/u.xy,begin+vec2u(1))-begin;
 var kept=begin;var d=load(begin);
 if(u.z==0u){
  var depths:array<f32,16>;var places:array<vec2u,16>;var n=0u;let m=min(extent,vec2u(4));
  for(var y=0u;y<m.y;y++){for(var x=0u;x<m.x;x++){
   let p=begin+(vec2u(x,y)*2u+vec2u(1))*extent/(m*2u);let value=load(p);var i=n;
   while(i>0u){if(depths[i-1u]>=value){break;}depths[i]=depths[i-1u];places[i]=places[i-1u];i--;}
   depths[i]=value;places[i]=p;n++;
  }}
  d=depths[(n-1u)/2u];kept=places[(n-1u)/2u];
 }else{
  let near=u.z==1u||(u.z==3u&&((o.x+o.y)&1u)==0u);
  for(var y=0u;y<extent.y;y++){for(var x=0u;x<extent.x;x++){
   let p=begin+vec2u(x,y);let value=load(p);
   if(select((value<d),(value>d),near)){d=value;kept=p;}
  }}
 }
 var out:Out;out.depth=vec4f(d,0.0,0.0,1.0);
 ${normal ? 'let to=vec2u(textureDimensions(normals));out.normal=textureLoad(normals,vec2i(min(vec2u((vec2f(kept)+0.5)/vec2f(size)*vec2f(to)),to-vec2u(1))),0);' : ''}
 return out;
}`;

let instances = 0;
const within = (v: unknown, min: number, max: number) => typeof v === 'number' && v >= min && v <= max;

/**
 * Writes the scene depth (and optionally normals) at a lower resolution into textures of its own, for half-resolution
 * ambient occlusion, fog, particles and depth-aware upsampling.
 *
 * `texture` is `r32float` (reversed Z: 1 at the near plane, 0 far or empty; read with `textureLoad`), `normalTexture`
 * is `rgba16float` with the source normal's values. Both are replaced on resize and device restore (`onResize`).
 * @throws TypeError for an option of the wrong type; RangeError for a number or mode out of range (checked now and
 * every frame); MargoError `'unsupported'` without a GPU backend, `'disposed'` after `dispose()`, `'state'` for a
 * multisampled source.
 */
export class DepthDownsample implements EnginePlugin {
  readonly name = `depth-downsample:${++instances}`;
  private engine?: Engine;
  private capture?: DepthTexture;
  private disposed = false;
  private uniform?: GPUBuffer;
  private depthOut?: GPUTexture;
  private normalOut?: GPUTexture;
  private readonly values = new Uint32Array(4);
  private readonly pipelines = new Map<number, GPURenderPipeline>();
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();
  private readonly listeners = new Set<() => void>();
  private bound?: { key: number; source: GPUTexture; normal?: GPUTexture; group: GPUBindGroup };

  constructor(readonly options: DepthDownsampleOptions = {}) {
    this.check();
  }
  /** Same as `engine.use(new DepthDownsample(options))`; returns it. */
  static attach(engine: EngineKernel, options: DepthDownsampleOptions = {}): DepthDownsample {
    const effect = new DepthDownsample(options);
    engine.use(effect);
    return effect;
  }
  /** The reduced depth; undefined before the first frame. */
  get texture(): GPUTexture | undefined {
    return this.depthOut;
  }
  /** The normals at the kept texels; undefined without a `normal` source. */
  get normalTexture(): GPUTexture | undefined {
    return this.normalOut;
  }
  /** Calls `listener` after the textures are created, resized or replaced. Returns a remover. */
  onResize(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** Draws `model`'s own geometry into the owned depth capture (not with a `depth` source); returns a remover.
   * @throws MargoError `'state'` before attachment or with a `depth` source. */
  add(model: SSRModel): () => void {
    if (!this.capture) throw fault('state', 'Add models after attaching a DepthDownsample without a depth source');
    return this.capture.add(model);
  }
  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'DepthDownsample is disposed; create a new one', 'disposed');
    if (!engine.gpu) throw fault('unsupported', 'DepthDownsample needs WebGPU or the WebGL2 layer', 'webgpu');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: 0x40 | 0x8 });
    this.own();
  }
  /** A depth source removed after setup falls back to the owned capture before the next frame's passes run. */
  onPreUpdate(): void {
    if (this.engine) this.own();
  }
  private own(): void {
    if (this.options.depth || this.capture) return;
    const capture = new DepthTexture({ order: (this.options.order ?? -4) - 1 });
    this.engine!.use(capture);
    this.capture = capture;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: `${this.name}:pass`,
      order: this.options.order ?? -4,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private check(): void {
    const o = this.options,
      fail = (message: string): never => {
        throw rangeError(`Use DepthDownsample ${message}`, 'arguments');
      };
    for (const key of ['depth', 'normal'] as const)
      if (o[key] !== undefined && typeof o[key] !== 'function')
        throw typeError(`Use DepthDownsample ${key} as () => texture`, 'arguments');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw typeError('Use DepthDownsample enabled as true or false', 'arguments');
    if (o.scale !== undefined && !within(o.scale, 0.0625, 1)) fail('scale from 0.0625 to 1');
    for (const key of ['width', 'height'] as const)
      if (o[key] !== undefined && !(Number.isInteger(o[key]) && within(o[key], 1, 16384)))
        fail(`${key} as a whole number of texels, at least 1`);
    if (o.mode !== undefined && !MODES.includes(o.mode)) fail(`mode as one of ${MODES.join(', ')}`);
    if (o.order !== undefined && !Number.isFinite(o.order)) fail('order as a finite frame-graph order');
  }
  private draw(c: Context): void {
    this.check();
    const o = this.options;
    if (o.enabled === false) return;
    const source = o.depth ? o.depth() : this.capture?.texture,
      normal = o.normal?.();
    if (!source || (o.normal && !normal)) return;
    if ((source.sampleCount ?? 1) !== 1)
      throw fault('state', 'DepthDownsample reads one sample a texel; pass a resolved depth');
    const size = (axis: 'width' | 'height') => {
        const from = source[axis],
          to = o[axis] ?? Math.max(1, Math.ceil(from * (o.scale ?? 0.5)));
        if (to > from || to * 16 < from)
          throw rangeError(`Use DepthDownsample ${axis} from 1/16 of the source's ${from} up to it`, 'arguments');
        return to;
      },
      width = size('width'),
      height = size('height'),
      resized = this.depthOut?.width !== width || this.depthOut.height !== height || !!this.normalOut !== !!normal;
    if (resized) {
      this.depthOut?.destroy();
      this.normalOut?.destroy();
      const make = (format: GPUTextureFormat) =>
        c.device.createTexture({ size: [width, height], format, usage: 0x10 | 0x4 | 0x1 });
      this.depthOut = make('r32float');
      this.normalOut = normal ? make('rgba16float') : undefined;
    }
    const depth = source.format.startsWith('depth'),
      key = +depth + (normal ? 2 : 0);
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code: shader(depth, !!normal) }),
        targets: GPUColorTargetState[] = [{ format: 'r32float' }];
      if (normal) targets.push({ format: 'rgba16float' });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets },
      });
      this.pipelines.set(key, pipeline);
    }
    this.values.set([width, height, MODES.indexOf(o.mode ?? 'representative'), 0]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    if (this.bound?.key !== key || this.bound.source !== source || this.bound.normal !== normal) {
      const resources: GPUBindingResource[] = [
        this.view(source, depth ? 'depth-only' : 'all'),
        { buffer: this.uniform! },
      ];
      if (normal) resources.push(this.view(normal, 'all'));
      this.bound = { key, source, normal, group: group(c.device, pipeline, resources) };
    }
    const colorAttachments: GPURenderPassColorAttachment[] = [this.depthOut!, this.normalOut]
        .filter((t): t is GPUTexture => !!t)
        .map((t) => ({ view: this.view(t, 'all'), loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' })),
      pass = c.encoder.beginRenderPass({ colorAttachments });
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.bound.group);
      // A view's rectangle, scaled to the output: earlier views' texels stay.
      const rect = viewRect(c);
      if (rect) {
        const x = Math.floor((rect[0] * width) / c.width),
          y = Math.floor((rect[1] * height) / c.height);
        pass.setScissorRect(
          x,
          y,
          Math.ceil(((rect[0] + rect[2]) * width) / c.width) - x,
          Math.ceil(((rect[1] + rect[3]) * height) / c.height) - y,
        );
      }
      pass.draw(3);
    } finally {
      pass.end();
    }
    if (resized) for (const listener of this.listeners) listener();
  }
  private view(texture: GPUTexture, aspect: GPUTextureAspect): GPUTextureView {
    let view = this.views.get(texture);
    if (!view) this.views.set(texture, (view = texture.createView({ aspect })));
    return view;
  }
  private release(): void {
    this.uniform?.destroy();
    this.depthOut?.destroy();
    this.normalOut?.destroy();
    this.uniform = this.depthOut = this.normalOut = this.bound = undefined;
    this.pipelines.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = engine;
    this.uniform = engine.gpu!.createBuffer({ size: 16, usage: 0x40 | 0x8 });
  }
  /** Releases the textures and the owned capture. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    this.capture?.dispose();
    this.capture = undefined;
    this.release();
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
