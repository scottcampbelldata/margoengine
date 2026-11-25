// Film frames from sub-frames: N renders of every frame, each at its own shutter time and sub-pixel offset, averaged
// in linear light by an Accumulate stage (@margoengine/post/accumulate) and read back once. Clean room from:
// - The Accumulation Buffer, Haeberli and Akeley, SIGGRAPH 1990, https://doi.org/10.1145/97879.97913 (jittered and
//   time-offset renders summed, then shown once);
// - Distributed Ray Tracing, Cook, Porter and Carpenter, SIGGRAPH 1984, https://doi.org/10.1145/800031.808590 (one
//   time sample a sub-frame spread over the open shutter gives motion blur of everything that moves);
// - Filter Importance Sampling, Ernst, Stamminger and Greiner, IEEE RT 2006, https://doi.org/10.1109/RT.2006.280223
//   (offsets drawn from the pixel filter, all weights equal);
// - Practical Hash-based Owen Scrambling, Burley, JCGT 2020, https://jcgt.org/published/0009/04/01/ (scrambled
//   2D Sobol points, and space shuffled against time so the two do not correlate).
import { Camera, type Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { readPixels, type HeadlessPixels } from './index.js';
import { readTexture, type HDRPixels } from './formats.js';
import type { FrameTiming } from './video.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** The pixel filter sub-pixel offsets are drawn from. */
export type PixelFilter = 'blackman-harris' | 'gaussian' | 'box';

/** Where the open shutter sits against the frame's time. */
export type ShutterPhase = 'start' | 'center' | 'end';

/** Options of {@link subFrames}. */
export interface SubFrameOptions {
  /** How many frames, a whole number from 1. Required. */
  frames: number;
  /** Frames per second, finite and above 0. Default 30. */
  fps?: number;
  /** Renders per frame, a whole number in 1..4096. Default 16. */
  samples?: number;
  /** Share of the frame interval the shutter is open, in [0, 1]: 0.5 is a 180 degree shutter, 0 a still instant.
   * Default 0.5. */
  shutter?: number;
  /** Where the open shutter sits: from the frame's time (`'start'`), around it, or up to it. Default `'start'`. */
  shutterPhase?: ShutterPhase;
  /** Filter the offsets are drawn from. Default `'blackman-harris'`. */
  filter?: PixelFilter;
  /** Filter width in pixels, finite and above 0. Default 1 for `'box'`, else 2. */
  filterWidth?: number;
  /** Seed of the sample pattern, a 32-bit unsigned integer. Default 0. */
  seed?: number;
  /** `'fixed'` uses one pattern on every frame, so still edges do not shimmer; `'per-frame'` draws a new one each
   * frame. Default `'fixed'`. */
  pattern?: 'fixed' | 'per-frame';
}

/** One render of {@link subFrames}. */
export interface SubFrame {
  /** The frame it belongs to, from 0. */
  frame: number;
  /** From 0 to `samples - 1`, in time order. */
  sample: number;
  /** Seconds: `frame / fps` plus its place in the open shutter. */
  time: number;
  /** Seconds since the render before: 0 on the first. Within a frame the step between shutter times, from one frame
   * to the next the rest of the interval; the steps add up to the frame interval. */
  delta: number;
  /** Sub-pixel offset `[x, y]` in pixels, x right and y down, inside the filter's width. */
  offset: readonly [number, number];
  /** True on the frame's last render, after which the frame is finished. */
  last: boolean;
}

const MAX_SAMPLES = 4096;

function reverse(x: number): number {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
  x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}

/** Burley 2020 section 4: a nested uniform scramble of bit-reversed `x` by a hash, as a permutation of 32 bits. */
function laineKarras(x: number, seed: number): number {
  x = (x + seed) >>> 0;
  x = (x ^ Math.imul(x, 0x6c50b47c)) >>> 0;
  x = (x ^ Math.imul(x, 0xb82f1e52)) >>> 0;
  x = (x ^ Math.imul(x, 0xc7afe638)) >>> 0;
  x = (x ^ Math.imul(x, 0x8d22f6e6)) >>> 0;
  return x;
}
const owen = (x: number, seed: number): number => reverse(laineKarras(reverse(x), seed));

function hash(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Sobol dimension 2 (primitive polynomial x + 1, direction numbers v_k = v_(k-1) ^ v_(k-1) >> 1), as 32 bits. */
function sobol2(index: number): number {
  let result = 0;
  for (let v = 0x80000000; index; index >>>= 1, v ^= v >>> 1) if (index & 1) result ^= v;
  return result >>> 0;
}

const unit = (bits: number): number => bits / 2 ** 32;

/** The 1D filter's inverse CDF on [0, 1), tabulated: separable filters share it for x and y. */
function inverseCDF(filter: PixelFilter, width: number): (u: number) => number {
  if (filter === 'box') return (u) => (u - 0.5) * width;
  const bins = 512,
    cdf = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) {
    // t in [0, 1] across the support.
    const t = (i + 0.5) / bins;
    let w: number;
    if (filter === 'gaussian') {
      // Six standard deviations across the width; the tails outside are cut.
      const x = (t - 0.5) * 6;
      w = Math.exp(-0.5 * x * x);
    } else {
      // Blackman-Harris 4-term (Harris 1978), zero at both ends of the support.
      const a = 2 * Math.PI * t;
      w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    }
    cdf[i + 1] = cdf[i] + w;
  }
  const total = cdf[bins];
  for (let i = 1; i <= bins; i++) cdf[i] /= total;
  return (u) => {
    let low = 0,
      high = bins;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (cdf[mid] <= u) low = mid;
      else high = mid;
    }
    const span = cdf[high] - cdf[low],
      t = (low + (span > 0 ? (u - cdf[low]) / span : 0.5)) / bins;
    return (t - 0.5) * width;
  };
}

