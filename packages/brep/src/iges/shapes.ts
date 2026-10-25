// IGES shapes with no direct STEP counterpart, made exact B-splines where they can be (IGES 5.3 sections 4.5, 4.14
// and 4.17): conic arcs, parametric spline curves and ruled surfaces.
import {
  add,
  type Beziers,
  beziersOfCurve,
  type Curve3,
  dist,
  domain,
  dot,
  fromBeziers,
  len,
  mul,
  type NurbsSurface,
  pointAt,
  raiseTo,
  splitBezier,
  sub,
  type V3,
} from './geometry.js';

/**
 * A conic arc (IGES 104) from A x^2 + B xy + C y^2 + D x + E y + F = 0 in the plane z = zt, from start to end: an
 * ellipse as a conic (counterclockwise), a parabola or hyperbola as rational quadratic Bezier pieces (each piece's
 * middle weight from the point where the line from its chord's middle to its tangents' meeting point crosses the conic).
 * Undefined for a degenerate conic.
 */
export function conicArc(
  q: readonly number[],
  zt: number,
  start: readonly number[],
  end: readonly number[],
  form: number,
): Curve3 | undefined {
  const [A, B, C, D, E, F] = q,
    scale = Math.max(Math.abs(A), Math.abs(B), Math.abs(C)) || 1,
    disc = (B * B - 4 * A * C) / (scale * scale),
    kind = form === 1 || form === 2 || form === 3 ? form : disc < -1e-12 ? 1 : disc > 1e-12 ? 2 : 3,
    Q = (x: number, y: number) => A * x * x + B * x * y + C * y * y + D * x + E * y + F;
  if (kind === 1) {
    const det = 4 * A * C - B * B;
    if (!(Math.abs(det) > 0)) return undefined;
    const cx = (-2 * C * D + B * E) / det,
      cy = (B * D - 2 * A * E) / det,
      f = Q(cx, cy),
      th = 0.5 * Math.atan2(B, A - C),
      c = Math.cos(th),
      s = Math.sin(th),
      l1 = A * c * c + B * s * c + C * s * s,
      l2 = A * s * s - B * s * c + C * c * c,
      a = Math.sqrt(-f / l1),
      b = Math.sqrt(-f / l2);
    if (!(a > 0 && b > 0)) return undefined;
    const e1 = [c, s],
      e2 = [-s, c],
      angle = (p: readonly number[]) => {
        const dx = p[0] - cx,
          dy = p[1] - cy;
        return Math.atan2((dx * e2[0] + dy * e2[1]) / b, (dx * e1[0] + dy * e1[1]) / a);
      };
    const t0 = angle(start);
    let t1 = angle(end);
    while (t1 <= t0 + 1e-12) t1 += 2 * Math.PI;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-12 * Math.max(a, b)) t1 = t0 + 2 * Math.PI;
    return { kind: 'conic', c: [cx, cy, zt], X: [a * e1[0], a * e1[1], 0], Y: [b * e2[0], b * e2[1], 0], t0, t1 };
  }
  const grad = (p: readonly number[]) => [2 * A * p[0] + B * p[1] + D, B * p[0] + 2 * C * p[1] + E];
  const segs: number[][][] = [];
  const arc = (p0: readonly number[], p2: readonly number[], depth: number): boolean => {
    const g0 = grad(p0),
      g2 = grad(p2),
      d0 = [-g0[1], g0[0]],
      d2 = [-g2[1], g2[0]],
      l0 = Math.hypot(d0[0], d0[1]),
      l2 = Math.hypot(d2[0], d2[1]),
      den = d0[0] * d2[1] - d0[1] * d2[0];
    if (!(Math.abs(den) > 1e-14 * l0 * l2)) return false;
    const s = ((p2[0] - p0[0]) * d2[1] - (p2[1] - p0[1]) * d2[0]) / den,
      p1 = [p0[0] + s * d0[0], p0[1] + s * d0[1]],
      m = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2],
      dir = [p1[0] - m[0], p1[1] - m[1]],
      q0 = Q(m[0], m[1]),
      qp = Q(m[0] + dir[0], m[1] + dir[1]),
      qm = Q(m[0] - dir[0], m[1] - dir[1]),
      a2 = (qp + qm) / 2 - q0,
      a1 = (qp - qm) / 2;
    let root = Number.NaN;
    if (Math.abs(a2) <= 1e-15 * (Math.abs(a1) + Math.abs(q0))) root = -q0 / a1;
    else {
      const d = a1 * a1 - 4 * a2 * q0;
      if (d < 0) return false;
      for (const r of [(-a1 - Math.sqrt(d)) / (2 * a2), (-a1 + Math.sqrt(d)) / (2 * a2)])
        if (r > 0 && r < 1 && !(root > 0 && root < 1)) root = r;
    }
    if (!(root > 0 && root < 1)) return false;
    // Turning more than about 100 degrees: split at the shoulder point, which is on the conic.
    const cosTurn = (d0[0] * d2[0] + d0[1] * d2[1]) / (l0 * l2);
    if (cosTurn < -0.17 && depth < 4) {
      const mid = [m[0] + root * dir[0], m[1] + root * dir[1]];
      return arc(p0, mid, depth + 1) && arc(mid, p2, depth + 1);
    }
    const w = root / (1 - root);
    segs.push([
      [p0[0], p0[1], zt, 1],
      [p1[0] * w, p1[1] * w, zt * w, w],
      [p2[0], p2[1], zt, 1],
    ]);
    return true;
  };
  if (!arc(start, end, 0) || !segs.length) return undefined;
  return { kind: 'nurbs', n: fromBeziers({ p: 2, segs, breaks: [...segs.map((_, i) => i), segs.length] }) };
}

