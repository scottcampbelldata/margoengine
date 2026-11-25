import { rangeError, typeError } from '../../shared/errors.js';

// Offline sample-rate conversion and channel mixing for Node, workers and pages: no Web Audio, no
// OfflineAudioContext. A file read by `decodeWav` at one rate is converted to the rate of the audio it joins.
//
// Sources (read clean room, no other library's code):
//  - J. O. Smith III and P. Gossett, "A flexible sampling-rate conversion method", ICASSP 1984,
//    and J. O. Smith III, "Digital Audio Resampling Home Page" (CCRMA, Stanford,
//    https://ccrma.stanford.edu/~jos/resample/): bandlimited interpolation, each output sample a sum of input samples
//    weighted by a windowed sinc centred on the output time; when the rate goes down the sinc is stretched by
//    out/in so it is also the anti-aliasing filter; the filter is a table of samples per zero crossing read with
//    linear interpolation between entries.
//  - R. E. Crochiere and L. R. Rabiner, "Multirate Digital Signal Processing", Prentice Hall, 1983, chapters 2 and 4:
//    a rate change by a rational factor is ideal lowpass filtering at the lower of the two Nyquist rates.
//  - J. F. Kaiser, "Nonrecursive digital filter design using the I0-sinh window function", IEEE ISCAS 1974, and
//    A. V. Oppenheim and R. W. Schafer, "Discrete-Time Signal Processing", 3rd ed., 2010, section 7.6: the Kaiser
//    window, its beta from the stopband attenuation (beta = 0.1102 (A - 8.7) for A > 50 dB) and its transition width.
//  - T. I. Laakso, V. Valimaki, M. Karjalainen and U. K. Laine, "Splitting the unit delay", IEEE Signal Processing
//    Magazine 13(1), 1996, doi:10.1109/79.482137: a fractional delay by a windowed sinc, compared here with Lagrange
//    and allpass interpolators, which do not band-limit a rate drop.
//  - W3C, "Web Audio API", Recommendation, 17 June 2021 (https://www.w3.org/TR/webaudio/), "Channel Up-Mixing and
//    Down-Mixing", speakers interpretation: the mono, stereo, quad and 5.1 mixing rules of `mixChannels`.

/** Audio as `decodeWav` returns it: a rate and one Float32Array per channel. */
export interface ResampleInput {
  sampleRate: number;
  channels: Float32Array[];
}

/** What {@link resample} returns. */
export interface ResampledAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Options of {@link resample}. */
export interface ResampleOptions {
  /**
   * Output channel count, mixed by {@link mixChannels} (the Web Audio speaker rules for 1, 2, 4 and 6 channels,
   * discrete otherwise). Default: the input's count.
   */
  channels?: number;
  /** Zero crossings of the windowed sinc on each side of an output sample, 4 to 256. Default 32. */
  zeroCrossings?: number;
  /**
   * The filter's cutoff as a share of the lower of the two Nyquist frequencies, 0.5 to 1. Default 0.92: with 32 zero
   * crossings and a 90 dB Kaiser window a tone at or above the lower Nyquist frequency comes out at least 90 dB down,
   * so nothing folds back, and the response is flat within 0.1 dB to 0.86 of it (19.0 kHz for 44.1 kHz to 48 kHz).
   */
  rolloff?: number;
  /** Stopband attenuation of the Kaiser window in dB, 40 to 160. Default 90. */
  attenuation?: number;
}

const SQRT_HALF = Math.SQRT1_2;
/** Samples of the filter table per zero crossing; linear interpolation between them (Smith). */
const PER_CROSSING = 1024;