function check(options: SubFrameOptions) {
  const {
    frames,
    fps = 30,
    samples = 16,
    shutter = 0.5,
    shutterPhase = 'start',
    filter = 'blackman-harris',
    seed = 0,
    pattern = 'fixed',
  } = options;
  const filterWidth = options.filterWidth ?? (filter === 'box' ? 1 : 2);
  if (!Number.isInteger(frames) || frames < 1) throw rangeError('Invalid frame count', 'headless');
  if (!(fps > 0) || !Number.isFinite(fps)) throw rangeError('Invalid fps', 'headless');
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES)
    throw rangeError(`Sub-frame samples must be a whole number in 1..${MAX_SAMPLES}`, 'headless');
  if (!(shutter >= 0 && shutter <= 1)) throw rangeError('Shutter must be in [0, 1] of the frame interval', 'headless');
  if (shutterPhase !== 'start' && shutterPhase !== 'center' && shutterPhase !== 'end')
    throw typeError("Shutter phase: 'start', 'center' or 'end'", 'headless');
  if (filter !== 'blackman-harris' && filter !== 'gaussian' && filter !== 'box')
    throw typeError("Pixel filter: 'blackman-harris', 'gaussian' or 'box'", 'headless');
  if (!(filterWidth > 0) || !Number.isFinite(filterWidth))
    throw rangeError('Filter width must be finite and above 0 pixels', 'headless');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw rangeError('Seed must be a 32-bit unsigned integer', 'headless');
  if (pattern !== 'fixed' && pattern !== 'per-frame') throw typeError("Pattern: 'fixed' or 'per-frame'", 'headless');
  return { frames, fps, samples, shutter, shutterPhase, filter, filterWidth, seed, pattern };
}

/**
 * The renders of a film sequence, in order: for each frame, `samples` shutter times spread evenly over the open
 * shutter (one in the middle of each of `samples` equal slices, ascending), each with a sub-pixel offset drawn from
 * the pixel filter (scrambled Sobol points, shuffled against the time order). Pure and repeatable for one seed.
 * `samples: 1` gives a zero offset, and with `shutter: 0` `renderFrames`' times and deltas exactly.
 * @throws RangeError or TypeError for an option out of its documented range.
 */
