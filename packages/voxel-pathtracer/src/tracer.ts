/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel-pathtracer: the engine plugin. One compute pass per frame adds samples to the viewport's
// accumulation buffers, an optional wavelet denoiser filters them, and a full-screen pass draws the result (tone mapped,
// with the first hit's depth) over the frame at `order` 20. Captures render tiles of any size on their own buffers
// with copies of the scene, so the viewport and later scene changes cannot disturb them (README, "Captures").
import type { EngineKernel } from '@margoengine/core';
import {
  Camera,
  type Engine,
  type EnginePlugin,
  engineRuntime,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { invertMatrix } from '@margoengine/math/mat4';
import {
  FLAG_CLAMP,
  FLAG_ENV,
  FLAG_GROUND,
  FLAG_JITTER,
  FLAG_MOTION,
  FLAG_AREA,
  FLAG_CAMERA_MOTION,
  FLAG_CLEAR_GLASS,
  FLAG_HIDE_SUN,
  FLAG_NO_COMPENSATION,
  FLAG_NO_SUN_MEDIA,
  FLAG_OPAQUE_SHADOWS,
  FLAG_SUN_DIFFUSE,
  FLAG_SPLIT,
  FLAG_SUN,
  FRAME_BYTES,
  type LightLayout,
  lightLayout,
  modelWords,
  type SceneLayout,
  sceneLayout,
} from './layout.js';
import { PngWriter } from './png.js';
import {
  buildSnapshot,
  checkNumber,
  checkVec3,
  type PackedEnvironment,
  type PackedModel,
  type SceneCache,
  MATERIAL_FLOATS,
  type SceneSnapshot,
} from './scene.js';
import { DENOISE, DISPLAY, TABLE_VEC4, TABLES, TRACE } from './shaders.js';
import { LAMBDA_MAX, LAMBDA_MIN } from './spectrum.js';
import { raycastSnapshot } from './traverse.js';
import type {
  TraceBounceLimits,
  TraceEdges,
  TraceFisheye,
  TraceGrid,
  TraceLensDistortion,
  TracePreviousCamera,
  TraceVec3,
  VoxelPathTracerOptions,
  VoxelPathTracerStats,
  VoxelTraceCaptureOptions,
  VoxelTraceHit,
  VoxelTraceImage,
  VoxelTraceRenderOptions,
  VoxelTraceScene,
} from './types.js';

declare const GPUBufferUsage: {
  MAP_READ: number;
  COPY_SRC: number;
  COPY_DST: number;
  UNIFORM: number;
  STORAGE: number;
};
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number; COMPUTE: number };
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

const DEFAULT_WORDS = (128 << 20) / 4, // WebGPU's default maxStorageBufferBindingSize, in words
  TILE = 1024, // capture tile edge
  APRON = 64, // capture tile margin while denoising (reach of five a-trous levels: 2 * (1 + 2 + 4 + 8 + 16) = 62)
  ATROUS = 5, // wavelet levels of the regular part (steps 1..16)
  CAUSTIC_LEVELS = 6, // and of the caustic part (steps 1..32)
  LUMINANCE_SIGMA = 1.5, // luminance stop of the regular chain, in standard deviations of the difference
  CAUSTIC_SIGMA = 4, // and of the caustic chain
  DENOISE_PASSES = ATROUS + CAUSTIC_LEVELS + 2, // prepare, the two chains, combine
  VIEW_BYTES = 176,
  PARAM_STRIDE = 512,
  PARAM_BYTES = 368;

/** Resolved tracer options (every field set). */
interface Settings {
  samplesPerFrame: number | 'auto';
  maxBounces: number;
  maxSamples: number;
  seed: number;
  resolutionScale: number;
  exposure: number;
  aperture: number;
  focusDistance: number | undefined;
  denoise: boolean | 'auto';
  lensBlades: number;
  lensRotation: number;
  shutter: number;
  clamp: number;
  toneMapping: 'neutral' | 'linear' | 'aces-narkowicz';
  gamma: number | undefined;
  bounceLimits: Required<TraceBounceLimits> | undefined;
  transparentShadows: boolean;
  sunSpecular: boolean;
  sunInMedia: boolean;
  energyCompensation: boolean;
  vignette: number;
  edges: TraceEdges | undefined;
  grid: Required<TraceGrid> | undefined;
  order: number;
  previousCamera: TracePreviousCamera | undefined;
  projection: 'camera' | 'panorama' | 'fisheye';
  fisheye: Required<TraceFisheye>;
  distortion: Required<TraceLensDistortion> | undefined;
}
const DEFAULTS: Settings = {
  samplesPerFrame: 1,
  maxBounces: 8,
  maxSamples: 1024,
  seed: 0,
  resolutionScale: 1,
  exposure: 0,
  aperture: 0,
  focusDistance: undefined,
  denoise: false,
  lensBlades: 0,
  lensRotation: 0,
  shutter: 0,
  clamp: Infinity,
  toneMapping: 'neutral',
  gamma: undefined,
  bounceLimits: undefined,
  transparentShadows: true,
  sunSpecular: true,
  sunInMedia: true,
  energyCompensation: true,
  vignette: 0,
  edges: undefined,
  grid: undefined,
  order: 20,
  previousCamera: undefined,
  projection: 'camera',
  fisheye: { mapping: 'equidistant', fov: 180 },
  distortion: undefined,
};
// Options whose change invalidates the accumulated samples (the others only change how they are shown or paced).
const RESETS: readonly (keyof Settings)[] = [
  'maxBounces',
  'seed',
  'resolutionScale',
  'aperture',
  'focusDistance',
  'lensBlades',
  'lensRotation',
  'shutter',
  'previousCamera',
  'projection',
  'fisheye',
  'distortion',
  'clamp',
  'bounceLimits',
  'transparentShadows',
  'sunSpecular',
  'sunInMedia',
  'energyCompensation',
  'edges',
  'grid',
];

const whole = (value: unknown, name: string, min: number, max: number, fix: string) => {
  const v = checkNumber(value, name, min, max, fix);
  if (!Number.isInteger(v)) throw new RangeError(`VoxelPathTracer ${name} ${v} must be a whole number; ${fix}`);
  return v;
};
const flag = (value: unknown, name: string) => {
  if (typeof value !== 'boolean') throw new TypeError(`VoxelPathTracer ${name} must be true or false`);
  return value;
};

/** Per-kind bounce caps with absent kinds uncapped (BOUNCE_FREE); null clears them. */
const BOUNCE_FREE = 0xffff;
function bounceLimits(value: unknown): Required<TraceBounceLimits> | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'object')
    throw new TypeError('VoxelPathTracer bounceLimits must be {diffuse?, specular?, scatter?} or null');
  const o = value as Record<string, unknown>,
    cap = (k: 'diffuse' | 'specular' | 'scatter') =>
      o[k] === undefined ? BOUNCE_FREE : whole(o[k], `bounceLimits.${k}`, 1, 64, 'pass 1 to 64, or leave it out');
  return { diffuse: cap('diffuse'), specular: cap('specular'), scatter: cap('scatter') };
}

/** Edge bands, or undefined for null. */
function edges(value: unknown): TraceEdges | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'object') throw new TypeError('VoxelPathTracer edges must be {color, width} or null');
  const o = value as Record<string, unknown>;
  return {
    color: checkVec3(o.color, 'VoxelPathTracer edges.color', true, 'pass linear RGB, 0 or more'),
    width: checkNumber(o.width, 'edges.width', 0, 0.5, 'pass 0 to 0.5 voxels'),
  };
}
/** Grid lines, or undefined for null. */
function grid(value: unknown): Required<TraceGrid> | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'object')
    throw new TypeError('VoxelPathTracer grid must be {color, spacing, width, onVoxels?} or null');
  const o = value as Record<string, unknown>;
  return {
    color: checkVec3(o.color, 'VoxelPathTracer grid.color', true, 'pass linear RGB, 0 or more'),
    spacing: checkNumber(o.spacing, 'grid.spacing', 1e-3, 1e6, 'pass a distance above 0'),
    width: checkNumber(o.width, 'grid.width', 0, 1e6, 'pass a half width, 0 or more'),
    onVoxels: o.onVoxels === undefined ? false : flag(o.onVoxels, 'grid.onVoxels'),
  };
}

