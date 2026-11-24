/// <reference lib="esnext.disposable" preserve="true" />
// Runtime virtual texture for `Terrain` (entry `@margoengine/terrain/rvt`): the terrain's blended ground colour, with
// decals and roads on top, baked into a cache around the camera, so a pixel of ground costs one or two cache samples
// instead of every layer's three triplanar samples, and other materials can read the ground they stand on.
// The cache is a clipmap (Tanner, Migdal and Jones 1998, "The Clipmap: A Virtual Mipmap", SIGGRAPH): levels of one size
// in texels, each twice as coarse as the one before, centred on the camera and addressed toroidally, so a camera move
// bakes only the rows and columns it exposes (their section 4). Ground is baked top down from the terrain's own colour
// function at each texel's world point, as a procedural virtual texture is (Widmark 2012, "Terrain in Battlefield 3: A
// Modern, Complete and Scalable System", GDC; van Waveren 2009, "id Tech 5 Challenges: From Texture Virtualization to
// Massive Parallelization", SIGGRAPH course). A pixel picks its level from its footprint and its distance to the camera
// and blends the two levels around it, as clipmap levels are blended (Losasso and Hoppe 2004, "Geometry Clipmaps",
// section 2.4). Our own code from those descriptions.
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
import { lightingLayout } from './lighting-layout.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number; COPY_DST: number };
type VirtualPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Settings of {@link TerrainVirtualTexture.attach}, fixed at attachment. Invalid values throw RangeError. */
export interface TerrainVirtualTextureOptions {
  /** World width of a texel of the finest level, above 0. Default 0.05 (5 cm). */
  texel?: number;
  /** Texels along each level's side: 256, 512, 1024, 2048 or 4096. Default 1024. */
  size?: number;
  /**
   * Levels, 1 to 12. Level k's texels are 2^k texels of level 0 wide. The coarsest level reaches `(size / 2 - 2) *
   * texel * 2^(levels - 1)` from the camera (along X or Z, about `size * texel * 2^(levels - 2)`); over the outer 29% of
   * that reach the cache fades into the terrain's own shader, which draws all ground past it. Default 6.
   */
  levels?: number;
  /**
   * Slope (1 - normal.y, 0 to 1) from which ground draws with the terrain's own shader instead of the cache, which is
   * baked top down and so stretches on steep faces (blended over the 0.1 below it). 1: never. Default 0.5.
   */
  steep?: number;
  /** The cache's format. `rgba16float` keeps layer colours above 1. Default `rgba8unorm-srgb` (4 bytes a texel). */
  format?: 'rgba8unorm-srgb' | 'rgba16float';
  /**
   * Creates the decal pictures, at attachment and again after device restoration: one `rgba8unorm` or
   * `rgba8unorm-srgb` 2D array texture, a layer per picture, alpha its coverage (give it a full mip chain for far
   * decals). The virtual texture owns and destroys it. Default: none (no decals).
   */
  decals?: (device: GPUDevice) => GPUTexture;
}
/** A decal: a picture laid on the ground, baked into the cache over what the terrain's layers draw there. */
export interface TerrainDecal {
  /** World XZ of its centre. */
  center: readonly [number, number];
  /** World width (along `angle`) and depth, each above 0. */
  size: readonly [number, number];
  /** Turn about +Y in radians, from +X toward +Z. Default 0. */
  angle?: number;
  /** The decals texture layer it shows, a whole number. Default 0. */
  layer?: number;
  /** 0 to 1, times the picture's alpha. Default 1. */
  opacity?: number;
  /** How many times the picture repeats along its width (a road's length over its width), above 0. Default 1. */
  repeat?: number;
}

const MAX_DECALS = 4096;
const NO_SHIFT = [0, 0, 0];
// Terrain lighting group bindings 94 to 96: clear of shadows (1 to 31, effects from 40), clustered (4 to 30) and
// layer materials (90 to 92).
const BINDING = 94;
const surface =
  'fn terrainVirtualSurface(color:vec3f,position:vec2f,footprint:f32)->vec3f {var terrainSurfaceColor=color;return terrainSurfaceColor;}\n';
const colorHead = 'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {',
  gradients = 'let dx=dpdx(position);let dy=dpdy(position);',
  groundCall = 'let base=terrainColor(i.position,';
/**
 * Splits the terrain's `terrainColor` into a wrapper that takes the position's screen derivatives and
 * `terrainColorAt`, which reads them from `terrainDx` and `terrainDy`: so the full colour can run where control flow
 * is not uniform (past the cache, on steep ground) and in the bake, whose derivatives are the texel's own.
 */
