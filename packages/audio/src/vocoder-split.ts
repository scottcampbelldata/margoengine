// The transient path of the vocoder: the signal is split into harmonic and percussive parts by median filtering its
// magnitude spectrogram along time and along frequency (D. Fitzgerald, "Harmonic/percussive separation using median
// filtering", DAFx 2010), the percussive part is stretched by overlap-add with a very short window so attacks stay
// sharp, and the rest goes to the phase vocoder (J. Driedger, M. Mueller and S. Ewert, "Improving time-scale
// modification of music signals using harmonic-percussive separation", IEEE Signal Processing Letters 21(1), 2014,
// doi:10.1109/LSP.2013.2294023). A bin counts as percussive only where its frequency median is more than the separation
// factor times its time median (J. Driedger, M. Mueller and S. Disch, "Extending harmonic-percussive separation of
// audio signals", ISMIR 2014), so beating chords stay with the phase vocoder. No transient detector.
import { fftPlan, inverseRealPair, realPair } from './spectrogram-fft.js';

/** Seconds of the harmonic (time) median and hertz of the percussive (frequency) median (Driedger 2014). */
const TIME_MEDIAN = 0.2,
  FREQUENCY_MEDIAN = 500;
/** The separation factor: how far the frequency median must stand above the time median for a percussive bin. */
const SEPARATION = 2;
const FRAMES_PER_TURN = 64;

/** The power of two nearest to `n` on a log scale, within [low, high]. */
export const nearestPowerOfTwo = (n: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, 2 ** Math.round(Math.log2(n))));

const hann = (size: number) =>
  Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));

/** Replaces `old` with `value` in the ascending run `sorted[at .. at + n)`, keeping it ascending. */
function replace(sorted: Float64Array, at: number, n: number, old: number, value: number): void {
  let i = at;
  const end = at + n - 1;
  while (i < end && sorted[i] < old) i++;
  if (value > old) while (i < end && sorted[i + 1] < value) sorted[i] = sorted[++i];
  else while (i > at && sorted[i - 1] > value) sorted[i] = sorted[--i];
  sorted[i] = value;
}

