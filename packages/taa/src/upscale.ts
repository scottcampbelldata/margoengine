/// <reference lib="esnext.disposable" preserve="true" />
import { temporalCameraSource } from '../../shared/temporal-camera.js';
// Temporal upscaling: the scene renders jittered at a lower size and accumulates at output size. Sample weights and
// the jitter idea after B. Karis, "High Quality Temporal Supersampling" (SIGGRAPH 2014); the neighbourhood range after
// M. Salvi, "An Excursion in Temporal Supersampling" (GDC 2016, variance clipping); history reads with a Catmull-Rom
// spline (Catmull & Rom 1974). A sample counts by its distance in output pixels, so jittered samples land as detail. The sharpen
// (./cas.ts, shared with `Sharpen`) is an unsharp mask whose strength falls as a pixel's neighbours near the ends of the
// display range. The spatial path is Lanczos-2 (Duchon 1979).
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { SceneTarget } from '../../shared/msaa.js';
import { halton } from './jitter.js';
import { color, fullscreen } from './shader.js';
import { sharpenCode } from './cas.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; STORAGE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link TAAUpscale}; the object is kept and read every frame. */
export interface TAAUpscaleOptions {
  /** Render size as a share of the output size, 0.25 to 1. Default 0.67. */
  scale?: number;
  /** False skips the jitter and history and upscales each frame with a Lanczos filter. Default true. */
  temporal?: boolean;
  /** Share of the history in each frame, 0 <= w < 1. Default 0.9. */
  historyWeight?: number;
  /** Relative reversed-depth difference that rejects history, which removes most ghosts on moving objects, 0 to 1. Default 0.01. */
  depthThreshold?: number;
  /** Width of the colour range history may keep, in standard deviations of the 3x3 neighbourhood, above 0. Lower ghosts less and flickers more. Default 1.5. */
  clampGamma?: number;
  /** Sharpening of the output, 0 (off) to 1. Default 0.2. */
  sharpen?: number;
}

const uniforms = `struct U {jittered:mat4x4f,inverse:mat4x4f,previous:mat4x4f,a:vec4f,b:vec4f}
@group(0) @binding(0) var<uniform> u:U;`;

const resolve = `${uniforms}${color}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var history:texture_2d<f32>;
@group(0) @binding(4) var historyDepth:texture_2d<f32>;
@group(0) @binding(5) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var outputDepth:texture_storage_2d<r32float,write>;
fn cubic(t:f32)->vec4f {let s=t*t;let c=s*t;return vec4f(-0.5*c+s-0.5*t,1.5*c-2.5*s+1,-1.5*c+2*s+0.5*t,0.5*c-0.5*s);}
fn old(at:vec2f,top:vec2i)->vec3f {
 let q=at-0.5;let base=vec2i(floor(q));let wx=cubic(q.x-floor(q.x));let wy=cubic(q.y-floor(q.y));var sum=vec3f(0);
 for(var y=0;y<4;y++){for(var x=0;x<4;x++){sum+=textureLoad(history,clamp(base+vec2i(x-1,y-1),vec2i(0),top),0).rgb*wx[x]*wy[y];}}
 return sum;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 let size=vec2f(textureDimensions(output));if(any(vec2f(id.xy)>=size)){return;}
 let p=vec2i(id.xy);let low=u.b.zw;let uv=(vec2f(id.xy)+0.5)/size;let at=uv*low;let base=vec2i(floor(at));let top=vec2i(low)-1;
 let f=size/low;var wide=vec3f(0);var wideTotal=0.0;var sum=vec3f(0);var total=0.0;var peak=0.0;var m1=vec3f(0);var m2=vec3f(0);var near=0.0;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let n=base+vec2i(x,y);let q=clamp(n,vec2i(0),top);let s=linear(textureLoad(scene,q,0).rgb);
  let d=vec2f(n)+0.5-u.b.xy-at;let o=d*f;let w=exp(-2.29*dot(o,o));let g=exp(-2.29*dot(d,d));
  sum+=s*w;total+=w;peak=max(peak,w);wide+=s*g;wideTotal+=g;let c=ycocg(s);m1+=c;m2+=c*c;near=max(near,textureLoad(depth,q,0));
 }}
 let soft=wide/wideTotal;let current=select(soft,sum/total,total>0.05);var result=soft;
 if(u.a.w>0){
  var back=uv;var expected=0.0;
  if(near>0){
   let world=u.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),near,1);let last=u.previous*world;
   back=last.xy/last.w*vec2f(0.5,-0.5)+0.5;expected=last.z/last.w;
  }
  if(all(back>=vec2f(0))&&all(back<vec2f(1))){
   let found=textureLoad(historyDepth,vec2i(back*size),0).r;
   if(abs(found-expected)<=max(0.000001,u.a.y*max(found,expected))){
    let mean=m1/9;let spread=sqrt(max(m2/9-mean*mean,vec3f(0)))*u.a.z;
    let kept=rgb(clamp(ycocg(old(back*size,vec2i(size)-1)),mean-spread,mean+spread));
    result=mix(kept,current,min(1,(1-u.a.x)*peak*f.x*f.y));
   }
  }
 }
 textureStore(output,p,vec4f(max(result,vec3f(0)),1));textureStore(outputDepth,p,vec4f(near));
}`;

