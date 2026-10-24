/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type DrawOptions,
} from '@margoengine/core/extension';
import { displayShader } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { render } from '../../shared/gpu.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  COPY_SRC: number;
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
};

type PostPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** Device, command encoder and exact image dimensions for an isolated HDR bloom dispatch. */
export type BloomImageContext = Pick<PostPassContext, 'device' | 'encoder' | 'width' | 'height'>;
/** Glow settings. They are read every frame, so they may be changed while the effect runs. */
export interface BloomOptions {
  /** Share of the light above `threshold` that is spread back as glow, 0 to 4 (default 0.8). */
  strength?: number;
  /** Linear brightness (brightest channel) above which a pixel glows, 0 to 100 (default 1). */
  threshold?: number;
  /** Exposure in stops, applied before the neutral display transform, -10 to 10 (default 0). */
  exposure?: number;
  /**
   * How far the glow spreads, 0 to 1 (default 0.5). Level j of the chain (j = 0 is the half-resolution level, the
   * tightest blur) is weighted by `k^j` with `k = 4^(2 * radius - 1)`, and the weights are scaled to sum to the number
   * of levels, so the total glow stays the same: 0 puts about three quarters of it in the tightest level, 1 about three
   * quarters in the widest, and 0.5 weighs every level equally (the chain as it is without a radius).
   */
  radius?: number;
}
/** 3x3 tent (1 2 1 by 1 2 1, over 16) of bilinear taps one texel of `t` apart: every upsample of the chain. */
const tent = `
fn tent(t:texture_2d<f32>,s:sampler,uv:vec2f)->vec3f{
 let d=1.0/vec2f(textureDimensions(t));var c=vec3f(0);
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){c+=textureSampleLevel(t,s,uv+vec2f(f32(x),f32(y))*d,0.0).rgb*f32((2-abs(x))*(2-abs(y)));}}
 return c/16.0;
}`;
/**
 * The glow chain, after Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare" (SIGGRAPH 2014).
 * Going down, each level is half the size of the one above, filtered by 13 bilinear taps that form five overlapping
 * 2x2-texel boxes: the centre box weighs 0.5, the four corner boxes 0.125 each. The top level reads the full-resolution
 * scene, keeps only the light above the threshold in every tap and weights each box by 1/(1+luma) (Karis average), so
 * one very bright pixel (a water glint, an ember) cannot switch the glow on and off as it crosses pixels. Coming back
 * up, each level adds a tent upsample of the summed levels below it.
 */
const chain =
  tent +
  `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var detail:texture_2d<f32>;
@group(0) @binding(4) var<uniform> settings:vec4f;
fn downsample(id:vec2u,top:bool){
 let size=textureDimensions(output);if(any(id>=size)){return;}
 let uv=(vec2f(id)+0.5)/vec2f(size);let t=1.0/vec2f(textureDimensions(source));
 let o=array<vec2f,13>(vec2f(-2,-2),vec2f(0,-2),vec2f(2,-2),vec2f(-1,-1),vec2f(1,-1),vec2f(-2,0),vec2f(0,0),vec2f(2,0),vec2f(-1,1),vec2f(1,1),vec2f(-2,2),vec2f(0,2),vec2f(2,2));
 var s:array<vec3f,13>;
 for(var i=0;i<13;i++){
  var c=textureSampleLevel(source,bilinear,uv+o[i]*t,0.0).rgb;let m=max(c.r,max(c.g,c.b));
  if(top){c*=max(0.0,m-settings.w)/max(0.0001,m);}s[i]=c;
 }
 let b=array<vec3f,5>(s[3]+s[4]+s[8]+s[9],s[0]+s[1]+s[5]+s[6],s[1]+s[2]+s[6]+s[7],s[5]+s[6]+s[10]+s[11],s[6]+s[7]+s[11]+s[12]);
 var color=vec3f(0);var total=0.0;
 for(var i=0;i<5;i++){
  let box=b[i]*0.25;var w=select(0.125,0.5,i==0);
  if(top){w/=1+dot(box,vec3f(0.2126,0.7152,0.0722));}color+=box*w;total+=w;
 }
 textureStore(output,vec2i(id),vec4f(color/total,1));
}
@compute @workgroup_size(8,8) fn prefilter(@builtin(global_invocation_id) id:vec3u){downsample(id.xy,true);}
@compute @workgroup_size(8,8) fn down(@builtin(global_invocation_id) id:vec3u){downsample(id.xy,false);}
@compute @workgroup_size(8,8) fn up(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(output);if(any(id.xy>=size)){return;}
 let uv=(vec2f(id.xy)+0.5)/vec2f(size);
 textureStore(output,vec2i(id.xy),vec4f(textureLoad(detail,vec2i(id.xy),0).rgb+tent(source,bilinear,uv),1));
}`;
// With a radius other than 0.5, each up step weighs its own level by settings.x and the sum below by settings.y (the
// smallest level's weight on the first step, 1 after it), read from that step's slice of the weights buffer.
const weighted = chain.replace('.rgb+tent(source,bilinear,uv)', '.rgb*settings.x+tent(source,bilinear,uv)*settings.y');
if (weighted === chain) throw margoError('failed', 'Bloom: the up pass lost its weights; update the radius patch');
/** Byte stride of the per-step weights: the largest `minUniformBufferOffsetAlignment` WebGPU allows. */
const slice = 256;
/**
 * Weight of each chain level for a glow `radius` (see {@link BloomOptions.radius}): `k^j` with
 * `k = 4^(2 * radius - 1)`, scaled so the weights sum to `levels`. Radius 0.5 gives exactly 1 for every level.
 */
