import { trackSpecLayer } from './spec-hooks.js';
/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/sciviz/bricks: volumes larger than one texture or the GPU budget. Bricks of a level-of-detail pyramid
// live in one atlas texture; a page table with one entry per full-resolution brick names the finest loaded brick over
// that place. Each ray sample looks up its entry and reads the atlas with hardware filtering, so one pass marches the
// whole box and the marching itself matches `figure.volume()` sample for sample where level 0 is loaded. Bricks repeat
// a voxel of their neighbours on each side, so filtering across a brick edge gives what a single texture gives. A
// separate entry: a sciviz user who does not import it pays nothing.
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import {
  brickKey,
  brickRegion,
  BrickCache,
  fillBrick,
  fitBudget,
  planBricks,
  selectBricks,
  type BrickAddress,
  type BrickBudget,
  type BrickPlan,
  type BrickSource,
  type SelectedBrick,
} from './bricks-plan.js';
import { rangeOption, resolveColormap, type Bounds } from './layer.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { transferTable, type ClipPlane, type VolumeLayerOptions } from './volume.js';
import type { Colormap } from './colormaps.js';

export {
  arraySource,
  BrickCache,
  brickKey,
  brickRegion,
  fillBrick,
  fitBudget,
  planBricks,
  selectBricks,
} from './bricks-plan.js';
export type {
  BrickAddress,
  BrickBudget,
  BrickLevel,
  BrickPlan,
  BrickRequest,
  BrickSource,
  SelectedBrick,
} from './bricks-plan.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** The default memory budget: 512 MiB of GPU memory for a layer's atlas and page table. */
export const DEFAULT_BRICK_BUDGET = 536_870_912;

/** Options for a bricked volume: the look of `figure.volume()` (without `dims`) plus how bricks load. */
export interface BrickedVolumeOptions extends Omit<VolumeLayerOptions, 'dims'> {
  /** Bytes of GPU memory for the atlas and page table. Default 536,870,912 (512 MiB). */
  readonly memoryBudget?: number;
  /** Voxels per brick side. Default 64. */
  readonly brickSize?: number;
  /** Voxels each brick repeats from its neighbours, so filtering stays exact across brick edges; 0 shows seams. Default 1. */
  readonly border?: number;
  /** Pixels a voxel may cover before finer bricks are wanted; 0 asks for full resolution everywhere in view. Default 1. */
  readonly detail?: number;
  /** Most brick reads started per frame and running at once. Default 4. */
  readonly concurrency?: number;
}

/** What a bricked volume holds right now, from `layer.stats`. */
export interface BrickStats {
  /** Bricks the current view wants. */
  readonly wanted: number;
  /** Bricks in the atlas, for any time step. */
  readonly resident: number;
  /** Atlas slots. */
  readonly capacity: number;
  /** Reads in progress. */
  readonly loading: number;
  /** Bricks read since the layer was created. */
  readonly loaded: number;
  /** Bytes of GPU memory of the atlas and page table. */
  readonly memoryBytes: number;
  /** The finest level wanted (0 is full resolution). */
  readonly finestLevel: number;
}

/** The page table and atlas lookup every bricked pipeline shares. */
const bricksWGSL = /* wgsl */ `${frameWGSL}
struct Volume { model: mat4x4f, toBox: mat4x4f, normalModel: mat4x4f, dims: vec4f, params: vec4f, planes: array<vec4f, 4>, atlas: vec4f, grid: vec4f }
@group(1) @binding(0) var<uniform> volume: Volume;
@group(1) @binding(1) var atlas: texture_3d<f32>;
@group(1) @binding(2) var transfer: texture_2d<f32>;
@group(1) @binding(3) var linearSampler: sampler;
@group(1) @binding(4) var pages: texture_3d<u32>;
// The finest loaded brick over a point: atlas slot in xyz, level + 1 in w, 0 when nothing covers it.
fn page(p: vec3f) -> vec4u {
  let v = clamp(p, vec3f(0.0), vec3f(1.0)) * volume.dims.xyz;
  return textureLoad(pages, min(vec3u(v / volume.grid.x), textureDimensions(pages) - 1u), 0);
}
fn sample(p: vec3f) -> f32 {
  let v = clamp(p, vec3f(0.0), vec3f(1.0)) * volume.dims.xyz;
  let cell = min(vec3u(v / volume.grid.x), textureDimensions(pages) - 1u);
  let entry = textureLoad(pages, cell, 0);
  if (entry.w == 0u) { return 0.0; }
  let level = entry.w - 1u;
  let local = v / f32(1u << level) - vec3f(cell >> vec3u(level)) * volume.grid.x;
  let at = vec3f(entry.xyz) * volume.grid.z + volume.grid.y + local;
  return textureSampleLevel(atlas, linearSampler, at / volume.atlas.xyz, 0.0).r;
}`;

