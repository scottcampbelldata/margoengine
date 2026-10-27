// Pure audio maths: decibels, the biquad coefficients of the Web Audio specification (themselves the public RBJ
// cookbook formulas), a direct-form biquad, the textbook compressor curve and a seeded reverb impulse response. No
// Web Audio objects here, so every function runs in Node and is the reference the offline renders are compared to.
import { MargoError } from '@margoengine/math/errors';

/** Linear gain of a level in decibels: `dbToGain(-6)` is about 0.501. */
export const dbToGain = (db: number): number => 10 ** (db / 20);
/** Level in decibels of a linear gain; 0 gives `-Infinity`. */
export const gainToDb = (gain: number): number => 20 * Math.log10(gain);

/** Filter shapes of a Web Audio BiquadFilterNode. */
export type BiquadKind =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'allpass'
  | 'peaking'
  | 'lowshelf'
  | 'highshelf';

/** Normalised biquad coefficients (a0 = 1): `y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2]`. */
export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const KINDS: readonly BiquadKind[] = [
  'lowpass',
  'highpass',
  'bandpass',
  'notch',
  'allpass',
  'peaking',
  'lowshelf',
  'highshelf',
];

/**
 * The `q` used when none is given: -3.0103 dB (a Butterworth response, no peak) for `lowpass` and `highpass`, 1 for
 * `peaking`, and 1/sqrt(2) for the rest.
 */
export const defaultQ = (kind: BiquadKind): number =>
  kind === 'lowpass' || kind === 'highpass' ? 20 * Math.log10(Math.SQRT1_2) : kind === 'peaking' ? 1 : Math.SQRT1_2;

/**
 * Biquad coefficients as the Web Audio specification defines them, so `biquadMagnitude` of the result matches a
 * BiquadFilterNode with the same settings. `q` is a resonance in decibels for `lowpass` and `highpass` and a plain
 * quality factor for `bandpass`, `notch`, `allpass` and `peaking`; the shelves ignore it. `gainDb` (within
 * 200 dB) only affects `peaking` and the shelves. Throws RangeError for a frequency outside 0..Nyquist, a `q` outside
 * -100..100 dB (lowpass, highpass) or 0.001..1000 (the rest), or a non-finite number, and a MargoError ('failed')
 * for a setting that has no stable filter.
 * @example
 * const c = biquadCoefficients('peaking', 48000, 1000, 1, 6); // +6 dB bell at 1 kHz
 */