export function bloomWeights(radius: number, levels: number): number[] {
  const k = 4 ** (2 * radius - 1),
    raw = Array.from({ length: levels }, (_, j) => k ** j),
    total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => (w * levels) / total);
}
// The 8-bit output is dithered (Gjøl, "Low Complexity, High Fidelity: INSIDE", GDC 2016): triangular noise of up to one
// 8-bit step (settings.z; 0 for float targets), hashed from the pixel position so a frame repeats exactly. The noise
// also stays within each channel's distance to 0 and 1, so black stays black, nothing clips (no bias) and a
// transparent pixel stays transparent.
const composite =
  displayShader +
  tent +
  `
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var bloom:texture_2d<f32>;
@group(0) @binding(2) var<uniform> settings:vec4f;
@group(0) @binding(3) var bilinear:sampler;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
fn dither(p:vec2f)->f32{
 var x=(u32(p.x)*0x9e3779b9u)^(u32(p.y)*0x85ebca6bu);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x^=x>>16u;
 return f32(x&0xffffu)/65536.0+f32(x>>16u)/65536.0-1.0;
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let s=textureLoad(scene,vec2i(p.xy),0);let hdr=s.rgb+tent(bloom,bilinear,p.xy/vec2f(textureDimensions(scene)))*settings.x;
 let o=toDisplay(hdr*exp2(settings.y));let a=max(s.a,max(o.r,max(o.g,o.b)));return vec4f(min(o+dither(p.xy)*min(vec3f(settings.z),min(o,1-o)),vec3f(a)),a);
}`;
// Alpha: scene coverage (premultiplied), raised to the glow's brightest channel so glow over a transparent canvas stays valid.
// In a PostStack, a non-final Bloom hands linear light (with its exposure) to the next effect.
const linear = composite.replace(
  /let o=toDisplay\(hdr\*exp2\(settings\.y\)\);[^\n]+/,
  'return vec4f(max(hdr,vec3f(0))*exp2(settings.y),s.a);',
);
// The display transform must be gone, or an HDR stage would hand the next effect display-encoded colour.
if (linear.includes('toDisplay(hdr'))
  throw margoError('failed', 'Bloom: the HDR composite still encodes for display; update its linear-output patch');
/** One dispatch of the chain: pipeline, bind group, workgroups across and down. */
type Step = [GPUComputePipeline, GPUBindGroup, number, number];
/** Bind group whose entry i is resource i; holes are bindings the entry point does not use. */
function bind(
  device: GPUDevice,
  pipeline: GPUComputePipeline | GPURenderPipeline,
  resources: (GPUBindingResource | undefined)[],
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: resources.flatMap((resource, binding) => (resource ? [{ binding, resource }] : [])),
  });
}

/**
 * Owns linear HDR scene capture, a glow chain from half resolution down to 1/64 and a single dithered neutral display presentation.
 * @throws RangeError when an option or an `encodeImage` size is out of range.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced core's lighting shader,
 * `'disposed'` after `dispose()`, `'attached'` when attached twice, `'state'` when another post effect owns the output
 * target, or `encodeImage` runs on an attached Bloom or a new device.
 */
