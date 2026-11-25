// BlackHole: a lensed black hole with a thin accretion disk, a relativistic jet and a lensed star field, drawn by one
// full-screen RawShaderMaterial, plus the CPU twin of its ray integrator for geodesic overlays and tests.
//
// Units: the scene's length unit is the Schwarzschild radius r_s = 2M (the hole sits at the origin, spin along +y). The
// exported physics functions take radii in units of M (G = c = 1), as Bardeen, Press and Teukolsky (1972) and Page and
// Thorne (1974) write them. Sources (read as papers only), cited in packages/shader/README.md and docs/clean-room.md:
// - Bardeen, Press, Teukolsky 1972, "Rotating black holes: locally nonrotating frames, energy extraction, and scalar
//   synchrotron radiation", ApJ 178:347: horizon, ISCO, photon orbit, circular-orbit u^t and angular velocity.
// - Page, Thorne 1974, "Disk-accretion onto a black hole. Time-averaged structure of accretion disk", ApJ 191:499:
//   the radiated flux F(r) of a thin disk (their eq. 15n), zero at the ISCO.
// - Luminet 1979, "Image of a spherical black hole with thin accretion disk", A&A 75:228: the direct and secondary
//   images, the bolometric observed flux g^4 F.
// - James, von Tunzelmann, Franklin, Thorne 2015, "Gravitational lensing by spinning black holes in astrophysics, and in
//   the movie Interstellar", CQG 32:065001: Kerr null geodesics in Boyer-Lindquist coordinates (their eq. A.15), the
//   camera's initial ray in the zero-angular-momentum frame (A.9 to A.12), ray bundles, the pixel footprint on the
//   celestial sphere and point stars drawn with their magnification instead of stretched.
// - Igehy 1999, "Tracing ray differentials", SIGGRAPH: the pixel footprint of a traced ray from its derivatives.
// - Norton, Rockwood, Skolmoski 1982, "Clamping: a method of antialiasing textured surfaces by bandwidth limiting in
//   object space", SIGGRAPH: fading out octaves above the footprint's Nyquist limit.
// - Neyret 2003, "Advected textures", SCA: two texture phases crossfaded so shear never winds a pattern without bound.
// - Lind, Blandford 1985, "Semidynamical models of radio jets: relativistic beaming and source counts", ApJ 295:358:
//   jet brightness D^(2 + alpha).
// - Asada, Nakamura 2012, "The structure of the M87 jet: a transition from parabolic to conical streamlines", ApJL
//   745:L28: a parabolic jet near the hole.
// - Kim, Kang et al. 2002, "Design of advanced color temperature control system for HDTV applications", J. Korean
//   Physical Society 41:865: the Planckian locus as cubic fits in 1/T and x.
import type { EngineKernel } from '@margoengine/core';
import { RawMesh, RawShaderMaterial, RawShaders } from './raw.js';

/** What the shader draws: the picture, or one of the maps that explain it. */
export type BlackHoleView = 'beauty' | 'redshift' | 'beaming' | 'temperature' | 'orders';

const VIEWS: readonly BlackHoleView[] = ['beauty', 'redshift', 'beaming', 'temperature', 'orders'];

/** Options of {@link BlackHole}: the hole, its disk, jet and sky, and how they are drawn; every one can change later. */
export interface BlackHoleOptions {
  /** Spin a = J / M^2, 0 to 0.998 (Thorne's limit). Default 0.9. */
  spin?: number;
  /** Disk brightness, a multiple of the default accretion rate; 0 hides the disk. Default 1. */
  accretion?: number;
  /** Disk temperature at its flux peak, kelvin, before redshift. Default 4500. */
  peakTemperature?: number;
  /** Outer disk radius in r_s. Default 6. */
  diskOuter?: number;
  /** Strength of the disk's turbulence, 0 (a smooth Page-Thorne disk) to 1. Default 0.6. */
  turbulence?: number;
  /** Jet brightness, 0 (none) to 1. Default 0.5. */
  jet?: number;
  /** The jet's bulk Lorentz factor, 1 to 20. Default 5. */
  jetLorentz?: number;
  /** Star field brightness, 0 hides it. Default 1. */
  stars?: number;
  /** Milky Way band brightness, 0 hides it. Default 1. */
  galaxy?: number;
  /** Disk time scale: units of M of orbital time per second of the shader clock. Default 6. */
  timeScale?: number;
  /** Linear exposure multiplier of the output. Default 1. */
  exposure?: number;
  /** Shading view. Default 'beauty'. */
  view?: BlackHoleView;
  /**
   * Filter the disk texture and the stars by each pixel's footprint (ray differentials). Default true. False draws them
   * point sampled, the way a plain per-ray march does: fine banding in the disk and stars stretched into dashes.
   */
  prefilter?: boolean;
  /** Most integration steps per ray, 32 to 1024. Default 260. */
  steps?: number;
}

/** Event horizon radius r_+ = M (1 + sqrt(1 - a^2)), in M. */
export function kerrHorizon(spin: number): number {
  const a = clampSpin(spin);
  return 1 + Math.sqrt(1 - a * a);
}

