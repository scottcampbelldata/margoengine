// The water a heaving section moves and the waves it makes (SEA-08): Ursell's multipole solution for a half circle as
// Tasai carried it to Lewis forms (Journee and Massie, *Offshore Hydromechanics*, TU Delft 2001, sections 7.3.1 and
// 7.3.3, eqs. 7.71-7.79 and 7.103-7.112; Ursell, "On the heaving motion of a circular cylinder on the surface of a fluid",
// QJMAM 2, 1949, and Tasai 1959, known through the book). Deep water, y downward, theta from the y axis.
//
// The flow is a pulsating source and dipole at the waterline that sends out the waves (phi_B, with its stream function
// psi_B), plus a series of multipoles that die away from the hull (phi_A2m, psi_A2m on the section's contour). The stream
// function on the contour must equal minus the flux of the hull's motion through it from the keel (the body condition
// Psi0 = -y' x0 + C, the constant fixed at the keel where x0 = 0 and every psi_A2m is 0); solved for the multipoles' strengths
// and the ratio of the hull's motion to the waves' (by least squares over points round the contour), the pressure on the
// hull gives the added mass M33 and the damping N33, and the waves give the damping again: the energy they carry away,
// N33 = rho g^2 Abar^2 / w^3, Abar the waves' amplitude over the hull's. The two must agree, which the tests hold.
//
// The integral part of the waves' potential is -e^{ikz} E1(ikz) (z = x + i y), its stream function the imaginary part:
// checked against direct quadrature of the book's integrals (eq. 7.74) before it was used. E1 by its series, which converges
// everywhere and, for the arguments here (|k z| up to a few tens), keeps its accuracy in f64.
import { cos, exp, hypot, ln, sin } from '@margoengine/math/pinned';
import type { LewisForm } from './strips.js';

/** Euler's constant. */
const EULER = 0.5772156649015329;

/** The angle of (re, im), in (-pi, pi]: Newton's steps on the pinned sine and cosine from a first guess. */
function angle(re: number, im: number): number {
  const r = hypot(re, im);
  if (!(r > 0)) return 0;
  // A first guess within about 0.07 rad (the octant and a rational approximation of the arc), then three Newton steps on
  // e(t) = im cos t - re sin t, whose root is the angle: quadratic, so the rounding of a double after three.
  const ax = re < 0 ? -re : re,
    ay = im < 0 ? -im : im,
    small = ax > ay ? ay / ax : ax / ay,
    base = (small * Math.PI) / 4 + 0.273 * small * (1 - small),
    first = ax > ay ? base : Math.PI / 2 - base;
  let t =
    re >= 0
      ? im >= 0 || Object.is(im, 0)
        ? first
        : -first
      : im > 0 || Object.is(im, 0)
        ? Math.PI - first
        : -(Math.PI - first);
  for (let step = 0; step < 3; step++) {
    const c = cos(t),
      s = sin(t);
    t += (im * c - re * s) / r;
  }
  return t;
}

/** E1(z), the exponential integral, principal branch, by its series: -gamma - Log z - sum (-z)^n / (n n!). */
function e1(re: number, im: number, belowCut = false): [number, number] {
  let sr = 0,
    si = 0,
    tr = 1,
    ti = 0;
  for (let n = 1; n < 400; n++) {
    // term *= -z / n
    const nr = (-re * tr + im * ti) / n,
      ni = (-re * ti - im * tr) / n;
    tr = nr;
    ti = ni;
    sr += tr / n;
    si += ti / n;
    if (hypot(tr, ti) < 1e-18 * (1 + hypot(sr, si)) && n > 4) break;
  }
  const arg = belowCut ? -Math.PI : angle(re, im);
  return [-EULER - ln(hypot(re, im)) - sr, -arg - si];
}

/** -i e^{-ikw} E1(-ikw), w = x - i y: its real part is the integral of psi_Bs, its imaginary part that of phi_Bs. */
function waveIntegral(k: number, x: number, y: number): [number, number] {
  const ar = -k * y,
    ai = -k * x,
    [er, ei] = e1(ar, ai, x === 0),
    m = exp(ar),
    cr = m * cos(ai),
    ci = m * sin(ai),
    pr = cr * er - ci * ei,
    pi = cr * ei + ci * er;
  // times -i: (pr + i pi)(-i) = pi - i pr
  return [pi, -pr];
}

