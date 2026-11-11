/// <reference lib="esnext.disposable" preserve="true" />
import { lightingLayout } from './lighting-layout.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { margoError } from '../../shared/errors.js';
import { MargoError } from '@margoengine/math/errors';
import { clipmapGrid } from './grid.js';
import {
  surfaceStruct,
  terrainVertex,
  terrainFragment,
  terrainOutside,
  terrainHole,
  terrainShading,
  weightedFragment,
  originShader,
} from './shader.js';
import { applyView } from '../../shared/view-rect.js';
import { unitLight } from '../../shared/unit-light.js';
import { linearHdr } from '../../shared/hdr-format.js';
export { clipmapGrid } from './grid.js';
export { TerrainColors, type TerrainColorOptions } from './colors.js';
export { heightfieldGeometry, TerrainHeightmap, type HeightField, type HeightfieldOptions } from './heightfield.js';
declare const GPUBufferUsage: { UNIFORM: number; VERTEX: number; INDEX: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type TerrainPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** The textures `TerrainOptions.textures` returns; Terrain owns and destroys them. All sampled, single-sample 2D. */
export interface TerrainTextures {
  /** Heights in the R channel: `r32float`, `rgba16float` or `rgba8unorm`, one layer. */
  heightmap: GPUTexture;
  /** Optional XYZ normals encoded 0..1: `rgba8unorm` or `rgba16float`. Default: from neighbouring heights. */
  normalmap?: GPUTexture;
  /** Layer colours, one array layer per `TerrainLayer`: `rgba8unorm-srgb`, `rgba8unorm` or `rgba16float`. */
  layers: GPUTexture;
  /**
   * Optional painted layer weights over the heightmap's bounds, 2 to 4 `rgba8unorm` 2D textures, enough for the layers
   * (4 per texture, up to 16): layer i's weight is channel i % 4 of texture i / 4 (pass the same texture twice for 4
   * layers). When present they replace the height and slope rules (each rule's `scale` still sets its texture repeat),
   * as `@margoengine/biomes/view` uses for biome ground layers; a layer whose weight is 0 at a pixel skips its texture
   * samples there. Without them the terrain shader and bindings are unchanged. Default: none.
   */
  weights?: readonly GPUTexture[];
  /**
   * Optional tint over the heightmap's bounds, with `weights` only: one `rgba8unorm` or `rgba8unorm-srgb` 2D texture of
   * any size, sampled bilinearly. Each layer with `tint: true` has its colour mixed toward the texel's RGB by its A:
   * `mix(layer, tint.rgb, tint.a)`, in linear light (an `-srgb` texture holds sRGB colours). Layers without `tint` are
   * drawn as they are. `@margoengine/biomes/view` draws seasons through it. Without it the shader and bindings are
   * unchanged. Default: none.
   */
  tint?: GPUTexture;
  /**
   * Optional holes over the heightmap's bounds: one `r8unorm` or `rgba8unorm` 2D texture of any size, a texel per
   * cell (texel (u, v) covers cell (u, v) of the bounds split into its width by height); where its R is below 0.5 the
   * terrain draws nothing, in its colour, SSR capture, shadow and occluder passes alike. `TerrainHoles`
   * (`@margoengine/terrain/holes`) makes and edits one. Without it the shaders and bindings are unchanged. Default: none.
   */
  holes?: GPUTexture;
}
/** A splat rule: where layer i's texture shows. Rules blend smoothly around their bounds; layer 0 is the fallback. */
export interface TerrainLayer {
  /** World Y range [min, max), min < max. */
  height: readonly [number, number];
  /** Slope range (1 - normal.y), 0 <= min < max <= 1. */
  slope: readonly [number, number];
  /** Texture repeats per world unit, > 0. */
  scale: number;
  /**
   * Relief from the layer's own texture, 0 to 1: its luma becomes a height of up to `bump` halves of one texture repeat
   * (2 m at scale 0.25), and the shading normal follows that height's slope (derivative bump mapping, Mikkelsen 2010).
   * No extra texture samples; the mips flatten it with distance, and its slope falls once a pixel covers over 1/64 of a
   * repeat on the ground. Default 0 (no bump).
   */
  bump?: number;
  /**
   * Large-scale variation, 0 to 1: the same layer at 1/24 of `scale` (96 m at 0.25) scales the colour by
   * `1 - macro + macro * luma / meanLuma`, so far slopes keep a pattern where the fine texture has averaged to its mean.
   * A smooth sample about 318 m wide picks that repeat's offset, so it draws no grid. The mean comes from the layer's
   * top mip: give the layers texture a full mip chain.
   * Default 0 (no macro sample).
   */
  macro?: number;
  /** Whether the layer takes `TerrainTextures.tint` (plant cover, not rock). Ignored without a tint. Default false. */
  tint?: boolean;
}
/**
 * What `TerrainOptions.floatingOrigin` takes: the float64 world point at local zero and its rebase event. A
 * `FloatingOrigin` from `@margoengine/cameras/origin` fits as is.
 */
export interface TerrainOrigin {
  /** Float64 world position of local [0, 0, 0]. */
  readonly origin: ArrayLike<number>;
  /** Calls `listener` after each rebase with the new origin second; returns an unsubscribe. */
  onRebase(listener: (shift: ArrayLike<number>, origin: ArrayLike<number>) => void): () => void;
}
/**
 * The ring corners of a clipmap: for each level i, the eye's float64 world XZ snapped down to the level's spacing
 * (`cell * 2^i`), less `shift` (the world point at local zero), as [x0, z0, x1, z1, ...]. Snapping the world point keeps
 * the lattice, and so the vertices and the LOD, the same wherever the origin sits; only the small local result reaches
 * float32. Exported for the tests.
 */
export function planRings(
  eye: ArrayLike<number>,
  shift: ArrayLike<number>,
  cell: number,
  levels: number,
  out = new Float64Array(levels * 2),
): Float64Array {
  for (let i = 0; i < levels; i++) {
    const spacing = cell * 2 ** i;
    out[i * 2] = Math.floor(eye[0] / spacing) * spacing - shift[0];
    out[i * 2 + 1] = Math.floor(eye[2] / spacing) * spacing - shift[2];
  }
  return out;
}
/** Clipmap terrain settings, fixed at construction. Invalid values throw RangeError. */
export interface TerrainOptions {
  /** Creates the textures, at attach and again after device restoration (recreate them from retained data). */
  textures: (device: GPUDevice) => TerrainTextures;
  /** 4 to 16 splat rules, one per `layers` texture layer. */
  layers: readonly TerrainLayer[];
  /** World XZ of the heightmap's minimum corner. Default [0, 0]. */
  origin?: readonly [number, number];
  /** World XZ extent the heightmap covers, each > 0. */
  size: readonly [number, number];
  /** World Y per height sample unit. Default 100. */
  heightScale?: number;
  /** World Y added to every height. Default 0. */
  heightOffset?: number;
  /** Finest grid spacing in world units, > 0; doubles per level. Default 1. */
  cellSize?: number;
  /** Cells per ring side, a multiple of 4 from 8 to 256. Default 64. */
  resolution?: number;
  /** Clipmap rings, 1-12. Default 6. */
  levels?: number;
  /** Surface roughness (GGX, 0-1), for the sun's highlight and screen-space reflections (`ssr.add(terrain)`). Default
   * 0.9; leaving it out keeps the shader as it was. */
  roughness?: number;
  /**
   * A floating origin (`FloatingOrigin` from `@margoengine/cameras/origin`) for terrain far from world zero: the camera
   * is local to it and the terrain plans its rings, layer texture phases and cache windows in float64 world space, then
   * sends the GPU only small local numbers. A terrain 10,000 km out then draws the same vertices, levels and texels as
   * at zero, and a rebase moves nothing on screen. `origin`, `size` and every CPU call (`TerrainQuery`, holes, decals,
   * overlays, sculpt) stay in world coordinates. Default: none (the shaders, uniforms and rules stay as they were).
   */
  floatingOrigin?: TerrainOrigin;
}
/** What `setCapture` takes: `@margoengine/post` SSR's material capture hook (its `SSRCapture`), declared here so terrain
 * does not import post. */
export interface TerrainCapture {
  /** Module-scope WGSL for the lit shader `code`: `struct MargoSSR` and `fn margoSSR(n,v,base,metal,rough)->MargoSSR`. */
  declarations(code: string): string;
  /** Colour targets of the capture pass, in `MargoSSR` location order. */
  readonly targets: readonly GPUColorTargetState[];
  /** This frame's capture pass: these targets and a depth attachment of the context's format; ended by the owner. */
  begin(): GPURenderPassEncoder;
}
/**
 * A lighting effect patched into the terrain shader, such as shadows or clustered lights (`terrain.addLighting`).
 * Its bindings live in group 1.
 */
export interface TerrainLighting {
  /** The engine the effect belongs to; a different engine is rejected. */
  readonly owner?: Engine;
  /** Returns `source` with the effect's WGSL added, using bind group `group`. */
  shader(source: string, group: number): string;
  /** The group-1 entries the patched shader reads, asked every frame. */
  bindings(): GPUBindGroupEntry[];
}
interface Ring {
  uniform: GPUBuffer;
  group: GPUBindGroup;
  values: Float32Array;
  shadowUniforms: GPUBuffer[];
  shadowGroups: GPUBindGroup[];
  shadowValues: Float32Array;
  /** Per local shadow layer (clustered `LocalShadows`), created on first use. */
  localUniforms: GPUBuffer[];
  localGroups: GPUBindGroup[];
}
interface LightingGroup {
  device: GPUDevice;
  entries: GPUBindGroupEntry[];
  group: GPUBindGroup;
}
let nextId = 0;
/**
 * Geometry-clipmap terrain: concentric rings that follow the camera, heights sampled from a texture in the vertex
 * shader, 4 to 16 slope/height texture layers with triplanar cliffs, GGX sun lighting. Works with `Shadows` and
 * `Clustered` (`shadows.add(terrain)`, `clustered.add(terrain)`). `Terrain.attach(engine, options)`; WebGPU only.
 * @throws RangeError from the constructor when an option is out of range.
 * @throws TypeError when the textures have the wrong dimension, format, usage or layer count.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` when a lighting
 * effect belongs to another engine.
 */
export class Terrain implements EnginePlugin {
  readonly name = 'terrain:' + nextId++;
  shadowVersion = 0;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private textures?: TerrainTextures;
  private vertex?: GPUBuffer;
  private center?: GPUBuffer;
  private ring?: GPUBuffer;
  private rules?: GPUBuffer;
  private sampler?: GPUSampler;
  private layout?: GPUBindGroupLayout;
  private shadowPipeline?: GPURenderPipeline;
  /** Reversed-depth variant of the shadow pipeline for local light maps, built on first use. */
  private localShadowPipeline?: GPURenderPipeline;
  private shadowModule?: GPUShaderModule;
  private ringGroup?: (buffer: GPUBuffer) => GPUBindGroup;
  private occluder?: { samples: number; pipeline: GPURenderPipeline };
  private rings: Ring[] = [];
  /** The bits each uniform buffer last received, so an unchanged frame uploads nothing. Buffers made anew start empty. */
  private readonly sent = new WeakMap<GPUBuffer, Uint32Array>();
  private readonly bitViews = new WeakMap<Float32Array, Uint32Array>();
  private pipelines = new Map<string, GPURenderPipeline>();
  private lightingGroups = new Map<GPURenderPipeline, LightingGroup>();
  private lighting = new Set<TerrainLighting>();
  /** Bind-group entries for the current draw. Lighting providers may return fresh wrappers; the group cache compares them. */
  private readonly lightingEntries: GPUBindGroupEntry[] = [];
  private centerCount = 0;
  private ringCount = 0;
  private capture?: TerrainCapture;
  private captureCode = new Map<string, string>();
  private readonly disposers = new Set<() => void>();
  /** The float64 world point at local zero (zeros without `floatingOrigin`); `shift` reads it. */
  private readonly shiftValues = new Float64Array(3);
  /** The shift the layer rules were last written with, and the scratch eye and ring plan of `prepare`. */
  private readonly rulesShift = new Float64Array(3);
  private readonly eye = new Float64Array(3);
  private plan = new Float64Array(0);
  private unfollow?: () => void;
  /**
   * With `floatingOrigin`, `options.origin` as it was at construction (a stream moves its array): local + `Frame.anchor`
   * is world XZ less this, the coordinate cache surfaces, overlays and imagery draw in. Undefined without the option.
   */
  readonly anchor?: readonly [number, number];
  constructor(readonly options: TerrainOptions) {
    this.validate();
    const o = options.floatingOrigin;
    if (o) {
      this.anchor = [options.origin?.[0] ?? 0, options.origin?.[1] ?? 0];
      this.shiftValues.set([o.origin[0], o.origin[1], o.origin[2]]);
      this.unfollow = o.onRebase((_, at) => this.shiftValues.set([at[0], at[1], at[2]]));
    }
  }
  /**
   * The float64 world point at local zero: the floating origin's, or zeros without `floatingOrigin`. Every terrain entry
   * reads it per frame and compares it with the last one to see a rebase. Read only.
   */
  get shift(): ArrayLike<number> {
    return this.shiftValues;
  }
  static attach(instance: EngineKernel, options: TerrainOptions): Terrain {
    const terrain = new Terrain(options);
    engineRuntime(instance).use(terrain);
    return terrain;
  }
  private validate(): void {
    const o = this.options;
    if (
      typeof o.textures !== 'function' ||
      !Number.isInteger(o.resolution ?? 64) ||
      (o.resolution ?? 64) < 8 ||
      (o.resolution ?? 64) > 256 ||
      (o.resolution ?? 64) % 4 ||
      !Number.isInteger(o.levels ?? 6) ||
      (o.levels ?? 6) < 1 ||
      (o.levels ?? 6) > 12 ||
      (o.roughness !== undefined && !(o.roughness >= 0 && o.roughness <= 1)) ||
      !Number.isFinite(Math.fround(o.cellSize ?? 1)) ||
      (o.cellSize ?? 1) <= 0 ||
      !Number.isFinite(Math.fround(o.heightScale ?? 100)) ||
      !Number.isFinite(Math.fround(o.heightOffset ?? 0)) ||
      !Array.isArray(o.layers) ||
      o.layers.length < 4 ||
      o.layers.length > 16
    )
      throw new RangeError(
        'Invalid terrain options; check textures, resolution (multiple of 4, 8..256), levels (1..12), roughness (0..1), cellSize above 0, finite heightScale and heightOffset, and 4 to 16 layers.',
      );
    finiteVector(o.origin ?? [0, 0], 2, 'Terrain origin');
    const f = o.floatingOrigin;
    if (f !== undefined && (typeof f?.onRebase !== 'function' || f.origin?.length !== 3))
      throw new TypeError('Invalid terrain floatingOrigin; pass a FloatingOrigin from @margoengine/cameras/origin.');
    if (f) finiteVector(f.origin, 3, 'Terrain floatingOrigin origin');
    finiteVector(o.size, 2, 'Terrain size');
    if (o.size.some((v) => v <= 0))
      throw new RangeError('Invalid terrain size; give a [width, depth] with both above 0.');
    for (const layer of o.layers) {
      finiteVector(layer.height, 2, 'Layer height');
      finiteVector(layer.slope, 2, 'Layer slope');
      if (
        layer.height[0] >= layer.height[1] ||
        layer.slope[0] < 0 ||
        layer.slope[1] > 1 ||
        layer.slope[0] >= layer.slope[1] ||
        !Number.isFinite(Math.fround(layer.scale)) ||
        layer.scale <= 0
      )
        throw new RangeError(
          'Invalid terrain layer; height must rise, slope must rise within 0..1 and scale must be above 0.',
        );
      if (![layer.bump ?? 0, layer.macro ?? 0].every((v) => typeof v === 'number' && v >= 0 && v <= 1))
        throw new RangeError('Invalid terrain layer bump or macro; give each a number from 0 to 1 (default 0).');
    }
  }
  addLighting(effect: TerrainLighting): () => void {
    if (this.disposed || !effect || typeof effect.shader !== 'function' || typeof effect.bindings !== 'function')
      throw new TypeError(
        'Invalid terrain lighting; pass a live Terrain an effect with shader() and bindings() functions.',
      );
    if (effect.owner && this.engine && effect.owner !== this.engine)
      throw new MargoError(
        'attached',
        'Terrain lighting belongs to another engine; use objects created by the same engine',
      );
    this.lighting.add(effect);
    return () => this.lighting.delete(effect);
  }
  invalidate(): void {
    this.shadowVersion++;
  }
  /**
   * The heightmap texture the `textures` factory returned, while attached (undefined before and after disposal; a new
   * one after device restoration). Terrain owns it. `TerrainQuery.read` (`@margoengine/terrain/query`) reads it back.
   */
  get heightmap(): GPUTexture | undefined {
    return this.textures?.heightmap;
  }
  /** The painted weight textures the factory returned (as given, a texture may repeat), while attached; else undefined. */
  get weights(): readonly GPUTexture[] | undefined {
    return this.textures?.weights;
  }
  /** The holes texture the factory returned, while attached; else undefined. `TerrainHoles.upload` writes into it. */
  get holes(): GPUTexture | undefined {
    return this.textures?.holes;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain requires WebGPU and a live module; attach a new Terrain to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.textures = this.options.textures(this.device);
    const t = this.textures;
    const weights = t.weights,
      tint = t.tint,
      holes = t.holes;
    if (
      tint !== undefined &&
      (!weights || !['rgba8unorm', 'rgba8unorm-srgb'].includes(tint?.format) || tint.depthOrArrayLayers !== 1)
    )
      throw new TypeError('Terrain tint must be one rgba8unorm or rgba8unorm-srgb 2D texture, given with weights');
    if (
      weights !== undefined &&
      (!Array.isArray(weights) ||
        weights.length < 2 ||
        weights.length > 4 ||
        weights.length * 4 < this.options.layers.length)
    )
      throw new TypeError(
        'Terrain weights must be 2 to 4 rgba8unorm 2D textures, one per 4 layers; pass the same texture twice for 4 layers',
      );
    for (const texture of [
      t.heightmap,
      t.layers,
      ...(t.normalmap ? [t.normalmap] : []),
      ...(weights ?? []),
      ...(tint ? [tint] : []),
      ...(holes ? [holes] : []),
    ])
      if (texture.dimension !== '2d' || !(texture.usage & GPUTextureUsage.TEXTURE_BINDING) || texture.sampleCount !== 1)
        throw new TypeError('Terrain textures must be sampled 2D textures');
    if (
      t.heightmap.depthOrArrayLayers !== 1 ||
      (t.normalmap && t.normalmap.depthOrArrayLayers !== 1) ||
      t.layers.depthOrArrayLayers !== this.options.layers.length ||
      !['rgba8unorm', 'rgba8unorm-srgb', 'rgba16float'].includes(t.layers.format) ||
      !['r32float', 'rgba16float', 'rgba8unorm'].includes(t.heightmap.format) ||
      (t.normalmap && !['rgba8unorm', 'rgba16float'].includes(t.normalmap.format)) ||
      (weights && weights.some((w) => w.format !== 'rgba8unorm' || w.depthOrArrayLayers !== 1)) ||
      (holes && (!['r8unorm', 'rgba8unorm'].includes(holes.format) || holes.depthOrArrayLayers !== 1))
    )
      throw new TypeError(
        'Invalid terrain texture format or layer count; use a layers array texture with one layer per terrain layer and a supported heightmap format.',
      );
    const geometry = clipmapGrid(this.options.resolution ?? 64),
      upload = (data: Float32Array | Uint32Array, usage: number) => {
        if (data.byteLength > this.device!.limits.maxBufferSize)
          throw new RangeError('Terrain grid exceeds the device maxBufferSize; reduce resolution.');
        const buffer = this.device!.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
        try {
          this.device!.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
        } catch (error) {
          buffer.destroy();
          throw error;
        }
        return buffer;
      };
    this.vertex = upload(geometry.vertices, GPUBufferUsage.VERTEX);
    this.center = upload(geometry.center, GPUBufferUsage.INDEX);
    this.ring = upload(geometry.ring, GPUBufferUsage.INDEX);
    this.centerCount = geometry.center.length;
    this.ringCount = geometry.ring.length;
    this.rules = upload(this.ruleData(), GPUBufferUsage.STORAGE);
    this.rulesShift.set(this.shiftValues);
    this.sampler = this.device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    const vertex = GPUShaderStage.VERTEX,
      fragment = GPUShaderStage.FRAGMENT;
    this.layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vertex | fragment, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vertex | fragment, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: vertex | fragment, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: fragment, texture: { viewDimension: '2d-array' } },
        { binding: 4, visibility: fragment, sampler: { type: 'filtering' } },
        { binding: 5, visibility: fragment, buffer: { type: 'read-only-storage' } },
        ...[...(weights ?? []), ...(tint ? [tint] : []), ...(t.holes ? [t.holes] : [])].map((_, i) => ({
          binding: 6 + i,
          visibility: fragment,
          texture: {},
        })),
      ],
    });
    const resources = [
      t.heightmap.createView(),
      (t.normalmap ?? t.heightmap).createView(),
      t.layers.createView({ dimension: '2d-array' }),
      this.sampler,
      { buffer: this.rules },
      ...(weights ? weights.map((w) => w.createView()) : []),
      ...(tint ? [tint.createView()] : []),
      ...(t.holes ? [t.holes.createView()] : []),
    ];
    const group = (buffer: GPUBuffer) =>
      this.device!.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer } },
          ...resources.map((resource, i) => ({ binding: i + 1, resource })),
        ],
      });
    this.ringGroup = group;
    // With `floatingOrigin` the frame grows by `anchor` (originShader), 176 to 192 bytes.
    const floats = this.options.floatingOrigin ? 48 : 44;
    for (let i = 0; i < (this.options.levels ?? 6); i++) {
      const uniform = this.device.createBuffer({
          size: floats * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        shadowUniforms: GPUBuffer[] = [];
      const r: Ring = {
        uniform,
        group: undefined!,
        values: new Float32Array(floats),
        shadowUniforms,
        shadowGroups: [],
        shadowValues: new Float32Array(floats),
        localUniforms: [],
        localGroups: [],
      };
      this.rings.push(r);
      r.group = group(uniform);
      for (let j = 0; j < 4; j++) {
        const buffer = this.device.createBuffer({
          size: floats * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        shadowUniforms.push(buffer);
        r.shadowGroups.push(group(buffer));
      }
    }
    // The shadow pass drops what lies outside the heightmap too: the outer rings' clamped shelf cast shadows inward.
    const module = this.device.createShaderModule({
      code: this.clip(terrainVertex + `@fragment fn outside(i:Output){${terrainOutside}}`),
    });
    this.shadowModule = module;
    this.shadowPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: {
        module,
        entryPoint: 'vertex',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: { module, entryPoint: 'outside', targets: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.invalidate();
  }
  /**
   * The layer rules: 8 floats a layer; 12 with `bump` or `macro` (surfaceStruct: bump metres per unit of luma, macro,
   * macro scale); with `floatingOrigin` 8 more (originShader: `wrap` and `tone` per axis) and the height bounds less the
   * shift's Y, as positions reach the shader local.
   */
  private ruleData(): Float32Array {
    const tint = this.textures!.tint,
      origin = !!this.options.floatingOrigin,
      s = this.shiftValues,
      surface = this.surface() ? 12 : 8,
      stride = surface + (origin ? 8 : 0),
      data = new Float32Array(this.options.layers.length * stride);
    this.options.layers.forEach((layer, i) => {
      data.set(
        [
          layer.height[0] - s[1],
          layer.height[1] - s[1],
          ...layer.slope,
          layer.scale,
          Math.max(0.01, (layer.height[1] - layer.height[0]) * 0.05),
          0.05,
          // params.w: 1 for a layer that takes the tint (0 without a tint, as before).
          +(!!tint && !!layer.tint),
          ...(surface === 12 ? [((layer.bump ?? 0) * 0.5) / layer.scale, layer.macro ?? 0, layer.scale / 24, 0] : []),
        ],
        i * stride,
      );
      if (!origin) return;
      // The textures repeat on the terrain's own coordinates (world less `anchor`; Y as is), so moving a terrain and
      // its camera together draws the same picture. k whole macro repeats (24 / scale, in the shader's float32 scale)
      // per axis: wrap is the shift so measured less them, tone their phase in the 0.302 tone repeat (k times the
      // shader's float32 0.302, exact in float64).
      const scale = Math.fround(layer.scale),
        relative = [s[0] - this.anchor![0], s[1], s[2] - this.anchor![1]];
      for (let a = 0; a < 3; a++) {
        const k = Math.floor((relative[a] * scale) / 24),
          tone = k * Math.fround(0.302);
        data[i * stride + surface + a] = relative[a] - (k * 24) / scale;
        data[i * stride + surface + 4 + a] = tone - Math.floor(tone);
      }
    });
    return data;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':prepare',
      order: -6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.prepare(c);
      },
    });
    graph.add({
      name: this.name,
      order: 1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawRings(c);
      },
    });
  }
  private prepare(c: TerrainPassContext): void {
    const origin = this.options.origin,
      size = this.options.size,
      resolution = this.options.resolution ?? 64,
      heightScale = this.options.heightScale ?? 100,
      heightOffset = this.options.heightOffset ?? 0,
      layers = this.options.layers.length,
      cell = this.options.cellSize ?? 1,
      hdr = +linearHdr(c.format),
      normal = +!!this.textures!.normalmap,
      floating = this.options.floatingOrigin,
      s = this.shiftValues;
    // With a floating origin the eye is planned in float64 world space; without, the camera as given (adding a zero
    // shift could only turn -0 into 0).
    let eye: ArrayLike<number> = c.camera.position;
    if (floating) {
      for (let a = 0; a < 3; a++) this.eye[a] = eye[a] + s[a];
      eye = this.eye;
      const r = this.rulesShift;
      if (r[0] !== s[0] || r[1] !== s[1] || r[2] !== s[2]) {
        c.device.queue.writeBuffer(this.rules!, 0, this.ruleData() as Float32Array<ArrayBuffer>);
        r.set(s);
      }
    }
    if (this.plan.length !== this.rings.length * 2) this.plan = new Float64Array(this.rings.length * 2);
    const plan = planRings(eye, s, cell, this.rings.length, this.plan);
    let previousX = 0,
      previousZ = 0,
      changed = false;
    for (let i = 0; i < this.rings.length; i++) {
      const values = this.rings[i].values,
        spacing = cell * 2 ** i,
        x = plan[i * 2],
        z = plan[i * 2 + 1];
      // The uniform holds float32: compare the rounded lattice, or a spacing not exact in float32 (0.1) reads as a
      // move every frame and redraws the shadow maps every frame.
      if (values[28] !== Math.fround(x) || values[29] !== Math.fround(z)) changed = true;
      values.set(c.camera.matrix);
      values.set(c.camera.position, 16);
      unitLight(values, 20, this.engine!.lighting.direction);
      values.set(this.engine!.lighting.radiance, 24);
      values[28] = x;
      values[29] = z;
      values[30] = spacing;
      values[31] = resolution;
      values[32] = i ? previousX - x : 0;
      values[33] = i ? previousZ - z : 0;
      values[34] = i;
      values[35] = normal;
      values[36] = (origin?.[0] ?? 0) - s[0];
      values[37] = (origin?.[1] ?? 0) - s[2];
      values[38] = size[0];
      values[39] = size[1];
      values[40] = heightScale;
      values[41] = heightOffset - s[1];
      values[42] = layers;
      values[43] = hdr;
      if (floating) {
        values[44] = s[0] - this.anchor![0];
        values[45] = s[2] - this.anchor![1];
        values[46] = s[1];
        values[47] = 0;
      }
      this.upload(c.device.queue, this.rings[i].uniform, values);
      previousX = x;
      previousZ = z;
    }
    if (changed) this.invalidate();
  }
  /** The lit shader: terrain's own (with `roughness`, when given) through every lighting effect. */
  private shader(): string {
    let code = this.base();
    for (const effect of this.lighting) code = effect.shader(code, 1);
    return code;
  }
  /**
   * The terrain's own shader, with its edge and hole tests and no lighting effect, with the bind group layout and the
   * finest ring's group 0 it draws with, while attached: what `@margoengine/terrain/rvt` bakes the ground colour from.
   */
  colorSource(): { code: string; layout: GPUBindGroupLayout; group: GPUBindGroup } | undefined {
    if (this.disposed || !this.layout || !this.rings[0]?.group) return undefined;
    return { code: this.base(), layout: this.layout, group: this.rings[0].group };
  }
  /** The terrain's own shader (with `roughness`, when given) and its edge and hole tests, before any effect. */
  private base(): string {
    const r = this.options.roughness,
      surface = this.surface(),
      vertex =
        r === undefined
          ? terrainVertex
          : terrainVertex.replace('o.material=vec4f(0.9,0,1,1)', `o.material=vec4f(${r},0,1,1)`);
    const code =
      (surface ? surfaceStruct(vertex) : vertex) +
      (this.textures?.weights
        ? weightedFragment(this.textures.weights.length, surface, !!this.textures.tint)
        : terrainFragment(surface));
    return this.clip(this.options.floatingOrigin ? originShader(code) : code);
  }
  /** With `TerrainTextures.holes`: declares the mask after the weights and tint and adds its test to the edge test. */
  private clip(code: string): string {
    const t = this.textures;
    if (!t?.holes) return code;
    const binding = 6 + (t.weights?.length ?? 0) + (t.tint ? 1 : 0);
    return `@group(0) @binding(${binding}) var terrainHoles:texture_2d<f32>;
${code.split(terrainOutside).join(terrainOutside + terrainHole)}`;
  }
  /** Whether any layer sets `bump` or `macro`; without, the shader and rules are what they were before both. */
  private surface(): boolean {
    return this.options.layers.some((layer) => (layer.bump ?? 0) > 0 || (layer.macro ?? 0) > 0);
  }
  private drawRings(c: TerrainPassContext): void {
    const code = this.shader();
    const key = c.descriptor.multisample?.count + ':' + c.format + ':' + c.descriptor.depthStencil!.format + code;
    let pipeline = this.pipelines.get(key);
    const entries = this.lightingEntries;
    entries.length = 0;
    for (const effect of this.lighting) {
      const bound = effect.bindings();
      for (let i = 0; i < bound.length; i++) entries.push(bound[i]);
    }
    if (!pipeline) {
      const module = c.device.createShaderModule({ code }),
        layouts = [this.layout!];
      if (entries.length) layouts.push(c.device.createBindGroupLayout({ entries: lightingLayout(code, entries) }));
      pipeline = c.device.createRenderPipeline({
        layout: c.device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
      });
      this.pipelines.set(key, pipeline);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: c.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(c.descriptor.depthStencil!.format.includes('stencil')
          ? { stencilLoadOp: 'load', stencilStoreOp: 'store' }
          : {}),
      },
    });
    applyView(pass, c);
    pass.setPipeline(pipeline);
    if (entries.length) pass.setBindGroup(1, this.lightingGroup(c.device, pipeline, entries));
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      pass.setBindGroup(0, this.rings[i].group);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
      this.engine!.stats.drawCalls++;
    }
    pass.end();
  }
  /**
   * Lets a capture hook (`@margoengine/post` SSR: `ssr.add(terrain)`) draw the terrain's material with
   * `draw(c, 'capture', ...)`: its normal, layer colour and roughness through the hook's `margoSSR`, depth tested
   * (greater-equal) and written. Returns a remover. Without a hook the terrain draws exactly as before.
   */
  setCapture(hook: TerrainCapture): () => void {
    if (
      this.disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw new TypeError(
        'Invalid terrain capture hook; pass an object with declarations() and begin() functions and a targets array to a live Terrain.',
      );
    this.capture = hook;
    return () => {
      if (this.capture === hook) this.capture = undefined;
    };
  }
  /** Calls `callback` once when the terrain is disposed; returns a remover. */
  onDispose(callback: () => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('Terrain onDispose needs a function');
    this.disposers.add(callback);
    return () => this.disposers.delete(callback);
  }
  /** `mode` 'capture': draws the terrain into the capture hook's pass (`setCapture`); `color` and `depth` are unused (the
   * hook's pass has its own). Does nothing without a hook or after disposal. */
  draw(c: TerrainPassContext, mode: 'capture', color?: GPUTextureView, depth?: GPUTextureView): void {
    const hook = this.capture;
    if (mode !== 'capture' || !hook || this.disposed || !this.rings.length) return;
    void color;
    void depth;
    const lit = this.shader();
    let code = this.captureCode.get(lit);
    if (code === undefined) {
      const declarations = hook.declarations(lit),
        head = '@fragment fn fragment(i:Output)->@location(0) vec4f {';
      if (lit.split(head).length !== 2)
        throw margoError(
          'unsupported',
          'Terrain capture needs the terrain fragment entry point once; a lighting effect changed it',
        );
      code =
        declarations +
        lit.replace(head, 'fn margoShade(i:Output)->vec4f {') +
        `\n@fragment fn capture(i:Output)->MargoSSR {${terrainOutside}${this.textures?.holes ? terrainHole : ''}${terrainShading(this.surface())}let v=normalize(frame.eye.xyz-i.position);${declarations.includes('var<private> margoPosition:') ? 'margoPosition=i.position;' : ''}return margoSSR(n,v,base,i.material.y,i.material.x);}\n`;
      if (this.captureCode.size >= 16) this.captureCode.clear();
      this.captureCode.set(lit, code);
    }
    const entries = this.lightingEntries;
    entries.length = 0;
    for (const effect of this.lighting) {
      const bound = effect.bindings();
      for (let i = 0; i < bound.length; i++) entries.push(bound[i]);
    }
    const key =
      'capture:' +
      hook.targets.map((t) => t.format).join(',') +
      ':' +
      c.descriptor.multisample?.count +
      ':' +
      c.descriptor.depthStencil!.format +
      code;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code }),
        layouts = [this.layout!];
      if (entries.length) layouts.push(c.device.createBindGroupLayout({ entries: lightingLayout(code, entries) }));
      pipeline = c.device.createRenderPipeline({
        layout: c.device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
        },
        fragment: { module, entryPoint: 'capture', targets: hook.targets as GPUColorTargetState[] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
      });
      this.pipelines.set(key, pipeline);
    }
    const pass = hook.begin();
    pass.setPipeline(pipeline);
    if (entries.length) pass.setBindGroup(1, this.lightingGroup(c.device, pipeline, entries));
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      pass.setBindGroup(0, this.rings[i].group);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
    }
  }
  private lightingGroup(device: GPUDevice, pipeline: GPURenderPipeline, entries: GPUBindGroupEntry[]): GPUBindGroup {
    const cached = this.lightingGroups.get(pipeline);
    if (
      cached?.device === device &&
      cached.entries.length === entries.length &&
      entries.every((entry, i) => {
        const previous = cached.entries[i],
          resource = entry.resource,
          old = previous.resource;
        return (
          entry.binding === previous.binding &&
          (resource === old ||
            ('buffer' in resource &&
              'buffer' in old &&
              resource.buffer === old.buffer &&
              resource.offset === old.offset &&
              resource.size === old.size))
        );
      })
    )
      return cached.group;
    // Providers may mutate the same buffer-binding wrapper between draws.
    const snapshot = entries.map(({ binding, resource }) => ({
      binding,
      resource:
        'buffer' in resource ? { buffer: resource.buffer, offset: resource.offset, size: resource.size } : resource,
    }));
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries });
    this.lightingGroups.set(pipeline, { device, entries: snapshot, group });
    return group;
  }
  /**
   * Draws the terrain's depth with the frame's camera into an occluder pass of @margoengine/culling
   * (`parts.addOccluder(terrain)`): the rings the main pass draws, on the same uniforms.
   */
  drawOccluder({ pass, samples }: { pass: GPURenderPassEncoder; samples: number }): void {
    if (this.disposed || !this.device) return;
    if (this.occluder?.samples !== samples) {
      const module = this.device.createShaderModule({
        code: this.clip(terrainVertex + `@fragment fn outside(i:Output){${terrainOutside}}`),
      });
      this.occluder = {
        samples,
        pipeline: this.device.createRenderPipeline({
          layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
          vertex: {
            module,
            entryPoint: 'vertex',
            buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
          },
          fragment: { module, entryPoint: 'outside', targets: [] },
          multisample: { count: samples },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
        }),
      };
    }
    pass.setPipeline(this.occluder.pipeline);
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      pass.setBindGroup(0, this.rings[i].group);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
    }
  }
  drawShadow({
    context,
    pass,
    matrix,
    cascade,
  }: {
    context: TerrainPassContext;
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    if (this.disposed) return;
    pass.setPipeline(this.shadowPipeline!);
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.shadowValues.set(r.values);
      r.shadowValues.set(matrix);
      this.upload(context.device.queue, r.shadowUniforms[cascade], r.shadowValues);
      pass.setBindGroup(0, r.shadowGroups[cascade]);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
    }
  }
  /**
   * Casts the terrain into a point, spot, directional or area light's map of clustered `LocalShadows` (pass the
   * terrain to `LocalShadows.add`). Reversed depth (`greater`), one uniform set per ring and layer, made on first use.
   */
  drawLocalShadow({
    context,
    pass,
    matrix,
    layer,
  }: {
    context: TerrainPassContext;
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    layer: number;
  }): void {
    if (this.disposed || !this.shadowModule || !this.ringGroup) return;
    if (!Number.isInteger(layer) || layer < 0)
      throw new RangeError('Invalid local shadow layer; pass the integer layer index LocalShadows gives');
    const device = context.device;
    const module = this.shadowModule;
    this.localShadowPipeline ??= device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
      vertex: {
        module,
        entryPoint: 'vertex',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: { module, entryPoint: 'outside', targets: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    pass.setPipeline(this.localShadowPipeline);
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      let buffer = r.localUniforms[layer];
      if (!buffer) {
        buffer = r.localUniforms[layer] = device.createBuffer({
          size: r.values.length * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        r.localGroups[layer] = this.ringGroup(buffer);
      }
      r.shadowValues.set(r.values);
      r.shadowValues.set(matrix);
      this.upload(device.queue, buffer, r.shadowValues);
      pass.setBindGroup(0, r.localGroups[layer]);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
    }
  }
  /** Writes `values` to `buffer` unless the buffer already holds exactly these bits (compared bit for bit, so -0 and NaN count). */
  private upload(queue: GPUQueue, buffer: GPUBuffer, values: Float32Array): void {
    let bits = this.bitViews.get(values);
    if (!bits) this.bitViews.set(values, (bits = new Uint32Array(values.buffer, values.byteOffset, values.length)));
    let last = this.sent.get(buffer);
    if (last) {
      let same = true;
      for (let i = 0; i < bits.length; i++)
        if (bits[i] !== last[i]) {
          same = false;
          break;
        }
      if (same) return;
    } else this.sent.set(buffer, (last = new Uint32Array(bits.length)));
    last.set(bits);
    queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
  }
  private release(): void {
    for (const texture of new Set(
      this.textures
        ? [
            this.textures.heightmap,
            this.textures.normalmap,
            this.textures.layers,
            ...(this.textures.weights ?? []),
            this.textures.tint,
            this.textures.holes,
          ]
        : [],
    ))
      texture?.destroy();
    for (const buffer of [this.vertex, this.center, this.ring, this.rules]) buffer?.destroy();
    for (const r of this.rings)
      for (const buffer of [r.uniform, ...r.shadowUniforms, ...r.localUniforms]) buffer?.destroy();
    this.textures = undefined;
    this.vertex = this.center = this.ring = this.rules = undefined;
    this.rings = [];
    this.pipelines.clear();
    this.occluder = undefined;
    this.lightingGroups.clear();
    this.shadowPipeline = this.localShadowPipeline = this.shadowModule = this.ringGroup = undefined;
    this.layout = undefined;
    this.sampler = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.unfollow?.();
    this.unfollow = undefined;
    this.lighting.clear();
    this.capture = undefined;
    this.captureCode.clear();
    this.engine = this.device = undefined;
    const disposers = [...this.disposers];
    this.disposers.clear();
    for (const callback of disposers) callback();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  destroy(): void {
    this.dispose();
  }
}
