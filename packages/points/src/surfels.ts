/// <reference lib="esnext.disposable" preserve="true" />
// High-quality splats. Each point is a small disc (a surfel) with a Gaussian falloff, drawn in three steps so that a scan
// reads as one continuous surface instead of overlapping dots:
//   1. depth: every disc writes depth, pushed back a little, and the view depth of the front surface;
//   2. blend: discs within that push of the front add colour x weight and weight into a float target, the weight falling
//      with the distance from the disc's centre and with the depth behind the front surface;
//   3. resolve: colour = sum / weight, drawn over the scene.
// This is the two-pass splatting of Botsch, Hornung, Zwicker and Kobbelt (High-quality surface splatting on today's GPUs,
// 2005) with the depth weight added. Pushing the scene's own depth keeps meshes and points in one depth test.
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { alphaBlend } from '../../shared/pass.js';
import { checkFog, FOG_BYTES, fogWgsl, writeFog, type FogLike } from '../../shared/fog.js';
import { applyView, viewSize } from '../../shared/view-rect.js';
import { compatibilityLevel, compatTier, requireCompatTier } from '../../shared/compat.js';
import { PointCloud } from './cloud.js';
import { checkStorage } from './storage-limit.js';
import { fillFrame } from './frame.js';
import { allocateBudget, boxInFrustum, mergeRanges, screenArea, worldBox } from './math.js';
import { depthPacking, FLAG, FRAME_BYTES, frameWgsl, pointColorWgsl } from './shaders.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };

type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Bit of `Cloud.flags.x` past the point shader's: the cloud has normals. */
const NORMALS = 512,
  /** The cloud takes the fog. */
  FOGGED = 1024,
  CLOUD_BYTES = 224,
  /** Front depth of a pixel no surfel covers. */
  NOTHING = 3e38,
  /** NOTHING as the four unorm bytes of its float, the clear of the packed front target at the compatibility level. */
  NOTHING_PACKED = ((bytes: Uint8Array) => ({ r: bytes[0] / 255, g: bytes[1] / 255, b: bytes[2] / 255, a: bytes[3] / 255 }))(
    new Uint8Array(new Float32Array([NOTHING]).buffer),
  );

/**
 * The surfel shader. `packed`: the front depth goes out as the four bytes of its float into rgba8unorm (exact, as no
 * blend touches it), for the compatibility level at 4x and for the WebGL2 layer below its full tier. `split`: the sums go
 * out as two rg16float targets, (r, g) and (b, weight), for the compatibility level at 4x: the same half floats the full
 * level adds in rgba16float.
 */
