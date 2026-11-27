import { rangeError, typeError } from '../../shared/errors.js';
import { sincRenderer } from './sinc.js';
import { envelopeCorrection } from './vocoder-envelope.js';
import { phaseStretch } from './vocoder-phase.js';
import { nearestPowerOfTwo, overlapStretch, percussivePart } from './vocoder-split.js';

// Offline time-stretch and pitch shift for music and any dense mix, for Node, workers and pages: no Web Audio. Clean
// room, from the papers only (each module lists its own):
//  - J. L. Flanagan and R. M. Golden, "Phase vocoder", BSTJ 45(9), 1966, doi:10.1002/j.1538-7305.1966.tb01706.x, and
//    M. Portnoff, "Implementation of the digital phase vocoder using the fast Fourier transform", IEEE TASSP 24(3),
//    1976: the short-time Fourier framework.
//  - J. Laroche and M. Dolson, "Improved phase vocoder time-scale modification of audio", IEEE TSAP 7(3), 1999,
//    doi:10.1109/89.759041: the loss of phase coherence across frequency ("phasiness") and phase locking around peaks,
//    compared and not used, as it needs a peak picker and is weaker on dense polyphony.
//  - A. Roebel, "A new approach to transient processing in the phase vocoder", DAFx 2003: detecting transients and
//    resetting their phase, compared; the split below needs no detector.
//  - Z. Prusa and N. Holighaus, "Phase vocoder done right", EUSIPCO 2017: the phase integration used (vocoder-phase.ts).
//  - J. Driedger, M. Mueller and S. Ewert, IEEE SPL 21(1), 2014: the harmonic-percussive split (vocoder-split.ts).
//  - L. Fierro and V. Valimaki, "Enhanced fuzzy decomposition of sound into sines, transients and noise", J. Audio Eng.
//    Soc. 71, 2023, https://arxiv.org/abs/2210.14041: a three-way split, compared and not built.
//  - A. Roebel and X. Rodet, DAFx 2005: the spectral envelope for formant preservation (vocoder-envelope.ts).
//  - Pitch shift as a time stretch followed by band-limited resampling: Laroche and Dolson, WASPAA 1999; sinc.ts.

/** Audio as `decodeWav` returns it: a rate and one Float32Array per channel. */
export interface VocoderAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Options shared by {@link timeStretch} and {@link pitchShift}. */
export interface VocoderOptions {
  /**
   * When lengthening (`factor * 2 ** (semitones / 12)` above 1), stretch drum hits, consonants and other attacks apart
   * from the sustained sound, so they stay sharp. Default true; false runs the phase vocoder on everything, which
   * softens attacks.
   */
  transients?: boolean;
  /** Keep the spectral envelope (a voice's or instrument's formants) where it is while the pitch moves. Default false. */
  preserveFormants?: boolean;
  /**
   * With `preserveFormants`, the finest detail of the envelope as a time in milliseconds, 0.2 to 10: shorter follows
   * the envelope more loosely. Keep it under the pitch period of the highest note. Default 2.
   */
  envelopeMs?: number;
  /**
   * Window of the phase vocoder in milliseconds, 20 to 200, rounded to the nearest power of two in samples. Longer
   * separates close low notes better; shorter follows fast changes. Default 85 (4096 samples at 44.1 and 48 kHz).
   */
  frameMs?: number;
  /** Stops the work between blocks of frames; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** Options of {@link timeStretch}. */
export interface TimeStretchOptions extends VocoderOptions {
  /** Pitch change applied in the same pass, in semitones from -24 to 24 (fractions allowed). Default 0. */
  semitones?: number;
}

/** Output samples resampled between two yields to the event loop. */
const BLOCK = 16384;

const yieldTurn = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve));
};

function check(audio: VocoderAudio, factor: number, options: TimeStretchOptions) {
  if (!audio || typeof audio !== 'object' || !Array.isArray(audio.channels) || !audio.channels.length)
    throw typeError('Pass {sampleRate, channels} audio with at least one channel', 'audio-vocoder');
  const { sampleRate, channels } = audio;
  if (channels.length > 32 || !channels.every((c) => c instanceof Float32Array && c.length === channels[0].length))
    throw rangeError('Pass 1 to 32 channels, each a Float32Array of the same length', 'audio-vocoder');
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000)
    throw rangeError('sampleRate must be a whole number from 1 to 768000', 'audio-vocoder');
  if (!(factor >= 0.25 && factor <= 4)) throw rangeError('factor must be from 0.25 to 4', 'audio-vocoder');
  const { semitones = 0, envelopeMs = 2, frameMs = 85 } = options;
  if (!(semitones >= -24 && semitones <= 24)) throw rangeError('semitones must be from -24 to 24', 'audio-vocoder');
  if (!(envelopeMs >= 0.2 && envelopeMs <= 10)) throw rangeError('envelopeMs must be from 0.2 to 10', 'audio-vocoder');
  if (!(frameMs >= 20 && frameMs <= 200)) throw rangeError('frameMs must be from 20 to 200', 'audio-vocoder');
  for (const c of channels)
    for (let i = 0; i < c.length; i++)
      if (!Number.isFinite(c[i])) throw rangeError('Every sample must be a finite number', 'audio-vocoder');
  return { semitones, envelopeMs, frameMs };
}

