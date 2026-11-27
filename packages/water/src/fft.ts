/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { fault } from '../../shared/errors.js';
import { group } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { applyView } from '../../shared/view-rect.js';
import { resolveMSAA } from '../../shared/msaa.js';
import { oceanCompute, oceanSurface } from './fft-shaders.js';
import { CpuOceanEvaluator, type OceanSample } from './fft-cpu.js';
export type { OceanSample } from './fft-cpu.js';
import { queryStates, surfacePasses } from './query-state.js';
import { unitLight } from '../../shared/unit-light.js';
import { linearHdr } from '../../shared/hdr-format.js';
declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  STORAGE: number;
  INDEX: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** A disjoint Fourier wavelength band. Lengths and wavelengths are metres. */
export interface OceanCascade {
  /** Periodic patch length, positive. */
  length: number;
  /** Longest included wavelength. Default the patch length. */
  maxWavelength?: number;
  /** Shortest included wavelength. Default twice the cell width. */
  minWavelength?: number;
}
/** Spectral ocean settings, copied at construction. All lengths are metres and time is seconds. */
export interface FFTOceanOptions {
  /** Fourier samples per axis, a power of two from 16 to 512. Default 128. */
  resolution?: number;
  /** One to four nonoverlapping wavelength bands. Default 512/64/8 metre patches. */
  cascades?: readonly OceanCascade[];
  /** Empirical wave spectrum. Default 'jonswap'. */
  spectrum?: 'phillips' | 'jonswap';
  /** Normalised internally; nonzero XZ direction. Default [1, 0.3]. */
  windDirection?: readonly [number, number];
  /** Wind speed at ten metres, 0.1..100 m/s. Default 10. */
  windSpeed?: number;
  /** Fetch for JONSWAP, 1..1e7 metres. Default 100000. */
  fetch?: number;
  /** JONSWAP peak enhancement, 1..10. Default 3.3. */
  peakEnhancement?: number;
  /** Spectral energy scale, 0..100. Default 1 for JONSWAP, 0.0005 for Phillips. */
  amplitude?: number;
  /** Horizontal displacement multiplier, 0..5. Default 1. */
  choppiness?: number;
  /** Reproducible integer seed, 0..16777215. Default 234. */
  seed?: number;
  /** Compression determinant below which foam forms, 0..1. Default 0.7. */
  foamThreshold?: number;
  /** Foam decay e-folding time, 0.01..60 seconds. Default 4. */
  foamLifetime?: number;
  /** Mean world Y. Default 0. */
  height?: number;
  /** Drawn square extent. Default 1024 metres. */
  size?: number;
  /** Draw grid cells per axis, 1..1024. Default 256. */
  segments?: number;
  /** Move the grid in whole cells with the camera. Default true. Waves stay world anchored. */
  followCamera?: boolean;
  /** Linear RGB water body colour, 0..1. Default [0.01, 0.18, 0.25]. */
  color?: readonly [number, number, number];
}
/** Immutable CPU copy of one GPU ocean frame. Read with FFTOcean.readFrame, never a second wave simulation. */
export interface OceanFrame {
  /** Exact evaluated simulation time. */
  readonly time: number;
  /** Mean world-space water height. */
  readonly height: number;
  /** Fourier grid side. */
  readonly resolution: number;
  /** Periodic patch lengths in cascade order. */
  readonly lengths: readonly number[];
  /** Twelve floats per point: displacement XYZ/foam, velocity XYZ/Jacobian, normal XYZ/unused. Cascade-major. */
  readonly data: Float32Array;
}
/** Wind settings for {@link FFTOcean.setWind}. Omitted optional fields keep their current values. */
export interface OceanWind {
  /** Wind speed at ten metres, 0.1..100 m/s. */
  speed: number;
  /** Fetch for JONSWAP, 1..1e7 metres. Omitted keeps the current fetch. */
  fetch?: number;
  /** Normalised internally; nonzero XZ direction. Omitted keeps the current direction. */
  direction?: readonly [number, number];
}
/** Surface shading mode for {@link FFTOcean.setDebug}. */
export type OceanDebugMode = 'off' | 'normals' | 'foam' | 'jacobian' | 'wireframe';
/** Debug visualization settings for {@link FFTOcean.setDebug}. */
export interface OceanDebugOptions {
  /** Enable or disable debug visualization. Default true when passing an options object. */
  enabled?: boolean;
  /** Shading overlay: 'off', 'normals', 'foam', 'jacobian', or 'wireframe'. Default 'normals'. */
  mode?: OceanDebugMode;
  /** Draw anti-aliased mesh wireframe lines. Default false (true when mode === 'wireframe'). */
  wireframe?: boolean;
  /** Draw concentric cascade patch-domain LOD rings. Default true when enabled. */
  lodRings?: boolean;
  /** World-space [x, z] sample points to mark on the surface (up to 16). */
  samplePoints?: readonly (readonly [number, number])[];
}
/** Maximum number of sample points rendered by {@link FFTOcean.setDebug}. */
export const MAX_OCEAN_DEBUG_POINTS = 16;
const DEBUG_MODES: Record<OceanDebugMode, number> = { off: 0, normals: 1, foam: 2, jacobian: 3, wireframe: 0 };
type OceanContext = Extract<PassContext, { backend: 'webgpu' }>;
type ComputeStep = { pipeline: GPUComputePipeline; bind: GPUBindGroup; count: number };
let sequence = 0;
/** A refusal of bad ocean input: a MargoError `unsupported` whose message names the fix and links to errors#ocean. */
const oceanError = (message: string) => fault('unsupported', message, 'ocean');
const positive = (value: number, min: number, max: number, name: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw oceanError(`Invalid ocean ${name}; pass a finite value in ${min}..${max}`);
  return value;
};

