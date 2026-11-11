/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/audio/spectrogram: offline short-time Fourier analysis of a whole sample array. Clean room, from the
// papers only: J. B. Allen and L. R. Rabiner, "A Unified Approach to Short-Time Fourier Analysis and Synthesis", Proc.
// IEEE 65(11), 1977 (framing, weighted overlap-add synthesis); F. J. Harris, "On the Use of Windows for Harmonic Analysis
// with the Discrete Fourier Transform", Proc. IEEE 66(1), 1978 (the windows); D. W. Griffin and J. S. Lim, "Signal
// Estimation from Modified Short-Time Fourier Transform", IEEE TASSP 32(2), 1984 (phase from magnitude by alternating
// projections); N. Perraudin, P. Balazs and P. L. Sondergaard, "A Fast Griffin-Lim Algorithm", WASPAA 2013 (the
// momentum step); J. W. Cooley and J. W. Tukey, Math. Comput. 19(90), 1965 (the FFT in spectrogram-fft.ts).
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { ComputeContext } from '@margoengine/compute';
import { fftPlan, inverseRealPair, realPair, type FftPlan } from './spectrogram-fft.js';
import { type WindowName, windowOf, windows } from './spectrogram-windows.js';

export { windows };
export type { WindowName };

/** Options for `stft`. */
export interface StftOptions {
  /** Samples per second, kept on the result. Default 44100. */
  readonly sampleRate?: number;
  /** Frame length, a power of two from 32 to 65536. Default 2048. */
  readonly size?: number;
  /** Samples between frame starts, 1 to `size`. Default `size / 4`. */
  readonly hop?: number;
  /** A window name, or `size` coefficients. Default `'hann'`. */
  readonly window?: WindowName | ArrayLike<number>;
  /** Centre frame k on sample k * hop by padding `size / 2` samples each side. Default true. */
  readonly center?: boolean;
  /** What the centre padding holds: `'reflect'` (default), `'zero'` or `'edge'`. */
  readonly pad?: 'reflect' | 'zero' | 'edge';
  /** Stops the work between frames; the call throws the signal's reason. */
  readonly signal?: AbortSignal;
}

/** `stft` options that run the transforms on the GPU (through `@margoengine/compute/fft`, loaded then). */
export interface StftGpuOptions extends StftOptions {
  /** A compute context. Resolves a promise instead of returning at once. Output agrees with the CPU path within 1e-4 of the peak. */
  readonly gpu: ComputeContext;
}

/** A short-time spectrum: `frames` rows of `bins = size / 2 + 1` complex values, row-major. */
export interface Spectrum {
  readonly real: Float32Array;
  readonly imag: Float32Array;
  readonly frames: number;
  readonly bins: number;
  readonly size: number;
  readonly hop: number;
  readonly sampleRate: number;
  readonly center: boolean;
  /** Samples analysed (before padding): the default length of `istft`. */
  readonly length: number;
  /** The window coefficients used (`size` values). */
  readonly window: Float64Array;
}

const fail = (message: string): never => {
  throw rangeError(message, 'state');
};
const MAX_CELLS = 2 ** 27;

interface Plan {
  readonly size: number;
  readonly hop: number;
  readonly window: Float64Array;
  readonly center: boolean;
  readonly sampleRate: number;
  readonly frames: number;
  readonly bins: number;
  readonly pad: 'reflect' | 'zero' | 'edge';
}

function planOf(length: number, o: StftOptions): Plan {
  const size = o.size ?? 2048,
    hop = o.hop ?? Math.max(1, size / 4),
    center = o.center ?? true,
    sampleRate = o.sampleRate ?? 44100,
    pad = o.pad ?? 'reflect';
  if (!Number.isInteger(size) || size < 32 || size > 65536 || (size & (size - 1)) !== 0)
    fail(`STFT size must be a power of two from 32 to 65536, got ${size}`);
  if (!Number.isInteger(hop) || hop < 1 || hop > size)
    fail(`STFT hop must be a whole number from 1 to size (${size}), got ${hop}`);
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate))
    fail(`Sample rate must be a positive number, got ${sampleRate}`);
  if (pad !== 'reflect' && pad !== 'zero' && pad !== 'edge')
    fail(`Unknown pad "${String(pad)}"; use reflect, zero or edge`);
  if (length < 1) fail('STFT needs at least one sample');
  if (!center && length < size)
    fail(`Without centring the signal needs at least size (${size}) samples, got ${length}`);
  const frames = center ? 1 + Math.floor(length / hop) : 1 + Math.floor((length - size) / hop),
    bins = size / 2 + 1;
  if (frames * bins > MAX_CELLS)
    fail(`${frames} frames of ${bins} bins is over ${MAX_CELLS} values; use a larger hop or a shorter signal`);
  return { size, hop, window: windowOf(o.window, size), center, sampleRate, frames, bins, pad };
}

