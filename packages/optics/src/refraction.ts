// Refraction and reflection at plane boundaries, dispersion formulas, prisms and graded-index rays.
// - Snell's law, the Fresnel equations, Brewster's and the critical angle: Born and Wolf, Principles of Optics, 7th ed.,
//   1999, sections 1.5.2 to 1.5.4; Hecht, Optics, 5th ed., 2017, sections 4.4 to 4.7.
// - Sellmeier dispersion of fused silica: I. H. Malitson, "Interspecimen Comparison of the Refractive Index of Fused
//   Silica", JOSA 55(10), 1205-1209, 1965. N-BK7: SCHOTT optical glass data sheet (Sellmeier B1..3, C1..3).
// - Cauchy's formula through n_d and the Abbe number V_d = (n_d - 1) / (n_F - n_C): Hecht 2017, section 3.5.1.
// - Prism deviation and minimum deviation: Born and Wolf 1999, section 4.7.2. Halo from randomly oriented hexagonal
//   ice columns (60 degree wedges): Greenler, Rainbows, Halos, and Glories, 1980, chapter 2; Tape, Atmospheric Halos,
//   AGU 1994.
// - Rays in a medium whose index varies with height (y'' = (1 + y'^2) n'(y) / n(y), with n cos(theta) conserved):
//   Born and Wolf 1999, section 3.2.1 (the ray equation).
import { checkFinite, checkPositive } from './validate.js';

/** Refraction angle (radians) from `n1` into `n2` at `incidence` radians, or null past the critical angle. */
export function snell(n1: number, n2: number, incidence: number): number | null {
  checkPositive('snell', 'n1', n1);
  checkPositive('snell', 'n2', n2);
  checkFinite('snell', 'incidence', incidence);
  const s = (n1 / n2) * Math.sin(incidence);
  return Math.abs(s) > 1 ? null : Math.asin(s);
}

/** Critical angle (radians) for total internal reflection from `n1` into `n2`, or null when n1 <= n2. */
export function criticalAngle(n1: number, n2: number): number | null {
  checkPositive('criticalAngle', 'n1', n1);
  checkPositive('criticalAngle', 'n2', n2);
  return n1 > n2 ? Math.asin(n2 / n1) : null;
}

/** Brewster's angle (radians) from `n1` onto `n2`: the p-polarised reflectance is zero there. */
export function brewsterAngle(n1: number, n2: number): number {
  checkPositive('brewsterAngle', 'n1', n1);
  checkPositive('brewsterAngle', 'n2', n2);
  return Math.atan2(n2, n1);
}

/** Fresnel amplitude coefficients of a plane boundary (real for non-absorbing media below the critical angle). */
export interface FresnelAmplitudes {
  /** s (TE) reflection amplitude. */
  readonly rs: number;
  /** p (TM) reflection amplitude (Born and Wolf sign convention). */
  readonly rp: number;
  /** s transmission amplitude. */
  readonly ts: number;
  /** p transmission amplitude. */
  readonly tp: number;
  /** Refraction angle, radians. */
  readonly transmitted: number;
}

/** Fresnel amplitude coefficients from `n1` into `n2` at `incidence` radians, or null past the critical angle. */
export function fresnelAmplitudes(n1: number, n2: number, incidence: number): FresnelAmplitudes | null {
  const t = snell(n1, n2, incidence);
  if (t === null) return null;
  const ci = Math.cos(incidence),
    ct = Math.cos(t);
  const s = n1 * ci + n2 * ct,
    p = n2 * ci + n1 * ct;
  return {
    rs: (n1 * ci - n2 * ct) / s,
    rp: (n2 * ci - n1 * ct) / p,
    ts: (2 * n1 * ci) / s,
    tp: (2 * n1 * ci) / p,
    transmitted: t,
  };
}

/** Power reflectances of a plane boundary. */
export interface FresnelReflectance {
  /** s-polarised reflectance. */
  readonly s: number;
  /** p-polarised reflectance. */
  readonly p: number;
  /** Unpolarised reflectance, (s + p) / 2. */
  readonly average: number;
}

