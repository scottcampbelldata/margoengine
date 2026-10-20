/// <reference lib="esnext.disposable" preserve="true" />
import type { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { render, compute, group as bind } from '../../shared/gpu.js';
import { preset } from '../../shared/preset.js';
import { margoError } from '../../shared/errors.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { PostStack } from './stack.js';
import { vertex, reduceShader, downsampleShader, traceFunctions, march } from './hiz.js';
import { shareCapture, drawCapture } from './capture.js';
import type { SSRCapture, SSRModel } from './ssr.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; STORAGE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link SSGI}; every value may change per frame. */
export interface SSGIOptions {
  /** Rays per pixel, 1-16. The 4x4 pixel tile spreads 16 times as many directions, which the blur averages. Default 4. */
  rays?: number;
  /** Longest ray in scene units; hits fade out over the last 20%. Default 10. */
  maxDistance?: number;
  /** Scene units a ray may pass behind the depth buffer and still count as a hit. Default 0.5. */
  thickness?: number;
  /** Hierarchical-depth march iterations per ray, 1-256. Default 32. */
  steps?: number;
  /** Scale of the change, 0-4: 1 replaces the ambient light where rays hit with the light they hit. Default 1. */
  intensity?: number;
  enabled?: boolean;
}

// Material replay outputs: the ambient light the scene added (rgb, as SSAO replays it: `margoAmbient` when a plugin names
// it, else core's ambient term), the diffuse albedo base*(1-metal) with coverage, and the shading normal.
const giStruct = '\nstruct MargoGI {@location(0) ambient:vec4f,@location(1) albedo:vec4f,@location(2) normal:vec4f}\n';
function coreReplay(shader: string): string {
  const all = shader.includes('let margoAmbient='),
    ambient = all
      ? 'margoAmbient'
      : shader.includes('skyAmbient.rgb')
        ? 'i.color*(1.0-i.material.y)*skyAmbient.rgb'
        : 'i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb',
    out = `return MargoGI(vec4f(${ambient},1),vec4f(i.color*(1.0-i.material.y),1),vec4f(n*0.5+0.5,1));`;
  // With margoAmbient the lighting runs (the ambient is computed there); otherwise it sits in a dead block that keeps
  // every pass binding statically used, as in SSR's replay.
  const code = shader
    .replace(/(@fragment[^{]*)->@location\(0\) vec4f/, '$1->MargoGI')
    .replace(/(let direct=[\s\S]*)return (vec4f\([^\n]+\));/, all ? `$1_=$2;${out}` : `if(false){$1_=$2;}${out}`);
  if (!code.includes('->MargoGI') || !code.includes('return MargoGI('))
    throw margoError('unsupported', 'SSGI requires the standard core lighting shader');
  return code + giStruct;
}
// gltf-pro capture (SSR's hook contract): the model's own ambient (`ambient(s)`, occlusion included; clearcoat and sheen
// scale it by k), albedo and normal.
const pbrSurface = /struct Surface\s*\{\s*base:vec4f/;
const modelTail = (code: string) => {
  // Terrain and water reach SSR's hook contract too, but have no albedo or ambient replay here.
  if (!pbrSurface.test(code))
    throw margoError(
      'unsupported',
      'SSGI captures gltf-pro models and materials meshes only; add terrain and water to SSR',
    );
  return `
struct MargoCapture {@location(0) ambient:vec4f,@location(1) albedo:vec4f,@location(2) normal:vec4f}
fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {return MargoCapture(vec4f(${code.includes('fn ambient(s:Surface)') ? 'ambient(s)*k' : 'vec3f(0)'},1),vec4f(s.base.rgb*(1.0-s.metal),1),vec4f(s.n*0.5+0.5,1));}
`;
};
const uniforms = `
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f,g:vec4f}
@group(0) @binding(0) var<uniform> u:U;
`;
// One bounce of diffuse light: cosine-weighted rays around the normal, each marched over the Hi-Z like SSR's mirror ray.
// A hit returns the lit scene there (a blurred mip of it for far hits, so a few rays see an area, not a point). The
// result is the hit light summed over all rays (rgb) and the share of rays that hit (a), both over the ray count.
const traceShader =
  vertex +
  uniforms +
  `
@group(0) @binding(1) var input:texture_2d<f32>;
@group(0) @binding(2) var blurred:texture_2d<f32>;
@group(0) @binding(3) var bilinear:sampler;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var hiz:texture_2d<f32>;
@group(0) @binding(6) var normals:texture_2d<f32>;
@group(0) @binding(7) var albedo:texture_2d<f32>;
@group(0) @binding(8) var<storage,read> rays:array<vec4f>;
${traceFunctions}fn trace(p:vec3f,r:vec3f)->vec4f {
${march}if(hit){return vec4f(o+dir*t,t*len);}}
return vec4f(-1.0);
}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let d=textureLoad(depth,q,0);
if(u.b.w<0.5||d<=0.0||textureLoad(albedo,q,0).a<0.5){return vec4f(0);}
let px=vec2f(q)+0.5;let p=world(px,d);let n=normalize(textureLoad(normals,q,0).xyz*2.0-1.0);
// Orthonormal basis around n (Duff, Burgess, Christensen et al. 2017); rays start two pixel footprints off the surface.
let sg=select(-1.0,1.0,n.z>=0.0);let a=-1.0/(sg+n.z);let b=n.x*n.y*a;
let t1=vec3f(1.0+sg*n.x*n.x*a,sg*b,-sg*n.x);let t2=vec3f(b,sg+n.y*n.y*a,-n.y);
let start=p+n*2.0*distance(world(px+vec2f(1,0),d),p);
let count=u32(u.g.x);let cell=(u32(q.y)%4u)*4u+u32(q.x)%4u;var sum=vec4f(0);
for(var j=0u;j<count;j++){
let k=rays[cell+16u*j].xyz;let r=normalize(t1*k.x+t2*k.y+n*k.z);let h=trace(start,r);
if(h.w<0.0){continue;}
let hq=vec2i(h.xy);let hn=textureLoad(normals,hq,0).xyz*2.0-1.0;let hp=world(vec2f(hq)+0.5,textureLoad(depth,hq,0));
// Fades: hits on back faces (hit normal along the ray) and near maxDistance.
let w=(1.0-smoothstep(0.0,0.3,dot(hn,r)))*(1.0-smoothstep(0.8*u.b.x,u.b.x,distance(p,hp)));
let lod=log2(max(h.w*u.g.w,1.0));var light=textureLoad(input,hq,0).rgb;
if(lod>1.0){light=textureSampleLevel(blurred,bilinear,h.xy/u.a.xy,min(lod-1.0,f32(textureNumLevels(blurred)-1))).rgb;}
sum+=vec4f(light*w,w);
}
return sum/f32(count);
}`;
// Bilateral blur over 8 taps (-4..3, so a flat run averages the 4x4 tile exactly): taps off the pixel's plane or with a
// different normal are left out.
const blurShader =
  vertex +
  uniforms +
  `
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var normals:texture_2d<f32>;
@group(0) @binding(4) var<uniform> axis:vec4f;
fn position(q:vec2f,d:f32)->vec3f {let w=u.inverse*vec4f(q.x/u.a.x*2.0-1.0,1.0-q.y/u.a.y*2.0,d,1.0);return w.xyz/w.w;}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let d=textureLoad(depth,q,0);let center=textureLoad(source,q,0);if(d<=0.0){return center;}
let px=vec2f(q)+0.5;let p=position(px,d);let n=normalize(textureLoad(normals,q,0).xyz*2.0-1.0);
let footprint=4.0*distance(position(px+vec2f(1,0),d),p);let limit=vec2i(textureDimensions(source))-1;
var sum=vec4f(0);var total=0.0;
for(var i=-4;i<4;i++){
let s=clamp(q+vec2i(axis.xy)*i,vec2i(0),limit);let sd=textureLoad(depth,s,0);if(sd<=0.0){continue;}
let sn=normalize(textureLoad(normals,s,0).xyz*2.0-1.0);
let w=exp(-abs(dot(position(vec2f(s)+0.5,sd)-p,n))/footprint)*pow(max(dot(n,sn),0.0),8.0);
sum+=textureLoad(source,s,0)*w;total+=w;
}
return select(center,sum/total,total>1e-4);
}`;
// Where rays hit, the ambient light the scene added (SSAO's replay) is replaced by the light they hit, times the albedo.
const compositeShader =
  vertex +
  uniforms +
  `
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var gi:texture_2d<f32>;
@group(0) @binding(3) var ambient:texture_2d<f32>;
@group(0) @binding(4) var albedo:texture_2d<f32>;
${displayShader}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let s=textureLoad(scene,q,0);var c=s.rgb;
if(u.b.w>0.5){let g=textureLoad(gi,q,0);c=max(vec3f(0),c+u.g.y*(textureLoad(albedo,q,0).rgb*g.rgb-textureLoad(ambient,q,0).rgb*g.a));}
return vec4f(toDisplay(c),s.a);
}`;
const linearComposite = compositeShader.replace('return vec4f(toDisplay(c),s.a);', 'return vec4f(c,s.a);');
if (linearComposite.includes('vec4f(toDisplay(c)'))
  throw margoError('failed', 'SSGI: the HDR composite still encodes for display; update its linear-output patch');
const formats: GPUTextureFormat[] = ['rgba16float', 'rgba8unorm', 'rgb10a2unorm'],
  targets = formats.map((format) => ({ format })),
  blurLevels = 5;
// 16 x rays cosine-weighted directions (a disc point lifted to the hemisphere, Malley's method), on a golden-angle
// spiral of equal-area rings; pixel i of the 4x4 tile takes directions i, i+16, i+32, ...
function directions(count: number): Float32Array {
  const n = count * 16,
    values = new Float32Array(1024);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n),
      a = i * 2.399963229728653;
    values.set([r * Math.cos(a), r * Math.sin(a), Math.sqrt(Math.max(0, 1 - r * r)), 0], i * 4);
  }
  return values;
}

/**
 * Screen-space global illumination (one bounce of diffuse light) in a {@link PostStack}: cosine-weighted rays per pixel
 * marched over SSR's hierarchical depth; where a ray hits, the ambient light the scene added at the pixel (SSAO's
 * ambient replay) is replaced by the lit scene the ray hit, times the pixel's diffuse albedo. Core meshes replay their
 * materials; gltf-pro models and materials meshes join with `add(model)` (SSR's capture hook). HDR stage.
 */
export class SSGI implements EnginePlugin {
  readonly name = 'ssgi';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private uniform?: GPUBuffer;
  private rays?: GPUBuffer;
  private axes: GPUBuffer[] = [];
  private rayCount = 0;
  private sampler?: GPUSampler;
  private reduceDepth?: GPUComputePipeline;
  private reduce?: GPUComputePipeline;
  private downsample?: GPURenderPipeline;
  private tracer?: GPURenderPipeline;
  private blur?: GPURenderPipeline;
  private textures: GPUTexture[] = [];
  private width = 0;
  private height = 0;
  private target?: SceneTarget;
  private depthView?: GPUTextureView;
  private ownDepth?: GPUTextureView;
  private base?: GPURenderPipelineDescriptor;
  private single?: GPURenderPipelineDescriptor;
  private hiz?: GPUTextureView;
  private hizGroups: GPUBindGroup[] = [];
  private hizSizes: number[][] = [];
  private material: GPUTextureView[] = [];
  private chain?: GPUTextureView;
  private chainGroups: GPUBindGroup[] = [];
  private chainPasses: GPURenderPassDescriptor[] = [];
  private gi: GPUTextureView[] = [];
  private giPasses: GPURenderPassDescriptor[] = [];
  private blurGroups: GPUBindGroup[] = [];
  private traceGroup?: GPUBindGroup;
  private replay?: GPURenderPipeline;
  private replayKey?: string;
  private composite?: GPURenderPipeline;
  private compositeGroup?: GPUBindGroup;
  private input?: GPUTextureView;
  private key = '';
  private clearPass?: GPURenderPassDescriptor;
  private extra: GPURenderPassColorAttachment[] = [];
  private readonly compositeAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly compositePass: GPURenderPassDescriptor = { colorAttachments: [this.compositeAttachment] };
  private readonly models = new Map<SSRModel, () => void>();
  private readonly modelCode = new Map<string, string>();
  private context?: Context;
  private pass?: GPURenderPassEncoder;
  private readonly hook: SSRCapture = {
    targets,
    declarations: (code) => {
      let out = this.modelCode.get(code);
      if (out === undefined) {
        if (this.modelCode.size >= 64) this.modelCode.clear();
        this.modelCode.set(code, (out = modelTail(code)));
      }
      return out;
    },
    begin: () => {
      if (this.pass) return this.pass;
      const c = this.context!,
        stencil = c.descriptor.depthStencil!.format.includes('stencil')
          ? ({ stencilLoadOp: 'load', stencilStoreOp: 'store' } as const)
          : {};
      return (this.pass = c.encoder.beginRenderPass({
        colorAttachments: this.material.map((view) => ({ view, loadOp: 'load', storeOp: 'store' })),
        depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', ...stencil },
      }));
    },
  };
  private readonly values = new Float32Array(44);
  private readonly workspace = new Float64Array(52);
  private readonly inverse = this.values.subarray(0, 16);
  constructor(readonly options: SSGIOptions = {}) {
    this.options = preset('ssgi', options);
    this.validate();
  }
  /** Alone, SSGI runs in its own one-effect PostStack (tone mapped like SSAO alone); to combine it, put it in your PostStack. */
  static attach(engine: EngineKernel, options: SSGIOptions = {}): SSGI {
    const effect = new SSGI(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Gives a gltf-pro model or materials mesh its own albedo, ambient and normals in the bounce (it is lit by the
   * bounce, not only bounced from). Returns a remover; a model may be added to SSR as well. */
  add(model: SSRModel): () => void {
    if (this.disposed) throw margoError('disposed', 'SSGI is disposed; create a new SSGI');
    let release = this.models.get(model);
    if (!release) {
      const restore = shareCapture(model, this.hook),
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
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('SSGI enabled must be boolean');
    this.options.enabled = value;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', 'SSGI is already attached; create another SSGI for another stack');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options,
      rays = o.rays ?? 4,
      d = o.maxDistance ?? 10,
      t = o.thickness ?? 0.5,
      s = o.steps ?? 32,
      i = o.intensity ?? 1;
    if (
      !Number.isInteger(rays) ||
      rays < 1 ||
      rays > 16 ||
      !(d > 0 && Number.isFinite(Math.fround(d))) ||
      !(t > 0 && Number.isFinite(t)) ||
      !Number.isInteger(s) ||
      s < 1 ||
      s > 256 ||
      !(i >= 0 && i <= 4) ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new RangeError(
        'Invalid SSGI options: rays 1-16, maxDistance > 0, thickness > 0, steps 1-256, intensity 0-4',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'SSGI is disposed; create a new SSGI');
    if (!this.host)
      throw margoError(
        'state',
        'SSGI runs in a PostStack: use SSGI.attach(engine) or PostStack.attach(engine, [..., new SSGI(), ...])',
      );
    if (!engine.gpu) throw margoError('unsupported', 'SSGI requires WebGPU');
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.rays = device.createBuffer({ size: 4096, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.rayCount = 0;
    this.axes = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ].map((axis) => {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Float32Array(axis));
      return b;
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.reduceDepth = compute(device, reduceShader('texture_depth_2d', ''));
    this.reduce = compute(device, reduceShader('texture_2d<f32>', '.r'));
    this.downsample = render(device, downsampleShader, 'rgba16float');
    this.tracer = render(device, traceShader, 'rgba16float');
    this.blur = render(device, blurShader, 'rgba16float');
  }
  registerPasses(graph: FrameGraph): void {
    // After the scene, SSAO's replays (10-13) and SSR's (14), before the stack composes (30).
    graph.add({
      name: 'ssgi:gbuffer',
      order: 15,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.host?.target) this.prepare(c);
      },
    });
  }
  private prepare(c: Context): void {
    this.validate();
    this.resize(c);
    const v = this.values,
      o = this.options,
      own = this.ownDepth,
      rays = o.rays ?? 4;
    if (!invertMatrixStable(c.camera.matrix, this.inverse, this.workspace))
      throw margoError('state', 'Invalid SSGI camera: its matrix cannot be inverted');
    v.set(c.camera.matrix, 16);
    v[32] = c.width;
    v[33] = c.height;
    v[34] = 0;
    v[35] = o.thickness ?? 0.5;
    v[36] = o.maxDistance ?? 10;
    v[37] = o.steps ?? 32;
    v[38] = this.hizGroups.length;
    v[39] = +this.enabled;
    v[40] = rays;
    v[41] = o.intensity ?? 1;
    v[42] = 0;
    // Cone of one of the 16 x rays directions (solid angle 2 pi / n): the hit footprint per pixel travelled.
    v[43] = Math.sqrt((2 * Math.PI) / (16 * rays));
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    if (this.rayCount !== rays) {
      this.rayCount = rays;
      c.device.queue.writeBuffer(this.rays!, 0, directions(rays) as Float32Array<ArrayBuffer>);
    }
    if (!this.enabled) return;
    if (this.base !== c.descriptor) {
      this.base = c.descriptor;
      this.single = {
        ...c.descriptor,
        multisample: { count: 1 },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    }
    const key = c.shader + !!own;
    if (this.replayKey !== key) {
      const module = c.device.createShaderModule({ code: coreReplay(c.shader) });
      this.replay = c.device.createRenderPipeline({
        ...this.single!,
        layout: 'auto',
        vertex: { ...c.descriptor.vertex, module },
        fragment: { module, entryPoint: 'fragment', targets },
        depthStencil: own
          ? this.single!.depthStencil
          : { ...c.descriptor.depthStencil!, depthWriteEnabled: false, depthCompare: 'equal' },
      });
      this.replayKey = key;
    }
    const { color, depth, descriptor } = c;
    c.color = this.material[0];
    if (own) {
      c.depth = own;
      c.descriptor = this.single!;
    } else c.encoder.beginRenderPass(this.clearPass!).end();
    try {
      // With margoAmbient the lighting runs, so the replay keeps every pass binding (as SSAO's does).
      c.draw({ pipeline: this.replay, clear: !!own, bindings: c.bindings, colorAttachments: this.extra });
      if (this.models.size) {
        this.context = c;
        for (const model of this.models.keys()) drawCapture(model, this.hook, c);
      }
    } finally {
      this.pass?.end();
      this.pass = this.context = undefined;
      Object.assign(c, { color, depth, descriptor });
    }
    const pass = c.encoder.beginComputePass();
    for (let i = 0; i < this.hizGroups.length; i++) {
      pass.setPipeline(i ? this.reduce! : this.reduceDepth!);
      pass.setBindGroup(0, this.hizGroups[i]);
      pass.dispatchWorkgroups(Math.ceil(this.hizSizes[i][0] / 8), Math.ceil(this.hizSizes[i][1] / 8));
    }
    pass.end();
  }
  private fullscreen(c: Context, descriptor: GPURenderPassDescriptor, pipeline: GPURenderPipeline, g: GPUBindGroup) {
    const pass = c.encoder.beginRenderPass(descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, g);
    pass.draw(3);
    pass.end();
  }
  private stage(c: Context, input: GPUTextureView, output: StageOutput): void {
    const key = output.format + output.multisample.count + output.hdr;
    if (this.key !== key) {
      this.key = key;
      this.composite = render(c.device, output.hdr ? linearComposite : compositeShader, output.format, {
        multisample: output.multisample,
      });
      this.input = undefined;
    }
    if (this.input !== input) {
      this.input = input;
      const uniform = { buffer: this.uniform! };
      this.chainGroups[0] = bind(c.device, this.downsample!, [input, this.sampler!]);
      this.traceGroup = bind(c.device, this.tracer!, [
        uniform,
        input,
        this.chain!,
        this.sampler!,
        this.depthView!,
        this.hiz!,
        this.material[2],
        this.material[1],
        { buffer: this.rays! },
      ]);
      this.compositeGroup = bind(c.device, this.composite!, [
        uniform,
        input,
        this.gi[0],
        this.material[0],
        this.material[1],
      ]);
    }
    if (this.enabled) {
      for (let i = 0; i < blurLevels; i++)
        this.fullscreen(c, this.chainPasses[i], this.downsample!, this.chainGroups[i]);
      this.fullscreen(c, this.giPasses[0], this.tracer!, this.traceGroup!);
      this.fullscreen(c, this.giPasses[1], this.blur!, this.blurGroups[0]);
      this.fullscreen(c, this.giPasses[0], this.blur!, this.blurGroups[1]);
    }
    this.compositeAttachment.view = output.view;
    this.fullscreen(c, this.compositePass, this.composite!, this.compositeGroup!);
  }
  private resize(c: Context): void {
    const target = this.host!.target!;
    if (this.width === c.width && this.height === c.height && this.target === target) return;
    this.release();
    this.width = c.width;
    this.height = c.height;
    this.target = target;
    const device = c.device,
      sampled = GPUTextureUsage.TEXTURE_BINDING,
      attachment = sampled | GPUTextureUsage.RENDER_ATTACHMENT,
      texture = (size: number[], format: GPUTextureFormat, usage: number, mipLevelCount = 1) => {
        const t = device.createTexture({ size, format, usage, mipLevelCount });
        this.textures.push(t);
        return t;
      };
    const scene = this.host!.depthTexture!,
      depth = target.samples === 4 ? texture([c.width, c.height], 'depth32float', attachment) : scene;
    this.depthView = depth.createView({ aspect: 'depth-only' });
    if (depth !== scene) this.ownDepth = depth.createView();
    const half = [Math.max(1, c.width >> 1), Math.max(1, c.height >> 1)],
      levels = Math.max(1, Math.min(6, Math.floor(Math.log2(Math.min(c.width, c.height)))));
    const hiz = texture(half, 'r32float', sampled | GPUTextureUsage.STORAGE_BINDING, levels);
    this.hiz = hiz.createView();
    for (let i = 0; i < levels; i++) {
      this.hizSizes.push([Math.max(1, half[0] >> i), Math.max(1, half[1] >> i)]);
      this.hizGroups.push(
        bind(device, i ? this.reduce! : this.reduceDepth!, [
          i ? hiz.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }) : this.depthView,
          hiz.createView({ baseMipLevel: i, mipLevelCount: 1 }),
        ]),
      );
    }
    this.material = formats.map((format) => texture([c.width, c.height], format, attachment).createView());
    this.clearPass = { colorAttachments: [{ view: this.material[0], loadOp: 'clear', storeOp: 'store' }] };
    this.extra = [1, 2].map((i) => ({
      view: this.material[i],
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: i === 2 ? { r: 0.5, g: 0.5, b: 0.5, a: 0 } : { r: 0, g: 0, b: 0, a: 0 },
    }));
    const chain = texture(half, 'rgba16float', attachment, blurLevels);
    this.chain = chain.createView();
    for (let i = 0; i < blurLevels; i++) {
      const view = chain.createView({ baseMipLevel: i, mipLevelCount: 1 });
      this.chainPasses.push({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      if (i < blurLevels - 1) this.chainGroups[i + 1] = bind(device, this.downsample!, [view, this.sampler!]);
    }
    this.gi = [0, 1].map(() => texture([c.width, c.height], 'rgba16float', attachment).createView());
    this.giPasses = this.gi.map((view) => ({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] }));
    const normals = this.material[2];
    this.blurGroups = [0, 1].map((i) =>
      bind(device, this.blur!, [
        { buffer: this.uniform! },
        this.gi[i],
        this.depthView!,
        normals,
        { buffer: this.axes[i] },
      ]),
    );
  }
  private release(): void {
    for (const t of this.textures) t.destroy();
    this.textures = [];
    this.width = this.height = 0;
    this.target = undefined;
    this.input = undefined;
    this.hizGroups = [];
    this.hizSizes = [];
    this.material = [];
    this.chainGroups = [];
    this.chainPasses = [];
    this.gi = [];
    this.giPasses = [];
    this.blurGroups = [];
    this.extra = [];
    this.depthView = this.ownDepth = this.hiz = this.chain = undefined;
    this.traceGroup = this.compositeGroup = undefined;
    this.clearPass = undefined;
    this.compositeAttachment.view = undefined!;
  }
  private releaseBuffers(): void {
    this.uniform?.destroy();
    this.rays?.destroy();
    for (const b of this.axes) b.destroy();
    this.uniform = this.rays = undefined;
    this.axes = [];
    this.replay = this.composite = undefined;
    this.replayKey = this.base = undefined;
    this.key = '';
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.releaseBuffers();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stack = this.stack;
    this.stack = undefined;
    for (const release of [...this.models.values()]) release();
    this.engine?.removePlugin(this.name);
    this.release();
    this.releaseBuffers();
    this.engine = undefined;
    stack?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