export function splitTerrainColor(code: string): string {
  if (code.split(colorHead).length !== 2 || code.split(gradients).length !== 2)
    throw new MargoError(
      'unsupported',
      "The terrain virtual texture needs the terrain's own colour function; attach it before effects that replace it",
    );
  return (
    'var<private> terrainDx:vec3f;var<private> terrainDy:vec3f;\n' +
    code
      .replace(
        colorHead,
        `${colorHead}terrainDx=dpdx(position);terrainDy=dpdy(position);return terrainColorAt(position,normal);}\nfn terrainColorAt(position:vec3f,normal:vec3f)->vec3f {`,
      )
      .replace(gradients, 'let dx=terrainDx;let dy=terrainDy;')
  );
}
/**
 * The cache reader: `terrainVirtualColor(position, footprint)` returns the baked ground's linear colour at world
 * `position` (its XZ) in rgb, and in a its coverage (1 inside the cache, falling to 0 past the coarsest level's reach);
 * `footprint` is the world width a pixel covers there. Level k's window is `size` texels of `texel * 2^k`, its origin
 * the camera's texel less half the size; a point is read from the level its footprint asks for, or the first whose
 * window holds it with a texel's margin, blended with the next.
 */
const reader = (group: number, binding: number, origin = false): string => {
  const code = /* wgsl */ `
struct TerrainVirtualFrame {eye:vec4f,params:vec4f}
@group(${group}) @binding(${binding}) var terrainVirtualCache:texture_2d_array<f32>;
@group(${group}) @binding(${binding + 1}) var terrainVirtualSampler:sampler;
@group(${group}) @binding(${binding + 2}) var<uniform> terrainVirtual:TerrainVirtualFrame;
fn terrainVirtualColor(position:vec3f,footprint:f32)->vec4f {
  let e=terrainVirtual.eye;let top=terrainVirtual.params.x-1.0;let half=(e.w*0.5-2.0)*e.z;
  let far=log2(max(max(abs(position.x-e.x),abs(position.z-e.y)),1e-9)/half)+1.0;
  let level=clamp(max(log2(max(footprint,1e-9)/e.z),far),0.0,top);let a=floor(level);let t=level-a;
  let uv=position.xz/(e.z*e.w*exp2(a));
  var c=textureSampleLevel(terrainVirtualCache,terrainVirtualSampler,uv,i32(a),0.0).rgb;
  if(t>0.0){c=mix(c,textureSampleLevel(terrainVirtualCache,terrainVirtualSampler,uv*0.5,i32(a)+1,0.0).rgb,t);}
  return vec4f(c,1.0-clamp((far-top-0.5)*2.0,0.0,1.0));
}`;
  // A floating origin: the frame adds `map` (the terrain's origin and height offset, local) and `anchor` (xy: the shift
  // less the terrain's anchor, so local XZ plus it is world XZ less the anchor whatever the rebases, as the terrain's
  // own `Frame.anchor`), and the level periods read the local position plus `params.zw`, the shift modulo the coarsest
  // period, so texels stay world texels.
  return origin
    ? code
        .replace('params:vec4f}', 'params:vec4f,map:vec4f,anchor:vec4f}')
        .replace('let uv=position.xz/', 'let uv=(position.xz+terrainVirtual.params.zw)/')
    : code;
};
/** The terrain's ground through the cache, its own colour where the cache does not reach or the ground is steep. */
const ground = /* wgsl */ `
fn terrainVirtualGround(position:vec3f,normal:vec3f)->vec3f {
  terrainDx=dpdx(position);terrainDy=dpdy(position);
  let cached=terrainVirtualColor(position,max(length(terrainDx.xz),length(terrainDy.xz)));
  let steep=terrainVirtual.params.y;let slope=1.0-clamp(normal.y,0.0,1.0);
  let full=max(1.0-cached.a,select(smoothstep(steep-0.1,steep,slope),0.0,steep>=1.0));
  if(full<=0.0){return cached.rgb;}
  return mix(cached.rgb,terrainColorAt(position,normal),full);
}`;
/**
 * The bake: a full-target triangle per level, scissored to the texels to bake. A texel's world point is its toroidal
 * address unwrapped into the level's window; its colour is the terrain's at that point (height and normal from the
 * heightmap as the terrain's vertex shader takes them, the texel's own width as the position's derivatives), with the
 * level's decals blended on in order.
 */