/** Power reflectance from `n1` into `n2` at `incidence` radians; 1 under total internal reflection. */
export function fresnelReflectance(n1: number, n2: number, incidence: number): FresnelReflectance {
  const a = fresnelAmplitudes(n1, n2, incidence);
  if (a === null) return { s: 1, p: 1, average: 1 };
  const s = a.rs * a.rs,
    p = a.rp * a.rp;
  return { s, p, average: 0.5 * (s + p) };
}

/** Sellmeier coefficients: n^2 = 1 + sum B_i lambda^2 / (lambda^2 - C_i), lambda in micrometres, C_i in um^2. */
export interface SellmeierCoefficients {
  readonly B: readonly number[];
  readonly C: readonly number[];
}

/** Fused silica at 20 C, Malitson 1965 (valid 0.21 to 3.71 um). */
export const FUSED_SILICA: SellmeierCoefficients = /* @__PURE__ */ Object.freeze({
  B: Object.freeze([0.6961663, 0.4079426, 0.8974794]),
  C: Object.freeze([0.0684043 ** 2, 0.1162414 ** 2, 9.896161 ** 2]),
});

/** SCHOTT N-BK7 borosilicate crown glass (data sheet, valid 0.3 to 2.5 um). */
export const N_BK7: SellmeierCoefficients = /* @__PURE__ */ Object.freeze({
  B: Object.freeze([1.03961212, 0.231792344, 1.01046945]),
  C: Object.freeze([0.00600069867, 0.0200179144, 103.560653]),
});

/** Refractive index at `nm` nanometres from Sellmeier coefficients. */
export function sellmeierIndex(nm: number, coefficients: SellmeierCoefficients): number {
  checkPositive('sellmeierIndex', 'nm', nm);
  const { B, C } = coefficients;
  if (B.length !== C.length) throw new RangeError('sellmeierIndex: B and C must have the same length');
  const l2 = (nm / 1000) ** 2;
  let n2 = 1;
  for (let i = 0; i < B.length; i++) n2 += (B[i] * l2) / (l2 - C[i]);
  return Math.sqrt(n2);
}

/** Fraunhofer d, F and C line wavelengths in nanometres (helium d, hydrogen F and C). */
export const FRAUNHOFER = /* @__PURE__ */ Object.freeze({ d: 587.56, F: 486.13, C: 656.27 });

/** Cauchy coefficients n = A + B / lambda^2 (lambda in micrometres, B in um^2). */
export interface CauchyCoefficients {
  readonly A: number;
  readonly B: number;
}

/** Cauchy coefficients through `nd` at the d line with Abbe number `abbe` (infinite or 0 means no dispersion). */
export function cauchyFromAbbe(nd: number, abbe: number): CauchyCoefficients {
  checkPositive('cauchyFromAbbe', 'nd', nd);
  checkFinite('cauchyFromAbbe', 'abbe', abbe);
  const { d, F, C } = FRAUNHOFER;
  const B = abbe > 0 ? (nd - 1) / (abbe * (1e6 / (F * F) - 1e6 / (C * C))) : 0;
  return { A: nd - (B * 1e6) / (d * d), B };
}

/** Refractive index at `nm` nanometres from Cauchy coefficients. */
export function cauchyIndex(nm: number, coefficients: CauchyCoefficients): number {
  checkPositive('cauchyIndex', 'nm', nm);
  return coefficients.A + (coefficients.B * 1e6) / (nm * nm);
}

/** A ray through a prism in its principal section. */
export interface PrismRay {
  /** Incidence on the first face, radians. */
  readonly incidence: number;
  /** Refraction angle inside the first face, radians. */
  readonly inside: number;
  /** Incidence on the second face from inside, radians (apex - inside). */
  readonly exitInternal: number;
  /** Exit angle from the second face, radians. */
  readonly exit: number;
  /** Total deviation, radians (incidence + exit - apex). */
  readonly deviation: number;
}

/** Traces a ray through a prism of `apex` radians and index `n` (in air); null if it is reflected inside. */
export function prismDeviation(apex: number, incidence: number, n: number): PrismRay | null {
  checkFinite('prismDeviation', 'apex', apex);
  const inside = snell(1, n, incidence);
  if (inside === null) return null;
  const exitInternal = apex - inside;
  const exit = snell(n, 1, exitInternal);
  if (exit === null) return null;
  return { incidence, inside, exitInternal, exit, deviation: incidence + exit - apex };
}

