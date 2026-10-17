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

/** A2.3 for orders 0 and 1: `out[0][j]` the basis functions N(span - p + j, p) at u, `out[1][j]` their derivatives. */
export function basisDerivatives(span: number, u: number, p: number, U: readonly number[]): [number[], number[]] {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0)),
    left = new Array(p + 1).fill(0),
    right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[j][r] ? ndu[r][j - 1] / ndu[j][r] : 0;
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  const values = new Array(p + 1),
    derivatives = new Array(p + 1).fill(0);
  for (let j = 0; j <= p; j++) values[j] = ndu[j][p];
  if (p > 0)
    for (let r = 0; r <= p; r++) {
      // d/du N(i,p) = p (N(i,p-1) / (U[i+p] - U[i]) - N(i+1,p-1) / (U[i+p+1] - U[i+1])), from the triangular table.
      // A zero knot difference (repeated knots) makes that term vanish, as A2.3 treats it.
      let d = 0;
      if (r >= 1 && ndu[p][r - 1]) d += ndu[r - 1][p - 1] / ndu[p][r - 1];
      if (r <= p - 1 && ndu[p][r]) d -= ndu[r][p - 1] / ndu[p][r];
      derivatives[r] = d * p;
    }
  return [values, derivatives];
}

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
    [N, dN] = basisDerivatives(span, u, p, c.knots);
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
    [Nu, dNu] = basisDerivatives(uspan, u, p, s.uKnots),
    [Nv, dNv] = basisDerivatives(vspan, v, q, s.vKnots);
  const a = [0, 0, 0, 0],
    au = [0, 0, 0, 0],
    av = [0, 0, 0, 0];
  for (let i = 0; i <= p; i++)
    for (let j = 0; j <= q; j++) {
      const o = ((uspan - p + i) * s.nv + (vspan - q + j)) * 4,
        n = Nu[i] * Nv[j],
        nu = dNu[i] * Nv[j],
        nv = Nu[i] * dNv[j];
      for (let k = 0; k < 4; k++) {
        const c = s.points[o + k];
        a[k] += n * c;
        au[k] += nu * c;
        av[k] += nv * c;
      }
    }
  const w = a[3],
    out = [a[0] / w, a[1] / w, a[2] / w, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[3 + k] = (au[k] - au[3] * out[k]) / w;
    out[6 + k] = (av[k] - av[3] * out[k]) / w;
  }
  return out;
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