/** Prograde innermost stable circular orbit (Bardeen, Press, Teukolsky 1972, eq. 2.21), in M. */
export function kerrIsco(spin: number): number {
  const a = clampSpin(spin);
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** Prograde circular photon orbit r = 2M (1 + cos(2/3 acos(-a))) (Bardeen, Press, Teukolsky 1972, eq. 2.18), in M. */
export function kerrPhotonOrbit(spin: number): number {
  const a = clampSpin(spin);
  return 2 * (1 + Math.cos((2 / 3) * Math.acos(-a)));
}

/** The three roots of x^3 - 3x + 2a = 0 used by Page and Thorne's flux, x = sqrt(r / M). */
function fluxRoots(a: number): [number, number, number] {
  const t = Math.acos(a) / 3;
  return [2 * Math.cos(t - Math.PI / 3), 2 * Math.cos(t + Math.PI / 3), -2 * Math.cos(t)];
}

/**
 * Flux radiated from each face of a thin Kerr disk at radius `r` (in M), for M = 1 and accretion rate 1: Page and
 * Thorne (1974) eq. 15n. Zero at and inside the ISCO; tends to the Newtonian 3 / (8 pi r^3) far out.
 */
export function novikovThorneFlux(r: number, spin: number): number {
  const a = Math.max(clampSpin(spin), 1e-6);
  const x0 = Math.sqrt(kerrIsco(a)),
    x = Math.sqrt(r);
  if (!(x > x0)) return 0;
  const [x1, x2, x3] = fluxRoots(a);
  const term = (xi: number, xj: number, xk: number) =>
    ((3 * (xi - a) * (xi - a)) / (xi * (xi - xj) * (xi - xk))) * Math.log((x - xi) / (x0 - xi));
  const bracket = x - x0 - 1.5 * a * Math.log(x / x0) - term(x1, x2, x3) - term(x2, x1, x3) - term(x3, x1, x2);
  return ((3 / (8 * Math.PI)) * bracket) / (x ** 4 * (x * x * x - 3 * x + 2 * a));
}

/**
 * Redshift factor g = E_observed / E_emitted of a photon from a prograde circular orbit at radius `r` (in M) that reaches
 * a distant observer with angular momentum per energy `lambda` (in M) about the spin axis: g = 1 / (u^t (1 - Omega
 * lambda)), u^t and Omega from Bardeen, Press, Teukolsky (1972).
 */
export function diskRedshift(r: number, spin: number, lambda: number): number {
  const a = clampSpin(spin),
    s = Math.sqrt(r),
    r15 = r * s;
  const ut = (r15 + a) / (Math.pow(r, 0.75) * Math.sqrt(Math.max(r15 - 3 * s + 2 * a, 1e-9)));
  const omega = 1 / (r15 + a);
  return 1 / (ut * (1 - omega * lambda));
}

/**
 * Lapse of the zero-angular-momentum frame, alpha = rho sqrt(Delta) / Sigma (Bardeen, Press, Teukolsky 1972), at
 * Boyer-Lindquist radius `r` (M) and polar angle `theta`: the gravitational redshift of light emitted there and seen far
 * away, 0 at the horizon and 1 far out. The jet's light is shifted by lapse times Doppler factor.
 */
export function kerrLapse(r: number, theta: number, spin: number): number {
  const a = clampSpin(spin),
    c = Math.cos(theta),
    dl = Math.max(r * r - 2 * r + a * a, 0);
  const rho2 = r * r + a * a * c * c,
    sig2 = (r * r + a * a) ** 2 - a * a * dl * (1 - c * c);
  return Math.sqrt((rho2 * dl) / sig2);
}

/** Doppler factor D = 1 / (Gamma (1 - beta cos theta)) of jet plasma at bulk Lorentz factor `gamma`. */
export function jetDoppler(gamma: number, cosTheta: number): number {
  const g = Math.max(gamma, 1),
    beta = Math.sqrt(1 - 1 / (g * g));
  return 1 / (g * (1 - beta * cosTheta));
}

/**
 * Linear sRGB colour of a black body at `kelvin` (clamped to 1667 to 25000 K), luminance 1: the Planckian locus fits of
 * Kim et al. (2002) taken to XYZ with Y = 1, then to linear sRGB (IEC 61966-2-1), negative parts clamped.
 */
export function blackbodyColor(kelvin: number): [number, number, number] {
  const T = Math.min(Math.max(kelvin, 1667), 25000),
    i = 1e3 / T;
  const x =
    T <= 4000
      ? -0.2661239 * i ** 3 - 0.2343589 * i * i + 0.8776956 * i + 0.17991
      : -3.0258469 * i ** 3 + 2.1070379 * i * i + 0.2226347 * i + 0.24039;
  const y =
    T <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x * x + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  const X = x / y,
    Z = (1 - x - y) / y;
  return [
    Math.max(3.2406 * X - 1.5372 - 0.4986 * Z, 0),
    Math.max(-0.9689 * X + 1.8758 + 0.0415 * Z, 0),
    Math.max(0.0557 * X - 0.204 + 1.057 * Z, 0),
  ];
}

/** Options of {@link traceGeodesic}. */
export interface GeodesicOptions {
  /** Spin, as BlackHoleOptions.spin. Default 0.9. */
  spin?: number;
  /** Most steps. Default 260. */
  steps?: number;
  /** Outer disk radius in r_s, where crossings are recorded. Default 6. */
  diskOuter?: number;
}

/** One ray traced by {@link traceGeodesic}: its path, its fate and where it crossed the disk. */
export interface Geodesic {
  /** Points along the path, xyz in r_s, the camera first (the ray is traced back in time from it). */
  points: Float32Array;
  /** 'horizon' when the hole took it, 'escape' when it left, 'steps' when the step limit ended it. */
  fate: 'horizon' | 'escape' | 'steps';
  /** Boyer-Lindquist radii (r_s) where it crossed the disk plane inside the disk, in order: image orders 0, 1, 2, ... */
  disk: number[];
  /** Where the light came from at the end (the backward ray's direction), unit length. */
  direction: [number, number, number];
  /** Constants of the motion per unit energy: axial angular momentum b (M) and Carter's q (M^2). */
  b: number;
  q: number;
  /** Largest |H| (the null condition, 0 for light) met along the path: the integration error. */
  drift: number;
}

/**
 * True when a step from polar angle `before` to `after` crosses the disk plane theta = pi / 2. Half open: the plane
 * itself counts with the side theta >= pi / 2, so a path through a step end exactly on the plane is counted once (a
 * product test misses it: 0 is not below 0).
 */
export function crossesEquator(before: number, after: number): boolean {
  return before < Math.PI / 2 !== after < Math.PI / 2;
}

/** The step (r_s) at radius r (r_s): small near the horizon, growing with r^2 and at most a fifth of r far out. */
export function geodesicStep(r: number, horizon: number): number {
  const dt = 0.028 * Math.max(r - horizon * 0.9, 0.035) + 0.0042 * r * r;
  return Math.min(Math.max(dt, 0.012), Math.max(0.65, 0.2 * r));
}

/** Escape radius (r_s): a ray moving outward past it is done. */
export const ESCAPE_RADIUS = 80;

/**
 * Scene point (r_s, spin on +y) to Boyer-Lindquist [r (M), theta, phi], where x = sqrt(r^2 + a^2) sin(theta) cos(phi),
 * y = r cos(theta), z = -sqrt(r^2 + a^2) sin(theta) sin(phi) (in M), so phi grows the way the hole turns.
 */
export function toBoyerLindquist(p: readonly number[], spin: number): [number, number, number] {
  const a = clampSpin(spin),
    x = p[0] * 2,
    y = p[1] * 2,
    z = p[2] * 2;
  const w = x * x + y * y + z * z - a * a;
  const r = Math.sqrt(0.5 * (w + Math.sqrt(w * w + 4 * a * a * y * y)));
  return [r, Math.acos(Math.min(Math.max(y / r, -1), 1)), Math.atan2(-z, x)];
}
/** Boyer-Lindquist r (M), theta, phi to a scene point (r_s). */
export function fromBoyerLindquist(r: number, theta: number, phi: number, spin: number): [number, number, number] {
  const a = clampSpin(spin),
    rho = Math.sqrt(r * r + a * a) * Math.sin(theta);
  return [(rho * Math.cos(phi)) / 2, (r * Math.cos(theta)) / 2, (-rho * Math.sin(phi)) / 2];
}

/**
 * Right-hand side of the Kerr null geodesic equations in Boyer-Lindquist coordinates, M = 1, p_t = -1 (James et al.
 * 2015, eq. A.15): y = [r, theta, p_r, p_theta]; returns [dr, dtheta, dp_r, dp_theta, dphi] per unit affine parameter.
 */
export function kerrRhs(y: readonly number[], a: number, b: number, q: number): number[] {
  const [r, th, pr, pt] = y,
    s = Math.max(Math.abs(Math.sin(th)), 1e-6),
    // An axial ray (kerrAxial) inside the band sin(theta) < POLE_BAND meets the b^2 cot^2 barrier held at its value
    // on the band's edge and no phi swing, so it goes straight over the axis; the step's reflection then turns phi by
    // the swing a straight line makes inside the band (kerrAxisTurn). Every other ray turns outside the band, its turn
    // resolved by kerrAxisStep.
    band = kerrAxial(a, b, q) && s < POLE_BAND,
    S2 = band ? POLE_BAND * POLE_BAND : s * s,
    c = Math.cos(th),
    a2 = a * a;
  const dl = r * r - 2 * r + a2,
    dlp = 2 * r - 2,
    rho2 = r * r + a2 * c * c,
    P = r * r + a2 - a * b,
    bq = (b - a) * (b - a) + q;
  const R = P * P - dl * bq,
    Rp = 4 * r * P - dlp * bq,
    Th = q - c * c * ((b * b) / S2 - a2),
    // -dTheta/dtheta's b part: 2 b^2 cos / sin^3 outside the band, 2 b^2 cos sin / band^2 inside it.
    barrier = band ? (2 * b * b * c * s) / S2 : (2 * b * b * c) / (s * s * s),
    // phi's b part, -2 b cos^2 / sin^2, none inside the band (kerrAxisTurn adds it at the reflection). phi enters no
    // other equation, so this changes no path in r and theta.
    swing = band ? 0 : (-2 * b * c * c) / S2;
  const A = -dl * pr * pr - pt * pt + Th,
    B = R / dl,
    Bp = (Rp * dl - R * dlp) / (dl * dl),
    inv = 1 / (2 * rho2);
  return [
    (dl * pr) / rho2,
    pt / rho2,
    (-dlp * pr * pr + Bp) * inv - ((A + B) * r) / (rho2 * rho2),
    (barrier - 2 * a2 * c * s) * inv + ((A + B) * a2 * c * s) / (rho2 * rho2),
    swing * inv + ((-2 * a * P - 2 * dl * (b - a)) * inv) / dl,
  ];
}

/**
 * Half-width, as sin(theta), of the band round the spin axis where Boyer-Lindquist coordinates are singular. An axial
 * ray (kerrAxial) goes straight over the axis inside it (kerrRhs, kerrHamiltonian and the shader) and its phi turns by
 * kerrAxisTurn at the reflection; its path moves by at most r * POLE_BAND / 3. Without this, rays a hundredth of a
 * pixel apart near the axis went to different places (a dashed seam over the pole, regression in
 * test/black-hole.test.js).
 */
export const POLE_BAND = 0.001;

/**
 * True for an axial ray: one whose turning point near the spin axis, sin(theta_min) = |b| / sqrt(q + a^2), lies within
 * a third of POLE_BAND. Such a ray is taken over the axis; outside the band the barrier it meets is at most a ninth of
 * q, and its path moves by at most r * POLE_BAND / 3.
 */
export function kerrAxial(a: number, b: number, q: number): boolean {
  return Math.abs(b) <= (POLE_BAND / 3) * Math.sqrt(Math.max(q + a * a, 1e-9));
}

/**
 * The turn in phi at a reflection over the spin axis. An axial ray crosses the band in a straight line (the band is
 * a thousandth of a radian wide, where space is flat to that order), whose azimuth about the axis turns by
 * 2 acos(theta_min / POLE_BAND), in the sense of b in the backward-traced ray; any other ray goes half a turn.
 */
export function kerrAxisTurn(a: number, b: number, q: number): number {
  if (!kerrAxial(a, b, q)) return Math.PI;
  const tMin = Math.abs(b) / Math.sqrt(Math.max(q + a * a, 1e-9));
  return (b < 0 ? -2 : 2) * Math.acos(Math.min(tMin / POLE_BAND, 1));
}

/**
 * Step limit near the spin axis: a ray of axial angular momentum b turns at sin(theta_min) = |b| / sqrt(q + a^2) (theta
 * moves at most sqrt(q + a^2) / rho^2 per unit affine parameter). Within sin(theta) < 0.2 each step covers at most a
 * quarter of the way left to theta_min, and a tenth of theta_min near it, so the turn and the half-turn in phi round
 * it are resolved: about 5 log2(0.2 / theta_min) steps, under 0.2 px of error where half-way steps left 2 px. An
 * axial ray steps the same way to the band's edge, then at most half the band at a time across it. Returns the step
 * `h` (affine parameter, M), limited.
 */
export function kerrAxisStep(h: number, r: number, theta: number, a: number, b: number, q: number): number {
  const k = Math.sqrt(Math.max(q + a * a, 1e-9)),
    tMin = Math.abs(b) / k,
    s = Math.abs(Math.sin(theta));
  if (s > 0.2) return h;
  const c = Math.cos(theta),
    axial = kerrAxial(a, b, q),
    turn = axial ? POLE_BAND : tMin,
    dTheta = axial && s < POLE_BAND ? 0.5 * POLE_BAND : 0.25 * Math.max(s - turn, 0.4 * turn);
  return Math.min(h, (dTheta * (r * r + a * a * c * c)) / k);
}

/** The null condition H of a state (James et al. 2015, eq. A.15's Hamiltonian): 0 for light; its size is the error. */
export function kerrHamiltonian(y: readonly number[], a: number, b: number, q: number): number {
  const [r, th, pr, pt] = y,
    s2 =
      kerrAxial(a, b, q) && Math.sin(th) ** 2 < POLE_BAND * POLE_BAND
        ? POLE_BAND * POLE_BAND
        : Math.max(Math.sin(th) ** 2, 1e-8),
    c = Math.cos(th),
    a2 = a * a;
  const dl = r * r - 2 * r + a2,
    rho2 = r * r + a2 * c * c,
    P = r * r + a2 - a * b;
  const R = P * P - dl * ((b - a) * (b - a) + q),
    Th = q - c * c * ((b * b) / s2 - a2);
  return (-dl * pr * pr - pt * pt + Th + R / dl) / (2 * rho2);
}

/**
 * Initial state of the ray seen by a camera at rest in the zero-angular-momentum frame at `origin`, looking along
 * `direction` (scene units): James et al. 2015, eqs. A.9 to A.12, the light travelling against `direction`.
 */
export function kerrInitial(
  origin: readonly number[],
  direction: readonly number[],
  spin: number,
): { y: number[]; phi: number; b: number; q: number } {
  const a = clampSpin(spin),
    [r, th, phi] = toBoyerLindquist(origin, a);
  const s = Math.max(Math.sin(th), 1e-6),
    c = Math.cos(th),
    ra = Math.sqrt(r * r + a * a);
  const er = norm([(r / ra) * s * Math.cos(phi), c, -(r / ra) * s * Math.sin(phi)]),
    et = norm([ra * c * Math.cos(phi), -r * s, -ra * c * Math.sin(phi)]),
    ep = [-Math.sin(phi), 0, -Math.cos(phi)];
  const d = norm([direction[0], direction[1], direction[2]]);
  const n = norm([dot(d, er), dot(d, et), dot(d, ep)]).map((v) => -v);
  const dl = r * r - 2 * r + a * a,
    rho = Math.sqrt(r * r + a * a * c * c),
    sig = Math.sqrt((r * r + a * a) ** 2 - a * a * dl * s * s);
  const alpha = (rho * Math.sqrt(dl)) / sig,
    omega = (2 * a * r) / (sig * sig),
    varpi = (sig * s) / rho;
  const E = 1 / (alpha + omega * varpi * n[2]);
  const pt = E * rho * n[1],
    b = E * varpi * n[2];
  return { y: [r, th, (E * rho * n[0]) / Math.sqrt(dl), pt], phi, b, q: pt * pt + c * c * ((b * b) / (s * s) - a * a) };
}

/**
 * True when a ray at radius r (M) moving inward meets no turning point before the horizon: R(r') = P^2 - Delta ((b - a)^2
 * + q) stays positive at 32 radii from r_+ to r (a turning point is a root of R). The shader stops such rays at once.
 */
export function kerrCaptured(r: number, a: number, b: number, q: number): boolean {
  const rH = kerrHorizon(a),
    bq = (b - a) * (b - a) + q;
  for (let i = 1; i <= 32; i++) {
    const x = rH + ((r - rH) * i) / 32,
      P = x * x + a * a - a * b;
    if (P * P - (x * x - 2 * x + a * a) * bq < 0) return false;
  }
  return true;
}

/** Step factor near the horizon, where Boyer-Lindquist momenta grow as 1 / Delta: clamp(4 Delta / r^2, 0.1, 1). */
export function kerrStepScale(r: number, a: number): number {
  return Math.min(Math.max((4 * (r * r - 2 * r + a * a)) / (r * r), 0.1), 1);
}

/**
 * Traces the ray the shader traces from `origin` along `direction` (scene units, r_s = 1) back in time through Kerr
 * spacetime: the CPU twin of the WGSL integrator, step for step (classic fourth-order Runge-Kutta, the same step size).
 */
export function traceGeodesic(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  options: GeodesicOptions = {},
): Geodesic {
  const a = clampSpin(options.spin ?? 0.9),
    steps = Math.round(clampNumber(options.steps ?? 260, 32, 1024)),
    outer = options.diskOuter ?? 6;
  const rH = kerrHorizon(a),
    isco = kerrIsco(a) / 2;
  const init = kerrInitial(origin, direction, a),
    { b, q } = init;
  let y = init.y,
    phi = init.phi,
    p = fromBoyerLindquist(y[0], y[1], phi, a),
    d = norm([direction[0], direction[1], direction[2]]);
  const out: number[] = [...p],
    disk: number[] = [];
  let fate: Geodesic['fate'] = 'steps',
    drift = 0,
    falling = false;
  const f = (s: readonly number[]) => kerrRhs(s, a, b, q).map((v) => -v);
  for (let i = 0; i < steps; i++) {
    const r = y[0];
    if (r <= rH * 1.02) {
      fate = 'horizon';
      break;
    }
    const k1 = f(y);
    if (r > ESCAPE_RADIUS * 2 && k1[0] > 0) {
      fate = 'escape';
      break;
    }
    if (k1[0] < 0 && r < 4 && (falling || kerrCaptured(r, a, b, q))) {
      falling = true;
      if (r < isco * 2) {
        fate = 'horizon';
        break;
      }
    }
    const h = kerrAxisStep(
      2 * geodesicStep(r / 2, rH / 2) * kerrStepScale(r, a) * Math.min(Math.max(Math.sin(y[1]) * 10, 0.05), 1),
      r,
      y[1],
      a,
      b,
      q,
    );
    const at = (k: number[], t: number) => y.map((v, j) => v + k[j] * t);
    const k2 = f(at(k1, h / 2)),
      k3 = f(at(k2, h / 2)),
      k4 = f(at(k3, h));
    const yn = y.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    phi += (h / 6) * (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4]);
    // Over the spin axis: theta reflects, p_theta turns and phi goes half a turn.
    if (yn[1] < 0 || yn[1] > Math.PI) {
      yn[1] = yn[1] < 0 ? -yn[1] : 2 * Math.PI - yn[1];
      yn[3] = -yn[3];
      phi += kerrAxisTurn(a, b, q);
    }
    const pn = fromBoyerLindquist(yn[0], yn[1], phi, a);
    if (crossesEquator(y[1], yn[1])) {
      const hr = (y[0] + ((yn[0] - y[0]) * (y[1] - Math.PI / 2)) / (y[1] - yn[1])) / 2;
      if (hr >= isco && hr <= outer) disk.push(hr);
    }
    d = norm([pn[0] - p[0], pn[1] - p[1], pn[2] - p[2]]);
    y = yn;
    p = pn;
    drift = Math.max(drift, Math.abs(kerrHamiltonian(y, a, b, q)));
    out.push(...p);
  }
  return { points: new Float32Array(out), fate, disk, direction: [d[0], d[1], d[2]], b, q, drift };
}