/** Minimum deviation (radians) of a prism of `apex` radians and index `n`: 2 asin(n sin(A/2)) - A. */
export function minimumDeviation(apex: number, n: number): number {
  checkPositive('minimumDeviation', 'n', n);
  const s = n * Math.sin(apex / 2);
  if (s > 1) throw new RangeError(`minimumDeviation: no ray passes a ${apex} rad prism of index ${n}`);
  return 2 * Math.asin(s) - apex;
}

/** Incidence (radians) at which a prism gives its minimum deviation (the symmetric passage). */
export function minimumDeviationIncidence(apex: number, n: number): number {
  return (minimumDeviation(apex, n) + apex) / 2;
}

/** Options of {@link hexagonalHaloProfile}. */
export interface HaloProfileOptions {
  /** Refractive indices, one channel each (for example red, green and blue for ice). */
  readonly indices: readonly number[];
  /** Smallest scattering angle binned, degrees. Default 17. */
  readonly minAngle?: number;
  /** Largest scattering angle binned, degrees. Default 33. */
  readonly maxAngle?: number;
  /** Number of bins. Default 256. */
  readonly bins?: number;
  /** Incidence samples across the wedge. Default 2800. */
  readonly rays?: number;
  /** Gaussian blur of each sample, degrees (the angular size of the Sun is about 0.53). Default 0.19. */
  readonly blur?: number;
}

/**
 * Relative intensity against scattering angle of light through the 60 degree wedges of randomly oriented hexagonal
 * ice columns (the 22 degree halo), per index channel. Each ray is weighted by the projected aperture its incidence
 * leaves open in the hexagon, its Fresnel transmission at both faces, and 1 / sin(angle) for the solid angle of its
 * ring. Returns `bins * indices.length` values, channel fastest, scaled so the brightest is 1.
 */