/** The ray march of `VolumeLayer`, over the page table and atlas, stepping by the loaded level. */
const volumeShader = /* wgsl */ `${bricksWGSL}
struct Out { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) ndc: vec4f }
fn corner(index: u32) -> vec3f {
  let faces = array<vec3u, 6>(vec3u(0u, 1u, 2u), vec3u(0u, 2u, 1u), vec3u(1u, 2u, 0u), vec3u(1u, 0u, 2u), vec3u(2u, 0u, 1u), vec3u(2u, 1u, 0u));
  let face = index / 6u;
  let k = index % 6u;
  let quad = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let axes = faces[face];
  var p = vec3f(0.0);
  let uv = quad[k].yx;
  p[axes.x] = uv.x;
  p[axes.y] = uv.y;
  p[axes.z] = f32(face % 2u);
  return p;
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let world = volume.model * vec4f(corner(index), 1.0);
  var out: Out;
  out.world = world.xyz;
  out.clip = frame.clip * world;
  out.ndc = out.clip;
  return out;
}
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn kept(p: vec3f) -> bool {
  for (var k = 0u; k < u32(volume.dims.w); k++) {
    if (dot(volume.planes[k].xyz, p) + volume.planes[k].w < 0.0) { return false; }
  }
  return true;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let ndc = in.ndc.xy / in.ndc.w;
  let nearWorld = frame.inverse * vec4f(ndc, 1.0, 1.0);
  let origin = (volume.toBox * vec4f(nearWorld.xyz / nearWorld.w, 1.0)).xyz;
  let hit = (volume.toBox * vec4f(in.world, 1.0)).xyz;
  let dir = normalize(hit - origin);
  let inv = 1.0 / dir;
  let t0 = (vec3f(0.0) - origin) * inv;
  let t1 = (vec3f(1.0) - origin) * inv;
  let enter = max(max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), 0.0);
  let exit = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  if (exit <= enter) { discard; }
  let voxel = 1.0 / max(max(volume.dims.x, volume.dims.y), volume.dims.z);
  let stride = max(voxel / volume.params.x, (exit - enter) / 2048.0);
  let count = min(u32((exit - enter) / stride) + 1u, 2048u);
  var t = enter + stride * hash(in.clip.xy);
  var colour = vec3f(0.0);
  var alpha = 0.0;
  var peak = 0.0;
  let toEye = -normalize((volume.normalModel * vec4f(dir, 0.0)).xyz);
  var i = 0u;
  loop {
    if (i >= count) { break; }
    let p = origin + dir * t;
    // A coarser brick has voxels 2^level as wide: step, and take gradients, by its voxel.
    let entry = page(p);
    let width = 1u << (max(entry.w, 1u) - 1u);
    let span = f32(width);
    t += stride * span;
    i += width;
    if (!kept(p)) { continue; }
    let v = sample(p);
    if (volume.params.y > 0.5) { peak = max(peak, v); continue; }
    let tf = textureSampleLevel(transfer, linearSampler, vec2f(v, 0.5), 0.0);
    let a = 1.0 - pow(1.0 - clamp(tf.a * volume.params.z, 0.0, 0.999), stride * span / voxel);
    if (a < 0.002) { continue; }
    var rgb = tf.rgb;
    if (volume.params.w > 0.5) {
      let texel = span / volume.dims.xyz;
      let g = vec3f(
        sample(p + vec3f(texel.x, 0.0, 0.0)) - sample(p - vec3f(texel.x, 0.0, 0.0)),
        sample(p + vec3f(0.0, texel.y, 0.0)) - sample(p - vec3f(0.0, texel.y, 0.0)),
        sample(p + vec3f(0.0, 0.0, texel.z)) - sample(p - vec3f(0.0, 0.0, texel.z)));
      if (dot(g, g) > 1e-8) {
        let n = normalize((volume.normalModel * vec4f(-g / texel, 0.0)).xyz);
        rgb = shade(rgb, n, toEye);
      }
    }
    colour += (1.0 - alpha) * a * rgb;
    alpha += (1.0 - alpha) * a;
    if (alpha > 0.99) { break; }
  }
  if (volume.params.y > 0.5) {
    let tf = textureSampleLevel(transfer, linearSampler, vec2f(peak, 0.5), 0.0);
    return vec4f(toOutput(tf.rgb), clamp(max(tf.a, peak) * volume.params.z, 0.0, 1.0));
  }
  if (alpha < 0.002) { discard; }
  return vec4f(toOutput(colour / alpha), alpha);
}`;