const spatial = `${uniforms}${color}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(5) var output:texture_storage_2d<rgba16float,write>;
fn lanczos(x:f32)->f32 {let a=abs(x);if(a<0.0001){return 1;}if(a>=2){return 0;}let t=3.14159265*a;return 2*sin(t)*sin(t/2)/(t*t);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 let size=vec2f(textureDimensions(output));if(any(vec2f(id.xy)>=size)){return;}
 let low=u.b.zw;let at=(vec2f(id.xy)+0.5)/size*low-0.5;let base=vec2i(floor(at));let top=vec2i(low)-1;
 var sum=vec3f(0);var total=0.0;var lo=vec3f(1e30);var hi=vec3f(-1e30);
 for(var y=-1;y<=2;y++){for(var x=-1;x<=2;x++){
  let n=base+vec2i(x,y);let s=linear(textureLoad(scene,clamp(n,vec2i(0),top),0).rgb);let d=vec2f(n)-at;let w=lanczos(d.x)*lanczos(d.y);
  sum+=s*w;total+=w;
  if(x>=0&&x<=1&&y>=0&&y<=1){lo=min(lo,s);hi=max(hi,s);}
 }}
 textureStore(output,vec2i(id.xy),vec4f(clamp(sum/total,lo,hi),1));
}`;

const present = `${fullscreen}
override manualSRGB:bool=true;
@group(0) @binding(0) var<uniform> sharpen:vec4f;
@group(0) @binding(1) var image:texture_2d<f32>;
${sharpenCode}
@fragment fn fragment(i:Fullscreen)->@location(0) vec4f {
 let out=max(margoSharpen(image,vec2i(i.clip.xy-sharpen.zw),sharpen.x),vec3f(0));
 return vec4f(select(out,select(out*12.92,1.055*pow(out,vec3f(1.0/2.4))-0.055,out>=vec3f(0.0031308)),manualSRGB),1);
}`;

/**
 * Renders the scene below output size and rebuilds the full frame: temporally from jittered frames, or with Lanczos
 * when `temporal` is false. Everything from the main pass to the end of a PostStack runs at the lower size, so effects
 * get cheaper too. Feed `scale` from `ResolutionScaler` for dynamic resolution. Runs instead of `TAA`, not with it.
 * Plugins that draw after frame-graph order 39 draw over the full frame without the scene's depth.
 * Object motion is rejected through depth and the colour range, so fast thin objects can ghost more than with `TAA`,
 * which draws per-object velocity.
 * @throws RangeError when an option is out of range (checked now and every frame); MargoError `'unsupported'` without
 * WebGPU, with `TAA` attached or in a multi-view frame, `'disposed'` after `dispose()`, `'state'` on a camera with no inverse.
 */
