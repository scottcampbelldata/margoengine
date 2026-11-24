import { rangeError, typeError } from '../../shared/errors.js';

// Quality checks of decoded audio for Node, workers and pages: no Web Audio, no DOM. A narration or a mix is read with
// `decodeWav` (or any decoder giving Float32Array channels) and scanned here for clipped runs and for silences.
//
// Sources (read clean room, no other library's code):
//  - AES17-2020, "AES standard method for digital audio engineering: Measurement of digital audio equipment": full
//    scale is the largest positive sample; 0 dBFS is the RMS of a sine whose peak reaches full scale, so a level in
//    dBFS is 20 log10(sqrt(2) RMS). A full-scale square wave reads +3.01 dBFS.
//  - IEC 61606-3:2008 and EBU Tech 3341 (2016): a sample peak is the largest |x|; a true peak needs oversampling
//    (`@margoengine/mixer/loudness` measures that). A clip is not one sample at the rail but several in a row.
//  - S. Aleinik, Y. Matveev, A. Raev, "Detection of clipped fragments in speech signals", International Journal of
//    Electrical, Computer, Energetic, Electronic and Communication Engineering 8(2), 2014: clipping shows as runs of
//    consecutive samples held at (or near) the extreme amplitude; a lone extreme sample is an ordinary peak.
//  - J. Eaton, P. Naylor, "Detection of clipping in coded speech signals", EUSIPCO 2013: the run-length criterion
//    survives decoding, where clipped plateaus are no longer exactly flat, so the level sits just under full scale.
//  - ITU-R BS.1770-5 (2023): levels over short blocks of the mean square of all channels, the basis of the window
//    level here (without K-weighting, which is for loudness, not for "is anything there").
//  - ITU-T P.56 (2011), "Objective measurement of active speech level": speech activity is decided on short-term
//    envelope against a threshold with a hangover, so a pause shorter than the hangover is not inactivity; here a
//    silence is a run of windows under the floor that lasts at least `minSeconds`.

/** One clipped run: at least `run` samples in a row on one channel at or over `level` of full scale (either sign). */
export interface ClipRun {
  /** The channel index. */
  channel: number;
  /** First sample of the run. */
  startSample: number;
  /** Samples in the run. */
  length: number;
  /** Seconds from the start: `startSample / sampleRate`. */
  start: number;
  /** Seconds: `(startSample + length) / sampleRate`. */
  end: number;
}

/** Options of {@link scanClipping}. */
export interface ClippingOptions {
  /** Share of full scale (0 to 1) a sample's magnitude must reach to sit at the rail. Default 0.999 (-0.009 dBFS
   * sample peak), which also catches clipped audio that went through a lossy codec. */
  level?: number;
  /** Samples in a row at the rail that make a clip. Default 3: one full-scale sample is a peak, not a clip. */
  run?: number;
}

/** What {@link scanClipping} gives back. */
export interface ClippingReport {
  /** Every clipped run, ordered by start time, then channel. */
  runs: ClipRun[];
  /** Samples inside the runs, all channels. */
  clippedSamples: number;
  /** The largest |sample| anywhere (the sample peak, linear). */
  peak: number;
}

/** Options of {@link findSilences}. */
export interface SilenceOptions {
  /** A window whose level (dBFS, AES17: a full-scale sine is 0) is under this is silent. Default -50. */
  floorDb?: number;
  /** Silences shorter than this many seconds are not reported (pauses between words). Default 2. */
  minSeconds?: number;
  /** Window length in seconds. Default 0.01: 10 ms, so edges are found to within 10 ms. */
  window?: number;
  /** Only look inside these `[start, end]` spans in seconds (a section of a script, say); a silence never crosses a
   * span's edge. Default: the whole signal. */
  spans?: ReadonlyArray<readonly [number, number]>;
}

/** One silence: windows under the floor, in a row, lasting at least `minSeconds`. */
export interface Silence {
  /** Seconds from the start of the signal. */
  start: number;
  /** Seconds from the start of the signal. */
  end: number;
  /** `end - start`. */
  duration: number;
  /** The loudest window inside, in dBFS (AES17); -Infinity when every sample is zero. */
  level: number;
}

type Channels = ArrayLike<number> | ReadonlyArray<ArrayLike<number>>;

