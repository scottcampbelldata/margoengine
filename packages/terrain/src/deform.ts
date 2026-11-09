/// <reference lib="esnext.disposable" preserve="true" />
// Deformable ground for `Terrain` (entry `@margoengine/terrain/deform`): footprints, tyre tracks and trails pressed
// into snow, mud and sand, kept in a deformation map that follows the camera and filled back in over time.
// The map is a square window of texels around the camera addressed toroidally, so a move rewrites only the rows and
// columns it exposes (the clipmap's update: Tanner, Migdal and Jones 1998, "The Clipmap: A Virtual Mipmap", SIGGRAPH).
// Prints are pressed on the GPU, the deepest one winning in each texel, and refilled by a fixed depth a second, as
// the deformation height maps of Barré-Brisebois, "Deformable Snow Rendering in Batman: Arkham Origins" (GDC 2014)
// and Michels and Sikachev, "Deferred Snow Deformation in Rise of the Tomb Raider" (GPU Pro 7, 2016) describe.
// Material pushed aside rises in a rim around each print. The terrain's lit shader then walks each near pixel's view
// ray down through the prints (parallax occlusion mapping: Tatarchuk 2006, "Dynamic Parallax Occlusion Mapping with
// Approximate Soft Shadows", I3D, with the lateral reach capped as in Welsh 2004, "Parallax Mapping with Offset
// Limiting") and shades the ground it meets with the print's slope as its normal, darkened where it is pressed.
// Our own code from those descriptions. No vertex moves: the clipmap's cells are far wider than a footprint.
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain, TerrainLighting } from './index.js';

type DeformPassContext = Extract<PassContext, { backend: 'webgpu' }>;
const BINDING = 99,
  /** Prints pressed in one frame at most; more wait for the next frame. */
  BATCH = 1024,
  /** Widest print box in texels (a longer track is split into pieces). */
  SPAN = 192;

/** Settings of {@link TerrainDeformation.attach}, fixed at attachment. Invalid values throw RangeError. */
export interface TerrainDeformationOptions {
  /** Texels along each side of the deformation map, 64 to 2,048. Default 1,024. */
  size?: number;
  /** World width of a texel, above 0. Default 0.025 (2.5 cm): 1,024 texels cover 25.6 m around the camera. */
  texel?: number;
  /** Deepest a print may go, world units above 0 (and the depth a print takes by default). Default 0.15. */
  depth?: number;
  /** Height of the rim pushed up around a print, as a share of its depth, 0 to 1. Default 0.25. */
  rim?: number;
  /** Seconds a print of the full `depth` takes to fill back in (shallower ones sooner); 0 keeps prints. Default 120. */
  fade?: number;
  /** How deep the ground takes prints, 0 (rock) to 1. Default 1. With painted weights, `layers` overrides it. */
  softness?: number;
  /** With painted `TerrainTextures.weights`: each layer's softness, 0 to 1, in layer order (missing: `softness`). */
  layers?: readonly number[];
  /** Darkening of the ground pressed down, 0 to 1 (packed snow, wet mud). Default 0.25. */
  darken?: number;
  /** World distance from the camera within which prints show, fading over the last quarter, above 0. Default 40. */
  distance?: number;
  /** Most view-ray steps a pixel takes through the prints, 4 to 32. Default 12. */
  steps?: number;
  /** World XZ the map centres on each frame (a player, a vehicle). Default the camera's position. */
  follow?: () => readonly [number, number];
}
/** A footprint: an ellipse pressed at a point. */
export interface TerrainFootprint {
  /** Heading in radians about +Y, 0 along +X. Default 0. */
  angle?: number;
  /** Length along the heading, world units above 0. Default 0.28. */
  length?: number;
  /** Width across the heading, world units above 0. Default 0.11. */
  width?: number;
  /** Depth, 0 to the deformation's `depth` (deeper is clamped). Default the deformation's `depth`. */
  depth?: number;
}
/** A track: a band of `width` pressed along a line (a tyre, a sledge, a body dragged). */
export interface TerrainTrack {
  /** Width of the band, world units above 0. Default 0.25. */
  width?: number;
  /** Depth, 0 to the deformation's `depth` (deeper is clamped). Default the deformation's `depth`. */
  depth?: number;
}