/**
 * Makes audio `factor` times as long at the same pitch with a phase vocoder, for music and dense mixes: 1.25 is 25 %
 * longer (slower), 0.8 is 20 % shorter (faster). The output holds `round(length * factor)` samples; `semitones` moves
 * the pitch in the same pass. All channels are turned by the same phase, so the stereo image stays. The input is not
 * changed. The work yields to the event loop as it goes, so a page stays responsive and `signal` can stop it.
 *
 * @example
 * import {timeStretch} from '@margoengine/audio/vocoder';
 * const take = {sampleRate: 48000, channels: [new Float32Array(48000)]};
 * const slower = await timeStretch(take, 1.25);
 * console.log(slower.channels[0].length); // 60000
 * @throws RangeError or TypeError (as a rejection) for bad audio or an option out of range; the signal's reason.
 */
export async function timeStretch(
  audio: VocoderAudio,
  factor: number,
  options: TimeStretchOptions = {},
): Promise<VocoderAudio> {
  const { semitones, envelopeMs, frameMs } = check(audio, factor, options),
    { transients = true, preserveFormants = false, signal } = options;
  signal?.throwIfAborted();
  const { sampleRate, channels } = audio,
    length = channels[0].length,
    outLength = Math.round(length * factor),
    // A pitch shift is a stretch by factor * ratio, read back `ratio` times as fast.
    ratio = 2 ** (semitones / 12),
    resultLength = ratio === 1 ? outLength : Math.round(outLength * ratio),
    stretch = factor * ratio,
    formants = preserveFormants && ratio !== 1;
  if (factor === 1 && ratio === 1) return { sampleRate, channels: channels.map((c) => c.slice()) };
  if (!length || !outLength) return { sampleRate, channels: channels.map(() => new Float32Array(outLength)) };
  const pause = async () => {
    await yieldTurn();
    signal?.throwIfAborted();
  };
  // The first turn: work on the caller's arrays starts after this call has returned, even for a short signal.
  await pause();
  let stretched: readonly Float32Array[] = channels;
  if (stretch !== 1 || formants) {
    const size = nearestPowerOfTwo((frameMs * sampleRate) / 1000, 64, 32768),
      out = channels.map(() => new Float32Array(Math.max(1, resultLength))),
      gain = formants ? envelopeCorrection(2 * size, ratio, (envelopeMs * sampleRate) / 1000) : undefined;
    let harmonic: readonly Float32Array[] = channels;
    // Compressing keeps attacks sharp in the vocoder itself; only lengthening smears them.
    if (transients && stretch > 1) {
      const percussive = await percussivePart(channels, sampleRate, pause);
      await overlapStretch(percussive, out, stretch, sampleRate, pause);
      // The percussive arrays become the harmonic part: input minus percussive.
      for (let c = 0; c < channels.length; c++) {
        const x = channels[c],
          p = percussive[c];
        for (let i = 0; i < length; i++) p[i] = x[i] - p[i];
      }
      harmonic = percussive;
    }
    await phaseStretch(harmonic, out, stretch, size, pause, gain);
    stretched = out;
  }
  if (ratio === 1) return { sampleRate, channels: stretched as Float32Array[] };
  const result = channels.map(() => new Float32Array(outLength)),
    render = sincRenderer(ratio, 1);
  for (let from = 0; from < outLength; from += BLOCK) {
    render(stretched, result, from, Math.min(outLength, from + BLOCK));
    await pause();
  }
  return { sampleRate, channels: result };
}

/**
 * Moves the pitch of audio by `semitones` (12 is an octave up, -12 down, fractions allowed) at the same length:
 * {@link timeStretch} with a factor of 1.
 *
 * @example
 * import {pitchShift} from '@margoengine/audio/vocoder';
 * const voice = {sampleRate: 48000, channels: [new Float32Array(48000)]};
 * const higher = await pitchShift(voice, 3, {preserveFormants: true});
 * console.log(higher.channels[0].length); // 48000
 * @throws RangeError or TypeError (as a rejection) for bad audio or an option out of range; the signal's reason.
 */
export function pitchShift(
  audio: VocoderAudio,
  semitones: number,
  options: VocoderOptions = {},
): Promise<VocoderAudio> {
  return timeStretch(audio, 1, { ...options, semitones });
}
