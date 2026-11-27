// The windowed-sinc interpolator behind `resample` and the vocoder's pitch shift: J. O. Smith III and P. Gossett, "A
// flexible sampling-rate conversion method", ICASSP 1984; the Kaiser window of J. F. Kaiser, "Nonrecursive digital
// filter design using the I0-sinh window function", IEEE ISCAS 1974. Full source list: resample.ts.

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
 * A renderer whose output sample `n` is the input read at time `n * step / per` samples. `render` fills output samples
 * `from` to `to` (exclusive) of every channel, so a long signal can be converted in blocks with the same result.
 */
export function sincRenderer(
  step: number,
  per: number,
  zeroCrossings = 32,
  rolloff = 0.92,
  attenuation = 90,
): (channels: readonly Float32Array[], out: readonly Float32Array[], from: number, to: number) => void {
  // The cutoff in cycles per input sample is s / 2; the sinc's zero crossings are 1 / s input samples apart.
  const s = rolloff * Math.min(1, per / step),
    reach = zeroCrossings / s,
    // Kaiser's beta for the stopband attenuation (Kaiser 1974; Oppenheim and Schafer, section 7.6).
    beta =
      attenuation > 50
        ? 0.1102 * (attenuation - 8.7)
        : 0.5842 * (attenuation - 21) ** 0.4 + 0.07886 * (attenuation - 21),
    table = filterTable(zeroCrossings, beta),
    weights = new Float64Array(Math.ceil(2 * reach) + 2);
  return (channels, out, from, to) => {
    const length = channels[0].length;
    for (let n = from; n < to; n++) {
      // For whole-number rates n * step is exact, as both are whole numbers below 2^53 / 768000.
      const t = (n * step) / per,
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
  };
}