export function hexagonalHaloProfile(options: HaloProfileOptions): Float64Array {
  const { indices } = options;
  const min = options.minAngle ?? 17,
    max = options.maxAngle ?? 33,
    bins = options.bins ?? 256,
    rays = options.rays ?? 2800,
    blur = options.blur ?? 0.19;
  if (!indices.length) throw new RangeError('hexagonalHaloProfile: indices must not be empty');
  if (!(max > min) || bins < 2) throw new RangeError('hexagonalHaloProfile: needs maxAngle > minAngle and 2+ bins');
  const channels = indices.length,
    out = new Float64Array(bins * channels);
  const rad = Math.PI / 180,
    apex = 60 * rad,
    width = (max - min) / (bins - 1),
    root3 = Math.sqrt(3);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const transmit = (n1: number, n2: number, a: number, b: number) => {
    const ca = Math.cos(a),
      cb = Math.cos(b);
    const s = (n1 * ca - n2 * cb) / (n1 * ca + n2 * cb),
      p = (n2 * ca - n1 * cb) / (n2 * ca + n1 * cb);
    return 1 - 0.5 * (s * s + p * p);
  };
  for (let i = 0; i < rays; i++) {
    const incidence = (15 + (74.8 * (i + 0.5)) / rays) * rad;
    for (let c = 0; c < channels; c++) {
      const n = indices[c];
      const ray = prismDeviation(apex, incidence, n);
      if (!ray) continue;
      const angle = ray.deviation / rad;
      if (angle < min - 0.8 || angle > max + 0.8) continue;
      // Fraction of the entry face whose refracted ray leaves through the opposite face of the 60 degree wedge.
      const advance = root3 / (2 * Math.tan(Math.PI / 6 + ray.inside));
      const base = advance - 1,
        sweep = 0.5 + advance;
      const accepted = clamp((0.5 - base) / sweep) - clamp((-0.5 - base) / sweep);
      const weight =
        (accepted *
          Math.cos(incidence) *
          transmit(1, n, incidence, ray.inside) *
          transmit(n, 1, ray.exitInternal, ray.exit)) /
        Math.sin(angle * rad);
      const bin = (angle - min) / width;
      for (let x = Math.max(0, Math.floor(bin) - 10); x <= Math.min(bins - 1, Math.ceil(bin) + 10); x++) {
        const d = ((x - bin) * width) / blur;
        out[x * channels + c] += weight * Math.exp(-0.5 * d * d);
      }
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, v);
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak;
  return out;
}

/** A medium whose refractive index depends on height only. */
export interface GradedIndex {
  /** Index at height `y`. */
  index(y: number): number;
  /** dn/dy at height `y`. */
  gradient(y: number): number;
}

/** Options of {@link traceGradedRay}. */
export interface GradedRayOptions {
  /** Start height. */
  readonly height: number;
  /** Start elevation above horizontal, radians. */
  readonly elevation: number;
  /** Horizontal distance to stop at. */
  readonly distance: number;
  /** Stop when the ray rises above this height while climbing. Default Infinity. */
  readonly ceiling?: number;
  /** Ground height: the ray stops when it reaches it. Default 0. */
  readonly ground?: number;
  /** Horizontal step for a given height and slope. Default a constant distance / 512. */
  readonly step?: (y: number, slope: number) => number;
  /** Keep the path as [x, y] pairs. Default false. */
  readonly path?: boolean;
}

/** Where a graded-index ray ended. */
export interface GradedRay {
  /** `'ground'` it reached the ground, `'ceiling'` it rose past the ceiling, `'far'` it reached the distance. */
  readonly kind: 'ground' | 'ceiling' | 'far';
  /** Horizontal distance travelled. */
  readonly distance: number;
  /** Final height. */
  readonly height: number;
  /** Final elevation, radians. */
  readonly elevation: number;
  /** Lowest point where the ray turned from falling to rising, or null if it never turned. */
  readonly turn: { readonly distance: number; readonly height: number } | null;
  /** The invariant n cos(theta) of the start (Snell's law in a layered medium). */
  readonly invariant: number;
  /** The path, when asked for. */
  readonly points?: [number, number][];
}

/**
 * Traces a ray through a medium whose index varies with height (mirages, looming, heat shimmer near the ground) by
 * fourth-order Runge-Kutta on y'' = (1 + y'^2) n'(y) / n(y). n cos(elevation) stays constant along the exact ray.
 */
export function traceGradedRay(medium: GradedIndex, options: GradedRayOptions): GradedRay {
  checkFinite('traceGradedRay', 'height', options.height);
  checkFinite('traceGradedRay', 'elevation', options.elevation);
  checkPositive('traceGradedRay', 'distance', options.distance);
  const limit = options.distance,
    ground = options.ground ?? 0,
    ceiling = options.ceiling ?? Infinity;
  const stepOf = options.step ?? (() => limit / 512);
  let x = 0,
    y = options.height,
    slope = Math.tan(options.elevation);
  const invariant = medium.index(y) / Math.hypot(1, slope);
  const points: [number, number][] | undefined = options.path ? [[x, y]] : undefined;
  let turn: GradedRay['turn'] = null;
  const bend = (h: number, s: number) => ((1 + s * s) * medium.gradient(h)) / medium.index(h);
  const done = (kind: GradedRay['kind'], d: number, h: number, s: number): GradedRay => ({
    kind,
    distance: d,
    height: h,
    elevation: Math.atan(s),
    turn,
    invariant,
    ...(points ? { points } : {}),
  });
  while (x < limit) {
    if (slope >= 0 && y >= ceiling) return done('ceiling', x, y, slope);
    const step = Math.min(limit - x, stepOf(y, slope));
    const k1 = bend(y, slope);
    const s2 = slope + (step * k1) / 2;
    const k2 = bend(y + (step * slope) / 2, s2);
    const s3 = slope + (step * k2) / 2;
    const k3 = bend(y + (step * s2) / 2, s3);
    const s4 = slope + step * k3;
    const k4 = bend(y + step * s3, s4);
    const nextSlope = slope + (step * (k1 + 2 * k2 + 2 * k3 + k4)) / 6;
    const nextY = y + (step * (slope + 2 * s2 + 2 * s3 + s4)) / 6;
    if (nextY <= ground) {
      const hit = x + (step * (y - ground)) / (y - nextY);
      points?.push([hit, ground]);
      return done('ground', hit, ground, nextSlope);
    }
    if (slope < 0 && nextSlope >= 0) {
      const f = -slope / (nextSlope - slope);
      turn = { distance: x + f * step, height: y + f * (nextY - y) };
    }
    x += step;
    y = nextY;
    slope = nextSlope;
    points?.push([x, y]);
  }
  return done('far', x, y, slope);
}