const surfelCode = (packed: boolean, split = packed): string =>
  frameWgsl +
  (packed ? depthPacking : '') +
  fogWgsl(3, 0) +
  /* wgsl */ `
struct Cloud{model:mat4x4f,color:vec4f,size:vec4f,flags:vec4u,blend:vec4f,planes:array<vec4f,6>}
@group(1) @binding(0) var<uniform> cloud:Cloud;
@group(1) @binding(1) var<storage,read> positions:array<f32>;
@group(1) @binding(2) var<storage,read> colors:array<u32>;
@group(1) @binding(3) var<storage,read> sizes:array<f32>;
@group(1) @binding(4) var<storage,read> order:array<u32>;
@group(1) @binding(5) var<storage,read> normals:array<f32>;
@group(2) @binding(0) var front:texture_2d<f32>;
struct VOut{
  @builtin(position) clip:vec4f,
  @location(0) @interpolate(flat) color:vec4f,
  @location(1) quad:vec2f,
  @location(2) world:vec3f,
  @location(3) @interpolate(flat) reach:f32,
}
fn has(bit:u32)->bool{return (cloud.flags.x&bit)!=0u;}
${pointColorWgsl}
fn disc(vi:u32,slot:u32,pushed:bool)->VOut{
  var out:VOut;
  var p=slot;
  if(!has(${FLAG.direct}u)){p=order[slot];}
  let center=cloud.model*vec4f(positions[p*3u],positions[p*3u+1u],positions[p*3u+2u],1.0);
  let middle=frame.viewProj*center;
  var color=vec4f(cloud.color.rgb,1.0);
  if(has(${FLAG.colors}u)){color*=pointColor(p);}
  // Behind the camera, or a point its alpha hides (a hidden class).
  if(!(middle.w>1e-6)||color.a<=0.0||color.a<cloud.color.w){out.clip=vec4f(0.0,0.0,-1.0,1.0);return out;}
  if(has(${FOGGED}u)){color=vec4f(mix(color.rgb,margoFog.color.rgb,fogAmount(center.xyz)),color.a);}
  var size=cloud.size.x;
  if(has(${FLAG.sizes}u)){size*=sizes[p];}
  let perUnit=frame.viewport.z/middle.w;
  let px=clamp(select(size,size*perUnit,has(${FLAG.world}u)),cloud.size.y,cloud.size.z);
  let radius=0.5*px*cloud.size.w/perUnit;
  var right=frame.right.xyz;
  var up=frame.up.xyz;
  if(has(${NORMALS}u)){
    let m=(cloud.model*vec4f(normals[p*3u],normals[p*3u+1u],normals[p*3u+2u],0.0)).xyz;
    if(dot(m,m)>1e-12){
      let n=normalize(m);
      right=normalize(cross(n,select(vec3f(0.0,1.0,0.0),vec3f(1.0,0.0,0.0),abs(n.y)>0.9)));
      up=cross(n,right);
    }
  }
  let corner=CORNERS[vi];
  out.world=center.xyz+(right*corner.x+up*corner.y)*radius;
  out.clip=frame.viewProj*vec4f(out.world,1.0);
  out.reach=cloud.blend.x*radius;
  if(pushed){
    let deep=frame.viewProj*vec4f(out.world-frame.back.xyz*out.reach,1.0);
    out.clip.z=deep.z/deep.w*out.clip.w;
  }
  out.color=color;out.quad=corner;
  return out;
}
@vertex fn vertexDepth(@builtin(vertex_index) vi:u32,@builtin(instance_index) slot:u32)->VOut{return disc(vi,slot,true);}
@vertex fn vertexBlend(@builtin(vertex_index) vi:u32,@builtin(instance_index) slot:u32)->VOut{return disc(vi,slot,false);}
// Outside the disc, or cut by the clipping planes (flags.y & 0xffff of them; bit 16: only behind every plane).
fn cut(i:VOut)->bool{
  if(dot(i.quad,i.quad)>1.0){return true;}
  let count=cloud.flags.y&0xffffu;
  var behind=0u;
  for(var k=0u;k<count;k++){if(dot(cloud.planes[k].xyz,i.world)+cloud.planes[k].w<0.0){behind++;}}
  return count>0u&&select(behind>0u,behind==count,(cloud.flags.y&65536u)!=0u);
}
@fragment fn fragmentDepth(i:VOut)->@location(0) ${packed ? 'vec4f' : 'f32'}{
  if(cut(i)){discard;}
  return ${packed ? 'packDepth(-dot(i.world,frame.back.xyz))' : '-dot(i.world,frame.back.xyz)'};
}
${split ? 'struct Sums{@location(0) rg:vec4f,@location(1) ba:vec4f}' : ''}
@fragment fn fragmentBlend(i:VOut)->${split ? 'Sums' : '@location(0) vec4f'}{
  if(cut(i)){discard;}
  let behind=max(-dot(i.world,frame.back.xyz)-${packed ? 'unpackDepth(textureLoad(front,vec2i(i.clip.xy),0))' : 'textureLoad(front,vec2i(i.clip.xy),0).r'},0.0);
  // Falls to about 0.14 at the rim, and to nothing at the far end of the blend window.
  let w=exp(-2.0*dot(i.quad,i.quad))*(1.0-smoothstep(0.0,max(i.reach,1e-20),behind))*i.color.a;
  let c=i.color.rgb*w;
  return ${split ? 'Sums(vec4f(c.rg,0.0,0.0),vec4f(c.b,w,0.0,0.0))' : 'vec4f(c,w)'};
}
`;