/** The map's three compute steps, over a 2 x size x size buffer of depths and rims (f32 bits, so atomicMax keeps the
 * deepest print in a texel) and the rgba16float relief the shader samples: height, its x and z slopes, pressed share. */
const computeSource = /* wgsl */ `
struct Window {origin:vec2i,previous:vec2i,size:u32,first:u32,fade:f32,texel:f32,rim:f32,count:u32,pad:vec2f}
struct Stamp {shape:vec4f,ends:vec4f,turn:vec4f,box:vec4i}
@group(0) @binding(0) var<uniform> w:Window;
@group(0) @binding(1) var<storage,read_write> marks:array<atomic<u32>>;
@group(0) @binding(2) var<storage,read> stamps:array<Stamp>;
@group(0) @binding(3) var relief:texture_storage_2d<rgba16float,write>;
fn slot(world:vec2i)->u32 {let s=i32(w.size);let m=((world%s)+s)%s;return u32(m.y)*w.size+u32(m.x);}
fn inside(world:vec2i,origin:vec2i)->bool {return all(world>=origin)&&all(world<origin+vec2i(i32(w.size)));}
@compute @workgroup_size(8,8) fn age(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=vec2u(w.size))){return;}
  let k=id.y*w.size+id.x;let n=w.size*w.size;let s=i32(w.size);
  let world=w.origin+(((vec2i(id.xy)-w.origin)%s)+s)%s;
  if(w.first==1u||!inside(world,w.previous)){atomicStore(&marks[k],0u);atomicStore(&marks[n+k],0u);return;}
  if(w.fade>0.0){
    atomicStore(&marks[k],bitcast<u32>(max(bitcast<f32>(atomicLoad(&marks[k]))-w.fade,0.0)));
    atomicStore(&marks[n+k],bitcast<u32>(max(bitcast<f32>(atomicLoad(&marks[n+k]))-w.fade*w.rim,0.0)));
  }
}
@compute @workgroup_size(8,8) fn stamp(@builtin(global_invocation_id) id:vec3u) {
  if(id.z>=w.count){return;}
  let s=stamps[id.z];if(any(vec2i(id.xy)>=s.box.zw)){return;}
  let world=s.box.xy+vec2i(id.xy);if(!inside(world,w.origin)){return;}
  let p=(vec2f(id.xy)+0.5)*w.texel;var t:f32;
  if(s.shape.x<0.5){let d=p-s.ends.xy;t=length(vec2f(d.x*s.turn.x+d.y*s.turn.y,d.y*s.turn.x-d.x*s.turn.y)/s.shape.wz);}
  else{let ab=s.ends.zw-s.ends.xy;let h=clamp(dot(p-s.ends.xy,ab)/max(dot(ab,ab),1e-12),0.0,1.0);t=length(p-s.ends.xy-ab*h)/s.shape.z;}
  let depth=s.shape.y*(1.0-smoothstep(0.55,1.0,t));let raised=s.shape.y*w.rim*(1.0-smoothstep(0.0,0.45,abs(t-1.2)));
  let k=slot(world);
  if(depth>0.0){atomicMax(&marks[k],bitcast<u32>(depth));}
  if(raised>0.0){atomicMax(&marks[w.size*w.size+k],bitcast<u32>(raised));}
}
fn heightAt(c:vec2i)->f32 {
  let s=i32(w.size);let m=((c%s)+s)%s;let k=u32(m.y)*w.size+u32(m.x);
  let d=bitcast<f32>(atomicLoad(&marks[k]));let r=bitcast<f32>(atomicLoad(&marks[w.size*w.size+k]));
  return r*(1.0-smoothstep(0.0,0.02,d))-d;
}
@compute @workgroup_size(8,8) fn resolve(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=vec2u(w.size))){return;}
  let c=vec2i(id.xy);let d=bitcast<f32>(atomicLoad(&marks[id.y*w.size+id.x]));
  let gx=(heightAt(c+vec2i(1,0))-heightAt(c-vec2i(1,0)))/(2.0*w.texel);
  let gz=(heightAt(c+vec2i(0,1))-heightAt(c-vec2i(0,1)))/(2.0*w.texel);
  textureStore(relief,c,vec4f(heightAt(c),gx,gz,clamp(d/0.02,0.0,1.0)));
}`;