/** A parametric spline curve (IGES 112): its cubic segments as Bezier pieces, so exactly its curve and parameter. */
export function polynomialCurve(breaks: readonly number[], coefficients: readonly number[][]): Curve3 | undefined {
  const segs: number[][][] = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const h = breaks[i + 1] - breaks[i],
      c = coefficients[i];
    if (!(h > 0) || !c) return undefined;
    // Per axis a + b s + c s^2 + d s^3 (s = u - T(i)) as Bernstein coefficients over [0, h].
    const ctrl = [0, 1, 2, 3].map(() => [0, 0, 0, 1]);
    for (let k = 0; k < 3; k++) {
      const [a, b, cc, d] = c.slice(k * 4, k * 4 + 4);
      ctrl[0][k] = a;
      ctrl[1][k] = a + (b * h) / 3;
      ctrl[2][k] = a + (2 * b * h) / 3 + (cc * h * h) / 3;
      ctrl[3][k] = a + b * h + cc * h * h + d * h * h * h;
    }
    segs.push(ctrl);
  }
  return segs.length ? { kind: 'nurbs', n: fromBeziers({ p: 3, segs, breaks: [...breaks] }) } : undefined;
}

/** Whether a curve's B-spline runs with its IGES parameter: true except for conic pieces (an angle there). */
const native = (c: Curve3): boolean => c.kind !== 'conic' && (c.kind !== 'chain' || c.parts.every(native));
const isCircle = (c: Curve3) =>
  c.kind === 'conic' &&
  Math.abs(len(c.X) - len(c.Y)) <= 1e-9 * len(c.X) &&
  Math.abs(dot(c.X, c.Y)) <= 1e-9 * dot(c.X, c.X);

function reverseBeziers(b: Beziers): Beziers {
  const a = b.breaks[0],
    z = b.breaks[b.breaks.length - 1];
  return {
    p: b.p,
    segs: [...b.segs].reverse().map((s) => [...s].reverse()),
    breaks: [...b.breaks].reverse().map((t) => a + z - t),
  };
}
const normalized = (b: Beziers): Beziers => {
  const a = b.breaks[0],
    z = b.breaks[b.breaks.length - 1];
  return { ...b, breaks: b.breaks.map((t) => (t - a) / (z - a)) };
};
/** Splits pieces so their breaks include every value of `at`. */
function refine(b: Beziers, at: readonly number[]): Beziers {
  const segs: number[][][] = [],
    breaks = [b.breaks[0]];
  for (let i = 0; i < b.segs.length; i++) {
    const hi = b.breaks[i + 1];
    let seg = b.segs[i],
      from = b.breaks[i];
    for (const t of at)
      if (t > from + 1e-12 && t < hi - 1e-12) {
        const [left, right] = splitBezier(seg, (t - from) / (hi - from));
        segs.push(left);
        breaks.push(t);
        seg = right;
        from = t;
      }
    segs.push(seg);
    breaks.push(hi);
  }
  return { p: b.p, segs, breaks };
}

