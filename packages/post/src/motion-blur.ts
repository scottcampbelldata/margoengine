/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { render, compute, group as bind } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { PostStack } from './stack.js';
import { vertex } from './hiz.js';
import { applyView, fromTarget, viewLoadOp } from '../../shared/view-rect.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Per-pixel motion for {@link MotionBlur}: what `@margoengine/taa`'s `taa.velocity` returns, or your own. */
export interface MotionVectors {
  /** Viewport-sized two-channel float texture (`rg16float`): current minus previous position per pixel, in uv. */
  readonly texture: GPUTexture;
  /** Part of every vector that is not motion, in uv (TAA's jitter difference); subtracted. Default none. */
  readonly jitter?: ArrayLike<number>;
  /** TAA's resolved frame. When present MotionBlur leaves the stack's frame alone (so TAA's history never holds a
   * blurred frame) and blurs this one after TAA's resolve, into the canvas. */
  readonly resolved?: GPUTexture;
}
/** Options of {@link MotionBlur}; all but `velocity` may change per frame. */
export interface MotionBlurOptions {
  /** This frame's motion vectors, e.g. `() => taa.velocity`; undefined skips the blur for the frame. */
  velocity: () => MotionVectors | undefined;
  /** Exposure as a share of the frame interval, 0-1 (0.5 is a 180-degree shutter). Default 0.5. */
  shutter?: number;
  /** Longest blur radius in pixels, 1-128; also the tile size of the velocity search. Default 32. */
  maxBlur?: number;
  /** Samples per pixel along the motion, 2-64. Default 16. */
  samples?: number;
  /** False skips the effect (the scene passes through). Default true; also `motionBlur.enabled`. */
  enabled?: boolean;
}