/**
 * GPU Tessendorf ocean with Phillips/JONSWAP spectra, disjoint cascades, choppy displacement and persistent folding foam.
 * The GPU creates and transforms every Fourier sample. No CPU transform or frame readback occurs while rendering.
 * @throws MargoError with a help link when disposed, attached twice, or attached to the small preview tier.
 */
export class FFTOcean implements EnginePlugin {
  readonly name = `fft-ocean-${sequence++}`;
  readonly resolution: number;
  readonly lengths: readonly number[];
  readonly height: number;
  private readonly size: number;
  private readonly segments: number;
  private readonly follow: boolean;
  private readonly config = new Float32Array(28);
  private readonly frame = new Float32Array(84);
  private readonly indices: Uint32Array;
  private engine?: Engine;
  private buffers: GPUBuffer[] = [];
  private configBuffer?: GPUBuffer;
  private frameBuffer?: GPUBuffer;
  private indexBuffer?: GPUBuffer;
  private result?: GPUBuffer;
  private initial?: ComputeStep;
  private steps: ComputeStep[] = [];
  private drawPipeline?: GPURenderPipeline;
  private drawBind?: GPUBindGroup;
  private drawKey = '';
  private initialized = false;
  private spectrumDirty = true;
  private spectrumVersion = 0;
  private cpu?: CpuOceanEvaluator;
  private debugState: {
    enabled: boolean;
    mode: OceanDebugMode;
    wireframe: boolean;
    lodRings: boolean;
    samplePoints: [number, number][];
  } = { enabled: false, mode: 'off', wireframe: false, lodRings: false, samplePoints: [] };
  private dirty = true;
  private disposed = false;
  private generation = 0;
  private renderedTime?: number;
  private reading = false;
  private elapsed = 0;
  private pendingDelta = 0;