export class TAAUpscale implements EnginePlugin {
  readonly name = 'taa-upscale';
  private engine?: Engine;
  private disposed = false;
  private uniform?: GPUBuffer;
  private sharpenUniform?: GPUBuffer;
  private cameraBinding?: GPUBindGroupEntry;
  protected readonly values = new Float32Array(56);
  private readonly last = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly sharpenValue = new Float32Array(4);
  private scene?: GPUTexture;
  protected depth?: GPUTexture;
  private target?: SceneTarget;
  private lowTextures: GPUTexture[] = [];
  private histories: GPUTexture[] = [];
  private depths: GPUTexture[] = [];
  private resolvePipeline?: GPUComputePipeline;
  private spatialPipeline?: GPUComputePipeline;
  private presentPipeline?: GPURenderPipeline;
  private presentKey = '';
  private resolveGroups: GPUBindGroup[] = [];
  private spatialGroups: GPUBindGroup[] = [];
  private presentGroups: GPUBindGroup[] = [];
  private front = 0;
  private frame = 0;
  protected valid = false;
  private manual = '';
  private originalCamera?: Context['camera'];
  private cameraView?: Context['camera'];
  private saved?: { width: number; height: number };

  /** Output rectangle used by optional view-aware upscalers. */
  protected outputView?: Context['view'];

  /** Specialises the temporal resolve without loading an optional renderer in this entry. */
  protected resolveCode(code: string): string {
    return code;
  }

  /** Additional resources of an optional temporal resolve. */
  protected resolveEntries(): GPUBindGroupEntry[] {
    return [];
  }

  constructor(readonly options: TAAUpscaleOptions = {}) {
    this.validate();
  }

  /** Attaches a new TAAUpscale to `engine`. */
  static attach(engine: EngineKernel, options: TAAUpscaleOptions = {}): TAAUpscale {
    const effect = new TAAUpscale(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  /** Forgets the history; call after a camera cut. */
  reset(): void {
    this.valid = false;
  }

  private validate(): void {
    const o = this.options,
      inside = (value: number | undefined, low: number, high: number) =>
        value === undefined || (value >= low && value <= high);
    if (!inside(o.scale, 0.25, 1)) throw new RangeError('TAAUpscale scale must be in 0.25..1');
    if (!inside(o.historyWeight, 0, 0.999999)) throw new RangeError('TAAUpscale historyWeight must be in [0, 1)');
    if (!inside(o.depthThreshold, 0, 1)) throw new RangeError('TAAUpscale depthThreshold must be in 0..1');
    if (!inside(o.sharpen, 0, 1)) throw new RangeError('TAAUpscale sharpen must be in 0..1');
    if (o.clampGamma !== undefined && !(Number.isFinite(o.clampGamma) && o.clampGamma > 0))
      throw new RangeError('TAAUpscale clampGamma must be finite and above 0');
    if (o.temporal !== undefined && typeof o.temporal !== 'boolean')
      throw new RangeError('TAAUpscale temporal must be a boolean; pass true or false');
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'TAAUpscale is disposed; create a new TAAUpscale');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'TAAUpscale requires WebGPU; it does not run on the WebGL2 fallback; see https://margoengine.com/errors#webgpu',
      );
    if (engine.hasPlugin('taa')) throw new MargoError('unsupported', 'TAAUpscale replaces TAA; remove TAA first');
    this.engine = engine;
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.uniform = engine.gpu.createBuffer({ size: 224, usage });
    this.sharpenUniform = engine.gpu.createBuffer({ size: 16, usage });
    this.cameraBinding = { binding: 18, resource: { buffer: this.uniform, size: 64 } };
    this.valid = false;
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'taa-upscale:capture',
      order: -70,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    graph.add({
      name: 'taa-upscale:resolve',
      order: 39,
      execute: (c) => {
        if (c.backend === 'webgpu') this.finish(c);
      },
    });
  }