/** Gauss-Legendre nodes and weights on [0, 1]. */
function gaussLegendre(n: number): [Float64Array, Float64Array] {
  const x = new Float64Array(n),
    w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = cos((Math.PI * (i + 0.75)) / (n + 0.5)),
      d = 0;
    for (let step = 0; step < 100; step++) {
      let p0 = 1,
        p1 = t;
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * t * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      d = (n * (t * p1 - p0)) / (t * t - 1);
      const dt = p1 / d;
      t -= dt;
      if ((dt < 0 ? -dt : dt) < 1e-16) break;
    }
    x[i] = (1 - t) / 2;
    w[i] = 1 / ((1 - t * t) * d * d);
  }
  return [x, w];
}

/** A heaving section's added mass (kg/m) and damping (N s/m^2), and the ratio of the waves it makes to its motion. */
export interface HeaveSection {
  readonly addedMass: number;
  readonly damping: number;
  /** The damping again, from the energy the waves carry away: it must equal `damping`. */
  readonly dampingFromWaves: number;
  /** The waves' amplitude over the heave's. */
  readonly waveRatio: number;
}

const QUADRATURE = gaussLegendre(48);

/**
 * The heave added mass and damping per metre of a section of Lewis form `form` at frequency `omega` (rad/s), in deep water of
 * density `density`. `terms` multipoles (default 16), fitted at `points` angles round the contour (default 64): the gap
 * between the two dampings shrinks as they grow (at xi = w^2 M / g = 4 on a half circle, 0.5, 0.2 and 0.08 percent at 10, 16
 * and 24 terms on 40, 64 and 96 points).
 */
export function heaveSection(
  form: LewisForm,
  omega: number,
  density: number,
  gravity = 9.81,
  terms = 16,
  points = 64,
): HeaveSection {
  const { scale: ms, a1, a3 } = form,
    k = (omega * omega) / gravity,
    xi = (omega * omega * ms) / gravity,
    draft = ms * (1 - a1 + a3),
    contour = (t: number): [number, number] => [
      ms * ((1 + a1) * sin(t) - a3 * sin(3 * t)),
      ms * ((1 - a1) * cos(t) + a3 * cos(3 * t)),
    ],
    slope = (t: number) => ms * ((1 + a1) * cos(t) - 3 * a3 * cos(3 * t)),
    coefficients = [1, a1, a3],
    // The multipoles on the contour, eq. 7.109: m from 1.
    multipole = (m: number, t: number, stream: boolean): number => {
      let sum = 0;
      for (let n = 0; n < 3; n++) {
        const order = 2 * m + 2 * n - 1,
          c = ((n % 2 === 0 ? 1 : -1) * (2 * n - 1) * coefficients[n]!) / order;
        sum += c * (stream ? sin(order * t) : cos(order * t));
      }
      return (stream ? sin(2 * m * t) : cos(2 * m * t)) - xi * sum;
    },
    psiBc = (x: number, y: number) => Math.PI * exp(-k * y) * sin(k * x),
    phiBc = (x: number, y: number) => Math.PI * exp(-k * y) * cos(k * x),
    psiBs = (x: number, y: number) => -Math.PI * exp(-k * y) * cos(k * x) + waveIntegral(k, x, y)[0],
    phiBs = (x: number, y: number) => Math.PI * exp(-k * y) * sin(k * x) + waveIntegral(k, x, y)[1],
    keel = psiBs(0, draft);
  // Least squares over the contour: unknowns P_1..P_M and p (the cos part), Q_1..Q_M and q (the sin part).
  const size = terms + 1,
    normal = new Float64Array(size * size),
    rc = new Float64Array(size),
    rs = new Float64Array(size),
    row = new Float64Array(size);
  for (let j = 1; j <= points; j++) {
    const t = (j * Math.PI) / (2 * points),
      [x0, y0] = contour(t);
    for (let m = 1; m <= terms; m++) row[m - 1] = multipole(m, t, true);
    row[terms] = -Math.PI * k * x0;
    const bc = -psiBc(x0, y0),
      bs = -(psiBs(x0, y0) - keel);
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) normal[a * size + b]! += row[a]! * row[b]!;
      rc[a]! += row[a]! * bc;
      rs[a]! += row[a]! * bs;
    }
  }
  const P = solve(normal, rc, size),
    Q = solve(normal, rs, size),
    p = P[terms]!,
    q = Q[terms]!;
  // The pressure's integrals over the contour, I_c and I_s.
  let ic = 0,
    is = 0;
  const [nodes, weights] = QUADRATURE;
  for (let i = 0; i < nodes.length; i++) {
    const t = (nodes[i]! * Math.PI) / 2,
      w = (weights[i]! * Math.PI) / 2,
      [x0, y0] = contour(t),
      dx = slope(t);
    let c = phiBc(x0, y0),
      s = phiBs(x0, y0);
    for (let m = 1; m <= terms; m++) {
      const f = multipole(m, t, false);
      c += P[m - 1]! * f;
      s += Q[m - 1]! * f;
    }
    ic += w * c * dx;
    is += w * s * dx;
  }
  const K = (2 * density * gravity) / Math.PI,
    pq = p * p + q * q,
    addedMass = (K * (q * is + p * ic)) / (omega * omega * pq),
    damping = (K * (p * is - q * ic)) / (omega * pq),
    ratio = 1 / Math.sqrt(pq);
  return {
    addedMass,
    damping,
    dampingFromWaves: (density * gravity * gravity * ratio * ratio) / (omega * omega * omega),
    waveRatio: ratio,
  };
}