  constructor(options: FFTOceanOptions = {}) {
    this.resolution = options.resolution ?? 128;
    if (
      !Number.isInteger(this.resolution) ||
      this.resolution < 16 ||
      this.resolution > 512 ||
      this.resolution & (this.resolution - 1)
    )
      throw oceanError('Invalid ocean resolution; pass a power of two from 16 to 512');
    const n = this.resolution;
    const cascades = options.cascades ?? [
      { length: 512, minWavelength: 64, maxWavelength: 512 },
      { length: 64, minWavelength: 8, maxWavelength: 64 },
      { length: 8, minWavelength: 16 / n, maxWavelength: 8 },
    ];
    if (cascades.length < 1 || cascades.length > 4)
      throw oceanError('Invalid ocean cascades; pass one to four wavelength bands');
    const bands = cascades.map((cascade) => {
      const length = positive(cascade.length, 0.01, 1000000, 'patch length');
      const min = positive(cascade.minWavelength ?? (2 * length) / n, (2 * length) / n, length, 'minimum wavelength');
      const max = positive(cascade.maxWavelength ?? length, min, length, 'maximum wavelength');
      if (min === max) throw oceanError('Empty ocean wavelength band; use minimum below maximum');
      return { length, min, max };
    });
    for (let i = 0; i < bands.length; i++)
      for (let j = 0; j < i; j++)
        if (Math.max(bands[i].min, bands[j].min) < Math.min(bands[i].max, bands[j].max))
          throw oceanError('Overlapping ocean cascade bands double wave energy; use disjoint wavelength ranges');
    this.lengths = Object.freeze(bands.map((band) => Math.fround(band.length)));
    const spectrum = options.spectrum ?? 'jonswap';
    if (spectrum !== 'jonswap' && spectrum !== 'phillips')
      throw oceanError("Invalid ocean spectrum; use 'jonswap' or 'phillips'");
    const direction = options.windDirection ?? [1, 0.3];
    const length = Math.hypot(...direction);
    if (direction.length !== 2 || !length || !Number.isFinite(length))
      throw oceanError('Invalid ocean wind direction; pass a finite nonzero XZ pair');
    const seed = positive(options.seed ?? 234, 0, 16777215, 'seed');
    if (!Number.isInteger(seed)) throw oceanError('Invalid ocean seed; pass an integer from 0 to 16777215');
    this.config.set([
      0,
      0,
      positive(options.choppiness ?? 1, 0, 5, 'choppiness'),
      positive(options.foamLifetime ?? 4, 0.01, 60, 'foam lifetime'),
    ]);
    this.config.set(
      [direction[0] / length, direction[1] / length, positive(options.windSpeed ?? 10, 0.1, 100, 'wind speed'), seed],
      4,
    );
    this.config.set(
      [
        spectrum === 'phillips' ? 0 : 1,
        positive(options.amplitude ?? (spectrum === 'phillips' ? 0.0005 : 1), 0, 100, 'amplitude'),
        positive(options.fetch ?? 100000, 1, 1e7, 'fetch'),
        positive(options.peakEnhancement ?? 3.3, 1, 10, 'peak enhancement'),
      ],
      8,
    );
    const threshold = positive(options.foamThreshold ?? 0.7, 0, 1, 'foam threshold');
    bands.forEach((band, i) =>
      this.config.set([band.length, (2 * Math.PI) / band.max, (2 * Math.PI) / band.min, threshold], 12 + i * 4),
    );
    this.height = Math.fround(positive(options.height ?? 0, -1e6, 1e6, 'height'));
    this.size = positive(options.size ?? 1024, 0.01, 1e6, 'size');
    this.segments = positive(options.segments ?? 256, 1, 1024, 'segments');
    if (!Number.isInteger(this.segments))
      throw oceanError('Invalid ocean segments; pass an integer from 1 to 1024');
    if (options.followCamera !== undefined && typeof options.followCamera !== 'boolean')
      throw oceanError('Invalid ocean followCamera; pass true or false');
    this.follow = options.followCamera ?? true;
    const color = options.color ?? [0.01, 0.18, 0.25];
    if (color.length !== 3)
      throw oceanError('Invalid ocean color; pass three linear RGB values from 0 to 1');
    color.forEach((v) => positive(v, 0, 1, 'color'));
    this.frame.set([this.height, 0, 0, 0], 32);
    this.frame.set([this.size, this.size, this.segments, 0], 36);
    this.frame.set(this.lengths, 40);
    this.frame.set(color, 44);
    this.indices = new Uint32Array(this.segments * this.segments * 6);
    queryStates.set(this, () =>
      this.disposed || !this.engine?.gpu || !this.frameBuffer || this.renderedTime === undefined
        ? undefined
        : {
            kind: 'fft',
            device: this.engine.gpu,
            token: this.frameBuffer,
            values: this.frame,
            time: this.renderedTime,
            shader: oceanSurface(this.resolution, this.lengths.length).split('struct SurfaceVertex')[0],
            segments: this.segments,
            resolution: this.resolution,
            lengths: this.lengths,
            field: this.result,
          },
    );
    for (let z = 0; z < this.segments; z++)
      for (let x = 0; x < this.segments; x++) {
        const a = z * (this.segments + 1) + x,
          b = a + this.segments + 1;
        this.indices.set([a, b, a + 1, a + 1, b, b + 1], (z * this.segments + x) * 6);
      }
  }
  /** Attach to a native WebGPU engine or the full WebGL2 compatibility layer. */
  static attach(engine: EngineKernel, options: FFTOceanOptions = {}): FFTOcean {
    const ocean = new FFTOcean(options);
    engineRuntime(engine).use(ocean);
    return ocean;
  }
  /** Evaluated time; setTime selects an absolute time for deterministic simulation and captures. */
  get time(): number {
    return this.elapsed;
  }
  /** Current wind settings (`speed` in m/s, `fetch` in m, normalised `direction` XZ). A copy. */
  get wind(): Readonly<Required<OceanWind>> {
    return Object.freeze({
      speed: this.config[6]!,
      fetch: this.config[10]!,
      direction: Object.freeze([this.config[4]!, this.config[5]!]) as readonly [number, number],
    });
  }
  /** Current horizontal choppiness multiplier (0..5). */
  get choppiness(): number {
    return this.config[2]!;
  }
  /** Current Jacobian compression foam threshold (0..1). */
  get foamThreshold(): number {
    return this.config[15]!;
  }
  /** Current debug visualization settings. A copy. */
  get debug(): Readonly<{
    enabled: boolean;
    mode: OceanDebugMode;
    wireframe: boolean;
    lodRings: boolean;
    samplePoints: readonly (readonly [number, number])[];
  }> {
    return Object.freeze({
      enabled: this.debugState.enabled,
      mode: this.debugState.mode,
      wireframe: this.debugState.wireframe,
      lodRings: this.debugState.lodRings,
      samplePoints: Object.freeze(this.debugState.samplePoints.map((p) => Object.freeze([p[0], p[1]]) as readonly [number, number])),
    });
  }
  /**
   * Retune the ocean spectrum live without recreating the ocean or allocating new GPU buffers.
   * Accepts a wind speed in m/s (0.1..100) or `{ speed, fetch?, direction? }` (omitted fields keep their current
   * values). Rebuilds the GPU seed spectrum on the next render while preserving foam history and device-restore state.
   * @throws MargoError `'disposed'` after disposal; MargoError `'unsupported'` (errors#ocean) for invalid input.
   */
  setWind(wind: number | OceanWind): this {
    this.live();
    if (typeof wind !== 'number' && (typeof wind !== 'object' || wind === null))
      throw oceanError('Invalid ocean wind; pass a wind speed in 0.1..100 m/s or { speed, fetch?, direction? }');
    const input: OceanWind = typeof wind === 'number' ? { speed: wind } : wind;
    const speed = positive(input.speed, 0.1, 100, 'wind speed');
    const fetch = input.fetch !== undefined ? positive(input.fetch, 1, 1e7, 'fetch') : this.config[10]!;
    let dirX = this.config[4]!,
      dirZ = this.config[5]!;
    if (input.direction !== undefined) {
      if (
        !Array.isArray(input.direction) ||
        input.direction.length !== 2 ||
        typeof input.direction[0] !== 'number' ||
        typeof input.direction[1] !== 'number'
      )
        throw oceanError('Invalid ocean wind direction; pass a finite nonzero XZ pair');
      const length = Math.hypot(input.direction[0], input.direction[1]);
      if (!length || !Number.isFinite(length))
        throw oceanError('Invalid ocean wind direction; pass a finite nonzero XZ pair');
      dirX = input.direction[0] / length;
      dirZ = input.direction[1] / length;
    }
    const nextDirX = Math.fround(dirX),
      nextDirZ = Math.fround(dirZ),
      nextSpeed = Math.fround(speed),
      nextFetch = Math.fround(fetch);
    if (
      nextDirX !== this.config[4] ||
      nextDirZ !== this.config[5] ||
      nextSpeed !== this.config[6] ||
      nextFetch !== this.config[10]
    ) {
      this.config[4] = nextDirX;
      this.config[5] = nextDirZ;
      this.config[6] = nextSpeed;
      this.config[10] = nextFetch;
      this.spectrumDirty = true;
      this.spectrumVersion++;
      this.dirty = true;
    }
    return this;
  }
  /** Set horizontal displacement choppiness (0..5) live without rebuilding the spectrum. */
  setChoppiness(choppiness: number): this {
    this.live();
    const next = Math.fround(positive(choppiness, 0, 5, 'choppiness'));
    if (next !== this.config[2]) {
      this.config[2] = next;
      this.dirty = true;
    }
    return this;
  }
  /** Set the Jacobian compression threshold below which whitecap foam forms (0..1) live. */
  setFoamThreshold(threshold: number): this {
    this.live();
    const next = Math.fround(positive(threshold, 0, 1, 'foam threshold'));
    if (next !== this.config[15]) {
      for (let i = 0; i < this.lengths.length; i++) this.config[15 + i * 4] = next;
      this.dirty = true;
    }
    return this;
  }
  /** Set the linear RGB water body colour (0..1 per channel) live. */
  setColor(color: readonly [number, number, number]): this {
    this.live();
    if (!Array.isArray(color) || color.length !== 3)
      throw oceanError('Invalid ocean color; pass three linear RGB values from 0 to 1');
    const r = positive(color[0], 0, 1, 'color'),
      g = positive(color[1], 0, 1, 'color'),
      b = positive(color[2], 0, 1, 'color');
    this.frame[44] = r;
    this.frame[45] = g;
    this.frame[46] = b;
    return this;
  }
  /**
   * Configure the GPU debug visualization overlay: mesh wireframe, cascade LOD rings, wave normals,
   * Jacobian foam mask, and up to 16 world XZ sample-point markers. Pass `false` to disable all overlays.
   */
  setDebug(options: boolean | OceanDebugOptions): this {
    this.live();
    if (typeof options !== 'boolean' && (typeof options !== 'object' || options === null))
      throw oceanError('Invalid ocean debug options; pass a boolean or { enabled?, mode?, wireframe?, lodRings?, samplePoints? }');
    const cfg: OceanDebugOptions = typeof options === 'boolean' ? { enabled: options } : options;
    const enabled = cfg.enabled ?? true;
    if (typeof enabled !== 'boolean')
      throw oceanError('Invalid ocean debug enabled; pass true or false');
    const mode: OceanDebugMode = cfg.mode ?? (enabled ? (cfg.wireframe ? 'wireframe' : 'normals') : 'off');
    if (!(mode in DEBUG_MODES))
      throw oceanError("Invalid ocean debug mode; use 'off', 'normals', 'foam', 'jacobian', or 'wireframe'");
    const wireframe = cfg.wireframe ?? mode === 'wireframe';
    if (typeof wireframe !== 'boolean')
      throw oceanError('Invalid ocean debug wireframe; pass true or false');
    const lodRings = cfg.lodRings ?? enabled;
    if (typeof lodRings !== 'boolean')
      throw oceanError('Invalid ocean debug lodRings; pass true or false');
    const points: [number, number][] = [];
    if (cfg.samplePoints !== undefined) {
      if (!Array.isArray(cfg.samplePoints) || cfg.samplePoints.length > MAX_OCEAN_DEBUG_POINTS)
        throw oceanError(`Invalid ocean debug samplePoints; pass an array of at most ${MAX_OCEAN_DEBUG_POINTS} [x, z] pairs`);
      for (const pt of cfg.samplePoints) {
        if (!Array.isArray(pt) || pt.length !== 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1]))
          throw oceanError('Invalid ocean debug sample point; pass finite [x, z] coordinates');
        points.push([pt[0], pt[1]]);
      }
    }
    this.debugState = {
      enabled,
      mode: enabled ? mode : 'off',
      wireframe: enabled && wireframe,
      lodRings: enabled && lodRings,
      samplePoints: enabled ? points : [],
    };
    this.frame[48] = this.debugState.enabled ? DEBUG_MODES[this.debugState.mode] : 0;
    this.frame[49] = this.debugState.wireframe ? 1 : 0;
    this.frame[50] = this.debugState.lodRings ? 1 : 0;
    this.frame[51] = this.debugState.samplePoints.length;
    this.frame.fill(0, 52, 84);
    for (let i = 0; i < this.debugState.samplePoints.length; i++) {
      this.frame[52 + i * 2] = this.debugState.samplePoints[i]![0];
      this.frame[52 + i * 2 + 1] = this.debugState.samplePoints[i]![1];
    }
    return this;
  }
  /**
   * Synchronously evaluates the FFT ocean surface (height, displacement, unit normal, velocity, Jacobian and
   * instantaneous foam) at world `(x, z)` and time `time` (default `ocean.time`), using a cached CPU spectral
   * 2D IFFT evaluator with zero async GPU readback.
   */
  sample(x: number, z: number, time?: number): OceanSample {
    this.live();
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z))
      throw oceanError('Invalid ocean sample coordinates; pass finite world XZ metres');
    const t = time !== undefined ? positive(time, 0, 1e7, 'time') : this.elapsed;
    this.cpu ??= new CpuOceanEvaluator(this.resolution, this.lengths.length);
    return this.cpu.sample(this.config, this.spectrumVersion, this.lengths, this.height, x, z, Math.fround(t));
  }
  /** Convenience synchronous CPU height query at world `(x, z)` and time `time` (default `ocean.time`). */
  sampleHeight(x: number, z: number, time?: number): number {
    return this.sample(x, z, time).height;
  }
  /** Select absolute seconds. Foam history resets when seeking backwards; forward seeks decay over the full interval. */
  setTime(seconds: number): this {
    this.live();
    positive(seconds, 0, 1e7, 'time');
    if (seconds < this.elapsed) this.initialized = false;
    this.pendingDelta += Math.max(0, seconds - this.elapsed);
    this.elapsed = seconds;
    this.dirty = true;
    return this;
  }
  /**
   * Puts the wave clock back to 0 with no span owed, and starts the foam history again at the next draw, as a fresh
   * ocean has them, so a later `seek` (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock) gives
   * what a fresh world seeked there gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.live();
    this.elapsed = 0;
    this.pendingDelta = 0;
    this.initialized = false;
    this.dirty = true;
  }
  /**
   * Moves the wave clock by `delta` seconds without drawing (a delta of 0 or less moves nothing); each frame update runs
   * it, so `seek` from `@margoengine/cutscene/seek` replays the waves exactly. Foam is history on the GPU: a replayed
   * span decays it over the whole span at the next draw, as a forward `setTime` does.
   */
  advanceTime(delta: number): void {
    this.live();
    if (delta > 0) this.setTime(this.elapsed + delta);
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Ocean already attached; create another FFTOcean', 'state');
    if (!engine.gpu)
      throw fault(
        'unsupported',
        'FFT ocean needs WebGPU or the full WebGL2 compatibility layer; use automatic escalation',
        'webgpu',
      );
    this.engine = engine;
    const device = engine.gpu;
    const make = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage });
      this.buffers.push(buffer);
      return buffer;
    };
    const count = this.resolution ** 2 * this.lengths.length;
    this.configBuffer = make(this.config.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.frameBuffer = make(this.frame.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.indexBuffer = make(this.indices.byteLength, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.indexBuffer, 0, this.indices as Uint32Array<ArrayBuffer>);
    const seed = make(count * 16, GPUBufferUsage.STORAGE);
    const a = make(count * 48, GPUBufferUsage.STORAGE);
    const b = make(count * 48, GPUBufferUsage.STORAGE);
    this.result = make(count * 48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const module = device.createShaderModule({ code: oceanCompute(this.resolution, this.lengths.length) });
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    const init = pipeline('initial'),
      evolve = pipeline('evolve'),
      fft = pipeline('butterfly'),
      finish = pipeline('finish');
    // Auto layouts drop unused declarations; binding numbers remain explicit.
    const stepGroup = (pipeline: GPUComputePipeline, input: GPUBuffer, output: GPUBuffer, step?: GPUBuffer) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...(pipeline === fft ? [] : [{ binding: 0, resource: { buffer: this.configBuffer! } }]),
          { binding: 1, resource: { buffer: input } },
          { binding: 2, resource: { buffer: output } },
          ...(step ? [{ binding: 3, resource: { buffer: step } }] : []),
        ],
      });
    this.initial = {
      pipeline: init,
      count,
      bind: device.createBindGroup({
        layout: init.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.configBuffer } },
          { binding: 2, resource: { buffer: seed } },
        ],
      }),
    };
    this.steps = [{ pipeline: evolve, bind: stepGroup(evolve, seed, a), count }];
    let input = a,
      output = b;
    for (let axis = 0; axis < 2; axis++)
      for (let stage = 0; stage < Math.log2(this.resolution); stage++) {
        const step = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(step, 0, new Uint32Array([stage, axis, 0, 0]));
        this.steps.push({ pipeline: fft, bind: stepGroup(fft, input, output, step), count: count * 3 });
        [input, output] = [output, input];
      }
    this.steps.push({ pipeline: finish, bind: stepGroup(finish, input, this.result), count });
    this.initialized = false;
    this.spectrumDirty = true;
    this.dirty = true;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: `${this.name}:surface`,
      order: 4,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private draw(c: OceanContext): void {
    if (this.disposed) return;
    if (this.dirty) {
      this.config[0] = this.elapsed;
      this.config[1] = this.pendingDelta;
      c.device.queue.writeBuffer(this.configBuffer!, 0, this.config);
      if (!this.initialized) {
        // clearBuffer also resets retained foam after a backwards seek or fresh setup.
        c.encoder.clearBuffer(this.result!);
      }
      if (!this.initialized || this.spectrumDirty) {
        const initPass = c.encoder.beginComputePass();
        initPass.setPipeline(this.initial!.pipeline);
        initPass.setBindGroup(0, this.initial!.bind);
        initPass.dispatchWorkgroups(Math.ceil(this.initial!.count / 64));
        initPass.end();
      }
      for (const step of this.steps) {
        const compute = c.encoder.beginComputePass();
        compute.setPipeline(step.pipeline);
        compute.setBindGroup(0, step.bind);
        compute.dispatchWorkgroups(Math.ceil(step.count / 64));
        compute.end();
      }
      this.initialized = true;
      this.spectrumDirty = false;
      this.dirty = false;
      this.renderedTime = this.config[0];
      this.pendingDelta = 0;
    }
    resolveMSAA(c);
    const samples = c.descriptor.multisample?.count ?? 1;
    const depthFormat = c.descriptor.depthStencil?.format ?? 'depth24plus';
    const key = `${c.format}/${samples}/${depthFormat}`;
    if (key !== this.drawKey) {
      const hdr = linearHdr(c.format);
      const code =
        displayShader +
        `\nfn surfaceDisplay(value:vec3f)->vec3f { return ${hdr ? 'value' : 'toDisplay(value)'}; }\n` +
        oceanSurface(this.resolution, this.lengths.length);
      const module = c.device.createShaderModule({ code });
      this.drawPipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      });
      this.drawBind = group(c.device, this.drawPipeline, [{ buffer: this.frameBuffer! }, { buffer: this.result! }]);
      this.drawKey = key;
    }
    const light = this.engine!.lighting;
    this.frame.set(c.camera.matrix, 0);
    this.frame.set(c.camera.position, 16);
    unitLight(this.frame, 20, light.direction);
    this.frame.set(light.radiance, 24);
    this.frame.set([light.radiance[3], light.radiance[3], light.radiance[3], 0], 28);
    const cell = this.size / this.segments;
    this.frame[34] = this.follow ? Math.round(c.camera.position[0] / cell) * cell : 0;
    this.frame[35] = this.follow ? Math.round(c.camera.position[2] / cell) * cell : 0;
    c.device.queue.writeBuffer(this.frameBuffer!, 0, this.frame);
    const readyPasses = surfacePasses.get(this);
    if (readyPasses) for (const entry of readyPasses) entry.draw(c);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
    });
    pass.setPipeline(this.drawPipeline!);
    pass.setBindGroup(0, this.drawBind!);
    pass.setIndexBuffer(this.indexBuffer!, 'uint32');
    applyView(pass, c);
    pass.drawIndexed(this.indices.length);
    pass.end();
  }
  /**
   * Copy the last submitted rendered frame to CPU. No implicit render or simulation step. One read at a time.
   * AbortSignal cancels the wait; disposal/restoration invalidate outstanding copies with a coded error.
   */
  async readFrame(options: { signal?: AbortSignal } = {}): Promise<OceanFrame> {
    this.live();
    options.signal?.throwIfAborted();
    if (!this.engine?.gpu || this.renderedTime === undefined) throw fault('state', 'Render the ocean before readFrame');
    if (this.reading) throw fault('state', 'An ocean readFrame is pending; await it before reading again');
    this.reading = true;
    const generation = this.generation,
      device = this.engine.gpu,
      time = this.renderedTime;
    const size = this.resolution ** 2 * this.lengths.length * 48;
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const abort = () => staging.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.result!, 0, staging, 0, size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      options.signal?.throwIfAborted();
      this.live();
      if (generation !== this.generation)
        throw fault('state', 'Ocean device restored during readFrame; render and read again');
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      return Object.freeze({ time, height: this.height, resolution: this.resolution, lengths: this.lengths, data });
    } catch (error) {
      options.signal?.throwIfAborted();
      this.live();
      if (generation !== this.generation)
        throw fault('state', 'Ocean device restored during readFrame; render and read again');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      staging.destroy();
      this.reading = false;
    }
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Ocean disposed; create a new FFTOcean');
  }
  private release(): void {
    this.generation++;
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers = [];
    this.steps = [];
    this.result = undefined;
    this.renderedTime = undefined;
    this.drawPipeline = undefined;
    this.drawBind = undefined;
    this.drawKey = '';
  }
  /** Detach the pass and destroy all owned buffers. Borrowed engine resources are untouched. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cpu = undefined;
    this.release();
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
