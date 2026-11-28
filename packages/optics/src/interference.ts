// Interference of light.
// - Single film (Airy summation of the multiple reflections): Born and Wolf, Principles of Optics, 7th ed., 1999,
//   section 7.6.1; Hecht, Optics, 5th ed., 2017, section 9.4.
// - Multilayer stacks by the characteristic (transfer) matrix of each layer: Born and Wolf 1999, section 1.6.2;
//   H. A. Macleod, Thin-Film Optical Filters, 4th ed., 2010, chapter 2. Tilted admittances: eta_s = n cos(theta),
//   eta_p = n / cos(theta).
// - Iridescence colour of a film by integrating the spectrum: Belcour and Barla, "A Practical Extension to
//   Microfacet Theory for the Modeling of Varying Iridescence", ACM TOG 36(4), 2017 (the reference it is checked
//   against is the spectral integral used here).
// - Michelson interferometer: a mirror displacement d changes the path by 2d, so 2d / lambda fringes pass (Hecht 2017,
//   section 9.8.1).
// - Moire of two line gratings of pitch p1 and p2 at angle theta: spacing p1 p2 / sqrt(p1^2 + p2^2 - 2 p1 p2 cos
//   theta) (Amidror, The Theory of the Moire Phenomenon, 2nd ed., 2009, chapter 2).
import { snell } from './refraction.js';
import { SpectralIntegrator, type SpectralIntegratorOptions, type NumberArray } from './spectrum.js';
import { checkFinite, checkPositive } from './validate.js';

/** Polarisation of a reflectance: s, p, or their unpolarised mean. */
export type Polarization = 's' | 'p' | 'unpolarized';

/** A non-absorbing film on a substrate. */
export interface ThinFilm {
  /** Film index. */
  readonly filmIndex: number;
  /** Film thickness, nm. */
  readonly thickness: number;
  /** Substrate index. */
  readonly substrateIndex: number;
  /** Index of the medium the light arrives from. Default 1. */
  readonly ambientIndex?: number;
}

function airy(r01: number, r12: number, cosPhase: number): number {
  const cross = 2 * r01 * r12 * cosPhase;
  return (r01 * r01 + r12 * r12 + cross) / (1 + r01 * r01 * r12 * r12 + cross);
}

/**
 * Reflectance of a single thin film at `nm` and `angle` radians of incidence (Airy formula; exact for non-absorbing
 * layers). Past a critical angle the reflectance is 1.
 */
export function thinFilmReflectance(
  film: ThinFilm,
  nm: number,
  angle = 0,
  polarization: Polarization = 'unpolarized',
): number {
  checkPositive('thinFilmReflectance', 'nm', nm);
  checkFinite('thinFilmReflectance', 'thickness', film.thickness);
  const n0 = film.ambientIndex ?? 1,
    n1 = film.filmIndex,
    n2 = film.substrateIndex;
  const t1 = snell(n0, n1, angle),
    t2 = snell(n0, n2, angle);
  if (t1 === null || t2 === null) return 1;
  const c0 = Math.cos(angle),
    c1 = Math.cos(t1),
    c2 = Math.cos(t2);
  const cosPhase = Math.cos((4 * Math.PI * n1 * c1 * film.thickness) / nm);
  const s = () => airy((n0 * c0 - n1 * c1) / (n0 * c0 + n1 * c1), (n1 * c1 - n2 * c2) / (n1 * c1 + n2 * c2), cosPhase);
  const p = () => airy((n1 * c0 - n0 * c1) / (n1 * c0 + n0 * c1), (n2 * c1 - n1 * c2) / (n2 * c1 + n1 * c2), cosPhase);
  return polarization === 's' ? s() : polarization === 'p' ? p() : 0.5 * (s() + p());
}

/** One layer of a multilayer stack. */
export interface Layer {
  /** Real refractive index. */
  readonly index: number;
  /** Physical thickness, nm. */
  readonly thickness: number;
}