export class Bloom implements EnginePlugin {
  readonly name = 'bloom';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  /** The chain's prefilter, down and up entry points. */
  private passes: GPUComputePipeline[] = [];
  /** Built with the textures and replayed every frame, so a steady frame creates no GPU objects. */
  private steps: Step[] = [];
  private levels = 1;
  /** Up steps read per-level weights (a radius other than 0.5); their pipeline and buffer are made on first use. */
  private weighted = false;
  private weightedUp?: GPUComputePipeline;
  private weights?: GPUBuffer;
  private readonly weightValues = new Float32Array((5 * slice) / 4);
  /** The view the chain was built over. */
  private source?: GPUTextureView;
  private textures: GPUTexture[] = [];
  private group?: GPUBindGroup;
  private present?: GPURenderPipeline;
  private capture?: SceneTarget;
  private scene?: GPUTextureView;
  private depth?: GPUTextureView;
  private original?: GPUTextureView;
  private originalDepth?: GPUTextureView;
  private originalFormat?: GPUTextureFormat;
  private linearShader = '';
  private sourceShader = '';
  private originalDraw?: PassContext['draw'];
  private readonly scenePipelines = new Map<string, GPURenderPipeline>();
  private readonly sceneOptions: DrawOptions = {};
  private readonly drawScene = (options?: DrawOptions): void => this.originalDraw!(options ?? this.sceneOptions);
  private readonly values = new Float32Array(4);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly presentation: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  private disposed = false;
  private host?: StackHost;
  private key = '';
  private imageDevice?: GPUDevice;