/** A section's sway and roll coefficients: added mass and damping, each from the pressure and the diagonal ones again from the waves. */
export interface LateralSection {
  /** Sway: added mass kg/m, damping N s/m^2, the damping from the waves. */
  readonly sway: { readonly addedMass: number; readonly damping: number; readonly dampingFromWaves: number };
  /** Roll about the section's own point at depth `pivot`: added inertia kg m, damping N m s, the damping from the waves. */
  readonly roll: { readonly addedMass: number; readonly damping: number; readonly dampingFromWaves: number };
  /** The sway force of a roll (kg, N s/m) and the roll moment of a sway: the two must be equal (reciprocity). */
  readonly swayOfRoll: { readonly addedMass: number; readonly damping: number };
  readonly rollOfSway: { readonly addedMass: number; readonly damping: number };
}

/**
 * Sway, sway-roll and roll inertia per metre when the free surface holds potential zero.
 * On the Lewis mapping's quadrant the stream functions expand in cos(2m theta)
 * and the conjugate potentials in -sin(2m theta). Their Dirichlet energy gives
 * rho*pi times the sum of m times each pair of stream coefficients.
 */
export function lateralAddedMassInfinite(form: LewisForm, density: number, pivot: number):
  { a22: number; a24: number; a44: number } {
  const { scale, a1, a3 } = form;
  const scaleSquared = scale * scale;
  const factor = 4 * scale / Math.PI;
  let a22 = 0;
  let a24 = 0;
  let a44 = 0;
  for (let m = 1; m <= 128; m++) {
    const order = 4 * m * m;
    const sway = (m % 2 ? -factor : factor) * ((1 - a1) / (1 - order) - 3 * a3 / (9 - order));
    const shape = m === 1 ? scaleSquared * a1 * (1 + a3) : m === 2 ? -scaleSquared * a3 : 0;
    const roll = pivot * sway + shape;
    a22 += m * sway * sway;
    a24 += m * sway * roll;
    a44 += m * roll * roll;
  }
  const scaleMass = Math.PI * density;
  return { a22: scaleMass * a22, a24: scaleMass * a24, a44: scaleMass * a44 };
}

/**
 * The sway and roll added mass and damping per metre of a section of Lewis form `form` at `omega` rad/s, rolling about the
 * point `pivot` metres below the waterline on its centre line (negative above it), in deep water (Journee and Massie eqs.
 * 7.70, 7.73, 7.105-7.112, the antisymmetric potentials, and the same least squares as `heaveSection`).
 *
 * One formulation for every mode: the hull's motion V(t) in mode i puts the stream function V S_i(theta) + C on the contour
 * (S = y0 for sway, -((x0^2 + (y0 - pivot)^2) / 2 for roll about the pivot, -x0 for heave), the constant taken off at the keel;
 * the pressure of the solution of mode i on mode j's motion, 2 integral of p dS_j, is mode j's force, so with p and q the
 * motion's two parts over the waves' amplitude, M_ji w^2 (p^2 + q^2) = -K (q I_s + p I_c) and N_ji w (p^2 + q^2) =
 * K (q I_c - p I_s), K = 2 rho g / pi, I the potentials' integrals against dS_j. Two of the book's printed forms carry a
 * wrong sign (the sway multipoles' stream function on the contour, eqs. 7.76 and 7.108, and the circle's sway body condition,
 * eq. 7.66): the forms used are those that satisfy Cauchy-Riemann with their potentials (eqs. 7.73 and 7.106).
 */