function samplesOf(samples: ArrayLike<number>): ArrayLike<number> {
  if (samples === null || typeof samples !== 'object' || typeof samples.length !== 'number')
    throw typeError('Samples must be a Float32Array, Float64Array or array of numbers', 'state');
  for (let i = 0; i < samples.length; i++)
    if (!Number.isFinite(samples[i])) fail(`Sample ${i} is ${samples[i]}; samples must be finite numbers`);
  return samples;
}

const fold = (i: number, n: number): number => {
  if (n === 1) return 0;
  const period = 2 * (n - 1),
    r = ((i % period) + period) % period;
  return r < n ? r : period - r;
};

// The signal as the frames see it: padded by size / 2 each side when centred.
function padded(samples: ArrayLike<number>, plan: Plan): Float64Array {
  const n = samples.length,
    before = plan.center ? plan.size / 2 : 0,
    out = new Float64Array(plan.center ? n + plan.size : n);
  for (let i = 0; i < out.length; i++) {
    const j = i - before;
    if (j >= 0 && j < n) out[i] = samples[j];
    else if (plan.pad === 'reflect') out[i] = samples[fold(j, n)];
    else if (plan.pad === 'edge') out[i] = samples[j < 0 ? 0 : n - 1];
  }
  return out;
}

// Frame transforms of one plan and their scratch memory.
class Engine {
  readonly fft: FftPlan;
  readonly bins: number;
  readonly span: number;
  readonly inverseEnvelope: Float64Array;
  readonly #a: Float64Array;
  readonly #b: Float64Array;
  readonly #zr: Float64Array;
  readonly #zi: Float64Array;
  readonly #aRe: Float64Array;
  readonly #aIm: Float64Array;
  readonly #bRe: Float64Array;
  readonly #bIm: Float64Array;

  constructor(
    readonly size: number,
    readonly hop: number,
    readonly window: Float64Array,
    readonly frames: number,
  ) {
    this.fft = fftPlan(size);
    this.bins = size / 2 + 1;
    this.span = (frames - 1) * hop + size;
    this.#a = new Float64Array(size);
    this.#b = new Float64Array(size);
    this.#zr = new Float64Array(size);
    this.#zi = new Float64Array(size);
    this.#aRe = new Float64Array(this.bins);
    this.#aIm = new Float64Array(this.bins);
    this.#bRe = new Float64Array(this.bins);
    this.#bIm = new Float64Array(this.bins);
    // The weighted overlap-add normaliser 1 / sum of squared windows (Allen and Rabiner); 0 where no window reaches.
    const envelope = new Float64Array(this.span);
    for (let f = 0; f < frames; f++) for (let i = 0; i < size; i++) envelope[f * hop + i] += window[i] * window[i];
    this.inverseEnvelope = envelope.map((e) => (e > 1e-12 ? 1 / e : 0));
  }

