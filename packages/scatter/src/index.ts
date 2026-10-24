/// <reference lib="esnext.disposable" preserve="true" />
import { Geometry, PbrMaterial, type EngineKernel } from '@margoengine/core';
export { ScatterInstances, type ScatterBatch } from './instances.js';
import { freeLocation } from './instances.js';
export { randomPlacements, radialPlacements } from './candidates.js';
export {
  PlacementLayout,
  spacePlacements,
  clearPlacements,
  placementBounds,
  instanceTransforms,
  groundTransforms,
  type GroundPlacement,
  type GroundBounds,
  type GroundCircle,
  type Placement,
} from './placement.js';
import { windShader, validateWind, type ScatterWind } from './wind.js';
import { poseShader } from './pose.js';
import { sameBindings, snapshotBindings } from './bindings.js';
export type { ScatterWind } from './wind.js';
import { validateExclusions, type GroundBounds } from './placement.js';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { group, compute, dispatch, overlayPass } from '../../shared/gpu.js';
import { preset } from '../../shared/preset.js';
import { displayShader } from '../../shared/display.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView } from '../../shared/view-rect.js';
declare const GPUBufferUsage: {
  VERTEX: number;
  INDEX: number;
  STORAGE: number;
  INDIRECT: number;
  UNIFORM: number;
  COPY_DST: number;
};
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type ScatterPassContext = Extract<PassContext, { backend: 'webgpu' }>;
const heightFormats = ['r32float', 'r16float', 'rgba32float', 'rgba16float', 'r8unorm'];
/** Grass-blade shading for GPU `Scatter` (see `ScatterOptions.blades`). */
export interface ScatterBlades {
  /** Albedo lost at the root, 0-1 (default 0.5): blades darken linearly from the tip (1) to the root (1 - rootShade). */
  rootShade?: number;
  /**
   * Extra blade width at the last LOD distance as a fraction, 0-10 (default 1: twice as wide), growing linearly with
   * distance from 0 at the camera. Thin distant blades otherwise fall below a pixel and shimmer.
   */
  widen?: number;
}
/** GPU scatter rules, fixed at construction (out of range throws RangeError). Distances are world units. */
export interface ScatterOptions {
  /** Candidate instances on a stratified grid, an integer 1-1,000,000 (GPU memory: three buffers of this many). Default 10,000. */
  count?: number;
  /** XZ extent covered around `center`, each 0-100,000 (exclusive of 0). Default [50, 50]. */
  area?: readonly [number, number];
  /** World centre of the area; its Y is added to the heightmap. Default [0, 0, 0]. */
  center?: readonly [number, number, number];
  /** Fraction of candidates kept, 0..1. Default 1. */
  density?: number;
  /** Lowest world height that gets instances. Default -10,000. */
  minHeight?: number;
  /** Highest world height that gets instances, >= `minHeight`. Default 10,000. */
  maxHeight?: number;
  /** Steepest ground slope that gets instances, degrees 0-90. Default 45. */
  maxSlope?: number;
  /** Random uniform scale range [min, max], 0 < min <= max <= 100. Default [0.7, 1.3]. */
  scale?: readonly [number, number];
  /** Increasing distances where the near, middle and far meshes end; the third is the culling distance. Default [25, 60, 120]. */
  lod?: readonly [number, number, number];
  /**
   * Width of the dithered cross-fade between LOD meshes, in world units (default 2). 0 switches hard and compiles the
   * shaders without the fade's `discard`, which keeps early depth rejection on tile-based phone GPUs; one shared
   * Geometry for all rings does the same. The phone quality tier sets 0 when the app leaves it unset.
   */
  lodFade?: number;
  /** Placement seed, an integer 0..2^32-1. Default 1. */
  seed?: number;
  /** Diffuse colour (linear RGB 0..1) when no `material` is given. Default [0.12, 0.35, 0.08]. */
  color?: readonly [number, number, number];
  /** Shade instances with core's PBR shader (and receive PCSS shadows) instead of the simple diffuse colour. */
  material?: PbrMaterial;
  /** World XZ rectangles `[minX, minZ, maxX, maxZ]` kept free of instances (up to 1,000,000). */
  exclusions?: readonly GroundBounds[];
  /**
   * Red-channel height texture covering `area` around `center` (r32float, r16float, rgba32float, rgba16float or
   * r8unorm), read every frame. Default: flat ground.
   */
  heightmap?: () => GPUTexture | undefined;
  /** Rooted wind bend `[directionX, directionZ, strength]`. Omitted: static. */
  wind?: ScatterWind;
  /**
   * How far each instance's up axis tilts from world +Y toward the ground normal, 0-1 (default 0, upright). 1 lays
   * stones and debris along the slope; grass and trees usually stay upright.
   */
  alignToGround?: number;
  /**
   * Lowers each instance by `sink * scale * (1 + tan(slope))` world units (default 0), so roots and stone bases stay
   * buried on the downhill side of steeper ground. The heightmap gives the slope.
   */
  sink?: number;
  /**
   * World units before the last LOD distance over which instances scale down to zero (default 0: cut at that
   * distance). Shrinking instead of cutting keeps the edge of a grass field from popping, without a fragment
   * `discard`; widths past the last distance are clamped to it.
   */
  edgeShrink?: number;
  /**
   * Shades instances as grass blades: upright geometry whose local origin is the root and whose tallest vertex is the
   * tip (default off). Albedo darkens toward the root; the shading normal blends from the ground normal at the root to
   * the blade's own normal at the tip, and fully to the ground normal by the last LOD distance, so a field shades like
   * the terrain under it instead of speckling (after Wohllaib, GDC 2021); distant blades widen. `{}` uses the defaults.
   */
  blades?: ScatterBlades;
}
const frame = `
struct Frame {camera:mat4x4f,eye:vec4f,area:vec4f,rules:vec4f,scale:vec4f,lod:vec4f,ids:vec4u,color:vec4f,planes:array<vec4f,6>,wind:vec4f,ground:vec4f,blade:vec4f}
struct Instance {position:vec4f,rotation:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
`;
const cull =
  frame +
  `
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> near:array<Instance>;
@group(0) @binding(3) var<storage,read_write> middle:array<Instance>;
@group(0) @binding(4) var<storage,read_write> far:array<Instance>;
struct Command {indices:u32,count:atomic<u32>,first:u32,base:u32,instance:u32}
@group(0) @binding(5) var<storage,read_write> commands:array<Command,3>;
@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;
fn hash(value:u32)->f32 {var x=value^frame.ids.y;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x)/4294967296.0;}
fn height(p:vec2i)->f32 {return textureLoad(terrain,clamp(p,vec2i(0),vec2i(textureDimensions(terrain))-1),0).r;}
fn emit(ring:u32,instance:Instance){
 let slot=atomicAdd(&commands[ring].count,1u);
 if(ring==0u){near[slot]=instance;}else if(ring==1u){middle[slot]=instance;}else{far[slot]=instance;}
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=frame.ids.x||hash(i*7u+1u)>frame.rules.w){return;}
 let columns=frame.ids.z;let rows=(frame.ids.x+columns-1u)/columns;
 let uv=vec2f((f32(i%columns)+hash(i*7u+2u))/f32(columns),(f32(i/columns)+hash(i*7u+3u))/f32(rows));
 // Texels hold cell-centre heights: interpolate the four centres around the instance (a nearest read is off by half a
 // cell times the slope), and take the normal from the same bilinear patch's gradient.
 let size=vec2i(textureDimensions(terrain));let texel=uv*vec2f(size)-0.5;let cell=vec2i(floor(texel));let f=texel-floor(texel);
 let h00=height(cell);let h10=height(cell+vec2i(1,0));let h01=height(cell+vec2i(0,1));let h11=height(cell+vec2i(1,1));
 let h=mix(mix(h00,h10,f.x),mix(h01,h11,f.x),f.y)+frame.scale.z;
 let normal=normalize(vec3f(-mix(h10-h00,h11-h01,f.y)*f32(size.x)/frame.area.x,1.0,-mix(h01-h00,h11-h10,f.x)*f32(size.y)/frame.area.y));
 if(h<frame.rules.x||h>frame.rules.y||normal.y<frame.rules.z){return;}
 let scale=mix(frame.scale.x,frame.scale.y,hash(i*7u+4u));let radius=frame.lod.w*scale;
 // Sink deeper on slopes: tan(slope) is how far the ground falls per unit of footprint.
 let p=vec3f((uv.x-0.5)*frame.area.x+frame.area.z,h-frame.ground.y*scale*(1.0+length(normal.xz)/max(normal.y,0.2)),(uv.y-0.5)*frame.area.y+frame.area.w);
 for(var j=0u;j<u32(frame.eye.w);j++){
  let bounds=exclusions[j];let offset=p.xz-clamp(p.xz,bounds.xy,bounds.zw);
  if(dot(offset,offset)<=radius*radius){return;}
 }
 for(var j=0u;j<6u;j++){if(dot(frame.planes[j].xyz,p)+frame.planes[j].w < -radius){return;}}
 let d=distance(p,frame.eye.xyz);if(d>frame.lod.z){return;}
 // edgeShrink: scale toward zero approaching the cull distance instead of cutting there.
 let shrink=select(1.0,clamp((frame.lod.z-d)/frame.ground.z,0.0,1.0),frame.ground.z>0.0);
 let angle=hash(i*7u+5u)*6.2831853;let q=round((normal.xz*0.5+0.5)*4095.0);
 var instance=Instance(vec4f(p,scale*shrink),vec4f(angle,q.x+q.y*4096.0,0,0));
 for(var ring=0u;ring<2u;ring++){
  if((frame.ids.w&(1u<<ring))!=0u&&frame.scale.w>0.0&&abs(d-frame.lod[ring])<frame.scale.w*0.5){
   instance.rotation.z=(d-frame.lod[ring])/frame.scale.w+0.5;instance.rotation.w=1.0;emit(ring,instance);
   instance.rotation.w=2.0;emit(ring+1u,instance);return;
  }
 }
 emit(select(select(2u,1u,d<frame.lod.y),0u,d<frame.lod.x),instance);
}`;
const fadeCode = `
fn lodVisible(pixel:vec2f,fade:vec2f)->bool {
 if(fade.y==0.0){return true;}
 let bayer=array<u32,16>(0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);let p=vec2u(pixel)%4u;
 let threshold=(f32(bayer[p.y*4u+p.x])+0.5)/16.0;
 return select(fade.x>=threshold,fade.x<threshold,fade.y==1.0);
}
`;
const renderCode =
  frame +
  fadeCode +
  windShader +
  poseShader +
  `
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) @interpolate(flat) lodFade:vec2f,@location(2) ground:vec4f,@location(3) shade:f32}
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->Output{
 let data=instances[index];let pose=scatterPose(p,n,data.position,data.rotation,frame.ground,frame.blade,frame.eye.xyz,frame.wind);
 return Output(frame.camera*vec4f(pose.world,1),pose.normal,data.rotation.zw,pose.ground,pose.shade);
}
${displayShader}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {if(!lodVisible(i.clip.xy,i.lodFade)){discard;}let n=normalize(mix(normalize(i.normal)*select(-1.0,1.0,front),i.ground.xyz,i.ground.w));var color=frame.color.rgb*i.shade*(0.25+max(0.0,dot(n,normalize(vec3f(1,2,1))))*0.75);if(frame.color.w<0.5){color=toDisplay(color);}return vec4f(color,1);}
`;
// Without a LOD fade no instance is ever dithered out, yet any `discard` in a fragment shader stops tile-based (phone)
// GPUs from rejecting hidden fragments before shading. This variant has no fade varying, no mask and no discard.
const solidCode = renderCode
  .replace(fadeCode, '')
  .replace(',@location(1) @interpolate(flat) lodFade:vec2f', '')
  .replace(',data.rotation.zw,', ',')
  .replace('if(!lodVisible(i.clip.xy,i.lodFade)){discard;}', '');