/** A multilayer stack on a substrate, layers listed from the light's side. */
export interface Multilayer {
  readonly layers: readonly Layer[];
  readonly substrateIndex: number;
  /** Index of the medium the light arrives from. Default 1. */
  readonly ambientIndex?: number;
}

function stackReflectance(stack: Multilayer, nm: number, angle: number, p: boolean): number {
  const n0 = stack.ambientIndex ?? 1;
  const sin0 = n0 * Math.sin(angle);
  // Complex cosines allow evanescent layers: cos = sqrt(1 - (sin0 / n)^2), imaginary when sin0 > n.
  const admittance = (n: number): [number, number, number, number] => {
    const q = 1 - (sin0 / n) ** 2;
    const cr = q >= 0 ? Math.sqrt(q) : 0,
      ci = q >= 0 ? 0 : Math.sqrt(-q);
    if (!p) return [n * cr, n * ci, cr, ci];
    const d = cr * cr + ci * ci; // n / cos
    return [(n * cr) / d, (-n * ci) / d, cr, ci];
  };
  // Characteristic matrix M = prod [[cos d, i sin d / eta], [i eta sin d, cos d]], complex.
  let m00r = 1,
    m00i = 0,
    m01r = 0,
    m01i = 0,
    m10r = 0,
    m10i = 0,
    m11r = 1,
    m11i = 0;
  for (const layer of stack.layers) {
    checkPositive('multilayerReflectance', 'layer index', layer.index);
    checkFinite('multilayerReflectance', 'layer thickness', layer.thickness);
    const [er, ei, cr, ci] = admittance(layer.index);
    const k = (2 * Math.PI * layer.index * layer.thickness) / nm;
    const dr = k * cr,
      di = k * ci;
    // cos and sin of the complex phase dr + i di
    const cosr = Math.cos(dr) * Math.cosh(di),
      cosi = -Math.sin(dr) * Math.sinh(di);
    const sinr = Math.sin(dr) * Math.cosh(di),
      sini = Math.cos(dr) * Math.sinh(di);
    const ed = er * er + ei * ei;
    // i sin / eta
    const sr = (sinr * er + sini * ei) / ed,
      si = (sini * er - sinr * ei) / ed;
    const a01r = -si,
      a01i = sr;
    // i eta sin
    const pr = er * sinr - ei * sini,
      pi = er * sini + ei * sinr;
    const a10r = -pi,
      a10i = pr;
    const mul = (ar: number, ai: number, br: number, bi: number): [number, number] => [ar * br - ai * bi, ar * bi + ai * br];
    const [n00r, n00i] = add(mul(m00r, m00i, cosr, cosi), mul(m01r, m01i, a10r, a10i));
    const [n01r, n01i] = add(mul(m00r, m00i, a01r, a01i), mul(m01r, m01i, cosr, cosi));
    const [n10r, n10i] = add(mul(m10r, m10i, cosr, cosi), mul(m11r, m11i, a10r, a10i));
    const [n11r, n11i] = add(mul(m10r, m10i, a01r, a01i), mul(m11r, m11i, cosr, cosi));
    m00r = n00r;
    m00i = n00i;
    m01r = n01r;
    m01i = n01i;
    m10r = n10r;
    m10i = n10i;
    m11r = n11r;
    m11i = n11i;
  }
  const [e0r, e0i] = admittance(n0),
    [esr, esi] = admittance(stack.substrateIndex);
  // [B; C] = M [1; eta_s]
  const Br = m00r + m01r * esr - m01i * esi,
    Bi = m00i + m01r * esi + m01i * esr;
  const Cr = m10r + m11r * esr - m11i * esi,
    Ci = m10i + m11r * esi + m11i * esr;
  // r = (eta0 B - C) / (eta0 B + C)
  const e0Br = e0r * Br - e0i * Bi,
    e0Bi = e0r * Bi + e0i * Br;
  const nr = e0Br - Cr,
    ni = e0Bi - Ci,
    dr = e0Br + Cr,
    di = e0Bi + Ci;
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}
function add(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}