/**
 * The lit shader's additions at `group`: the frame (window centre and extent, settings, layer softness and which
 * layers exist), the relief map, and `terrainDeformShift`, which moves a fragment to where its view ray meets the
 * printed ground and bends its normal there. `painted` weight textures give per-layer softness.
 */
const functions = (group: number, painted: number) => /* wgsl */ `
struct TerrainDeformFrame {window:vec4f,params:vec4f,extra:vec4f,softness:array<vec4f,4>,layers:array<vec4f,4>}
@group(${group}) @binding(${BINDING}) var<uniform> terrainDeform:TerrainDeformFrame;
@group(${group}) @binding(${BINDING + 1}) var terrainDeformMap:texture_2d<f32>;
var<private> terrainDeformTint:f32=1.0;
fn terrainDeformAt(xz:vec2f)->vec4f {
  let f=terrainDeform.window;let d=max(abs(xz.x-f.x),abs(xz.y-f.y))*2.0/f.z;
  return textureSampleLevel(terrainDeformMap,terrainSampler,xz/f.z,0.0)*(1.0-smoothstep(1.0-8.0/f.w,1.0-2.0/f.w,d));
}
fn terrainDeformSoftness(xz:vec2f)->f32 {${
  painted
    ? `
  let dd=vec2f(textureDimensions(terrainWeights0));let uv=clamp((xz-frame.map.xy)/frame.map.zw,vec2f(0.5)/dd,vec2f(1)-vec2f(0.5)/dd);var soft=0.0;var total=0.0;
  ${Array.from({ length: painted }, (_, i) => `{let wv=textureSampleLevel(terrainWeights${i},terrainSampler,uv,0.0);soft+=dot(wv,terrainDeform.softness[${i}]);total+=dot(wv,terrainDeform.layers[${i}]);}`).join('')}
  return select(terrainDeform.extra.y,soft/total,total>0.00001);`
    : `
  return terrainDeform.extra.y;`
}
}
fn terrainDeformShift(i:Output)->Output {
  var j=i;let n=normalize(i.normal);let reach=terrainDeform.params.x;let dist=distance(frame.eye.xyz,i.position);
  if(dist>=reach||n.y<0.2){return j;}
  let soft=terrainDeformSoftness(i.position.xz)*(1.0-smoothstep(reach*0.75,reach,dist));if(soft<=0.0){return j;}
  let v=normalize(i.position-frame.eye.xyz);let vn=min(dot(v,n),-0.05);
  let top=terrainDeform.extra.x*soft;let bottom=-terrainDeform.params.w*soft;let t0=top/vn;
  let span=min(bottom/vn-t0,8.0*(top-bottom)/max(sqrt(max(1.0-vn*vn,0.0)),0.0001));let steps=terrainDeform.params.y;
  var before=t0;var gap0=top-terrainDeformAt((i.position+v*t0).xz).x*soft;var hit=t0+span;
  for(var k=1.0;k<=steps;k+=1.0){
    let t=t0+span*k/steps;let gap=t*vn-terrainDeformAt((i.position+v*t).xz).x*soft;
    if(gap<=0.0){hit=mix(before,t,gap0/max(gap0-gap,0.000001));break;}
    before=t;gap0=gap;
  }
  let p=i.position+v*hit;let delta=p.xz-i.position.xz;let sample=terrainDeformAt(p.xz);
  j.position=vec3f(p.x,i.position.y-(n.x*delta.x+n.z*delta.y)/n.y,p.z);
  let g=vec3f(sample.y,0.0,sample.z)*soft;j.normal=normalize(n-(g-n*dot(n,g)));
  terrainDeformTint=1.0-terrainDeform.params.z*sample.w*soft;
  return j;
}
`;
const head = '@fragment fn fragment(i:Output)->@location(0) vec4f {',
  colorHead = 'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {';