/**
 * Whether the WebGL2 layer rounds this device's r32float targets: below its full tier it stores them as r16float, whose
 * rounding of the front depth (about 0.004 at a depth of 4) moves the blend window and so the weights of nearby discs.
 */
function roundsFloatTargets(device: GPUDevice): boolean {
  const tier = (device as { adapter?: { capabilities?: { tier?: string } } }).adapter?.capabilities?.tier;
  return compatTier(device) === 'webgl2' && tier !== 'full';
}

/** Surfel shader: one disc per point, read from the same storage buffers as the point shader. */
export const surfelShader: string = surfelCode(false);

/**
 * The resolve shader; with a `sample`, the resolve of that sample at the compatibility level at 4x, reading (r, g) and
 * (b, weight) from the two sum targets.
 */
const resolveCode = (sample?: number): string =>
  frameWgsl +
  /* wgsl */ `
@group(1) @binding(0) var sums:texture_2d<f32>;
${sample === undefined ? '' : '@group(1) @binding(1) var rest:texture_2d<f32>;'}
const EDGE=0.25;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  return vec4f(f32(i&1u)*4.0-1.0,f32(i>>1u)*4.0-1.0,0.0,1.0);
}
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f{
  let q=vec2i(position.xy);
  let sum=${sample === undefined ? 'textureLoad(sums,q,0)' : `vec4f(textureLoad(sums,q,${sample}).rg,textureLoad(rest,q,${sample}).rg)`};
  if(sum.a<=0.0){discard;}
  return encode(vec4f(sum.rgb/sum.a,clamp(sum.a/EDGE,0.0,1.0)));
}
`;

/** Resolve shader: the weighted colour sum over its weight. `EDGE` weight or more is fully opaque. */
export const resolveShader: string = resolveCode();

/** Options of `SurfelPlugin`. An empty name or non-finite order throws a TypeError, a value out of range a RangeError. */
export interface SurfelPluginOptions {
  /** Plugin name, unique per engine. Default 'surfels'. */
  name?: string;
  /** Frame graph order. Default 10, as `PointsPlugin`: after the scene, before fat lines and post-processing. */
  order?: number;
  /** Most points drawn per frame across all clouds. Visible blocks share it by screen area. Default 1,000,000. */
  pointBudget?: number;
  /** Disc diameter as a multiple of the point's size: discs must overlap to blend. Above 0. Default 1.5. */
  overlap?: number;
  /** Depth behind the front surface that still blends, as a multiple of the disc's radius. Above 0. Default 1. */
  blendDepth?: number;
}

interface CloudGpu {
  structure: number;
  uniform: GPUBuffer;
  positions: GPUBuffer;
  colors: GPUBuffer | null;
  sizes: GPUBuffer | null;
  order: GPUBuffer | null;
  normals: GPUBuffer | null;
  group: GPUBindGroup;
  floats: Float32Array;
  uints: Uint32Array;
}
interface Draw {
  cloud: PointCloud;
  r: CloudGpu;
  first: number;
  end: number;
}
interface Targets {
  width: number;
  height: number;
  samples: number;
  /** The compatibility level at 4x: sums in two rg16float targets, resolved by a masked draw per sample. */
  split: boolean;
  /** Front depth packed into rgba8unorm: when `split`, and on the WebGL2 layer below its full tier. */
  packed: boolean;
  textures: GPUTexture[];
  frontView: GPUTextureView;
  /** The sum targets: one rgba16float, or rg16float (r, g) and rg16float (b, weight). */
  sumsViews: GPUTextureView[];
  frontGroup: GPUBindGroup;
  /** The resolve's sums. */
  sumsGroup: GPUBindGroup;
  /** Group 2 of the depth pass, which reads nothing there but cannot bind the target it draws into. */
  depthGroup: GPUBindGroup;
}

/**
 * Draws `PointCloud`s as blended surfels over the scene colour and depth (WebGPU), so a scan looks like a continuous
 * surface. A cloud goes to one plugin: add it here instead of to a `PointsPlugin`. `OctreeCloud` takes this plugin
 * in place of `PointsPlugin`. On the WebGL2 backend it warns once and draws nothing.
 */