export function lateralSection(
  form: LewisForm,
  omega: number,
  density: number,
  pivot: number,
  gravity = 9.81,
  terms = 16,
  points = 64,
): LateralSection {
  const { scale: ms, a1, a3 } = form,
    k = (omega * omega) / gravity,
    xi = (omega * omega * ms) / gravity,
    draft = ms * (1 - a1 + a3),
    contour = (t: number): [number, number] => [
      ms * ((1 + a1) * sin(t) - a3 * sin(3 * t)),
      ms * ((1 - a1) * cos(t) + a3 * cos(3 * t)),
    ],
    dx0 = (t: number) => ms * ((1 + a1) * cos(t) - 3 * a3 * cos(3 * t)),
    dy0 = (t: number) => ms * (-(1 - a1) * sin(t) - 3 * a3 * sin(3 * t)),
    coefficients = [1, a1, a3],
    // The antisymmetric multipoles on the contour (eq. 7.106): m from 1.
    multipole = (m: number, t: number, stream: boolean): number => {
      let sum = 0;
      for (let n = 0; n < 3; n++) {
        const order = 2 * m + 2 * n,
          c = ((n % 2 === 0 ? 1 : -1) * (2 * n - 1) * coefficients[n]!) / order;
        sum += c * (stream ? cos(order * t) : sin(order * t));
      }
      return stream ? -cos((2 * m + 1) * t) + xi * sum : sin((2 * m + 1) * t) - xi * sum;
    },
    psiBc = (x: number, y: number) => Math.PI * exp(-k * y) * cos(k * x),
    phiBc = (x: number, y: number) => -Math.PI * exp(-k * y) * sin(k * x),
    psiBs = (x: number, y: number) =>
      Math.PI * exp(-k * y) * sin(k * x) + waveIntegral(k, x, y)[1] - y / (k * (x * x + y * y)),
    phiBs = (x: number, y: number) =>
      Math.PI * exp(-k * y) * cos(k * x) - waveIntegral(k, x, y)[0] + x / (k * (x * x + y * y)),
    keelC = psiBc(0, draft),
    keelS = psiBs(0, draft),
    keelA = Array.from({ length: terms }, (_, m) => multipole(m + 1, 0, true)),
    shapes = {
      sway: (t: number) => contour(t)[1],
      roll: (t: number) => {
        const [x0, y0] = contour(t);
        return -(x0 * x0 + (y0 - pivot) * (y0 - pivot)) / 2;
      },
    },
    slopes = {
      sway: (t: number) => dy0(t),
      roll: (t: number) => {
        const [x0, y0] = contour(t);
        return -(x0 * dx0(t) + (y0 - pivot) * dy0(t));
      },
    },
    K = (2 * density * gravity) / Math.PI,
    [nodes, weights] = QUADRATURE;
  // One radiation problem: mode `mode`'s motion, solved for the multipoles and the motion over the waves.
  const solveMode = (mode: 'sway' | 'roll') => {
    const shape = shapes[mode],
      size = terms + 1,
      normal = new Float64Array(size * size),
      rc = new Float64Array(size),
      rs = new Float64Array(size),
      row = new Float64Array(size),
      keel = shape(0);
    let spread = 0;
    for (let j = 1; j <= points; j++) {
      const t = (j * Math.PI) / (2 * points),
        [x0, y0] = contour(t);
      for (let m = 1; m <= terms; m++) row[m - 1] = multipole(m, t, true) - keelA[m - 1]!;
      const ds = shape(t) - keel;
      spread = Math.max(spread, ds < 0 ? -ds : ds);
      row[terms] = Math.PI * k * ds;
      const bc = -(psiBc(x0, y0) - keelC),
        bs = -(psiBs(x0, y0) - keelS);
      for (let a = 0; a < size; a++) {
        for (let b = 0; b < size; b++) normal[a * size + b]! += row[a]! * row[b]!;
        rc[a]! += row[a]! * bc;
        rs[a]! += row[a]! * bs;
      }
    }
    // A motion that moves no water normal to the contour (a half circle rolling about its centre) makes no waves.
    if (!(spread > 1e-9 * ms * ms)) return null;
    const P = solve(normal, rc, size),
      Q = solve(normal, rs, size);
    return { P, Q, p: P[terms]!, q: Q[terms]! };
  };
  // Mode j's force from mode i's solution.
  const load = (solution: ReturnType<typeof solveMode>, j: 'sway' | 'roll') => {
    if (!solution) return { addedMass: 0, damping: 0 };
    const { P, Q, p, q } = solution,
      slope = slopes[j];
    let ic = 0,
      is = 0;
    for (let n = 0; n < nodes.length; n++) {
      const t = (nodes[n]! * Math.PI) / 2,
        w = (weights[n]! * Math.PI) / 2,
        [x0, y0] = contour(t),
        d = slope(t);
      let c = phiBc(x0, y0),
        s = phiBs(x0, y0);
      for (let m = 1; m <= terms; m++) {
        const f = multipole(m, t, false);
        c += P[m - 1]! * f;
        s += Q[m - 1]! * f;
      }
      ic += w * c * d;
      is += w * s * d;
    }
    const pq = p * p + q * q;
    return {
      addedMass: (-K * (q * is + p * ic)) / (omega * omega * pq),
      damping: (K * (q * ic - p * is)) / (omega * pq),
    };
  };
  const waves = (solution: ReturnType<typeof solveMode>) =>
      solution
        ? (density * gravity * gravity) / (omega * omega * omega * (solution.p * solution.p + solution.q * solution.q))
        : 0,
    sway = solveMode('sway'),
    roll = solveMode('roll');
  return {
    sway: { ...load(sway, 'sway'), dampingFromWaves: waves(sway) },
    roll: { ...load(roll, 'roll'), dampingFromWaves: waves(roll) },
    swayOfRoll: load(roll, 'sway'),
    rollOfSway: load(sway, 'roll'),
  };
}

