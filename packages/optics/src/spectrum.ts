// Colour of light from its spectrum.
// - CIE 1931 2-degree colour matching functions: the multi-lobe piecewise Gaussian fit of Wyman, Sloan and Shirley,
//   "Simple Analytic Approximations to the CIE XYZ Color Matching Functions", JCGT 2(2), 2013, Table 1 (weight, mean,
//   inverse widths below and above the mean).
// - XYZ to linear sRGB: IEC 61966-2-1:1999 (D65 white).
// - Planck's law with the second radiation constant c2 = 1.438776877e-2 m K (CODATA 2018).
import { checkFinite, checkPositive } from './validate.js';

/** Second radiation constant c2 in nanometre kelvin. */
export const SECOND_RADIATION_CONSTANT = 1.438776877e7;

/** Row-major XYZ (D65) to linear sRGB matrix, IEC 61966-2-1. */
export const XYZ_TO_LINEAR_SRGB: readonly number[] = /* @__PURE__ */ Object.freeze([
  3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057,
]);

type Lobe = readonly [weight: number, mean: number, below: number, above: number];
const X: readonly Lobe[] = [
  [0.362, 442.0, 0.0624, 0.0374],
  [1.056, 599.8, 0.0264, 0.0323],
  [-0.065, 501.1, 0.049, 0.0382],
];
const Y: readonly Lobe[] = [
  [0.821, 568.8, 0.0213, 0.0247],
  [0.286, 530.9, 0.0613, 0.0322],
];
const Z: readonly Lobe[] = [
  [1.217, 437.0, 0.0845, 0.0278],
  [0.681, 459.0, 0.0385, 0.0725],
];
function lobes(nm: number, list: readonly Lobe[]): number {
  let sum = 0;
  for (const [w, mu, below, above] of list) {
    const t = (nm - mu) * (nm < mu ? below : above);
    sum += w * Math.exp(-0.5 * t * t);
  }
  return sum;
}

/** Writable numeric array accepted as an `out` target. */
export type NumberArray = number[] | Float32Array | Float64Array;

/**
 * CIE 1931 2-degree colour matching functions x̄, ȳ, z̄ at `nm` nanometres (Wyman, Sloan and Shirley 2013 fit; the
 * fit's ȳ peaks at 1.0 near 555 nm).
 */
export function cieXYZ<T extends NumberArray = number[]>(nm: number, out?: T, offset = 0): T {
  checkFinite('cieXYZ', 'nm', nm);
  const o = (out ?? [0, 0, 0]) as T;
  o[offset] = lobes(nm, X);
  o[offset + 1] = lobes(nm, Y);
  o[offset + 2] = lobes(nm, Z);
  return o;
}

/** Converts CIE XYZ (D65) to linear sRGB, unclamped (negative outside the gamut). */
export function xyzToLinearSRGB<T extends NumberArray = number[]>(xyz: ArrayLike<number>, out?: T, offset = 0): T {
  const o = (out ?? [0, 0, 0]) as T;
  const x = xyz[0],
    y = xyz[1],
    z = xyz[2],
    m = XYZ_TO_LINEAR_SRGB;
  o[offset] = m[0] * x + m[1] * y + m[2] * z;
  o[offset + 1] = m[3] * x + m[4] * y + m[5] * z;
  o[offset + 2] = m[6] * x + m[7] * y + m[8] * z;
  return o;
}

/** Linear sRGB weight of a single wavelength (unclamped, unnormalised): xyzToLinearSRGB(cieXYZ(nm)). */
export function wavelengthToLinearSRGB<T extends NumberArray = number[]>(nm: number, out?: T, offset = 0): T {
  const o = cieXYZ(nm, out, offset);
  return xyzToLinearSRGB([o[offset], o[offset + 1], o[offset + 2]], o, offset);
}

/**
 * Display colour of a pure spectral line: its linear sRGB with negative channels clipped to 0 and scaled so the largest
 * channel is 1 (black outside about 360 to 830 nm where every channel underflows).
 */
export function spectralColor<T extends NumberArray = number[]>(nm: number, out?: T, offset = 0): T {
  const o = wavelengthToLinearSRGB(nm, out, offset);
  let peak = 0;
  for (let i = 0; i < 3; i++) {
    o[offset + i] = Math.max(0, o[offset + i]);
    peak = Math.max(peak, o[offset + i]);
  }
  for (let i = 0; i < 3; i++) o[offset + i] = peak > 0 ? o[offset + i] / peak : 0;
  return o;
}