/**
 * A ruled surface (IGES 118) between two rails as a B-spline surface, u along the rails and v from rail 1 (v = 0) to
 * rail 2. Exact when both rails' B-splines keep their parameter's meaning (form 1 with rails that are not conics, or
 * both conics of the same sweep; form 0 with two lines or two circles of the same sweep); otherwise both rails are
 * sampled at the same relative parameter (or arc length, form 0) and joined by Hermite cubics.
 */
export function ruledSurface(c1: Curve3, c2: Curve3, flip: boolean, arcLength: boolean): NurbsSurface {
  const sweep = (c: Curve3) => (c.kind === 'conic' ? c.t1 - c.t0 : 0),
    exact = arcLength
      ? (c1.kind === 'line' && c2.kind === 'line') ||
        (isCircle(c1) && isCircle(c2) && Math.abs(sweep(c1) - sweep(c2)) < 1e-9)
      : (native(c1) && native(c2)) ||
        (c1.kind === 'conic' && c2.kind === 'conic' && Math.abs(sweep(c1) - sweep(c2)) < 1e-9);
  if (exact) {
    let b1 = beziersOfCurve(c1),
      b2 = beziersOfCurve(c2);
    if (b1?.segs.length && b2?.segs.length) {
      b1 = normalized(b1);
      b2 = normalized(flip ? reverseBeziers(b2) : b2);
      const p = Math.max(b1.p, b2.p);
      b1 = raiseTo(b1, p);
      b2 = raiseTo(b2, p);
      const all = [...b1.breaks, ...b2.breaks].sort((x, y) => x - y);
      const r1b = refine(b1, all),
        r2b = refine(b2, all),
        same =
          r1b.segs.length === r2b.segs.length &&
          r1b.segs.every((s, i) => s.every((q, k) => Math.abs(q[3] - r2b.segs[i][k][3]) <= 1e-12 * Math.abs(q[3])));
      if (same) {
        const r1 = fromBeziers(r1b),
          r2 = fromBeziers(r2b);
        return {
          pu: p,
          pv: 1,
          U: r1.U,
          V: [0, 0, 1, 1],
          nu: r1.P.length,
          nv: 2,
          P: [...r1.P, ...r2.P],
          ...(r1.W ? { W: [...r1.W, ...r1.W] } : {}),
        };
      }
    }
  }
  const parts = (c: Curve3) => (c.kind === 'chain' ? c.parts.length : 1),
    count = Math.min(256, 16 * Math.max(parts(c1), parts(c2)));
  const rail = (c: Curve3, reverse: boolean): ((u: number) => V3) => {
    const [a, b] = domain(c);
    if (!arcLength) return (u) => pointAt(c, reverse ? b - u * (b - a) : a + u * (b - a));
    // Arc length: a table of 2048 chords, inverted linearly.
    const n = 2048,
      ts: number[] = [],
      ls: number[] = [0];
    let last = pointAt(c, a);
    for (let i = 0; i <= n; i++) {
      const t = a + ((b - a) * i) / n,
        p = pointAt(c, t);
      ts.push(t);
      if (i) ls.push(ls[i - 1] + dist(p, last));
      last = p;
    }
    const total = ls[n] || 1;
    return (u) => {
      const target = (reverse ? 1 - u : u) * total;
      let lo = 0,
        hi = n;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ls[mid] <= target) lo = mid;
        else hi = mid;
      }
      const f = ls[hi] > ls[lo] ? (target - ls[lo]) / (ls[hi] - ls[lo]) : 0;
      return pointAt(c, ts[lo] + f * (ts[hi] - ts[lo]));
    };
  };
  const rows = [rail(c1, false), rail(c2, flip)].map((f) => {
    const h = 1e-6,
      d = (u: number) => {
        const lo = Math.max(0, u - h),
          hi = Math.min(1, u + h);
        return mul(sub(f(hi), f(lo)), 1 / (hi - lo));
      };
    const segs: number[][][] = [],
      breaks = [0];
    for (let i = 0; i < count; i++) {
      const a = i / count,
        b = (i + 1) / count,
        pa = f(a),
        pb = f(b),
        k = (b - a) / 3;
      segs.push([pa, add(pa, mul(d(a), k)), sub(pb, mul(d(b), k)), pb].map((q) => [...q, 1]));
      breaks.push(b);
    }
    return fromBeziers({ p: 3, segs, breaks });
  });
  return {
    pu: 3,
    pv: 1,
    U: rows[0].U,
    V: [0, 0, 1, 1],
    nu: rows[0].P.length,
    nv: 2,
    P: [...rows[0].P, ...rows[1].P],
  };
}