/** A section's far-field waves in a beam wave of unit amplitude, as complex amplitudes of waves going away from it. */
export interface Scattering {
  /** The wave reflected back the way the incident wave came. */
  readonly reflected: readonly [number, number];
  /** The wave going on past the section (the incident wave and the section's own together). */
  readonly transmitted: readonly [number, number];
  /**
   * The wave's load on the section held still, per metre and metre of wave amplitude, as Re(F e^(-i w t)) against the
   * elevation: heave (down, as the book takes it), sway, and roll about `pivot` (the Froude-Krylov and diffraction loads
   * together, from the pressure of the incident and scattered flow over the contour).
   */
  readonly heaveForce: readonly [number, number];
  readonly swayForce: readonly [number, number];
  readonly rollMoment: readonly [number, number];
}

/**
 * The waves a section of Lewis form `form` sends back and lets through in a beam wave of unit amplitude at `omega` rad/s
 * (deep water), held still and, with `motions`, moving: each mode's complex velocity per unit wave amplitude (heave down
 * positive as the book takes it, sway, and roll about `pivot`), as Re(v e^(-i w t)) with the incident wave
 * Re(e^(i (k x - w t))) at the section's centre line.
 *
 * Derived here from the radiation solution of `heaveSection` and `lateralSection` (the same multipoles, the same least
 * squares over the half contour): the scattered and radiated flow has the stream function on the contour that cancels the
 * incident wave's and carries the section's motion, Psi = -Psi_I + (pi w / g) V S + C, split into the part even in x (the
 * incident wave's cos k x half, heave) and the part odd in x (its sin k x half, sway and roll), each sent out as an
 * outgoing wave whose two components are unknowns of the least squares. Far away the even part goes out alike on both
 * sides and the odd part with opposite signs, so the reflected wave is their difference and the transmitted wave the
 * incident wave plus their sum. A section that loses no energy has |R|^2 + |T|^2 = 1, which the tests hold.
 */