// Reconstruction after McGuire, Hennessy, Bukowski and Osman 2012 ("A Reconstruction Filter for Plausible Motion Blur"):
// blur radii per pixel (half the motion over the open shutter, at most maxBlur), the largest per tile, the largest over
// each tile's 3x3 neighbourhood, then a gather along that neighbourhood maximum. Each sample is classified by depth: a
// sample in front whose own blur reaches the pixel, or one behind while the pixel's own blur reaches it, shows; any other
// share stays the pixel's own colour. A rigidly moving surface over a still one therefore gets exactly the shutter's box:
// the share of samples landing on it.
const uniforms = `
struct M {inverse:mat4x4f,eye:vec4f,size:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> m:M;
fn radius(p:vec2i)->vec2f {
let v=(textureLoad(velocity,p,0).xy-m.params.zw)*m.size.xy*m.params.x;let l=length(v);
return select(v,v*(m.params.y/l),l>m.params.y);
}
`;
const tileShader = `
@group(0) @binding(1) var velocity:texture_2d<f32>;
@group(0) @binding(2) var tiles:texture_storage_2d<rgba16float,write>;
${uniforms}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
let count=textureDimensions(tiles);if(any(id.xy>=count)){return;}
let k=i32(m.size.z);let base=vec2i(id.xy)*k;let size=vec2i(m.size.xy);var best=vec2f(0);var most=0.0;
for(var y=0;y<k;y++){for(var x=0;x<k;x++){let p=base+vec2i(x,y);if(any(p>=size)){continue;}let v=radius(p);let l=dot(v,v);if(l>most){most=l;best=v;}}}
textureStore(tiles,vec2i(id.xy),vec4f(best,0,0));
}`;
const neighbourShader = `
@group(0) @binding(0) var tiles:texture_2d<f32>;
@group(0) @binding(1) var neighbours:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
let count=vec2i(textureDimensions(neighbours));let p=vec2i(id.xy);if(any(p>=count)){return;}
var best=vec2f(0);var most=0.0;
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let v=textureLoad(tiles,clamp(p+vec2i(x,y),vec2i(0),count-1),0).xy;let l=dot(v,v);if(l>most){most=l;best=v;}}}
textureStore(neighbours,p,vec4f(best,0,0));
}`;
// OUTPUT: 0 linear (HDR stage), 1 Margo's display transform (last stage), 2 sRGB encoding only (after TAA, unorm canvas),
// 3 as is (after TAA, float canvas).
const reconstructShader = (output: number) =>
  vertex +
  `
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var velocity:texture_2d<f32>;
@group(0) @binding(3) var neighbours:texture_2d<f32>;
@group(0) @binding(4) var depth:texture_depth_2d;
${uniforms}${output === 1 ? displayShader : ''}
fn encode(c:vec4f)->vec4f {${
    output === 1
      ? 'return vec4f(toDisplay(c.rgb),c.a);'
      : output === 2
        ? 'let x=max(c.rgb,vec3f(0));return vec4f(select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308)),c.a);'
        : 'return c;'
  }}
fn away(p:vec2i)->f32 {
let d=textureLoad(depth,p,0);if(d<=0.0){return 1e30;}let q=(vec2f(p)+0.5)/m.size.xy;
let w=m.inverse*vec4f(q.x*2.0-1.0,1.0-q.y*2.0,d,1.0);return distance(w.xyz/w.w,m.eye.xyz);
}
// 1 when a is in front of b (or within 1% of b's distance), 0 when clearly behind.
fn front(a:f32,b:f32)->f32 {return clamp(1.0-(a-b)/(0.01*min(a,b)+1e-4),0.0,1.0);}
// 1 within a blur radius r, fading out over 10% of it.
fn reach(d:f32,r:f32)->f32 {return clamp((1.05*r-d)/(0.1*r+1e-4),0.0,1.0);}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let p=vec2i(frag.xy);let c=textureLoad(scene,p,0);let k=i32(m.size.z);
let vn=textureLoad(neighbours,p/k,0).xy;if(m.size.w<0.5||length(vn)<0.5){return encode(c);}
let vx=length(radius(p));let zx=away(p);let n=i32(m.size.w);let limit=vec2i(m.size.xy)-1;
// Interleaved gradient noise (Jimenez 2014) staggers the samples per pixel; it does not change between frames.
let j=fract(52.9829189*fract(dot(vec2f(p),vec2f(0.06711056,0.00583715))))-0.5;var sum=vec3f(0);
for(var i=0;i<n;i++){
let t=(f32(i)+0.5+j)/f32(n)*2.0-1.0;let q=clamp(vec2i(floor(vec2f(p)+0.5+vn*t)),vec2i(0),limit);
let d=length(vn)*abs(t);let zy=away(q);
let w=min(1.0,front(zy,zx)*reach(d,length(radius(q)))+front(zx,zy)*reach(d,vx));
sum+=mix(c.rgb,textureLoad(scene,q,0).rgb,w);
}
return encode(vec4f(sum/f32(n),c.a));
}`;
const copyShader = (output: number) =>
  vertex +
  `@group(0) @binding(0) var scene:texture_2d<f32>;${output === 1 ? displayShader : ''}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {let c=textureLoad(scene,vec2i(frag.xy),0);return ${output === 1 ? 'vec4f(toDisplay(c.rgb),c.a)' : 'c'};}`;

/**
 * Motion blur in a {@link PostStack} (HDR effect), fed by per-pixel motion vectors: `new MotionBlur({velocity: () =>
 * taa.velocity})` with `@margoengine/taa`, or any viewport-sized velocity texture. Without TAA it blurs the stack's
 * linear HDR frame. With TAA's vectors (they carry `resolved`) it blurs TAA's resolved frame after TAA (frame-graph order
 * 41) and leaves the stack's frame alone, so no blurred frame enters TAA's history.
 */