/** Validates `input` over `base`; throws before returning anything. */
function settings(input: Partial<Omit<VoxelPathTracerOptions, 'scene'>>, base: Settings): Settings {
  if (!input || typeof input !== 'object') throw new TypeError('VoxelPathTracer options must be an object');
  const s = { ...base },
    o = input as Record<string, unknown>;
  if (o.samplesPerFrame !== undefined)
    s.samplesPerFrame =
      o.samplesPerFrame === 'auto'
        ? 'auto'
        : whole(o.samplesPerFrame, 'samplesPerFrame', 1, 64, "pass 1 to 64 or 'auto'");
  if (o.maxBounces !== undefined) s.maxBounces = whole(o.maxBounces, 'maxBounces', 1, 64, 'pass 1 to 64');
  if (o.maxSamples !== undefined) {
    const v = checkNumber(o.maxSamples, 'maxSamples', 1, Infinity, 'pass 1 or more, or Infinity');
    if (v !== Infinity && !Number.isInteger(v))
      throw new RangeError(`VoxelPathTracer maxSamples ${v} must be a whole number or Infinity`);
    s.maxSamples = v;
  }
  if (o.seed !== undefined) s.seed = whole(o.seed, 'seed', 0, 0xffffffff, 'pass an integer 0 to 4294967295');
  if (o.resolutionScale !== undefined)
    s.resolutionScale = checkNumber(o.resolutionScale, 'resolutionScale', 0.1, 2, 'pass 0.1 to 2');
  if (o.exposure !== undefined) s.exposure = checkNumber(o.exposure, 'exposure', -20, 20, 'pass EV stops, -20 to 20');
  if (o.aperture !== undefined) s.aperture = checkNumber(o.aperture, 'aperture', 0, 1e6, 'pass a diameter, 0 or more');
  if (o.focusDistance !== undefined)
    s.focusDistance = checkNumber(o.focusDistance, 'focusDistance', 1e-6, 1e9, 'pass a distance above 0');
  if (o.denoise !== undefined) s.denoise = o.denoise === 'auto' ? 'auto' : flag(o.denoise, 'denoise');
  if (o.lensBlades !== undefined) {
    const v = whole(o.lensBlades, 'lensBlades', 0, 16, 'pass 0 (round) or 3 to 16');
    if (v === 1 || v === 2) throw new RangeError('VoxelPathTracer lensBlades must be 0 (round) or 3 to 16');
    s.lensBlades = v;
  }
  if (o.lensRotation !== undefined)
    s.lensRotation = checkNumber(o.lensRotation, 'lensRotation', -1e6, 1e6, 'pass radians');
  if (o.shutter !== undefined) s.shutter = checkNumber(o.shutter, 'shutter', 0, 1, 'pass 0 (off) to 1');
  if (o.clamp !== undefined) {
    const v = checkNumber(o.clamp, 'clamp', 0, Infinity, 'pass a luminance above 0, or Infinity');
    if (!(v > 0)) throw new RangeError('VoxelPathTracer clamp must be above 0 (Infinity turns it off)');
    s.clamp = v;
  }
  if (o.toneMapping !== undefined) {
    if (o.toneMapping !== 'neutral' && o.toneMapping !== 'linear' && o.toneMapping !== 'aces-narkowicz')
      throw new TypeError(
        `VoxelPathTracer toneMapping ${String(o.toneMapping)} is unknown; pass 'neutral', 'linear' or 'aces-narkowicz'`,
      );
    s.toneMapping = o.toneMapping;
  }
  if ('gamma' in o)
    s.gamma =
      o.gamma === undefined ? undefined : checkNumber(o.gamma, 'gamma', 1, 5, 'pass 1 to 5, or undefined for sRGB');
  if (o.bounceLimits !== undefined) s.bounceLimits = bounceLimits(o.bounceLimits);
  if (o.transparentShadows !== undefined) s.transparentShadows = flag(o.transparentShadows, 'transparentShadows');
  if (o.sunSpecular !== undefined) s.sunSpecular = flag(o.sunSpecular, 'sunSpecular');
  if (o.sunInMedia !== undefined) s.sunInMedia = flag(o.sunInMedia, 'sunInMedia');
  if (o.energyCompensation !== undefined) s.energyCompensation = flag(o.energyCompensation, 'energyCompensation');
  if (o.vignette !== undefined) s.vignette = checkNumber(o.vignette, 'vignette', 0, 100, 'pass 0 (off) or more');
  if (o.edges !== undefined) s.edges = edges(o.edges);
  if (o.grid !== undefined) s.grid = grid(o.grid);
  if (o.order !== undefined) s.order = checkNumber(o.order, 'order', -1e9, 1e9, 'pass a finite frame-graph order');
  if (o.previousCamera !== undefined) s.previousCamera = previousCamera(o.previousCamera);
  if (o.projection !== undefined) {
    if (o.projection !== 'camera' && o.projection !== 'panorama' && o.projection !== 'fisheye')
      throw new TypeError(
        `VoxelPathTracer projection ${String(o.projection)} is unknown; pass 'camera', 'panorama' or 'fisheye'`,
      );
    s.projection = o.projection;
  }
  if (o.fisheye !== undefined) {
    if (!o.fisheye || typeof o.fisheye !== 'object')
      throw new TypeError('VoxelPathTracer fisheye must be {mapping?, fov?}');
    const e = o.fisheye as Record<string, unknown>;
    if (e.mapping !== undefined && e.mapping !== 'equidistant' && e.mapping !== 'equisolid')
      throw new TypeError(
        `VoxelPathTracer fisheye.mapping ${String(e.mapping)} is unknown; pass 'equidistant' or 'equisolid'`,
      );
    s.fisheye = {
      mapping: (e.mapping as 'equidistant' | 'equisolid' | undefined) ?? 'equidistant',
      fov: e.fov === undefined ? 180 : checkNumber(e.fov, 'fisheye.fov', 1e-3, 360, 'pass degrees above 0 to 360'),
    };
  }
  if (o.distortion !== undefined) {
    if (o.distortion === null) s.distortion = undefined;
    else {
      if (typeof o.distortion !== 'object')
        throw new TypeError('VoxelPathTracer distortion must be {k1?, k2?, p1?, p2?} or null');
      const d = o.distortion as Record<string, unknown>,
        c = (k: string) => (d[k] === undefined ? 0 : checkNumber(d[k], `distortion.${k}`, -1, 1, 'pass -1 to 1'));
      s.distortion = { k1: c('k1'), k2: c('k2'), p1: c('p1'), p2: c('p2') };
    }
  }
  return s;
}

// A validated copy of a previous camera pose (undefined for null).
function previousCamera(value: unknown): TracePreviousCamera | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== 'object')
    throw new TypeError('VoxelPathTracer previousCamera must be {position, target, up?, fov?} or null');
  const c = value as Record<string, unknown>,
    position = checkVec3(c.position, 'previousCamera.position', false, 'pass a world point'),
    target = checkVec3(c.target, 'previousCamera.target', false, 'pass a world point'),
    up = c.up === undefined ? undefined : checkVec3(c.up, 'previousCamera.up', false, 'pass a direction'),
    fov = c.fov === undefined ? undefined : checkNumber(c.fov, 'previousCamera.fov', 1e-3, 179.999, 'pass degrees');
  if (position.every((v, i) => v === target[i]))
    throw new RangeError('VoxelPathTracer previousCamera.position equals its target; pass a distinct target');
  return { position, target, up, fov };
}

// First-fit allocator over runs of free words: [start, length] pairs sorted by start, neighbours merged.
class Runs {
  runs: number[];
  constructor(start: number, capacity: number) {
    this.runs = capacity > start ? [start, capacity - start] : [];
  }
  alloc(n: number): number {
    const r = this.runs;
    for (let i = 0; i < r.length; i += 2)
      if (r[i + 1] >= n) {
        const at = r[i];
        r[i] += n;
        r[i + 1] -= n;
        if (!r[i + 1]) r.splice(i, 2);
        return at;
      }
    return -1;
  }
  release(start: number, n: number): void {
    const r = this.runs;
    let i = 0;
    while (i < r.length && r[i] < start) i += 2;
    if (i < r.length && start + n === r[i]) {
      r[i] = start;
      r[i + 1] += n;
    } else r.splice(i, 0, start, n);
    if (i && r[i - 2] + r[i - 1] === start) {
      r[i - 1] += r[i + 1];
      r.splice(i, 2);
    }
  }
}

interface Pipelines {
  trace: GPUComputePipeline;
  ids: GPUComputePipeline;
  prepare: GPUComputePipeline;
  atrous: GPUComputePipeline;
  combine: GPUComputePipeline;
}
/** Scene buffers on one device. */
interface SceneBuffers {
  materials: GPUBuffer;
  voxels: GPUBuffer;
  scene: GPUBuffer;
  lights: GPUBuffer;
  env: GPUBuffer;
}
interface Gpu {
  device: GPUDevice;
  lost: boolean;
  traceLayout: GPUBindGroupLayout;
  denoiseLayout: GPUBindGroupLayout;
  displayLayout: GPUBindGroupLayout;
  pipelines?: Pipelines;
  /** The preview kernel, ready long before the full pipelines. */
  preview?: GPUComputePipeline;
  /** The trace module, and its coverage kernel compiled at the first transparent render. */
  traceModule?: GPUShaderModule;
  coverage?: Promise<GPUComputePipeline>;
  display: Map<string, { pipeline?: GPURenderPipeline }>;
  buffers: SceneBuffers;
  /** Energy-compensation albedo tables (uniform) and the storage buffer the GPU integrates them into. */
  tables: GPUBuffer;
  tableScratch: GPUBuffer;
  /** Bound where a binding is unused (no caustic buffer without denoising): one for writable, one for read-only
   * bindings, since a pass may not bind one buffer both ways. */
  dummy: GPUBuffer;
  dummyRead: GPUBuffer;
  capacity: number;
  runs: Runs;
  regions: Map<PackedModel, number>;
  envSource?: PackedEnvironment;
  layout?: { scene: SceneLayout; lights: LightLayout };
  version: number;
  resources: number;
  view?: View;
}
/** Accumulation (and denoiser) buffers of one image size. */
interface Targets {
  width: number;
  height: number;
  accum: GPUBuffer;
  albedo: GPUBuffer;
  normals: GPUBuffer;
  ping?: GPUBuffer;
  pong?: GPUBuffer;
  guide?: GPUBuffer;
  /** Caustic part of the samples (when denoising), and its filter's ping-pong pair. */
  caustics?: GPUBuffer;
  cping?: GPUBuffer;
  cpong?: GPUBuffer;
  params?: GPUBuffer;
  /** One per denoiser pass; none for the caustic chain's passes when there are no caustics. */
  denoiseGroups?: (GPUBindGroup | undefined)[];
}
interface View extends Targets {
  frame: GPUBuffer;
  uniform: GPUBuffer;
  traceGroup?: GPUBindGroup;
  traceKey?: string;
  displayRaw?: GPUBindGroup;
  displayDenoised?: GPUBindGroup;
  /** The denoised image blended with its history (in ping), shown when the last denoising kept history. */
  displayResolved?: GPUBindGroup;
  resolved?: boolean;
  denoisedAt: number;
}

let serial = 0;
const neutral = (c: number[]) => {
  const x = Math.min(c[0], c[1], c[2]),
    offset = x < 0.08 ? x - 6.25 * x * x : 0.04,
    v = c.map((y) => y - offset),
    peak = Math.max(v[0], v[1], v[2]);
  if (peak < 0.76) return v;
  const top = 1 - (0.24 * 0.24) / (peak + 0.24 - 0.76),
    t = 1 - 1 / (0.15 * (peak - top) + 1);
  return v.map((y) => (y * top) / peak + (top - (y * top) / peak) * t);
};
// Narkowicz's fit after the 0.6 pre-scale his reference applies (the shader's acesNarkowicz).
const acesNarkowicz = (c: number[]) =>
  c.map((y) => {
    const x = 0.6 * y;
    return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  });
const toneCurve = (mode: Settings['toneMapping']) =>
  mode === 'linear' ? (c: number[]) => c : mode === 'aces-narkowicz' ? acesNarkowicz : neutral;
