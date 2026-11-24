import { MargoError } from '@margoengine/math/errors';
import { bounded } from './worklet-host.js';
import { measureTruePeak } from './true-peak.js';
import { loudnessFilters } from './loudness-filters.js';

/** File/segment loudness measurements. Loudness values use LUFS; linear truePeak includes sample peaks. */
export interface LoudnessReport {
  /** BS.1770 integrated loudness after absolute and relative gating; -Infinity if no block qualifies. */
  readonly integrated: number;
  /** Last complete ungated 400 ms window; -Infinity if unavailable or silent. */
  readonly momentary: number;
  /** Last complete ungated 3 s window; -Infinity if unavailable or silent. */
  readonly shortTerm: number;
  /** Maximum momentary loudness, -Infinity if unavailable. */
  readonly maximumMomentary: number;
  /** Maximum short-term loudness, -Infinity if unavailable. */
  readonly maximumShortTerm: number;
  /** 400 ms windows every 10 ms, starting at time 0.4 s. */
  readonly momentaryHistory: Float64Array;
  /** 3 s windows every 10 ms, starting at time 3 s. */
  readonly shortTermHistory: Float64Array;
  /** Total 400 ms integration blocks, with 75% overlap. */
  readonly blocks: number;
  /** Blocks retained after both gates. */
  readonly gatedBlocks: number;
  /** Full input duration in seconds; incomplete integration windows are discarded. */
  readonly duration: number;
  /** Linear maximum across original samples and the ITU four-phase FIR reconstruction, including LFE. */
  readonly truePeak: number;
}

/** Gain normalisation options. */
export interface NormalizeLoudnessOptions {
  /** Target LUFS, default -23. Must be above -70 and at most 0. */
  target?: number;
  /** Maximum true peak in dBTP, default -1, range -96..0; uses the worklet entry's finite-FIR model. */
  maxTruePeak?: number;
}
/** Owned copies of the normalised PCM, with measured outcomes. */
export interface NormalizedLoudness {
  /** New channels; input arrays are never mutated. */
  readonly channels: Float32Array[];
  /** Applied constant gain in dB. */
  readonly gainDb: number;
  /** True if the peak cap required less gain than the loudness target. No compression or clipping is used. */
  readonly peakLimited: boolean;
  /** Measurements before applying gain. */
  readonly before: LoudnessReport;
  /** Measurements after applying gain, including any changed absolute-gate selection. */
  readonly after: LoudnessReport;
}

type Filter = readonly [number, number, number, number, number];
const rates = [32000, 44100, 48000, 88200, 96000, 176400, 192000];
const help = 'https://margoengine.com/llms/packages/mixer.md';
const level = (power: number) => power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;


function validate(channels: readonly Float32Array[], sampleRate: number): number {
  bounded(sampleRate, 32000, 192000, 'Loudness sampleRate');
  if (!rates.includes(sampleRate))
    throw new RangeError('Loudness sampleRate is unsupported; use 32000, 44100, 48000, 88200, 96000, 176400 or 192000 Hz');
  if (!Array.isArray(channels) || ![1, 2, 6].includes(channels.length))
    throw new TypeError('Loudness needs mono, stereo or Web Audio 5.1 PCM; pass 1, 2 or 6 Float32Array channels');
  const length = channels[0]?.length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length)
      throw new TypeError('Loudness channels need equal-length Float32Arrays; decode or copy the PCM first');
    for (const value of channel) if (!Number.isFinite(value))
      throw new TypeError('Loudness needs finite PCM; remove NaN and Infinity from every channel including LFE');
  }
  return length;
}

function mean(values: ArrayLike<number>, start = 0, end = values.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += values[i];
  return end > start ? sum / (end - start) : 0;
}