type V3 = number[];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
function clampSpin(a: number): number {
  return clampNumber(a, 0, 0.998);
}
function clampNumber(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) throw new RangeError(`BlackHole: ${v} is not a finite number; pass a finite number`);
  return Math.min(Math.max(v, lo), hi);
}

// The march stops escaping rays at r > 160 M, 2 * ESCAPE_RADIUS written out so the WGSL literal has no interpolation (its
// comments are stripped at build time); black-hole.test.js checks the two agree.
const shader = /* wgsl */ `
struct Out { @builtin(position) clip:vec4f, @location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 0.0, 1.0), p);
}

fn bhHash3(p:vec3f)->f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}
fn bhHash2(p:vec2f)->f32 { return bhHash3(vec3f(p, 7.13)); }
fn bhNoise(p:vec3f)->f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(bhHash3(i), bhHash3(i + vec3f(1,0,0)), f.x), mix(bhHash3(i + vec3f(0,1,0)), bhHash3(i + vec3f(1,1,0)), f.x), f.y),
    mix(mix(bhHash3(i + vec3f(0,0,1)), bhHash3(i + vec3f(1,0,1)), f.x), mix(bhHash3(i + vec3f(0,1,1)), bhHash3(i + vec3f(1,1,1)), f.x), f.y),
    f.z) - 0.5;
}
// Band-limited fbm: octave k has 2^k cycles per unit of p; it fades out as the footprint (in units of p) reaches its
// Nyquist limit (Norton et al. 1982), leaving the mean (0) in its place.
fn bhFbm(p:vec3f, foot:f32)->f32 {
  var v = 0.0;
  var a = 0.55;
  var q = p;
  var f = foot;
  for (var k = 0; k < 6; k++) {
    v += a * bhNoise(q) * (1.0 - smoothstep(0.25, 0.5, f));
    q = q * 2.0 + vec3f(17.1, 9.3, 23.7);
    f *= 2.0;
    a *= 0.5;
  }
  return v;
}

fn bhBlackbody(kelvin:f32)->vec3f {
  let T = clamp(kelvin, 1667.0, 25000.0);
  let i = 1000.0 / T;
  var x = -3.0258469 * i * i * i + 2.1070379 * i * i + 0.2226347 * i + 0.24039;
  if (T <= 4000.0) { x = -0.2661239 * i * i * i - 0.2343589 * i * i + 0.8776956 * i + 0.17991; }
  var y = 3.081758 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  if (T <= 4000.0) { y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867; }
  if (T <= 2222.0) { y = -1.1063814 * x * x * x - 1.3481102 * x * x + 2.18555832 * x - 0.20219683; }
  let X = x / y;
  let Z = (1.0 - x - y) / y;
  return max(vec3f(3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z), vec3f(0.0));
}

// Page and Thorne (1974) eq. 15n for M = 1, accretion rate 1; r in M.
fn bhFlux(r:f32)->f32 {
  let a = max(uniforms.spin, 1e-6);
  let x = sqrt(r);
  let x0 = uniforms.x0;
  if (x <= x0) { return 0.0; }
  let x1 = uniforms.x1; let x2 = uniforms.x2; let x3 = uniforms.x3;
  let t1 = 3.0 * (x1 - a) * (x1 - a) / (x1 * (x1 - x2) * (x1 - x3)) * log((x - x1) / (x0 - x1));
  let t2 = 3.0 * (x2 - a) * (x2 - a) / (x2 * (x2 - x1) * (x2 - x3)) * log((x - x2) / (x0 - x2));
  let t3 = 3.0 * (x3 - a) * (x3 - a) / (x3 * (x3 - x1) * (x3 - x2)) * log((x - x3) / (x0 - x3));
  let b = x - x0 - 1.5 * a * log(x / x0) - t1 - t2 - t3;
  return max(0.11936621 * b / (x * x * x * x * (x * x * x - 3.0 * x + 2.0 * a)), 0.0);
}

// Disk opacity at a crossing at cylindrical radius r (r_s): opaque from the ISCO to the outer edge, soft at the rim.
fn bhDiskAlpha(r:f32)->f32 {
  return smoothstep(uniforms.isco * 0.985, uniforms.isco, r) * (1.0 - smoothstep(uniforms.outer * 0.9, uniforms.outer, r));
}

// The two crossfaded phases of the advected texture (Neyret 2003): x = phase age in seconds, y = weight.
fn bhPhase(k:f32)->vec2f {
  let period = 24.0;
  let u = fract(camera.time / period + 0.5 * k);
  return vec2f(u * period, 1.0 - abs(2.0 * u - 1.0));
}

// Noise coordinate of a disk point, carried round by Keplerian rotation for the phase's age.
fn bhDiskCoord(p:vec3f, age:f32, k:f32)->vec3f {
  let rM = max(length(p.xz), 1e-3) * 2.0;
  let omega = 1.0 / (pow(rM, 1.5) + uniforms.spin);
  let phi = atan2(p.z, p.x) + omega * age * uniforms.timeScale;
  return vec3f(cos(phi) * 3.0, sin(phi) * 3.0, log(rM) * 6.0 + k * 31.7);
}

// Light from the disk at crossing p (scene units) for a photon of axial angular momentum bk (M, conserved).
// turb is the filtered turbulence (-0.5 to 0.5).
fn bhDisk(p:vec3f, bk:f32, turb:f32, order:f32)->vec3f {
  let rM = sqrt(max(4.0 * dot(p.xz, p.xz) - uniforms.spin * uniforms.spin, 1e-4));
  let rS = rM * 0.5;
  var f = bhFlux(rM) * uniforms.fluxNorm;
  // An orbiting hot spot that spirals in after flare(start).
  let age = camera.time - uniforms.flareStart;
  if (age >= 0.0 && age < 14.0) {
    let fr = mix(4.2, uniforms.isco * 1.15, clamp(age / 8.0, 0.0, 1.0));
    let fphi = -age * 3.0 - 4.5 * log(max(rS, 0.35));
    let dr = (rS - fr) / 0.42;
    let dphi = sin((atan2(p.z, p.x) - fphi) * 0.5);
    f *= 1.0 + 2.5 * exp(-dr * dr - dphi * dphi * 5.0) * exp(-max(age - 6.0, 0.0) * 0.45);
  }
  // Turbulent brightness is log-normal, as in the surface density of magnetised disk turbulence (Balbus and Hawley 1991,
  // the magnetorotational instability), so hot knots and dark lanes both read; the mean stays near the smooth flux.
  f *= exp(5.0 * uniforms.turbulence * turb);
  // g = 1 / (u^t (1 - Omega b)) for a prograde circular orbit (Bardeen, Press, Teukolsky 1972).
  let s = sqrt(rM);
  let ut = (rM * s + uniforms.spin) / (pow(rM, 0.75) * sqrt(max(rM * s - 3.0 * s + 2.0 * uniforms.spin, 1e-5)));
  let g = 1.0 / (ut * (1.0 - bk / (rM * s + uniforms.spin)));
  let tEm = uniforms.tPeak * pow(max(f, 0.0), 0.25);
  let v = uniforms.view;
  if (v > 3.5) {
    let tint = select(select(vec3f(0.9, 0.25, 1.0), vec3f(0.2, 0.85, 1.0), order < 1.5), vec3f(1.0, 0.62, 0.25), order < 0.5);
    return tint * (0.25 + 0.75 * sqrt(f));
  }
  if (v > 2.5) { return bhBlackbody(tEm) * select(0.0, 1.0, f > 0.0); }
  if (v > 1.5) {
    let e = clamp(log2(g * g * g * g) / 3.0, -1.0, 1.0);
    return mix(vec3f(0.35, 0.35, 0.35), select(vec3f(0.15, 0.3, 1.0), vec3f(1.0, 0.95, 0.4), e > 0.0) * 1.6, abs(e)) * select(0.0, 1.0, f > 0.0);
  }
  if (v > 0.5) {
    let e = clamp((g - 1.0) * 2.5, -1.0, 1.0);
    return mix(vec3f(0.8), select(vec3f(1.0, 0.18, 0.1), vec3f(0.2, 0.45, 1.0), e > 0.0), abs(e)) * select(0.0, 1.0, f > 0.0);
  }
  return bhBlackbody(g * tEm) * (g * g * g * g * f * uniforms.accretion * 0.8);
}

// Lapse of the zero-angular-momentum frame at scene point p (r_s): rho sqrt(Delta) / Sigma, 0 at the horizon, 1 far out.
fn bhLapse(p:vec3f)->f32 {
  let a = uniforms.spin;
  let m = p * 2.0;
  let w = dot(m, m) - a * a;
  let r = sqrt(0.5 * (w + sqrt(w * w + 4.0 * a * a * m.y * m.y)));
  let c = clamp(m.y / max(r, 1e-4), -1.0, 1.0);
  let dl = max(r * r - 2.0 * r + a * a, 0.0);
  let rho2 = r * r + a * a * c * c;
  let sig2 = (r * r + a * a) * (r * r + a * a) - a * a * dl * (1.0 - c * c);
  return sqrt(rho2 * dl / sig2);
}

// Synchrotron jet along the spin axis: a parabolic funnel R = 0.28 |y|^0.58 (Asada and Nakamura 2012), emissivity
// falling as |y|^-2 and switching on from 1.2 to 3 r_s, since the funnel next to the hole is starved of mass and the
// radiating particles load it further out (Blandford and Znajek 1977; McKinney 2006), seen with Doppler factor
// D^(2 + alpha), alpha = 0.7 (Lind and Blandford 1985).
fn bhJet(p:vec3f, rd:vec3f)->f32 {
  let ay = abs(p.y);
  if (ay < 1.2 || ay > 40.0) { return 0.0; }
  let R = 0.28 * pow(ay, 0.58);
  let q = length(p.xz) / R;
  if (q > 3.0) { return 0.0; }
  let gamma = uniforms.jetGamma;
  let beta = sqrt(1.0 - 1.0 / (gamma * gamma));
  let cosT = dot(vec3f(0.0, sign(p.y), 0.0), -rd);
  let D = 1.0 / (gamma * (1.0 - beta * cosT));
  let knots = 0.75 + 0.5 * bhNoise(vec3f(p.x * 2.0, ay * 0.8 - camera.time * 1.5 * sign(p.y), p.z * 2.0));
  // Gravitational redshift: light from near the hole climbs out with the lapse of the zero-angular-momentum frame,
  // alpha = rho sqrt(Delta) / Sigma (Bardeen, Press, Teukolsky 1972), so the frequency ratio is alpha D and the jet's
  // base, just outside the horizon, fades instead of shining over the shadow (kerrLapse is the CPU twin).
  let lapse = bhLapse(p);
  return exp(-q * q * 1.5) * smoothstep(1.2, 3.0, ay) / (ay * ay * R * R) * min(pow(lapse * D, 2.7), 60.0) * knots * 0.02;
}

// Sky: stars on a latitude-band grid and the Milky Way. Stars are points (James et al. 2015): each lands where its
// direction maps through the inverse of the pixel's footprint jacobian J (radians of sky per pixel), drawn with a fixed
// pixel PSF and its magnification mu = (unlensed pixel solid angle) / |det J| as flux. Stars crowd towards the galactic
// plane, as in any star count by latitude, so the lens visibly bends the band and its crowded star field.
const BH_PLANE = vec3f(-0.4198, 0.8996, 0.12);
const BH_CENTRE = vec3f(0.1948, 0.2185, -0.9562);
struct BhFrame { e1:vec3f, e2:vec3f, inv:mat2x2f, det:f32, mu:f32, pixel:f32 }
// Share of grid cells holding a star in direction d: 0.05 at the galactic poles, about 0.2 in the plane.
fn bhStarFill(d:vec3f)->f32 {
  let z = abs(dot(d, BH_PLANE));
  return 0.05 + 0.11 * exp(-z * 6.0) + 0.05 * exp(-(1.0 - dot(d, BH_CENTRE)) * 6.0);
}
fn bhStarCell(d:vec3f, band:f32, dlat:f32, dlon:f32, bands:f32, seed:f32, fr:BhFrame)->vec3f {
  let lat = band + dlat;
  if (lat < 0.0 || lat >= bands) { return vec3f(0.0); }
  let latC = (lat + 0.5) / bands * 3.14159265 - 1.5707963;
  let lonBins = max(floor(cos(latC) * bands * 2.0), 6.0);
  let phi = atan2(d.z, d.x);
  let lon = floor((phi + 3.14159265) / 6.2831853 * lonBins) + dlon;
  let cell = vec2f(lon - floor(lon / lonBins) * lonBins + seed * 17.0, lat + seed * 31.0);
  let rnd = bhHash2(cell);
  if (rnd < 1.0 - bhStarFill(d)) { return vec3f(0.0); }
  let sLat = latC + (bhHash2(cell + vec2f(11.3, 5.9)) - 0.5) * 0.9 * 3.14159265 / bands;
  let sLon = (lon + 0.5 + (bhHash2(cell + vec2f(3.1, 7.7)) - 0.5) * 0.9) / lonBins * 6.2831853 - 3.14159265;
  let s = vec3f(cos(sLat) * cos(sLon), sin(sLat), cos(sLat) * sin(sLon));
  let delta = s - d;
  let px = fr.inv * vec2f(dot(delta, fr.e1), dot(delta, fr.e2));
  // A steep luminosity function: most stars faint, a few bright (mean flux 1).
  let u = bhHash2(cell + vec2f(5.7, 2.3));
  let flux = (0.2 + 4.8 * pow(u, 5.0)) * fr.mu;
  // Colours along the black-body locus, from 3,000 K to 15,000 K, cool stars the commonest.
  let tint = bhBlackbody(3000.0 + 12000.0 * pow(bhHash2(cell + vec2f(9.1, 1.7)), 2.2));
  if (dot(s, d) < 0.0) { return vec3f(0.0); }
  return tint * flux * exp(-dot(px, px) / (2.0 * 0.36)) * 0.44;
}
fn bhStars(d:vec3f, bands:f32, seed:f32, fr:BhFrame)->vec3f {
  let band = floor((asin(clamp(d.y, -1.0, 1.0)) + 1.5707963) / 3.14159265 * bands);
  var c = vec3f(0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      c += bhStarCell(d, band, f32(i), f32(j), bands, seed, fr);
    }
  }
  // Where a pixel sees more than a cell of sky the stars blend into their mean light. Each star's light sums to its flux
  // times mu over the image, so the mean per pixel is fill x mean flux 1 x mu x det / cell^2 = fill x pixel^2 / cell^2:
  // lensing keeps surface brightness.
  let cellAngle = 3.14159265 / bands;
  let w = smoothstep(0.3, 0.7, sqrt(fr.det) / cellAngle);
  return mix(c, vec3f(0.85, 0.82, 0.8) * bhStarFill(d) * fr.pixel * fr.pixel / (cellAngle * cellAngle), w);
}
// The Milky Way: the unresolved light of a thin and a thick disk and a bulge round the galactic centre, cut by dust
// lanes along the mid-plane. Old bulge stars are warm, the disk's young stars bluer.
fn bhGalaxy(d:vec3f, foot:f32)->vec3f {
  let z = dot(d, BH_PLANE);
  let thin = exp(-abs(z) * 7.0);
  let thick = exp(-abs(z) * 2.2);
  let toward = dot(d, BH_CENTRE);
  let bulge = exp(-(1.0 - toward) * 9.0) * exp(-abs(z) * 3.0);
  let clumps = bhFbm(d * 6.0 + vec3f(1.4, -0.8, 2.1), foot * 6.0) + 0.5;
  let lanes = smoothstep(0.38, 0.7, bhFbm(d * 11.0 + vec3f(4.2, 0.3, -1.9), foot * 11.0) + 0.5) * exp(-abs(z + 0.012) * 26.0);
  let disk = (thin * (0.35 + 0.9 * clumps) + 0.25 * thick) * (0.55 + 0.45 * max(toward, 0.0));
  let light = vec3f(0.62, 0.68, 0.85) * disk + vec3f(1.0, 0.72, 0.45) * bulge * 1.4;
  return light * (1.0 - 0.85 * lanes) * 0.02;
}

// Kerr null geodesic right-hand side, Boyer-Lindquist, M = 1, p_t = -1 (James et al. 2015, A.15), negated: the ray runs
// back in time from the camera. y = (r, theta, p_r, p_theta). Mirrors kerrRhs in TypeScript, its axis band (POLE_BAND 0.001, axial rays only) included.
struct BhKD { d:vec4f, dphi:f32 }
fn bhKerr(y:vec4f, a:f32, b:f32, q:f32, band:f32)->BhKD {
  let r = y.x; let pr = y.z; let pt = y.w;
  let s = max(sin(y.y), 1e-6); let inBand = s < band; let S2 = select(s * s, band * band, inBand); let c = cos(y.y); let a2 = a * a;
  let dl = r * r - 2.0 * r + a2; let dlp = 2.0 * r - 2.0;
  let rho2 = r * r + a2 * c * c;
  let P = r * r + a2 - a * b; let bq = (b - a) * (b - a) + q;
  let R = P * P - dl * bq; let Rp = 4.0 * r * P - dlp * bq;
  let Th = q - c * c * (b * b / S2 - a2);
  let barrier = select(2.0 * b * b * c / (s * s * s), 2.0 * b * b * c * s / S2, inBand);
  let A = -dl * pr * pr - pt * pt + Th;
  let B = R / dl; let Bp = (Rp * dl - R * dlp) / (dl * dl);
  let inv = 1.0 / (2.0 * rho2);
  let k = A + B;
  let d = vec4f(dl * pr / rho2, pt / rho2,
    (-dlp * pr * pr + Bp) * inv - k * r / (rho2 * rho2),
    (barrier - 2.0 * a2 * c * s) * inv + k * a2 * c * s / (rho2 * rho2));
  let dphi = select(-2.0, 0.0, inBand) * b * c * c / S2 * inv + (-2.0 * a * P - 2.0 * dl * (b - a)) * inv / dl;
  return BhKD(-d, -dphi);
}
// Mirrors kerrCaptured: no root of R between the horizon and r, so an inward ray falls in.
fn bhCaptured(r:f32, rH:f32, a:f32, b:f32, q:f32)->bool {
  let bq = (b - a) * (b - a) + q;
  for (var i = 1; i <= 32; i++) {
    let x = rH + (r - rH) * f32(i) / 32.0;
    let P = x * x + a * a - a * b;
    if (P * P - (x * x - 2.0 * x + a * a) * bq < 0.0) { return false; }
  }
  return true;
}
fn bhCart(y:vec4f, phi:f32, a:f32, cp:f32, sp:f32)->vec3f {
  let rho = sqrt(y.x * y.x + a * a) * sin(y.y);
  let c = cp * cos(phi) - sp * sin(phi);
  let s = sp * cos(phi) + cp * sin(phi);
  return 0.5 * vec3f(rho * c, y.x * cos(y.y), -rho * s);
}

// The derivatives below run after the march loop, whose breaks depend on each ray; every invocation of a quad has left
// the loop by then (structured control flow reconverges), so they are well defined and the analysis is switched off.
@diagnostic(off, derivative_uniformity) @fragment fn fragment(i:Out)->@location(0) vec4f {
  let v = camera.view;
  let right = vec3f(v[0][0], v[1][0], v[2][0]);
  let up = vec3f(v[0][1], v[1][1], v[2][1]);
  let back = vec3f(v[0][2], v[1][2], v[2][2]);
  let proj = camera.projection;
  var rd = normalize(right * i.ndc.x / proj[0][0] + up * i.ndc.y / proj[1][1] - back);
  let horizon = uniforms.horizon;

  var accum = vec3f(0.0);
  var trans = 1.0;
  // A ray that neither escapes nor ends at the horizon within the step limit circles the photon region: dark too.
  var escaped = false;
  var falling = false;
  var crossings = 0;
  var hp = array<vec3f, 3>(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  var hb = array<f32, 3>(0.0, 0.0, 0.0);
  var hw = array<f32, 3>(0.0, 0.0, 0.0);
  let steps = i32(uniforms.steps);
  let a = uniforms.spin;
  let rH = horizon * 2.0;

  // The camera's ray in the zero-angular-momentum frame (James et al. 2015, A.9 to A.12): Boyer-Lindquist state, b, q.
  let cm = camera.position * 2.0;
  let w0 = dot(cm, cm) - a * a;
  let r0 = sqrt(0.5 * (w0 + sqrt(w0 * w0 + 4.0 * a * a * cm.y * cm.y)));
  let th0 = acos(clamp(cm.y / r0, -1.0, 1.0));
  // phi is counted from the camera's own meridian (cp, sp = cos, sin of its angle), so no atan2 is needed: one GPU
  // driver (Radeon 680M, D3D12) returned atan2(-25, 0.02) half a turn off.
  var phi = 0.0;
  let rc = length(cm.xz);
  let cp = select(1.0, cm.x / rc, rc > 1e-6);
  let sp = select(0.0, -cm.z / rc, rc > 1e-6);
  let s0 = max(sin(th0), 1e-6);
  let c0 = cos(th0);
  let ra = sqrt(r0 * r0 + a * a);
  let er = normalize(vec3f(r0 / ra * s0 * cp, c0, -r0 / ra * s0 * sp));
  let et = normalize(vec3f(ra * c0 * cp, -r0 * s0, -ra * c0 * sp));
  let ep = vec3f(-sp, 0.0, -cp);
  let n = -normalize(vec3f(dot(rd, er), dot(rd, et), dot(rd, ep)));
  let dl0 = r0 * r0 - 2.0 * r0 + a * a;
  let rho0 = sqrt(r0 * r0 + a * a * c0 * c0);
  let sig = sqrt((r0 * r0 + a * a) * (r0 * r0 + a * a) - a * a * dl0 * s0 * s0);
  let alpha = rho0 * sqrt(max(dl0, 1e-6)) / sig;
  let omega = 2.0 * a * r0 / (sig * sig);
  let varpi = sig * s0 / rho0;
  let E = 1.0 / (alpha + omega * varpi * n.z);
  let bk = E * varpi * n.z;
  var y = vec4f(r0, th0, E * rho0 * n.x / sqrt(max(dl0, 1e-6)), E * rho0 * n.y);
  let qk = y.w * y.w + c0 * c0 * (bk * bk / (s0 * s0) - a * a);
  let kq = sqrt(max(qk + a * a, 1e-9));
  let tMin = abs(bk) / kq;
  // Mirrors kerrAxial: an axial ray meets the held barrier inside the band (POLE_BAND 0.001); 0 turns the band off.
  let band = select(0.0, 0.001, tMin <= 0.00033333);
  // Mirrors kerrAxisTurn: the phi turn at a reflection over the axis.
  let axisTurn = select(3.14159265, sign(bk) * 2.0 * acos(min(tMin / 0.001, 1.0)), band > 0.0);
  let turnAt = select(tMin, 0.001, band > 0.0);

  for (var step = 0; step < steps; step++) {
    let r = y.x;
    if (r <= rH * 1.02) { break; }
    let k1 = bhKerr(y, a, bk, qk, band);
    if (r > 160.0 && k1.d.x > 0.0) { escaped = true; break; }
    // A captured ray still crosses the disk on its way in: stop it only inside the ISCO, where nothing shines.
    if (k1.d.x < 0.0 && r < 4.0 && (falling || bhCaptured(r, rH, a, bk, qk))) {
      falling = true;
      if (r < uniforms.isco * 2.0) { break; }
    }
    var dt = 2.0 * min(max(0.028 * max(0.5 * r - horizon * 0.9, 0.035) + 0.00105 * r * r, 0.012), max(0.65, 0.1 * r)) *
      clamp(4.0 * (r * r - 2.0 * r + a * a) / (r * r), 0.1, 1.0) * clamp(sin(y.y) * 10.0, 0.05, 1.0);
    // Mirrors kerrAxisStep: resolve a turn near the spin axis.
    let sa = abs(sin(y.y));
    if (sa < 0.2) {
      let dTheta = select(0.25 * max(sa - turnAt, 0.4 * turnAt), 0.0005, sa < band);
      dt = min(dt, dTheta * (r * r + a * a * cos(y.y) * cos(y.y)) / kq);
    }
    let k2 = bhKerr(y + k1.d * (0.5 * dt), a, bk, qk, band);
    let k3 = bhKerr(y + k2.d * (0.5 * dt), a, bk, qk, band);
    let k4 = bhKerr(y + k3.d * dt, a, bk, qk, band);
    let yn = y + (k1.d + 2.0 * k2.d + 2.0 * k3.d + k4.d) * (dt / 6.0);
    let phin = phi + (k1.dphi + 2.0 * k2.dphi + 2.0 * k3.dphi + k4.dphi) * (dt / 6.0);
    // Over the spin axis: theta reflects, p_theta turns and phi goes half a turn.
    var ynn = yn;
    var phn = phin;
    if (ynn.y < 0.0) { ynn = vec4f(ynn.x, -ynn.y, ynn.z, -ynn.w); phn += axisTurn; }
    if (ynn.y > 3.14159265) { ynn = vec4f(ynn.x, 6.2831853 - ynn.y, ynn.z, -ynn.w); phn += axisTurn; }
    let p0 = bhCart(y, phi, a, cp, sp);
    let p1 = bhCart(ynn, phn, a, cp, sp);
    let seg = p1 - p0;
    let segLen = length(seg);
    let dir = seg / max(segLen, 1e-6);

    // The jet is sampled at four points per step, so its funnel (at least 0.17 r_s wide) is never stepped over.
    let mid = 0.5 * (p0 + p1);
    if (uniforms.jet > 0.0 && abs(mid.y) > 0.5 && length(mid.xz) < 0.9 * pow(abs(mid.y), 0.58) + segLen) {
      var j = 0.0;
      for (var s = 0; s < 4; s++) { j += bhJet(p0 + seg * ((f32(s) + 0.5) * 0.25), dir); }
      accum += trans * vec3f(0.55, 0.72, 1.0) * j * 0.25 * segLen * uniforms.jet;
    }

    // Half open (the plane counts with theta >= pi / 2, so a path through it is counted once), as crossesEquator:
    // the product test missed a crossing whenever a step landed on theta = pi / 2 in f32, a dark speck on the disk.
    if ((y.y < 1.5707963) != (yn.y < 1.5707963)) {
      let t = (y.y - 1.5707963) / (y.y - yn.y);
      let hit = mix(p0, p1, t);
      let opacity = bhDiskAlpha(0.5 * mix(y.x, yn.x, t));
      if (opacity > 0.0) {
        if (crossings < 3) {
          hp[crossings] = hit;
          hb[crossings] = bk;
          hw[crossings] = trans * opacity;
        } else {
          accum += trans * opacity * bhDisk(hit, bk, 0.0, 3.0);
        }
        trans *= 1.0 - opacity;
        crossings += 1;
      }
    }
    y = ynn;
    phi = phn;
    rd = dir;
    if (trans < 0.004) { break; }
  }

  if (uniforms.view > 4.5) { return vec4f(select(0.0,1.0,escaped), f32(crossings)/3.0, y.x/400.0, 1.0); }
  // Ray differentials (Igehy 1999), in uniform control flow after the march: the footprint of each disk image in its
  // texture coordinates, and the jacobian of the escaping direction per pixel.
  let pf = uniforms.prefilter;
  var turb = array<f32, 3>(0.0, 0.0, 0.0);
  let ph0 = bhPhase(0.0);
  let ph1 = bhPhase(1.0);
  let q00 = bhDiskCoord(hp[0], ph0.x, 0.0); let q01 = bhDiskCoord(hp[0], ph1.x, 1.0);
  let q10 = bhDiskCoord(hp[1], ph0.x, 0.0); let q11 = bhDiskCoord(hp[1], ph1.x, 1.0);
  let q20 = bhDiskCoord(hp[2], ph0.x, 0.0); let q21 = bhDiskCoord(hp[2], ph1.x, 1.0);
  let f00 = max(length(dpdx(q00)), length(dpdy(q00))) * pf; let f01 = max(length(dpdx(q01)), length(dpdy(q01))) * pf;
  let f10 = max(length(dpdx(q10)), length(dpdy(q10))) * pf; let f11 = max(length(dpdx(q11)), length(dpdy(q11))) * pf;
  let f20 = max(length(dpdx(q20)), length(dpdy(q20))) * pf; let f21 = max(length(dpdx(q21)), length(dpdy(q21))) * pf;
  turb[0] = ph0.y * bhFbm(q00, f00) + ph1.y * bhFbm(q01, f01);
  turb[1] = ph0.y * bhFbm(q10, f10) + ph1.y * bhFbm(q11, f11);
  turb[2] = ph0.y * bhFbm(q20, f20) + ph1.y * bhFbm(q21, f21);
  let dx = dpdx(rd);
  let dy = dpdy(rd);

  // Every value made from a derivative is used in uniform control flow, never only inside a branch on this ray: a
  // compiler may sink a derivative into the one branch that uses it, where the quad's other invocations may not run.
  // ANGLE's Direct3D 11 back end on an NVIDIA RTX A6000 did, and returned 0, so the shadow's edge drew a ring of
  // unblended stars at the magnification cap and the disk lost its footprint. The disk images past the crossings and the
  // sky of a ray that did not escape weigh 0 (hw starts at 0; sky below).
  for (var k = 0; k < 3; k++) {
    accum += hw[k] * bhDisk(hp[k], hb[k], turb[k], f32(k));
  }

  {
    let sky = select(0.0, trans, escaped);
    // A ray that did not escape may end on a zero step; its direction only has to be finite, as its sky weighs 0.
    let d = select(vec3f(0.0, 0.0, 1.0), normalize(rd), dot(rd, rd) > 0.0);
    var e1 = cross(vec3f(0.0, 1.0, 0.0), d);
    if (dot(e1, e1) < 1e-8) { e1 = vec3f(1.0, 0.0, 0.0); }
    e1 = normalize(e1);
    let e2 = cross(d, e1);
    let pixel = 2.0 / (camera.resolution.y * proj[1][1]);
    // Point-sampled (prefilter off): the unlensed pixel stands in for J, so stars stretch with the lens as in a plain march.
    let jx = mix(vec2f(pixel, 0.0), vec2f(dot(dx, e1), dot(dx, e2)), pf);
    let jy = mix(vec2f(0.0, pixel), vec2f(dot(dy, e1), dot(dy, e2)), pf);
    let det = max(abs(jx.x * jy.y - jy.x * jx.y), 1e-14);
    let inv = mat2x2f(vec2f(jy.y, -jx.y), vec2f(-jy.x, jx.x)) * (1.0 / det);
    let mu = min(pixel * pixel / det, 40.0);
    let fr = BhFrame(e1, e2, inv, det, mu, pixel);
    let foot = sqrt(det) * pf;
    let starLight = bhStars(d, 140.0, 1.0, fr) + bhStars(d, 300.0, 2.0, fr) * 0.6;
    accum += sky * (starLight * uniforms.stars + bhGalaxy(d, foot) * uniforms.galaxy * select(1.0, 0.25, uniforms.view > 0.5));
  }
  return margoDisplay(vec4f(accum * uniforms.exposure, 1.0));
}
`;