/** 8-bit display value: sRGB, or the power 1 / gamma. */
const encode = (v: number, gamma?: number) => {
  const x = Math.min(1, Math.max(0, v));
  return Math.round(255 * (gamma ? x ** (1 / gamma) : x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055));
};
/** FNV-1a over a matrix's float32 bits. */
const cameraHash = (m: ArrayLike<number>) => {
  const bits = new Uint32Array(Float32Array.from(m).buffer);
  let h = 0x811c9dc5;
  for (const b of bits) h = Math.imul(h ^ b, 0x01000193);
  return h >>> 0;
};
const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The render was aborted', 'AbortError');
};

/**
 * Progressive WebGPU path tracer for voxel scenes: an engine plugin that, while `enabled`, replaces the frame with a
 * path-traced image of a {@link VoxelTraceScene} seen through the engine camera (perspective, or orthographic through
 * `Camera.project`), refining it every frame until `maxSamples`. Models are walked in 8^3 bricks and voxels
 * (Amanatides-Woo), instances through a bounding volume hierarchy; materials, lights and options are listed in the
 * README. `capture` renders a PNG of any size off screen.
 *
 * ```ts
 * const tracer = VoxelPathTracer.attach(engine, { scene });
 * await tracer.ready; // pipelines compiled (frames before this show the ordinary raster image)
 * tracer.setScene(next); // validated whole; the accumulation restarts
 * const png = await tracer.capture({ width: 3840, height: 2160, samples: 512 });
 * tracer.dispose();
 * ```
 */