let nextId = 0;

/**
 * Deformable ground: footprints, tyre tracks and trails pressed into a terrain, kept in a deformation map that follows
 * the camera and filling back in over `fade` seconds. Prints are shown by the terrain's lit shader (parallax, the
 * print's slope as normal, darkening); the terrain's geometry, shadow and SSR capture are unchanged.
 * `TerrainDeformation.attach(engine, terrain, options)`, after the terrain's other effects; WebGPU only.
 * @throws RangeError from the constructor when an option is out of range, and from a print with a bad size.
 * @throws MargoError `'unsupported'` on a WebGL engine or a map larger than the device allows, `'disposed'` after
 * `dispose()`.
 */
export class TerrainDeformation implements EnginePlugin, TerrainLighting {
  readonly name = 'terrain-deform:' + nextId++;
  disposed = false;
  owner?: Engine;
  /** Texels along each side of the map. */
  readonly size: number;
  /** World width of a texel. */
  readonly texel: number;
  /** Deepest a print goes. */
  readonly depth: number;
  #marks?: GPUBuffer;
  #stamps?: GPUBuffer;
  #window?: GPUBuffer;
  #frame?: GPUBuffer;
  #relief?: GPUTexture;
  #group?: GPUBindGroup;
  #pipelines?: { age: GPUComputePipeline; stamp: GPUComputePipeline; resolve: GPUComputePipeline };
  #entries: GPUBindGroupEntry[] = [];
  #remove?: () => void;
  #origin?: [number, number];
  #pending: number[][] = [];
  #clear = true;
  readonly #cache = new Map<string, string>();
  readonly #windowData = new ArrayBuffer(48);
  readonly #stampData = new ArrayBuffer(BATCH * 64);

  constructor(
    private readonly terrain: Terrain,
    readonly options: TerrainDeformationOptions = {},
  ) {
    const count = terrain?.options?.layers?.length;
    if (!count || typeof terrain.addLighting !== 'function')
      throw new TypeError('Invalid terrain deformation; pass a Terrain');
    const o = options ?? {},
      unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1,
      positive = (v: unknown) => typeof v === 'number' && v > 0 && Number.isFinite(v);
    if (
      !Number.isInteger(o.size ?? 1024) ||
      (o.size ?? 1024) < 64 ||
      (o.size ?? 1024) > 2048 ||
      !positive(o.texel ?? 0.025) ||
      !positive(o.depth ?? 0.15) ||
      !unit(o.rim ?? 0.25) ||
      !(typeof (o.fade ?? 120) === 'number' && (o.fade ?? 120) >= 0 && Number.isFinite(o.fade ?? 120)) ||
      !unit(o.softness ?? 1) ||
      !(o.layers === undefined || (Array.isArray(o.layers) && o.layers.length <= count && o.layers.every(unit))) ||
      !unit(o.darken ?? 0.25) ||
      !positive(o.distance ?? 40) ||
      !Number.isInteger(o.steps ?? 12) ||
      (o.steps ?? 12) < 4 ||
      (o.steps ?? 12) > 32 ||
      !(o.follow === undefined || typeof o.follow === 'function')
    )
      throw new RangeError(
        'Invalid terrain deformation; give size 64..2048, texel, depth and distance above 0, rim, softness, darken and each layers entry 0..1 (at most one per terrain layer), fade 0 or more, steps 4..32 and follow as a function.',
      );
    this.size = o.size ?? 1024;
    this.texel = o.texel ?? 0.025;
    this.depth = o.depth ?? 0.15;
  }

  /** Attaches deformation to `terrain`, after its other effects. `dispose()` removes it. */
  static attach(engine: EngineKernel, terrain: Terrain, options: TerrainDeformationOptions = {}): TerrainDeformation {
    const deformation = new TerrainDeformation(terrain, options);
    engineRuntime(engine).use(deformation);
    return deformation;
  }