/** The shader source the material compiles (the full-screen vertex and fragment stages). */
export const blackHoleShader: string = shader;

/**
 * A black hole drawn behind everything else by a full-screen pass of a {@link RawShaders}: the lensed disk (Page-Thorne
 * flux, redshift and beaming), its jet and a lensed sky. Change any property between frames; nothing recompiles.
 */
export class BlackHole {
  readonly material: RawShaderMaterial;
  readonly mesh: RawMesh;
  readonly raw: RawShaders;
  private readonly owned: boolean;
  private paths: RawMesh | null = null;
  private pathMaterial: RawShaderMaterial | null = null;
  private disposed = false;

  /** Adds a RawShaders to `engine` and a BlackHole to it. */
  static attach(engine: EngineKernel, options: BlackHoleOptions = {}): BlackHole {
    return new BlackHole(RawShaders.attach(engine, { name: 'shader:black-hole' }), options, true);
  }

  constructor(raw: RawShaders, options: BlackHoleOptions = {}, ownsRaw = false) {
    this.raw = raw;
    this.owned = ownsRaw;
    this.material = new RawShaderMaterial({
      vertexShader: shader,
      uniforms: Object.fromEntries(
        [
          'spin',
          'accretion',
          'jet',
          'jetGamma',
          'turbulence',
          'view',
          'prefilter',
          'horizon',
          'isco',
          'outer',
          'tPeak',
          'fluxNorm',
          'x0',
          'x1',
          'x2',
          'x3',
          'flareStart',
          'timeScale',
          'exposure',
          'steps',
          'stars',
          'galaxy',
        ].map((n) => [n, { value: 0 }]),
      ),
      depthTest: false,
      depthWrite: false,
      cull: 'none',
      name: 'black-hole',
    });
    this.u('flareStart', -1e6);
    this.mesh = new RawMesh({ material: this.material, vertexCount: 3, renderOrder: -1000, frustumCulled: false });
    this.spin = options.spin ?? 0.9;
    this.accretion = options.accretion ?? 1;
    this.peakTemperature = options.peakTemperature ?? 4500;
    this.diskOuter = options.diskOuter ?? 6;
    this.turbulence = options.turbulence ?? 0.6;
    this.jet = options.jet ?? 0.5;
    this.jetLorentz = options.jetLorentz ?? 5;
    this.stars = options.stars ?? 1;
    this.galaxy = options.galaxy ?? 1;
    this.timeScale = options.timeScale ?? 6;
    this.exposure = options.exposure ?? 1;
    this.view = options.view ?? 'beauty';
    this.prefilter = options.prefilter ?? true;
    this.steps = options.steps ?? 260;
    raw.add(this.mesh);
  }

