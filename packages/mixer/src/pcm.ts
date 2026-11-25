// Offline mixing in plain code (GAP-FILM-MIX): clips placed on a timeline into buses, level and pan, fades, ducking keyed
// by another bus and a look-ahead limiter. No Web Audio, so it runs in Node, and the same input gives the same samples.
//
// Sources: D. Giannoulis, M. Massberg and J. D. Reiss, "Digital Dynamic Range Compressor Design - A Tutorial and
// Analysis", J. Audio Eng. Soc. 60(6), 2012 (https://aes2.org/publications/elibrary-page/?id=16354): feed-forward gain
// computed first and smoothed in the log domain with separate attack and release time constants. ITU-R BS.1770-5 Annex 2
// (https://www.itu.int/rec/R-REC-BS.1770): the four-phase interpolator for true peak. D. Lemire, "Streaming
// maximum-minimum filter using no more than three comparisons per element", 2006 (https://arxiv.org/abs/cs/0610046):
// the sliding minimum. A minimum over the look-ahead followed by a mean of the same length never exceeds the gain any
// covered sample needs.
import { dbToGain, gainToDb } from './dsp.js';
import { measureTruePeak, peakPhases } from './true-peak.js';

/** One piece of audio placed on the timeline. */
export interface PCMClip {
  /** The source: one Float32Array per channel at the mix's sample rate (1 channel, or as many as the mix has). */
  channels: readonly Float32Array[];
  /** Where it starts on the timeline, seconds, 0 or more. Default 0. */
  at?: number;
  /** Where reading starts in the source, seconds. Default 0. */
  offset?: number;
  /** Seconds to play, at most what is left of the source. Default all of it. */
  duration?: number;
  /** Level in dB. Default 0. */
  gain?: number;
  /** -1 (left) to 1 (right), two-channel mixes only: constant power for a mono source, balance for stereo. Default 0. */
  pan?: number;
  /** Linear fade from silence, seconds. Default 0. */
  fadeIn?: number;
  /** Linear fade to silence at the end, seconds. Default 0. */
  fadeOut?: number;
  /** Name of a bus in `buses`. Default the master. */
  bus?: string;
}
/** Lowers a bus while another bus is heard. */
export interface PCMDuck {
  /** The bus that triggers it, for example the voice. Its level is read after its gain and before any ducking. */
  key: string;
  /** How far the bus is lowered, dB, 0 to 120. Default 12. */
  amount?: number;
  /** Key peak, dBFS, at or above which the bus is lowered. Default -40. */
  threshold?: number;
  /** Time constant of the way down, seconds. Default 0.05. */
  attack?: number;
  /** Time constant of the way back, seconds. Default 0.4. */
  release?: number;
  /** Seconds the bus stays lowered after the key was last above the threshold, so words do not pump. Default 0.25. */
  hold?: number;
  /** Seconds the move starts before the key does; offline audio can look ahead. Default three attack times. */
  lookahead?: number;
}
/** A group of clips with a level and ducking. */
export interface PCMBus {
  /** Level in dB. Default 0. */
  gain?: number;
  /** One or more ducking rules; the deepest wins. */
  duck?: PCMDuck | readonly PCMDuck[];
}
/** Look-ahead true-peak limiter settings. */
export interface PCMLimiter {
  /** Highest true peak of the result, dBTP, -60 to 0. Default -1 (EBU R 128). */
  ceiling?: number;
  /** Seconds the gain moves down ahead of a peak, 0 to 0.1. Default 0.005. */
  lookahead?: number;
  /** Time constant of the way back, seconds. Default 0.1. */
  release?: number;
}
/** Settings of {@link mixPCM}. */
export interface PCMMixOptions {
  /** The audio and where it goes. */
  clips: readonly PCMClip[];
  /** Samples per second of every source and of the result. Default 48000. */
  sampleRate?: number;
  /** Output channels, 1 to 32. Default 2. */
  channels?: number;
  /** Length of the result in seconds. Default the end of the last clip. */
  seconds?: number;
  /** Buses by name; `master` is the sum of all of them and takes no entry here. */
  buses?: Readonly<Record<string, PCMBus>>;
  /** Master level in dB, before the limiter. Default 0. */
  gain?: number;
  /** The master limiter, or false for none. Default on at -1 dBTP. */
  limiter?: PCMLimiter | false;
  /** Checked between clips and buses. */
  signal?: AbortSignal;
}
/** A finished mix. */
export interface PCMMix {
  /** The result, one Float32Array per channel. */
  channels: Float32Array[];
  /** Samples per second. */
  sampleRate: number;
  /** True peak of the result as a linear gain. */
  truePeak: number;
  /** The most the limiter lowered the mix, dB, 0 or more. */
  reduction: number;
}