/** The percussive part of every channel; the harmonic part is the input minus it, sample for sample. */
export async function percussivePart(
  channels: readonly Float32Array[],
  sampleRate: number,
  pause: () => Promise<void>,
): Promise<Float32Array[]> {
  const count = channels.length,
    length = channels[0].length,
    size = nearestPowerOfTwo(sampleRate * 0.023, 64, 8192),
    hop = size / 4,
    bins = size / 2 + 1,
    odd = (n: number) => 2 * Math.max(1, Math.round((n - 1) / 2)) + 1,
    times = odd((TIME_MEDIAN * sampleRate) / hop),
    lag = (times - 1) / 2,
    spread = (odd(Math.min(bins, (FREQUENCY_MEDIAN * size) / sampleRate)) - 1) / 2,
    plan = fftPlan(size),
    window = hann(size),
    // Frames centred on k * hop for every k whose window reaches the signal.
    first = -1,
    frames = Math.floor((length + size / 2 - 1) / hop) - first + 1,
    weight = new Float64Array(hop);
  for (let i = 0; i < size; i++) weight[i % hop] += window[i] * window[i];
  // The spectra still waiting for the time median's later frames.
  const held = Array.from({ length: lag + 1 }, () => ({
      re: channels.map(() => new Float64Array(bins)),
      im: channels.map(() => new Float64Array(bins)),
      magnitude: new Float64Array(bins),
    })),
    history = Array.from({ length: times }, () => new Float64Array(bins)),
    sorted = new Float64Array(bins * times),
    band = new Float64Array(2 * spread + 1),
    a = new Float64Array(size),
    b = new Float64Array(size),
    zr = new Float64Array(size),
    zi = new Float64Array(size),
    keepRe = [new Float64Array(bins), new Float64Array(bins)],
    keepIm = [new Float64Array(bins), new Float64Array(bins)],
    spare = { re: new Float64Array(bins), im: new Float64Array(bins) },
    mask = new Uint8Array(bins),
    out = channels.map(() => new Float32Array(length));

  const analyse = (f: number) => {
    const slot = held[f % (lag + 1)],
      start = (f + first) * hop - size / 2;
    for (let c = 0; c < count; c += 2) {
      const second = c + 1 < count;
      for (let i = 0; i < size; i++) {
        const j = start + i,
          inside = j >= 0 && j < length;
        a[i] = inside ? channels[c][j] * window[i] : 0;
        b[i] = inside && second ? channels[c + 1][j] * window[i] : 0;
      }
      realPair(
        plan,
        a,
        b,
        zr,
        zi,
        slot.re[c],
        slot.im[c],
        second ? slot.re[c + 1] : spare.re,
        second ? slot.im[c + 1] : spare.im,
      );
    }
    for (let k = 0; k < bins; k++) {
      let p = 0;
      for (let c = 0; c < count; c++) p += slot.re[c][k] ** 2 + slot.im[c][k] ** 2;
      slot.magnitude[k] = Math.sqrt(p);
    }
  };

  const resynthesise = (f: number) => {
    const slot = held[f % (lag + 1)],
      magnitude = slot.magnitude,
      at = (k: number) => magnitude[Math.max(0, Math.min(bins - 1, k))];
    // The frequency median, sliding up the bins; the edge bins stand in for those outside.
    for (let i = 0; i < band.length; i++) band[i] = at(i - spread);
    band.sort();
    for (let k = 0; k < bins; k++) {
      if (k > 0) replace(band, 0, band.length, at(k - 1 - spread), at(k + spread));
      mask[k] = band[spread] > SEPARATION * sorted[k * times + lag] ? 1 : 0;
    }
    const start = (f + first) * hop - size / 2;
    for (let c = 0; c < count; c += 2) {
      const pair = Math.min(2, count - c);
      for (let p = 0; p < 2; p++)
        for (let k = 0; k < bins; k++) {
          const on = p < pair && mask[k] === 1;
          keepRe[p][k] = on ? slot.re[c + p][k] : 0;
          keepIm[p][k] = on ? slot.im[c + p][k] : 0;
        }
      inverseRealPair(plan, keepRe[0], keepIm[0], keepRe[1], keepIm[1], zr, zi, a, b);
      for (let p = 0; p < pair; p++) {
        const y = p ? b : a,
          to = out[c + p];
        for (let i = Math.max(0, -start); i < Math.min(size, length - start); i++)
          to[start + i] += (y[i] * window[i]) / weight[i % hop];
      }
    }
  };

  for (let j = 0; j < frames + lag; j++) {
    if (j < frames) analyse(j);
    // Past either end the first and last frames stand in for the missing ones.
    const magnitude = held[Math.min(j, frames - 1) % (lag + 1)].magnitude;
    if (j === 0) {
      for (const h of history) h.set(magnitude);
      for (let k = 0; k < bins; k++) sorted.fill(magnitude[k], k * times, (k + 1) * times);
    } else {
      const old = history[j % times];
      for (let k = 0; k < bins; k++) replace(sorted, k * times, times, old[k], magnitude[k]);
      old.set(magnitude);
    }
    if (j >= lag) resynthesise(j - lag);
    if (j % FRAMES_PER_TURN === FRAMES_PER_TURN - 1) await pause();
  }
  return out;
}

/**
 * Adds `input`, made longer by `stretch` (above 1), into `output` by plain overlap-add with a window of about 6 ms (OLA,
 * Driedger and Mueller, "A review of time-scale modification of music signals", Applied Sciences 6(2):57, 2016,
 * section 3).
 */
export async function overlapStretch(
  input: readonly Float32Array[],
  output: readonly Float32Array[],
  stretch: number,
  sampleRate: number,
  pause: () => Promise<void>,
): Promise<void> {
  const size = nearestPowerOfTwo(sampleRate * 0.0058, 16, 2048),
    half = size / 2,
    length = input[0].length,
    outLength = output[0].length,
    // Periodic Hann windows half a window apart sum to 1.
    window = hann(size),
    last = Math.floor((outLength + half - 1) / half);
  for (let n = 0; n <= last; n++) {
    const at = n * half,
      centre = Math.round(at / stretch),
      from = Math.max(0, half - at, half - centre),
      to = Math.min(size, outLength + half - at, length + half - centre);
    for (let c = 0; c < input.length; c++)
      for (let i = from; i < to; i++) output[c][at - half + i] += window[i] * input[c][centre - half + i];
    if (n % 1024 === 1023) await pause();
  }
}