export function biquadCoefficients(
  kind: BiquadKind,
  sampleRate: number,
  frequency: number,
  q = defaultQ(kind),
  gainDb = 0,
): BiquadCoefficients {
  if (!KINDS.includes(kind))
    throw new TypeError(`Unknown filter type "${String(kind)}"; use one of ${KINDS.join(', ')}`);
  for (const [name, value] of [
    ['sampleRate', sampleRate],
    ['frequency', frequency],
    ['q', q],
    ['gainDb', gainDb],
  ] as const)
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number, got ${value}`);
  if (sampleRate <= 0) throw new RangeError(`sampleRate must be above 0, got ${sampleRate}`);
  if (frequency < 0 || frequency > sampleRate / 2)
    throw new RangeError(
      `frequency must be between 0 and the Nyquist frequency ${sampleRate / 2} Hz, got ${frequency}`,
    );
  if (Math.abs(gainDb) > 200) throw new RangeError(`gainDb must be between -200 and 200, got ${gainDb}`);
  if (kind === 'lowpass' || kind === 'highpass') {
    if (Math.abs(q) > 100) throw new RangeError(`q must be a resonance of -100 to 100 dB for ${kind}, got ${q}`);
  } else if (kind === 'bandpass' || kind === 'notch' || kind === 'allpass' || kind === 'peaking') {
    if (q < 0.001 || q > 1000) throw new RangeError(`q must be between 0.001 and 1000 for ${kind}, got ${q}`);
  }
  const w0 = (2 * Math.PI * frequency) / sampleRate,
    cos = Math.cos(w0),
    sin = Math.sin(w0),
    A = 10 ** (gainDb / 40);
  let b0 = 1,
    b1 = 0,
    b2 = 0,
    a0 = 1,
    a1 = 0,
    a2 = 0;
  const resonant = () => sin / (2 * 10 ** (q / 20));
  const bell = () => (q > 0 ? sin / (2 * q) : 0);
  switch (kind) {
    case 'lowpass': {
      const alpha = resonant();
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      const alpha = resonant();
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'bandpass': {
      const alpha = bell();
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'notch': {
      const alpha = bell();
      b0 = 1;
      b1 = -2 * cos;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'allpass': {
      const alpha = bell();
      b0 = 1 - alpha;
      b1 = -2 * cos;
      b2 = 1 + alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'peaking': {
      const alpha = bell();
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      // Shelf slope S = 1, so alpha = sin(w0)/2 * sqrt(2); k = 2 sqrt(A) alpha.
      const k = 2 * Math.sqrt(A) * ((sin / 2) * Math.SQRT2);
      b0 = A * (A + 1 - (A - 1) * cos + k);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - k);
      a0 = A + 1 + (A - 1) * cos + k;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - k;
      break;
    }
    case 'highshelf': {
      const k = 2 * Math.sqrt(A) * ((sin / 2) * Math.SQRT2);
      b0 = A * (A + 1 + (A - 1) * cos + k);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - k);
      a0 = A + 1 - (A - 1) * cos + k;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - k;
      break;
    }
  }
  const c = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  // Stability triangle |a2| < 1 and |a1| < 1 + a2 (at the 0 Hz and Nyquist edges the poles sit on the unit circle,
  // which the Web Audio specification also allows, so the bounds are inclusive there).
  const stable = Math.abs(c.a2) <= 1 && Math.abs(c.a1) <= 1 + c.a2 + 1e-12;
  if (!Object.values(c).every(Number.isFinite) || !stable)
    throw new MargoError(
      'failed',
      `Filter ${kind} at ${frequency} Hz with q ${q} and gain ${gainDb} dB is not realisable; move the frequency or lower q`,
    );
  return c;
}

/** Gain (linear magnitude) of a biquad at `frequency` Hz. */
export function biquadMagnitude(c: BiquadCoefficients, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate,
    cos1 = Math.cos(w),
    sin1 = Math.sin(w),
    cos2 = Math.cos(2 * w),
    sin2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cos1 + c.b2 * cos2,
    ni = -(c.b1 * sin1 + c.b2 * sin2),
    dr = 1 + c.a1 * cos1 + c.a2 * cos2,
    di = -(c.a1 * sin1 + c.a2 * sin2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Runs a biquad (direct form I, double precision) over `input` and returns a new array. */
export function biquadProcess(c: BiquadCoefficients, input: ArrayLike<number>): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i],
      y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/** Static compressor settings used by {@link compressorCurve}. */
export interface CompressorCurve {
  /** Level in dB above which gain reduction starts. */
  threshold: number;
  /** Width in dB of the soft transition around the threshold; 0 is a hard knee. */
  knee: number;
  /** Input change in dB per 1 dB of output change above the threshold; at least 1. */
  ratio: number;
}

/**
 * Output level in dB of a feed-forward compressor for an input level in dB, with the soft knee of Giannoulis,
 * Massberg and Reiss, "Digital Dynamic Range Compressor Design" (JAES 2012). A design aid: the browser's
 * DynamicsCompressorNode uses its own curve and make-up gain, so this does not predict it to the decibel.
 */
export function compressorCurve(levelDb: number, { threshold, knee, ratio }: CompressorCurve): number {
  if (!(ratio >= 1)) throw new RangeError(`ratio must be 1 or more, got ${ratio}`);
  if (!(knee >= 0)) throw new RangeError(`knee must be 0 or more, got ${knee}`);
  const over = levelDb - threshold;
  if (2 * over < -knee) return levelDb;
  if (knee > 0 && 2 * Math.abs(over) <= knee) {
    const x = over + knee / 2;
    return levelDb + ((1 / ratio - 1) * x * x) / (2 * knee);
  }
  return threshold + over / ratio;
}

/** Settings of {@link impulseResponse}. */
export interface ImpulseOptions {
  /** Length in seconds, above 0 and at most 20. Default 2. */
  seconds?: number;
  /** Seconds for the tail to fall 60 dB (RT60), above 0. Default `seconds / 2`. */
  decay?: number;
  /** Silence before the tail starts, seconds, below `seconds`. Default 0. */
  preDelay?: number;
  /** Channels, 1 or 2. Default 2 (the two channels use different noise). */
  channels?: 1 | 2;
  /** Seed of the noise: the same options and seed give the same samples. Default 1. */
  seed?: number;
}

/**
 * A synthetic room: decaying white noise whose level falls 60 dB over `decay` seconds, scaled to unit energy per
 * channel so a convolver with `normalize = false` neither boosts nor cuts the level. Deterministic for a seed
 * (mulberry32 generator), so renders are repeatable.
 */
export function impulseResponse(sampleRate: number, options: ImpulseOptions = {}): Float32Array[] {
  const { seconds = 2, preDelay = 0, channels = 2, seed = 1 } = options;
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate))
    throw new RangeError(`sampleRate must be above 0, got ${sampleRate}`);
  if (!(seconds > 0 && seconds <= 20)) throw new RangeError(`seconds must be above 0 and at most 20, got ${seconds}`);
  const decay = options.decay ?? seconds / 2;
  if (!(decay > 0)) throw new RangeError(`decay must be above 0, got ${decay}`);
  if (!(preDelay >= 0 && preDelay < seconds))
    throw new RangeError(`preDelay must be 0 or more and below seconds, got ${preDelay}`);
  if (channels !== 1 && channels !== 2) throw new RangeError(`channels must be 1 or 2, got ${channels}`);
  const length = Math.max(1, Math.round(seconds * sampleRate)),
    start = Math.round(preDelay * sampleRate),
    k = Math.log(1000) / decay; // amplitude falls 60 dB (x1000) in `decay` seconds
  const out: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    let state = (seed + ch * 0x9e3779b9) >>> 0;
    const data = new Float32Array(length);
    let energy = 0;
    for (let i = start; i < length; i++) {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const noise = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1,
        v = noise * Math.exp(-k * ((i - start) / sampleRate));
      data[i] = v;
      energy += v * v;
    }
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i++) data[i] *= scale;
    out.push(data);
  }
  return out;
}

/** Peak (largest absolute sample) and RMS of `samples[from..to)`. */
export function measure(samples: ArrayLike<number>, from = 0, to = samples.length): { peak: number; rms: number } {
  let peak = 0,
    sum = 0;
  for (let i = from; i < to; i++) {
    const v = samples[i];
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return { peak, rms: to > from ? Math.sqrt(sum / (to - from)) : 0 };
}