/** One channel or a list of them, all the same length. */
function channelsOf(input: Channels, name: string): ArrayLike<number>[] {
  const isChannel = (value: unknown): value is ArrayLike<number> =>
    ArrayBuffer.isView(value) || (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number');
  const list = isChannel(input) ? [input] : Array.isArray(input) ? (input as ArrayLike<number>[]) : null;
  if (!list || !list.length || !list.every(isChannel))
    throw typeError(`${name} needs a channel (a Float32Array) or an array of channels`, 'audio-scan');
  if (list.some((channel) => channel.length !== list[0].length))
    throw rangeError(`${name} needs channels of one length`, 'audio-scan');
  return list;
}

const checkRate = (sampleRate: number, name: string) => {
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) throw rangeError(`${name} needs a sampleRate above 0`, 'audio-scan');
};

/**
 * Finds clipped runs in decoded audio: `run` or more samples in a row on one channel whose magnitude is at or over
 * `level` of full scale. `channels` is one channel or an array of them (`decodeWav(file).channels`).
 */
export function scanClipping(channels: Channels, sampleRate: number, options: ClippingOptions = {}): ClippingReport {
  const list = channelsOf(channels, 'scanClipping');
  checkRate(sampleRate, 'scanClipping');
  const { level = 0.999, run = 3 } = options;
  if (!(level > 0 && level <= 1)) throw rangeError('scanClipping needs a level above 0 and at most 1', 'audio-scan');
  if (!(Number.isInteger(run) && run >= 1)) throw rangeError('scanClipping needs a run of 1 or more samples', 'audio-scan');
  const runs: ClipRun[] = [];
  let clippedSamples = 0,
    peak = 0;
  list.forEach((data, channel) => {
    let length = 0;
    for (let i = 0; i <= data.length; i++) {
      const magnitude = i < data.length ? Math.abs(data[i]) : 0;
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= level) {
        length++;
        continue;
      }
      if (length >= run) {
        const startSample = i - length;
        runs.push({ channel, startSample, length, start: startSample / sampleRate, end: i / sampleRate });
        clippedSamples += length;
      }
      length = 0;
    }
  });
  runs.sort((a, b) => a.startSample - b.startSample || a.channel - b.channel);
  return { runs, clippedSamples, peak };
}

/**
 * Finds silences: runs of windows whose level (the mean square of all channels, in dBFS as AES17 defines it) is under
 * `floorDb`, lasting at least `minSeconds`, inside `spans` when given. A trailing partial window counts by its own
 * samples.
 */
export function findSilences(samples: Channels, sampleRate: number, options: SilenceOptions = {}): Silence[] {
  const list = channelsOf(samples, 'findSilences');
  checkRate(sampleRate, 'findSilences');
  const { floorDb = -50, minSeconds = 2, window = 0.01 } = options;
  if (!Number.isFinite(floorDb)) throw rangeError('findSilences needs a finite floorDb', 'audio-scan');
  if (!(minSeconds >= 0 && minSeconds < Infinity)) throw rangeError('findSilences needs minSeconds of 0 or more', 'audio-scan');
  const size = Math.round(window * sampleRate);
  if (!(size >= 1)) throw rangeError('findSilences needs a window of at least one sample', 'audio-scan');
  const total = list[0].length,
    duration = total / sampleRate,
    spans = options.spans ?? [[0, duration]];
  for (const span of spans)
    if (!(span.length === 2 && Number.isFinite(span[0]) && Number.isFinite(span[1]) && span[0] <= span[1]))
      throw rangeError('findSilences needs spans of [start, end] seconds with start <= end', 'audio-scan');
  // Mean square of a sine at full scale is 1/2; AES17 calls that 0 dBFS.
  const floor = 0.5 * 10 ** (floorDb / 10),
    toDb = (meanSquare: number) => 10 * Math.log10(2 * meanSquare);
  const found: Silence[] = [];
  for (const [from, to] of spans) {
    const first = Math.max(0, Math.round(from * sampleRate)),
      last = Math.min(total, Math.round(to * sampleRate));
    let start = -1,
      loudest = 0;
    const close = (end: number) => {
      if (start >= 0 && (end - start) / sampleRate >= minSeconds)
        found.push({
          start: start / sampleRate,
          end: end / sampleRate,
          duration: (end - start) / sampleRate,
          level: loudest > 0 ? toDb(loudest) : -Infinity,
        });
      start = -1;
      loudest = 0;
    };
    for (let at = first; at < last; at += size) {
      const end = Math.min(at + size, last);
      let sum = 0;
      for (const data of list) for (let i = at; i < end; i++) sum += data[i] * data[i];
      const meanSquare = sum / ((end - at) * list.length);
      if (meanSquare < floor) {
        if (start < 0) start = at;
        if (meanSquare > loudest) loudest = meanSquare;
      } else close(at);
    }
    close(last);
  }
  return found.sort((a, b) => a.start - b.start);
}
