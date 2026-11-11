// Iterative in-place radix-2 FFT (J. W. Cooley and J. W. Tukey, "An Algorithm for the Machine Calculation of Complex
// Fourier Series", Math. Comput. 19(90), 1965) in double precision with a bit-reversal table and precomputed twiddles
// per size. Real frames go through in pairs: two real signals a and b share one complex transform z = a + i b, and
// A[k] = (Z[k] + conj Z[N-k]) / 2, B[k] = (Z[k] - conj Z[N-k]) / 2i (the standard two-for-one real transform), so a
// frame costs half a complex FFT of its size.
import { rangeError } from '../../shared/errors.js';

/** Twiddles and bit-reversal order of one transform size. */
export interface FftPlan {
  readonly size: number;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly reverse: Uint32Array;
}

const plans = new Map<number, FftPlan>();

/** The cached plan for a power-of-two `size` from 2 to 65536 (an FFT of 32 to 65536 points is what the entry accepts). */
export function fftPlan(size: number): FftPlan {
  let plan = plans.get(size);
  if (plan) return plan;
  if (!Number.isInteger(size) || size < 2 || size > 65536 || (size & (size - 1)) !== 0)
    throw rangeError(`FFT size must be a power of two from 2 to 65536, got ${size}`, 'state');
  const cos = new Float64Array(size / 2),
    sin = new Float64Array(size / 2),
    reverse = new Uint32Array(size),
    bits = Math.log2(size);
  for (let k = 0; k < size / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / size);
    sin[k] = -Math.sin((2 * Math.PI * k) / size);
  }
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  if (plans.size >= 8) plans.delete(plans.keys().next().value!);
  plans.set(size, (plan = { size, cos, sin, reverse }));
  return plan;
}

/**
 * Complex transform of re/im in place: forward (exp(-2 pi i k n / N), unscaled) or inverse (conjugate twiddles, unscaled).
 * Work: (N/2) log2 N butterflies.
 */
export function fft(plan: FftPlan, re: Float64Array, im: Float64Array, inverse = false): void {
  const { size, cos, sin, reverse } = plan;
  for (let i = 0; i < size; i++) {
    const j = reverse[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let length = 2; length <= size; length *= 2) {
    const half = length / 2,
      step = size / length;
    for (let start = 0; start < size; start += length)
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t],
          wi = sign * sin[t],
          a = start + k,
          b = a + half,
          xr = re[b] * wr - im[b] * wi,
          xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
  }
}

/** Butterflies of one complex transform of `size` points, the unit of the entry's work counts. */
export const butterflies = (size: number): number => (size / 2) * Math.log2(size);

/**
 * Forward transforms of two real frames `a` and `b` (length N) at once; writes bins 0..N/2 of each into
 * (aRe, aIm) and (bRe, bIm), which hold at least N/2 + 1 values. `zr` and `zi` are N-point scratch.
 */
export function realPair(
  plan: FftPlan,
  a: Float64Array,
  b: Float64Array,
  zr: Float64Array,
  zi: Float64Array,
  aRe: Float64Array,
  aIm: Float64Array,
  bRe: Float64Array,
  bIm: Float64Array,
): void {
  const n = plan.size;
  zr.set(a);
  zi.set(b);
  fft(plan, zr, zi);
  for (let k = 0; k <= n / 2; k++) {
    const j = (n - k) & (n - 1);
    aRe[k] = (zr[k] + zr[j]) / 2;
    aIm[k] = (zi[k] - zi[j]) / 2;
    bRe[k] = (zi[k] + zi[j]) / 2;
    bIm[k] = (zr[j] - zr[k]) / 2;
  }
}

/**
 * Inverse transforms of two Hermitian spectra (bins 0..N/2 given) at once, scaled by 1/N: the real frames land in
 * `a` and `b` (length N). `zr` and `zi` are N-point scratch.
 */
export function inverseRealPair(
  plan: FftPlan,
  aRe: Float64Array,
  aIm: Float64Array,
  bRe: Float64Array,
  bIm: Float64Array,
  zr: Float64Array,
  zi: Float64Array,
  a: Float64Array,
  b: Float64Array,
): void {
  const n = plan.size;
  // Z = A + iB with A and B completed by Hermitian symmetry: Z[k] = A[k] + iB[k], Z[N-k] = conj A[k] + i conj B[k].
  for (let k = 0; k <= n / 2; k++) {
    const j = (n - k) & (n - 1),
      imA = k === 0 || k === n / 2 ? 0 : aIm[k],
      imB = k === 0 || k === n / 2 ? 0 : bIm[k];
    zr[k] = aRe[k] - imB;
    zi[k] = imA + bRe[k];
    zr[j] = aRe[k] + imB;
    zi[j] = -imA + bRe[k];
  }
  fft(plan, zr, zi, true);
  const scale = 1 / n;
  for (let i = 0; i < n; i++) {
    a[i] = zr[i] * scale;
    b[i] = zi[i] * scale;
  }
}