export function* subFrames(options: SubFrameOptions): Generator<SubFrame, void, void> {
  const o = check(options),
    invert = inverseCDF(o.filter, o.filterWidth),
    phase = o.shutterPhase === 'start' ? 0 : o.shutterPhase === 'center' ? -o.shutter / 2 : -o.shutter,
    order = new Uint32Array(o.samples),
    offsets: [number, number][] = [];
  // Seconds into the frame of sample k, the same for every frame.
  const within = Float64Array.from({ length: o.samples }, (_, k) =>
    o.shutter === 0 ? 0 : (phase + (o.shutter * (k + 0.5)) / o.samples) / o.fps,
  );
  let previousFrame = -1,
    previousWithin = 0;
  for (let frame = 0; frame < o.frames; frame++) {
    if (frame === 0 || o.pattern === 'per-frame') {
      const seed = o.pattern === 'fixed' ? o.seed : hash(o.seed ^ hash(frame + 1));
      // A shuffle of the points against time (Fisher-Yates on a hashed stream), so offset order and time order are
      // independent; every point is still used once a frame.
      for (let k = 0; k < o.samples; k++) order[k] = k;
      for (let k = o.samples - 1, state = hash(seed ^ 0x9e3779b9); k > 0; k--) {
        state = hash(state + k);
        const j = state % (k + 1),
          t = order[k];
        order[k] = order[j];
        order[j] = t;
      }
      offsets.length = 0;
      const sx = hash(seed ^ 0x68bc21eb),
        sy = hash(seed ^ 0x02e5be93);
      for (let k = 0; k < o.samples; k++) {
        if (o.samples === 1) {
          offsets.push([0, 0]);
          continue;
        }
        const i = order[k];
        offsets.push([invert(unit(owen(reverse(i), sx))), invert(unit(owen(sobol2(i), sy)))]);
      }
    }
    for (let sample = 0; sample < o.samples; sample++) {
      const delta = previousFrame < 0 ? 0 : (frame - previousFrame) / o.fps + (within[sample] - previousWithin);
      previousFrame = frame;
      previousWithin = within[sample];
      yield {
        frame,
        sample,
        time: frame / o.fps + within[sample],
        delta: delta < 0 ? 0 : delta,
        offset: offsets[sample],
        last: sample === o.samples - 1,
      };
    }
  }
}

/** The part of an Accumulate stage {@link renderAccumulated} drives; `@margoengine/post/accumulate` has it. */
export interface AccumulateTarget {
  /** Starts a new sum. */
  begin(): void;
  /** The running mean in linear light, read for `output: 'linear'`. */
  readonly texture?: GPUTexture;
  /** Number of frames added since `begin()`. */
  readonly count: number;
}

/** What `update` is given before each render: the render's own time, and which frame and sample it is. */
export interface SubFrameTiming extends FrameTiming {
  /** From 0 to `samples - 1`, in time order. */
  sample: number;
  /** Renders per frame. */
  samples: number;
}