/** Measure decoded finite PCM with BS.1770 K-weighting/gates and EBU 400 ms/3 s windows. Default rate 48000 Hz. */
export function measureLoudness(channels: readonly Float32Array[], sampleRate = 48000): LoudnessReport {
  const length = validate(channels, sampleRate), hop = sampleRate / 100;
  const energy = new Float64Array(Math.floor(length / hop));
  const weights = channels.length === 6 ? [1, 1, 1, 0, 1.41, 1.41] : channels.map(() => 1);
  const coefficients = loudnessFilters(sampleRate);
  for (let channel = 0; channel < channels.length; channel++) {
    if (weights[channel] === 0) continue;
    const state = coefficients.map(() => new Float64Array(4));
    for (let n = 0; n < length; n++) {
      let value = channels[channel][n];
      for (let stage = 0; stage < 2; stage++) {
        const c = coefficients[stage], s = state[stage];
        const out = c[0] * value + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3];
        s[1] = s[0]; s[0] = value; s[3] = s[2]; s[2] = out;
        value = out;
      }
      const block = Math.floor(n / hop);
      if (block < energy.length) energy[block] += value * value * weights[channel];
    }
  }
  for (let i = 0; i < energy.length; i++) energy[i] /= hop;
  const momentaryHistory = new Float64Array(Math.max(0, energy.length - 39));
  const shortTermHistory = new Float64Array(Math.max(0, energy.length - 299));
  const powers: number[] = [];
  let maximumMomentary = -Infinity, maximumShortTerm = -Infinity;
  for (let end = 40; end <= energy.length; end++) {
    const power = mean(energy, end - 40, end), loudness = level(power);
    momentaryHistory[end - 40] = loudness;
    maximumMomentary = Math.max(maximumMomentary, loudness);
    if ((end - 40) % 10 === 0) powers.push(power);
  }
  for (let end = 300; end <= energy.length; end++) {
    const loudness = level(mean(energy, end - 300, end));
    shortTermHistory[end - 300] = loudness;
    maximumShortTerm = Math.max(maximumShortTerm, loudness);
  }
  const absolute = 10 ** ((-70 + 0.691) / 10);
  const surviving = powers.filter((power) => power > absolute);
  const relative = mean(surviving) / 10;
  const gated = surviving.filter((power) => power > relative);
  return {
    integrated: level(mean(gated)),
    momentary: momentaryHistory.at(-1) ?? -Infinity, shortTerm: shortTermHistory.at(-1) ?? -Infinity,
    maximumMomentary, maximumShortTerm, momentaryHistory, shortTermHistory,
    blocks: powers.length, gatedBlocks: gated.length, duration: length / sampleRate,
    truePeak: measureTruePeak(channels),
  };
}

/** Normalise owned PCM copies by constant gain, respecting the finite-FIR peak cap; default target -23 LUFS. */
export function normalizeLoudness(
  channels: readonly Float32Array[], sampleRate = 48000, options: NormalizeLoudnessOptions = {},
): NormalizedLoudness {
  const target = bounded(options.target ?? -23, -70, 0, 'Loudness target');
  if (target === -70) throw new RangeError('Loudness target must be above the -70 LUFS gate; choose -23 or another higher target');
  const maxPeak = bounded(options.maxTruePeak ?? -1, -96, 0, 'Loudness maxTruePeak');
  const before = measureLoudness(channels, sampleRate);
  if (!Number.isFinite(before.integrated))
    throw new MargoError('state', `Normalisation needs at least one complete 400 ms block above -70 LUFS; supply a measurable programme. ${help}`);
  const desired = 10 ** ((target - before.integrated) / 20);
  // The FIR L1 norm is below 2.1; this margin exceeds its worst-case float32 output-rounding error.
  const cap = 10 ** (maxPeak / 20) * (1 - 2 ** -22) / before.truePeak;
  const gain = Math.min(desired, cap);
  const output = channels.map((channel) => Float32Array.from(channel, (value) => value * gain));
  return { channels: output, gainDb: 20 * Math.log10(gain), peakLimited: cap < desired,
    before, after: measureLoudness(output, sampleRate) };
}