  protected capture(c: Context): void {
    this.validate();
    if (c.view)
      throw new MargoError('unsupported', 'TAAUpscale handles one full-canvas view; use TAA with several views');
    const o = this.options,
      scale = o.scale ?? 0.67,
      width = Math.max(1, Math.round(c.width * scale)),
      height = Math.max(1, Math.round(c.height * scale)),
      temporal = o.temporal ?? true;
    this.resize(c, width, height);
    const camera = c.camera === this.cameraView ? this.originalCamera! : c.camera;
    if (this.originalCamera !== camera || !this.cameraView)
      this.cameraView = Object.assign(Object.create(camera), {
        matrix: this.values.subarray(0, 16),
        [temporalCameraSource]: camera,
      });
    this.originalCamera = camera;
    const v = this.values,
      m = camera.matrix;
    if (!invertMatrixStable(m, v.subarray(16, 32), this.workspace))
      throw new MargoError('state', 'Invalid TAAUpscale camera; give the camera a finite, invertible projection');
    // More phases at lower scales, so every output pixel is covered: 8 per output pixel's share of a render pixel.
    const phases = Math.min(64, Math.ceil(8 / (scale * scale))),
      index = (this.frame % phases) + 1,
      jx = temporal ? halton(index, 2) - 0.5 : 0,
      jy = temporal ? halton(index, 3) - 0.5 : 0;
    v.set(m);
    for (let i = 0; i < 4; i++) {
      v[i * 4] += ((2 * jx) / width) * v[i * 4 + 3];
      v[i * 4 + 1] += ((-2 * jy) / height) * v[i * 4 + 3];
    }
    v.set(this.valid ? this.last : m, 32);
    v.set([o.historyWeight ?? 0.9, o.depthThreshold ?? 0.01, o.clampGamma ?? 1.5, +(this.valid && temporal)], 48);
    v.set([jx, jy, width, height], 52);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    this.last.set(m);
    this.saved = { width: c.width, height: c.height };
    this.target!.begin(c);
    c.width = width;
    c.height = height;
    c.camera = this.cameraView!;
    c.shader =
      '@group(0) @binding(18) var<uniform> taaCamera:mat4x4f;\n' +
      c.shader.replace('o.clip=frame.camera*p', 'o.clip=taaCamera*p');
    c.bindings.push(this.cameraBinding!);
  }