  private u(name: string, value: number): void {
    this.material.uniforms[name].value = value;
  }
  private g(name: string): number {
    return this.material.uniforms[name].value as number;
  }

  get spin(): number {
    return this.g('spin');
  }
  set spin(a: number) {
    a = clampSpin(a);
    this.u('spin', a);
    this.u('horizon', kerrHorizon(a) / 2);
    this.u('isco', kerrIsco(a) / 2);
    const [x1, x2, x3] = fluxRoots(Math.max(a, 1e-6));
    this.u('x0', Math.sqrt(kerrIsco(a)));
    this.u('x1', x1);
    this.u('x2', x2);
    this.u('x3', x3);
    let peak = 0;
    const isco = kerrIsco(a);
    for (let i = 1; i <= 400; i++) peak = Math.max(peak, novikovThorneFlux(isco * (1 + (i / 400) * 8), a));
    this.u('fluxNorm', 1 / peak);
  }
  /** Event horizon radius in r_s. */
  get horizon(): number {
    return this.g('horizon');
  }
  /** ISCO radius in r_s, where the disk starts. */
  get isco(): number {
    return this.g('isco');
  }
  get accretion(): number {
    return this.g('accretion');
  }
  set accretion(v: number) {
    this.u('accretion', clampNumber(v, 0, 100));
  }
  get peakTemperature(): number {
    return this.g('tPeak');
  }
  set peakTemperature(v: number) {
    this.u('tPeak', clampNumber(v, 1000, 100000));
  }
  get diskOuter(): number {
    return this.g('outer');
  }
  set diskOuter(v: number) {
    this.u('outer', clampNumber(v, 1.5, 40));
  }
  get turbulence(): number {
    return this.g('turbulence');
  }
  set turbulence(v: number) {
    this.u('turbulence', clampNumber(v, 0, 1));
  }
  get jet(): number {
    return this.g('jet');
  }
  set jet(v: number) {
    this.u('jet', clampNumber(v, 0, 1));
  }
  get jetLorentz(): number {
    return this.g('jetGamma');
  }
  set jetLorentz(v: number) {
    this.u('jetGamma', clampNumber(v, 1.0001, 20));
  }
  get stars(): number {
    return this.g('stars');
  }
  set stars(v: number) {
    this.u('stars', clampNumber(v, 0, 100));
  }
  get galaxy(): number {
    return this.g('galaxy');
  }
  set galaxy(v: number) {
    this.u('galaxy', clampNumber(v, 0, 100));
  }
  get timeScale(): number {
    return this.g('timeScale');
  }
  set timeScale(v: number) {
    this.u('timeScale', clampNumber(v, 0, 1000));
  }
  get exposure(): number {
    return this.g('exposure');
  }
  set exposure(v: number) {
    this.u('exposure', clampNumber(v, 0, 1e4));
  }
  get view(): BlackHoleView {
    return VIEWS[this.g('view')];
  }
  set view(v: BlackHoleView) {
    const i = VIEWS.indexOf(v);
    if (i < 0) throw new RangeError(`BlackHole view must be one of ${VIEWS.join(', ')}`);
    this.u('view', i);
  }
  get prefilter(): boolean {
    return this.g('prefilter') > 0;
  }
  set prefilter(on: boolean) {
    this.u('prefilter', on ? 1 : 0);
  }
  get steps(): number {
    return this.g('steps');
  }
  set steps(n: number) {
    this.u('steps', Math.round(clampNumber(n, 32, 1024)));
  }
  /** Starts a hot spot at the disk's outer part that spirals in over 8 s; `start` is the shader clock (camera.time). */
  flare(start: number): void {
    this.u('flareStart', clampNumber(start, -1e9, 1e9));
  }