export class MotionBlur implements EnginePlugin {
  readonly name = 'motion-blur';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private uniform?: GPUBuffer;
  private tilePipeline?: GPUComputePipeline;
  private neighbourPipeline?: GPUComputePipeline;
  private tiles: GPUTexture[] = [];
  private tileViews: GPUTextureView[] = [];
  private tileSize = 0;
  private width = 0;
  private height = 0;
  private velocityTexture?: GPUTexture;
  private velocityView?: GPUTextureView;
  private depthTexture?: GPUTexture;
  private depthView?: GPUTextureView;
  private tileGroups: GPUBindGroup[] = [];
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  // Per pipeline, one bind group per input view (TAA's resolved frame alternates between two histories).
  private readonly groups = new Map<GPURenderPipeline, Map<GPUTextureView, GPUBindGroup>>();
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();
  private readonly values = new Float32Array(28);
  private readonly workspace = new Float64Array(52);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly pass: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(readonly options: MotionBlurOptions) {
    if (!options || typeof options.velocity !== 'function')
      throw new TypeError('MotionBlur needs options.velocity, a function returning motion vectors (taa.velocity)');
    this.validate();
  }
  /** Alone, MotionBlur runs in its own one-effect PostStack; to combine it, put it in your PostStack. */
  static attach(engine: EngineKernel, options: MotionBlurOptions): MotionBlur {
    const effect = new MotionBlur(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('MotionBlur enabled must be boolean');
    this.options.enabled = value;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', 'MotionBlur is already attached; create another MotionBlur for another stack');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options,
      shutter = o.shutter ?? 0.5,
      blur = o.maxBlur ?? 32,
      samples = o.samples ?? 16;
    if (
      !(shutter >= 0 && shutter <= 1) ||
      !(blur >= 1 && blur <= 128) ||
      !Number.isInteger(samples) ||
      samples < 2 ||
      samples > 64 ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new RangeError('Invalid MotionBlur options; shutter must be 0-1, maxBlur 1-128 pixels, samples 2-64.');
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'MotionBlur is disposed; create a new MotionBlur');
    if (!this.host)
      throw margoError(
        'state',
        'MotionBlur runs in a PostStack: use MotionBlur.attach(engine, options) or PostStack.attach(engine, [..., new MotionBlur(options)])',
      );
    if (!engine.gpu)
      throw margoError('unsupported', 'MotionBlur requires WebGPU; see https://margoengine.com/errors#webgpu');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.tilePipeline = compute(engine.gpu, tileShader);
    this.neighbourPipeline = compute(engine.gpu, neighbourShader);
  }
  registerPasses(graph: FrameGraph): void {
    // TAA resolves at 40 (after the stack composes at 30); with its vectors the blur runs on its resolved frame here.
    graph.add({
      name: 'motion-blur:after-taa',
      order: 41,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.enabled || !this.host?.target) return;
        const vectors = this.options.velocity();
        if (!vectors?.resolved) return;
        if (!this.prepare(c, vectors)) return;
        const output = c.format === 'rgba8unorm' || c.format === 'bgra8unorm' ? 2 : 3;
        let view = this.views.get(vectors.resolved);
        if (!view) this.views.set(vectors.resolved, (view = vectors.resolved.createView()));
        this.draw(c, view, c.color, c.format, c.descriptor.multisample ?? { count: 1 }, output);
      },
    });
  }
  /** Uploads this frame's uniforms and finds the per-tile radii; false when there is nothing to blur with. */
  private prepare(c: Context, vectors: MotionVectors): boolean {
    this.validate();
    const v = vectors.texture,
      depth = this.host!.depthTexture;
    if (
      !v ||
      v.width !== c.width ||
      v.height !== c.height ||
      v.dimension !== '2d' ||
      v.sampleCount !== 1 ||
      !(v.usage & GPUTextureUsage.TEXTURE_BINDING)
    )
      throw margoError('state', 'MotionBlur velocity needs a viewport-sized sampleable 2D texture; pass taa.velocity');
    if (!depth) return false;
    const o = this.options,
      k = Math.ceil(o.maxBlur ?? 32),
      jitter = vectors.jitter,
      values = this.values;
    if (!invertMatrixStable(c.camera.matrix, values.subarray(0, 16), this.workspace))
      throw margoError('state', 'Invalid MotionBlur camera: its matrix cannot be inverted; use an invertible camera.');
    // The inverse takes full-target pixels (the velocity and depth textures) back to world space.
    fromTarget(c, values);
    values.set(c.camera.position, 16);
    values[19] = 0;
    values[20] = c.width;
    values[21] = c.height;
    values[22] = k;
    values[23] = o.samples ?? 16;
    values[24] = (o.shutter ?? 0.5) * 0.5;
    values[25] = o.maxBlur ?? 32;
    values[26] = jitter?.[0] ?? 0;
    values[27] = jitter?.[1] ?? 0;
    c.device.queue.writeBuffer(this.uniform!, 0, values as Float32Array<ArrayBuffer>);
    if (this.width !== c.width || this.height !== c.height || this.tileSize !== k) {
      for (const t of this.tiles) t.destroy();
      this.tiles = [];
      this.tileSize = this.width = this.height = 0;
      this.velocityTexture = undefined;
      this.groups.clear();
      const size = [Math.ceil(c.width / k), Math.ceil(c.height / k)];
      for (let i = 0; i < 2; i++)
        this.tiles.push(
          c.device.createTexture({
            size,
            format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
          }),
        );
      this.tileViews = this.tiles.map((t) => t.createView());
      this.width = c.width;
      this.height = c.height;
      this.tileSize = k;
    }
    if (this.velocityTexture !== v) {
      this.velocityView = v.createView();
      this.tileGroups = [
        bind(c.device, this.tilePipeline!, [{ buffer: this.uniform! }, this.velocityView, this.tileViews[0]]),
        bind(c.device, this.neighbourPipeline!, [this.tileViews[0], this.tileViews[1]]),
      ];
      this.velocityTexture = v;
      this.groups.clear();
    }
    if (this.depthTexture !== depth) {
      this.depthView = depth.createView({ aspect: 'depth-only' });
      this.depthTexture = depth;
      this.groups.clear();
    }
    const pass = c.encoder.beginComputePass(),
      tiles = [this.tiles[0].width, this.tiles[0].height];
    for (let i = 0; i < 2; i++) {
      pass.setPipeline(i ? this.neighbourPipeline! : this.tilePipeline!);
      pass.setBindGroup(0, this.tileGroups[i]);
      pass.dispatchWorkgroups(Math.ceil(tiles[0] / 8), Math.ceil(tiles[1] / 8));
    }
    pass.end();
    return true;
  }
  private draw(
    c: Context,
    input: GPUTextureView,
    view: GPUTextureView,
    format: GPUTextureFormat,
    multisample: GPUMultisampleState,
    output: number,
    copy = false,
  ): void {
    const key = (copy ? 'copy:' : '') + output + format + multisample.count;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(c.device, copy ? copyShader(output) : reconstructShader(output), format, { multisample });
      this.pipelines.set(key, pipeline);
    }
    let byInput = this.groups.get(pipeline);
    if (!byInput) this.groups.set(pipeline, (byInput = new Map()));
    let group = byInput.get(input);
    if (!group) {
      if (byInput.size >= 4) byInput.clear();
      group = bind(
        c.device,
        pipeline,
        copy ? [input] : [{ buffer: this.uniform! }, input, this.velocityView!, this.tileViews[1], this.depthView!],
      );
      byInput.set(input, group);
    }
    this.attachment.view = view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.pass);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private stage(c: Context, input: GPUTextureView, output: StageOutput): void {
    const vectors = this.enabled ? this.options.velocity() : undefined,
      encoding = output.hdr ? 0 : 1;
    // Nothing to blur here (no vectors, or TAA's: blurred after its resolve): copy the input through. Handing the input
    // view on instead would break the stack's ping-pong (the next stage may write the slot it reads).
    if (!vectors || vectors.resolved || !this.prepare(c, vectors)) {
      this.draw(c, input, output.view, output.format, output.multisample, encoding, true);
      return;
    }
    this.draw(c, input, output.view, output.format, output.multisample, encoding);
  }
  private release(): void {
    for (const t of this.tiles) t.destroy();
    this.tiles = [];
    this.tileViews = [];
    this.tileGroups = [];
    this.tileSize = this.width = this.height = 0;
    this.velocityTexture = this.depthTexture = undefined;
    this.velocityView = this.depthView = undefined;
    this.pipelines.clear();
    this.groups.clear();
    this.attachment.view = undefined!;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.uniform?.destroy();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stack = this.stack;
    this.stack = undefined;
    this.engine?.removePlugin(this.name);
    this.release();
    this.uniform?.destroy();
    this.uniform = undefined;
    this.engine = undefined;
    stack?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