const bake = /* wgsl */ `
struct TerrainVirtualBake {origin:vec2i,size:i32,count:u32,texel:f32,start:u32,pad:vec2f}
struct TerrainVirtualDecal {box:vec4f,turn:vec4f,extra:vec4f}
@group(1) @binding(0) var<uniform> terrainBake:TerrainVirtualBake;
@group(1) @binding(1) var<storage,read> terrainDecals:array<TerrainVirtualDecal>;
@group(1) @binding(2) var<storage,read> terrainDecalList:array<u32>;
@group(1) @binding(3) var terrainDecalPictures:texture_2d_array<f32>;
@vertex fn terrainBakeVertex(@builtin(vertex_index) k:u32)->@builtin(position) vec4f {
  return vec4f(f32((k<<1u)&2u)*2.0-1.0,f32(k&2u)*2.0-1.0,0.0,1.0);
}
@fragment fn terrainBakeTexel(@builtin(position) pixel:vec4f)->@location(0) vec4f {
  let n=terrainBake.size;let o=terrainBake.origin;let w=o+(((vec2i(pixel.xy)-o)%n)+n)%n;let e=terrainBake.texel;
  let xz=(vec2f(w)+0.5)*e;let step=frame.map.zw/max(vec2f(textureDimensions(heightMap))-1.0,vec2f(1.0));
  var normal=normalize(vec3f((height(xz-vec2f(step.x,0.0))-height(xz+vec2f(step.x,0.0)))/(2.0*step.x),1.0,(height(xz-vec2f(0.0,step.y))-height(xz+vec2f(0.0,step.y)))/(2.0*step.y)));
  if(frame.offset.w>0.5){let d=vec2i(textureDimensions(normalMap));let uv=clamp((xz-frame.map.xy)/frame.map.zw,vec2f(0.0),vec2f(1.0));let s=textureLoad(normalMap,min(vec2i(uv*vec2f(d)),d-vec2i(1)),0).xyz*2.0-1.0;if(dot(s,s)>0.00001){normal=normalize(s);}}
  terrainDx=vec3f(e,height(xz+vec2f(e*0.5,0.0))-height(xz-vec2f(e*0.5,0.0)),0.0);
  terrainDy=vec3f(0.0,height(xz+vec2f(0.0,e*0.5))-height(xz-vec2f(0.0,e*0.5)),e);
  var c=terrainColorAt(vec3f(xz.x,height(xz),xz.y),normal);
  for(var k=0u;k<terrainBake.count;k++){
    let d=terrainDecals[terrainDecalList[terrainBake.start+k]];let r=xz-d.box.xy;
    let u=dot(r,d.turn.xy)/d.box.z;let v=dot(r,vec2f(-d.turn.y,d.turn.x))/d.box.w;
    if(abs(u)>1.0||abs(v)>1.0){continue;}
    let ru=0.5*d.extra.x/d.box.z;let rv=0.5/d.box.w;
    let s=textureSampleGrad(terrainDecalPictures,terrainSampler,vec2f((u*0.5+0.5)*d.extra.x,v*0.5+0.5),i32(d.turn.z),e*vec2f(d.turn.x*ru,-d.turn.y*rv),e*vec2f(d.turn.y*ru,d.turn.x*rv));
    c=mix(c,s.rgb,s.a*d.turn.w);
  }
  return vec4f(c,1.0);
}`;

/** [start, end) of `length` texels from `start` on a ring of `n`, as one or two runs inside [0, n). */
function runs(start: number, length: number, n: number): [number, number][] {
  const a = ((start % n) + n) % n;
  return a + length <= n
    ? [[a, a + length]]
    : [
        [a, n],
        [0, a + length - n],
      ];
}
/**
 * The texel rectangles a level of `n` texels must bake when its window's origin moves from `from` to `to` (texel
 * coordinates; no `from`: the whole window), plus `dirty` (world-texel rectangles [x0, z0, x1, z1)), each clipped to
 * the new window, as scissor rectangles [x, y, width, height] of its toroidal target. Exported for the tests.
 */
export function bakeRects(
  from: readonly [number, number] | undefined,
  to: readonly [number, number],
  n: number,
  dirty: readonly (readonly [number, number, number, number])[] = [],
): [number, number, number, number][] {
  const [ox, oz] = to,
    areas: [number, number, number, number][] = [];
  if (!from || Math.abs(ox - from[0]) >= n || Math.abs(oz - from[1]) >= n) areas.push([ox, oz, ox + n, oz + n]);
  else {
    const [px, pz] = from;
    if (ox > px) areas.push([px + n, oz, ox + n, oz + n]);
    if (ox < px) areas.push([ox, oz, px, oz + n]);
    // Rows the move exposes, less the columns just added.
    const x0 = ox > px ? ox : ox < px ? px : ox,
      x1 = ox > px ? px + n : ox + n;
    if (oz > pz) areas.push([x0, pz + n, x1, oz + n]);
    if (oz < pz) areas.push([x0, oz, x1, pz]);
  }
  for (const [x0, z0, x1, z1] of dirty) {
    const a = Math.max(x0, ox),
      b = Math.max(z0, oz),
      c = Math.min(x1, ox + n),
      d = Math.min(z1, oz + n);
    if (a < c && b < d) areas.push([a, b, c, d]);
  }
  const out: [number, number, number, number][] = [];
  for (const [x0, z0, x1, z1] of areas)
    if (x1 > x0 && z1 > z0)
      for (const [u0, u1] of runs(x0, x1 - x0, n))
        for (const [v0, v1] of runs(z0, z1 - z0, n)) out.push([u0, v0, u1 - u0, v1 - v0]);
  return out;
}