  /**
   * Draws the paths of `rays` (from {@link traceGeodesic}) as lines over the picture, coloured by fate: amber for rays
   * that cross the disk, blue for rays that escape, red for rays the hole takes. An empty list removes them.
   */
  showGeodesics(rays: readonly Geodesic[]): void {
    if (this.paths) {
      this.raw.remove(this.paths);
      this.paths = null;
    }
    const position: number[] = [],
      color: number[] = [];
    for (const ray of rays) {
      const c = ray.fate === 'horizon' ? [1, 0.25, 0.2] : ray.disk.length ? [1, 0.7, 0.3] : [0.35, 0.65, 1];
      const p = ray.points;
      for (let i = 3; i < p.length; i += 3) {
        position.push(p[i - 3], p[i - 2], p[i - 1], p[i], p[i + 1], p[i + 2]);
        color.push(...c, ...c);
      }
    }
    if (!position.length) return;
    this.pathMaterial ??= new RawShaderMaterial({
      vertexShader: /* wgsl */ `
struct PathOut { @builtin(position) clip:vec4f, @location(0) color:vec3f }
@vertex fn vertex(a:Attributes)->PathOut { return PathOut(camera.viewProjection * mesh.world * vec4f(a.position, 1.0), a.color); }
@fragment fn fragment(i:PathOut)->@location(0) vec4f { return margoDisplay(vec4f(i.color * 0.9, 1.0)); }`,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: 'additive',
      cull: 'none',
      name: 'black-hole-geodesics',
    });
    this.paths = this.raw.add(
      new RawMesh({
        material: this.pathMaterial,
        attributes: {
          position: { data: new Float32Array(position), type: 'vec3f' },
          color: { data: new Float32Array(color), type: 'vec3f' },
        },
        topology: 'line-list',
        frustumCulled: false,
      }),
    );
  }

  /** Removes the meshes (and the RawShaders when {@link BlackHole.attach} made it). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.paths) this.raw.remove(this.paths);
    this.raw.remove(this.mesh);
    this.material.dispose();
    this.pathMaterial?.dispose();
    if (this.owned) this.raw.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