/** A slice through the bricks, in the pipeline layout of the volume plus its plane. */
const sliceShader = /* wgsl */ `${bricksWGSL}
@group(2) @binding(0) var<uniform> plane: vec4f;
struct Out { @builtin(position) clip: vec4f, @location(0) box: vec3f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let quad = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let axis = u32(plane.x);
  var p = vec3f(0.0);
  p[(axis + 1u) % 3u] = quad[index].x;
  p[(axis + 2u) % 3u] = quad[index].y;
  p[axis] = plane.y;
  var out: Out;
  out.box = p;
  out.clip = frame.clip * (volume.model * vec4f(p, 1.0));
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let rgb = textureSampleLevel(transfer, linearSampler, vec2f(sample(in.box), 0.5), 0.0).rgb;
  return vec4f(toOutput(rgb), plane.z);
}`;

const MAX_PLANES = 4;
const BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * A volume drawn from bricks loaded by view and level of detail, inside a memory budget. Create it with
 * {@link brickedVolume}. Sends an `error` event for a brick that failed to load; coarser bricks keep drawing there.
 */
export class BrickedVolumeLayer extends EventTarget implements Drawable {
  /** False hides the layer. */
  visible = true;
  /** Blended over opaque layers. */
  readonly transparent = true;
  /** Grid size [nx, ny, nz]. */
  readonly dims: readonly [number, number, number];
  /** Data bounds of the box. */
  readonly bounds: Bounds;
  /** Data range of the transfer function. */
  readonly range: readonly [number, number];
  /** The colour map. */
  readonly colormap: Colormap;
  /** Time steps of the source. */
  readonly frames: number;
  /** The bricks of this volume. */
  readonly plan: BrickPlan;
  /** The atlas and page table sizes the memory budget gave. */
  readonly budget: BrickBudget;
  /** `'composite'` or `'mip'`. */
  mode: 'composite' | 'mip';
  /** Overall opacity scale. */
  density: number;
  /** Samples per voxel along a ray. */
  quality: number;
  /** Gradient lighting. */
  shading: boolean;
  /** Pixels a voxel may cover before finer bricks are wanted. */
  detail: number;
  readonly #renderer: SciRenderer;
  readonly #source: BrickSource;
  readonly #opacity: VolumeLayerOptions['opacity'];
  readonly #concurrency: number;
  #clip: ClipPlane[];
  #atlas: GPUTexture | undefined;
  #pages: GPUTexture | undefined;
  #transfer: GPUTexture | undefined;
  #uniform: GPUBuffer | undefined;
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  readonly #values = new Float32Array(84);
  #model = new Float32Array(16);
  // CPU copy of the page table, and the box of cells changed since it was last written.
  readonly #table: Uint16Array<ArrayBuffer>;
  #dirty: [number, number, number, number, number, number] | undefined;
  #cache: BrickCache;
  // The time step on screen, and the one loading (they differ until the new step's bricks are in).
  #shown = 0;
  #frame = 0;
  #wanted: SelectedBrick[] = [];
  #wantedKeys = new Set<number>();
  readonly #loading = new Map<number, AbortController>();
  readonly #failed = new Set<number>();
  #loaded = 0;
  readonly #viewKey = new Float32Array(34);
  #selected = false;
  #settled = false;
  readonly #waiters = new Set<Waiter>();
  readonly #slices = new Set<BrickedSliceLayer>();
  readonly #scratch: Uint16Array<ArrayBuffer>;
  #disposed = false;
  #frames: Promise<void> = Promise.resolve();

