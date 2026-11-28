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
// - Vector refraction t = r d + (r c - sqrt(1 - r^2 (1 - c^2))) n with c = -d . n: A. S. Glassner (ed.), An Introduction
//   to Ray Tracing, Academic Press 1989, chapter 6 (Heckbert's derivation); Bec, "Faster refraction formula", 1997.
// - Refractivity of standard dry air (15 C, 101 325 Pa, 450 ppm CO2): P. E. Ciddor, "Refractive index of air: new
//   equations for the visible and near infrared", Applied Optics 35(9), 1566-1573, 1996, equation (1). At constant
//   pressure n - 1 scales with density, so with 1 / T (Gladstone-Dale; Ciddor 1996 section 3).
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
  if (s > 1) throw new RangeError(`minimumDeviation: no ray passes a ${apex} rad prism of index ${n}; use a smaller apex angle or a lower index`);
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
  /**
   * Optional exact inverse: the height where the index equals `n`. When given, {@link traceGradedRay} places the
   * turning point there (n at the turn equals the ray invariant) instead of interpolating between two steps.
   */
  heightAt?(n: number): number;
  /** Optional step controller (horizontal step for a height and slope), used when the trace options give none. */
  step?(y: number, slope: number): number;
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
  /** Horizontal step for a given height and slope. Default the medium's `step`, else a constant distance / 512. */
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
  const stepOf = options.step ?? (medium.step ? (y: number, s: number) => medium.step!(y, s) : () => limit / 512);
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
      const exact = medium.heightAt?.(invariant);
      turn = { distance: x + f * step, height: Number.isFinite(exact) ? (exact as number) : y + f * (nextY - y) };
    }
    x += step;
    y = nextY;
    slope = nextSlope;
    points?.push([x, y]);
  }
  return done('far', x, y, slope);
}

/**
 * Elevation (radians, 0 to pi / 2) of a layered-medium ray with Snell invariant `invariant` (n cos(elevation)) where the
 * index is `n`: where a mirage ray leaves the hot layer into still air, or 0 where it is horizontal.
 */
export function layeredElevation(invariant: number, n: number): number {
  checkPositive('layeredElevation', 'invariant', invariant);
  checkPositive('layeredElevation', 'n', n);
  return Math.acos(Math.min(1, invariant / n));
}

/**
 * Phase refractivity n - 1 of standard dry air (15 C, 101 325 Pa, 450 ppm CO2) at `nm` nanometres, Ciddor (1996)
 * equation (1), valid 230 to 1690 nm: 2.7784e-4 at 550 nm.
 */
export function ciddorRefractivity(nm: number): number {
  checkPositive('ciddorRefractivity', 'nm', nm);
  const s2 = 1 / (nm / 1000) ** 2;
  return (5792105 / (238.0185 - s2) + 167917 / (57.362 - s2)) * 1e-8;
}

/** Options of {@link heatedAirLayer}. */
export interface HeatedAirOptions {
  /** Air temperature well above the surface, degrees Celsius. */
  readonly ambient: number;
  /** Air temperature at the surface, degrees Celsius (hotter for an inferior mirage, colder for looming). */
  readonly surface: number;
  /** Height over which the temperature excess falls by 1 / e, metres. */
  readonly depth: number;
  /** Wavelength, nanometres. Default 550. */
  readonly wavelength?: number;
}

/** A heated (or cooled) air layer over a surface: a {@link GradedIndex} with its exact inverse. */
export interface HeatedAir extends GradedIndex {
  /** Index of the still air far above the layer. */
  readonly farIndex: number;
  heightAt(n: number): number;
  /**
   * Step controller that resolves the layer: about 3 layer depths at the surface for steep rays, shrinking with the slope
   * for grazing rays (whose bending happens over a long run), and up to 400 depths well above the layer.
   */
  step(y: number, slope: number): number;
}

/**
 * Air over a hot road or desert floor: T(y) = T_ambient + (T_surface - T_ambient) exp(-max(0, y) / depth) at constant
 * pressure, n(y) = 1 + N_0 T_0 / T(y) with N_0 the Ciddor refractivity at T_0 = 288.15 K. Hand it to
 * {@link traceGradedRay} to trace an inferior mirage; `heightAt` makes the turning point exact.
 */
