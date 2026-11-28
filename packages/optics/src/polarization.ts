// Polarised light.
// - Malus's law I = I0 cos^2(theta): Hecht, Optics, 5th ed., 2017, section 8.2.
// - Jones calculus: R. C. Jones, "A New Calculus for the Treatment of Optical Systems I", JOSA 31(7), 488-493, 1941;
//   Hecht 2017, section 8.12.
// - Photoelasticity: a retardation delta between crossed (or parallel) polarisers transmits sin^2(2 phi) sin^2(pi delta
//   / lambda) (or one minus it), with delta = C t (sigma1 - sigma2): Frocht, Photoelasticity, 1941, vol. 1; Dally and
//   Riley, Experimental Stress Analysis, 4th ed., 2005, chapter 13. The diametrically loaded disc: Frocht 1941, and
//   Timoshenko and Goodier, Theory of Elasticity, 3rd ed., 1970, section 41.
import { SpectralIntegrator, type SpectralIntegratorOptions } from './spectrum.js';
import { checkFinite, checkPositive } from './validate.js';

/** Intensity behind a linear polariser at `angle` radians to linearly polarised light of intensity `intensity`. */
export function malus(angle: number, intensity = 1): number {
  checkFinite('malus', 'angle', angle);
  const c = Math.cos(angle);
  return intensity * c * c;
}

/** A Jones vector: complex x and y field amplitudes (re, im). */
export class JonesVector {
  constructor(
    public xr: number,
    public xi: number,
    public yr: number,
    public yi: number,
  ) {}
  /** Unit linearly polarised light at `angle` radians from x. */
  static linear(angle: number): JonesVector {
    return new JonesVector(Math.cos(angle), 0, Math.sin(angle), 0);
  }
  /** Unit circularly polarised light; `handedness` +1 is left-handed seen facing the source (y leads by 90 deg). */
  static circular(handedness: 1 | -1 = 1): JonesVector {
    const h = Math.SQRT1_2;
    return new JonesVector(h, 0, 0, handedness * h);
  }
  /** Intensity |Ex|^2 + |Ey|^2. */
  get intensity(): number {
    return this.xr * this.xr + this.xi * this.xi + this.yr * this.yr + this.yi * this.yi;
  }
  /** Copy. */
  clone(): JonesVector {
    return new JonesVector(this.xr, this.xi, this.yr, this.yi);
  }
}

/** A 2 x 2 complex Jones matrix [[a, b], [c, d]], each entry (re, im). */
export class JonesMatrix {
  constructor(readonly m: Float64Array = new Float64Array([1, 0, 0, 0, 0, 0, 1, 0])) {}
  /** Ideal linear polariser with its transmission axis at `angle` radians from x. */
  static polarizer(angle: number): JonesMatrix {
    checkFinite('JonesMatrix.polarizer', 'angle', angle);
    const c = Math.cos(angle),
      s = Math.sin(angle);
    return new JonesMatrix(new Float64Array([c * c, 0, c * s, 0, c * s, 0, s * s, 0]));
  }
  /**
   * Linear retarder with its fast axis at `angle` radians and retardance `phase` radians (pi/2 a quarter-wave plate,
   * pi a half-wave plate); the slow axis lags by `phase`.
   */
  static retarder(angle: number, phase: number): JonesMatrix {
    checkFinite('JonesMatrix.retarder', 'angle', angle);
    checkFinite('JonesMatrix.retarder', 'phase', phase);
    const c = Math.cos(angle),
      s = Math.sin(angle),
      er = Math.cos(phase),
      ei = -Math.sin(phase);
    // R(-a) diag(1, e^{-i phase}) R(a)
    return new JonesMatrix(
      new Float64Array([
        c * c + s * s * er,
        s * s * ei,
        c * s * (1 - er),
        -c * s * ei,
        c * s * (1 - er),
        -c * s * ei,
        s * s + c * c * er,
        c * c * ei,
      ]),
    );
  }
  /** `this` applied after `first`: the matrix of light going through `first`, then `this`. */
  after(first: JonesMatrix): JonesMatrix {
    const a = this.m,
      b = first.m,
      o = new Float64Array(8);
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) {
        let re = 0,
          im = 0;
        for (let k = 0; k < 2; k++) {
          const ar = a[(r * 2 + k) * 2],
            ai = a[(r * 2 + k) * 2 + 1],
            br = b[(k * 2 + c) * 2],
            bi = b[(k * 2 + c) * 2 + 1];
          re += ar * br - ai * bi;
          im += ar * bi + ai * br;
        }
        o[(r * 2 + c) * 2] = re;
        o[(r * 2 + c) * 2 + 1] = im;
      }
    return new JonesMatrix(o);
  }
  /** Applies the matrix to `v`, writing into `out` (default a new vector). */
  apply(v: JonesVector, out = new JonesVector(0, 0, 0, 0)): JonesVector {
    const m = this.m,
      { xr, xi, yr, yi } = v;
    out.xr = m[0] * xr - m[1] * xi + m[2] * yr - m[3] * yi;
    out.xi = m[0] * xi + m[1] * xr + m[2] * yi + m[3] * yr;
    out.yr = m[4] * xr - m[5] * xi + m[6] * yr - m[7] * yi;
    out.yi = m[4] * xi + m[5] * xr + m[6] * yi + m[7] * yr;
    return out;
  }
}

