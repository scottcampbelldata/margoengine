// Non-uniform rational B-splines, evaluated with the standard algorithms of Piegl and Tiller, The NURBS Book (2nd ed.):
// A2.1 FindSpan, A2.3 DersBasisFuns (up to first derivatives here), and the rational quotient rule of section 4.
// Control points are homogeneous (x w, y w, z w, w), so polynomial splines are the w = 1 case.

/** The full knot vector from STEP's distinct knots and their multiplicities. */
export function knotVector(knots: readonly number[], multiplicities: readonly number[]): number[] {
  if (knots.length !== multiplicities.length || !knots.length)
    throw new TypeError('Invalid STEP B-spline: knots and multiplicities must have the same, non-zero length');
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const m = multiplicities[i];
    if (!Number.isInteger(m) || m < 1 || m > 64) throw new TypeError('Invalid STEP B-spline: a knot multiplicity');
    if (i && knots[i] < knots[i - 1]) throw new TypeError('Invalid STEP B-spline: knots must not decrease');
    for (let k = 0; k < m; k++) out.push(knots[i]);
  }
  return out;
}

/** A2.1: the knot span index of `u` (n = last control point index, p = degree). */
export function findSpan(n: number, p: number, u: number, U: readonly number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let low = p,
    high = n + 1,
    mid = (low + high) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

// Scratch for the basis table, reused by every evaluation (they run one at a time): evaluating a surface point
// allocates nothing, which is most of the tessellator's time on spline-heavy parts. Degrees above MAX_DEGREE take a
// table of their own.
const MAX_DEGREE = 31;
const scratchTable = new Float64Array((MAX_DEGREE + 1) * (MAX_DEGREE + 1)),
  scratchLeft = new Float64Array(MAX_DEGREE + 1),
  scratchRight = new Float64Array(MAX_DEGREE + 1);

/**
 * A2.3 for orders 0 and 1, into `values[j]` (the basis functions N(span - p + j, p) at u) and `derivatives[j]`, each
 * with room for p + 1 entries.
 */
export function basisInto(
  span: number,
  u: number,
  p: number,
  U: readonly number[],
  values: Float64Array | number[],
  derivatives: Float64Array | number[],
): void {
  const big = p > MAX_DEGREE,
    ndu = big ? new Float64Array((p + 1) * (p + 1)) : scratchTable,
    left = big ? new Float64Array(p + 1) : scratchLeft,
    right = big ? new Float64Array(p + 1) : scratchRight,
    w = p + 1;
  ndu[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const lower = right[r + 1] + left[j - r];
      ndu[j * w + r] = lower;
      const temp = lower ? ndu[r * w + j - 1] / lower : 0;
      ndu[r * w + j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j * w + j] = saved;
  }
  for (let j = 0; j <= p; j++) values[j] = ndu[j * w + p];
  if (!p) {
    derivatives[0] = 0;
    return;
  }
  for (let r = 0; r <= p; r++) {
    // d/du N(i,p) = p (N(i,p-1) / (U[i+p] - U[i]) - N(i+1,p-1) / (U[i+p+1] - U[i+1])), from the triangular table.
    // A zero knot difference (repeated knots) makes that term vanish, as A2.3 treats it.
    let d = 0;
    if (r >= 1 && ndu[p * w + r - 1]) d += ndu[(r - 1) * w + p - 1] / ndu[p * w + r - 1];
    if (r <= p - 1 && ndu[p * w + r]) d -= ndu[r * w + p - 1] / ndu[p * w + r];
    derivatives[r] = d * p;
  }
}

/** A2.3 for orders 0 and 1: `out[0][j]` the basis functions N(span - p + j, p) at u, `out[1][j]` their derivatives. */
export function basisDerivatives(span: number, u: number, p: number, U: readonly number[]): [number[], number[]] {
  const values = new Array<number>(p + 1).fill(0),
    derivatives = new Array<number>(p + 1).fill(0);
  basisInto(span, u, p, U, values, derivatives);
  return [values, derivatives];
}

// Per-direction outputs of basisInto for curve and surface evaluation.
const N0 = new Float64Array(MAX_DEGREE + 1),
  D0 = new Float64Array(MAX_DEGREE + 1),
  N1 = new Float64Array(MAX_DEGREE + 1),
  D1 = new Float64Array(MAX_DEGREE + 1);

/** A B-spline curve: degree, homogeneous control points (4 per point), knot vector. */
export interface SplineCurve {
  readonly degree: number;
  readonly points: Float64Array;
  readonly knots: readonly number[];
}

/** Point and first derivative of a (rational) B-spline curve at u: [x, y, z, dx, dy, dz]. */
export function curveAt(c: SplineCurve, u: number): number[] {
  const n = c.points.length / 4 - 1,
    p = c.degree,
    span = findSpan(n, p, u, c.knots),
    big = p > MAX_DEGREE,
    N = big ? new Float64Array(p + 1) : N0,
    dN = big ? new Float64Array(p + 1) : D0;
  basisInto(span, u, p, c.knots, N, dN);
  const a = [0, 0, 0, 0],
    d = [0, 0, 0, 0];
  for (let j = 0; j <= p; j++) {
    const o = (span - p + j) * 4;
    for (let k = 0; k < 4; k++) {
      a[k] += N[j] * c.points[o + k];
      d[k] += dN[j] * c.points[o + k];
    }
  }
  const w = a[3],
    out = [a[0] / w, a[1] / w, a[2] / w, 0, 0, 0];
  for (let k = 0; k < 3; k++) out[3 + k] = (d[k] - d[3] * out[k]) / w;
  return out;
}

/** A B-spline surface: degrees, homogeneous control net (row-major, u index outer: (i * nv + j) * 4), knots. */
export interface SplineSurface {
  readonly uDegree: number;
  readonly vDegree: number;
  readonly nu: number;
  readonly nv: number;
  readonly points: Float64Array;
  readonly uKnots: readonly number[];
  readonly vKnots: readonly number[];
}

/** Point and first partial derivatives of a (rational) B-spline surface: [x, y, z, du(3), dv(3)]. */
export function surfaceAt(s: SplineSurface, u: number, v: number): number[] {
  const p = s.uDegree,
    q = s.vDegree,
    uspan = findSpan(s.nu - 1, p, u, s.uKnots),
    vspan = findSpan(s.nv - 1, q, v, s.vKnots),
    Nu = p > MAX_DEGREE ? new Float64Array(p + 1) : N0,
    dNu = p > MAX_DEGREE ? new Float64Array(p + 1) : D0,
    Nv = q > MAX_DEGREE ? new Float64Array(q + 1) : N1,
    dNv = q > MAX_DEGREE ? new Float64Array(q + 1) : D1;
  basisInto(uspan, u, p, s.uKnots, Nu, dNu);
  basisInto(vspan, v, q, s.vKnots, Nv, dNv);
  // Sums in plain locals: x, y, z, w of the point and of both partial derivatives.
  let ax = 0,
    ay = 0,
    az = 0,
    aw = 0,
    ux = 0,
    uy = 0,
    uz = 0,
    uw = 0,
    vx = 0,
    vy = 0,
    vz = 0,
    vw = 0;
  const P = s.points;
  for (let i = 0; i <= p; i++) {
    const ni = Nu[i],
      di = dNu[i];
    let o = ((uspan - p + i) * s.nv + (vspan - q)) * 4;
    for (let j = 0; j <= q; j++, o += 4) {
      const n = ni * Nv[j],
        nu = di * Nv[j],
        nv = ni * dNv[j],
        x = P[o],
        y = P[o + 1],
        z = P[o + 2],
        h = P[o + 3];
      ax += n * x;
      ay += n * y;
      az += n * z;
      aw += n * h;
      ux += nu * x;
      uy += nu * y;
      uz += nu * z;
      uw += nu * h;
      vx += nv * x;
      vy += nv * y;
      vz += nv * z;
      vw += nv * h;
    }
  }
  const px = ax / aw,
    py = ay / aw,
    pz = az / aw;
  return [
    px,
    py,
    pz,
    (ux - uw * px) / aw,
    (uy - uw * py) / aw,
    (uz - uw * pz) / aw,
    (vx - vw * px) / aw,
    (vy - vw * py) / aw,
    (vz - vw * pz) / aw,
  ];
}

/** Whether a knot vector is clamped (its first and last p + 1 knots repeat), so the spline starts and ends on control points. */
export function clamped(U: readonly number[], p: number): boolean {
  for (let i = 1; i <= p; i++) if (U[i] !== U[0] || U[U.length - 1 - i] !== U[U.length - 1]) return false;
  return true;
}

/** Distinct knot values inside [U[p], U[n + 1]] (span boundaries), for sampling one span at a time. */
export function spanBreaks(U: readonly number[], p: number, n: number): number[] {
  const out: number[] = [];
  for (let i = p; i <= n + 1; i++) if (!out.length || U[i] > out[out.length - 1]) out.push(U[i]);
  return out;
}