  /** Presses a footprint centred at world (x, z). Returns this. */
  footprint(x: number, z: number, print: TerrainFootprint = {}): this {
    const length = print.length ?? 0.28,
      width = print.width ?? 0.11,
      angle = print.angle ?? 0;
    this.#check([x, z, angle], length, width, print.depth);
    const reach = Math.max(length, width) * 0.85,
      x0 = Math.floor((x - reach) / this.texel),
      z0 = Math.floor((z - reach) / this.texel),
      span = Math.ceil((2 * reach) / this.texel) + 2;
    this.#queue([
      0,
      this.#depthOf(print.depth),
      width / 2,
      length / 2,
      x - x0 * this.texel,
      z - z0 * this.texel,
      0,
      0,
      Math.cos(angle),
      Math.sin(angle),
      0,
      0,
      x0,
      z0,
      span,
      span,
    ]);
    return this;
  }

  /** Presses a track of `width` from world (x, z) `from` to `to` (rounded ends). Returns this. */
  track(from: readonly [number, number], to: readonly [number, number], track: TerrainTrack = {}): this {
    const width = track.width ?? 0.25;
    this.#check([from?.[0], from?.[1], to?.[0], to?.[1]], width, width, track.depth);
    const depth = this.#depthOf(track.depth),
      reach = width * 0.85,
      piece = (SPAN - 4) * this.texel - 2 * reach,
      length = Math.hypot(to[0] - from[0], to[1] - from[1]),
      pieces = Math.max(1, Math.ceil(length / piece));
    for (let p = 0; p < pieces; p++) {
      const a = [from[0] + ((to[0] - from[0]) * p) / pieces, from[1] + ((to[1] - from[1]) * p) / pieces],
        b = [from[0] + ((to[0] - from[0]) * (p + 1)) / pieces, from[1] + ((to[1] - from[1]) * (p + 1)) / pieces],
        x0 = Math.floor((Math.min(a[0], b[0]) - reach) / this.texel),
        z0 = Math.floor((Math.min(a[1], b[1]) - reach) / this.texel),
        x1 = Math.ceil((Math.max(a[0], b[0]) + reach) / this.texel),
        z1 = Math.ceil((Math.max(a[1], b[1]) + reach) / this.texel),
        ox = x0 * this.texel,
        oz = z0 * this.texel;
      this.#queue([
        1,
        depth,
        width / 2,
        0,
        a[0] - ox,
        a[1] - oz,
        b[0] - ox,
        b[1] - oz,
        1,
        0,
        0,
        0,
        x0,
        z0,
        x1 - x0 + 1,
        z1 - z0 + 1,
      ]);
    }
    return this;
  }

  /** Presses a track through each world (x, z) point in turn (a trail). Returns this. */
  trail(points: readonly (readonly [number, number])[], track: TerrainTrack = {}): this {
    if (!Array.isArray(points)) throw new RangeError('Invalid terrain trail; pass an array of [x, z] points');
    for (let i = 1; i < points.length; i++) this.track(points[i - 1], points[i], track);
    if (points.length === 1) this.track(points[0], points[0], track);
    return this;
  }

  /** Smooths every print away at the next frame. Returns this. */
  clear(): this {
    this.#pending = [];
    this.#clear = true;
    return this;
  }

  /**
   * The relief the terrain's shader reads, while attached: an `rgba16float` texture of `size` texels a side holding
   * the ground's height change (negative in a print, positive on a rim), its x and z slopes and the pressed share (0 to
   * 1), addressed toroidally (world texel (i, j) at texel (i mod size, j mod size)) and valid within `size / 2` texels
   * of the centre. Usage `TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC`, so other materials can sample it and tests
   * can read it back. A new one after device restoration.
   */
  get texture(): GPUTexture | undefined {
    return this.#relief;
  }

  /** Prints waiting for the next frame. */
  get pending(): number {
    return this.#pending.length;
  }

  #check(values: unknown[], length: number, width: number, depth: number | undefined): void {
    const extent = (SPAN - 4) * this.texel * 0.5;
    if (
      !values.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
      !(length > 0 && length <= extent) ||
      !(width > 0 && width <= extent) ||
      !(depth === undefined || (typeof depth === 'number' && depth >= 0 && Number.isFinite(depth)))
    )
      throw new RangeError(
        `Invalid terrain print; give finite positions, length and width above 0 up to ${extent.toFixed(3)} world units and depth 0 or more.`,
      );
  }

  #depthOf(depth: number | undefined): number {
    return Math.min(depth ?? this.depth, this.depth);
  }

  #queue(record: number[]): void {
    this.#pending.push(record);
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain deformation requires WebGPU and a live module; attach a new one to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    const gpu = engine.gpu,
      n = this.size,
      bytes = 8 * n * n;
    if (n > gpu.limits.maxTextureDimension2D || bytes > gpu.limits.maxStorageBufferBindingSize)
      throw new MargoError(
        'unsupported',
        'The terrain deformation map is larger than this device allows; pass a smaller size',
      );
    this.owner = engine;
    this.#marks = gpu.createBuffer({ size: bytes, usage: 0x80 });
    this.#stamps = gpu.createBuffer({ size: BATCH * 64, usage: 0x80 | 0x8 });
    this.#window = gpu.createBuffer({ size: 48, usage: 0x40 | 0x8 });
    this.#frame = gpu.createBuffer({ size: 176, usage: 0x40 | 0x8 });
    this.#relief = gpu.createTexture({ size: [n, n], format: 'rgba16float', usage: 0x1 | 0x4 | 0x8 });
    const layout = gpu.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
          { binding: 1, visibility: 4, buffer: { type: 'storage' } },
          { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        ],
      }),
      module = gpu.createShaderModule({ code: computeSource }),
      pipelineLayout = gpu.createPipelineLayout({ bindGroupLayouts: [layout] }),
      pipeline = (entryPoint: string) =>
        gpu.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
    this.#pipelines = { age: pipeline('age'), stamp: pipeline('stamp'), resolve: pipeline('resolve') };
    this.#group = gpu.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.#window } },
        { binding: 1, resource: { buffer: this.#marks } },
        { binding: 2, resource: { buffer: this.#stamps } },
        { binding: 3, resource: this.#relief.createView() },
      ],
    });
    // Until the first frame places the window, the frame's extent puts every fragment outside it.
    const o = this.options,
      frame = new Float32Array(44),
      layers = this.terrain.options.layers.length;
    frame.set([1e30, 1e30, n * this.texel, n], 0);
    frame.set([o.distance ?? 40, o.steps ?? 12, o.darken ?? 0.25, this.depth], 4);
    frame.set([this.depth * (o.rim ?? 0.25), o.softness ?? 1, 0, 0], 8);
    for (let i = 0; i < layers; i++) {
      frame[12 + i] = o.layers?.[i] ?? o.softness ?? 1;
      frame[28 + i] = 1;
    }
    gpu.queue.writeBuffer(this.#frame, 0, frame);
    this.#origin = undefined;
    this.#clear = true;
    this.#entries = [
      { binding: BINDING, resource: { buffer: this.#frame } },
      { binding: BINDING + 1, resource: this.#relief.createView() },
    ];
    this.#remove ??= this.terrain.addLighting(this);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      // After the terrain's prepare (-6), before any draw.
      order: -5,
      execute: (c) => {
        if (c.backend === 'webgpu' && !(c.view?.index ?? 0)) this.#run(c);
      },
    });
  }

  #run(c: DeformPassContext): void {
    if (this.disposed || !this.#pipelines) return;
    const n = this.size,
      centre = this.options.follow?.() ?? [c.camera.position[0], c.camera.position[2]];
    if (!Number.isFinite(centre[0]) || !Number.isFinite(centre[1])) return;
    const origin: [number, number] = [
        Math.floor(centre[0] / this.texel) - n / 2,
        Math.floor(centre[1] / this.texel) - n / 2,
      ],
      previous = this.#origin ?? origin,
      first = this.#clear,
      moved = previous[0] !== origin[0] || previous[1] !== origin[1] || !this.#origin,
      fade = this.options.fade ?? 120,
      fill = fade > 0 ? (this.depth * Math.max(c.delta, 0)) / fade : 0,
      count = Math.min(this.#pending.length, BATCH);
    if (!first && !moved && !fill && !count) return;
    const ints = new Int32Array(this.#windowData),
      floats = new Float32Array(this.#windowData),
      words = new Uint32Array(this.#windowData);
    ints.set([origin[0], origin[1], previous[0], previous[1]]);
    words[4] = n;
    words[5] = +first;
    floats[6] = fill;
    floats[7] = this.texel;
    floats[8] = this.options.rim ?? 0.25;
    words[9] = count;
    c.device.queue.writeBuffer(this.#window!, 0, this.#windowData);
    if (moved) {
      c.device.queue.writeBuffer(
        this.#frame!,
        0,
        new Float32Array([(origin[0] + n / 2) * this.texel, (origin[1] + n / 2) * this.texel]),
      );
      this.#origin = origin;
    }
    const pass = c.encoder.beginComputePass(),
      groups = Math.ceil(n / 8);
    pass.setBindGroup(0, this.#group!);
    if (first || moved || fill) {
      pass.setPipeline(this.#pipelines.age);
      pass.dispatchWorkgroups(groups, groups);
    }
    if (count) {
      const batch = this.#pending.splice(0, count),
        f = new Float32Array(this.#stampData),
        k = new Int32Array(this.#stampData);
      let span = 1;
      batch.forEach((r, i) => {
        f.set(r.slice(0, 12), i * 16);
        k.set(r.slice(12), i * 16 + 12);
        span = Math.max(span, r[14], r[15]);
      });
      c.device.queue.writeBuffer(this.#stamps!, 0, this.#stampData, 0, count * 64);
      pass.setPipeline(this.#pipelines.stamp);
      pass.dispatchWorkgroups(Math.ceil(span / 8), Math.ceil(span / 8), count);
    }
    pass.setPipeline(this.#pipelines.resolve);
    pass.dispatchWorkgroups(groups, groups);
    pass.end();
    this.#clear = false;
  }

  /** The group-1 entries the patched shader reads. */
  bindings(): GPUBindGroupEntry[] {
    return this.#entries;
  }

  /** The terrain's lit shader shading each near fragment where its view ray meets the printed ground (bindings in `group`). */
  shader(source: string, group: number): string {
    const key = group + source,
      cached = this.#cache.get(key);
    if (cached) return cached;
    if (source.split(head).length !== 2)
      throw new MargoError(
        'unsupported',
        "Terrain deformation needs the terrain's lit fragment shader; attach it before effects that replace it",
      );
    const painted = [...source.matchAll(/var terrainWeights(\d):texture_2d<f32>;/g)].length;
    let code = source.replace(head, 'fn terrainDeformInner(i:Output)->vec4f {');
    if (code.split(colorHead).length === 2)
      code = code.replace(colorHead, 'fn terrainColorUndeformed(position:vec3f,normal:vec3f)->vec3f {');
    code =
      functions(group, painted) +
      code +
      (code.includes('terrainColorUndeformed')
        ? `\n${colorHead}return terrainColorUndeformed(position,normal)*terrainDeformTint;}`
        : '') +
      `\n${head}return terrainDeformInner(terrainDeformShift(i));}`;
    if (this.#cache.size >= 16) this.#cache.clear();
    this.#cache.set(key, code);
    return code;
  }

  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.setup(engine);
  }

  #release(): void {
    this.#marks?.destroy();
    this.#stamps?.destroy();
    this.#window?.destroy();
    this.#frame?.destroy();
    this.#relief?.destroy();
    this.#marks = this.#stamps = this.#window = this.#frame = this.#relief = undefined;
    this.#group = this.#pipelines = undefined;
    this.#entries = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.owner?.sceneOf(this)?.removePlugin(this.name);
    this.#release();
    this.#cache.clear();
    this.#pending = [];
    this.owner = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
