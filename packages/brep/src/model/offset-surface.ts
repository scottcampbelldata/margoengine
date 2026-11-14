// The offset of a B-spline surface by a distance along its natural normal, Su x Sv (ISO 10303-42's offset_surface,
// whose basis surface is a B-spline, or a curve swept along a vector or turned round an axis as one). An analytic
// surface's offset is the analytic surface it is (import.ts); a spline's is no spline, so it is fitted: a bicubic
// B-spline over the basis's own (u, v) domain through the offset's points at its knots' Greville abscissae, its knot
// spans halved where it strays, until it lies within the tolerance of the offset at nine points of every span, or as
// close as it came (the caller reports the error, and refuses a surface fitted no closer than the tolerance).
import { distance, type XYZ } from '../geometry/vec.js';
import { basisDerivatives, findSpan, knotVector } from '../geometry/nurbs.js';
import { surfaceEvaluator, type SurfaceDef } from './geometry.js';

type SplineSurfaceDef = Extract<SurfaceDef, { kind: 'spline' }>;

/** A fitted offset: its surface and the most it strays from the offset at the points it was measured at. */
export interface FittedOffset {
  readonly surface: SplineSurfaceDef;
  readonly error: number;
}

/** A direction's distinct knots and their multiplicities for the cubic fit. */
interface Knots {
  knots: number[];
  multiplicities: number[];
}

/**
 * The cubic fit's knots in one direction: the basis's knots inside its domain, each as often as the offset needs to
 * bend there (a basis of degree p, C^(p - m) at a knot of multiplicity m, has a normal and so an offset one degree less
 * smooth: a cubic is that smooth with multiplicity 4 - p + m, from 1 to 3), clamped at the ends.
 */
function fitKnots(knots: readonly number[], mults: readonly number[], p: number, lo: number, hi: number): Knots {
  const out: Knots = { knots: [lo], multiplicities: [4] };
  knots.forEach((k, i) => {
    if (k > lo && k < hi) {
      out.knots.push(k);
      out.multiplicities.push(Math.max(1, Math.min(3, 4 - p + mults[i])));
    }
  });
  out.knots.push(hi);
  out.multiplicities.push(4);
  return out;
}

/** The Greville abscissae of a cubic knot vector: where the fit meets the offset. */
function greville(U: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 < U.length; i++) out.push((U[i + 1] + U[i + 2] + U[i + 3]) / 3);
  return out;
}

/** The LU factors (partial pivoting) of the collocation matrix of the cubic basis on U at the abscissae g. */
function collocation(U: readonly number[], g: readonly number[]): { lu: Float64Array; piv: Int32Array; n: number } {
  const n = g.length,
    lu = new Float64Array(n * n),
    piv = new Int32Array(n);
  g.forEach((t, i) => {
    const span = findSpan(n - 1, 3, t, U),
      [N] = basisDerivatives(span, t, 3, U);
    for (let j = 0; j <= 3; j++) lu[i * n + span - 3 + j] = N[j];
  });
  for (let k = 0; k < n; k++) {
    let best = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(lu[i * n + k]) > Math.abs(lu[best * n + k])) best = i;
    piv[k] = best;
    if (best !== k)
      for (let j = 0; j < n; j++) {
        const t = lu[k * n + j];
        lu[k * n + j] = lu[best * n + j];
        lu[best * n + j] = t;
      }
    const d = lu[k * n + k];
    if (!(Math.abs(d) > 0))
      throw new RangeError('offset fit: the collocation matrix is singular; mesh the file with tessellateSTEP instead');
    for (let i = k + 1; i < n; i++) {
      const f = (lu[i * n + k] /= d);
      if (f) for (let j = k + 1; j < n; j++) lu[i * n + j] -= f * lu[k * n + j];
    }
  }
  return { lu, piv, n };
}

/** Solves the factored system for three right-hand sides at once (x, y, z of each row), in place. */
function solve(f: { lu: Float64Array; piv: Int32Array; n: number }, b: XYZ[]): void {
  const { lu, piv, n } = f;
  for (let k = 0; k < n; k++) {
    const p = piv[k];
    if (p !== k) [b[k], b[p]] = [b[p], b[k]];
  }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++) {
      const l = lu[i * n + j];
      if (l) for (let c = 0; c < 3; c++) b[i][c] -= l * b[j][c];
    }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) {
      const u = lu[i * n + j];
      if (u) for (let c = 0; c < 3; c++) b[i][c] -= u * b[j][c];
    }
    for (let c = 0; c < 3; c++) b[i][c] /= lu[i * n + i];
  }
}

