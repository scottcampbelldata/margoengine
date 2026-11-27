// Phase vocoder whose synthesis phase is integrated from both partial derivatives of the STFT phase, largest magnitude
// first: Z. Prusa and N. Holighaus, "Phase vocoder done right", EUSIPCO 2017, https://arxiv.org/abs/2202.07382, with
// the heap integration of Z. Prusa and P. L. Sondergaard, "Real-time spectrogram inversion using phase gradient heap
// integration", DAFx 2016. The derivatives are not finite differences here: they are the reassignment operators of
// F. Auger and P. Flandrin, "Improving the readability of time-frequency and time-scale representations by the
// reassignment method", IEEE Trans. Signal Process. 43(5), 1995, doi:10.1109/78.382394, read from two more transforms
// (the window's derivative and the time-weighted window). They need no phase unwrapping, so they hold at any analysis
// hop. Weighted overlap-add: J. B. Allen and L. R. Rabiner, Proc. IEEE 65(11), 1977.
import { fftPlan, inverseRealPair, realPair } from './spectrogram-fft.js';

/** PV frames between two yields to the event loop. */
const FRAMES_PER_TURN = 16;
/** Bins this far below the loudest of the two frames (-120 dB, as a power ratio) take a random phase (Prusa). */
const TOLERANCE = 1e-12;
const TURN = 2 * Math.PI;

/** What one analysed frame keeps, per channel, for bins 0 to size / 2. */
interface Frame {
  readonly re: Float64Array[];
  readonly im: Float64Array[];
  /** Instantaneous frequency in radians per sample: the phase's derivative over time. */
  readonly omega: Float64Array[];
  /** The loudest channel's power per bin, and which channel that is. */
  readonly power: Float64Array;
  readonly channel: Uint8Array;
  peak: number;
}

/** A binary max-heap of (key, id) pairs on typed arrays. */
class Heap {
  size = 0;
  readonly #keys: Float64Array;
  readonly #ids: Int32Array;
  constructor(capacity: number) {
    this.#keys = new Float64Array(capacity);
    this.#ids = new Int32Array(capacity);
  }
  push(key: number, id: number): void {
    const keys = this.#keys,
      ids = this.#ids;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] >= key) break;
      keys[i] = keys[parent];
      ids[i] = ids[parent];
      i = parent;
    }
    keys[i] = key;
    ids[i] = id;
  }
  pop(): number {
    const keys = this.#keys,
      ids = this.#ids,
      top = ids[0],
      n = --this.size,
      key = keys[n],
      id = ids[n];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && keys[child + 1] > keys[child]) child++;
      if (keys[child] <= key) break;
      keys[i] = keys[child];
      ids[i] = ids[child];
      i = child;
    }
    keys[i] = key;
    ids[i] = id;
    return top;
  }
}

/**
 * Adds `input` stretched by `stretch` into `output` (whose length sets the stretched length). `size` is the window
 * length, a power of two; the transform is twice as long. `gain`, when given, fills a per-bin magnitude correction from
 * each frame's power. Every channel is rotated by the same per-bin angle, so level and phase differences between
 * channels are kept.
 */