/** The zeroth-order modified Bessel function of the first kind, by its power series. */
function besselI0(x: number): number {
  let sum = 1,
    term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** Half of the windowed sinc, sinc(u) w(u / zc) for u = i / PER_CROSSING, plus one zero past the end. */
function filterTable(zeroCrossings: number, beta: number): Float64Array {
  const n = zeroCrossings * PER_CROSSING,
    table = new Float64Array(n + 2),
    norm = besselI0(beta);
  table[0] = 1;
  for (let i = 1; i <= n; i++) {
    const u = i / PER_CROSSING,
      r = u / zeroCrossings,
      window = r < 1 ? besselI0(beta * Math.sqrt(1 - r * r)) / norm : 0;
    table[i] = (Math.sin(Math.PI * u) / (Math.PI * u)) * window;
  }
  return table;
}

/**
 * Channels mixed to `count` by the Web Audio speaker rules: mono, stereo, quad (L, R, SL, SR) and 5.1 (L, R, C, LFE,
 * SL, SR) up and down; any other pair is discrete (channels copied in order, missing ones silent, extra ones dropped).
 * Returns new arrays.
 *
 * @example
 * import {mixChannels} from '@margoengine/audio/resample';
 * const [mono] = mixChannels([new Float32Array([1, 0.5]), new Float32Array([0, 0.5])], 1);
 * console.log([...mono]); // [0.5, 0.5]
 */
export function mixChannels(channels: readonly Float32Array[], count: number): Float32Array[] {
  if (!Array.isArray(channels) || !channels.length || !channels.every((c) => c instanceof Float32Array))
    throw typeError('Pass the channels as an array of Float32Array', 'audio-resample');
  const length = channels[0].length;
  if (!channels.every((c) => c.length === length))
    throw rangeError('Every channel must hold the same number of samples', 'audio-resample');
  if (!Number.isInteger(count) || count < 1 || count > 32)
    throw rangeError('Pass an output channel count from 1 to 32', 'audio-resample');
  const from = channels.length,
    out = Array.from({ length: count }, () => new Float32Array(length)),
    add = (to: number, src: number, gain: number) => {
      const a = out[to],
        b = channels[src];
      for (let i = 0; i < length; i++) a[i] += gain * b[i];
    };
  const rules: Record<string, [number, number, number][]> = {
    '1>2': [
      [0, 0, 1],
      [1, 0, 1],
    ],
    '1>4': [
      [0, 0, 1],
      [1, 0, 1],
    ],
    '1>6': [[2, 0, 1]],
    '2>4': [
      [0, 0, 1],
      [1, 1, 1],
    ],
    '2>6': [
      [0, 0, 1],
      [1, 1, 1],
    ],
    '4>6': [
      [0, 0, 1],
      [1, 1, 1],
      [4, 2, 1],
      [5, 3, 1],
    ],
    '2>1': [
      [0, 0, 0.5],
      [0, 1, 0.5],
    ],
    '4>1': [
      [0, 0, 0.25],
      [0, 1, 0.25],
      [0, 2, 0.25],
      [0, 3, 0.25],
    ],
    '6>1': [
      [0, 0, SQRT_HALF],
      [0, 1, SQRT_HALF],
      [0, 2, 1],
      [0, 4, 0.5],
      [0, 5, 0.5],
    ],
    '4>2': [
      [0, 0, 0.5],
      [0, 2, 0.5],
      [1, 1, 0.5],
      [1, 3, 0.5],
    ],
    '6>2': [
      [0, 0, 1],
      [0, 2, SQRT_HALF],
      [0, 4, SQRT_HALF],
      [1, 1, 1],
      [1, 2, SQRT_HALF],
      [1, 5, SQRT_HALF],
    ],
    '6>4': [
      [0, 0, 1],
      [0, 2, SQRT_HALF],
      [1, 1, 1],
      [1, 2, SQRT_HALF],
      [2, 4, 1],
      [3, 5, 1],
    ],
  };
  const rule = from === count ? undefined : rules[`${from}>${count}`];
  if (rule) for (const [to, src, gain] of rule) add(to, src, gain);
  else for (let c = 0; c < Math.min(from, count); c++) out[c].set(channels[c]);
  return out;
}

/**
 * Converts audio to `sampleRate` by bandlimited interpolation (a Kaiser-windowed sinc, Smith and Gossett 1984), on
 * plain Float32Array channels, in Node or a page. The output holds `ceil(length * sampleRate / input rate)` samples,
 * so one second stays one second; samples before the start and after the end count as silence. Converting to the
 * same rate copies the samples. A rate drop also filters out what the new rate cannot hold, so nothing aliases.
 *
 * @example
 * import {resample} from '@margoengine/audio/resample';
 * const take = {sampleRate: 44100, channels: [new Float32Array(44100)]};
 * const voice = resample(take, 48000, {channels: 2});
 * console.log(voice.sampleRate, voice.channels.length, voice.channels[0].length); // 48000 2 48000
 * @throws RangeError for a rate that is not a positive integer up to 768000, or an option out of range.
 */
export function resample(audio: ResampleInput, sampleRate: number, options: ResampleOptions = {}): ResampledAudio {
  if (!audio || typeof audio !== 'object') throw typeError('Pass {sampleRate, channels} audio', 'audio-resample');
  const { zeroCrossings = 32, rolloff = 0.92, attenuation = 90 } = options;
  for (const rate of [audio.sampleRate, sampleRate])
    if (!Number.isInteger(rate) || rate < 1 || rate > 768000)
      throw rangeError('Sample rates must be whole numbers from 1 to 768000', 'audio-resample');
  if (!Number.isInteger(zeroCrossings) || zeroCrossings < 4 || zeroCrossings > 256)
    throw rangeError('zeroCrossings must be a whole number from 4 to 256', 'audio-resample');
  if (!(rolloff >= 0.5 && rolloff <= 1)) throw rangeError('rolloff must be from 0.5 to 1', 'audio-resample');
  if (!(attenuation >= 40 && attenuation <= 160))
    throw rangeError('attenuation must be from 40 to 160 dB', 'audio-resample');
  const channels = mixChannels(audio.channels, options.channels ?? audio.channels.length);
  const from = audio.sampleRate,
    length = channels[0].length;
  if (from === sampleRate) return { sampleRate, channels };
  const outLength = Math.floor((length * sampleRate + from - 1) / from),
    // The cutoff in cycles per input sample is s / 2; the sinc's zero crossings are 1 / s input samples apart.
    s = rolloff * Math.min(1, sampleRate / from),
    reach = zeroCrossings / s,
    // Kaiser's beta for the stopband attenuation (Kaiser 1974; Oppenheim and Schafer, section 7.6).
    beta =
      attenuation > 50
        ? 0.1102 * (attenuation - 8.7)
        : 0.5842 * (attenuation - 21) ** 0.4 + 0.07886 * (attenuation - 21),
    table = filterTable(zeroCrossings, beta),
    weights = new Float64Array(Math.ceil(2 * reach) + 2),
    out = channels.map(() => new Float32Array(outLength));
  for (let n = 0; n < outLength; n++) {
    // The output sample's time in input samples; n * from is exact, as both are whole numbers below 2^53 / 768000.
    const t = (n * from) / sampleRate,
      first = Math.max(0, Math.ceil(t - reach)),
      last = Math.min(length - 1, Math.floor(t + reach));
    let count = 0;
    for (let i = first; i <= last; i++) {
      const x = Math.abs(t - i) * s * PER_CROSSING,
        j = Math.floor(x),
        f = x - j;
      weights[count++] = j >= table.length - 1 ? 0 : s * (table[j] + (table[j + 1] - table[j]) * f);
    }
    for (let c = 0; c < channels.length; c++) {
      const input = channels[c];
      let sum = 0;
      for (let k = 0; k < count; k++) sum += weights[k] * input[first + k];
      out[c][n] = sum;
    }
  }
  return { sampleRate, channels: out };
}
