import { rangeError, typeError } from '../../shared/errors.js';

// Offline time-scale modification that keeps pitch, for Node, workers and pages: no Web Audio. A narration section or
// a recorded take is made a few percent longer or shorter to fit its slot, at the same pitch.
//
// Sources (read clean room, no other library's code):
//  - W. Verhelst and M. Roelands, "An overlap-add technique based on waveform similarity (WSOLA) for high quality
//    time-scale modification of speech", ICASSP 1993, doi:10.1109/ICASSP.1993.319366: analysis frames are taken near
//    their nominal place in the input, each shifted within a tolerance to the position whose waveform best matches
//    the natural continuation of the frame taken before it, then overlap-added at a fixed synthesis hop.
//  - S. Roucos and A. M. Wilgus, "High quality time-scale modification for speech", ICASSP 1985,
//    doi:10.1109/ICASSP.1985.1168381 (SOLA): aligning frames by cross-correlation before overlap-add, the step WSOLA
//    moves to the analysis side.
//  - J. Driedger and M. Mueller, "A Review of Time-Scale Modification of Music Signals", Applied Sciences 6(2):57,
//    2016, doi:10.3390/app6020057, section 3: the OLA and WSOLA formulation used here (Hann window, synthesis hop of
//    half a frame, analysis hop = synthesis hop / factor, the signal padded by half a frame at both ends, overlap-add
//    normalised by the summed windows), and why WSOLA suits speech while a phase vocoder suits music.
//  - J. L. Flanagan and R. M. Golden, "Phase vocoder", Bell System Technical Journal 45(9), 1966,
//    doi:10.1002/j.1538-7305.1966.tb01706.x, and J. Laroche and M. Dolson, "Improved phase vocoder time-scale
//    modification of audio", IEEE Transactions on Speech and Audio Processing 7(3), 1999, doi:10.1109/89.759041:
//    compared and not used here; for speech they smear transients and add phasiness that WSOLA avoids.

/** Audio as `decodeWav` returns it: a rate and one Float32Array per channel. */
export interface StretchInput {
  sampleRate: number;
  channels: Float32Array[];
}

/** Options of {@link timeStretch}. */
export interface StretchOptions {
  /** Frame length in milliseconds, 10 to 200; the synthesis hop is half of it. Default 40, a few pitch periods of speech. */
  frameMs?: number;
  /** How far, in milliseconds, a frame may move from its nominal place to match the waveform, 1 to 50. Default 10. */
  toleranceMs?: number;
}

/** Decimation of the coarse search; the best coarse shift is then refined sample by sample. */
const COARSE = 4;

/**
 * Makes audio `factor` times as long at the same pitch by WSOLA (Verhelst and Roelands 1993): 1.05 is 5 % longer
 * (slower), 0.95 is 5 % shorter (faster). The output holds `round(length * factor)` samples. Every channel uses the
 * same frame positions, chosen on their mean, so the stereo image stays put. A factor of 1 copies the samples.
 *
 * @example
 * import {timeStretch} from '@margoengine/audio/stretch';
 * const take = {sampleRate: 48000, channels: [new Float32Array(48000)]};
 * const faster = timeStretch(take, 0.95);
 * console.log(faster.channels[0].length); // 45600
 * @throws RangeError for a factor outside 0.25 to 4 or an option out of range.
 */
export function timeStretch(audio: StretchInput, factor: number, options: StretchOptions = {}): StretchInput {
  if (!audio || typeof audio !== 'object' || !Array.isArray(audio.channels) || !audio.channels.length)
    throw typeError('Pass {sampleRate, channels} audio with at least one channel', 'audio-stretch');
  const { sampleRate, channels } = audio;
  if (!channels.every((c) => c instanceof Float32Array && c.length === channels[0].length))
    throw rangeError('Every channel must be a Float32Array of the same length', 'audio-stretch');
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000)
    throw rangeError('sampleRate must be a whole number from 1 to 768000', 'audio-stretch');
  if (!(factor >= 0.25 && factor <= 4)) throw rangeError('factor must be from 0.25 to 4', 'audio-stretch');
  const { frameMs = 40, toleranceMs = 10 } = options;
  if (!(frameMs >= 10 && frameMs <= 200)) throw rangeError('frameMs must be from 10 to 200', 'audio-stretch');
  if (!(toleranceMs >= 1 && toleranceMs <= 50)) throw rangeError('toleranceMs must be from 1 to 50', 'audio-stretch');
  const length = channels[0].length,
    outLength = Math.round(length * factor);
  if (factor === 1) return { sampleRate, channels: channels.map((c) => c.slice()) };
  const half = Math.max(2, Math.round((frameMs * sampleRate) / 2000)),
    frame = 2 * half,
    synthesis = half,
    analysis = synthesis / factor,
    tolerance = Math.max(1, Math.round((toleranceMs * sampleRate) / 1000));
  // The periodic Hann window: at a hop of half a frame the windows sum to 1.
  const window = Float64Array.from({ length: frame }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame));
  const mono = new Float32Array(length);
  for (const c of channels) for (let i = 0; i < length; i++) mono[i] += c[i] / channels.length;
  // Samples outside the input are silence; a frame's index is its centre, so the padding is half a frame.
  const at = (i: number) => (i >= 0 && i < length ? mono[i] : 0);
  const correlate = (a: number, b: number, step: number) => {
    let sum = 0;
    for (let i = 0; i < frame; i += step) sum += at(a - half + i) * at(b - half + i);
    return sum;
  };
  const frames = Math.ceil(outLength / synthesis) + 1,
    out = channels.map(() => new Float32Array(outLength)),
    weight = new Float64Array(outLength);
  let previous = 0;
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * analysis);
    let position = nominal;
    if (k > 0) {
      // The natural continuation of the frame before: where it would have gone on in the input.
      const natural = previous + synthesis;
      let best = 0,
        score = -Infinity;
      for (let d = -tolerance; d <= tolerance; d += COARSE) {
        const s = correlate(natural, nominal + d, COARSE);
        if (s > score) [score, best] = [s, d];
      }
      const coarse = best;
      score = -Infinity;
      for (let d = Math.max(-tolerance, coarse - COARSE + 1); d <= Math.min(tolerance, coarse + COARSE - 1); d++) {
        const s = correlate(natural, nominal + d, 1);
        if (s > score) [score, best] = [s, d];
      }
      position = nominal + best;
    }
    previous = position;
    const start = k * synthesis - half;
    for (let i = 0; i < frame; i++) {
      const o = start + i,
        x = position - half + i;
      if (o < 0 || o >= outLength) continue;
      weight[o] += window[i];
      if (x < 0 || x >= length) continue;
      for (let c = 0; c < channels.length; c++) out[c][o] += window[i] * channels[c][x];
    }
  }
  for (let o = 0; o < outLength; o++) if (weight[o] > 1e-9) for (const c of out) c[o] /= weight[o];
  return { sampleRate, channels: out };
}
