// Diffraction.
// - Grating equation d (sin theta_m - sin theta_i) = m lambda: Hecht, Optics, 5th ed., 2017, section 10.2.8; Born and
//   Wolf, Principles of Optics, 7th ed., 1999, section 8.6.1.
// - Fraunhofer pattern of a circular aperture (Airy), I = (2 J1(x) / x)^2 with x = k a sin(theta), first zero at
//   x = 3.8317, so sin(theta) = 1.21967 lambda / D: Born and Wolf 1999, section 8.5.2.
// - Fresnel number N = a^2 / (lambda) (1/z1 + 1/z2) and the Fresnel (near-field) point spread of a circular pupil, the
//   Hankel transform of the quadratic pupil phase: J. W. Goodman, Introduction to Fourier Optics, 3rd ed., 2005,
//   sections 4.2 and 4.5.
// - Bessel functions by their integral representations J_n(x) = (1/pi) int_0^pi cos(n t - x sin t) dt, evaluated by
//   the midpoint rule with at least 64 nodes and |x| + 32 nodes past that (the integrand is
//   periodic and analytic, so the midpoint rule converges geometrically: Trefethen and Weideman, "The Exponentially
//   Convergent Trapezoidal Rule", SIAM Review 56(3), 2014).
import { checkFinite, checkPositive } from './validate.js';

/** One diffraction order. */
export interface GratingOrder {
  /** Order number m. */
  readonly order: number;
  /** Diffraction angle from the grating normal, radians. */
  readonly angle: number;
}

/** Angle (radians) of order `order` for `nm` on a grating of `linesPerMm`, at `incidence` radians; null if evanescent. */
export function gratingAngle(order: number, nm: number, linesPerMm: number, incidence = 0): number | null {
  checkFinite('gratingAngle', 'order', order);
  checkPositive('gratingAngle', 'nm', nm);
  checkPositive('gratingAngle', 'linesPerMm', linesPerMm);
  const s = Math.sin(incidence) + (order * nm * linesPerMm) / 1e6;
  return Math.abs(s) <= 1 ? Math.asin(s) : null;
}

/** Every propagating order of a grating, lowest first, optionally only those within `maxAngle` radians of the normal. */
export function gratingOrders(nm: number, linesPerMm: number, incidence = 0, maxAngle = Math.PI / 2): GratingOrder[] {
  const per = (nm * linesPerMm) / 1e6,
    si = Math.sin(incidence);
  const low = Math.ceil((-1 - si) / per),
    high = Math.floor((1 - si) / per);
  const out: GratingOrder[] = [];
  for (let m = low; m <= high; m++) {
    const angle = gratingAngle(m, nm, linesPerMm, incidence);
    if (angle !== null && Math.abs(angle) <= maxAngle) out.push({ order: m, angle });
  }
  return out;
}

const NODES = 64;
/** Bessel function of the first kind J_n(x) for integer n >= 0. */
export function besselJ(n: number, x: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('besselJ: n must be a whole number 0 or more');
  checkFinite('besselJ', 'x', x);
  const nodes = Math.max(NODES, Math.ceil(Math.abs(x)) + 32);
  let sum = 0;
  for (let i = 0; i < nodes; i++) {
    const t = (Math.PI * (i + 0.5)) / nodes;
    sum += Math.cos(n * t - x * Math.sin(t));
  }
  return sum / nodes;
}

/** First zero of J1, x = 3.8317... */
export const AIRY_FIRST_ZERO = 3.8317059702075125;

/** Airy pattern intensity (2 J1(x) / x)^2, 1 at the centre. */
export function airyIntensity(x: number): number {
  checkFinite('airyIntensity', 'x', x);
  if (Math.abs(x) < 1e-8) return 1;
  const j = (2 * besselJ(1, x)) / x;
  return j * j;
}

/** Angle (radians) of the first dark ring of a circular aperture of diameter `diameter` (same unit as wavelength). */
export function airyFirstZero(wavelength: number, diameter: number): number {
  checkPositive('airyFirstZero', 'wavelength', wavelength);
  checkPositive('airyFirstZero', 'diameter', diameter);
  return Math.asin((AIRY_FIRST_ZERO / Math.PI) * (wavelength / diameter));
}