export class SurfelPlugin implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  pointBudget: number;
  overlap: number;
  blendDepth: number;
  /** Counters of the latest frame. */
  readonly stats = { clouds: 0, blocksVisible: 0, pointsDrawn: 0, drawCalls: 0 };
  private readonly clouds = new Set<PointCloud>();
  private readonly cloudGpu = new Map<PointCloud, CloudGpu>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly resolves = new Map<string, GPURenderPipeline[]>();
  private fogSource: FogLike | null = null;
  private engine?: Engine;
  private device?: GPUDevice;
  private gpu?: {
    module: GPUShaderModule;
    frame: GPUBuffer;
    frameLayout: GPUBindGroupLayout;
    frameGroup: GPUBindGroup;
    cloudLayout: GPUBindGroupLayout;
    fog: GPUBuffer;
    fogLayout: GPUBindGroupLayout;
    fogGroup: GPUBindGroup;
    dummy: GPUBuffer;
  };
  private targets?: Targets;
  private readonly frameData = new Float32Array(FRAME_BYTES / 4);
  private readonly fogData = new Float32Array(FOG_BYTES / 4);
  private readonly view = new Float32Array(16);
  private readonly box = new Float64Array(6);
  private readonly entryBlock: number[] = [];
  private readonly entryCount: number[] = [];
  private readonly entryWeight: number[] = [];
  private allotment = new Uint32Array(0);
  private readonly draws: Draw[] = [];

  /** Same as `engine.use(new SurfelPlugin(...))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: SurfelPluginOptions): SurfelPlugin {
    const value = new SurfelPlugin(options);
    engine.use(value);
    return value;
  }
  constructor(options: SurfelPluginOptions = {}) {
    this.name = options.name ?? 'surfels';
    this.order = options.order ?? 10;
    this.pointBudget = options.pointBudget ?? 1_000_000;
    this.overlap = options.overlap ?? 1.5;
    this.blendDepth = options.blendDepth ?? 1;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw new TypeError('SurfelPlugin needs a non-empty string name and a finite order; fix the options.');
    if (!(this.pointBudget >= 0) || !(this.overlap > 0) || !(this.blendDepth > 0))
      throw new RangeError(
        'Invalid SurfelPlugin option; pointBudget must be 0 or more, overlap and blendDepth above 0',
      );
  }

  /** Clouds drawn by this plugin. */
  get pointClouds(): ReadonlySet<PointCloud> {
    return this.clouds;
  }
  /** The fog clouds are drawn in (see `setFog`), or null. */
  get fog(): FogLike | null {
    return this.fogSource;
  }
  /**
   * Fogs every cloud whose material has `fog` true, as `PointsPlugin.setFog` does: `@margoengine/environment`'s `Fog` or
   * any object with its fields, read every frame. A point takes the fog at its centre. `null` draws without fog.
   * @throws TypeError when `fog` is neither an object nor null; RangeError or TypeError for an invalid field.
   */
  setFog(fog: FogLike | null): this {
    this.fogSource = checkFog(fog);
    return this;
  }

  /** Adds a cloud and returns it. */
  add<T extends PointCloud>(cloud: T): T {
    if (!(cloud instanceof PointCloud)) throw new TypeError('Expected a PointCloud; surfels draw point clouds only');
    cloud.bind(this);
    this.clouds.add(cloud);
    return cloud;
  }
  /** Removes a cloud and frees its GPU buffers. */
  remove(cloud: unknown): void {
    if (!(cloud instanceof PointCloud) || !this.clouds.delete(cloud)) return;
    this.release(cloud);
    cloud.bind(undefined);
  }
  clear(): void {
    for (const cloud of [...this.clouds]) this.remove(cloud);
  }

  setup(engine: Engine): void {
    requireWebGPU(engine, 'SurfelPlugin');
    // The sums need float targets: the layer's ldr tier would store them in 8 bits, clamping every weight sum at 1.
    requireCompatTier(engine.gpu, 'SurfelPlugin weighted sums', 'half-float');
    this.engine = engine;
    const device = (this.device = engine.gpu),
      VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      uniform = (size: number) =>
        device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      storage = (binding: number): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      }),
      frameLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: VF, buffer: { type: 'uniform', minBindingSize: FRAME_BYTES } }],
      }),
      fogLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: VF, buffer: { type: 'uniform', minBindingSize: FOG_BYTES } }],
      }),
      frame = uniform(FRAME_BYTES),
      fog = uniform(FOG_BYTES);
    this.gpu = {
      module: device.createShaderModule({ code: surfelShader }),
      frame,
      frameLayout,
      frameGroup: device.createBindGroup({
        layout: frameLayout,
        entries: [{ binding: 0, resource: { buffer: frame } }],
      }),
      cloudLayout: device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: VF, buffer: { type: 'uniform', minBindingSize: CLOUD_BYTES } },
          storage(1),
          storage(2),
          storage(3),
          storage(4),
          storage(5),
        ],
      }),
      fog,
      fogLayout,
      fogGroup: device.createBindGroup({ layout: fogLayout, entries: [{ binding: 0, resource: { buffer: fog } }] }),
      dummy: device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }),
    };
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }
  onDeviceRestored(engine: Engine): void {
    this.releaseGpu();
    this.setup(engine);
  }
  /** Releases every GPU resource. Clouds stay registered, so the plugin can be used again. */
  dispose(): void {
    const engine = this.engine;
    this.releaseGpu();
    this.engine = undefined;
    // engine.removePlugin calls dispose again, which finds nothing left to free.
    (engine as unknown as EngineKernel | undefined)?.sceneOf(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  private ensure(cloud: PointCloud): CloudGpu {
    let r = this.cloudGpu.get(cloud);
    if (r && r.structure === cloud.structure) return r;
    if (r) this.release(cloud);
    const device = this.device!,
      gpu = this.gpu!,
      n = cloud.count;
    checkStorage(cloud, device.limits, cloud.normals ? 12 : 0);
    const upload = (data: ArrayBufferView | null | undefined, bytes: number): GPUBuffer | null => {
        if (!data) return null;
        const buffer = device.createBuffer({
          size: Math.max(16, bytes),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        if (n) device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>, 0, bytes / 4);
        return buffer;
      },
      positions = upload(cloud.positions, n * 12)!,
      colors = upload(cloud.colors, n * 4 * cloud.colorStride),
      sizes = upload(cloud.sizes, n * 4),
      order = upload(cloud.direct ? null : cloud.blocks.order, n * 4),
      normals = upload(cloud.normals, n * 12),
      uniform = device.createBuffer({ size: CLOUD_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      data = new ArrayBuffer(CLOUD_BYTES);
    r = {
      structure: cloud.structure,
      uniform,
      positions,
      colors,
      sizes,
      order,
      normals,
      group: device.createBindGroup({
        layout: gpu.cloudLayout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: positions } },
          { binding: 2, resource: { buffer: colors ?? gpu.dummy } },
          { binding: 3, resource: { buffer: sizes ?? gpu.dummy } },
          { binding: 4, resource: { buffer: order ?? gpu.dummy } },
          { binding: 5, resource: { buffer: normals ?? gpu.dummy } },
        ],
      }),
      floats: new Float32Array(data),
      uints: new Uint32Array(data),
    };
    cloud.dirty.positions.length = cloud.dirty.colors.length = cloud.dirty.sizes.length = 0;
    this.cloudGpu.set(cloud, r);
    return r;
  }

  private flush(cloud: PointCloud, r: CloudGpu): void {
    const q = this.device!.queue,
      channels = [
        ['positions', r.positions, cloud.positions, 3],
        ['colors', r.colors, cloud.colors, cloud.colorStride],
        ['sizes', r.sizes, cloud.sizes, 1],
      ] as const;
    for (const [channel, buffer, array, stride] of channels) {
      const ranges = cloud.dirty[channel];
      if (!ranges.length) continue;
      if (buffer && array)
        for (const [start, end] of mergeRanges(ranges))
          q.writeBuffer(
            buffer,
            start * stride * 4,
            array as Float32Array<ArrayBuffer>,
            start * stride,
            (end - start) * stride,
          );
      ranges.length = 0;
    }
  }

  private release(cloud: PointCloud): void {
    const r = this.cloudGpu.get(cloud);
    if (!r) return;
    for (const buffer of [r.uniform, r.positions, r.colors, r.sizes, r.order, r.normals]) buffer?.destroy();
    this.cloudGpu.delete(cloud);
  }

  private releaseGpu(): void {
    for (const cloud of [...this.cloudGpu.keys()]) this.release(cloud);
    this.releaseTargets();
    if (this.gpu) for (const buffer of [this.gpu.frame, this.gpu.fog, this.gpu.dummy]) buffer.destroy();
    this.gpu = undefined;
    this.device = undefined;
    this.pipelines.clear();
    this.resolves.clear();
  }
  private releaseTargets(): void {
    for (const texture of this.targets?.textures ?? []) texture.destroy();
    this.targets = undefined;
  }

  /** A sampled-texture layout of `count` depth or sum targets; multisampled ones are unfilterable by definition. */
  private textureLayout(samples: number, count = 1): GPUBindGroupLayout {
    return this.device!.createBindGroupLayout({
      entries: Array.from({ length: count }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float' as const, multisampled: samples > 1 },
      })),
    });
  }

  private frameTargets(context: GpuContext): Targets {
    const samples = context.descriptor.multisample?.count ?? 1,
      { width, height } = context,
      old = this.targets;
    if (old && old.width === width && old.height === height && old.samples === samples) return old;
    const device = this.device!,
      // The level multisamples neither r32float nor rgba16float, but does rgba8unorm and rg16float.
      split = samples > 1 && compatibilityLevel(device),
      packed = split || roundsFloatTargets(device);
    this.releaseTargets();
    const layout = this.textureLayout(samples),
      make = (format: GPUTextureFormat) =>
        device.createTexture({
          size: [width, height],
          sampleCount: samples,
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      textures = [
        make(packed ? 'rgba8unorm' : 'r32float'),
        ...(split ? [make('rg16float'), make('rg16float')] : [make('rgba16float')]),
      ],
      [frontView, ...sumsViews] = textures.map((texture) => texture.createView()),
      group = (views: GPUTextureView[], target = layout) =>
        device.createBindGroup({
          layout: target,
          entries: views.map((resource, binding) => ({ binding, resource })),
        }),
      sumsGroup = split ? group(sumsViews, this.textureLayout(samples, 2)) : group(sumsViews);
    return (this.targets = {
      width,
      height,
      samples,
      split,
      packed,
      textures,
      frontView,
      sumsViews,
      frontGroup: group([frontView]),
      sumsGroup,
      depthGroup: split ? group(sumsViews.slice(0, 1)) : sumsGroup,
    });
  }

  /** The depth, blend and resolve pipelines of one target setup; at the level, one resolve per sample. */
  private passes(context: GpuContext, targets: Targets): [GPURenderPipeline, GPURenderPipeline, GPURenderPipeline[]] {
    const { samples, split, packed } = targets,
      depthFormat = context.descriptor.depthStencil!.format,
      key = `${samples}|${+split}|${+packed}|${context.format}|${depthFormat}`,
      found = this.resolves.get(key);
    if (found) return [this.pipelines.get(`d${key}`)!, this.pipelines.get(`b${key}`)!, found];
    const device = this.device!,
      gpu = this.gpu!,
      layout = device.createPipelineLayout({
        bindGroupLayouts: [gpu.frameLayout, gpu.cloudLayout, this.textureLayout(samples), gpu.fogLayout],
      }),
      multisample = context.descriptor.multisample,
      splatModule =
        samples > 1 || packed
          ? device.createShaderModule({ code: multisampled(surfelCode(packed, split), samples, false) })
          : gpu.module,
      splat = (
        vertex: string,
        fragment: string,
        targets: GPUColorTargetState[],
        depthWriteEnabled: boolean,
      ): GPURenderPipeline =>
        device.createRenderPipeline({
          layout,
          vertex: { module: splatModule, entryPoint: vertex },
          fragment: { module: splatModule, entryPoint: fragment, targets },
          primitive: { topology: 'triangle-strip', cullMode: 'none' },
          multisample,
          depthStencil: { format: depthFormat, depthWriteEnabled, depthCompare: 'greater-equal' },
        }),
      depth = splat('vertexDepth', 'fragmentDepth', [{ format: packed ? 'rgba8unorm' : 'r32float' }], true),
      add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      sum = (format: GPUTextureFormat): GPUColorTargetState => ({ format, blend: { color: add, alpha: add } }),
      blend = splat(
        'vertexBlend',
        'fragmentBlend',
        split ? [sum('rg16float'), sum('rg16float')] : [sum('rgba16float')],
        false,
      ),
      resolveLayout = device.createPipelineLayout({
        bindGroupLayouts: [gpu.frameLayout, this.textureLayout(samples, split ? 2 : 1)],
      }),
      resolve = (code: string, multisample: GPUMultisampleState): GPURenderPipeline => {
        const module = device.createShaderModule({ code });
        return device.createRenderPipeline({
          layout: resolveLayout,
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: context.format, blend: alphaBlend }] },
          primitive: { topology: 'triangle-list' },
          multisample,
        });
      },
      // The level has no sample_index: one draw per sample, its mask writing that sample alone.
      resolves = split
        ? [0, 1, 2, 3].map((sample) =>
            resolve(multisampled(resolveCode(sample), samples, false), {
              count: samples,
              mask: 1 << sample,
            }),
          )
        : [resolve(multisampled(resolveShader, samples, true), { count: samples })];
    this.pipelines.set(`d${key}`, depth);
    this.pipelines.set(`b${key}`, blend);
    this.resolves.set(key, resolves);
    return [depth, blend, resolves];
  }

  private writeCloud(cloud: PointCloud, r: CloudGpu, model: ArrayLike<number>): void {
    const m = cloud.material,
      f = r.floats,
      u = r.uints,
      planes = m['clipping'];
    f.set(model, 0);
    f.set(m.color, 16);
    f[19] = m.alphaTest;
    f[20] = m.size;
    f[21] = m.minPixelSize;
    f[22] = m.maxPixelSize;
    f[23] = this.overlap;
    u[24] =
      (cloud.colors && m.vertexColors ? FLAG.colors : 0) |
      (cloud.sizes ? FLAG.sizes : 0) |
      (m.sizeUnits === 'world' ? FLAG.world : 0) |
      (cloud.direct ? FLAG.direct : 0) |
      (cloud.colorSpace === 'srgb' ? FLAG.srgbColors : 0) |
      (cloud.colorFormat === 'float' ? FLAG.floatColors : 0) |
      (r.normals ? NORMALS : 0) |
      (this.fogSource && m.fog ? FOGGED : 0);
    u[25] = planes.length / 4 + (m.clipIntersection ? 65536 : 0);
    u[26] = u[27] = 0;
    f[28] = this.blendDepth;
    f.set(planes, 32);
    f.fill(0, 32 + planes.length);
    this.device!.queue.writeBuffer(r.uniform, 0, f);
  }

  private readonly execute = (context: PassContext): void => {
    const s = this.stats;
    s.clouds = s.blocksVisible = s.pointsDrawn = s.drawCalls = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.gpu || !this.engine || context.device !== this.device)
      return;
    if (!this.clouds.size) return;
    const engine = this.engine as unknown as EngineKernel,
      device = this.device,
      gpu = this.gpu,
      camera = context.camera,
      f = this.frameData,
      [viewWidth, viewHeight] = viewSize(context),
      orthographic = fillFrame(f, this.view, camera, viewWidth, viewHeight, context.format);
    device.queue.writeBuffer(gpu.frame, 0, f);
    if (this.fogSource) {
      writeFog(this.fogSource, camera.position, this.fogData);
      device.queue.writeBuffer(gpu.fog, 0, this.fogData);
    }
    const blocksOf = this.entryBlock,
      counts = this.entryCount,
      weights = this.entryWeight,
      draws = this.draws;
    blocksOf.length = counts.length = weights.length = 0;
    let drawCount = 0;
    for (const cloud of this.clouds) {
      if (!cloud.visible || !cloud.count) continue;
      const mesh = cloud.attachedMesh,
        model = mesh ? meshWorldMatrix(engine, mesh) : cloud.matrix;
      if (!model) continue;
      cloud.material.validate();
      const r = this.ensure(cloud);
      this.flush(cloud, r);
      this.writeCloud(cloud, r, model);
      s.clouds++;
      const blocks = cloud.blocks,
        first = blocksOf.length;
      for (let b = 0; b < blocks.length; b++) {
        if (!blocks.counts[b]) continue;
        worldBox(blocks.bounds, b, model, this.box);
        if (!boxInFrustum(this.box, camera.planes, cloud.cullMargin)) continue;
        blocksOf.push(b);
        counts.push(blocks.counts[b]);
        weights.push(screenArea(this.box, camera.position, f[18], f[16], f[17], orthographic));
      }
      s.blocksVisible += blocksOf.length - first;
      if (blocksOf.length > first) draws[drawCount++] = { cloud, r, first, end: blocksOf.length };
    }
    if (!drawCount) return;
    if (this.allotment.length < blocksOf.length)
      this.allotment = new Uint32Array(Math.max(16, blocksOf.length, this.allotment.length * 2));
    const allotment = this.allotment;
    s.pointsDrawn = allocateBudget(counts, weights, blocksOf.length, this.pointBudget, allotment);

    const gpuContext = context as GpuContext,
      targets = this.frameTargets(gpuContext),
      [depthPipeline, blendPipeline, resolvePipelines] = this.passes(gpuContext, targets),
      stencil = context.descriptor.depthStencil!.format.includes('stencil'),
      sceneDepth: GPURenderPassDepthStencilAttachment = {
        view: context.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(stencil ? { stencilReadOnly: true } : {}),
      },
      discs = (pass: GPURenderPassEncoder) => {
        applyView(pass, context);
        pass.setBindGroup(0, gpu.frameGroup);
        pass.setBindGroup(3, gpu.fogGroup);
        for (let i = 0; i < drawCount; i++) {
          const { cloud, r, first, end } = draws[i];
          pass.setBindGroup(1, r.group);
          for (let e = first; e < end; e++) {
            if (!allotment[e]) continue;
            pass.draw(4, allotment[e], 0, cloud.blocks.starts[blocksOf[e]]);
            s.drawCalls++;
          }
        }
        pass.end();
      };
    const depth = context.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targets.frontView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: targets.packed ? NOTHING_PACKED : { r: NOTHING, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: sceneDepth,
    });
    depth.setPipeline(depthPipeline);
    depth.setBindGroup(2, targets.depthGroup);
    discs(depth);
    const blend = context.encoder.beginRenderPass({
      colorAttachments: targets.sumsViews.map((view) => ({
        view,
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
      depthStencilAttachment: sceneDepth,
    });
    blend.setPipeline(blendPipeline);
    blend.setBindGroup(2, targets.frontGroup);
    discs(blend);
    const resolve = context.encoder.beginRenderPass({
      colorAttachments: [{ view: context.color, loadOp: 'load', storeOp: 'store' }],
    });
    applyView(resolve, context);
    resolve.setBindGroup(0, gpu.frameGroup);
    resolve.setBindGroup(1, targets.sumsGroup);
    for (const pipeline of resolvePipelines) {
      resolve.setPipeline(pipeline);
      resolve.draw(3);
      s.drawCalls++;
    }
    resolve.end();
  };
}

/**
 * `code` for a multisampled target: textures become multisampled. The resolve (`perSample`) reads each pixel's matching
 * sample, as averaging empty samples into a sum would be wrong; the blend reads sample 0, as the front depth of a pixel
 * only needs to be near.
 */
function multisampled(code: string, samples: number, perSample: boolean): string {
  if (samples === 1) return code;
  const out = code.replaceAll('texture_2d<f32>', 'texture_multisampled_2d<f32>');
  return perSample
    ? out
        .replace('position:vec4f)', 'position:vec4f,@builtin(sample_index) sample:u32)')
        .replace('sums,q,0)', 'sums,q,i32(sample))')
    : out;
}