/** Lit vertex stage: `fade` writes the LOD fade varying, `blades` the root shade and the ground-normal varying. */
const pbrVertex = (fade: boolean, blades: boolean) =>
  windShader +
  poseShader +
  `
struct ScatterInstance {position:vec4f,rotation:vec4f}
@group(1) @binding(0) var<storage,read> instances:array<ScatterInstance>;
@group(1) @binding(1) var<uniform> material:array<vec4f,5>;
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->Output {
 let data=instances[index];let pose=scatterPose(p,n,data.position,data.rotation,material[3],material[4],frame.eye.xyz,material[2]);
 var o:Output;o.position=pose.world;o.clip=frame.camera*vec4f(o.position,1);o.normal=pose.normal;
 o.color=material[0].rgb${blades ? '*pose.shade' : ''};o.material=vec4f(material[1].xyz,1);${fade ? 'o.lodFade=data.rotation.zw;' : ''}${blades ? 'o.ground=pose.ground;' : ''}return o;
}
`;
const coreNormal = 'let n=normalize(i.normal)*select(-1.0,1.0,facing);';
let serial = 0;
/**
 * GPU-distributed ground cover: seeded, stratified placement under density, height and slope rules, compute-culled
 * every frame into three distance LOD rings drawn with indexed indirect draws. Pass one Geometry or one per ring
 * (near, middle, far). `Scatter.attach(engine, geometry, options)`; WebGPU only.
 * @throws RangeError when an option is out of range (constructor) or the buffers exceed device limits (attach);
 * TypeError when `material` is not a core PbrMaterial or `blades` is not an object.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` during a frame when
 * the heightmap is not a sampleable height texture.
 */