/**
 * The window origins of a cache's levels in world texels, [x0, z0, x1, z1, ...]: level k's texel is `texel * 2^k`
 * wide and its window of `size` texels starts at the eye's float64 world texel less half the size. With a floating
 * origin, `base` gets four numbers a level, [ax, az, bx, bz]: the world texel `a` at or below the shift and its corner
 * as a local point, `b = a * texel - shift` (float64, under one texel). The bake places world texel w at
 * `b + (w - a + 0.5) * texel`, so a texel's point depends on the shift alone, never on where the window stood when it
 * baked (with the window corner in place of `a` a flight rounded each page by its own corner). The function returns
 * the wrap of the reader, `shift` modulo the coarsest level's period. Exported for the tests.
 */
export function planWindows(
  eye: ArrayLike<number>,
  shift: ArrayLike<number>,
  texel: number,
  size: number,
  levels: number,
  out = new Float64Array(levels * 2),
  base?: Float64Array,
): [number, number] {
  for (let k = 0; k < levels; k++) {
    const s = texel * 2 ** k;
    out[k * 2] = Math.floor(eye[0] / s) - size / 2;
    out[k * 2 + 1] = Math.floor(eye[2] / s) - size / 2;
    if (base) {
      const ax = Math.floor(shift[0] / s),
        az = Math.floor(shift[2] / s);
      base.set([ax, az, ax * s - shift[0], az * s - shift[2]], k * 4);
    }
  }
  const period = texel * size * 2 ** (levels - 1),
    wrap = (v: number) => v - Math.floor(v / period) * period;
  return [wrap(shift[0]), wrap(shift[2])];
}

let nextId = 0;
/**
 * A runtime virtual texture for a `Terrain`: its blended ground colour, decals and roads baked into camera-centred
 * clipmap levels, and the terrain's lit shader reads the cache instead of its layers.
 * `TerrainVirtualTexture.attach(engine, terrain, options)`; WebGPU only. Call `invalidate(area)` after changing what
 * the terrain draws (sculpt, paint, streamed heights) so that area bakes again.
 * Not with `TerrainMaterials` (`@margoengine/terrain/layers-pbr`), whose normals and roughness come from the layer
 * loop the cache replaces. `bump` relief shows only where the terrain's own shader draws (steep or far ground).
 * @throws RangeError when an option is out of range.
 * @throws MargoError `'unsupported'` when the terrain's shader lacks its colour function or has layer materials,
 * `'disposed'` after dispose.
 */
export class TerrainVirtualTexture implements EnginePlugin, TerrainLighting {
  readonly name = 'terrain-rvt:' + nextId++;
  disposed = false;
  owner?: Engine;
  /** Texels baked in the last frame (a level's whole window is `size` squared). */
  baked = 0;
  readonly texel: number;
  readonly size: number;
  readonly levels: number;
  readonly #steep: number;
  readonly #format: GPUTextureFormat;
  #device?: GPUDevice;
  #cache?: GPUTexture;
  #targets: GPUTextureView[] = [];
  #pictures?: GPUTexture;
  #sampler?: GPUSampler;
  #frame?: GPUBuffer;
  #bake?: GPUBuffer;
  #decalBuffer?: GPUBuffer;
  #listBuffer?: GPUBuffer;
  #layout?: GPUBindGroupLayout;
  #group?: GPUBindGroup;
  #pipeline?: GPURenderPipeline;
  #pipelineSource?: GPUBindGroupLayout;
  #entries: GPUBindGroupEntry[] = [];
  #origins: ([number, number] | undefined)[] = [];
  #dirty: [number, number, number, number][] = [];
  #decals = new Map<number, Required<TerrainDecal>>();
  #decalsChanged = true;
  #nextDecal = 0;
  #remove?: () => void;
  /** Whether the terrain has `floatingOrigin`: the reader's frame grows by `map` and the bake works in local points. */
  readonly #floating: boolean;
  /** The shift the decal boxes were last written with (they hold local centres with a floating origin). */
  readonly #decalShift = new Float64Array(3);
  #windows = new Float64Array(0);
  #bases = new Float64Array(0);
  readonly #eye = new Float64Array(3);
  readonly #frameValues: Float32Array;
  #uniform = new ArrayBuffer(0);
  #list = new Uint32Array(0);
  readonly #cacheCode = new Map<string, string>();
  readonly #surfaces = new Set<TerrainLighting>();