export async function phaseStretch(
  input: readonly Float32Array[],
  output: readonly Float32Array[],
  stretch: number,
  size: number,
  pause: () => Promise<void>,
  gain?: (power: Float64Array, gains: Float64Array) => void,
): Promise<void> {
  const count = input.length,
    length = input[0].length,
    outLength = output[0].length,
    half = size / 2,
    points = 2 * size,
    bins = size + 1,
    step = TURN / points,
    plan = fftPlan(points),
    // A synthesis hop of a quarter window, shorter when speeding up so the analysis hop stays within a quarter too.
    hop = Math.max(1, Math.round((Math.min(1, stretch) * size) / 4)),
    // The centred periodic Hann window, its derivative per sample, and time (from the centre) times the window.
    window = Float64Array.from({ length: size }, (_, i) => 0.5 + 0.5 * Math.cos((TURN * (i - half)) / size)),
    slope = Float64Array.from({ length: size }, (_, i) => (-Math.PI / size) * Math.sin((TURN * (i - half)) / size)),
    ramp = window.map((w, i) => (i - half) * w),
    // The summed squared windows repeat every hop.
    weight = new Float64Array(hop),
    mod = (t: number) => ((t % hop) + hop) % hop;
  for (let i = 0; i < size; i++) weight[mod(i - half)] += window[i] * window[i];

  const frame = (): Frame => ({
    re: input.map(() => new Float64Array(bins)),
    im: input.map(() => new Float64Array(bins)),
    omega: input.map(() => new Float64Array(bins)),
    power: new Float64Array(bins),
    channel: new Uint8Array(bins),
    peak: 0,
  });
  let current = frame(),
    previous = frame();
  // The phase's derivative over frequency (minus the reassigned time), per channel, of the current frame only.
  const delay = input.map(() => new Float64Array(bins)),
    scratch = () => new Float64Array(points),
    zr = scratch(),
    zi = scratch(),
    windowed = scratch(),
    sloped = scratch(),
    ramped = scratch(),
    nothing = scratch(),
    dRe = new Float64Array(bins),
    dIm = new Float64Array(bins),
    tRe = new Float64Array(bins),
    tIm = new Float64Array(bins),
    unusedRe = new Float64Array(bins),
    unusedIm = new Float64Array(bins),
    synthesisRe = [new Float64Array(bins), new Float64Array(bins)],
    synthesisIm = [new Float64Array(bins), new Float64Array(bins)],
    synthesis = [scratch(), scratch()],
    gains = gain && new Float64Array(bins),
    // The rotation applied to every channel at each bin: synthesis phase minus analysis phase.
    angle = new Float64Array(bins),
    next = new Float64Array(bins),
    pending = new Uint8Array(bins),
    heap = new Heap(2 * bins);
  // The Hann main lobe is two window bins wide on each side; a component's frequency is held within twice that.
  const reach = (4 * TURN) / size;
  // A fixed-seed generator (a 32-bit linear congruential step), so the same input always gives the same output.
  let seed = 0x2545f491;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * TURN;
  };

  const analyse = (centre: number) => {
    current.power.fill(0);
    current.channel.fill(0);
    current.peak = 0;
    for (let c = 0; c < count; c++) {
      const x = input[c];
      windowed.fill(0);
      sloped.fill(0);
      ramped.fill(0);
      const from = Math.max(0, half - centre),
        to = Math.min(size, length + half - centre);
      for (let i = from; i < to; i++) {
        // The centre of the frame goes to index 0, so phases are measured from it.
        const j = (i + points - half) % points,
          v = x[centre - half + i];
        windowed[j] = v * window[i];
        sloped[j] = v * slope[i];
        ramped[j] = v * ramp[i];
      }
      const re = current.re[c],
        im = current.im[c],
        omega = current.omega[c],
        tau = delay[c];
      realPair(plan, windowed, sloped, zr, zi, re, im, dRe, dIm);
      realPair(plan, ramped, nothing, zr, zi, tRe, tIm, unusedRe, unusedIm);
      for (let k = 0; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        let offset = 0,
          t = 0;
        if (p > 0) {
          offset = Math.max(-reach, Math.min(reach, -(dIm[k] * re[k] - dRe[k] * im[k]) / p));
          t = Math.max(-half, Math.min(half, -(tRe[k] * re[k] + tIm[k] * im[k]) / p));
        }
        omega[k] = step * k + offset;
        tau[k] = t;
        if (p > current.power[k]) {
          current.power[k] = p;
          current.channel[k] = c;
          if (p > current.peak) current.peak = p;
        }
      }
    }
  };

  /** Fills `next` with this frame's rotations, from the previous frame's along time and from neighbours along frequency. */
  const integrate = () => {
    const floor = TOLERANCE * Math.max(current.peak, previous.peak);
    let left = 0;
    heap.size = 0;
    for (let k = 0; k < bins; k++) {
      if (current.power[k] > floor) {
        pending[k] = 1;
        left++;
        heap.push(previous.power[k], 2 * k);
      } else {
        pending[k] = 0;
        next[k] = random();
      }
    }
    while (left > 0) {
      const id = heap.pop(),
        k = id >> 1;
      if ((id & 1) === 0) {
        if (!pending[k]) continue;
        const c = current.channel[k];
        // Energy that was not there a frame ago keeps its analysis phase (a phase reset at onsets).
        next[k] =
          previous.power[k] > floor
            ? angle[k] +
              Math.atan2(previous.im[c][k], previous.re[c][k]) -
              Math.atan2(current.im[c][k], current.re[c][k]) +
              (hop * (previous.omega[c][k] + current.omega[c][k])) / 2
            : 0;
        pending[k] = 0;
        left--;
        heap.push(current.power[k], 2 * k + 1);
      } else
        for (let side = -1; side <= 1; side += 2) {
          const j = k + side;
          if (j < 0 || j >= bins || !pending[j]) continue;
          const c = current.channel[j],
            re = current.re[c],
            im = current.im[c];
          next[j] =
            next[k] +
            Math.atan2(im[k], re[k]) -
            Math.atan2(im[j], re[j]) +
            (side * stretch * step * (delay[c][k] + delay[c][j])) / 2;
          pending[j] = 0;
          left--;
          heap.push(current.power[j], 2 * j + 1);
        }
    }
    for (let k = 0; k < bins; k++) angle[k] = next[k] - TURN * Math.round(next[k] / TURN);
    // The bins at 0 and the Nyquist frequency of a real signal are real.
    angle[0] = angle[bins - 1] = 0;
  };

  const synthesise = (at: number) => {
    if (gain) gain(current.power, gains!);
    for (let c = 0; c < count; c += 2) {
      const pair = Math.min(2, count - c);
      for (let p = 0; p < 2; p++) {
        const outRe = synthesisRe[p],
          outIm = synthesisIm[p];
        if (p >= pair) {
          outRe.fill(0);
          outIm.fill(0);
          continue;
        }
        const re = current.re[c + p],
          im = current.im[c + p];
        for (let k = 0; k < bins; k++) {
          const g = gains ? gains[k] : 1,
            cos = g * Math.cos(angle[k]),
            sin = g * Math.sin(angle[k]);
          outRe[k] = re[k] * cos - im[k] * sin;
          outIm[k] = re[k] * sin + im[k] * cos;
        }
      }
      inverseRealPair(
        plan,
        synthesisRe[0],
        synthesisIm[0],
        synthesisRe[1],
        synthesisIm[1],
        zr,
        zi,
        synthesis[0],
        synthesis[1],
      );
      const from = Math.max(0, half - at),
        to = Math.min(size, outLength + half - at);
      for (let p = 0; p < pair; p++) {
        const out = output[c + p],
          y = synthesis[p];
        for (let i = from; i < to; i++) {
          const o = at - half + i;
          out[o] += (window[i] * y[(i + points - half) % points]) / weight[mod(i - half)];
        }
      }
    }
  };

  // Every frame whose window reaches the output.
  const first = -Math.floor((half - 1) / hop),
    last = Math.floor((outLength + half - 1) / hop);
  for (let n = first; n <= last; n++) {
    analyse(Math.round((n * hop) / stretch));
    if (n === first) angle.fill(0);
    else integrate();
    synthesise(n * hop);
    [current, previous] = [previous, current];
    if ((n - first) % FRAMES_PER_TURN === FRAMES_PER_TURN - 1) await pause();
  }
}