  /** @internal Use {@link brickedVolume}. */
  constructor(renderer: SciRenderer, source: BrickSource, options: BrickedVolumeOptions = {}) {
    super();
    if (!source || typeof source.read !== 'function' || source.dims?.length !== 3)
      throw typeError(
        'A bricked volume needs a source: { dims: [nx, ny, nz], read(request) }, or arraySource(data, dims)',
        'sciviz',
      );
    this.#renderer = renderer;
    this.#source = source;
    this.frames = source.frames ?? 1;
    if (!Number.isInteger(this.frames) || this.frames < 1)
      throw rangeError(`Bricked volume source frames must be a positive integer, got ${source.frames}`, 'sciviz');
    this.plan = planBricks([...source.dims], options.brickSize ?? 64, options.border ?? 1);
    this.budget = fitBudget(
      this.plan,
      options.memoryBudget ?? DEFAULT_BRICK_BUDGET,
      renderer.device!.limits.maxTextureDimension3D,
      this.frames,
    );
    const range = rangeOption(options.range ?? source.range, 'Bricked volume range');
    if (!range) throw typeError('A bricked volume needs range: [min, max], from the option or the source', 'sciviz');
    this.range = range;
    const [nx, ny, nz] = source.dims;
    this.dims = [nx, ny, nz];
    this.bounds = options.bounds ? ([...options.bounds] as Bounds) : [0, nx - 1, 0, ny - 1, 0, nz - 1];
    this.colormap = resolveColormap(options.colormap);
    this.#opacity = options.opacity;
    this.mode = options.mode ?? 'composite';
    if (this.mode !== 'composite' && this.mode !== 'mip')
      throw typeError(`Volume mode must be 'composite' or 'mip', got ${String(this.mode)}`, 'sciviz');
    this.density = options.density ?? 1;
    this.quality = options.quality ?? 1.5;
    this.shading = options.shading ?? true;
    this.detail = options.detail ?? 1;
    this.#concurrency = options.concurrency ?? 4;
    if (!(this.density > 0) || !(this.quality > 0))
      throw rangeError('Volume density and quality must be positive', 'sciviz');
    if (!(this.detail >= 0)) throw rangeError(`Bricked volume detail must be 0 or more, got ${this.detail}`, 'sciviz');
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1)
      throw rangeError(`Bricked volume concurrency must be a positive integer, got ${this.#concurrency}`, 'sciviz');
    this.#clip = this.#checkClip(options.clip ?? []);
    const [px, py, pz] = this.plan.levels[0].bricks;
    this.#table = new Uint16Array(px * py * pz * 4);
    this.#cache = new BrickCache(this.budget.capacity);
    this.#scratch = new Uint16Array((this.plan.brickSize + 2 * this.plan.border) ** 3);
    this.#build();
  }

  #checkClip(planes: readonly ClipPlane[]): ClipPlane[] {
    if (planes.length > MAX_PLANES)
      throw rangeError(`A volume takes at most ${MAX_PLANES} clip planes, got ${planes.length}`, 'sciviz');
    for (const p of planes)
      if (!p || p.normal?.length !== 3 || ![...p.normal, p.offset].every(Number.isFinite))
        throw typeError('A clip plane is { normal: [x, y, z], offset } with finite numbers', 'sciviz');
    return [...planes];
  }

  /** The clip planes (box coordinates). Assign to change them. */
  get clip(): readonly ClipPlane[] {
    return this.#clip;
  }
  set clip(planes: readonly ClipPlane[]) {
    this.#clip = this.#checkClip(planes);
  }

  /** The time step on screen. */
  get frame(): number {
    return this.#shown;
  }

  /** What the layer holds right now. */
  get stats(): BrickStats {
    return {
      wanted: this.#wanted.length,
      resident: this.#cache.size,
      capacity: this.budget.capacity,
      loading: this.#loading.size,
      loaded: this.#loaded,
      memoryBytes: this.budget.atlasBytes + this.budget.pageBytes,
      finestLevel: this.#wanted.reduce((finest, b) => Math.min(finest, b.level), this.plan.levels.length - 1),
    };
  }

  #build(): void {
    const device = this.#renderer.device!,
      { brickSize, border } = this.plan,
      side = brickSize + 2 * border,
      [sx, sy, sz] = this.budget.slots;
    this.#atlas = device.createTexture({
      label: 'sciviz bricks atlas',
      size: [sx * side, sy * side, sz * side],
      dimension: '3d',
      format: 'r16float',
      // A browser zeroes a texture before its first partial write. Without this usage some backends do that through
      // one staging buffer of the whole texture, which fails past maxBufferSize (Chrome on Direct3D 12); with it, they
      // clear it as a render target.
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#pages = device.createTexture({
      label: 'sciviz bricks pages',
      size: [...this.plan.levels[0].bricks],
      dimension: '3d',
      format: 'rgba16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#transfer = device.createTexture({
      size: [256, 1],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.#transfer },
      transferTable(this.colormap, this.#opacity),
      { bytesPerRow: 1024 },
      [256, 1],
    );
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint', viewDimension: '3d' } },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: this.#atlas.createView({ dimension: '3d' }) },
        { binding: 2, resource: this.#transfer.createView() },
        {
          binding: 3,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
          }),
        },
        { binding: 4, resource: this.#pages.createView({ dimension: '3d' }) },
      ],
    });
    // A page table starts empty: nothing draws until the root brick arrives.
    this.#table.fill(0);
    const [px, py, pz] = this.plan.levels[0].bricks;
    this.#dirty = [0, 0, 0, px, py, pz];
    this.#flushPages();
  }

  /** @internal The device was restored: every brick is read again. */
  restore(): void {
    for (const load of this.#loading.values()) load.abort();
    this.#loading.clear();
    this.#failed.clear();
    this.#cache = new BrickCache(this.budget.capacity);
    this.#selected = false;
    this.#settled = false;
    this.#build();
  }

  /** @internal The figure's data-to-scene transform. */
  setModel(figure: Float32Array): void {
    const [x0, x1, y0, y1, z0, z1] = this.bounds,
      box = [x1 - x0, 0, 0, 0, 0, y1 - y0, 0, 0, 0, 0, z1 - z0, 0, x0, y0, z0, 1];
    multiplyMatrices(figure, box, this.#model);
  }

  /** @internal */
  center(): readonly [number, number, number] {
    const m = this.#model;
    return [m[12] + (m[0] + m[4] + m[8]) / 2, m[13] + (m[1] + m[5] + m[9]) / 2, m[14] + (m[2] + m[6] + m[10]) / 2];
  }

  /** @internal Resources slices draw with. */
  resources(): { layout: GPUBindGroupLayout; group: GPUBindGroup } {
    return { layout: this.#layout!, group: this.#group! };
  }

  /**
   * A slice through the volume: the plane `axis = position` (position in [0, 1] across the box), coloured by the
   * volume's colour map from the same bricks. Move it with `slice.position = ...`.
   */
  slice(axis: 'x' | 'y' | 'z', position = 0.5, options: { readonly opacity?: number } = {}): BrickedSliceLayer {
    const slice = new BrickedSliceLayer(this.#renderer, this, axis, position, options.opacity ?? 1);
    this.#slices.add(slice);
    this.#renderer.add(slice);
    return slice;
  }

  /** @internal */
  forgetSlice(slice: BrickedSliceLayer): void {
    this.#slices.delete(slice);
  }

  /**
   * Resolves once every brick the current view wants at the current time step is loaded, which takes rendered frames:
   * bricks are chosen and started as frames draw. Rejects with a coded error if a brick failed (asking again reads it
   * again), or with the signal's reason when `signal` aborts.
   */
  ready(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.#disposed) return Promise.reject(fault('disposed', 'Bricked volume disposed; create a new one', 'sciviz'));
    this.#failed.clear();
    this.#settled = false;
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const abort = () => done(() => reject(signal!.reason)),
        done = (finish: () => void) => {
          signal?.removeEventListener('abort', abort);
          this.#waiters.delete(waiter);
          finish();
        },
        waiter: Waiter = {
          resolve: () => done(resolve),
          reject: (error) => done(() => reject(error)),
        };
      signal?.addEventListener('abort', abort, { once: true });
      this.#waiters.add(waiter);
    });
  }

  /**
   * Moves to time step `index`. The old step stays on screen until the new step's bricks for the view are loaded, then
   * they swap in one frame. Overlapping requests run in order and each resolves for its own step.
   * Use it from `figure.timeline()`: playback waits for the returned promise.
   */
  setFrame(index: number, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= this.frames)
      return Promise.reject(
        rangeError(`Bricked volume frame must be an integer in [0, ${this.frames - 1}], got ${index}`, 'sciviz'),
      );
    const run = this.#frames.then(() => {
      if (this.#disposed) throw fault('disposed', 'Bricked volume disposed; create a new one', 'sciviz');
      options.signal?.throwIfAborted();
      if (index !== this.#frame) {
        this.#frame = index;
        this.#selected = false;
      }
      const cancel = () => {
        // Revoke publication as well as the waiter, even when a source ignores its aborted signal.
        this.#frame = this.#shown;
        this.#selected = false;
        this.#settled = false;
        this.#failed.clear();
        for (const load of this.#loading.values()) load.abort(options.signal!.reason);
        this.#loading.clear();
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      return this.ready(options).finally(() => options.signal?.removeEventListener('abort', cancel));
    });
    this.#frames = run.catch(() => {});
    return run;
  }

  // Keys carry the time step, so going back to a step finds what is still cached.
  #key(brick: BrickAddress, frame: number): number {
    return brickKey(this.plan, brick) + frame * this.plan.count;
  }

  // A page cell gets the finest loaded brick of the time step on screen over it, or nothing.
  #coverCell(cell: number, x: number, y: number, z: number): void {
    const table = this.#table,
      [sx, sy] = this.budget.slots;
    for (let level = 0; level < this.plan.levels.length; level++) {
      const slot = this.#cache.slot(this.#key({ level, x: x >> level, y: y >> level, z: z >> level }, this.#shown));
      if (slot === undefined) continue;
      table[cell] = slot % sx;
      table[cell + 1] = Math.floor(slot / sx) % sy;
      table[cell + 2] = Math.floor(slot / (sx * sy));
      table[cell + 3] = level + 1;
      return;
    }
    table.fill(0, cell, cell + 4);
  }

  // After a brick arrived or left: the page cells under it.
  #refreshPages({ level, x, y, z }: BrickAddress): void {
    const [px, py, pz] = this.plan.levels[0].bricks,
      lo = [x << level, y << level, z << level],
      hi = [Math.min(px, (x + 1) << level), Math.min(py, (y + 1) << level), Math.min(pz, (z + 1) << level)];
    for (let k = lo[2]; k < hi[2]; k++)
      for (let j = lo[1]; j < hi[1]; j++)
        for (let i = lo[0]; i < hi[0]; i++) this.#coverCell((i + px * (j + py * k)) * 4, i, j, k);
    const d = this.#dirty;
    this.#dirty = d
      ? [
          Math.min(d[0], lo[0]),
          Math.min(d[1], lo[1]),
          Math.min(d[2], lo[2]),
          Math.max(d[3], hi[0]),
          Math.max(d[4], hi[1]),
          Math.max(d[5], hi[2]),
        ]
      : [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
  }

  #flushPages(): void {
    const d = this.#dirty;
    if (!d) return;
    this.#dirty = undefined;
    const [px, py] = this.plan.levels[0].bricks;
    this.#renderer.device!.queue.writeTexture(
      { texture: this.#pages!, origin: [d[0], d[1], d[2]] },
      this.#table,
      { offset: (d[0] + px * (d[1] + py * d[2])) * 8, bytesPerRow: px * 8, rowsPerImage: py },
      [d[3] - d[0], d[4] - d[1], d[5] - d[2]],
    );
  }

  #address(key: number): { brick: BrickAddress; frame: number } {
    const count = this.plan.count,
      frame = Math.floor(key / count),
      rest = key - frame * count,
      levels = this.plan.levels;
    let level = levels.length - 1;
    while (levels[level].offset > rest) level--;
    const [bx, by] = levels[level].bricks,
      local = rest - levels[level].offset;
    return { brick: { level, x: local % bx, y: Math.floor(local / bx) % by, z: Math.floor(local / (bx * by)) }, frame };
  }

  // A slot for the brick: the least recently used one this view does not want. The time step on screen keeps its root
  // while another loads, so a swap never shows a hole.
  #upload(brick: BrickAddress, frame: number, values: ArrayLike<number>): void {
    const { size } = brickRegion(this.plan, brick);
    if (values?.length !== size[0] * size[1] * size[2])
      throw rangeError(
        `Bricked volume source returned ${values?.length} values for a block of [${size.join(', ')}]`,
        'sciviz',
      );
    const key = this.#key(brick, frame),
      rootKey = this.#key({ level: this.plan.levels.length - 1, x: 0, y: 0, z: 0 }, this.#shown),
      placed = this.#cache.place(key, (k) => this.#wantedKeys.has(k) || (k === rootKey && this.budget.capacity > 1));
    // Every slot holds a brick this view wants: a newer view dropped this one while it loaded.
    if (!placed) return;
    if (placed.evicted !== undefined) {
      const old = this.#address(placed.evicted);
      if (old.frame === this.#shown) this.#refreshPages(old.brick);
    }
    const [lo, hi] = this.range,
      side = this.plan.brickSize + 2 * this.plan.border,
      [sx, sy] = this.budget.slots;
    fillBrick(this.plan, brick, values, lo, hi, this.#scratch);
    this.#renderer.device!.queue.writeTexture(
      {
        texture: this.#atlas!,
        origin: [
          (placed.slot % sx) * side,
          (Math.floor(placed.slot / sx) % sy) * side,
          Math.floor(placed.slot / (sx * sy)) * side,
        ],
      },
      this.#scratch,
      { bytesPerRow: side * 2, rowsPerImage: side },
      [side, side, side],
    );
    if (frame === this.#shown) this.#refreshPages(brick);
    this.#loaded++;
    this.#flushPages();
  }

  #load(brick: SelectedBrick, frame: number): void {
    const key = this.#key(brick, frame),
      controller = new AbortController(),
      { signal } = controller,
      { origin, size } = brickRegion(this.plan, brick);
    this.#loading.set(key, controller);
    const finish = () => {
      if (this.#loading.get(key) === controller) this.#loading.delete(key);
    };
    new Promise<ArrayLike<number>>((resolve) =>
      resolve(this.#source.read({ level: brick.level, frame, origin, size, signal })),
    )
      .then((values) => {
        if (signal.aborted || this.#disposed) return;
        finish();
        this.#upload(brick, frame, values);
        this.#settle();
      })
      .catch((error: unknown) => {
        finish();
        if (signal.aborted || this.#disposed) return;
        this.#failed.add(key);
        this.#fail(error, brick);
      });
  }

  #fail(cause: unknown, brick: BrickAddress): void {
    const text = cause instanceof Error ? cause.message : String(cause),
      error = fault(
        'failed',
        `Bricked volume brick at level ${brick.level} [${brick.x}, ${brick.y}, ${brick.z}] failed to load (${text}); coarser bricks keep drawing, call ready() to read it again`,
        'sciviz',
      ) as Error;
    error.cause = cause;
    const heard = this.#waiters.size > 0;
    for (const w of [...this.#waiters]) w.reject(error);
    const event = new CustomEvent('error', { cancelable: true, detail: { error, brick } });
    // An error nobody asked about or listened for still reaches the page's error reporting.
    if (this.dispatchEvent(event) && !heard) reportError(error);
  }

  // After a selection or a finished read: swap to a time step that is ready, and answer waiters.
  #settle(): void {
    if (!this.#selected || this.#loading.size) return;
    const missing = this.#wanted.some((b) => {
      const key = this.#key(b, this.#frame);
      return !this.#cache.has(key) && !this.#failed.has(key);
    });
    if (missing) return;
    if (this.#frame !== this.#shown) {
      this.#shown = this.#frame;
      const [px, py, pz] = this.plan.levels[0].bricks;
      for (let k = 0, cell = 0; k < pz; k++)
        for (let j = 0; j < py; j++) for (let i = 0; i < px; i++, cell += 4) this.#coverCell(cell, i, j, k);
      this.#dirty = [0, 0, 0, px, py, pz];
      this.#flushPages();
    }
    if (this.#failed.size) return;
    this.#settled = true;
    for (const w of [...this.#waiters]) w.resolve();
  }

  /** @internal Once per frame from the volume or a slice: picks bricks when the view changed and starts reads. */
  schedule(context: GpuContext): void {
    if (this.#disposed) return;
    const key = this.#viewKey,
      clip = context.camera.matrix,
      model = this.#model;
    let changed = !this.#selected;
    const check = (at: number, v: number) => {
      if (key[at] !== v) {
        key[at] = v;
        changed = true;
      }
    };
    for (let i = 0; i < 16; i++) {
      check(i, clip[i]);
      check(16 + i, model[i]);
    }
    check(32, context.width);
    check(33, context.height);
    if (changed) {
      const m = new Float32Array(16);
      multiplyMatrices(clip as Float32Array, model, m);
      // One slot stays for the shown step's root while time series load (see #upload).
      const room = this.frames > 1 && this.budget.capacity > 1 ? this.budget.capacity - 1 : this.budget.capacity;
      this.#wanted = selectBricks(this.plan, m, context.width, context.height, room, this.detail);
      this.#wantedKeys = new Set(this.#wanted.map((b) => this.#key(b, this.#frame)));
      this.#selected = true;
      this.#settled = false;
      for (const [k, load] of this.#loading)
        if (!this.#wantedKeys.has(k)) {
          load.abort();
          this.#loading.delete(k);
        }
    }
    if (this.#settled) return;
    let started = 0;
    for (const brick of this.#wanted) {
      if (this.#loading.size >= this.#concurrency || started >= this.#concurrency) break;
      const k = this.#key(brick, this.#frame);
      if (this.#cache.has(k)) {
        this.#cache.touch(k);
        continue;
      }
      if (this.#loading.has(k) || this.#failed.has(k)) continue;
      this.#load(brick, this.#frame);
      started++;
    }
    this.#settle();
  }

  /** @internal */
  prepare(context: GpuContext): void {
    this.schedule(context);
    const v = this.#values,
      m = this.#model;
    v.set(m, 0);
    const toBox = new Float32Array(16);
    invertMatrix(m, toBox);
    v.set(toBox, 16);
    const n = new Float32Array(16);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) n[c * 4 + r] = toBox[r * 4 + c];
    n[15] = 1;
    v.set(n, 32);
    v.set([this.dims[0], this.dims[1], this.dims[2], this.#clip.length], 48);
    v.set([this.quality, this.mode === 'mip' ? 1 : 0, this.density, this.shading ? 1 : 0], 52);
    v.fill(0, 56, 72);
    this.#clip.forEach((p, k) => v.set([...p.normal, p.offset], 56 + k * 4));
    const { brickSize, border } = this.plan,
      side = brickSize + 2 * border,
      [sx, sy, sz] = this.budget.slots;
    v.set([sx * side, sy * side, sz * side, 0], 72);
    v.set([brickSize, border, side, 0], 76);
    this.#renderer.device!.queue.writeBuffer(this.#uniform!, 0, v);
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const eye = context.camera.position,
      toBox = this.#values.subarray(16, 32),
      p = [0, 1, 2].map((r) => toBox[r] * eye[0] + toBox[4 + r] * eye[1] + toBox[8 + r] * eye[2] + toBox[12 + r]),
      inside = p.every((c) => c > 0 && c < 1);
    const pipeline = renderer.pipeline(`bricks|${inside}`, context, (target) => {
      const module = renderer.device!.createShaderModule({ code: volumeShader, label: 'sciviz bricks' });
      return {
        label: 'sciviz bricks',
        layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout!] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format, blend: BLEND }] },
        primitive: { topology: 'triangle-list', cullMode: inside ? 'front' : 'back' },
        multisample: target.multisample,
        depthStencil: {
          format: target.depth,
          depthWriteEnabled: false,
          depthCompare: inside ? 'always' : 'greater-equal',
        },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group!);
    pass.draw(36);
  }

  /** Stops reading, frees the GPU resources and the volume's slices. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const load of this.#loading.values()) load.abort();
    this.#loading.clear();
    for (const w of [...this.#waiters])
      w.reject(fault('disposed', 'Bricked volume disposed; create a new one', 'sciviz'));
    for (const s of [...this.#slices]) s.dispose();
    this.#renderer.remove(this);
    this.#atlas?.destroy();
    this.#pages?.destroy();
    this.#transfer?.destroy();
    this.#uniform?.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** A plane through a bricked volume. Create it with `layer.slice(axis, position)`. */
export class BrickedSliceLayer implements Drawable {
  /** False hides the slice. */
  visible = true;
  /** The axis the plane is perpendicular to. */
  readonly axis: 'x' | 'y' | 'z';
  /** Position across the box, 0 to 1. */
  position: number;
  /** Opacity, 0 to 1. */
  readonly opacity: number;
  readonly #renderer: SciRenderer;
  readonly #volume: BrickedVolumeLayer;
  #uniform: GPUBuffer | undefined;
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  #disposed = false;

  /** @internal Use `layer.slice()`. */
  constructor(
    renderer: SciRenderer,
    volume: BrickedVolumeLayer,
    axis: 'x' | 'y' | 'z',
    position: number,
    opacity: number,
  ) {
    if (!['x', 'y', 'z'].includes(axis))
      throw typeError(`Slice axis must be 'x', 'y' or 'z', got ${String(axis)}`, 'sciviz');
    if (!(position >= 0 && position <= 1))
      throw rangeError(`Slice position must be in [0, 1], got ${position}`, 'sciviz');
    if (!(opacity >= 0 && opacity <= 1)) throw rangeError(`Slice opacity must be in [0, 1], got ${opacity}`, 'sciviz');
    this.#renderer = renderer;
    this.#volume = volume;
    this.axis = axis;
    this.position = position;
    this.opacity = opacity;
    this.restore();
  }

  /** @internal */
  restore(): void {
    const device = this.#renderer.device!;
    this.#uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: [{ binding: 0, resource: { buffer: this.#uniform } }],
    });
  }

  /** Opaque slices write depth; translucent ones blend. */
  get transparent(): boolean {
    return this.opacity < 1;
  }

  /** @internal */
  center(): readonly [number, number, number] {
    return this.#volume.center();
  }

  /** @internal A slice also loads bricks and fills the shared uniform, so hiding the volume keeps it drawing. */
  prepare(context: GpuContext): void {
    if (!(this.position >= 0 && this.position <= 1))
      throw rangeError(`Slice position must be in [0, 1], got ${this.position}`, 'sciviz');
    if (!this.#volume.visible) this.#volume.prepare(context);
    this.#renderer.device!.queue.writeBuffer(
      this.#uniform!,
      0,
      new Float32Array([{ x: 0, y: 1, z: 2 }[this.axis], this.position, this.opacity, 0]),
    );
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const transparent = this.transparent,
      { layout, group } = this.#volume.resources();
    const pipeline = renderer.pipeline(`bricks-slice|${transparent}`, context, (target) => {
      const module = renderer.device!.createShaderModule({ code: sliceShader, label: 'sciviz bricks slice' });
      return {
        label: 'sciviz bricks slice',
        layout: renderer.device!.createPipelineLayout({
          bindGroupLayouts: [renderer.frameLayout!, layout, this.#layout!],
        }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: target.format, blend: transparent ? BLEND : undefined }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: !transparent, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, group);
    pass.setBindGroup(2, this.#group!);
    pass.draw(6);
  }

  /** Removes the slice. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    this.#volume.forgetSlice(this);
    this.#uniform?.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Adds a volume drawn from bricks to a 3D figure: for grids larger than one texture or the GPU memory budget. Bricks
 * load by view and level of detail as frames draw; await `layer.ready()` for the view's full detail.
 * @param figure The figure.
 * @param source Where voxels come from: your `{ dims, read(request) }`, or {@link arraySource}.
 * @param options Look (as `figure.volume()`) and loading.
 */
export function brickedVolume(
  figure: Figure,
  source: BrickSource,
  options: BrickedVolumeOptions = {},
): BrickedVolumeLayer {
  const layer = new BrickedVolumeLayer(figure.renderer, source, options);
  figure.renderer.add(layer);
  return trackSpecLayer(figure, 'bricks', [source, options], figure.addLayer(layer));
}