  analyse(
    x: ArrayLike<number>,
    re: Float32Array | Float64Array,
    im: Float32Array | Float64Array,
    signal?: AbortSignal,
  ) {
    const { size, hop, window, frames, bins } = this;
    for (let f = 0; f < frames; f += 2) {
      signal?.throwIfAborted();
      const second = f + 1 < frames;
      for (let i = 0; i < size; i++) {
        this.#a[i] = x[f * hop + i] * window[i];
        this.#b[i] = second ? x[(f + 1) * hop + i] * window[i] : 0;
      }
      realPair(this.fft, this.#a, this.#b, this.#zr, this.#zi, this.#aRe, this.#aIm, this.#bRe, this.#bIm);
      for (let k = 0; k < bins; k++) {
        re[f * bins + k] = this.#aRe[k];
        im[f * bins + k] = this.#aIm[k];
        if (second) {
          re[(f + 1) * bins + k] = this.#bRe[k];
          im[(f + 1) * bins + k] = this.#bIm[k];
        }
      }
    }
  }

  synthesise(re: ArrayLike<number>, im: ArrayLike<number>, y: Float64Array, signal?: AbortSignal) {
    const { size, hop, window, frames, bins } = this;
    y.fill(0);
    for (let f = 0; f < frames; f += 2) {
      signal?.throwIfAborted();
      const second = f + 1 < frames;
      for (let k = 0; k < bins; k++) {
        this.#aRe[k] = re[f * bins + k];
        this.#aIm[k] = im[f * bins + k];
        this.#bRe[k] = second ? re[(f + 1) * bins + k] : 0;
        this.#bIm[k] = second ? im[(f + 1) * bins + k] : 0;
      }
      inverseRealPair(this.fft, this.#aRe, this.#aIm, this.#bRe, this.#bIm, this.#zr, this.#zi, this.#a, this.#b);
      for (let i = 0; i < size; i++) {
        y[f * hop + i] += this.#a[i] * window[i];
        if (second) y[(f + 1) * hop + i] += this.#b[i] * window[i];
      }
    }
    for (let i = 0; i < y.length; i++) y[i] *= this.inverseEnvelope[i];
  }
}

/**
 * The reconstruction conditioning of a window at a hop: the smallest over the largest of the steady-state sum of
 * squared windows `sum_k w[r + k hop]^2`, r in [0, hop). 1 is perfect constant overlap-add; `istft` and `resynthesize`
 * refuse a ratio under 0.1 (Hann at hop 3/4 of its size gives 0.04, at hop 1/2 gives 0.5, at 1/4 gives 1).
 */
export function overlapRatio(window: ArrayLike<number>, hop: number): number {
  let min = Infinity,
    max = 0;
  for (let r = 0; r < Math.min(hop, window.length); r++) {
    let sum = 0;
    for (let i = r; i < window.length; i += hop) sum += window[i] * window[i];
    min = Math.min(min, sum);
    max = Math.max(max, sum);
  }
  return max > 0 ? min / max : 0;
}

function checkOverlap(window: ArrayLike<number>, hop: number): void {
  const ratio = overlapRatio(window, hop);
  if (!(ratio >= 0.1))
    throw fault(
      'state',
      `Window and hop do not overlap-add evenly (smallest over largest summed squared window is ${ratio.toFixed(3)}, needs 0.1); use a hop of size / 4 or size / 2 with a Hann window`,
    );
}

/**
 * Short-time Fourier transform of `samples`: `frames` windowed frames of `size` samples, `hop` apart, each transformed to
 * `size / 2 + 1` bins. Pass `gpu` (a compute context) to transform frames in batches on the GPU; that returns a promise.
 * @example const spec = stft(samples, { sampleRate: 48000, size: 2048 }); // spec.real, spec.imag
 */
export function stft(samples: ArrayLike<number>, options?: StftOptions): Spectrum;
export function stft(samples: ArrayLike<number>, options: StftGpuOptions): Promise<Spectrum>;
export function stft(
  samples: ArrayLike<number>,
  options: StftOptions | StftGpuOptions = {},
): Spectrum | Promise<Spectrum> {
  const x = samplesOf(samples),
    plan = planOf(x.length, options),
    signal = options.signal,
    unrolled = padded(x, plan);
  signal?.throwIfAborted();
  const real = new Float32Array(plan.frames * plan.bins),
    imag = new Float32Array(plan.frames * plan.bins),
    spec: Spectrum = {
      real,
      imag,
      frames: plan.frames,
      bins: plan.bins,
      size: plan.size,
      hop: plan.hop,
      sampleRate: plan.sampleRate,
      center: plan.center,
      length: x.length,
      window: plan.window,
    };
  if ('gpu' in options && options.gpu) return gpuTransform(options.gpu, unrolled, plan, spec, signal);
  new Engine(plan.size, plan.hop, plan.window, plan.frames).analyse(unrolled, real, imag, signal);
  return spec;
}

// Frames in batches through compute/fft (Stockham, f32); the first size / 2 + 1 bins of each row are kept.
async function gpuTransform(gpu: ComputeContext, x: Float64Array, plan: Plan, spec: Spectrum, signal?: AbortSignal) {
  const { fft } = await import('@margoengine/compute/fft');
  const { size, hop, window, bins } = plan,
    batch = Math.max(1, Math.floor(2 ** 22 / size));
  for (let first = 0; first < plan.frames; first += batch) {
    signal?.throwIfAborted();
    const count = Math.min(batch, plan.frames - first),
      data = new Float32Array(count * size);
    for (let f = 0; f < count; f++)
      for (let i = 0; i < size; i++) data[f * size + i] = x[(first + f) * hop + i] * window[i];
    using input = gpu.array(data, { shape: [count, size] });
    const { re, im } = fft(input);
    try {
      const [r, m] = await Promise.all([re.read({ signal }), im.read({ signal })]);
      for (let f = 0; f < count; f++)
        for (let k = 0; k < bins; k++) {
          spec.real[(first + f) * bins + k] = r[f * size + k];
          spec.imag[(first + f) * bins + k] = m[f * size + k];
        }
    } finally {
      re.dispose();
      im.dispose();
    }
  }
  return spec;
}

/** Options for `istft`. */
export interface IstftOptions {
  /** Samples to return. Default the analysed length (`spec.length`). */
  readonly length?: number;
  readonly signal?: AbortSignal;
}

/**
 * Inverse transform by weighted overlap-add: each frame's inverse FFT is multiplied by the window and added in place,
 * and the sum is divided by the sum of squared windows. Exact (to rounding) wherever a window reaches. Throws a coded
 * `state` error when the window and hop overlap too unevenly (see `overlapRatio`).
 * @example const same = istft(stft(samples)); // same[i] equals samples[i] within 1e-6
 */
export function istft(spec: Spectrum, options: IstftOptions = {}): Float32Array {
  checkOverlap(spec.window, spec.hop);
  const engine = new Engine(spec.size, spec.hop, spec.window, spec.frames),
    y = new Float64Array(engine.span);
  engine.synthesise(spec.real, spec.imag, y, options.signal);
  return trim(y, spec, options.length);
}

function trim(y: Float64Array, spec: Pick<Spectrum, 'size' | 'center' | 'length'>, length?: number): Float32Array {
  const start = spec.center ? spec.size / 2 : 0,
    n = length ?? spec.length;
  if (!Number.isInteger(n) || n < 0 || start + n > y.length)
    fail(`Length must be a whole number from 0 to ${y.length - start}, got ${n}`);
  return Float32Array.from(y.subarray(start, start + n));
}

/** Image data of a spectrogram. */
export interface SpectrogramImage {
  /** Frames (columns). */
  readonly width: number;
  /** Bins (rows). */
  readonly height: number;
  /** 1 for plain values, 4 (RGBA) when a colormap was given. */
  readonly channels: 1 | 4;
  /** Row-major, `width` per row. */
  readonly data: Uint8Array | Float32Array;
}

/** Options for `spectrogram`. */
export interface SpectrogramOptions {
  /** Decibels (10 log10 of power over `ref`) instead of linear power. Default true. */
  readonly dB?: boolean;
  /** Lowest decibel value kept, relative to `ref`. Default -100. */
  readonly floor?: number;
  /** [low, high] decibels mapped to 0 and 1 (or 0 and 255). Default [floor, 0]. */
  readonly range?: readonly [number, number];
  /** Reference power: `'max'` (default, the loudest cell is 0 dB) or a number. */
  readonly ref?: 'max' | number;
  /** `'u8'` (default) normalised 0 to 255 over `range`, or `'f32'` the raw decibel (or power) values. */
  readonly format?: 'u8' | 'f32';
  /** `'heat'` or a function from 0..1 to [r, g, b] (0..255): output RGBA bytes. */
  readonly colormap?: 'heat' | ((t: number) => readonly [number, number, number]);
  /** Which end is row 0: `'low'` (default, the lowest frequency) or `'high'` (top-down images). */
  readonly origin?: 'low' | 'high';
}

// Black, purple, red, orange, pale yellow: a perceptually ordered ramp (brightness rises with t), linear between stops.
const STOPS = [
  [0, 0, 0],
  [60, 0, 100],
  [190, 40, 80],
  [250, 150, 20],
  [255, 250, 200],
] as const;
const heat = (t: number): [number, number, number] => {
  const x = Math.min(0.999999, Math.max(0, t)) * (STOPS.length - 1),
    k = Math.floor(x),
    f = x - k;
  return [0, 1, 2].map((c) => STOPS[k][c] + f * (STOPS[k + 1][c] - STOPS[k][c])) as [number, number, number];
};

/**
 * A spectrogram image of a spectrum: power per frame and bin, in decibels by default, normalised to bytes (and
 * optionally coloured) ready to upload as a texture of `width` x `height`.
 * @example const { width, height, data } = spectrogram(stft(samples), { colormap: 'heat' });
 */
export function spectrogram(spec: Spectrum, options: SpectrogramOptions = {}): SpectrogramImage {
  const dB = options.dB ?? true,
    floor = options.floor ?? -100,
    [low, high] = options.range ?? [floor, 0],
    n = spec.frames * spec.bins,
    power = new Float64Array(n);
  if (!(floor < 0) || !(low < high))
    fail(`Floor must be below 0 and range [low, high] needs low < high, got floor ${floor}, range [${low}, ${high}]`);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    power[i] = spec.real[i] ** 2 + spec.imag[i] ** 2;
    if (power[i] > peak) peak = power[i];
  }
  const ref = options.ref === undefined || options.ref === 'max' ? peak : options.ref;
  if (!(ref >= 0) && ref !== 0) fail(`Reference power must be a number of 0 or more, got ${String(options.ref)}`);
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++)
    values[i] = dB ? Math.max(floor, 10 * Math.log10(Math.max(power[i], 1e-30) / Math.max(ref, 1e-30))) : power[i];
  const flip = options.origin === 'high',
    row = (y: number) => (flip ? spec.bins - 1 - y : y),
    map = options.colormap === 'heat' ? heat : options.colormap;
  const norm = (v: number) => Math.min(1, Math.max(0, (v - low) / (high - low)));
  if (options.format === 'f32' && !map) {
    const data = new Float32Array(n);
    for (let y = 0; y < spec.bins; y++)
      for (let x = 0; x < spec.frames; x++) data[y * spec.frames + x] = values[x * spec.bins + row(y)];
    return { width: spec.frames, height: spec.bins, channels: 1, data };
  }
  if (map) {
    const data = new Uint8Array(4 * n);
    for (let y = 0; y < spec.bins; y++)
      for (let x = 0; x < spec.frames; x++) {
        const [r, g, b] = map(norm(values[x * spec.bins + row(y)])),
          o = 4 * (y * spec.frames + x);
        data[o] = Math.round(r);
        data[o + 1] = Math.round(g);
        data[o + 2] = Math.round(b);
        data[o + 3] = 255;
      }
    return { width: spec.frames, height: spec.bins, channels: 4, data };
  }
  const data = new Uint8Array(n);
  for (let y = 0; y < spec.bins; y++)
    for (let x = 0; x < spec.frames; x++)
      data[y * spec.frames + x] = Math.round(255 * norm(values[x * spec.bins + row(y)]));
  return { width: spec.frames, height: spec.bins, channels: 1, data };
}