  private resize(c: Context, width: number, height: number): void {
    const device = c.device,
      formats = `${c.format}:${c.descriptor.depthStencil!.format}:${c.descriptor.multisample?.count ?? 4}`,
      texture = (size: number[], format: GPUTextureFormat, usage: number, into: GPUTexture[]) => {
        const t = device.createTexture({ size, format, usage: usage | GPUTextureUsage.TEXTURE_BINDING });
        into.push(t);
        return t;
      };
    let rebuilt = false;
    if (this.manual !== formats || this.scene?.width !== width || this.scene.height !== height) {
      this.target?.dispose();
      for (const t of this.lowTextures) t.destroy();
      this.lowTextures = [];
      this.scene = texture([width, height], c.format, GPUTextureUsage.RENDER_ATTACHMENT, this.lowTextures);
      this.depth = texture(
        [width, height],
        c.descriptor.depthStencil!.format,
        GPUTextureUsage.RENDER_ATTACHMENT,
        this.lowTextures,
      );
      this.target = new SceneTarget(device, this.scene, this.depth, c.descriptor.multisample?.count ?? 4);
      rebuilt = true;
    }
    if (this.histories[0]?.width !== c.width || this.histories[0].height !== c.height) {
      for (const t of [...this.histories, ...this.depths]) t.destroy();
      this.histories = [];
      this.depths = [];
      for (let i = 0; i < 2; i++) {
        texture([c.width, c.height], 'rgba16float', GPUTextureUsage.STORAGE_BINDING, this.histories);
        texture([c.width, c.height], 'r32float', GPUTextureUsage.STORAGE_BINDING, this.depths);
      }
      this.valid = false;
      rebuilt = true;
    }
    if (this.manual !== formats) {
      this.manual = formats;
      const manualSRGB = +(c.format === 'rgba8unorm' || c.format === 'bgra8unorm'),
        compute = (code: string) =>
          device.createComputePipeline({
            layout: 'auto',
            compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants: { manualSRGB } },
          });
      this.resolvePipeline = compute(this.resolveCode(resolve));
      this.spatialPipeline = compute(spatial);
      const module = device.createShaderModule({ code: present });
      this.presentKey = '';
      this.presentPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }], constants: { manualSRGB } },
        multisample: c.descriptor.multisample,
      });
      rebuilt = true;
    }
    if (!rebuilt) return;
    const scene = this.scene!.createView(),
      entries = (list: GPUBindingResource[], bindings: number[]) =>
        list.map((resource, i) => ({ binding: bindings[i], resource })),
      group = (pipeline: GPUComputePipeline | GPURenderPipeline, list: GPUBindGroupEntry[]) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: list });
    this.resolveGroups = [];
    this.spatialGroups = [];
    this.presentGroups = [];
    for (let i = 0; i < 2; i++) {
      const next = 1 - i,
        buffer = { buffer: this.uniform! };
      this.spatialGroups.push(
        group(this.spatialPipeline!, entries([buffer, scene, this.histories[next].createView()], [0, 1, 5])),
      );
      this.presentGroups.push(
        group(
          this.presentPipeline!,
          entries([{ buffer: this.sharpenUniform! }, this.histories[next].createView()], [0, 1]),
        ),
      );
    }
  }

  protected finish(c: Context): void {
    const saved = this.saved;
    if (!saved) return;
    this.saved = undefined;
    const target = this.target!;
    // A plain resolve, then restore without its depth copy: the outer depth has the output's size, not this target's.
    target.resolve(c.encoder, false);
    (target as unknown as { retired: boolean }).retired = true;
    target.restore(c);
    c.width = saved.width;
    c.height = saved.height;
    if (c.camera === this.cameraView) c.camera = this.originalCamera!;
    if ((this.options.temporal ?? true) && !this.resolveGroups.length) {
      const extra = this.resolveEntries();
      this.resolveGroups = [0, 1].map((i) =>
        c.device.createBindGroup({
          layout: this.resolvePipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform! } },
            ...[
              this.scene!,
              this.depth!,
              this.histories[i],
              this.depths[i],
              this.histories[1 - i],
              this.depths[1 - i],
            ].map((texture, index) => ({
              binding: index + 1,
              resource: texture.createView(index === 1 ? { aspect: 'depth-only' } : {}),
            })),
            ...extra,
          ],
        }),
      );
    }
    const temporal = this.options.temporal ?? true,
      compute = c.encoder.beginComputePass();
    compute.setPipeline(temporal ? this.resolvePipeline! : this.spatialPipeline!);
    compute.setBindGroup(0, (temporal ? this.resolveGroups : this.spatialGroups)[this.front]);
    compute.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
    compute.end();
    const sharpen = this.options.sharpen ?? 0.2;
    const rect = this.outputView?.viewport;
    if (
      this.sharpenValue[0] !== Math.fround(sharpen) ||
      !this.presentKey ||
      this.sharpenValue[2] !== (rect?.[0] ?? 0) ||
      this.sharpenValue[3] !== (rect?.[1] ?? 0)
    ) {
      this.sharpenValue[0] = sharpen;
      this.sharpenValue[2] = rect?.[0] ?? 0;
      this.sharpenValue[3] = rect?.[1] ?? 0;
      this.presentKey = 'written';
      c.device.queue.writeBuffer(this.sharpenUniform!, 0, this.sharpenValue);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: c.color,
          loadOp: viewLoadOp({ width: c.width, height: c.height, view: this.outputView }, 'clear'),
          storeOp: 'store',
        },
      ],
    });
    applyView(pass, { width: c.width, height: c.height, view: this.outputView });
    pass.setPipeline(this.presentPipeline!);
    pass.setBindGroup(0, this.presentGroups[this.front]);
    pass.draw(3);
    pass.end();
    this.front = 1 - this.front;
    this.valid = temporal;
    this.frame++;
  }

  /** Restores a capture abandoned by an optional pass, without copying a differently sized depth attachment. */
  protected cancelCapture(c: Context): void {
    if (this.saved) {
      (this.target as unknown as { retired: boolean }).retired = true;
      this.target!.restore(c);
      c.width = this.saved.width;
      c.height = this.saved.height;
      this.saved = undefined;
      if (c.camera === this.cameraView) c.camera = this.originalCamera!;
    }
    this.reset();
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  /** Removes the effect and releases its GPU resources. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  protected release(): void {
    this.target?.dispose();
    for (const t of [...this.lowTextures, ...this.histories, ...this.depths]) t.destroy();
    this.uniform?.destroy();
    this.sharpenUniform?.destroy();
    this.lowTextures = [];
    this.histories = [];
    this.depths = [];
    this.target = this.scene = this.depth = this.uniform = this.sharpenUniform = undefined;
    this.resolvePipeline = this.spatialPipeline = this.presentPipeline = undefined;
    this.resolveGroups = [];
    this.spatialGroups = [];
    this.presentGroups = [];
    this.manual = this.presentKey = '';
    this.valid = false;
  }
}