export class Scatter implements EnginePlugin {
  readonly name = 'scatter:' + ++serial;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private instances: GPUBuffer[] = [];
  private vertices: GPUBuffer[] = [];
  private indices: GPUBuffer[] = [];
  private commands?: GPUBuffer;
  private fallback?: GPUTexture;
  private compute?: GPUComputePipeline;
  private pipelines = new Map<string, GPURenderPipeline>();
  private readonly values = new Float32Array(80);
  private readonly meta = new Uint32Array(this.values.buffer);
  private readonly geometries: readonly Geometry[];
  private disposed = false;
  readonly count: number;
  private readonly materialValues = new Float32Array(20);
  private time = 0;
  private terrain?: GPUTexture;
  private computeGroup?: GPUBindGroup;
  private readonly renderGroups = new Map<GPURenderPipeline, GPUBindGroup[]>();
  private exclusionBuffer?: GPUBuffer;
  private readonly exclusionValues: Float32Array;
  private pbrUniform?: GPUBuffer;
  private materialUniform?: GPUBuffer;
  private readonly pbrValues = new Float32Array(32);
  private pbrShader = '';
  private pbrBindings: GPUBindGroupEntry[] = [];
  private readonly pbrGroups = new Map<GPURenderPipeline, GPUBindGroup>();
  private readonly presentation = overlayPass(true);
  private readonly attachment = this.presentation.colorAttachments[0];
  private readonly depthAttachment = this.presentation.depthStencilAttachment;
  private readonly options: ScatterOptions;
  /** Whether any instance can fade between LOD meshes: shaders keep the dither `discard` only then. */
  private readonly fade: boolean;
  constructor(geometry: Geometry | readonly [Geometry, Geometry, Geometry], input: ScatterOptions = {}) {
    this.options = preset('scatter', input);
    const options = this.options;
    this.geometries = geometry instanceof Geometry ? [geometry, geometry, geometry] : [...geometry];
    const {
      count = 10000,
      area = [50, 50],
      center = [0, 0, 0],
      density = 1,
      minHeight = -10000,
      maxHeight = 10000,
      maxSlope = 45,
      scale = [0.7, 1.3],
      lod = [25, 60, 120],
      lodFade = 2,
      seed = 1,
      color = [0.12, 0.35, 0.08],
      alignToGround = 0,
      sink = 0,
      edgeShrink = 0,
    } = options;
    if (
      this.geometries.length !== 3 ||
      this.geometries.some((g) => !(g instanceof Geometry)) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 1000000 ||
      area.length !== 2 ||
      area.some((v) => !Number.isFinite(v) || v <= 0 || v > 100000) ||
      center.length !== 3 ||
      center.some((v) => !Number.isFinite(Math.fround(v))) ||
      ![density, minHeight, maxHeight, maxSlope].every(Number.isFinite) ||
      density < 0 ||
      density > 1 ||
      minHeight > maxHeight ||
      maxSlope < 0 ||
      maxSlope > 90 ||
      scale.length !== 2 ||
      scale.some((v) => !Number.isFinite(v) || v <= 0 || v > 100) ||
      scale[0] > scale[1] ||
      lod.length !== 3 ||
      lod.some((v, i) => !Number.isFinite(v) || v <= 0 || v > 100000 || (i > 0 && v <= lod[i - 1])) ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 0xffffffff ||
      color.length !== 3 ||
      color.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
      (options.heightmap !== undefined && typeof options.heightmap !== 'function')
    )
      throw new RangeError('Invalid scatter rules');
    if (options.material !== undefined && !(options.material instanceof PbrMaterial))
      throw new TypeError('Expected a PBR scatter material');
    if (!Number.isFinite(lodFade) || lodFade < 0 || lodFade > 100000) throw new RangeError('Invalid scatter LOD fade');
    if (
      ![alignToGround, sink].every(Number.isFinite) ||
      alignToGround < 0 ||
      alignToGround > 1 ||
      sink < 0 ||
      sink > 100000
    )
      throw new RangeError('Scatter alignToGround must be 0-1 and sink a distance from 0 to 100000');
    if (!Number.isFinite(edgeShrink) || edgeShrink < 0 || edgeShrink > 100000)
      throw new RangeError('Scatter edgeShrink must be a distance from 0 to 100000');
    if (options.wind) validateWind(options.wind);
    const exclusions = options.exclusions ?? [];
    validateExclusions(exclusions);
    this.exclusionValues = new Float32Array(Math.max(1, exclusions.length) * 4);
    for (let i = 0; i < exclusions.length; i++) this.exclusionValues.set(exclusions[i], i * 4);
    this.values[19] = exclusions.length; // eye.w holds the fixed exclusion count.
    this.count = count;
    this.values.set(
      [
        area[0],
        area[1],
        center[0],
        center[2],
        minHeight,
        maxHeight,
        Math.cos((maxSlope * Math.PI) / 180),
        density,
        scale[0],
        scale[1],
        center[1],
        0,
        ...lod,
        Math.max(...this.geometries.map((g) => g.bounds[3] + Math.hypot(g.bounds[0], g.bounds[1], g.bounds[2]))),
      ],
      20,
    );
    this.values[35] *= options.wind ? 2 : 1;
    this.values[31] = Math.min(lodFade, 2 * lod[0], lod[1] - lod[0], 2 * (lod[2] - lod[1]));
    this.meta.set(
      [
        count,
        seed,
        Math.ceil(Math.sqrt((count * area[0]) / area[1])),
        +(this.geometries[0] !== this.geometries[1]) + 2 * +(this.geometries[1] !== this.geometries[2]),
      ],
      36,
    );
    this.values.set(color, 40);
    this.values[72] = alignToGround;
    this.values[73] = sink;
    this.values[74] = Math.min(edgeShrink, lod[2]);
    const { blades } = options;
    if (blades !== undefined) {
      if (typeof blades !== 'object' || blades === null)
        throw new TypeError('Scatter blades must be an options object');
      const { rootShade = 0.5, widen = 1 } = blades;
      if (![rootShade, widen].every(Number.isFinite) || rootShade < 0 || rootShade > 1 || widen < 0 || widen > 10)
        throw new RangeError('Scatter blades need rootShade 0-1 and widen 0-10');
      let top = 0;
      for (const g of this.geometries)
        for (let i = 1; i < g.vertices.length; i += 6) top = Math.max(top, g.vertices[i]);
      if (!(top > 0)) throw new RangeError('Scatter blades need meshes that rise above their local origin (the root)');
      this.values.set([rootShade, widen / lod[2], 1 / top, 1 / lod[2]], 76);
      this.values[35] *= 1 + widen; // cull bounds include the widest blades
    }
    // Compute emits fading instances only for a nonzero width between rings that use different meshes.
    this.fade = this.values[31] > 0 && this.meta[39] !== 0;
  }
  static attach(
    engine: EngineKernel,
    geometry: Geometry | readonly [Geometry, Geometry, Geometry],
    options: ScatterOptions = {},
  ): Scatter {
    const effect = new Scatter(geometry, options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Scatter requires WebGPU; attach a new Scatter to a WebGPU engine',
      );
    const d = engine.gpu;
    this.engine = engine;
    if (
      Math.max(this.count * 32, this.exclusionValues.byteLength) >
        Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize) ||
      Math.ceil(this.count / 64) > d.limits.maxComputeWorkgroupsPerDimension
    )
      throw new RangeError('Scatter exceeds GPU limits');
    this.uniform = d.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.exclusionBuffer = d.createBuffer({
      size: this.exclusionValues.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.exclusionBuffer, 0, this.exclusionValues as Float32Array<ArrayBuffer>);
    if (this.options.material) {
      this.pbrUniform = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.materialUniform = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.materialValues.set(this.options.material.data);
    }
    this.commands = d.createBuffer({
      size: 60,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    const commands = new Uint32Array(15);
    for (let i = 0; i < 3; i++) {
      const g = this.geometries[i];
      commands[i * 5] = g.indices.length;
      const v = d.createBuffer({ size: g.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.vertices.push(v);
      const index = d.createBuffer({
        size: g.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.indices.push(index);
      d.queue.writeBuffer(v, 0, g.vertices as Float32Array<ArrayBuffer>);
      d.queue.writeBuffer(index, 0, g.indices as Uint32Array<ArrayBuffer>);
      this.instances.push(d.createBuffer({ size: this.count * 32, usage: GPUBufferUsage.STORAGE }));
    }
    d.queue.writeBuffer(this.commands, 0, commands);
    this.fallback = d.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    d.queue.writeTexture({ texture: this.fallback }, new Float32Array(1), { bytesPerRow: 4 }, [1, 1]);
    this.compute = compute(d, cull);
  }
  onPreUpdate(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid scatter delta');
    this.time += delta;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':distribute',
      order: -10,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const terrain = this.options.heightmap?.() ?? this.fallback!;
        if (!heightFormats.includes(terrain.format) || !(terrain.usage & GPUTextureUsage.TEXTURE_BINDING))
          throw new MargoError(
            'state',
            'Scatter needs a sampleable floating-height texture; return one from options.heightmap',
          );
        this.values.fill(0, 68, 71);
        if (this.options.wind) {
          const wind = this.options.wind,
            length = validateWind(wind);
          this.values[68] = wind[0] / length;
          this.values[69] = wind[1] / length;
          this.values[70] = wind[2];
        }
        this.values[71] = this.time;
        this.values.set(c.camera.matrix);
        this.values.set(c.camera.position, 16);
        this.values.set(c.camera.planes, 44);
        this.values[43] = +(c.format === 'rgba16float');
        c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
        for (let i = 0; i < 3; i++) c.encoder.clearBuffer(this.commands!, i * 20 + 4, 4);
        if (this.terrain !== terrain || !this.computeGroup) {
          this.computeGroup = group(c.device, this.compute!, [
            { buffer: this.uniform! },
            terrain.createView(),
            ...this.instances.map((buffer) => ({ buffer })),
            { buffer: this.commands! },
            { buffer: this.exclusionBuffer! },
          ]);
          this.terrain = terrain;
        }
        dispatch(c, this.compute!, this.computeGroup, Math.ceil(this.count / 64));
      },
    });
    graph.add({
      name: this.name + ':lod',
      order: 1.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private draw(c: ScatterPassContext): void {
    const lit = !!this.options.material;
    if (lit) {
      this.materialValues.set(this.options.material!.data);
      this.materialValues.set(this.values.subarray(68, 80), 8); // wind, ground fit, blades
      c.device.queue.writeBuffer(this.materialUniform!, 0, this.materialValues as Float32Array<ArrayBuffer>);
      if (this.pbrShader !== c.shader) {
        this.pipelines.clear();
        this.renderGroups.clear();
        this.pbrGroups.clear();
        this.pbrShader = c.shader;
      }
      if (!sameBindings(this.pbrBindings, c.bindings)) {
        this.pbrGroups.clear();
        this.pbrBindings = snapshotBindings(c.bindings);
      }
      this.pbrValues.set(c.camera.matrix);
      this.pbrValues.set(c.camera.position, 16);
      this.pbrValues.set(this.engine!.lighting.direction, 20);
      this.pbrValues.set(this.engine!.lighting.radiance, 24);
      this.pbrValues.fill(1, 28, 31);
      if (this.engine!.lighting.ambient) this.pbrValues.set(this.engine!.lighting.ambient, 28);
      c.device.queue.writeBuffer(this.pbrUniform!, 0, this.pbrValues as Float32Array<ArrayBuffer>);
    }
    // Without the fade, the lit shader also drops core's back-face discard: override C=1 removes it at pipeline
    // creation (as core's culled pipeline does), and single-sided materials cull back faces in the rasterizer
    // instead. Toggling `doubleSided` later picks the other cached pipeline.
    const solid = lit && !this.fade && c.shader.includes('override C='),
      culled = solid && this.options.material!.data[6] < 0.5;
    const key =
      c.format +
      ':' +
      c.descriptor.multisample?.count +
      ':' +
      c.descriptor.depthStencil!.format +
      (culled ? ':culled' : '');
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const blades = this.values[78] > 0,
        vertex = pbrVertex(this.fade, blades);
      let code = !lit ? (this.fade ? renderCode : solidCode) : c.shader.replace(/struct Input \{[^}]+\}/, '');
      if (lit) {
        // After core's varyings and any a patch added to its Output (terrain's mesh id): 4 and 5 on a plain shader.
        const at = freeLocation(/struct Output \{[^}]+\}/.exec(code)?.[0] ?? '');
        code = code
          .replace(
            '@location(3) material:vec4f',
            '@location(3) material:vec4f' +
              (this.fade ? `,@location(${at}) @interpolate(flat) lodFade:vec2f` : '') +
              (blades ? `,@location(${at + 1}) ground:vec4f` : ''),
          )
          .replace(
            /@vertex fn vertex\([\s\S]*?(?=@fragment)/,
            c.shader.includes('var<uniform> taaCamera:')
              ? vertex.replace('o.clip=frame.camera*', 'o.clip=taaCamera*')
              : vertex,
          );
        if (this.fade)
          code =
            code.replace(/(@fragment fn fragment[^{]+\{)/, '$1\n if(!lodVisible(i.clip.xy,i.lodFade)){discard;}') +
            fadeCode;
        // Blades bend core's shading normal after its back-face flip, so both sides of a blade share the ground term.
        if (blades)
          code = code.replace(
            coreNormal,
            'let n=normalize(mix(normalize(i.normal)*select(-1.0,1.0,facing),i.ground.xyz,i.ground.w));',
          );
      }
      const module = c.device.createShaderModule({ code });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 24,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: c.format }],
          ...(solid ? { constants: { C: 1 } } : {}),
        },
        ...(culled ? { primitive: { cullMode: 'back' as const } } : {}),
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
      });
      this.pipelines.set(key, pipeline);
    }
    let groups = this.renderGroups.get(pipeline);
    if (!groups) {
      groups = this.instances.map((buffer) =>
        lit
          ? c.device.createBindGroup({
              layout: pipeline!.getBindGroupLayout(1),
              entries: [
                { binding: 0, resource: { buffer } },
                { binding: 1, resource: { buffer: this.materialUniform! } },
              ],
            })
          : group(c.device, pipeline!, [{ buffer: this.uniform! }, { buffer }]),
      );
      this.renderGroups.set(pipeline, groups);
    }
    let lighting = this.pbrGroups.get(pipeline);
    if (lit && !lighting) {
      lighting = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.pbrUniform! } }, ...c.bindings],
      });
      this.pbrGroups.set(pipeline, lighting);
    }
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    applyView(pass, c);
    pass.setPipeline(pipeline);
    if (lit) pass.setBindGroup(0, lighting!);
    for (let i = 0; i < 3; i++) {
      pass.setBindGroup(lit ? 1 : 0, groups[i]);
      pass.setVertexBuffer(0, this.vertices[i]);
      pass.setIndexBuffer(this.indices[i], 'uint32');
      pass.drawIndexedIndirect(this.commands!, i * 20);
    }
    pass.end();
  }
  private release(): void {
    for (const b of [...this.instances, ...this.vertices, ...this.indices]) b.destroy();
    this.instances = [];
    this.vertices = [];
    this.indices = [];
    this.exclusionBuffer?.destroy();
    this.exclusionBuffer = undefined;
    this.uniform?.destroy();
    this.commands?.destroy();
    this.fallback?.destroy();
    this.pbrUniform?.destroy();
    this.materialUniform?.destroy();
    this.pbrUniform = this.materialUniform = undefined;
    this.pbrShader = '';
    this.pbrBindings.length = 0;
    this.pbrGroups.clear();
    this.uniform = this.commands = undefined;
    this.fallback = undefined;
    this.compute = undefined;
    this.pipelines.clear();
    this.terrain = undefined;
    this.computeGroup = undefined;
    this.renderGroups.clear();
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