/** A magnitude spectrogram to invert: `frames` rows of `bins` non-negative values, plus the analysis settings. */
export interface Magnitude {
  readonly magnitude: Float32Array | Float64Array;
  readonly frames: number;
  readonly size: number;
  readonly hop: number;
  /** Default `'hann'`. */
  readonly window?: WindowName | ArrayLike<number>;
  /** Default true. */
  readonly center?: boolean;
  /** Samples to return. Default (frames - 1) * hop when centred. */
  readonly length?: number;
}

/** Options for `resynthesize`. */
export interface ResynthesizeOptions {
  /** Griffin-Lim iterations, 1 to 10000. Default 32. */
  readonly iterations?: number;
  /** Momentum alpha of the fast algorithm, 0 (plain Griffin-Lim) to 0.999. Default 0.99. */
  readonly momentum?: number;
  /** Starting phase: `'random'` (default, seeded), `'zero'`, or a spectrum whose phase is used. */
  readonly init?: 'random' | 'zero' | Spectrum;
  /** Seed of the random phase. Default 1. */
  readonly seed?: number;
  readonly signal?: AbortSignal;
}

/** What `resynthesize` returns. */
export interface Resynthesis {
  readonly samples: Float32Array;
  /** Spectral convergence ||target - |STFT(estimate)|| / ||target|| after each iteration (smaller is better). */
  readonly convergence: Float64Array;
  /** Frame FFTs run: iterations x 2 x frames for the projections plus frames for the final inverse. */
  readonly transforms: number;
}