export class VoxelPathTracer implements EnginePlugin {
  /** Plugin name, unique per tracer. */
  readonly name = `voxel-pathtracer:${serial++}`;
  #engine?: Engine;
  #graph?: FrameGraph;
  #removePass?: () => void;
  #disposed = false;
  #enabled = true;
  #settings: Settings;
  #cache: SceneCache = { models: new Map(), emitters: new WeakMap() };
  #snapshot: SceneSnapshot;
  #version = 1;
  #gpu?: Gpu;
  #status: 'compiling' | 'ready' | 'failed' | 'disposed' = 'compiling';
  #error: unknown;
  /** samplesPerFrame 'auto': the current count, the display interval estimate, the cap after a missed frame and frames to keep it. */
  #auto = 1;
  #interval = 0;
  #cap = 64;
  #hold = 0;
  #streak = 0;
  /** The viewport's last denoised frame (its camera, scene version and size) and whether the camera moved since. */
  #history = {
    matrix: new Float32Array(16),
    corners: new Float32Array(32),
    version: -1,
    width: 0,
    height: 0,
    valid: false,
  };
  #restarted = false;
  /** The viewport shows preview samples (the full tracer is still compiling). */
  #previewing = false;
  #ready!: Promise<void>;
  #settle?: [() => void, (error: unknown) => void];
  #samples = 0;
  #key = new Float64Array(30);
  #frameMs = 0;
  #lastTrace = 0;
  #bytes = 0;
  #width = 0;
  #height = 0;
  #capturing = 0;
  #job: Promise<unknown> = Promise.resolve();
  #frame = new ArrayBuffer(FRAME_BYTES);
  #view = new Float32Array(VIEW_BYTES / 4);
  #inverse = new Float64Array(16);
  #corners = new Float32Array(32);

  private constructor(options: VoxelPathTracerOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('VoxelPathTracer.attach expects (engine, {scene, ...options})');
    const { scene, ...rest } = options;
    this.#settings = settings(rest, DEFAULTS);
    this.#snapshot = buildSnapshot(scene, this.#cache, DEFAULT_WORDS);
    this.#newReady();
  }

  /**
   * Creates a tracer for `options.scene` and adds it to `engine` (WebGPU backend). Pipelines compile in the background:
   * until {@link VoxelPathTracer.ready} resolves, frames show the ordinary raster image.
   * @throws TypeError when the scene or an option has the wrong shape (duplicate ids, a missing model or material).
   * @throws RangeError for values out of range or a scene over the device's storage limits.
   * @throws MargoError `unsupported` without the WebGPU backend.
   */
  static attach(engine: EngineKernel, options: VoxelPathTracerOptions): VoxelPathTracer {
    const tracer = new VoxelPathTracer(options);
    try {
      engineRuntime(engine).use(tracer);
    } catch (error) {
      tracer.dispose();
      throw error;
    }
    return tracer;
  }

  /** Whether the traced image replaces the frame. While false the tracer draws nothing and traces nothing. */
  get enabled(): boolean {
    return this.#enabled;
  }
  set enabled(value: boolean) {
    flag(value, 'enabled');
    if (value && !this.#enabled) this.#restart();
    this.#enabled = value;
  }

  /** Samples, timing and memory of the viewport image. */
  get stats(): VoxelPathTracerStats {
    return {
      samples: this.#previewing ? 0 : this.#samples,
      frameMs: this.#frameMs,
      gpuBytes: this.#bytes,
      converged: this.#samples >= this.#settings.maxSamples,
      width: this.#width,
      height: this.#height,
      sceneRevision: this.#snapshot.revision,
    };
  }

  /**
   * Compatible addition: resolves once the compute pipelines are compiled on the current device (a new promise
   * after a device restore); rejects with the compile error, or MargoError `disposed`.
   */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Compatible addition: 'compiling', 'ready', 'failed' (see `error`) or 'disposed'. */
  get status(): 'compiling' | 'ready' | 'failed' | 'disposed' {
    return this.#status;
  }

  /** Compatible addition: the pipeline error when `status` is 'failed'. */
  get error(): unknown {
    return this.#error;
  }

  /** Compatible addition: the options in effect (scene excluded), defaults filled in. */
  get options(): Readonly<
    Omit<
      Required<VoxelPathTracerOptions>,
      | 'scene'
      | 'focusDistance'
      | 'previousCamera'
      | 'distortion'
      | 'fisheye'
      | 'gamma'
      | 'bounceLimits'
      | 'edges'
      | 'grid'
    > & {
      focusDistance?: number;
      previousCamera?: TracePreviousCamera;
      fisheye: Required<TraceFisheye>;
      distortion?: Required<TraceLensDistortion>;
      gamma?: number;
      bounceLimits?: TraceBounceLimits;
      edges?: TraceEdges;
      grid?: Required<TraceGrid>;
    }
  > {
    const caps = this.#settings.bounceLimits,
      cap = (v: number) => (v === BOUNCE_FREE ? undefined : v);
    return {
      ...this.#settings,
      bounceLimits: caps && { diffuse: cap(caps.diffuse), specular: cap(caps.specular), scatter: cap(caps.scatter) },
    };
  }

  /**
   * Replaces the scene with a validated copy and restarts accumulation. Models whose id, revision and size match the
   * current scene's keep their packed and uploaded voxels.
   * @throws TypeError / RangeError for an invalid scene (the current scene stays); MargoError `disposed`.
   */
  setScene(scene: VoxelTraceScene): void {
    this.#alive();
    const limit = this.#gpu ? Math.floor(this.#gpu.device.limits.maxStorageBufferBindingSize / 4) : DEFAULT_WORDS;
    this.#snapshot = buildSnapshot(scene, this.#cache, limit);
    this.#version++;
    this.#samples = 0;
  }

  /**
   * Changes options (all validated before any applies). Sampling, lens, shutter and clamp changes restart
   * accumulation; exposure, tone mapping, denoising and sample budgets apply to the current image.
   * @throws TypeError / RangeError for an invalid option; MargoError `disposed`.
   */
  setOptions(options: Partial<Omit<VoxelPathTracerOptions, 'scene'>>): void {
    this.#alive();
    if (options && typeof options === 'object' && 'scene' in options)
      throw new TypeError('VoxelPathTracer setOptions does not take a scene; call setScene');
    const next = settings(options, this.#settings),
      previous = this.#settings;
    this.#settings = next;
    if (RESETS.some((k) => !Object.is(previous[k], next[k]))) this.#restart();
    if (next.order !== previous.order && this.#graph) this.#register(this.#graph);
  }

  /** Discards the accumulated samples; the next frame starts a new image. */
  reset(): void {
    this.#alive();
    this.#restart();
  }

  // A new image that the viewport's history must not blend into (the camera's moves keep it).
  #restart(): void {
    this.#samples = 0;
    this.#history.valid = false;
  }

  /**
   * Compatible addition: the closest visible voxel along a world ray (model-local cell, face, palette index), from the
   * scene being traced. Ground and lights are not hit.
   * @throws TypeError / RangeError for a malformed ray; MargoError `disposed`.
   */
  raycast(origin: TraceVec3, direction: TraceVec3, maxDistance = Infinity): VoxelTraceHit | null {
    this.#alive();
    const o = checkVec3(origin, 'raycast origin', false, 'pass a world point'),
      d = checkVec3(direction, 'raycast direction', false, 'pass a direction');
    if (!(Math.hypot(d[0], d[1], d[2]) > 0)) throw new RangeError('VoxelPathTracer raycast direction is zero');
    checkNumber(maxDistance, 'raycast maxDistance', 0, Infinity, 'pass a distance, 0 or more');
    const s = this.#snapshot,
      found = raycastSnapshot(s, o, d, maxDistance);
    if (!found) return null;
    const instance = s.instances[found.instance],
      { hit, distance } = found,
      normal: [number, number, number] = [0, 0, 0],
      length = Math.hypot(d[0], d[1], d[2]);
    normal[hit.axis] = hit.sign;
    return {
      instanceId: instance.id,
      modelId: s.models[instance.model].id,
      cell: hit.cell,
      normal,
      adjacent: [hit.cell[0] + normal[0], hit.cell[1] + normal[1], hit.cell[2] + normal[2]],
      paletteIndex: hit.value,
      distance,
      point: [o[0] + (d[0] / length) * distance, o[1] + (d[1] / length) * distance, o[2] + (d[2] / length) * distance],
    };
  }

  /**
   * Renders a PNG of `width` x `height` pixels at `samples` samples per pixel from the engine camera (its aspect set
   * to the image's), on separate GPU buffers and in tiles; the viewport pauses tracing meanwhile and keeps its image.
   * Rejects with the signal's reason when aborted, MargoError `failed` when the GPU device is lost, MargoError
   * `disposed` when the tracer is disposed meanwhile.
   * @throws TypeError / RangeError for invalid options (as a rejection).
   */
  capture(options: VoxelTraceCaptureOptions): Promise<Blob> {
    return this.#enqueue(async () => {
      const o = this.#renderOptions(options, 1 << 26),
        exposure = 2 ** this.#settings.exposure,
        tone = toneCurve(this.#settings.toneMapping),
        gamma = this.#settings.gamma,
        vignette = this.#settings.vignette,
        writer = new PngWriter(o.width, o.height, o.transparent),
        channels = writer.channels;
      try {
        await this.#render(o, false, async (y0, rows, band) => {
          const bytes = new Uint8Array(o.width * rows * channels),
            c = [0, 0, 0];
          for (let i = 0; i < o.width * rows; i++) {
            // Transparent: the colour of what the pixel's rays hit (premultiplied by coverage in the render).
            const alpha = band.alpha ? band.alpha[i] : 1;
            let gain = alpha > 0 ? exposure / alpha : 0;
            if (vignette > 0) {
              const x = (i % o.width) + 0.5 - o.width / 2,
                y = y0 + Math.floor(i / o.width) + 0.5 - o.height / 2,
                t = (vignette * Math.hypot(x, y)) / (0.2238 * o.height);
              gain /= (1 + t * t) ** 2;
            }
            for (let k = 0; k < 3; k++) c[k] = Math.max(0, band.color[i * 3 + k] * gain);
            const v = tone(c);
            for (let k = 0; k < 3; k++) bytes[i * channels + k] = encode(v[k], gamma);
            if (channels === 4) bytes[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha)));
          }
          await writer.write(bytes, rows);
        });
        return await writer.finish();
      } catch (error) {
        writer.abort();
        throw error;
      }
    });
  }

  /**
   * Compatible addition: renders linear float data (and with `aovs` albedo, normals, depth, instance and palette ids)
   * the way `capture` renders a PNG.
   * @throws TypeError / RangeError for invalid options (as a rejection); see `capture` for the other rejections.
   */
  renderImage(options: VoxelTraceRenderOptions): Promise<VoxelTraceImage> {
    return this.#enqueue(async () => {
      const o = this.#renderOptions(options, 1 << 24),
        n = o.width * o.height,
        color = new Float32Array(n * 3),
        aovs = options.aovs === true,
        albedo = aovs ? new Float32Array(n * 3) : undefined,
        normal = aovs ? new Float32Array(n * 3) : undefined,
        depth = aovs ? new Float32Array(n) : undefined,
        instance = aovs ? new Int32Array(n) : undefined,
        palette = aovs ? new Uint8Array(n) : undefined,
        alpha = o.transparent ? new Float32Array(n) : undefined,
        sources = this.#snapshot.instances.map((v) => v.source);
      await this.#render(o, aovs, async (y0, rows, band) => {
        const at = y0 * o.width;
        color.set(band.color, at * 3);
        if (alpha) alpha.set(band.alpha!, at);
        if (!aovs) return;
        albedo!.set(band.albedo!, at * 3);
        normal!.set(band.normal!, at * 3);
        depth!.set(band.depth!, at);
        for (let i = 0; i < o.width * rows; i++) {
          const id = band.ids![i];
          if (id >= 256) {
            instance![at + i] = sources[Math.floor(id / 256) - 1] ?? -1;
            palette![at + i] = id % 256;
          } else instance![at + i] = id === -2 ? -2 : id === -3 ? -3 : -1;
        }
      });
      return {
        width: o.width,
        height: o.height,
        samples: o.samples,
        color,
        albedo,
        normal,
        depth,
        instance,
        palette,
        ...(alpha ? { alpha } : {}),
      };
    });
  }

  /** @internal Engine plugin hook: checks the device and starts compiling. */
  setup(engine: Engine): void {
    this.#alive();
    const device = engine.gpu;
    if (!device)
      throw new MargoError('unsupported', 'VoxelPathTracer needs the WebGPU backend; create the engine with WebGPU');
    const limit = Math.floor(device.limits.maxStorageBufferBindingSize / 4);
    if (this.#snapshot.voxelWords > limit)
      throw new RangeError(
        `VoxelPathTracer scene needs ${this.#snapshot.voxelWords * 4} bytes of voxel bricks; this device binds at most ${limit * 4}`,
      );
    this.#engine = engine;
    this.#state(device);
  }

  /** @internal Engine plugin hook: the trace, denoise and display pass. */
  registerPasses(graph: FrameGraph): void {
    this.#graph = graph;
    this.#register(graph);
  }

  /** @internal Engine plugin hook: everything is rebuilt on the new device and accumulation restarts. */
  onDeviceRestored(engine: Engine): void {
    if (this.#disposed) return;
    this.#release();
    if (engine.gpu) this.#state(engine.gpu);
  }

  /** Removes the pass, frees every GPU buffer and leaves the engine. Pending captures reject. Safe to repeat. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#removePass?.();
    } catch {
      // The graph is executing (dispose from inside a frame); the pass checks #disposed and does nothing.
    }
    this.#engine?.removePlugin(this.name);
    this.#release();
    this.#engine = this.#graph = this.#removePass = undefined;
    if (this.#status === 'compiling') this.#settle?.[1](new MargoError('disposed', 'VoxelPathTracer is disposed'));
    this.#status = 'disposed';
  }

  /** Same as {@link VoxelPathTracer.dispose} (for `using`). */
  [Symbol.dispose](): void {
    this.dispose();
  }

  #alive(): void {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelPathTracer is disposed; attach a new one');
  }

  #newReady(): void {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#settle = [resolve, reject];
    });
    this.#ready.catch(() => {});
  }

  #register(graph: FrameGraph): void {
    this.#removePass?.();
    this.#removePass = graph.add({
      name: this.name,
      order: this.#settings.order,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.#enabled && !this.#disposed) this.#execute(c);
      },
    });
  }

  #buffer(gpu: Gpu, size: number, usage: number): GPUBuffer {
    const b = gpu.device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    this.#bytes += b.size;
    return b;
  }
  #destroy(b: GPUBuffer | undefined): void {
    if (!b) return;
    this.#bytes -= b.size;
    b.destroy();
  }

  // GPU state for `device`: layouts, empty scene buffers, pipelines compiling in the background.
  #state(device: GPUDevice): Gpu {
    if (this.#gpu?.device === device) return this.#gpu;
    if (this.#gpu) this.#release();
    const C = GPUShaderStage.COMPUTE,
      F = GPUShaderStage.FRAGMENT,
      entry = (binding: number, type: 'uniform' | 'read-only-storage' | 'storage', visibility = C) => ({
        binding,
        visibility,
        buffer: { type },
      }),
      traceLayout = device.createBindGroupLayout({
        entries: [
          entry(0, 'uniform'),
          entry(1, 'uniform'),
          entry(2, 'read-only-storage'),
          entry(3, 'read-only-storage'),
          entry(4, 'read-only-storage'),
          entry(5, 'read-only-storage'),
          entry(6, 'storage'),
          entry(7, 'storage'),
          entry(8, 'storage'),
          entry(9, 'uniform'),
          entry(10, 'storage'),
        ],
      }),
      tablesLayout = device.createBindGroupLayout({ entries: [entry(0, 'storage')] }),
      denoiseLayout = device.createBindGroupLayout({
        entries: [
          entry(0, 'uniform'),
          entry(1, 'read-only-storage'),
          entry(2, 'read-only-storage'),
          entry(3, 'read-only-storage'),
          entry(4, 'read-only-storage'),
          entry(5, 'storage'),
          entry(6, 'storage'),
          entry(7, 'read-only-storage'),
          entry(8, 'storage'),
        ],
      }),
      displayLayout = device.createBindGroupLayout({
        entries: [
          entry(0, 'uniform', GPUShaderStage.VERTEX | F),
          entry(1, 'read-only-storage', F),
          entry(2, 'read-only-storage', F),
        ],
      });
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      gpu: Gpu = {
        device,
        lost: false,
        traceLayout,
        denoiseLayout,
        displayLayout,
        display: new Map(),
        buffers: undefined as unknown as SceneBuffers,
        tables: undefined as unknown as GPUBuffer,
        tableScratch: undefined as unknown as GPUBuffer,
        dummy: undefined as unknown as GPUBuffer,
        dummyRead: undefined as unknown as GPUBuffer,
        capacity: 0,
        runs: new Runs(4, 4),
        regions: new Map(),
        version: 0,
        resources: 0,
      };
    this.#gpu = gpu;
    gpu.buffers = {
      materials: this.#buffer(
        gpu,
        256 * MATERIAL_FLOATS * 4,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      ),
      voxels: this.#buffer(gpu, 16, storage),
      scene: this.#buffer(gpu, 16, storage),
      lights: this.#buffer(gpu, 16, storage),
      env: this.#buffer(gpu, 16, storage),
    };
    gpu.tables = this.#buffer(gpu, TABLE_VEC4 * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    gpu.tableScratch = this.#buffer(gpu, TABLE_VEC4 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    gpu.dummy = this.#buffer(gpu, 16, GPUBufferUsage.STORAGE);
    gpu.dummyRead = this.#buffer(gpu, 16, GPUBufferUsage.STORAGE);
    gpu.capacity = 4;
    void device.lost?.then(() => {
      gpu.lost = true;
    });
    this.#samples = 0;
    if (this.#status !== 'compiling') this.#newReady();
    this.#status = 'compiling';
    const trace = (gpu.traceModule = device.createShaderModule({ code: TRACE })),
      denoise = device.createShaderModule({ code: DENOISE }),
      tables = device.createShaderModule({ code: TABLES }),
      layout = (l: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [l] }),
      compute = (module: GPUShaderModule, entryPoint: string, l: GPUBindGroupLayout) =>
        device.createComputePipelineAsync({ layout: layout(l), compute: { module, entryPoint } });
    // The small preview kernel first: the viewport shows a lit image while the full tracer compiles.
    compute(trace, 'preview', traceLayout).then(
      (p) => {
        if (this.#gpu === gpu && !this.#disposed && !gpu.pipelines) gpu.preview = p;
      },
      () => {},
    );
    Promise.all([
      compute(trace, 'trace', traceLayout),
      compute(trace, 'ids', traceLayout),
      compute(denoise, 'prepare', denoiseLayout),
      compute(denoise, 'atrous', denoiseLayout),
      compute(tables, 'tables', tablesLayout),
      compute(denoise, 'combine', denoiseLayout),
    ]).then(
      ([t, ids, prepare, atrous, table, combine]) => {
        if (this.#gpu !== gpu || this.#disposed) return;
        // Integrate the albedo tables once per device; queue order puts them before any trace.
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(table);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: tablesLayout,
            entries: [{ binding: 0, resource: { buffer: gpu.tableScratch } }],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil((TABLE_VEC4 * 4) / 64));
        pass.end();
        encoder.copyBufferToBuffer(gpu.tableScratch, 0, gpu.tables, 0, TABLE_VEC4 * 16);
        device.queue.submit([encoder.finish()]);
        gpu.pipelines = { trace: t, ids, prepare, atrous, combine };
        this.#status = 'ready';
        this.#settle?.[0]();
      },
      (error) => {
        if (this.#gpu !== gpu || this.#disposed) return;
        this.#status = 'failed';
        this.#error = error;
        this.#settle?.[1](error);
        this.#engine?.onError(error);
      },
    );
    return gpu;
  }

  #release(): void {
    const gpu = this.#gpu;
    if (!gpu) return;
    this.#gpu = undefined;
    for (const b of Object.values(gpu.buffers)) this.#destroy(b);
    this.#destroy(gpu.tables);
    this.#destroy(gpu.tableScratch);
    this.#destroy(gpu.dummy);
    this.#destroy(gpu.dummyRead);
    this.#releaseTargets(gpu.view);
    if (gpu.view) {
      this.#destroy(gpu.view.frame);
      this.#destroy(gpu.view.uniform);
    }
    gpu.view = undefined;
    this.#samples = 0;
  }

  #releaseTargets(t: Targets | undefined): void {
    if (!t) return;
    for (const b of [t.accum, t.albedo, t.normals, t.ping, t.pong, t.guide, t.params, t.caustics, t.cping, t.cpong])
      this.#destroy(b);
    t.ping = t.pong = t.guide = t.params = t.caustics = t.cping = t.cpong = undefined;
    t.denoiseGroups = undefined;
  }

  // Uploads the snapshot when it changed: voxel regions (kept for unchanged models), scene, lights, environment.
  #syncScene(gpu: Gpu): void {
    if (gpu.version === this.#version) return;
    const s = this.#snapshot,
      device = gpu.device,
      limit = Math.floor(device.limits.maxStorageBufferBindingSize / 4),
      storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      present = new Set(s.models);
    for (const [m, at] of gpu.regions)
      if (!present.has(m)) {
        gpu.runs.release(at, m.grid.length + m.payload.length);
        gpu.regions.delete(m);
      }
    const place = (m: PackedModel) => {
      const words = m.grid.length + m.payload.length,
        at = gpu.runs.alloc(words);
      if (at < 0) return false;
      gpu.regions.set(m, at);
      device.queue.writeBuffer(gpu.buffers.voxels, at * 4, modelWords(m, at));
      return true;
    };
    let fits = true;
    for (const m of s.models) if (!gpu.regions.has(m) && !(fits = place(m))) break;
    if (!fits) {
      // Repack every model into a buffer with room to spare (the snapshot was checked against the limit).
      const capacity = Math.min(limit, Math.max(s.voxelWords * 2, 1 << 16));
      this.#destroy(gpu.buffers.voxels);
      gpu.buffers.voxels = this.#buffer(gpu, capacity * 4, storage);
      gpu.capacity = capacity;
      gpu.runs = new Runs(4, capacity);
      gpu.regions.clear();
      for (const m of s.models) place(m);
      gpu.resources++;
    }
    const lights = lightLayout(s),
      scene = sceneLayout(
        s,
        s.models.map((m) => gpu.regions.get(m)!),
        lights,
      );
    const upload = (key: 'scene' | 'lights' | 'env', data: ArrayBufferView) => {
      if (gpu.buffers[key].size < data.byteLength) {
        this.#destroy(gpu.buffers[key]);
        gpu.buffers[key] = this.#buffer(gpu, Math.max(data.byteLength, gpu.buffers[key].size * 2), storage);
        gpu.resources++;
      }
      if (data.byteLength) device.queue.writeBuffer(gpu.buffers[key], 0, data as Uint32Array<ArrayBuffer>);
    };
    upload('scene', scene.words);
    upload('lights', lights.words);
    const env = s.environment.map;
    if (env && env !== gpu.envSource) {
      upload('env', env.texels);
      gpu.envSource = env;
    }
    device.queue.writeBuffer(gpu.buffers.materials, 0, s.materials as Float32Array<ArrayBuffer>);
    gpu.layout = { scene, lights };
    gpu.version = this.#version;
  }

  // Accumulation targets of `width` x `height` (plus the denoiser's when `denoise`, with its caustic chain when
  // `caustic`: the scene has materials that focus light).
  #targets(
    gpu: Gpu,
    t: Targets | undefined,
    width: number,
    height: number,
    denoise: boolean,
    caustic: boolean,
    temporal = false,
  ): Targets {
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      bytes = width * height * 16;
    let out = t;
    if (!out || out.width !== width || out.height !== height) {
      this.#releaseTargets(out);
      out = {
        ...(out ?? {}),
        width,
        height,
        accum: this.#buffer(gpu, bytes, storage),
        albedo: this.#buffer(gpu, bytes, storage),
        normals: this.#buffer(gpu, bytes, storage),
      } as Targets;
      gpu.resources++;
    }
    if (out.ping && (!denoise || (out.caustics !== undefined) !== caustic)) {
      for (const b of [out.ping, out.pong, out.guide, out.params, out.caustics, out.cping, out.cpong]) this.#destroy(b);
      out.ping = out.pong = out.guide = out.params = out.caustics = out.cping = out.cpong = undefined;
      out.denoiseGroups = undefined;
      gpu.resources++;
    }
    if (denoise && !out.ping) {
      out.ping = this.#buffer(gpu, bytes, storage);
      out.pong = this.#buffer(gpu, bytes, storage);
      // The viewport's guide also holds the denoiser's history (two more images of its size).
      out.guide = this.#buffer(gpu, temporal ? 3 * bytes : bytes, storage);
      if (caustic) {
        out.caustics = this.#buffer(gpu, bytes, storage);
        out.cping = this.#buffer(gpu, bytes, storage);
        out.cpong = this.#buffer(gpu, bytes, storage);
      }
      out.params = this.#buffer(gpu, PARAM_STRIDE * DENOISE_PASSES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const groups: (GPUBindGroup | undefined)[] = [],
        o = out,
        read = (b: GPUBuffer | undefined) => b ?? gpu.dummyRead;
      // Pass k: 0 prepare (regular -> ping, caustic -> cping), 1..ATROUS the regular chain ending in pong, then the
      // caustic chain ending in cping, last combine (pong += cping; the viewport's, blended with its history, to ping).
      for (let k = 0; k < DENOISE_PASSES; k++) {
        const j = k - ATROUS;
        if (!caustic && k > ATROUS && j <= CAUSTIC_LEVELS) {
          groups.push(undefined);
          continue;
        }
        const [src, dst] =
          k === 0
            ? [o.pong!, o.ping!]
            : k <= ATROUS
              ? k % 2
                ? [o.ping!, o.pong!]
                : [o.pong!, o.ping!]
              : j <= CAUSTIC_LEVELS
                ? j % 2
                  ? [o.cping!, o.cpong!]
                  : [o.cpong!, o.cping!]
                : [read(o.cping), o.pong!];
        groups.push(
          gpu.device.createBindGroup({
            layout: gpu.denoiseLayout,
            entries: [
              { binding: 0, resource: { buffer: o.params!, offset: k * PARAM_STRIDE, size: PARAM_BYTES } },
              { binding: 1, resource: { buffer: o.accum } },
              { binding: 2, resource: { buffer: o.albedo } },
              { binding: 3, resource: { buffer: o.normals } },
              { binding: 4, resource: { buffer: src } },
              { binding: 5, resource: { buffer: dst } },
              { binding: 6, resource: { buffer: o.guide! } },
              { binding: 7, resource: { buffer: read(o.caustics) } },
              {
                binding: 8,
                resource: {
                  buffer: k === 0 ? (o.cping ?? gpu.dummy) : temporal && k === DENOISE_PASSES - 1 ? o.ping! : gpu.dummy,
                },
              },
            ],
          }),
        );
      }
      out.denoiseGroups = groups;
      gpu.resources++;
    }
    return out;
  }

  #traceGroup(gpu: Gpu, frame: GPUBuffer, t: Targets, buffers = gpu.buffers): GPUBindGroup {
    return gpu.device.createBindGroup({
      layout: gpu.traceLayout,
      entries: [
        { binding: 0, resource: { buffer: frame } },
        { binding: 1, resource: { buffer: buffers.materials } },
        { binding: 2, resource: { buffer: buffers.voxels } },
        { binding: 3, resource: { buffer: buffers.scene } },
        { binding: 4, resource: { buffer: buffers.lights } },
        { binding: 5, resource: { buffer: buffers.env } },
        { binding: 6, resource: { buffer: t.accum } },
        { binding: 7, resource: { buffer: t.albedo } },
        { binding: 8, resource: { buffer: t.normals } },
        { binding: 9, resource: { buffer: gpu.tables } },
        { binding: 10, resource: { buffer: t.caustics ?? gpu.dummy } },
      ],
    });
  }

  // Corner rays (near-plane points at `origins`, directions toward NDC depth 0.5 at `directions`) and the lens frame
  // (eye and target distance, forward, right, up at `lens`) of a camera, into frame floats `f`; false when singular.
  #pose(camera: Camera, f: Float32Array, origins: number, directions: number, lens: number): boolean {
    const inv = this.#inverse;
    if (!invertMatrix(camera.matrix, inv)) return false;
    // In float64: near-plane points are NDC depth 1 (reversed).
    const unproject = (x: number, y: number, z: number) => {
      const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
      return [0, 1, 2].map((r) => (inv[r] * x + inv[4 + r] * y + inv[8 + r] * z + inv[12 + r]) / w);
    };
    for (const [k, [x, y]] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ].entries()) {
      const a = unproject(x, y, 1),
        b = unproject(x, y, 0.5);
      f.set([a[0], a[1], a[2], 0], origins + k * 4);
      f.set([b[0] - a[0], b[1] - a[1], b[2] - a[2], 0], directions + k * 4);
    }
    const p = camera.position,
      t = camera.target,
      forward = [t[0] - p[0], t[1] - p[1], t[2] - p[2]],
      distance = Math.hypot(forward[0], forward[1], forward[2]) || 1;
    for (let k = 0; k < 3; k++) forward[k] /= distance;
    const up = camera.up,
      right = [
        forward[1] * up[2] - forward[2] * up[1],
        forward[2] * up[0] - forward[0] * up[2],
        forward[0] * up[1] - forward[1] * up[0],
      ],
      rl = Math.hypot(right[0], right[1], right[2]) || 1;
    for (let k = 0; k < 3; k++) right[k] /= rl;
    const top = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ];
    f.set([p[0], p[1], p[2], distance], lens);
    f.set([forward[0], forward[1], forward[2], 0], lens + 4);
    f.set([right[0], right[1], right[2], 0], lens + 8);
    f.set([top[0], top[1], top[2], 0], lens + 12);
    return true;
  }

  // Frame uniform for a camera, image and tile (layout.ts FRAME_BYTES; Frame in shaders.ts).
  #writeFrame(
    device: GPUDevice,
    target: GPUBuffer,
    camera: Camera,
    image: readonly [number, number, number, number],
    tile: readonly [number, number, number, number],
    seed: number,
    jitter: boolean,
    split: boolean,
    layout: { scene: SceneLayout; lights: LightLayout },
    s: SceneSnapshot,
    wavelength = 0,
    transparent = false,
  ): boolean {
    const o = this.#settings,
      f = new Float32Array(this.#frame),
      u = new Uint32Array(this.#frame);
    if (!this.#pose(camera, f, 0, 76, 16)) return false;
    this.#corners.set(f.subarray(0, 16), 0);
    this.#corners.set(f.subarray(76, 92), 16);
    f[19] = o.focusDistance ?? f[19];
    f[23] = o.aperture / 2;
    f[27] = o.lensBlades;
    f[31] = o.lensRotation;
    // Camera motion: the shutter-open pose's corner rays (92, 108) and lens frame (124), from a camera like the
    // engine's at that pose.
    let cameraMotion = false;
    const pc = o.previousCamera;
    if (pc && o.shutter > 0) {
      const prev = new Camera({
        fov: pc.fov ?? camera.fov,
        position: pc.position,
        target: pc.target,
        near: camera.near,
        far: camera.far,
      });
      prev.up = pc.up ?? camera.up;
      prev.project = camera.project;
      try {
        prev.update(image[0] / image[1], true);
        cameraMotion = this.#pose(prev, f, 92, 108, 124);
        f[127] = o.focusDistance ?? f[127];
      } catch {
        cameraMotion = false; // a view parallel to `up`: no camera motion
      }
    }
    u.set(image, 32);
    u.set(tile, 36);
    const e = s.environment,
      sunOn = e.sun[0] + e.sun[1] + e.sun[2] > 0,
      env = e.map;
    let flags = (jitter ? FLAG_JITTER : 0) | (split ? FLAG_SPLIT : 0);
    if (sunOn) flags |= FLAG_SUN;
    if (e.ground) flags |= FLAG_GROUND;
    if (env) flags |= FLAG_ENV;
    if ((s.moving || cameraMotion) && o.shutter > 0) flags |= FLAG_MOTION;
    // Projection: mode (0 camera, 1 panorama, 2 fisheye), fisheye mapping, distortion on; fov and sin(fov / 4);
    // the Brown-Conrady coefficients.
    const fov = (o.fisheye.fov * Math.PI) / 180,
      dist = o.projection === 'camera' ? o.distortion : undefined;
    u.set(
      [
        o.projection === 'camera' ? 0 : o.projection === 'panorama' ? 1 : 2,
        o.fisheye.mapping === 'equisolid' ? 1 : 0,
        dist && (dist.k1 || dist.k2 || dist.p1 || dist.p2) ? 1 : 0,
        0,
      ],
      140,
    );
    f.set([fov, Math.sin(fov / 4), 0, 0], 144);
    f.set(dist ? [dist.k1, dist.k2, dist.p1, dist.p2] : [0, 0, 0, 0], 148);
    if (cameraMotion) flags |= FLAG_CAMERA_MOTION;
    if (o.clamp < Infinity) flags |= FLAG_CLAMP;
    if (s.lightPower > 0) flags |= FLAG_AREA;
    if (s.clearGlass && o.transparentShadows) flags |= FLAG_CLEAR_GLASS;
    if (!o.transparentShadows) flags |= FLAG_OPAQUE_SHADOWS;
    if (!o.sunSpecular) flags |= FLAG_SUN_DIFFUSE;
    if (!o.sunInMedia) flags |= FLAG_NO_SUN_MEDIA;
    if (!e.sunVisible) flags |= FLAG_HIDE_SUN;
    if (!o.energyCompensation) flags |= FLAG_NO_COMPENSATION;
    u.set([o.maxBounces, seed >>> 0, flags, s.lightCount], 40);
    const caps = o.bounceLimits;
    u.set(caps ? [caps.diffuse, caps.specular, caps.scatter] : [BOUNCE_FREE, BOUNCE_FREE, BOUNCE_FREE], 152);
    f[155] = e.groundFade;
    // Uniform fog: extinction, anisotropy, on; colour; the glow's hemisphere table.
    const fog = e.fog;
    f.set(fog ? [fog.density, fog.anisotropy, 1, 0] : [0, 0, 0, 0], 156);
    f.set(fog ? [fog.color[0], fog.color[1], fog.color[2], 0] : [0, 0, 0, 0], 160);
    f.set(fog ? fog.hemisphere : new Float32Array(16), 164);
    f.set([e.groundFadeStart, e.fadeModels ? 1 : 0, 0, 0], 180);
    // Background, edge bands, grid lines (MagicaVoxel's display settings).
    // A transparent render's camera rays that leave the scene add nothing (alpha comes from the coverage kernel).
    const bg = transparent ? [0, 0, 0] : e.background,
      ed = o.edges,
      gr = o.grid;
    f.set(bg ? [bg[0], bg[1], bg[2], 1] : [0, 0, 0, 0], 184);
    f.set(ed ? [ed.color[0], ed.color[1], ed.color[2], ed.width] : [0, 0, 0, 0], 188);
    f.set(gr ? [gr.color[0], gr.color[1], gr.color[2], gr.spacing] : [0, 0, 0, 1], 192);
    f.set(gr ? [gr.width, gr.onVoxels ? 2 : 1, 0, 0] : [0, 0, 0, 0], 196);
    const sl = layout.scene,
      ll = layout.lights;
    u.set([sl.modelBase, sl.instanceBase, sl.nodeBase, s.instances.length ? sl.nodeCount : 0], 44);
    u.set([s.emissiveInstances.length, ll.emissiveBase, ll.areaBase, 0], 48);
    f[51] = wavelength; // fixed wavelength of dispersive glass, 0 to sample the spectrum
    u.set([env?.width ?? 0, env?.height ?? 0, ll.marginalBase, ll.conditionalBase], 52);
    f.set([e.sky[0], e.sky[1], e.sky[2], env?.intensity ?? 0], 56);
    const half = e.sunAngularSize / 2,
      solid = half > 0 ? 2 * Math.PI * (1 - Math.cos(half)) : 0,
      scale = half > 0 ? 1 / (Math.PI * Math.sin(half) ** 2) : 1;
    f.set([e.sunDirection[0], e.sunDirection[1], e.sunDirection[2], half > 0 ? Math.cos(half) : 1], 60);
    f.set([e.sun[0] * scale, e.sun[1] * scale, e.sun[2] * scale, solid], 64);
    f.set([e.ground?.[0] ?? 0, e.ground?.[1] ?? 0, e.ground?.[2] ?? 0, e.groundHeight], 68);
    f.set([env?.integral ?? 0, env?.rotation ?? 0, o.shutter, o.clamp < Infinity ? o.clamp : 0], 72);
    device.queue.writeBuffer(target, 0, this.#frame);
    return true;
  }

  // Denoiser levels: tile size, a-trous step, last-level flag; edge-stopping strengths; where the tile lies in the
  // image and the camera's corner rays (from the last #writeFrame) to place first hits in the world.
  #denoiseParams(
    device: GPUDevice,
    t: Targets,
    samples: number,
    tile: readonly [number, number, number, number],
    history = 0,
  ): boolean {
    const data = new ArrayBuffer(PARAM_STRIDE * DENOISE_PASSES),
      u = new Uint32Array(data),
      f = new Float32Array(data);
    for (let k = 0; k < DENOISE_PASSES; k++) {
      const at = (k * PARAM_STRIDE) / 4,
        caustic = k > ATROUS,
        level = caustic ? k - ATROUS : k,
        last = k === ATROUS || k === ATROUS + CAUSTIC_LEVELS;
      // Flags: 1 last level, 2 a caustic chain (prepare splits it off, combine adds it), 4 no plane test (rays not the
      // camera's corner-ray interpolation).
      const flat = this.#settings.projection !== 'camera' || this.#settings.distortion !== undefined;
      // 8 and up: the viewport's history (prepare and combine), never with flat rays.
      const keep = flat ? 0 : history;
      u.set(
        [
          t.width,
          t.height,
          k === 0 ? 0 : 1 << (level - 1),
          (last ? 1 : 0) |
            (t.caustics && (k === 0 || k === DENOISE_PASSES - 1) ? 2 : 0) |
            (flat ? 4 : 0) |
            (k === 0 || k === DENOISE_PASSES - 1 ? keep : 0),
        ],
        at,
      );
      // Edge stops: luminance difference over LUMINANCE_SIGMA (CAUSTIC_SIGMA) standard deviations of the difference
      // (widened at low sample counts in the shader), normal cosine^128, plane distance over a footprint.
      f.set([caustic ? CAUSTIC_SIGMA : LUMINANCE_SIGMA, 128, 1, 1 / samples], at + 4);
      u.set(tile, at + 8);
      f.set(this.#corners, at + 12);
      // The previous viewport frame: view-projection and corner rays (prepare reprojects into them).
      f.set(this.#history.matrix, at + 44);
      f.set(this.#history.corners, at + 60);
    }
    device.queue.writeBuffer(t.params!, 0, data);
    return history !== 0 && this.#settings.projection === 'camera' && this.#settings.distortion === undefined;
  }

  #encodeDenoise(gpu: Gpu, encoder: GPUCommandEncoder, t: Targets): void {
    const p = gpu.pipelines!,
      pass = encoder.beginComputePass(),
      x = Math.ceil(t.width / 8),
      y = Math.ceil(t.height / 8);
    for (let k = 0; k < DENOISE_PASSES; k++) {
      const group = t.denoiseGroups![k];
      if (!group) continue;
      pass.setPipeline(k === 0 ? p.prepare : k === DENOISE_PASSES - 1 ? p.combine : p.atrous);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, y);
    }
    pass.end();
  }

  // The display pipeline for this target (format, samples, depth), compiled asynchronously: undefined until ready.
  #display(gpu: Gpu, c: Context): GPURenderPipeline | undefined {
    const samples = c.descriptor.multisample?.count ?? 1,
      depth = c.descriptor.depthStencil?.format ?? 'depth32float',
      key = `${c.format}|${samples}|${depth}`;
    let entry = gpu.display.get(key);
    if (!entry) {
      const device = gpu.device,
        module = device.createShaderModule({ code: DISPLAY }),
        pending: { pipeline?: GPURenderPipeline } = {};
      gpu.display.set(key, (entry = pending));
      device
        .createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.displayLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: c.format }] },
          primitive: { topology: 'triangle-list' },
          depthStencil: { format: depth, depthWriteEnabled: true, depthCompare: 'always' },
          multisample: { count: samples },
        })
        .then(
          (pipeline) => {
            pending.pipeline = pipeline;
          },
          (error) => this.#engine?.onError(error),
        );
    }
    return entry.pipeline;
  }

  // samplesPerFrame 'auto': the display interval is the fastest recent frame; the count grows by a quarter after four
  // frames in a row keep that pace (a frame's cost shows in the frame time a few frames late). A frame that misses it
  // (over 1.6 intervals) caps the count for 120 frames at 80% of what fits an interval at that frame's cost per sample,
  // so the viewport misses about one frame every two seconds while probing.
  #pace(ms: number): void {
    this.#interval = this.#interval > 0 ? Math.min(this.#interval * 1.01, ms) : ms;
    const pace = Math.min(50, Math.max(4, this.#interval));
    if (ms > pace * 1.6) {
      this.#cap = Math.max(1, Math.min(Math.floor(this.#auto * 0.8), Math.floor((this.#auto * 0.8 * pace) / ms)));
      this.#auto = this.#cap;
      this.#hold = 120;
      this.#streak = 0;
      return;
    }
    if (this.#hold > 0 && --this.#hold === 0) this.#cap = 64;
    this.#streak = ms <= pace * 1.2 ? this.#streak + 1 : 0;
    if (this.#streak >= 4) {
      this.#auto = Math.min(this.#cap, Math.ceil(this.#auto * 1.25));
      this.#streak = 0;
    }
  }

  // Accumulation key: scene, settings, size and every camera value a ray depends on.
  #moved(c: Context, width: number, height: number): boolean {
    const k = this.#key,
      cam = c.camera,
      values = [this.#version, width, height, ...cam.matrix, ...cam.position, ...cam.target, ...cam.up];
    let changed = false;
    for (let i = 0; i < values.length; i++)
      if (!Object.is(k[i], values[i])) {
        k[i] = values[i];
        changed = true;
      }
    return changed;
  }

  #execute(c: Context): void {
    const gpu = this.#state(c.device);
    if ((!gpu.pipelines && !gpu.preview) || gpu.lost) return;
    this.#syncScene(gpu);
    const o = this.#settings,
      limit = Math.floor(gpu.device.limits.maxStorageBufferBindingSize / 16);
    let width = Math.max(1, Math.round(c.width * o.resolutionScale)),
      height = Math.max(1, Math.round(c.height * o.resolutionScale));
    if (width * height > limit) {
      const k = Math.sqrt(limit / (width * height));
      width = Math.max(1, Math.floor(width * k));
      height = Math.max(1, Math.floor(height * k));
    }
    const pipeline = this.#display(gpu, c);
    if (!pipeline) return;
    const device = gpu.device;
    let view = gpu.view;
    if (!view) {
      const frame = this.#buffer(gpu, FRAME_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        uniform = this.#buffer(gpu, VIEW_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      view = gpu.view = {
        ...this.#targets(gpu, undefined, width, height, o.denoise !== false, this.#snapshot.focusing, true),
        frame,
        uniform,
        denoisedAt: -1,
      };
    } else
      Object.assign(view, this.#targets(gpu, view, width, height, o.denoise !== false, this.#snapshot.focusing, true));
    if (this.#moved(c, width, height) || (gpu.pipelines && this.#previewing)) {
      this.#samples = 0;
      this.#restarted = true;
      // The denoised image is stale even when the new accumulation reaches the same sample count.
      view.denoisedAt = -1;
    }
    this.#previewing = !gpu.pipelines;
    this.#width = width;
    this.#height = height;
    const key = `${gpu.resources}`;
    if (view.traceKey !== key) {
      view.traceGroup = this.#traceGroup(gpu, view.frame, view);
      const group = (color: GPUBuffer) =>
        device.createBindGroup({
          layout: gpu.displayLayout,
          entries: [
            { binding: 0, resource: { buffer: view!.uniform } },
            { binding: 1, resource: { buffer: color } },
            { binding: 2, resource: { buffer: view!.albedo } },
          ],
        });
      view.displayRaw = group(view.accum);
      view.displayDenoised = view.pong ? group(view.pong) : undefined;
      view.displayResolved = view.ping ? group(view.ping) : undefined;
      view.traceKey = key;
      view.denoisedAt = -1;
    }
    if (this.#previewing) {
      // Until the full tracer is compiled: one preview sample per frame, written over the image.
      if (
        !this.#writeFrame(
          device,
          view.frame,
          c.camera,
          [width, height, 0, 0],
          [width, height, 0, 1],
          o.seed,
          true,
          false,
          gpu.layout!,
          this.#snapshot,
        )
      )
        return;
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(gpu.preview!);
      pass.setBindGroup(0, view.traceGroup!);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      this.#samples = 1;
    } else if (!this.#capturing && this.#samples < o.maxSamples) {
      const count = Math.min(
        o.samplesPerFrame === 'auto' ? this.#auto : o.samplesPerFrame,
        o.maxSamples - this.#samples,
      );
      if (
        !this.#writeFrame(
          device,
          view.frame,
          c.camera,
          [width, height, 0, 0],
          [width, height, this.#samples, count],
          // With the denoiser's history every camera draws its own sample sequence (the history averages frames, which
          // must not repeat one sequence); a camera's sequence stays the same, so equal inputs still give equal images.
          o.denoise !== false ? (o.seed ^ cameraHash(c.camera.matrix)) >>> 0 : o.seed,
          true,
          view.caustics !== undefined,
          gpu.layout!,
          this.#snapshot,
        )
      )
        return;
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(gpu.pipelines!.trace);
      pass.setBindGroup(0, view.traceGroup!);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      this.#samples += count;
      const now = performance.now();
      if (this.#lastTrace) {
        this.#frameMs = now - this.#lastTrace;
        if (o.samplesPerFrame === 'auto') this.#pace(this.#frameMs);
      }
      this.#lastTrace = now;
    } else this.#lastTrace = 0;
    if (!this.#samples) return;
    const denoised = !this.#previewing && o.denoise !== false && view.denoiseGroups !== undefined;
    // 'auto': every frame while the image is sparse, then as the samples grow by a quarter, and at convergence.
    const due =
      o.denoise === true ||
      view.denoisedAt <= 0 ||
      this.#samples < 32 ||
      this.#samples >= view.denoisedAt * 1.25 ||
      this.#samples >= o.maxSamples;
    if (denoised && view.denoisedAt !== this.#samples && due) {
      // History: kept by the viewport (8); used (16) when only the camera changed since it was written; 64 the
      // accumulation restarted (the camera moved).
      const h = this.#history,
        reuse = h.valid && h.version === this.#version && h.width === width && h.height === height;
      view.resolved = this.#denoiseParams(
        device,
        view,
        this.#samples,
        [0, 0, width, height],
        8 | (reuse ? 16 : 0) | (this.#restarted ? 64 : 0),
      );
      h.matrix.set(c.camera.matrix);
      h.corners.set(this.#corners);
      h.version = this.#version;
      h.width = width;
      h.height = height;
      h.valid = true;
      this.#restarted = false;
      this.#encodeDenoise(gpu, c.encoder, view);
      view.denoisedAt = this.#samples;
    }
    const v = this.#view,
      inverse = this.#inverse;
    if (!invertMatrix(c.camera.matrix, inverse)) return;
    v.set(c.camera.matrix, 0);
    v.set(inverse, 16);
    v.set([width, height, c.width, c.height], 32);
    const mode =
      (c.format === 'rgba16float' ? 1 : 0) |
      (o.toneMapping === 'linear' ? 2 : 0) |
      (o.toneMapping === 'aces-narkowicz' ? 4 : 0);
    // First-hit depth only where pixels are the camera's own perspective rays (far otherwise).
    const depth = o.projection === 'camera' && !o.distortion ? 1 / this.#samples : 0;
    v.set([denoised ? 1 : 1 / this.#samples, 2 ** o.exposure, mode, depth], 36);
    v.set([o.gamma ?? 0, o.vignette, 0, 0], 40);
    device.queue.writeBuffer(view.uniform, 0, v);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, denoised ? (view.resolved ? view.displayResolved! : view.displayDenoised!) : view.displayRaw!);
    pass.draw(3);
    pass.end();
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const job = this.#job.then(
      () => run(),
      () => run(),
    );
    this.#job = job.catch(() => {});
    return job;
  }

  #renderOptions(
    options: VoxelTraceRenderOptions | VoxelTraceCaptureOptions,
    maxPixels: number,
  ): {
    width: number;
    height: number;
    samples: number;
    denoise: boolean;
    jitter: boolean;
    seed: number;
    wavelength: number;
    transparent: boolean;
    signal?: AbortSignal;
  } {
    this.#alive();
    if (!options || typeof options !== 'object')
      throw new TypeError('VoxelPathTracer render options must be {width, height, samples}');
    const width = whole(options.width, 'width', 1, 16384, 'pass the image width in pixels'),
      height = whole(options.height, 'height', 1, 16384, 'pass the image height in pixels'),
      samples = whole(options.samples, 'samples', 1, 1 << 20, 'pass samples per pixel, 1 or more');
    if (width * height > maxPixels)
      throw new RangeError(`VoxelPathTracer ${width}x${height} is over ${maxPixels} pixels; render a smaller image`);
    const r = options as VoxelTraceRenderOptions,
      denoise = r.denoise === undefined ? this.#settings.denoise !== false : flag(r.denoise, 'denoise'),
      jitter = r.jitter === undefined ? true : flag(r.jitter, 'jitter'),
      seed = r.seed === undefined ? this.#settings.seed : whole(r.seed, 'seed', 0, 0xffffffff, 'pass an integer seed'),
      transparent = r.transparent === undefined ? false : flag(r.transparent, 'transparent'),
      wavelength =
        r.wavelength === undefined
          ? 0
          : checkNumber(r.wavelength, 'wavelength', LAMBDA_MIN, LAMBDA_MAX, 'pass nanometres, 380 to 780');
    if (r.signal !== undefined && !(r.signal instanceof AbortSignal))
      throw new TypeError('VoxelPathTracer signal must be an AbortSignal');
    aborted(r.signal);
    return { width, height, samples, denoise, jitter, seed, wavelength, transparent, signal: r.signal };
  }

  // Renders tiles band by band and hands each band (rows y0..y0+rows) to `consume`.
  async #render(
    o: {
      width: number;
      height: number;
      samples: number;
      denoise: boolean;
      jitter: boolean;
      seed: number;
      wavelength: number;
      transparent: boolean;
      signal?: AbortSignal;
    },
    aovs: boolean,
    consume: (
      y0: number,
      rows: number,
      band: {
        color: Float32Array;
        albedo?: Float32Array;
        normal?: Float32Array;
        depth?: Float32Array;
        ids?: Float32Array;
        alpha?: Float32Array;
      },
    ) => Promise<void>,
  ): Promise<void> {
    this.#alive();
    if (this.#status === 'compiling') await this.#ready;
    this.#alive();
    const gpu = this.#gpu;
    if (!gpu?.pipelines)
      throw new MargoError('state', 'VoxelPathTracer is not attached to a WebGPU engine; attach it first');
    const device = gpu.device,
      engineCamera = this.#engine!.camera,
      camera = new Camera({
        fov: engineCamera.fov,
        position: engineCamera.position,
        target: engineCamera.target,
        near: engineCamera.near,
        far: engineCamera.far,
      });
    camera.up = engineCamera.up;
    camera.project = engineCamera.project;
    camera.update(o.width / o.height, true);
    this.#syncScene(gpu);
    const snapshot = this.#snapshot,
      layout = gpu.layout!,
      storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      created: GPUBuffer[] = [],
      make = (size: number, usage: number) => {
        const b = this.#buffer(gpu, size, usage);
        created.push(b);
        return b;
      };
    let targets: Targets | undefined;
    this.#capturing++;
    try {
      // Private copies of the scene buffers: setScene during the render cannot change what it traces.
      const copies = {} as SceneBuffers,
        encoder = device.createCommandEncoder();
      for (const key of ['materials', 'voxels', 'scene', 'lights', 'env'] as const) {
        const source = gpu.buffers[key],
          usage = key === 'materials' ? GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST : storage;
        copies[key] = make(source.size, usage);
        encoder.copyBufferToBuffer(source, 0, copies[key], 0, source.size);
      }
      device.queue.submit([encoder.finish()]);
      const multi = o.width > TILE || o.height > TILE,
        apron = o.denoise && multi ? APRON : 0,
        tw = Math.min(o.width, TILE) + 2 * apron,
        th = Math.min(o.height, TILE) + 2 * apron,
        frame = make(FRAME_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        bytes = tw * th * 16,
        // Colour; with AOVs albedo and normals; with a transparent denoised render the accumulation (alpha in w).
        staging = [0, ...(aovs ? [1, 2] : []), ...(o.transparent && o.denoise ? [3] : [])].map(() =>
          make(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        ),
        coverage = o.transparent
          ? await (gpu.coverage ??= device.createComputePipelineAsync({
              layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.traceLayout] }),
              compute: { module: gpu.traceModule!, entryPoint: 'coverage' },
            }))
          : undefined;
      let group: GPUBindGroup | undefined,
        submitted = 0;
      const check = () => {
        aborted(o.signal);
        this.#alive();
        if (gpu.lost || this.#gpu !== gpu)
          throw new MargoError('failed', 'VoxelPathTracer lost its GPU device during the render; render again');
      };
      for (let y0 = 0; y0 < o.height; y0 += TILE) {
        const rows = Math.min(TILE, o.height - y0),
          band = {
            color: new Float32Array(o.width * rows * 3),
            albedo: aovs ? new Float32Array(o.width * rows * 3) : undefined,
            normal: aovs ? new Float32Array(o.width * rows * 3) : undefined,
            depth: aovs ? new Float32Array(o.width * rows) : undefined,
            ids: aovs ? new Float32Array(o.width * rows) : undefined,
            alpha: o.transparent ? new Float32Array(o.width * rows) : undefined,
          };
        for (let x0 = 0; x0 < o.width; x0 += TILE) {
          const cols = Math.min(TILE, o.width - x0),
            rx0 = Math.max(0, x0 - apron),
            ry0 = Math.max(0, y0 - apron),
            rx1 = Math.min(o.width, x0 + cols + apron),
            ry1 = Math.min(o.height, y0 + rows + apron),
            w = rx1 - rx0,
            h = ry1 - ry0;
          if (!targets || targets.width !== w || targets.height !== h) {
            this.#releaseTargets(targets);
            targets = this.#targets(gpu, undefined, w, h, o.denoise, snapshot.focusing);
            group = this.#traceGroup(gpu, frame, targets, copies);
          }
          const batch = Math.max(1, Math.min(16, Math.floor((1 << 20) / (w * h))));
          for (let s = 0; s < o.samples; s += batch) {
            check();
            const count = Math.min(batch, o.samples - s);
            this.#writeFrame(
              device,
              frame,
              camera,
              [o.width, o.height, rx0, ry0],
              [w, h, s, count],
              o.seed,
              o.jitter,
              targets.caustics !== undefined,
              layout,
              snapshot,
              o.wavelength,
              o.transparent,
            );
            const e = device.createCommandEncoder(),
              pass = e.beginComputePass();
            pass.setPipeline(gpu.pipelines.trace);
            pass.setBindGroup(0, group!);
            pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
            pass.end();
            device.queue.submit([e.finish()]);
            if (++submitted % 4 === 0) await device.queue.onSubmittedWorkDone();
          }
          check();
          const e = device.createCommandEncoder();
          // The denoiser reads the normals' w (share of first-hit features) before the id pass overwrites it.
          if (o.denoise) {
            this.#denoiseParams(device, targets, o.samples, [rx0, ry0, o.width, o.height]);
            this.#encodeDenoise(gpu, e, targets);
          }
          if (aovs || coverage) {
            this.#writeFrame(
              device,
              frame,
              camera,
              [o.width, o.height, rx0, ry0],
              [w, h, 0, 1],
              o.seed,
              false,
              targets.caustics !== undefined,
              layout,
              snapshot,
              0,
              o.transparent,
            );
            for (const pipeline of [aovs ? gpu.pipelines.ids : undefined, coverage]) {
              if (!pipeline) continue;
              const pass = e.beginComputePass();
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, group!);
              pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
              pass.end();
            }
          }
          const size = w * h * 16;
          e.copyBufferToBuffer(o.denoise ? targets.pong! : targets.accum, 0, staging[0], 0, size);
          if (aovs) {
            e.copyBufferToBuffer(targets.albedo, 0, staging[1], 0, size);
            e.copyBufferToBuffer(targets.normals, 0, staging[2], 0, size);
          }
          if (o.transparent && o.denoise) e.copyBufferToBuffer(targets.accum, 0, staging[staging.length - 1], 0, size);
          device.queue.submit([e.finish()]);
          const maps = staging.map((b) => b.mapAsync(GPUMapMode.READ, 0, size));
          try {
            await Promise.all(maps);
          } catch (error) {
            check();
            throw new MargoError(
              'failed',
              `VoxelPathTracer could not read the render back (${String(error)}); render again`,
            );
          }
          const read = (b: GPUBuffer) => new Float32Array(b.getMappedRange(0, size).slice(0)),
            c = read(staging[0]),
            a = aovs ? read(staging[1]) : undefined,
            n = aovs ? read(staging[2]) : undefined,
            coverageOf = o.transparent ? (o.denoise ? read(staging[staging.length - 1]) : c) : undefined;
          for (const b of staging) b.unmap();
          const scale = o.denoise ? 1 : 1 / o.samples;
          for (let y = 0; y < rows; y++)
            for (let x = 0; x < cols; x++) {
              const src = (y0 + y - ry0) * w + (x0 + x - rx0),
                dst = y * o.width + x0 + x;
              for (let k = 0; k < 3; k++) band.color[dst * 3 + k] = c[src * 4 + k] * scale;
              if (coverageOf) band.alpha![dst] = coverageOf[src * 4 + 3];
              if (a && n) {
                for (let k = 0; k < 3; k++) {
                  band.albedo![dst * 3 + k] = a[src * 4 + k] / o.samples;
                  band.normal![dst * 3 + k] = n[src * 4 + k] / o.samples;
                }
                const inv = a[src * 4 + 3] / o.samples;
                band.depth![dst] = inv > 0 ? 1 / inv : Infinity;
                band.ids![dst] = n[src * 4 + 3];
              }
            }
        }
        check();
        await consume(y0, rows, band);
      }
    } finally {
      this.#capturing--;
      this.#releaseTargets(targets);
      for (const b of created) this.#destroy(b);
    }
  }
}