/** Black-body spectral radiance at `nm` for `kelvin`, relative to its value at 550 nm. */
export function planckRelative(nm: number, kelvin: number): number {
  checkPositive('planckRelative', 'nm', nm);
  checkPositive('planckRelative', 'kelvin', kelvin);
  const c2 = SECOND_RADIATION_CONSTANT;
  return ((550 / nm) ** 5 * Math.expm1(c2 / (550 * kelvin))) / Math.expm1(c2 / (nm * kelvin));
}

/** Options of a {@link SpectralIntegrator}. */
export interface SpectralIntegratorOptions {
  /** Shortest wavelength sampled, nm. Default 380. */
  readonly min?: number;
  /** Longest wavelength sampled, nm. Default 780. */
  readonly max?: number;
  /** Sample spacing, nm (the range is rounded to whole steps). Default 5. */
  readonly step?: number;
  /**
   * Light the spectrum is seen under: `'equal'` (equal energy), a colour temperature in kelvin (Planck's law), or a
   * function of wavelength in nm. Default 6504 (a black body at the D65 correlated colour temperature).
   */
  readonly illuminant?: 'equal' | number | ((nm: number) => number);
}

/**
 * Integrates a reflectance or transmittance spectrum to linear sRGB under an illuminant (trapezoid rule), normalised so
 * a spectrum of 1 everywhere gives white (1, 1, 1). Results are unclamped: clip or tone map them for display.
 *
 * @example
 * ```ts
 * import { SpectralIntegrator } from '@margoengine/optics/spectrum';
 * const integrator = new SpectralIntegrator({ step: 4 });
 * const white = integrator.color(() => 1); // [1, 1, 1]
 * ```
 */
export class SpectralIntegrator {
  /** Sampled wavelengths, nm. */
  readonly wavelengths: Float64Array;
  /** Per-sample linear sRGB weights (three per wavelength), already divided by the white of the illuminant. */
  readonly weights: Float64Array;
  /** Per-sample luminance (CIE Y) weights, already divided by the Y of the illuminant. */
  readonly luminanceWeights: Float64Array;

  constructor(options: SpectralIntegratorOptions = {}) {
    const min = options.min ?? 380,
      max = options.max ?? 780,
      step = options.step ?? 5;
    checkPositive('SpectralIntegrator', 'step', step);
    checkPositive('SpectralIntegrator', 'min', min);
    if (!(max > min)) throw new RangeError(`SpectralIntegrator max (${max}) must exceed min (${min})`);
    const count = Math.round((max - min) / step) + 1;
    const lamp = options.illuminant ?? 6504;
    const power =
      lamp === 'equal' ? () => 1 : typeof lamp === 'number' ? (nm: number) => planckRelative(nm, lamp) : lamp;
    this.wavelengths = new Float64Array(count);
    this.weights = new Float64Array(count * 3);
    this.luminanceWeights = new Float64Array(count);
    const white = [0, 0, 0],
      rgb = [0, 0, 0];
    let whiteY = 0;
    for (let i = 0; i < count; i++) {
      const nm = min + i * step;
      const w = power(nm) * (i === 0 || i === count - 1 ? 0.5 : 1);
      const y = lobes(nm, Y) * w;
      this.luminanceWeights[i] = y;
      whiteY += y;
      wavelengthToLinearSRGB(nm, rgb);
      this.wavelengths[i] = nm;
      for (let c = 0; c < 3; c++) {
        this.weights[i * 3 + c] = rgb[c] * w;
        white[c] += rgb[c] * w;
      }
    }
    for (let i = 0; i < count * 3; i++) this.weights[i] /= white[i % 3];
    for (let i = 0; i < count; i++) this.luminanceWeights[i] /= whiteY;
  }

  /** Luminance (CIE Y) of `spectrum(nm)` relative to the illuminant's: the fraction of the light's brightness kept. */
  luminance(spectrum: (nm: number) => number): number {
    let y = 0;
    const { wavelengths, luminanceWeights } = this;
    for (let i = 0; i < wavelengths.length; i++) y += spectrum(wavelengths[i]) * luminanceWeights[i];
    return y;
  }

  /** Linear sRGB of `spectrum(nm)` (values 0..1 for a reflectance), relative to the illuminant's white. */
  color<T extends NumberArray = number[]>(spectrum: (nm: number) => number, out?: T, offset = 0): T {
    const o = (out ?? [0, 0, 0]) as T;
    let r = 0,
      g = 0,
      b = 0;
    const { wavelengths, weights } = this;
    for (let i = 0; i < wavelengths.length; i++) {
      const v = spectrum(wavelengths[i]);
      r += v * weights[i * 3];
      g += v * weights[i * 3 + 1];
      b += v * weights[i * 3 + 2];
    }
    o[offset] = r;
    o[offset + 1] = g;
    o[offset + 2] = b;
    return o;
  }
}