export function scatterSection(
  form: LewisForm,
  omega: number,
  pivot: number,
  motions: {
    readonly heave?: readonly [number, number];
    readonly sway?: readonly [number, number];
    readonly roll?: readonly [number, number];
  } = {},
  gravity = 9.81,
  terms = 16,
  points = 64,
  density = 1025,
): Scattering {
  const { scale: ms, a1, a3 } = form,
    k = (omega * omega) / gravity,
    xi = (omega * omega * ms) / gravity,
    draft = ms * (1 - a1 + a3),
    contour = (t: number): [number, number] => [
      ms * ((1 + a1) * sin(t) - a3 * sin(3 * t)),
      ms * ((1 - a1) * cos(t) + a3 * cos(3 * t)),
    ],
    coefficients = [1, a1, a3],
    // The even multipoles (heave's, eq. 7.109) and the odd ones (sway's, eq. 7.106): their stream functions on the contour.
    even = (m: number, t: number): number => {
      let sum = 0;
      for (let n = 0; n < 3; n++) {
        const order = 2 * m + 2 * n - 1;
        sum += (((n % 2 === 0 ? 1 : -1) * (2 * n - 1) * coefficients[n]!) / order) * sin(order * t);
      }
      return sin(2 * m * t) - xi * sum;
    },
    odd = (m: number, t: number): number => {
      let sum = 0;
      for (let n = 0; n < 3; n++) {
        const order = 2 * m + 2 * n;
        sum += (((n % 2 === 0 ? 1 : -1) * (2 * n - 1) * coefficients[n]!) / order) * cos(order * t);
      }
      return -cos((2 * m + 1) * t) + xi * sum;
    },
    // The outgoing wave's two stream functions, even and odd (the radiation solutions' psi_Bc and psi_Bs).
    evenC = (x: number, y: number) => Math.PI * exp(-k * y) * sin(k * x),
    evenS = (x: number, y: number) => -Math.PI * exp(-k * y) * cos(k * x) + waveIntegral(k, x, y)[0],
    oddC = (x: number, y: number) => Math.PI * exp(-k * y) * cos(k * x),
    oddS = (x: number, y: number) =>
      Math.PI * exp(-k * y) * sin(k * x) + waveIntegral(k, x, y)[1] - y / (k * (x * x + y * y)),
    scale = (Math.PI * omega) / gravity,
    // The motions' shapes on the contour (radiation.ts): heave -x0, sway y0, roll about the pivot.
    heaveShape = (t: number) => -contour(t)[0],
    swayShape = (t: number) => contour(t)[1],
    rollShape = (t: number) => {
      const [x0, y0] = contour(t);
      return -(x0 * x0 + (y0 - pivot) * (y0 - pivot)) / 2;
    },
    // The incident potential pi cos(k x - w t) raises the surface Re(e^(i (k x - w t))) a quarter period after it (the
    // elevation is the potential's time rate over g), so a motion given against the elevation enters the stream function
    // times i: its cos part is -Im v and its sin part Re v. (Checked: in long waves a section heaving with the surface
    // sends out the wave that cancels its scattering.)
    turn = (v: readonly [number, number] | undefined): [number, number] => (v ? [-v[1], v[0]] : [0, 0]),
    [hr, hi] = turn(motions.heave),
    [sr, si] = turn(motions.sway),
    [rr, ri] = turn(motions.roll);
  // One part, even or odd: least squares for [P_1..P_M (cos), Q_1..Q_M (sin), c1, c2] with the outgoing wave's cos part
  // c1 C - c2 S and its sin part c2 C + c1 S; the constant taken off at the keel. Returns the outgoing wave c1 + i c2.
  const part = (
    multipole: (m: number, t: number) => number,
    waveC: (x: number, y: number) => number,
    waveS: (x: number, y: number) => number,
    rhsCos: (t: number) => number,
    rhsSin: (t: number) => number,
  ): Float64Array => {
    const size = 2 * terms + 2,
      normal = new Float64Array(size * size),
      rhs = new Float64Array(size),
      row = new Float64Array(size),
      keelC = waveC(0, draft),
      keelS = waveS(0, draft),
      keelA = Array.from({ length: terms }, (_, m) => multipole(m + 1, 0)),
      add = (b: number) => {
        for (let a = 0; a < size; a++) {
          for (let c = 0; c < size; c++) normal[a * size + c]! += row[a]! * row[c]!;
          rhs[a]! += row[a]! * b;
        }
      };
    for (let j = 1; j <= points; j++) {
      const t = (j * Math.PI) / (2 * points),
        [x0, y0] = contour(t),
        c = waveC(x0, y0) - keelC,
        s = waveS(x0, y0) - keelS;
      // The cos part of the time.
      row.fill(0);
      for (let m = 1; m <= terms; m++) row[m - 1] = multipole(m, t) - keelA[m - 1]!;
      row[2 * terms] = c;
      row[2 * terms + 1] = -s;
      add(rhsCos(t));
      // The sin part.
      row.fill(0);
      for (let m = 1; m <= terms; m++) row[terms + m - 1] = multipole(m, t) - keelA[m - 1]!;
      row[2 * terms] = s;
      row[2 * terms + 1] = c;
      add(rhsSin(t));
    }
    const x = solve(normal, rhs, size);
    return x;
  };
  // The incident wave pi cos(k x - w t): its even half pi e^(-k y) cos(k x) cos(w t) (stream pi e^(-k y) sin(k x), cos
  // part), its odd half pi e^(-k y) sin(k x) sin(w t) (stream -pi e^(-k y) cos(k x), sin part). The scattered and radiated
  // stream function on the contour is minus the incident one plus the motion's, each less its value at the keel.
  const at = (f: (x: number, y: number) => number, t: number) => {
      const [x0, y0] = contour(t);
      return f(x0, y0) - f(0, draft);
    },
    incidentEven = (x: number, y: number) => Math.PI * exp(-k * y) * sin(k * x),
    incidentOdd = (x: number, y: number) => -Math.PI * exp(-k * y) * cos(k * x),
    moved = (shape: (t: number) => number, v: number, t: number) => scale * v * (shape(t) - shape(0)),
    evenSolution = part(
      even,
      evenC,
      evenS,
      (t) => -at(incidentEven, t) + moved(heaveShape, hr, t),
      (t) => moved(heaveShape, hi, t),
    ),
    oddSolution = part(
      odd,
      oddC,
      oddS,
      (t) => moved(swayShape, sr, t) + moved(rollShape, rr, t),
      (t) => -at(incidentOdd, t) + moved(swayShape, si, t) + moved(rollShape, ri, t),
    ),
    er = evenSolution[2 * terms]!,
    ei = evenSolution[2 * terms + 1]!,
    or = oddSolution[2 * terms]!,
    oi = oddSolution[2 * terms + 1]!;
  // The loads on the section held still (no motions): the pressure p = -rho dPhi/dt of the incident and scattered flow,
  // Phi = (g / (pi w)) (Phi_c cos w t + Phi_s sin w t), integrated against each mode's normal over both halves (K = 2 rho g /
  // pi as in the radiation loads): F_j(t) = K (I_c sin w t - I_s cos w t), I the potentials' integrals against dS_j.
  const held = motions.heave || motions.sway || motions.roll ? null : { evenSolution, oddSolution },
    K = (2 * density * gravity) / Math.PI,
    [nodes, weights] = QUADRATURE,
    dx0 = (t: number) => ms * ((1 + a1) * cos(t) - 3 * a3 * cos(3 * t)),
    dy0 = (t: number) => ms * (-(1 - a1) * sin(t) - 3 * a3 * sin(3 * t)),
    evenPhi = (m: number, t: number): number => {
      let sum = 0;
      for (let n = 0; n < 3; n++) {
        const order = 2 * m + 2 * n - 1;
        sum += (((n % 2 === 0 ? 1 : -1) * (2 * n - 1) * coefficients[n]!) / order) * cos(order * t);
      }
      return cos(2 * m * t) - xi * sum;
    },
    oddPhi = (m: number, t: number): number => {
      let sum = 0;
      for (let n = 0; n < 3; n++) {
        const order = 2 * m + 2 * n;
        sum += (((n % 2 === 0 ? 1 : -1) * (2 * n - 1) * coefficients[n]!) / order) * sin(order * t);
      }
      return sin((2 * m + 1) * t) - xi * sum;
    },
    loadOf = (
      solution: Float64Array,
      phi: (m: number, t: number) => number,
      waveC: (x: number, y: number) => number,
      waveS: (x: number, y: number) => number,
      incident: (x: number, y: number) => number,
      incidentInSin: boolean,
      slope: (t: number) => number,
    ): [number, number] => {
      const c1 = solution[2 * terms]!,
        c2 = solution[2 * terms + 1]!;
      let ic = 0,
        is = 0;
      for (let n = 0; n < nodes.length; n++) {
        const t = (nodes[n]! * Math.PI) / 2,
          w = (weights[n]! * Math.PI) / 2,
          [x0, y0] = contour(t),
          d = slope(t),
          bc = waveC(x0, y0),
          bs = waveS(x0, y0);
        let c = c1 * bc - c2 * bs,
          s = c2 * bc + c1 * bs;
        for (let m = 1; m <= terms; m++) {
          const f = phi(m, t);
          c += solution[m - 1]! * f;
          s += solution[terms + m - 1]! * f;
        }
        if (incidentInSin) s += incident(x0, y0);
        else c += incident(x0, y0);
        ic += w * c * d;
        is += w * s * d;
      }
      // F(t) = K (I_c sin w t - I_s cos w t) = Re(F e^(-i w t)) with F = K (-I_s + i I_c) against the potential, and
      // against the elevation (a quarter period before it) F times -i = K (I_c + i I_s); heave's normal points the other way
      // (the book's heave is down). Checked: a free section moved by these loads loses no energy, |R|^2 + |T|^2 = 1 at every
      // frequency, which no other sign or quarter period gives.
      return [K * ic, K * is];
    },
    evenPhiC = (x: number, y: number) => Math.PI * exp(-k * y) * cos(k * x),
    evenPhiS = (x: number, y: number) => Math.PI * exp(-k * y) * sin(k * x) + waveIntegral(k, x, y)[1],
    oddPhiC = (x: number, y: number) => -Math.PI * exp(-k * y) * sin(k * x),
    oddPhiS = (x: number, y: number) =>
      Math.PI * exp(-k * y) * cos(k * x) - waveIntegral(k, x, y)[0] + x / (k * (x * x + y * y)),
    none: [number, number] = [0, 0],
    heaveUp = held
      ? loadOf(held.evenSolution, evenPhi, evenPhiC, evenPhiS, (x, y) => Math.PI * exp(-k * y) * cos(k * x), false, dx0)
      : none,
    heaveForce: [number, number] = [-heaveUp[0], -heaveUp[1]],
    swayForce = held
      ? loadOf(held.oddSolution, oddPhi, oddPhiC, oddPhiS, (x, y) => Math.PI * exp(-k * y) * sin(k * x), true, dy0)
      : none,
    rollMoment = held
      ? loadOf(
          held.oddSolution,
          oddPhi,
          oddPhiC,
          oddPhiS,
          (x, y) => Math.PI * exp(-k * y) * sin(k * x),
          true,
          (t) => {
            const [x0, y0] = contour(t);
            return -(x0 * dx0(t) + (y0 - pivot) * dy0(t));
          },
        )
      : none;
  // Far away on the side the wave goes on to (x > 0) the even part goes out as E e^(i (k x - w t)) and the odd part as
  // i O e^(i (k x - w t)); on the side it came from, the even part alike and the odd part with the opposite sign.
  return {
    reflected: [er + oi, ei - or],
    transmitted: [1 + er - oi, ei + or],
    heaveForce,
    swayForce,
    rollMoment,
  };
}

/** Solves the symmetric system (row-major) by Gaussian elimination with partial pivoting, in a fixed order. */
function solve(matrix: Float64Array, rhs: Float64Array, n: number): Float64Array {
  const a = matrix.slice(),
    b = rhs.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r * n + col]!) > Math.abs(a[pivot * n + col]!)) pivot = r;
    if (a[pivot * n + col] === 0) continue;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) [a[col * n + c], a[pivot * n + c]] = [a[pivot * n + c]!, a[col * n + c]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col]! / a[col * n + col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r * n + c]! -= f * a[col * n + c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= a[r * n + c]! * x[c]!;
    x[r] = a[r * n + r]! !== 0 ? s / a[r * n + r]! : 0;
  }
  return x;
}
