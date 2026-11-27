// Formant preservation for the vocoder's pitch shift: each frame's spectral envelope is estimated by iterative cepstral
// smoothing (the "true envelope": A. Roebel and X. Rodet, "Efficient spectral envelope estimation and its application
// to pitch shifting and envelope preservation", DAFx 2005, after S. Imai and Y. Abe, 1979), and the magnitudes are
// corrected before resampling so that the envelope lands where it was. Shifting formants apart from the pitch this way
// follows J. Laroche and M. Dolson, "New phase-vocoder techniques for pitch-shifting, harmonizing and other exotic
// effects", IEEE WASPAA 1999, doi:10.1109/ASPAA.1999.810857.
import { fft, fftPlan } from './spectrogram-fft.js';

/** Stop when no bin stands more than 2 dB above the envelope (Roebel and Rodet), or after this many rounds. */
const EXCESS = (2 * Math.LN10) / 20,
  ROUNDS = 32;
/** The correction is held within 60 dB, and bins are floored 120 dB below the frame's peak. */
const LIMIT = 3 * Math.LN10,
  DEPTH = 6 * Math.LN10;

/**
 * A per-frame magnitude correction for a pitch ratio: `fill(power, gains)` writes `E(ratio * f) / E(f)` for each bin of
 * a transform of `points`, E the frame's envelope with cepstral cutoff `quefrency` samples.
 */
export function envelopeCorrection(
  points: number,
  ratio: number,
  quefrency: number,
): (power: Float64Array, gains: Float64Array) => void {
  const cutoff = Math.max(2, Math.min(points / 4, Math.round(quefrency))),
    // The envelope is smooth, so it is fitted to the spectrum's peaks on a coarser grid.
    size = Math.min(points, Math.max(1024, 2 ** Math.ceil(Math.log2(4 * cutoff)))),
    group = points / size,
    top = size / 2,
    plan = fftPlan(size),
    peaks = new Float64Array(top + 1),
    target = new Float64Array(top + 1),
    re = new Float64Array(size),
    im = new Float64Array(size);
  return (power, gains) => {
    let loudest = 0;
    for (let k = 0; k <= top; k++) {
      let p = 0;
      const from = Math.max(0, Math.ceil((k - 0.5) * group)),
        to = Math.min(power.length - 1, Math.floor((k + 0.5) * group));
      for (let i = from; i <= to; i++) if (power[i] > p) p = power[i];
      peaks[k] = p;
      if (p > loudest) loudest = p;
    }
    if (!(loudest > 0)) {
      gains.fill(1);
      return;
    }
    const floor = Math.log(loudest) / 2 - DEPTH;
    for (let k = 0; k <= top; k++) peaks[k] = target[k] = Math.max(floor, Math.log(peaks[k]) / 2);
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < size; i++) {
        re[i] = target[i <= top ? i : size - i];
        im[i] = 0;
      }
      // The log spectrum is even, so a forward transform over its length gives the cepstrum, and one more the spectrum.
      fft(plan, re, im);
      for (let q = 0; q < size; q++) {
        const distance = Math.min(q, size - q),
          keep = distance < cutoff ? 1 : distance === cutoff ? 0.5 : 0;
        re[q] = (re[q] * keep) / size;
        im[q] = 0;
      }
      fft(plan, re, im);
      let excess = 0;
      for (let k = 0; k <= top; k++) {
        excess = Math.max(excess, peaks[k] - re[k]);
        target[k] = Math.max(peaks[k], re[k]);
      }
      if (excess < EXCESS) break;
    }
    // `re` now holds the envelope in nepers.
    const envelope = (bin: number) => {
      const x = Math.min(top, bin / group),
        i = Math.min(top - 1, Math.floor(x));
      return re[i] + (re[i + 1] - re[i]) * (x - i);
    };
    for (let k = 0; k < gains.length; k++)
      gains[k] = Math.exp(Math.max(-LIMIT, Math.min(LIMIT, envelope(k * ratio) - envelope(k))));
  };
}