  constructor(readonly options: BloomOptions = {}) {
    this.validate();
  }
  static attach(engine: EngineKernel, options: BloomOptions = {}): Bloom {
    const bloom = new Bloom(options);
    engineRuntime(engine).use(bloom);
    return bloom;
  }
  get depthTexture(): GPUTexture | undefined {
    return this.host ? this.host.depthTexture : this.textures[1];
  }
  /** Captured linear scene; undefined in a PostStack. */
  get sceneTexture(): GPUTexture | undefined {
    return this.host ? undefined : this.textures[0];
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', 'Bloom is already attached; create a new Bloom');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const s = this.options.strength ?? 0.8,
      t = this.options.threshold ?? 1,
      e = this.options.exposure ?? 0,
      r = this.options.radius ?? 0.5;
    if (
      !Number.isFinite(r) ||
      r < 0 ||
      r > 1 ||
      !Number.isFinite(s) ||
      s < 0 ||
      s > 4 ||
      !Number.isFinite(t) ||
      t < 0 ||
      t > 100 ||
      !Number.isFinite(e) ||
      Math.abs(e) > 10
    )
      throw new RangeError('Invalid bloom options');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw margoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Bloom requires WebGPU and a live effect; attach a new Bloom to a WebGPU engine',
      );
    if (
      !this.host &&
      (engine.hasPlugin('ssao') ||
        engine.hasPlugin('post-processing') ||
        engine.hasPlugin('tonemap') ||
        engine.hasPlugin('dof'))
    )
      throw margoError('state', 'Bloom owns the output target; remove the other post effect first');
    this.engine = engine;
    this.initialize(engine.gpu);
  }
  private initialize(device: GPUDevice): void {
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const module = device.createShaderModule({ code: chain });
    this.passes = ['prefilter', 'down', 'up'].map((entryPoint) =>
      device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } }),
    );
  }
  /**
   * Encode the same bloom kernel as the viewport into a caller-owned linear rgba16float target. Use an unattached
   * Bloom instance; this owns only its intermediate textures, never an engine plugin or the input/output. Submit the
   * encoder before disposing the instance. Both views must match width/height; exposure is applied to the HDR output.
   */
  encodeImage(context: BloomImageContext, input: GPUTextureView, output: GPUTextureView): void {
    if (this.disposed) throw margoError('disposed', 'Bloom.encodeImage: create a new Bloom after disposal');
    if (this.engine || this.host)
      throw margoError(
        'state',
        'Bloom.encodeImage: this Bloom is attached to an engine; use a separate unattached Bloom',
      );
    this.validate();
    for (const value of [context.width, context.height])
      if (!Number.isInteger(value) || value < 1 || value > (context.device.limits.maxTextureDimension2D ?? 16384))
        throw new RangeError(
          'Bloom.encodeImage: image dimensions must be positive integers within the device texture limit',
        );
    if (this.imageDevice && this.imageDevice !== context.device)
      throw margoError('state', 'Bloom.encodeImage: the GPU device changed; use a new Bloom for the new device');
    if (!this.imageDevice) {
      this.initialize(context.device);
      this.imageDevice = context.device;
    }
    this.stage(context as PostPassContext, input, {
      view: output,
      format: 'rgba16float',
      multisample: { count: 1 },
      hdr: true,
    });
  }
  registerPasses(graph: FrameGraph): void {
    if (this.host) return;
    graph.add({
      name: 'bloom:capture',
      order: -60,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.validate();
        if (
          this.engine!.hasPlugin('ssao') ||
          this.engine!.hasPlugin('post-processing') ||
          this.engine!.hasPlugin('tonemap') ||
          this.engine!.hasPlugin('dof')
        )
          throw margoError('state', 'Bloom cannot share its output target; put both effects in one PostStack');
        this.resize(c);
        this.original = c.color;
        this.originalDepth = c.depth;
        this.originalFormat = c.format;
        if (this.sourceShader !== c.shader) {
          const linearShader = c.shader.replace(
            /let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/,
            'return vec4f(linear,1);',
          );
          if (linearShader === c.shader)
            throw margoError(
              'unsupported',
              "Bloom requires the standard core lighting shader; remove the plugin that replaced core's shader",
            );
          this.sourceShader = c.shader;
          this.linearShader = linearShader;
        }
        this.capture!.begin(c);
        c.shader = this.linearShader;
      },
    });
    graph.add({
      name: 'bloom:scene-pipeline',
      order: -0.25,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        let pipeline = this.scenePipelines.get(c.shader);
        if (!pipeline) {
          const module = c.device.createShaderModule({ code: c.shader });
          pipeline = c.device.createRenderPipeline({
            ...c.descriptor,
            layout: 'auto',
            vertex: { ...c.descriptor.vertex, module },
            fragment: { ...c.descriptor.fragment!, module, targets: [{ format: 'rgba16float' }] },
          });
          this.scenePipelines.set(c.shader, pipeline);
        }
        // Supply the retained HDR variant directly, avoiding a large shader-key concatenation in core.
        this.sceneOptions.pipeline = pipeline;
        if (c.draw !== this.drawScene) this.originalDraw = c.draw;
        c.draw = this.drawScene;
      },
    });
    graph.add({
      name: 'bloom:present',
      order: 30,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private resize(c: PostPassContext): void {
    if (
      this.textures[0]?.width === c.width &&
      this.textures[0]?.height === c.height &&
      this.originalFormat === c.format &&
      this.textures[1]?.format === c.descriptor.depthStencil!.format &&
      this.capture?.samples === (c.descriptor.multisample?.count ?? 4)
    )
      return;
    if (
      this.textures[1]?.format !== c.descriptor.depthStencil!.format ||
      this.capture?.samples !== (c.descriptor.multisample?.count ?? 4)
    )
      this.scenePipelines.clear();
    this.capture?.dispose();
    this.capture = undefined;
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
    const device = c.device;
    this.textures.push(
      device.createTexture({
        size: [c.width, c.height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      }),
    );
    this.textures.push(
      device.createTexture({
        size: [c.width, c.height],
        format: c.descriptor.depthStencil!.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.allocate(device, Math.max(1, Math.ceil(c.width / 2)), Math.max(1, Math.ceil(c.height / 2)));
    this.scene = this.textures[0].createView();
    this.depth = this.textures[1].createView();
    this.present = render(device, composite, c.format, { multisample: c.descriptor.multisample });
    this.link(device, this.scene);
    // Last, so a frame that failed part-way rebuilds everything above on the next one.
    this.capture = new SceneTarget(device, this.textures[0], this.textures[1], c.descriptor.multisample?.count ?? 4);
  }
  /**
   * The chain's two textures, each pushed as soon as it exists so a failed allocation is still released. Mip i of the
   * first is level i going down; mip i of the second is level i plus every level below it.
   */
  private allocate(device: GPUDevice, width: number, height: number): void {
    // Six levels (1/2 to 1/64 of the viewport) where the viewport allows, none smaller than a pixel.
    this.levels = Math.min(6, 32 - Math.clz32(Math.min(width, height)));
    for (const mipLevelCount of [this.levels, Math.max(1, this.levels - 1)])
      this.textures.push(
        device.createTexture({
          size: [width, height],
          mipLevelCount,
          format: 'rgba16float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
  }
  /** The chain over `source` and the presentation bind group that reads it, weighted when the radius asks for it. */
  private link(device: GPUDevice, source: GPUTextureView): void {
    this.weighted = (this.options.radius ?? 0.5) !== 0.5;
    this.group = bind(device, this.present!, [
      source,
      this.chain(device, source),
      { buffer: this.uniform! },
      this.sampler,
    ]);
    this.source = source;
  }
  /** Views, bind groups and dispatch sizes of the chain over `source`; returns the view the presentation reads. */
  private chain(device: GPUDevice, source: GPUTextureView): GPUTextureView {
    if (this.weighted) {
      this.weights ??= device.createBuffer({
        size: this.weightValues.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.weightedUp ??= device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: weighted }), entryPoint: 'up' },
      });
    }
    const [down, up] = this.textures.slice(-2),
      [prefilter, reduce] = this.passes,
      expand = this.weighted ? this.weightedUp! : this.passes[2],
      levels = this.levels,
      mip = (texture: GPUTexture, baseMipLevel: number) => texture.createView({ baseMipLevel, mipLevelCount: 1 }),
      downs = Array.from({ length: levels }, (_, i) => mip(down, i)),
      ups = Array.from({ length: levels - 1 }, (_, i) => mip(up, i)),
      steps: Step[] = [],
      step = (pipeline: GPUComputePipeline, level: number, resources: (GPUBindingResource | undefined)[]) =>
        steps.push([
          pipeline,
          bind(device, pipeline, resources),
          Math.ceil(Math.max(1, down.width >> level) / 8),
          Math.ceil(Math.max(1, down.height >> level) / 8),
        ]);
    for (let i = 0; i < levels; i++)
      step(i ? reduce : prefilter, i, [
        i ? downs[i - 1] : source,
        this.sampler,
        downs[i],
        undefined,
        { buffer: this.uniform! },
      ]);
    // The smallest level stands for itself; each level above adds the tent of the sum below it.
    for (let i = levels - 2; i >= 0; i--)
      step(expand, i, [
        ups[i + 1] ?? downs[i + 1],
        this.sampler,
        ups[i],
        downs[i],
        this.weighted ? { buffer: this.weights!, offset: i * slice, size: 16 } : undefined,
      ]);
    this.steps = steps;
    return ups[0] ?? downs[0];
  }
  private draw(c: PostPassContext): void {
    this.capture!.resolve(c.encoder, true);
    this.apply(c, this.original!, this.originalFormat!);
    this.capture!.restore(c);
    c.draw = this.originalDraw!;
  }
  /** Stacked: run the chain on `input` and composite into `output`, display-encoded only as the final output. */
  private stage(c: PostPassContext, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const device = c.device,
      width = Math.max(1, Math.ceil(c.width / 2)),
      height = Math.max(1, Math.ceil(c.height / 2)),
      key = output.format + output.multisample.count + output.hdr;
    if (this.textures[1]?.width !== width || this.textures[1].height !== height) {
      for (const texture of this.textures) texture.destroy();
      this.textures = [];
      this.source = undefined;
      this.allocate(device, width, height);
    }
    if (this.key !== key) {
      this.key = key;
      this.source = undefined;
      this.present = render(device, output.hdr ? linear : composite, output.format, {
        multisample: output.multisample,
      });
    }
    if (this.source !== input) this.link(device, input);
    this.apply(c, output.view, output.format);
  }
  private apply(c: PostPassContext, view: GPUTextureView, format: GPUTextureFormat): void {
    // Every level carries all of the thresholded light, so the summed chain is averaged over its levels.
    this.values[0] = (this.options.strength ?? 0.8) / this.levels;
    this.values[1] = this.options.exposure ?? 0;
    this.values[2] = format.includes('8unorm') ? 1 / 255 : 0;
    this.values[3] = this.options.threshold ?? 1;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    const radius = this.options.radius ?? 0.5;
    if ((radius !== 0.5) !== this.weighted) this.link(c.device, this.source!);
    if (this.weighted) {
      const weights = bloomWeights(radius, this.levels);
      for (let i = 0; i < this.levels - 1; i++) {
        this.weightValues[(i * slice) / 4] = weights[i];
        this.weightValues[(i * slice) / 4 + 1] = i === this.levels - 2 ? weights[i + 1] : 1;
      }
      c.device.queue.writeBuffer(this.weights!, 0, this.weightValues);
    }
    const compute = c.encoder.beginComputePass();
    for (const [pipeline, group, x, y] of this.steps) {
      compute.setPipeline(pipeline);
      compute.setBindGroup(0, group);
      compute.dispatchWorkgroups(x, y);
    }
    compute.end();
    this.attachment.view = view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.present!);
    pass.setBindGroup(0, this.group!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.capture?.dispose();
    this.capture = undefined;
    this.uniform?.destroy();
    this.weights?.destroy();
    for (const texture of this.textures) texture.destroy();
    this.uniform = this.weights = this.sampler = this.group = this.present = this.weightedUp = undefined;
    this.weighted = false;
    this.passes = [];
    this.steps = [];
    this.textures = [];
    this.scene = this.depth = this.original = this.originalDepth = undefined;
    this.originalFormat = undefined;
    this.sourceShader = this.linearShader = this.key = '';
    this.source = undefined;
    this.scenePipelines.clear();
    this.sceneOptions.pipeline = undefined;
    this.originalDraw = undefined;
    this.imageDevice = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