function number(value: number, min: number, max: number, name: string): number {
  if (!(value >= min && value <= max))
    throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}; pass a number in that range`);
  return value;
}
function pcm(channels: readonly Float32Array[], name: string): number {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 32)
    throw new RangeError(`${name} needs 1 to 32 channels; pass an array of Float32Arrays`);
  const length = channels[0]?.length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length)
      throw new TypeError(`${name} needs equal-length Float32Array channels; decode or copy the PCM first`);
    for (const value of channel)
      if (!Number.isFinite(value))
        throw new TypeError(`${name} needs finite samples; remove NaN and Infinity from the input`);
  }
  return length;
}
/** One-pole coefficient of a time constant. */
const pole = (seconds: number, rate: number) => (seconds === 0 ? 0 : Math.exp(-1 / (rate * seconds)));

/**
 * The gain a duck applies at every sample of its key (linear, 1 where the key is quiet): the key's peak over the
 * threshold marks it active from `lookahead` before to `hold` after, and the gain in dB follows with the attack and
 * release time constants.
 * @example
 * const gain = duckGain([new Float32Array(48000).fill(0.5, 24000)], 48000, {amount: 9});
 */
export function duckGain(
  key: readonly Float32Array[],
  sampleRate: number,
  options: Omit<PCMDuck, 'key'> = {},
): Float32Array {
  const length = pcm(key, 'Duck key'),
    rate = number(sampleRate, 1, 768000, 'sampleRate'),
    amount = number(options.amount ?? 12, 0, 120, 'Duck amount'),
    threshold = dbToGain(number(options.threshold ?? -40, -120, 0, 'Duck threshold')),
    attack = number(options.attack ?? 0.05, 0, 60, 'Duck attack'),
    release = number(options.release ?? 0.4, 0, 60, 'Duck release'),
    hold = Math.round(number(options.hold ?? 0.25, 0, 60, 'Duck hold') * rate),
    ahead = Math.round(number(options.lookahead ?? Math.min(60, attack * 3), 0, 60, 'Duck lookahead') * rate);
  const active = new Uint8Array(length);
  // `until` is the first sample no longer covered by a loud one seen so far.
  let from = 0;
  for (let n = 0; n < length; n++) {
    let peak = 0;
    for (const channel of key) peak = Math.max(peak, Math.abs(channel[n]));
    if (peak < threshold) continue;
    const end = Math.min(length, n + hold + 1);
    active.fill(1, Math.max(from, n - ahead), end);
    from = end;
  }
  const out = new Float32Array(length),
    down = pole(attack, rate),
    up = pole(release, rate);
  let db = 0;
  for (let n = 0; n < length; n++) {
    const target = active[n] ? -amount : 0,
      a = target < db ? down : up;
    db = target + a * (db - target);
    out[n] = dbToGain(db);
  }
  return out;
}

/**
 * Limits `channels` in place to a true peak at or under the ceiling with one gain for all channels: the gain moves down
 * over the look-ahead before a peak and comes back with the release time constant. Returns the true peak of the result
 * and the deepest reduction in dB.
 * @example
 * const loud = [new Float32Array(48000).fill(1.5)];
 * const {truePeak} = limitPCM(loud, 48000, {ceiling: -1}); // truePeak <= 0.8913
 */
export function limitPCM(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: PCMLimiter = {},
): { truePeak: number; reduction: number } {
  const length = pcm(channels, 'Limiter'),
    rate = number(sampleRate, 1, 768000, 'sampleRate'),
    ceiling = dbToGain(number(options.ceiling ?? -1, -60, 0, 'Limiter ceiling')),
    ahead = Math.round(number(options.lookahead ?? 0.005, 0, 0.1, 'Limiter lookahead') * rate),
    release = pole(number(options.release ?? 0.1, 0, 60, 'Limiter release'), rate);
  // Aim a hair under the ceiling, so that rounding the products to float32 never lands over it.
  const aim = ceiling * (1 - 2 ** -20);
  // The gain each sample needs: its own peak, and every interpolated peak whose 12 taps read it.
  const need = new Float32Array(length).fill(1);
  const history = new Float64Array(12);
  for (const channel of channels) {
    history.fill(0);
    for (let n = 0; n < length + 11; n++) {
      const at = n % 12;
      history[at] = n < length ? channel[n] : 0;
      let peak = Math.abs(history[at]);
      for (const phase of peakPhases) {
        let sum = 0;
        for (let k = 0; k < 12; k++) sum += phase[k] * history[(at - k + 12) % 12];
        peak = Math.max(peak, Math.abs(sum));
      }
      if (peak <= aim) continue;
      const gain = aim / peak;
      for (let k = Math.max(0, n - 11), end = Math.min(length - 1, n); k <= end; k++)
        if (gain < need[k]) need[k] = gain;
    }
  }
  // held[i]: the smallest need over samples i - ahead .. i (monotonic queue of indices), for i from 0 to
  // length - 1 + ahead; the gain of sample n then averages the released values at n .. n + ahead.
  const total = length + ahead,
    held = new Float64Array(total),
    queue = new Int32Array(length);
  let head = 0,
    tail = 0,
    previous = 1;
  for (let i = 0; i < total; i++) {
    if (i < length) {
      while (tail > head && need[queue[tail - 1]] >= need[i]) tail--;
      queue[tail++] = i;
    }
    while (queue[head] < i - ahead) head++;
    const low = need[queue[head]];
    // Down at once (the mean below turns it into a ramp), back up with the release time constant.
    previous = low < previous ? low : low + release * (previous - low);
    held[i] = previous;
  }
  let sum = 0,
    lowest = 1;
  for (let i = 0; i < ahead; i++) sum += held[i];
  for (let n = 0; n < length; n++) {
    sum += held[n + ahead];
    const gain = Math.min(sum / (ahead + 1), need[n]);
    sum -= held[n];
    if (gain < 1) {
      lowest = Math.min(lowest, gain);
      for (const channel of channels) channel[n] *= gain;
    }
  }
  // A gain that moves inside the interpolator's 12 taps can leave a small excess: take it off the whole signal.
  let truePeak = measureTruePeak(channels as Float32Array[]);
  if (truePeak > ceiling) {
    const trim = (ceiling / truePeak) * (1 - 2 ** -22);
    for (const channel of channels) for (let n = 0; n < length; n++) channel[n] *= trim;
    lowest *= trim;
    truePeak = measureTruePeak(channels as Float32Array[]);
  }
  return { truePeak, reduction: Math.max(0, -gainToDb(lowest)) };
}

/**
 * Mixes clips into buses and buses into one signal, in plain code: no Web Audio, so it runs in Node.
 * @example
 * const music = new Float32Array(96000).fill(0.25), voice = new Float32Array(48000).fill(0.5);
 * const mix = mixPCM({
 *   buses: {music: {gain: -6, duck: {key: 'voice', amount: 12}}, voice: {}},
 *   clips: [{channels: [music], bus: 'music'}, {channels: [voice], bus: 'voice', at: 0.5}],
 * });
 * console.log(mix.channels.length, mix.truePeak, mix.reduction);
 */
export function mixPCM(options: PCMMixOptions): PCMMix {
  const { clips, buses = {}, signal } = options;
  signal?.throwIfAborted();
  const sampleRate = number(options.sampleRate ?? 48000, 8000, 768000, 'sampleRate'),
    count = options.channels ?? 2;
  if (!Number.isInteger(count) || count < 1 || count > 32)
    throw new RangeError(`channels must be an integer from 1 to 32, got ${count}; use 2 for stereo`);
  if (!Array.isArray(clips)) throw new TypeError('clips must be an array; pass the audio to mix');
  const placed = clips.map((clip, i) => {
    const name = `Clip ${i}`,
      length = pcm(clip.channels, name);
    if (clip.channels.length !== 1 && clip.channels.length !== count)
      throw new RangeError(
        `${name} has ${clip.channels.length} channels; give it 1 or ${count}, the mix's channel count`,
      );
    if (clip.bus !== undefined && !Object.hasOwn(buses, clip.bus))
      throw new RangeError(`${name} goes to bus "${clip.bus}", which is not in buses; add it there`);
    const pan = number(clip.pan ?? 0, -1, 1, `${name} pan`);
    if (pan !== 0 && count !== 2) throw new RangeError(`${name} pan needs a two-channel mix; use channels 2 or pan 0`);
    const start = Math.round(number(clip.at ?? 0, 0, 86400, `${name} at`) * sampleRate),
      offset = Math.round(number(clip.offset ?? 0, 0, length / sampleRate, `${name} offset`) * sampleRate),
      wanted =
        clip.duration === undefined
          ? length - offset
          : Math.round(number(clip.duration, 0, 86400, `${name} duration`) * sampleRate);
    return {
      clip,
      pan,
      start,
      offset,
      length: Math.max(0, Math.min(wanted, length - offset)),
      gain: dbToGain(number(clip.gain ?? 0, -Infinity, 120, `${name} gain`)),
      fadeIn: Math.round(number(clip.fadeIn ?? 0, 0, 86400, `${name} fadeIn`) * sampleRate),
      fadeOut: Math.round(number(clip.fadeOut ?? 0, 0, 86400, `${name} fadeOut`) * sampleRate),
    };
  });
  const total =
    options.seconds === undefined
      ? placed.reduce((end, p) => Math.max(end, p.start + p.length), 0)
      : Math.round(number(options.seconds, 0, 86400, 'seconds') * sampleRate);
  const silence = () => Array.from({ length: count }, () => new Float32Array(total));
  const output = silence(),
    stems = new Map<string, Float32Array[]>();
  for (const [name, bus] of Object.entries(buses)) {
    for (const duck of [bus.duck ?? []].flat())
      if (!Object.hasOwn(buses, duck.key))
        throw new RangeError(`Bus "${name}" ducks under "${duck.key}", which is not in buses; add it there`);
    stems.set(name, silence());
  }
  for (const p of placed) {
    signal?.throwIfAborted();
    const target = p.clip.bus === undefined ? output : stems.get(p.clip.bus)!,
      mono = p.clip.channels.length === 1,
      angle = ((p.pan + 1) * Math.PI) / 4;
    const end = Math.min(p.length, total - p.start);
    for (let c = 0; c < count; c++) {
      const source = p.clip.channels[mono ? 0 : c],
        destination = target[c];
      // A mono source in a stereo mix is panned at constant power, scaled so that the centre keeps its level.
      const side =
        count !== 2
          ? 1
          : mono
            ? Math.SQRT2 * (c === 0 ? Math.cos(angle) : Math.sin(angle))
            : Math.min(1, c === 0 ? 1 - p.pan : 1 + p.pan);
      for (let n = 0; n < end; n++) {
        let level = p.gain * side;
        if (n < p.fadeIn) level *= n / p.fadeIn;
        if (p.length - 1 - n < p.fadeOut) level *= (p.length - 1 - n) / p.fadeOut;
        destination[p.start + n] += source[p.offset + n] * level;
      }
    }
  }
  for (const [name, bus] of Object.entries(buses)) {
    const gain = dbToGain(number(bus.gain ?? 0, -Infinity, 120, `Bus "${name}" gain`));
    for (const channel of stems.get(name)!) for (let n = 0; n < total; n++) channel[n] *= gain;
  }
  // Every duck reads its key before any bus is ducked, so the order of the buses does not matter.
  const gains = new Map<string, Float32Array>();
  for (const [name, bus] of Object.entries(buses)) {
    for (const duck of [bus.duck ?? []].flat()) {
      signal?.throwIfAborted();
      const next = duckGain(stems.get(duck.key)!, sampleRate, duck),
        current = gains.get(name);
      if (!current) gains.set(name, next);
      else for (let n = 0; n < total; n++) current[n] = Math.min(current[n], next[n]);
    }
  }
  const master = dbToGain(number(options.gain ?? 0, -Infinity, 120, 'gain'));
  for (const [name, stem] of stems) {
    const duck = gains.get(name);
    for (let c = 0; c < count; c++)
      for (let n = 0; n < total; n++) output[c][n] += duck ? stem[c][n] * duck[n] : stem[c][n];
  }
  for (const channel of output) for (let n = 0; n < total; n++) channel[n] *= master;
  signal?.throwIfAborted();
  const limited =
    options.limiter === false
      ? { truePeak: measureTruePeak(output), reduction: 0 }
      : limitPCM(output, sampleRate, options.limiter);
  return { channels: output, sampleRate, ...limited };
}