  /**
   * Adds an ordered cache surface provider. Its shader decorates the bake's color and the reader's steep/far fallback;
   * bindings use group 2 in the bake, group 1 in the reader. Remove it with the returned function.
   */
  addSurface(effect: TerrainLighting): () => void {
    if (this.disposed || !effect || typeof effect.shader !== 'function' || typeof effect.bindings !== 'function')
      throw new TypeError('Invalid virtual surface; pass a live provider with shader() and bindings().');
    if (effect.owner && this.owner && effect.owner !== this.owner)
      throw new MargoError('attached', 'Virtual surface belongs to another engine; attach it to the same engine.');
    const used = new Set([...this.#entries, ...[...this.#surfaces].flatMap((s) => s.bindings())].map((b) => b.binding));
    if (effect.bindings().some((b) => used.has(b.binding)))
      throw new RangeError('Virtual surface binding collision; select distinct bindings for each provider.');
    this.#surfaces.add(effect);
    const changed = () => this.refreshSurfaces();
    changed();
    return () => {
      if (this.#surfaces.delete(effect)) changed();
    };
  }

  /** Rebuilds provider shader/layout state and the cache after a provider's declarations or binding set changes. */
  refreshSurfaces(): void {
    this.#pipelineSource = undefined;
    this.#cacheCode.clear();
    this.invalidate();
  }

  private constructor(
    /** The terrain whose ground the cache holds. */
    readonly terrain: Terrain,
    readonly options: TerrainVirtualTextureOptions,
  ) {
    if (!terrain?.options?.layers || typeof terrain.addLighting !== 'function')
      throw new TypeError('Invalid terrain virtual texture; pass a Terrain');
    this.#floating = !!terrain.options.floatingOrigin;
    this.#frameValues = new Float32Array(this.#floating ? 16 : 8);
    const o = options ?? {};
    this.texel = o.texel ?? 0.05;
    this.size = o.size ?? 1024;
    this.levels = o.levels ?? 6;
    this.#steep = o.steep ?? 0.5;
    this.#format = o.format ?? 'rgba8unorm-srgb';
    if (
      !(Number.isFinite(Math.fround(this.texel)) && this.texel > 0) ||
      ![256, 512, 1024, 2048, 4096].includes(this.size) ||
      !Number.isInteger(this.levels) ||
      this.levels < 1 ||
      this.levels > 12 ||
      !(this.#steep >= 0 && this.#steep <= 1) ||
      !['rgba8unorm-srgb', 'rgba16float'].includes(this.#format) ||
      (o.decals !== undefined && typeof o.decals !== 'function')
    )
      throw new RangeError(
        'Invalid terrain virtual texture; give texel above 0, size 256, 512, 1024, 2048 or 4096, levels 1..12, steep 0..1, format rgba8unorm-srgb or rgba16float and decals as a function.',
      );
  }

  /** Attaches a virtual texture to `terrain`, which must already be attached to `engine`. `dispose()` removes it. */
  static attach(
    engine: EngineKernel,
    terrain: Terrain,
    options: TerrainVirtualTextureOptions = {},
  ): TerrainVirtualTexture {
    const texture = new TerrainVirtualTexture(terrain, options);
    engineRuntime(engine).use(texture);
    return texture;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'The terrain virtual texture requires WebGPU and a live module; attach a new one to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.owner = engine;
    const device = (this.#device = engine.gpu);
    if (this.size > device.limits.maxTextureDimension2D || this.levels > device.limits.maxTextureArrayLayers)
      throw new RangeError('Terrain virtual texture size or levels exceed the device limits; lower them.');
    this.#cache = device.createTexture({
      size: [this.size, this.size, this.levels],
      format: this.#format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#targets = Array.from({ length: this.levels }, (_, k) =>
      this.#cache!.createView({ dimension: '2d', baseArrayLayer: k, arrayLayerCount: 1 }),
    );
    let pictures = this.options.decals?.(device);
    if (
      pictures &&
      (pictures.dimension !== '2d' ||
        !(pictures.usage & GPUTextureUsage.TEXTURE_BINDING) ||
        pictures.sampleCount !== 1 ||
        !['rgba8unorm', 'rgba8unorm-srgb'].includes(pictures.format))
    ) {
      pictures.destroy();
      throw new TypeError(
        'Terrain decal pictures must be one texture; return one rgba8unorm or rgba8unorm-srgb 2D array texture from options.decals.',
      );
    }
    if (!pictures) {
      pictures = device.createTexture({
        size: [1, 1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: pictures }, new Uint8Array(4), { bytesPerRow: 4 }, [1, 1, 1]);
    }
    this.#pictures = pictures;
    this.#sampler = device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.#frame = device.createBuffer({
      size: this.#frameValues.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#bake = device.createBuffer({
      size: 256 * this.levels,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#decalBuffer = device.createBuffer({
      size: MAX_DECALS * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#listBuffer = device.createBuffer({
      size: MAX_DECALS * 4 * this.levels,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: this.#floating ? 40 : 32 } },
        { binding: 1, visibility: 2, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: 2, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: 2, texture: { viewDimension: '2d-array' } },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#bake, size: this.#floating ? 40 : 32 } },
        { binding: 1, resource: { buffer: this.#decalBuffer } },
        { binding: 2, resource: { buffer: this.#listBuffer } },
        { binding: 3, resource: pictures.createView({ dimension: '2d-array' }) },
      ],
    });
    this.#entries = this.entries(BINDING);
    this.#uniform = new ArrayBuffer(256 * this.levels);
    this.#list = new Uint32Array(MAX_DECALS * this.levels);
    this.#origins = [];
    this.#decalsChanged = true;
    this.#remove ??= this.terrain.addLighting(this);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      // After the terrain's prepare (-6) has written the uniforms the bake reads, before any draw.
      order: -5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.#run(c);
      },
    });
  }

  /** The group-1 entries the patched terrain shader reads. */
  bindings(): GPUBindGroupEntry[] {
    return this.#surfaces.size
      ? [...this.#entries, ...[...this.#surfaces].flatMap((s) => s.bindings())]
      : this.#entries;
  }

  /** The terrain's lit shader reading its ground colour from the cache (bindings in `group`). */
  shader(source: string, group: number): string {
    const key = group + source,
      cached = this.#cacheCode.get(key);
    if (cached) return cached;
    if (source.includes('terrainPbr') || source.split(groundCall).length !== 2)
      throw new MargoError(
        'unsupported',
        'The terrain virtual texture needs the terrain lit shader without layer materials; attach it without TerrainMaterials',
      );
    let code =
      reader(group, BINDING, this.#floating) +
      ground +
      splitTerrainColor(source).replace(groundCall, 'let base=terrainVirtualGround(i.position,');
    if (this.#surfaces.size) {
      code =
        surface +
        code.replace(
          'terrainColorAt(position,normal),full)',
          `terrainVirtualSurface(terrainColorAt(position,normal),position.xz${this.#floating ? '+frame.anchor.xy' : ''},max(length(terrainDx.xz),length(terrainDy.xz))),full)`,
        );
      for (const effect of this.#surfaces) code = effect.shader(code, group);
    }
    if (this.#cacheCode.size >= 16) this.#cacheCode.clear();
    this.#cacheCode.set(key, code);
    return code;
  }

  /**
   * WGSL for another material to read the ground under it (to blend into the terrain): its three bindings at `group`
   * from `binding`, and `fn terrainVirtualColor(position: vec3f, footprint: f32) -> vec4f`, the baked colour (linear)
   * at world `position` in rgb and in a its coverage (0 past the cache), for a pixel `footprint` world units wide.
   */
  declarations(group: number, binding: number): string {
    return reader(group, binding, this.#floating);
  }

  /** The bind group entries `declarations(group, binding)` reads, while attached (else an empty list). */
  entries(binding: number): GPUBindGroupEntry[] {
    if (!this.#cache || !this.#sampler || !this.#frame) return [];
    return [
      { binding, resource: this.#cache.createView({ dimension: '2d-array' }) },
      { binding: binding + 1, resource: this.#sampler },
      { binding: binding + 2, resource: { buffer: this.#frame } },
    ];
  }

  /** The cache, one array layer per level, while attached (else undefined). */
  get texture(): GPUTexture | undefined {
    return this.#cache;
  }

  /**
   * Bakes again the world XZ rectangle from (x0, z0) to (x1, z1) on every level, on the next frame: call it after
   * changing the terrain's heights, weights or tint there. Without arguments, the whole cache.
   */
  invalidate(x0?: number, z0?: number, x1?: number, z1?: number): void {
    if (x0 === undefined) {
      this.#origins = [];
      this.#dirty = [];
      return;
    }
    if (![x0, z0, x1, z1].every((v) => typeof v === 'number' && !Number.isNaN(v)))
      throw new RangeError('Invalid terrain virtual texture area; pass four numbers x0, z0, x1, z1.');
    this.#dirty.push([Math.min(x0, x1!), Math.min(z0!, z1!), Math.max(x0, x1!), Math.max(z0!, z1!)]);
  }

  /** Adds a decal; returns its id for `removeDecal`. Decals added later draw over earlier ones. */
  addDecal(decal: TerrainDecal): number {
    if (this.disposed || !this.options.decals)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain decals need a live virtual texture made with a decals texture; pass options.decals',
      );
    const d = {
      center: decal?.center,
      size: decal?.size,
      angle: decal?.angle ?? 0,
      layer: decal?.layer ?? 0,
      opacity: decal?.opacity ?? 1,
      repeat: decal?.repeat ?? 1,
    };
    const layers = this.#pictures?.depthOrArrayLayers ?? Infinity;
    if (
      !Array.isArray(d.center) ||
      !Array.isArray(d.size) ||
      ![...d.center, ...d.size, d.angle, d.repeat].every(Number.isFinite) ||
      !(d.size[0] > 0 && d.size[1] > 0 && d.repeat > 0) ||
      !Number.isInteger(d.layer) ||
      d.layer < 0 ||
      d.layer >= layers ||
      !(d.opacity >= 0 && d.opacity <= 1)
    )
      throw new RangeError(
        'Invalid terrain decal; give a finite center, a size above 0, a whole layer of the decals texture, opacity 0..1 and repeat above 0.',
      );
    if (this.#decals.size >= MAX_DECALS)
      throw new RangeError(`Terrain decals are limited to ${MAX_DECALS}; remove one before adding another.`);
    const id = this.#nextDecal++;
    this.#decals.set(id, d as Required<TerrainDecal>);
    this.#decalsChanged = true;
    this.#dirtyDecal(d as Required<TerrainDecal>);
    return id;
  }

  /** Removes a decal by its id; returns whether it was there. */
  removeDecal(id: number): boolean {
    const d = this.#decals.get(id);
    if (!d) return false;
    this.#decals.delete(id);
    this.#decalsChanged = true;
    this.#dirtyDecal(d);
    return true;
  }

  /**
   * Lays a road along world XZ `points` (2 or more): a decal per segment, `width` wide, its picture repeating once per
   * `width` of length. Returns the decals' ids. Sharp bends leave a gap on their outer side; give a curve as short
   * segments.
   */
  road(
    points: readonly (readonly [number, number])[],
    width: number,
    decal: Pick<TerrainDecal, 'layer' | 'opacity'> = {},
  ): number[] {
    if (!Array.isArray(points) || points.length < 2 || !(width > 0))
      throw new RangeError('Invalid terrain road; pass 2 or more [x, z] points and a width above 0.');
    const ids: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1],
        [bx, bz] = points[i],
        length = Math.hypot(bx - ax, bz - az);
      if (!(length > 0)) continue;
      ids.push(
        this.addDecal({
          ...decal,
          center: [(ax + bx) / 2, (az + bz) / 2],
          size: [length, width],
          angle: Math.atan2(bz - az, bx - ax),
          repeat: length / width,
        }),
      );
    }
    return ids;
  }

  /** The world-XZ bounds of a decal, marked to bake again. */
  #dirtyDecal(d: Required<TerrainDecal>): void {
    const c = Math.abs(Math.cos(d.angle)),
      s = Math.abs(Math.sin(d.angle)),
      hx = (d.size[0] * c + d.size[1] * s) / 2,
      hz = (d.size[0] * s + d.size[1] * c) / 2;
    this.#dirty.push([d.center[0] - hx, d.center[1] - hz, d.center[0] + hx, d.center[1] + hz]);
  }

  #run(c: VirtualPassContext): void {
    const source = this.terrain.colorSource?.();
    if (this.disposed || !source || !this.#cache) return;
    const device = c.device,
      n = this.size,
      local = c.camera.position,
      floating = this.#floating,
      shift = floating ? this.terrain.shift : NO_SHIFT,
      levels = this.levels;
    // With a floating origin the windows are planned from the float64 world eye, on the texel the GPU holds (float32),
    // so the reader's period and the bake's texel are the same numbers; without, as before.
    let eye: ArrayLike<number> = local;
    if (floating) {
      for (let a = 0; a < 3; a++) this.#eye[a] = local[a] + shift[a];
      eye = this.#eye;
    }
    const texel = floating ? Math.fround(this.texel) : this.texel;
    if (this.#windows.length !== levels * 2) {
      this.#windows = new Float64Array(levels * 2);
      this.#bases = new Float64Array(levels * 4);
    }
    const [wrapX, wrapZ] = planWindows(eye, shift, texel, n, levels, this.#windows, floating ? this.#bases : undefined);
    this.#frameValues.set([
      local[0],
      local[2],
      this.texel,
      n,
      levels,
      this.#steep,
      floating ? wrapX : 0,
      floating ? wrapZ : 0,
    ]);
    if (floating) {
      const o = this.terrain.options;
      this.#frameValues.set(
        [
          (o.origin?.[0] ?? 0) - shift[0],
          (o.origin?.[1] ?? 0) - shift[2],
          (o.heightOffset ?? 0) - shift[1],
          0,
          shift[0] - this.terrain.anchor![0],
          shift[2] - this.terrain.anchor![1],
        ],
        8,
      );
      const d = this.#decalShift;
      if (d[0] !== shift[0] || d[2] !== shift[2]) {
        d.set([shift[0], shift[1], shift[2]]);
        this.#decalsChanged = true;
      }
    }
    device.queue.writeBuffer(this.#frame!, 0, this.#frameValues as Float32Array<ArrayBuffer>);
    if (this.#pipelineSource !== source.layout) {
      let code = splitTerrainColor(source.code) + bake;
      if (floating)
        code = code
          .replace('pad:vec2f}', 'pad:vec2f,anchor:vec2i}')
          .replace('let xz=(vec2f(w)+0.5)*e;', 'let xz=terrainBake.pad+(vec2f(w-terrainBake.anchor)+0.5)*e;');
      if (this.#surfaces.size)
        code =
          surface +
          code.replace(
            'var c=terrainColorAt(vec3f(xz.x,height(xz),xz.y),normal);',
            `var c=terrainVirtualSurface(terrainColorAt(vec3f(xz.x,height(xz),xz.y),normal),xz${floating ? '+frame.anchor.xy' : ''},terrainBake.texel);`,
          );
      for (const effect of this.#surfaces) code = effect.shader(code, 2);
      const module = device.createShaderModule({ code });
      const layouts = [source.layout, this.#layout!];
      if (this.#surfaces.size)
        layouts.push(
          device.createBindGroupLayout({
            entries: lightingLayout(
              code,
              [...this.#surfaces].flatMap((s) => s.bindings()),
              2,
            ),
          }),
        );
      this.#pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module, entryPoint: 'terrainBakeVertex' },
        fragment: { module, entryPoint: 'terrainBakeTexel', targets: [{ format: this.#format }] },
      });
      this.#pipelineSource = source.layout;
      this.#origins = [];
    }
    // Most frames move no level a texel and change nothing: they bake nothing and allocate nothing.
    this.baked = 0;
    let moved = this.#dirty.length > 0;
    for (let k = 0; k < levels && !moved; k++) {
      const o = this.#origins[k];
      moved = !o || o[0] !== this.#windows[k * 2] || o[1] !== this.#windows[k * 2 + 1];
    }
    if (!moved) return;
    const decals = [...this.#decals.values()];
    if (this.#decalsChanged) {
      const data = new Float32Array(Math.max(1, decals.length) * 12);
      decals.forEach((d, i) =>
        data.set(
          [
            d.center[0] - (floating ? shift[0] : 0),
            d.center[1] - (floating ? shift[2] : 0),
            d.size[0] / 2,
            d.size[1] / 2,
            Math.cos(d.angle),
            Math.sin(d.angle),
            d.layer,
            d.opacity,
            d.repeat,
          ],
          i * 12,
        ),
      );
      device.queue.writeBuffer(this.#decalBuffer!, 0, data);
      this.#decalsChanged = false;
    }
    const dirty = this.#dirty,
      uniform = this.#uniform,
      list = this.#list,
      ints = new Int32Array(uniform),
      floats = new Float32Array(uniform),
      work: [number, [number, number, number, number][]][] = [];
    this.#dirty = [];
    let listed = 0;
    for (let k = 0; k < levels; k++) {
      const s = texel * 2 ** k,
        origin: [number, number] = [this.#windows[k * 2], this.#windows[k * 2 + 1]],
        rects = bakeRects(
          this.#origins[k],
          origin,
          n,
          dirty.map(([x0, z0, x1, z1]) => [
            Math.floor(x0 / s),
            Math.floor(z0 / s),
            Math.ceil(x1 / s),
            Math.ceil(z1 / s),
          ]),
        );
      this.#origins[k] = origin;
      if (!rects.length) continue;
      // The decals over the window, in the order they were added.
      const start = listed,
        x0 = origin[0] * s,
        z0 = origin[1] * s,
        x1 = x0 + n * s,
        z1 = z0 + n * s;
      decals.forEach((d, i) => {
        const r = Math.hypot(d.size[0], d.size[1]) / 2;
        if (d.center[0] + r > x0 && d.center[0] - r < x1 && d.center[1] + r > z0 && d.center[1] - r < z1)
          list[listed++] = i;
      });
      const base = 64 * k;
      ints.set([origin[0], origin[1], n, listed - start], base);
      floats[base + 4] = s;
      ints[base + 5] = start;
      if (floating) {
        floats[base + 6] = this.#bases[k * 4 + 2];
        floats[base + 7] = this.#bases[k * 4 + 3];
        ints[base + 8] = this.#bases[k * 4];
        ints[base + 9] = this.#bases[k * 4 + 1];
      }
      work.push([k, rects]);
    }
    if (!work.length) return;
    const surfaceGroup = this.#surfaces.size
      ? device.createBindGroup({
          layout: this.#pipeline!.getBindGroupLayout(2),
          entries: [...this.#surfaces].flatMap((s) => s.bindings()),
        })
      : undefined;
    device.queue.writeBuffer(this.#bake!, 0, uniform);
    if (listed) device.queue.writeBuffer(this.#listBuffer!, 0, list, 0, listed);
    for (const [k, rects] of work) {
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: this.#targets[k], loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(this.#pipeline!);
      pass.setBindGroup(0, source.group);
      pass.setBindGroup(1, this.#group!, [256 * k]);
      if (surfaceGroup) pass.setBindGroup(2, surfaceGroup);
      for (const [x, y, w, h] of rects) {
        pass.setScissorRect(x, y, w, h);
        pass.draw(3);
        this.baked += w * h;
      }
      pass.end();
    }
  }

  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.setup(engine);
  }

  #release(): void {
    for (const resource of [this.#cache, this.#pictures, this.#frame, this.#bake, this.#decalBuffer, this.#listBuffer])
      resource?.destroy();
    this.#cache = this.#pictures = this.#frame = this.#bake = this.#decalBuffer = this.#listBuffer = undefined;
    this.#targets = [];
    this.#entries = [];
    this.#pipeline = this.#pipelineSource = this.#layout = this.#group = this.#sampler = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.owner?.sceneOf(this)?.removePlugin(this.name);
    this.#release();
    this.#cacheCode.clear();
    this.#decals.clear();
    this.#surfaces.clear();
    this.owner = this.#device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