/**
 * Transmission of a birefringent sample of retardation `retardationNm` at `nm` between polarisers: crossed gives
 * axisFactor sin^2(pi delta / lambda), parallel one minus it. `axisFactor` is sin^2(2 phi) for a principal axis at phi to
 * the polariser (1 for circular polariscopes).
 */
export function photoelasticTransmission(nm: number, retardationNm: number, axisFactor = 1, parallel = false): number {
  checkPositive('photoelasticTransmission', 'nm', nm);
  checkFinite('photoelasticTransmission', 'retardationNm', retardationNm);
  const s = Math.sin((Math.PI * retardationNm) / nm);
  const crossed = axisFactor * s * s;
  return parallel ? 1 - crossed : crossed;
}

/**
 * Michel-Levy interference colours: linear sRGB (relative to the white of the illuminant, unclamped) of white light
 * through a retardation of 0..`maxRetardationNm` between crossed polarisers, sampled at `length` evenly spaced
 * retardations. Returns `length * 3` values.
 */
export function photoelasticColors(
  maxRetardationNm: number,
  length: number,
  options: SpectralIntegratorOptions & { readonly parallel?: boolean } = {},
): Float32Array {
  checkPositive('photoelasticColors', 'maxRetardationNm', maxRetardationNm);
  if (!Number.isInteger(length) || length < 2) throw new RangeError('photoelasticColors: length must be 2 or more');
  const integrator = new SpectralIntegrator(options),
    out = new Float32Array(length * 3),
    rgb = [0, 0, 0];
  const parallel = options.parallel ?? false;
  for (let i = 0; i < length; i++) {
    const delay = (maxRetardationNm * i) / (length - 1);
    integrator.color((nm) => photoelasticTransmission(nm, delay, 1, parallel), rgb);
    out.set(rgb, i * 3);
  }
  return out;
}

/** Retardation in nm of a photoelastic plate: C (1/Pa) times thickness (m) times principal stress difference (Pa). */
export function photoelasticRetardation(stressOptic: number, thickness: number, stressDifference: number): number {
  return stressOptic * thickness * stressDifference * 1e9;
}

/**
 * Principal stress difference terms of a disc squeezed by two opposite point loads at (0, +1) and (0, -1) (unit radius,
 * dimensionless): returns [sigma_x - sigma_y, 2 tau_xy] of the two radial point-load fields (the uniform tension term
 * cancels in the difference). sqrt(a^2 + b^2) times 2F / (pi t R) is sigma1 - sigma2.
 */
export function diametralDiscStress(x: number, y: number, out: [number, number] = [0, 0]): [number, number] {
  const top = y - 1,
    bottom = y + 1;
  const rTop2 = x * x + top * top,
    rBottom2 = x * x + bottom * bottom;
  const first = (2 * top) / (rTop2 * rTop2),
    second = (-2 * bottom) / (rBottom2 * rBottom2);
  out[0] = first * (x * x - top * top) + second * (x * x - bottom * bottom);
  out[1] = 2 * x * (first * top + second * bottom);
  return out;
}