export function heatedAirLayer(options: HeatedAirOptions): HeatedAir {
  checkFinite('heatedAirLayer', 'ambient', options.ambient);
  checkFinite('heatedAirLayer', 'surface', options.surface);
  checkPositive('heatedAirLayer', 'depth', options.depth);
  const ambient = options.ambient + 273.15,
    heat = options.surface - options.ambient,
    depth = options.depth;
  if (!(ambient > 0) || !(ambient + heat > 0))
    throw new RangeError('heatedAirLayer: temperatures must be above absolute zero');
  const density = ciddorRefractivity(options.wavelength ?? 550) * 288.15;
  const excess = (y: number) => heat * Math.exp(-Math.max(0, y) / depth);
  return {
    farIndex: 1 + density / ambient,
    index: (y) => 1 + density / (ambient + excess(y)),
    gradient: (y) => {
      const e = excess(y),
        kelvin = ambient + e;
      return (density * e) / (depth * kelvin * kelvin);
    },
    step: (y, slope) =>
      Math.max(
        3.25 * depth,
        Math.min(400 * depth, 9.5 * depth + 67 * y, (0.05 * depth + 0.105 * y) / Math.max(Math.abs(slope), 0.002)),
      ),
    heightAt: (n) => {
      if (!heat || !(n > 1)) return NaN;
      const ratio = (density / (n - 1) - ambient) / heat;
      return ratio > 0 && ratio <= 1 ? -depth * Math.log(ratio) : NaN;
    },
  };
}

/**
 * Refracted unit direction of the unit `direction` at a surface with unit `normal` (either side; it is flipped to face
 * the ray), for `ratio` = n_from / n_to. Works for 2D and 3D arrays. Null on total internal reflection.
 */
export function refractVector(direction: ArrayLike<number>, normal: ArrayLike<number>, ratio: number): number[] | null {
  checkPositive('refractVector', 'ratio', ratio);
  const m = direction.length;
  let c = 0;
  for (let i = 0; i < m; i++) c -= direction[i] * normal[i];
  const sign = c < 0 ? -1 : 1;
  c *= sign;
  const k = 1 - ratio * ratio * (1 - c * c);
  if (k < 0) return null;
  const along = ratio * c - Math.sqrt(k);
  const out = new Array<number>(m);
  let length = 0;
  for (let i = 0; i < m; i++) {
    out[i] = ratio * direction[i] + along * sign * normal[i];
    length += out[i] * out[i];
  }
  length = Math.sqrt(length);
  for (let i = 0; i < m; i++) out[i] /= length;
  return out;
}

/** A ray through a polygonal prism, from {@link tracePolygon}. */
export interface PolygonRay {
  /** Point where the ray enters, and the index of that edge (edge i runs from vertex i to i + 1). */
  readonly entry: [number, number];
  readonly entryEdge: number;
  /** Unit direction inside the glass. */
  readonly inside: [number, number];
  /** Point where the ray leaves, and that edge. */
  readonly exit: [number, number];
  readonly exitEdge: number;
  /** Unit direction after leaving. */
  readonly direction: [number, number];
}

/**
 * Traces a 2D ray from `origin` along the unit `direction` through a convex polygon of index `index` in a medium of
 * `ambient` (default 1): refraction in at the first edge it meets, straight through, refraction out at the far edge. Null
 * when it misses the polygon or is totally internally reflected at the exit.
 */
export function tracePolygon(
  vertices: readonly (readonly [number, number])[],
  origin: readonly [number, number],
  direction: readonly [number, number],
  index: number,
  ambient = 1,
): PolygonRay | null {
  checkPositive('tracePolygon', 'index', index);
  checkPositive('tracePolygon', 'ambient', ambient);
  const count = vertices.length;
  const perp = (a: readonly number[], b: readonly number[]) => a[0] * b[1] - a[1] * b[0];
  const first = (from: readonly number[], d: readonly number[], skip: number) => {
    let best: { distance: number; edge: number } | null = null;
    for (let e = 0; e < count; e++) {
      if (e === skip) continue;
      const a = vertices[e],
        b = vertices[(e + 1) % count];
      const edge = [b[0] - a[0], b[1] - a[1]],
        offset = [a[0] - from[0], a[1] - from[1]];
      const denominator = perp(d, edge);
      if (!denominator) continue;
      const distance = perp(offset, edge) / denominator,
        across = perp(offset, d) / denominator;
      if (distance > 1e-9 && across >= 0 && across <= 1 && (!best || distance < best.distance))
        best = { distance, edge: e };
    }
    return best;
  };
  const normalOf = (e: number): [number, number] => {
    const a = vertices[e],
      b = vertices[(e + 1) % count];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
  };
  const hitIn = first(origin, direction, -1);
  if (!hitIn) return null;
  const entry: [number, number] = [
    origin[0] + direction[0] * hitIn.distance,
    origin[1] + direction[1] * hitIn.distance,
  ];
  const inside = refractVector(direction, normalOf(hitIn.edge), ambient / index) as [number, number] | null;
  if (!inside) return null;
  const hitOut = first(entry, inside, hitIn.edge);
  if (!hitOut) return null;
  const exit: [number, number] = [entry[0] + inside[0] * hitOut.distance, entry[1] + inside[1] * hitOut.distance];
  const out = refractVector(inside, normalOf(hitOut.edge), index / ambient) as [number, number] | null;
  if (!out) return null;
  return { entry, entryEdge: hitIn.edge, inside, exit, exitEdge: hitOut.edge, direction: out };
}
