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