/** Fresnel number of an aperture of `radius` between a source at `z1` and a screen at `z2` (all in metres). */
export function fresnelNumber(radius: number, wavelength: number, z1: number, z2: number): number {
  checkPositive('fresnelNumber', 'radius', radius);
  checkPositive('fresnelNumber', 'wavelength', wavelength);
  return (radius * radius * (1 / z1 + 1 / z2)) / wavelength;
}

/** Options of {@link circularPointSpread}. */
export interface PointSpreadOptions {
  /** Aperture radius, m. */
  readonly radius: number;
  /** Wavelength, m. */
  readonly wavelength: number;
  /** Aperture to screen distance, m. */
  readonly distance: number;
  /** Fresnel number of the defocus phase pi N rho^2 across the pupil (0 is in focus, Fraunhofer). Default 0. */
  readonly fresnelNumber?: number;
  /** Largest screen radius sampled, m. */
  readonly maxRadius: number;
  /** Samples from the centre out. Default 256. */
  readonly samples?: number;
  /** Radial pupil steps (even). Default 104. */
  readonly pupilSteps?: number;
}

/** A radial point spread profile. */
export interface PointSpread {
  /** Irradiance per sample, relative to the incident irradiance. */
  readonly values: Float64Array;
  /** Largest value. */
  readonly peak: number;
  /** Diameter holding 80 percent of the transmitted flux, m (undefined if the sampled radius holds less). */
  readonly diameter80: number | undefined;
  /** Flux inside maxRadius over the flux through the aperture. */
  readonly fluxFraction: number;
}

/**
 * Point spread of a circular aperture on a screen (Fresnel diffraction with a quadratic pupil phase pi N rho^2),
 * U(r) = (pi a^2 / (lambda z)) int_0^1 2 rho e^{i pi N rho^2} J0(k a r rho / z) d rho, by Simpson's rule over rho.
 */
export function circularPointSpread(options: PointSpreadOptions): PointSpread {
  const { radius: a, wavelength, distance: z, maxRadius } = options;
  checkPositive('circularPointSpread', 'radius', a);
  checkPositive('circularPointSpread', 'wavelength', wavelength);
  checkPositive('circularPointSpread', 'distance', z);
  checkPositive('circularPointSpread', 'maxRadius', maxRadius);
  const N = options.fresnelNumber ?? 0,
    samples = options.samples ?? 256,
    steps = options.pupilSteps ?? 104;
  if (steps % 2) throw new RangeError('circularPointSpread: pupilSteps must be even');
  const waveScale = (2 * Math.PI * a) / (wavelength * z);
  const gain = ((Math.PI * a * a) / (wavelength * z)) ** 2;
  const re = new Float64Array(steps + 1),
    im = new Float64Array(steps + 1);
  for (let j = 1; j <= steps; j++) {
    const rho = j / steps,
      phase = Math.PI * N * rho * rho;
    const w = (2 * rho * (j === steps ? 1 : j % 2 === 0 ? 2 : 4)) / (3 * steps);
    re[j] = w * Math.cos(phase);
    im[j] = w * Math.sin(phase);
  }
  // J0 table on a fine grid, linearly interpolated.
  const tableStep = 0.02,
    tableLength = Math.ceil((waveScale * maxRadius) / tableStep) + 2;
  const j0 = new Float64Array(tableLength);
  for (let i = 0; i < tableLength; i++) j0[i] = besselJ(0, i * tableStep);
  const values = new Float64Array(samples);
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const r = (maxRadius * i) / (samples - 1);
    let sr = 0,
      si = 0;
    for (let j = 1; j <= steps; j++) {
      const at = (r * waveScale * j) / steps / tableStep;
      const k = Math.min(tableLength - 2, Math.floor(at));
      const b = j0[k] + (j0[k + 1] - j0[k]) * (at - k);
      sr += b * re[j];
      si += b * im[j];
    }
    const v = gain * (sr * sr + si * si);
    values[i] = v;
    peak = Math.max(peak, v);
  }
  const area = Math.PI * a * a,
    step = maxRadius / (samples - 1);
  let flux = 0,
    e80: number | undefined;
  for (let i = 1; i < samples; i++) {
    const before = flux;
    flux += Math.PI * step * step * ((i - 1) * values[i - 1] + i * values[i]);
    if (e80 === undefined && flux >= 0.8 * area) e80 = 2 * step * (i - 1 + (0.8 * area - before) / (flux - before));
  }
  return { values, peak, diameter80: e80, fluxFraction: flux / area };
}