/** Options of {@link renderAccumulated}. */
export interface RenderAccumulatedOptions extends SubFrameOptions {
  /** Camera to render through; it is not modified. Default the engine's camera. */
  camera?: Camera;
  /** Runs before each render; move the scene to `timing.time` here. May be async. Default none. */
  update?: (timing: SubFrameTiming) => unknown;
  /** The Accumulate stage in the engine's PostStack, before Tonemap. Default a new `Accumulate` attached alone (it
   * shows the mean through the display curve), loaded from the optional peer `@margoengine/post` on first use and
   * disposed when the sequence ends. */
  accumulate?: AccumulateTarget;
  /** `'display'` yields 8-bit RGBA as `readPixels` reads the canvas; `'linear'` yields float RGBA of the mean in
   * linear light, for `encodeEXR`. Default `'display'`. */
  output?: 'display' | 'linear';
  /** Stops the sequence between renders or during readback; the iterator rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** A frame of {@link renderAccumulated}: its pixels and where it sits, with `renderFrames`' frame timing. */
export type AccumulatedFrame<P> = P & FrameTiming;

const active = new WeakSet<Engine>();

async function loadAccumulate(engine: Engine): Promise<AccumulateTarget & { dispose(): void }> {
  let module: typeof import('@margoengine/post/accumulate');
  try {
    module = await import('@margoengine/post/accumulate');
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND')
      throw Object.assign(fault('state', 'Install @margoengine/post', 'install'), { cause: error });
    throw error;
  }
  return module.Accumulate.attach(engine);
}

export function renderAccumulated(
  engine: Engine,
  options: RenderAccumulatedOptions & { output: 'linear' },
): AsyncGenerator<AccumulatedFrame<HDRPixels>, void, void>;
export function renderAccumulated(
  engine: Engine,
  options: RenderAccumulatedOptions & { output?: 'display' },
): AsyncGenerator<AccumulatedFrame<HeadlessPixels>, void, void>;
/**
 * Renders a film sequence on a headless engine, `samples` renders a frame averaged in linear light: antialiased
 * by the pixel filter and motion-blurred over the open shutter, for everything that moves (cameras, skinned and
 * morphed meshes, particles, wind), since each render is the scene at its own time. The tone curve is applied once,
 * to the average. Each frame is read back once, after its last render; the next is not drawn until the consumer asks.
 * Time is the sequence's own: the same options give the same frames on any machine. The jitter is applied to a copy of
 * the camera, so effects with their own jitter (TAA not in `velocityOnly` mode) must be off.
 * @throws RangeError or TypeError for an option out of range (before any render); MargoError `'state'` when another
 * accumulated or tiled render runs on this engine, or with `output: 'linear'` before the stage has a texture,
 * `'unsupported'` without WebGPU.
 */
export async function* renderAccumulated(
  instance: Engine,
  options: RenderAccumulatedOptions,
): AsyncGenerator<AccumulatedFrame<HeadlessPixels | HDRPixels>, void, void> {
  const { update, signal, output = 'display' } = options;
  if (output !== 'display' && output !== 'linear') throw typeError("Output: 'display' or 'linear'", 'headless');
  const settings = check(options);
  signal?.throwIfAborted();
  const engine = engineRuntime(instance);
  if (!engine.gpu) throw fault('unsupported', 'Accumulated rendering requires WebGPU', 'headless');
  if (active.has(engine)) throw fault('state', 'An accumulated render is already active on this engine', 'headless');
  active.add(engine);
  let owned: (AccumulateTarget & { dispose(): void }) | undefined;
  try {
    const target = options.accumulate ?? (owned = await loadAccumulate(instance)),
      source = options.camera ?? engine.camera,
      shot = new Camera(source),
      offset = [0, 0];
    shot.update = (aspect, webgpu) => {
      Camera.prototype.update.call(shot, aspect, webgpu);
      // A clip-space shift of the full view-projection by the offset in pixels (x right, y down). The culling planes
      // stay those of the unshifted view: conservative within a pixel.
      const { width, height } = engine.canvas,
        x = (2 * offset[0]) / width,
        y = (-2 * offset[1]) / height;
      for (let c = 0; c < 16; c += 4) {
        shot.matrix[c] += x * shot.matrix[c + 3];
        shot.matrix[c + 1] += y * shot.matrix[c + 3];
      }
    };
    for (const sub of subFrames(settings)) {
      signal?.throwIfAborted();
      if (sub.sample === 0) target.begin();
      await update?.({
        index: sub.frame,
        time: sub.time,
        delta: sub.delta,
        progress: sub.frame / settings.frames,
        sample: sub.sample,
        samples: settings.samples,
      });
      // The source camera may have moved in update: copy it for this render.
      shot.fov = source.fov;
      shot.near = source.near;
      shot.far = source.far;
      shot.position = source.position;
      shot.target = source.target;
      shot.up = source.up;
      shot.project = source.project;
      [offset[0], offset[1]] = sub.offset;
      engine.render({ camera: shot, delta: sub.delta });
      if (!sub.last) continue;
      const timing: FrameTiming = {
        index: sub.frame,
        time: sub.frame / settings.fps,
        delta: sub.frame ? 1 / settings.fps : 0,
        progress: sub.frame / settings.frames,
      };
      if (output === 'display') {
        yield { ...timing, ...(await readPixels(instance, { signal })) };
        continue;
      }
      const texture = target.texture;
      if (!texture) throw fault('state', 'The Accumulate stage has no texture; add it to the PostStack', 'headless');
      yield { ...timing, ...(await readTexture(instance, texture, { signal })) };
    }
  } finally {
    owned?.dispose();
    active.delete(engine);
  }
}