/**
 * Estimates a signal whose STFT magnitude matches `magnitude` by the fast Griffin-Lim algorithm: alternate projecting
 * onto consistent spectrograms (inverse then forward transform) and onto the given magnitude, with a momentum step.
 * Momentum 0 is the original Griffin and Lim algorithm, whose spectral convergence never gets worse.
 * @example const { samples } = resynthesize({ magnitude, frames, size: 2048, hop: 512 }, { iterations: 64 });
 */
export function resynthesize(target: Magnitude, options: ResynthesizeOptions = {}): Resynthesis {
  const { size, hop, frames } = target,
    center = target.center ?? true,
    iterations = options.iterations ?? 32,
    alpha = options.momentum ?? 0.99,
    window = windowOf(target.window, size),
    bins = size / 2 + 1;
  planOf(center ? Math.max(1, (frames - 1) * hop) : size + (frames - 1) * hop, { size, hop, center, window });
  if (!Number.isInteger(frames) || frames < 1 || target.magnitude.length !== frames * bins)
    fail(`Magnitude needs frames x ${bins} values; got ${target.magnitude.length} for ${frames} frames`);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000)
    fail(`Iterations must be a whole number from 1 to 10000, got ${iterations}`);
  if (!(alpha >= 0 && alpha <= 0.999)) fail(`Momentum must be from 0 to 0.999, got ${alpha}`);
  checkOverlap(window, hop);
  const n = frames * bins,
    s = Float64Array.from(target.magnitude);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    if (!(s[i] >= 0) || !Number.isFinite(s[i]))
      fail(`Magnitude ${i} is ${s[i]}; magnitudes must be finite and at least 0`);
    energy += s[i] * s[i];
  }
  const engine = new Engine(size, hop, window, frames),
    cRe = new Float64Array(n),
    cIm = new Float64Array(n),
    tRe = new Float64Array(n),
    tIm = new Float64Array(n),
    pRe = new Float64Array(n),
    pIm = new Float64Array(n),
    y = new Float64Array(engine.span),
    convergence = new Float64Array(iterations),
    init = options.init ?? 'random';
  if (typeof init === 'object') {
    if (init.frames !== frames || init.size !== size)
      fail('The init spectrum must have the same frames and size as the magnitude');
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(init.real[i], init.imag[i]);
      cRe[i] = m > 0 ? (s[i] * init.real[i]) / m : s[i];
      cIm[i] = m > 0 ? (s[i] * init.imag[i]) / m : 0;
    }
  } else if (init === 'zero') cRe.set(s);
  else if (init === 'random') {
    let a = (options.seed ?? 1) >>> 0;
    for (let i = 0; i < n; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const phase = (2 * Math.PI * ((t ^ (t >>> 14)) >>> 0)) / 4294967296;
      cRe[i] = s[i] * Math.cos(phase);
      cIm[i] = s[i] * Math.sin(phase);
    }
  } else fail(`Unknown init "${String(init)}"; use random, zero or a Spectrum`);
  // Hermitian bins: the DC and Nyquist columns are real.
  for (let f = 0; f < frames; f++) {
    cIm[f * bins] = 0;
    cIm[f * bins + bins - 1] = 0;
  }
  tRe.set(cRe);
  tIm.set(cIm);
  for (let step = 0; step < iterations; step++) {
    options.signal?.throwIfAborted();
    // Project t onto the consistent spectrograms: p = STFT(ISTFT(t)).
    engine.synthesise(tRe, tIm, y, options.signal);
    engine.analyse(y, pRe, pIm, options.signal);
    // Onto the target magnitude, then the momentum step t = c + alpha (c - previous c).
    let error = 0;
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(pRe[i], pIm[i]),
        diff = s[i] - m;
      error += diff * diff;
      const re = m > 1e-30 ? (s[i] * pRe[i]) / m : s[i],
        im = m > 1e-30 ? (s[i] * pIm[i]) / m : 0;
      tRe[i] = re + alpha * (re - cRe[i]);
      tIm[i] = im + alpha * (im - cIm[i]);
      cRe[i] = re;
      cIm[i] = im;
    }
    convergence[step] = energy > 0 ? Math.sqrt(error / energy) : 0;
  }
  engine.synthesise(cRe, cIm, y, options.signal);
  const spec = { size, center, length: target.length ?? (center ? (frames - 1) * hop : engine.span) };
  return { samples: trim(y, spec, target.length), convergence, transforms: iterations * 2 * frames + frames };
}