/** Distinct knots (with multiplicities) with a knot added at the middle of each listed span. */
function refine(k: Knots, spans: ReadonlySet<number>): Knots {
  const out: Knots = { knots: [], multiplicities: [] };
  k.knots.forEach((t, i) => {
    out.knots.push(t);
    out.multiplicities.push(k.multiplicities[i]);
    if (spans.has(i)) {
      out.knots.push((t + k.knots[i + 1]) / 2);
      out.multiplicities.push(1);
    }
  });
  return out;
}

/**
 * The offset of a B-spline surface by `d` (metres, along Su x Sv), fitted within `tolerance` where it can be in up to
 * `maxPoints` control points a direction (else as near as it came: the caller compares the error). Throws a RangeError
 * where the basis has no normal even beside the place (a crease), as the offset has no single place there.
 */
export function offsetSpline(s: SplineSurfaceDef, d: number, tolerance: number, maxPoints = 400): FittedOffset {
  const e = surfaceEvaluator(s),
    [u0, u1] = e.uDomain,
    [v0, v1] = e.vDomain,
    hu = 1e-7 * (u1 - u0),
    hv = 1e-7 * (v1 - v0),
    /**
     * The unit normal Su x Sv at (u, v), or undefined where it vanishes: where Su and Sv are parallel, or where one of
     * them is rounding beside the other (on a pole a rational surface's Su comes out near 1e-18, not 0, in a direction
     * of no meaning, so its cross product with Sv would pass the parallel test; each is weighed over its domain).
     */
    normal = (u: number, v: number): XYZ | undefined => {
      if (!(u >= u0 && u <= u1 && v >= v0 && v <= v1)) return undefined;
      const q = e.at(u, v),
        nx = q[4] * q[8] - q[5] * q[7],
        ny = q[5] * q[6] - q[3] * q[8],
        nz = q[3] * q[7] - q[4] * q[6],
        len = Math.hypot(nx, ny, nz),
        a = Math.hypot(q[3], q[4], q[5]),
        b = Math.hypot(q[6], q[7], q[8]),
        wa = a * (u1 - u0),
        wb = b * (v1 - v0);
      return len > 1e-9 * a * b && len > 0 && Math.min(wa, wb) > 1e-12 * Math.max(wa, wb)
        ? [nx / len, ny / len, nz / len]
        : undefined;
    },
    /**
     * The offset's point at (u, v): S + d n. On a pole of the basis (a row of its net collapsed to a point, as a curve
     * turned round an axis through it makes) Su x Sv vanishes and n is its limit, taken a ten-millionth of the domain
     * in from the row.
     */
    target = (u: number, v: number): XYZ => {
      const n = normal(u, v) ?? normal(u, v + hv) ?? normal(u, v - hv) ?? normal(u + hu, v) ?? normal(u - hu, v);
      if (!n)
        throw new RangeError(
          `offset fit: the basis surface has no normal near (${u}, ${v}); mesh the file with tessellateSTEP instead`,
        );
      const q = e.at(u, v);
      return [q[0] + d * n[0], q[1] + d * n[1], q[2] + d * n[2]];
    },
    /**
     * Whether the offset turns inside out at (u, v): past a centre of curvature, where 1 + d k is negative for a
     * principal curvature k. The offset's tangents Su + d Nu and Sv + d Nv are M times the basis's (M = I + d W, W the
     * shape operator, its eigenvalues real): inside out where M has a negative eigenvalue, so a negative determinant
     * or trace. Nu and Nv by differences of the unit normal; not judged on a pole (no tangent plane there).
     */
    everted = (u: number, v: number): boolean => {
      const n0 = normal(u, v);
      if (!n0) return false;
      const q = e.at(u, v),
        su: XYZ = [q[3], q[4], q[5]],
        sv: XYZ = [q[6], q[7], q[8]],
        rate = (a: XYZ | undefined, b: XYZ | undefined, h: number): XYZ | undefined =>
          a && b
            ? [(a[0] - b[0]) / (2 * h), (a[1] - b[1]) / (2 * h), (a[2] - b[2]) / (2 * h)]
            : a
              ? [(a[0] - n0[0]) / h, (a[1] - n0[1]) / h, (a[2] - n0[2]) / h]
              : b
                ? [(n0[0] - b[0]) / h, (n0[1] - b[1]) / h, (n0[2] - b[2]) / h]
                : undefined,
        nu = rate(normal(u + hu, v), normal(u - hu, v), hu),
        nv = rate(normal(u, v + hv), normal(u, v - hv), hv);
      if (!nu || !nv) return false;
      const dot3 = (a: XYZ, b: XYZ) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
        tu: XYZ = [su[0] + d * nu[0], su[1] + d * nu[1], su[2] + d * nu[2]],
        tv: XYZ = [sv[0] + d * nv[0], sv[1] + d * nv[1], sv[2] + d * nv[2]],
        g11 = dot3(su, su),
        g12 = dot3(su, sv),
        g22 = dot3(sv, sv),
        det = g11 * g22 - g12 * g12;
      if (!(det > 1e-12 * g11 * g22)) return false;
      // M's columns: the basis coordinates of tu and tv (the Gram matrix solved for them).
      const coords = (t: XYZ): [number, number] => {
          const r1 = dot3(su, t),
            r2 = dot3(sv, t);
          return [(g22 * r1 - g12 * r2) / det, (g11 * r2 - g12 * r1) / det];
        },
        [a11, a21] = coords(tu),
        [a12, a22] = coords(tv);
      return a11 * a22 - a12 * a21 < 0 || a11 + a22 < 0;
    };
  let ku = fitKnots(s.knots[0], s.multiplicities[0], s.degrees[0], u0, u1),
    kv = fitKnots(s.knots[1], s.multiplicities[1], s.degrees[1], v0, v1),
    best: FittedOffset | undefined;
  for (let round = 0; round < 12; round++) {
    const U = knotVector(ku.knots, ku.multiplicities),
      V = knotVector(kv.knots, kv.multiplicities),
      gu = greville(U),
      gv = greville(V),
      nu = gu.length,
      nv = gv.length;
    if (nu > maxPoints || nv > maxPoints) break;
    // Along u for each v abscissa, then along v for each u control point.
    const fu = collocation(U, gu),
      fv = collocation(V, gv),
      rows: XYZ[][] = gv.map((v) => {
        const b = gu.map((u) => target(u, v));
        solve(fu, b);
        return b;
      }),
      points: XYZ[] = Array<XYZ>(nu * nv);
    for (let i = 0; i < nu; i++) {
      const b = rows.map((r) => [...r[i]] as XYZ);
      solve(fv, b);
      for (let j = 0; j < nv; j++) points[j * nu + i] = b[j];
    }
    const surface: SplineSurfaceDef = {
        kind: 'spline',
        ...(s.uClosed ? { uClosed: true } : {}),
        ...(s.vClosed ? { vClosed: true } : {}),
        degrees: [3, 3],
        counts: [nu, nv],
        knots: [ku.knots, kv.knots],
        multiplicities: [ku.multiplicities, kv.multiplicities],
        points,
      },
      f = surfaceEvaluator(surface),
      uBad = new Set<number>(),
      vBad = new Set<number>();
    let error = 0,
      fold = false;
    for (let i = 0; i + 1 < ku.knots.length; i++)
      for (let j = 0; j + 1 < kv.knots.length; j++)
        for (const a of [0.25, 0.5, 0.75])
          for (const b of [0.25, 0.5, 0.75]) {
            const u = ku.knots[i] + a * (ku.knots[i + 1] - ku.knots[i]),
              v = kv.knots[j] + b * (kv.knots[j + 1] - kv.knots[j]),
              q = f.at(u, v),
              miss = distance(q.slice(0, 3), target(u, v)),
              n = normal(u, v);
            // Past a centre of curvature the offset itself turns inside out: no surface.
            if (everted(u, v))
              throw new RangeError(
                `offset fit: the offset by ${d} m turns inside out near (${u}, ${v}), past a centre of curvature; the offset distance must stay inside the radius of curvature`,
              );
            // A fit folded where the offset is not (a coarse first fit beside a pole) misses there: its spans are halved.
            const folded =
              !!n &&
              n[0] * (q[4] * q[8] - q[5] * q[7]) +
                n[1] * (q[5] * q[6] - q[3] * q[8]) +
                n[2] * (q[3] * q[7] - q[4] * q[6]) <
                0;
            if (folded) fold = true;
            error = Math.max(error, miss);
            if (miss > tolerance || folded) {
              uBad.add(i);
              vBad.add(j);
            }
          }
    // A folded fit is never taken, however near it lies.
    if (!fold && (!best || error < best.error)) best = { surface, error };
    if (!fold && error <= tolerance) break;
    // Halve the spans that miss; a direction along which the misses all lie within one span row still halves them.
    ku = refine(ku, uBad);
    kv = refine(kv, vBad);
  }
  if (!best)
    throw new RangeError(
      `offset fit: no unfolded fit within ${maxPoints} control points a direction; mesh the file with tessellateSTEP instead`,
    );
  return best;
}