/**
 * Reflectance of a stack of non-absorbing layers at `nm` and `angle` radians of incidence, by the characteristic matrix
 * method (handles any number of layers, including evanescent ones past a critical angle).
 */
export function multilayerReflectance(
  stack: Multilayer,
  nm: number,
  angle = 0,
  polarization: Polarization = 'unpolarized',
): number {
  checkPositive('multilayerReflectance', 'nm', nm);
  checkFinite('multilayerReflectance', 'angle', angle);
  if (polarization === 's') return stackReflectance(stack, nm, angle, false);
  if (polarization === 'p') return stackReflectance(stack, nm, angle, true);
  return 0.5 * (stackReflectance(stack, nm, angle, false) + stackReflectance(stack, nm, angle, true));
}

/** Quarter-wave stack (H L)^pairs H at `designNm`, the usual dielectric mirror or dichroic. */
export function quarterWaveStack(high: number, low: number, pairs: number, designNm: number): Layer[] {
  const out: Layer[] = [];
  for (let i = 0; i < pairs; i++) out.push({ index: high, thickness: designNm / (4 * high) }, { index: low, thickness: designNm / (4 * low) });
  out.push({ index: high, thickness: designNm / (4 * high) });
  return out;
}

/** Linear sRGB (relative to the illuminant's white, unclamped) of white light reflected from a thin film. */
export function thinFilmColor<T extends NumberArray = number[]>(
  film: ThinFilm,
  angle = 0,
  integrator: SpectralIntegrator = defaultIntegrator(),
  out?: T,
): T {
  return integrator.color((nm) => thinFilmReflectance(film, nm, angle), out);
}

let shared: SpectralIntegrator | undefined;
function defaultIntegrator(): SpectralIntegrator {
  return (shared ??= new SpectralIntegrator());
}

/** Creates a {@link SpectralIntegrator} (re-exported for film colours with chosen sampling). */
export function filmIntegrator(options?: SpectralIntegratorOptions): SpectralIntegrator {
  return new SpectralIntegrator(options);
}

/** Fringes that pass when a Michelson mirror moves `displacementNm`: 2 d / lambda. */
export function michelsonFringes(displacementNm: number, nm: number): number {
  checkFinite('michelsonFringes', 'displacementNm', displacementNm);
  checkPositive('michelsonFringes', 'nm', nm);
  return (2 * displacementNm) / nm;
}

/** Options of {@link michelsonIntensity}. */
export interface MichelsonOptions {
  /** Wavelength, nm. */
  readonly wavelength: number;
  /** Fringe spacing across the screen from mirror tilt (same unit as x). Infinity for a uniform field. */
  readonly fringeSpacing: number;
  /** Fringe visibility 0..1. Default 1. */
  readonly visibility?: number;
}

/** Normalised intensity at screen position `x` with the mirror moved `displacementNm` (0..1, mean 0.5). */
export function michelsonIntensity(x: number, displacementNm: number, options: MichelsonOptions): number {
  const v = options.visibility ?? 1;
  const phase = 2 * Math.PI * (x / options.fringeSpacing + michelsonFringes(displacementNm, options.wavelength));
  return 0.5 + 0.5 * v * Math.cos(phase);
}

/** Mirror tilt (radians) that gives tilt fringes of `spacing` for wavelength `nm` (spacing in metres). */
export function michelsonTilt(nm: number, spacing: number): number {
  checkPositive('michelsonTilt', 'spacing', spacing);
  return 0.5 * Math.asin((nm * 1e-9) / spacing);
}

/** Moire band spacing of two line gratings of pitch `p1` and `p2` crossed at `angle` radians (Infinity if parallel and equal). */
export function moireSpacing(p1: number, p2: number, angle: number): number {
  checkPositive('moireSpacing', 'p1', p1);
  checkPositive('moireSpacing', 'p2', p2);
  checkFinite('moireSpacing', 'angle', angle);
  const d = p1 * p1 + p2 * p2 - 2 * p1 * p2 * Math.cos(angle);
  return d <= 1e-30 * p1 * p2 ? Infinity : (p1 * p2) / Math.sqrt(d);
}
