// Window functions for the short-time Fourier transform, from the definitions in F. J. Harris, "On the Use of Windows
// for Harmonic Analysis with the Discrete Fourier Transform", Proc. IEEE 66(1), 1978 (cosine-sum windows, section III;
// the Kaiser-Bessel window, section V). Periodic by default (the DFT-even form an FFT of that length sees); pass
// `symmetric: true` for the filter-design form with w[0] equal to w[size - 1].
import { rangeError } from '../../shared/errors.js';

/** Window names understood by `stft`: `'hann'` (default), `'hamming'`, `'blackman'`, `'blackman-harris'`, `'kaiser'` or `'rectangular'`. */
export type WindowName = 'hann' | 'hamming' | 'blackman' | 'blackman-harris' | 'kaiser' | 'rectangular';

/** Options for the window builders. */
export interface WindowOptions {
  /** Symmetric (filter design) instead of periodic (spectral analysis) form. Default false. */
  readonly symmetric?: boolean;
}

function cosineSum(size: number, a: readonly number[], options: WindowOptions): Float64Array {
  check(size);
  const w = new Float64Array(size),
    span = options.symmetric ? Math.max(size - 1, 1) : size;
  for (let n = 0; n < size; n++) {
    let sum = 0;
    for (let k = 0; k < a.length; k++) sum += (k % 2 ? -1 : 1) * a[k] * Math.cos((2 * Math.PI * k * n) / span);
    w[n] = sum;
  }
  return w;
}

function check(size: number): void {
  if (!Number.isInteger(size) || size < 1)
    throw rangeError(`Window size must be a whole number of at least 1, got ${size}`, 'state');
}

// Modified Bessel function of the first kind, order 0, by its power series (Harris 1978, equation 38 region).
function bessel0(x: number): number {
  let sum = 1,
    term = 1;
  for (let k = 1; k < 200 && term > 1e-17 * sum; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/** Window builders. Each returns a Float64Array of `size` coefficients. */
export const windows = {
  /** Rectangular window, all ones. */
  rectangular(size: number): Float64Array {
    check(size);
    return new Float64Array(size).fill(1);
  },
  /** Hann: 0.5 - 0.5 cos(2 pi n / N). */
  hann: (size: number, options: WindowOptions = {}) => cosineSum(size, [0.5, 0.5], options),
  /** Hamming: 0.54 - 0.46 cos(2 pi n / N). */
  hamming: (size: number, options: WindowOptions = {}) => cosineSum(size, [0.54, 0.46], options),
  /** Blackman, the three-term form with Harris's rounded coefficients 0.42, 0.5, 0.08. */
  blackman: (size: number, options: WindowOptions = {}) => cosineSum(size, [0.42, 0.5, 0.08], options),
  /** The four-term minimum-sidelobe Blackman-Harris window (-92 dB sidelobes). */
  blackmanHarris: (size: number, options: WindowOptions = {}) =>
    cosineSum(size, [0.35875, 0.48829, 0.14128, 0.01168], options),
  /** Kaiser-Bessel with shape `beta` (default 8.6, about -80 dB sidelobes): I0(beta sqrt(1 - r^2)) / I0(beta). */
  kaiser(size: number, beta = 8.6, options: WindowOptions = {}): Float64Array {
    check(size);
    if (!(beta >= 0) || !Number.isFinite(beta)) throw rangeError(`Kaiser beta must be 0 or more, got ${beta}`, 'state');
    const w = new Float64Array(size),
      span = options.symmetric ? Math.max(size - 1, 1) : size,
      half = span / 2,
      norm = bessel0(beta);
    for (let n = 0; n < size; n++) {
      const r = (n - half) / half;
      w[n] = bessel0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / norm;
    }
    return w;
  },
} as const;

/** A window by name, or the coefficients themselves (which must hold `size` numbers). */
export function windowOf(window: WindowName | ArrayLike<number> | undefined, size: number): Float64Array {
  if (window === undefined || window === 'hann') return windows.hann(size);
  if (typeof window !== 'string') {
    if (window.length !== size)
      throw rangeError(`A window array must hold ${size} numbers, got ${window.length}`, 'state');
    return Float64Array.from(window);
  }
  switch (window) {
    case 'hamming':
      return windows.hamming(size);
    case 'blackman':
      return windows.blackman(size);
    case 'blackman-harris':
      return windows.blackmanHarris(size);
    case 'kaiser':
      return windows.kaiser(size);
    case 'rectangular':
      return windows.rectangular(size);
  }
  throw rangeError(
    `Unknown window "${String(window)}"; use hann, hamming, blackman, blackman-harris, kaiser or rectangular`,
    'state',
  );
}
