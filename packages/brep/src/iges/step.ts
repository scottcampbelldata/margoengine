// IGES 5.3 entities to STEP, from the specification's entity definitions (chapter 4), so the kernel's own STEP reader
// and tessellator take the result. Manifold solid B-rep objects (186) with their shells, faces, loops, edge and vertex
// lists (514, 510, 508, 504, 502) become STEP solids, edge for edge; trimmed (144) and bounded (143) surfaces, bounded
// planes (108) and untrimmed surfaces become faces of one surface model, each with its own edges. Curves: circular and
// conic arcs (100, 104), composite curves (102), linear paths (106), lines (110), parametric splines (112), rational
// B-splines (126), offset curves (130, fitted), curves on surfaces (142: the model-space curve, else the parameter-space
// curve mapped through the surface and fitted). Surfaces: planes (108, 190), ruled
// surfaces (118), surfaces of revolution (120), tabulated cylinders (122), rational B-spline surfaces (128), offset
// surfaces (140), cylinders, cones, spheres and tori (192 to 198). Transformation matrices (124) chain as the
// specification says; lengths come out in millimetres (units flag over model space scale).
import { MargoError } from '@margoengine/math/errors';
import { STEPFile, stepText } from '../step/file.js';
import { StepWriter } from '../step/write.js';
import { curveOf, type Curve } from '../geometry/curves.js';
import { surfaceOf, type Surface } from '../geometry/surfaces.js';
import { readIGES, type IGESEntity, type IGESFile, type IGESGlobal } from './file.js';
import {
  apply,
  compose,
  type Curve3,
  cross,
  dist,
  domain,
  dot,
  endOf,
  fit,
  identity,
  len,
  lengthOf,
  mul,
  type Nurbs,
  nurbsOf,
  perpendicular,
  pieces,
  pointAt,
  rotate,
  scaleOf,
  scaling,
  startOf,
  sub,
  type Surf,
  surfDomain,
  surfNormal,
  surfPoint,
  transformCurve,
  transformSurf,
  unit,
  type V3,
  type Xf,
} from './geometry.js';
import { conicArc, polynomialCurve, ruledSurface } from './shapes.js';

/** What {@link igesToSTEP} produces. */
export interface IGESConversion {
  /** An AP214 STEP file in millimetres: one product whose shape holds every solid and surface model. */
  readonly step: string;
  readonly global: IGESGlobal;
  /** Millimetres per IGES model unit (the units flag over the model space scale). */
  readonly unit: number;
  /** Solids (186, closed 514), open shells (514) and faces (all of them, trimmed surfaces included) converted. */
  readonly counts: { readonly solids: number; readonly shells: number; readonly faces: number };
  /** What was left out and why (unsupported entities, faces whose geometry could not be built). */
  readonly warnings: readonly string[];
}

const COLORS: Readonly<Record<number, number[]>> = {
  1: [0, 0, 0],
  2: [1, 0, 0],
  3: [0, 1, 0],
  4: [0, 0, 1],
  5: [1, 1, 0],
  6: [1, 0, 1],
  7: [0, 1, 1],
  8: [1, 1, 1],
};

type Segment = { readonly curve: Curve3; readonly forward: boolean; readonly key?: string };
interface Bound {
  readonly loop: string;
  /** Outer bound; undefined: the one enclosing the most area is. */
  outer?: boolean;
  /** Fixed orientation (186 loops); otherwise from the loop's turning in the surface's parameters. */
  readonly orientation?: boolean;
  readonly samples?: readonly V3[];
}
interface FaceJob {
  readonly id: string;
  readonly surf: Surf;
  readonly surfId: string;
  /** +1 when the face's normal is the IGES surface normal, -1 when it is reversed. */
  readonly sign: number;
  readonly bounds: Bound[];
  readonly color?: readonly number[];
  readonly where: string;
  filled?: boolean;
}

/** Converts an IGES file to STEP for the kernel. Throws a TypeError for a malformed file or one with no surfaces. */
export function igesToSTEP(input: string | ArrayBuffer | ArrayBufferView): IGESConversion {
  const file: IGESFile = readIGES(input),
    g = file.global,
    k = g.millimetres / g.modelScale,
    root = scaling(k),
    size = (g.maxCoordinate > 0 ? g.maxCoordinate * k : 1000) || 1000,
    tol = Math.max(1e-9 * size, Math.min(g.resolution > 0 ? g.resolution * k : 1e-6 * size, 1e-4 * size)),
    fitTol = Math.max(1e-9 * size, tol * 0.01),
    w = new StepWriter(),
    warnings: string[] = [],
    refusals: MargoError[] = [],
    warn = (message: string) => {
      if (warnings.length < 200) warnings.push(message);
    };
  /** A malformed entity: the message, then the fix. */
  const invalid = (message: string) => new TypeError(`${message}; export the model again from the CAD tool`);
  const unsupported = (message: string) =>
    new TypeError(`${message}; export it as a B-spline curve or surface from the CAD tool`);
  const E = (de: number): IGESEntity | undefined => file.entities.get(de);
  const n = (e: IGESEntity, i: number, fallback = 0): number => {
    const v = e.params[i];
    return typeof v === 'number' ? v : fallback;
  };
  const ptr = (e: IGESEntity, i: number): number => {
    const v = n(e, i);
    return v > 0 ? Math.trunc(v) : 0;
  };
  const xyz = (e: IGESEntity, i: number): V3 => [n(e, i), n(e, i + 1), n(e, i + 2)];
  const name = (e: IGESEntity) => `entity ${e.de} (type ${e.type}${e.form ? ` form ${e.form}` : ''})`;
  const need = (e: IGESEntity, count: number) => {
    if (e.params.length < count)
      throw invalid(`${name(e)} has ${e.params.length} parameters, fewer than the ${count} it needs`);
  };

  // --- transformation matrices (124), chained through their own directory entries ------------------------------
  const matrices = new Map<number, Xf>();
  const matrix = (de: number, depth = 0): Xf => {
    if (!de) return identity;
    const known = matrices.get(de);
    if (known) return known;
    const e = E(de);
    if (!e || e.type !== 124 || depth > 32) {
      warn(`transformation matrix ${de} is missing or not a type 124 entity; ignored`);
      return identity;
    }
    const own: Xf = {
      r: [n(e, 0), n(e, 1), n(e, 2), n(e, 4), n(e, 5), n(e, 6), n(e, 8), n(e, 9), n(e, 10)],
      t: [n(e, 3), n(e, 7), n(e, 11)],
    };
    const result = compose(matrix(e.transform, depth + 1), own);
    matrices.set(de, result);
    return result;
  };
  const placed = (e: IGESEntity, outer: Xf) => compose(outer, matrix(e.transform));

  // --- curves ---------------------------------------------------------------------------------------------------
  const curve = (de: number, outer: Xf, depth = 0): Curve3 | undefined => {
    const e = E(de);
    if (!e) {
      warn(`curve ${de} is missing`);
      return undefined;
    }
    if (depth > 16) throw invalid(`${name(e)}: curves nested too deeply`);
    const m = placed(e, outer),
      local = (c: Curve3 | undefined) => (c ? transformCurve(c, m) : undefined);
    switch (e.type) {
      case 100: {
        need(e, 7);
        const zt = n(e, 0),
          c = [n(e, 1), n(e, 2), zt],
          s = [n(e, 3), n(e, 4), zt],
          t = [n(e, 5), n(e, 6), zt],
          r = dist(c, s);
        if (!(r > 0)) return undefined;
        const t0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
        let t1 = Math.atan2(t[1] - c[1], t[0] - c[0]);
        while (t1 <= t0 + 1e-12) t1 += 2 * Math.PI;
        if (dist(s, t) <= 1e-12 * r) t1 = t0 + 2 * Math.PI;
        return local({ kind: 'conic', c, X: [r, 0, 0], Y: [0, r, 0], t0, t1 });
      }
      case 102: {
        const count = n(e, 0),
          parts: Curve3[] = [];
        for (let i = 1; i <= count; i++) {
          const child = E(ptr(e, i));
          if (!child || child.type === 116 || child.type === 132) continue;
          const c = curve(child.de, m, depth + 1);
          if (c) parts.push(c);
          else throw invalid(`${name(e)}: its constituent ${child.de} (type ${child.type}) is not a curve`);
        }
        if (!parts.length) return undefined;
        return parts.length === 1 ? parts[0] : { kind: 'chain', parts };
      }
      case 104: {
        need(e, 11);
        const c = conicArc(
          [n(e, 0), n(e, 1), n(e, 2), n(e, 3), n(e, 4), n(e, 5)],
          n(e, 6),
          [n(e, 7), n(e, 8)],
          [n(e, 9), n(e, 10)],
          e.form,
        );
        if (!c) throw invalid(`${name(e)}: a degenerate conic`);
        return local(c);
      }
      case 106: {
        const ip = n(e, 0),
          count = n(e, 1),
          pts: V3[] = [];
        if (e.form >= 20 && e.form !== 63) return undefined;
        for (let i = 0; i < count; i++)
          pts.push(
            ip === 1 ? [n(e, 3 + 2 * i), n(e, 4 + 2 * i), n(e, 2)] : ip === 2 ? xyz(e, 2 + 3 * i) : xyz(e, 2 + 6 * i),
          );
        if (e.form === 63 && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) > 0) pts.push(pts[0]);
        return pts.length >= 2 ? local({ kind: 'poly', pts }) : undefined;
      }
      case 110:
        need(e, 6);
        return local({ kind: 'line', a: xyz(e, 0), b: xyz(e, 3) });
      case 112: {
        const segments = n(e, 3),
          breaks = Array.from({ length: segments + 1 }, (_, i) => n(e, 4 + i)),
          coefficients = Array.from({ length: segments }, (_, i) =>
            Array.from({ length: 12 }, (_, j) => n(e, 5 + segments + 12 * i + j)),
          );
        need(e, 5 + 13 * segments);
        const c = polynomialCurve(breaks, coefficients);
        if (!c) throw invalid(`${name(e)}: its breakpoints do not increase`);
        return local(c);
      }
      case 126:
        return local(bspline(e));
      case 130: {
        need(e, 14);
        const base = curve(ptr(e, 0), m, depth + 1),
          flag = n(e, 1),
          d1 = n(e, 5) * scaleOf(m),
          d2 = n(e, 7) * scaleOf(m),
          td1 = n(e, 6),
          td2 = n(e, 8),
          normal = unit(rotate(m, xyz(e, 9))),
          tt1 = n(e, 12),
          tt2 = n(e, 13);
        if (!base) return undefined;
        if (flag === 3) throw unsupported(`${name(e)}: offsets given by a function curve are not supported`);
        if (!(len(normal) > 0)) throw invalid(`${name(e)}: no plane normal`);
        if (flag === 2 && n(e, 4) === 1)
          throw unsupported(`${name(e)}: offsets varying with arc length are not supported`);
        const [a, b] = domain(base),
          t0 = tt1 < tt2 ? tt1 : a,
          t1 = tt1 < tt2 ? tt2 : b,
          h = (t1 - t0) * 1e-6;
        const f = (t: number): V3 => {
          const p = pointAt(base, t),
            tangent = unit(sub(pointAt(base, Math.min(t1, t + h)), pointAt(base, Math.max(t0, t - h)))),
            d = flag === 2 && td2 !== td1 ? d1 + ((d2 - d1) * (t - td1)) / (td2 - td1) : d1;
          return [p[0], p[1], p[2]].map((v, i) => v + d * cross(normal, tangent)[i]);
        };
        return { kind: 'nurbs', n: fit(f, t0, t1, fitTol, 8) };
      }
      case 142: {
        const c = ptr(e, 3);
        return c ? curve(c, m, depth + 1) : undefined;
      }
      default:
        warn(`${name(e)} is not a curve the converter reads; left out`);
        return undefined;
    }
  };

  /** A rational B-spline curve (126) in its definition space. */
  const bspline = (e: IGESEntity): Curve3 => {
    const K = n(e, 0),
      M = n(e, 1),
      N = 1 + K - M,
      A = N + 2 * M;
    if (!(Number.isInteger(K) && Number.isInteger(M) && M >= 1 && K >= M))
      throw invalid(`${name(e)}: upper index ${K} and degree ${M} do not make a B-spline`);
    need(e, 15 + A + 4 * K);
    const U = Array.from({ length: A + 1 }, (_, i) => n(e, 6 + i)),
      polynomial = n(e, 4) === 1,
      W = Array.from({ length: K + 1 }, (_, i) => n(e, 7 + A + i, 1)),
      P = Array.from({ length: K + 1 }, (_, i) => xyz(e, 8 + A + K + 3 * i)),
      v0 = n(e, 11 + A + 4 * K),
      v1 = n(e, 12 + A + 4 * K);
    for (let i = 1; i < U.length; i++) if (U[i] < U[i - 1]) throw invalid(`${name(e)}: its knots decrease`);
    if (W.some((x) => !(x > 0))) throw invalid(`${name(e)}: a weight is not positive`);
    const lo = U[M],
      hi = U[K + 1],
      rational = !polynomial && W.some((x) => Math.abs(x - W[0]) > 1e-12 * W[0]);
    const t0 = v0 < v1 ? Math.max(lo, v0) : lo,
      t1 = v0 < v1 ? Math.min(hi, v1) : hi;
    return { kind: 'nurbs', n: { p: M, U, P, ...(rational ? { W } : {}), t0, t1 } };
  };

  /** A curve in parameter space (a 142's B, a 141's or 508's parameter curves), with its own transform only. */
  const paramCurve = (de: number): Curve3 | undefined => curve(de, identity);

  // --- surfaces -------------------------------------------------------------------------------------------------
  const pointEntity = (de: number, m: Xf): V3 => {
    const e = E(de);
    if (!e || e.type !== 116) throw invalid(`point ${de} is missing or not a type 116 entity`);
    return apply(compose(m, matrix(e.transform)), xyz(e, 0));
  };
  const directionEntity = (de: number, m: Xf): V3 => {
    const e = E(de);
    if (!e || e.type !== 123) throw invalid(`direction ${de} is missing or not a type 123 entity`);
    const d = unit(rotate(m, xyz(e, 0)));
    if (!(len(d) > 0)) throw invalid(`direction ${de} is zero`);
    return d;
  };
  const surface = (de: number, outer: Xf, depth = 0): Surf | undefined => {
    const e = E(de);
    if (!e) {
      warn(`surface ${de} is missing`);
      return undefined;
    }
    if (depth > 8) throw invalid(`${name(e)}: surfaces nested too deeply`);
    const m = placed(e, outer),
      local = (s: Surf) => transformSurf(s, m);
    switch (e.type) {
      case 108: {
        need(e, 4);
        const normal = [n(e, 0), n(e, 1), n(e, 2)],
          l = len(normal);
        if (!(l > 0)) throw invalid(`${name(e)}: its coefficients A, B and C are all zero`);
        return local({ kind: 'plane', o: mul(normal, n(e, 3) / (l * l)), n: unit(normal) });
      }
      case 114:
        // The order of the 48 coefficients per patch is given only by a formula image in the specification and has
        // not been checked against it yet (docs/known-bugs.md), so the entity is refused rather than guessed.
        throw new MargoError(
          'unsupported',
          'unsupported IGES entity 114 (parametric spline surface): coefficient order not yet verified against the IGES 5.3 spec; convert the surface to entity 128 in the sending CAD system',
        );
      case 118: {
        need(e, 3);
        const c1 = curve(ptr(e, 0), m),
          c2 = curve(ptr(e, 1), m);
        if (!c1 || !c2) throw invalid(`${name(e)}: a rail curve is missing`);
        return { kind: 'nurbs', s: ruledSurface(c1, c2, n(e, 2) === 1, e.form === 0), dom: [0, 1, 0, 1] };
      }
      case 120: {
        need(e, 4);
        const axis = curve(ptr(e, 0), m),
          generatrix = curve(ptr(e, 1), m);
        if (!axis || axis.kind !== 'line') throw invalid(`${name(e)}: its axis is not a line`);
        if (!generatrix) throw invalid(`${name(e)}: its generatrix is missing`);
        const d = unit(sub(axis.b, axis.a));
        if (!(len(d) > 0)) throw invalid(`${name(e)}: its axis has no length`);
        // The axis and generatrix are already in model space (their transforms include this entity's).
        return { kind: 'revolution', a: axis.a, d, curve: generatrix, sa: n(e, 2), ta: n(e, 3) };
      }
      case 122: {
        need(e, 4);
        const directrix = curve(ptr(e, 0), m);
        if (!directrix) throw invalid(`${name(e)}: its directrix is missing`);
        return { kind: 'extrusion', curve: directrix, v: sub(apply(m, xyz(e, 1)), startOf(directrix)) };
      }
      case 128: {
        const K1 = n(e, 0),
          K2 = n(e, 1),
          M1 = n(e, 2),
          M2 = n(e, 3),
          A = K1 - M1 + 1 + 2 * M1,
          B = K2 - M2 + 1 + 2 * M2,
          C = (1 + K1) * (1 + K2);
        if (!(M1 >= 1 && M2 >= 1 && K1 >= M1 && K2 >= M2 && Number.isInteger(K1) && Number.isInteger(K2)))
          throw invalid(`${name(e)}: upper indices ${K1}, ${K2} and degrees ${M1}, ${M2} do not make a B-spline`);
        need(e, 13 + A + B + 4 * C);
        const U = Array.from({ length: A + 1 }, (_, i) => n(e, 9 + i)),
          V = Array.from({ length: B + 1 }, (_, i) => n(e, 10 + A + i)),
          W = Array.from({ length: C }, (_, i) => n(e, 11 + A + B + i, 1)),
          P = Array.from({ length: C }, (_, i) => xyz(e, 11 + A + B + C + 3 * i)),
          at = 11 + A + B + 4 * C,
          polynomial = n(e, 6) === 1;
        for (const knots of [U, V])
          for (let i = 1; i < knots.length; i++)
            if (knots[i] < knots[i - 1]) throw invalid(`${name(e)}: its knots decrease`);
        if (W.some((x) => !(x > 0))) throw invalid(`${name(e)}: a weight is not positive`);
        const rational = !polynomial && W.some((x) => Math.abs(x - W[0]) > 1e-12 * W[0]),
          [u0, u1, v0, v1] = [n(e, at), n(e, at + 1), n(e, at + 2), n(e, at + 3)],
          dom = [
            u0 < u1 ? Math.max(u0, U[M1]) : U[M1],
            u0 < u1 ? Math.min(u1, U[K1 + 1]) : U[K1 + 1],
            v0 < v1 ? Math.max(v0, V[M2]) : V[M2],
            v0 < v1 ? Math.min(v1, V[K2 + 1]) : V[K2 + 1],
          ];
        return local({
          kind: 'nurbs',
          s: { pu: M1, pv: M2, U, V, nu: K1 + 1, nv: K2 + 1, P, ...(rational ? { W } : {}) },
          dom,
        });
      }
      case 140: {
        need(e, 5);
        const base = surface(ptr(e, 4), m, depth + 1);
        if (!base) throw invalid(`${name(e)}: its base surface is missing`);
        return { kind: 'offset', base, d: n(e, 3) * scaleOf(m) };
      }
      case 190: {
        const o = pointEntity(ptr(e, 0), m),
          z = directionEntity(ptr(e, 1), m);
        if (e.form === 1 && ptr(e, 2)) {
          const d = directionEntity(ptr(e, 2), m),
            x = unit(sub(d, mul(z, dot(d, z))));
          return { kind: 'plane', o, n: z, x, y: cross(z, x) };
        }
        return { kind: 'plane', o, n: z };
      }
      case 192:
      case 194:
      case 196:
      case 198: {
        const o = pointEntity(ptr(e, 0), m),
          sphere = e.type === 196,
          z = sphere ? (ptr(e, 2) ? directionEntity(ptr(e, 2), m) : [0, 0, 1]) : directionEntity(ptr(e, 1), m),
          refAt = e.type === 192 ? 3 : e.type === 196 ? 3 : 4,
          d = e.form === 1 && ptr(e, refAt) ? directionEntity(ptr(e, refAt), m) : perpendicular(z),
          x = unit(sub(d, mul(z, dot(d, z)))),
          k = scaleOf(m),
          r = (sphere ? n(e, 1) : n(e, 2)) * k,
          r2 = e.type === 194 ? (n(e, 3) * Math.PI) / 180 : e.type === 198 ? n(e, 3) * k : 0;
        if (!(r > 0) && e.type !== 194) throw invalid(`${name(e)}: its radius is not positive`);
        const kind = e.type === 192 ? 'cylinder' : e.type === 194 ? 'cone' : sphere ? 'sphere' : 'torus';
        return { kind, o, x, y: cross(z, x), z, r, r2 };
      }
      default:
        warn(`${name(e)} is not a surface the converter reads; left out`);
        return undefined;
    }
  };

  // --- STEP geometry ----------------------------------------------------------------------------------------------
  const writeNurbs = (c: Nurbs): string => {
    const knots: number[] = [],
      mults: number[] = [];
    for (const u of c.U)
      if (knots.length && u === knots[knots.length - 1]) mults[mults.length - 1]++;
      else {
        knots.push(u);
        mults.push(1);
      }
    return w.spline({
      degrees: [c.p],
      counts: [c.P.length],
      knots: [knots],
      multiplicities: [mults],
      points: c.P,
      ...(c.W ? { weights: c.W } : {}),
    });
  };
  const curveIds = new WeakMap<Curve3, string>();
  /** A STEP curve for one piece (a line, conic, B-spline, or a chain or polyline joined into one B-spline). */
  const stepCurve = (c: Curve3): string => {
    const known = curveIds.get(c);
    if (known) return known;
    let id: string;
    if (c.kind === 'line') {
      const d = sub(c.b, c.a);
      id = w.add(`LINE('',${w.point(c.a)},${w.add(`VECTOR('',${w.direction(unit(d))},${w.real(len(d))})`)})`);
    } else if (c.kind === 'conic' && Math.abs(dot(c.X, c.Y)) <= 1e-12 * dot(c.X, c.X)) {
      const a = len(c.X),
        b = len(c.Y),
        axis = w.axis(c.c, cross(c.X, c.Y), c.X);
      id =
        Math.abs(a - b) <= 1e-12 * a
          ? w.add(`CIRCLE('',${axis},${w.real(a)})`)
          : w.add(`ELLIPSE('',${axis},${w.real(a)},${w.real(b)})`);
    } else {
      const s = nurbsOf(c);
      if (!s) throw invalid('a curve with no points');
      id = writeNurbs(s);
    }
    curveIds.set(c, id);
    return id;
  };

  /**
   * The curve a swept surface sweeps, as one STEP curve: lines as they are, anything else as its exact B-spline over the
   * range it uses (a whole circle would let the kernel's (u, v) of a face that crosses the circle's seam run off it).
   */
  const sweptCurve = (c: Curve3): string => {
    if (c.kind === 'line' || c.kind === 'nurbs') return stepCurve(c);
    const s = nurbsOf(c);
    if (!s) throw invalid('a swept curve with no points');
    return writeNurbs(s);
  };
  const pendingOffsets: { id: string; baseId: string; base: Surf; d: number }[] = [];
  const surfaceIds = new WeakMap<Surf, string>();
  const stepSurface = (s: Surf): string => {
    const known = surfaceIds.get(s);
    if (known) return known;
    let id: string;
    switch (s.kind) {
      case 'plane':
        id = w.add(`PLANE('',${w.axis(s.o, s.n, s.x ?? perpendicular(s.n))})`);
        break;
      case 'cylinder':
        id = w.add(`CYLINDRICAL_SURFACE('',${w.axis(s.o, s.z, s.x)},${w.real(s.r)})`);
        break;
      case 'cone':
        id = w.add(`CONICAL_SURFACE('',${w.axis(s.o, s.z, s.x)},${w.real(s.r)},${w.real(s.r2)})`);
        break;
      case 'sphere':
        id = w.add(`SPHERICAL_SURFACE('',${w.axis(s.o, s.z, s.x)},${w.real(s.r)})`);
        break;
      case 'torus':
        id = w.add(`TOROIDAL_SURFACE('',${w.axis(s.o, s.z, s.x)},${w.real(s.r)},${w.real(s.r2)})`);
        break;
      case 'nurbs': {
        const distinct = (U: readonly number[]) => {
          const knots: number[] = [],
            mults: number[] = [];
          for (const u of U)
            if (knots.length && u === knots[knots.length - 1]) mults[mults.length - 1]++;
            else {
              knots.push(u);
              mults.push(1);
            }
          return [knots, mults];
        };
        const [ku, mu] = distinct(s.s.U),
          [kv, mv] = distinct(s.s.V);
        id = w.spline({
          degrees: [s.s.pu, s.s.pv],
          counts: [s.s.nu, s.s.nv],
          knots: [ku, kv],
          multiplicities: [mu, mv],
          points: s.s.P,
          ...(s.s.W ? { weights: s.s.W } : {}),
        });
        break;
      }
      case 'revolution': {
        const c = sweptCurve(s.curve);
        id = w.add(
          `SURFACE_OF_REVOLUTION('',${c},${w.add(`AXIS1_PLACEMENT('',${w.point(s.a)},${w.direction(s.d)})`)})`,
        );
        break;
      }
      case 'extrusion': {
        const c = sweptCurve(s.curve);
        if (!(len(s.v) > 0)) throw invalid('a tabulated cylinder with no length');
        id = w.add(
          `SURFACE_OF_LINEAR_EXTRUSION('',${c},${w.add(`VECTOR('',${w.direction(unit(s.v))},${w.real(len(s.v))})`)})`,
        );
        break;
      }
      case 'offset': {
        const baseId = stepSurface(s.base);
        id = w.reserve();
        pendingOffsets.push({ id, baseId, base: s.base, d: s.d });
        break;
      }
    }
    surfaceIds.set(s, id);
    return id;
  };

  // --- edges and loops of faces with their own edges -------------------------------------------------------------
  type Pool = { p: V3; id: string }[];
  const vertexIn = (pool: Pool, p: V3): string => {
    for (const v of pool) if (dist(v.p, p) <= tol) return v.id;
    const id = w.add(`VERTEX_POINT('',${w.point(p)})`);
    pool.push({ p, id });
    return id;
  };
  /** An edge loop of oriented edges from segments in loop order; samples along it for orientation. */
  const writeLoop = (
    segs: readonly Segment[],
    pool: Pool,
    shared: Map<string, string>,
  ): { loop: string; samples: V3[] } | undefined => {
    const oriented: string[] = [],
      samples: V3[] = [];
    for (const s of segs) {
      const a = startOf(s.curve),
        b = endOf(s.curve),
        v1 = vertexIn(pool, a),
        v2 = vertexIn(pool, b);
      if (v1 === v2 && lengthOf(s.curve) <= 10 * tol) continue;
      let edge = s.key ? shared.get(s.key) : undefined;
      if (!edge) {
        edge = w.add(`EDGE_CURVE('',${v1},${v2},${stepCurve(s.curve)},.T.)`);
        if (s.key) shared.set(s.key, edge);
      }
      oriented.push(w.add(`ORIENTED_EDGE('',*,*,${edge},${s.forward ? '.T.' : '.F.'})`));
      const [t0, t1] = domain(s.curve);
      for (let i = 0; i < 24; i++) {
        const f = i / 24;
        samples.push(pointAt(s.curve, s.forward ? t0 + (t1 - t0) * f : t1 - (t1 - t0) * f));
      }
    }
    if (!oriented.length) return undefined;
    return { loop: w.add(`EDGE_LOOP('',(${oriented.join(',')}))`), samples };
  };
  const forwardPieces = (c: Curve3, reverse = false): Segment[] => {
    const ps = pieces(c, tol).map((curve) => ({ curve, forward: !reverse }));
    return reverse ? ps.reverse() : ps;
  };
  /** Segments of a curve given in a surface's parameter space, mapped through the surface (fitted). */
  const throughSurface = (c: Curve3, s: Surf): Segment[] =>
    pieces(c, 0).map((piece) => {
      const [a, b] = domain(piece);
      return {
        curve: {
          kind: 'nurbs',
          n: fit(
            (t) => {
              const uv = pointAt(piece, t),
                p = surfPoint(s, uv[0], uv[1]);
              if (!p) throw invalid('a parameter-space curve on a surface with no parameterization');
              return p;
            },
            a,
            b,
            fitTol,
          ),
        },
        forward: true,
      };
    });
  /** The boundary of a surface's parameter rectangle, counterclockwise, seams shared and poles left out. */
  const domainLoop = (s: Surf): Segment[] => {
    const [u0, u1, v0, v1] = surfDomain(s);
    if (![u0, u1, v0, v1].every(Number.isFinite)) throw invalid('an unbounded surface with no boundary');
    const at = (u: number, v: number) => surfPoint(s, u, v) ?? [0, 0, 0];
    const iso = (fixed: number, alongU: boolean): Curve3 => ({
      kind: 'nurbs',
      n: alongU ? fit((u) => at(u, fixed), u0, u1, fitTol) : fit((v) => at(fixed, v), v0, v1, fitTol),
    });
    const same = (f: (t: number) => [V3, V3]) => [0.13, 0.5, 0.91].every((t) => dist(...f(t)) <= tol);
    const uSeam = same((t) => [at(u0, v0 + (v1 - v0) * t), at(u1, v0 + (v1 - v0) * t)]),
      vSeam = same((t) => [at(u0 + (u1 - u0) * t, v0), at(u0 + (u1 - u0) * t, v1)]);
    const bottom = iso(v0, true),
      right = iso(u1, false),
      top = vSeam ? bottom : iso(v1, true),
      left = uSeam ? right : iso(u0, false);
    return [
      { curve: bottom, forward: true, key: vSeam ? 'v' : undefined },
      { curve: right, forward: true, key: uSeam ? 'u' : undefined },
      { curve: top, forward: false, key: vSeam ? 'v' : undefined },
      { curve: left, forward: false, key: uSeam ? 'u' : undefined },
    ];
  };

  // --- colours ----------------------------------------------------------------------------------------------------
  const colorOf = (...es: (IGESEntity | undefined)[]): number[] | undefined => {
    for (const e of es) {
      if (!e || !e.color) continue;
      if (e.color > 0) {
        if (COLORS[e.color]) return COLORS[e.color];
        continue;
      }
      const def = E(-e.color);
      if (def?.type === 314) return [n(def, 0), n(def, 1), n(def, 2)].map((v) => Math.min(1, Math.max(0, v / 100)));
    }
    return undefined;
  };

  // --- faces ------------------------------------------------------------------------------------------------------
  const jobs: FaceJob[] = [];
  const job = (surf: Surf, sign: number, where: string, color?: number[]): FaceJob => {
    const j: FaceJob = { id: w.reserve(), surf, surfId: stepSurface(surf), sign, bounds: [], color, where };
    jobs.push(j);
    return j;
  };
  /** The model-space segments of a curve on a surface (142): its model curve, else its parameter curve mapped. */
  const curveOnSurface = (de: number, outer: Xf, s: Surf): Segment[] => {
    const e = E(de);
    if (!e) throw invalid(`curve on surface ${de} is missing`);
    if (e.type !== 142) {
      const c = curve(de, outer);
      if (!c) throw invalid(`boundary ${de} is not a curve`);
      return forwardPieces(c);
    }
    const m = placed(e, outer),
      model = ptr(e, 3) ? curve(ptr(e, 3), m) : undefined;
    if (model) return forwardPieces(model);
    const b = ptr(e, 2) ? paramCurve(ptr(e, 2)) : undefined;
    if (!b) throw invalid(`${name(e)} has neither a model-space nor a parameter-space curve`);
    return throughSurface(b, s);
  };
  const faceOf = (j: FaceJob, loops: { segs: Segment[]; outer?: boolean }[]) => {
    const pool: Pool = [],
      shared = new Map<string, string>();
    for (const l of loops) {
      const written = writeLoop(l.segs, pool, shared);
      if (written) j.bounds.push({ loop: written.loop, outer: l.outer, samples: written.samples });
    }
    if (!j.bounds.length) throw invalid(`${j.where} has no boundary with any length`);
  };
  const trimmed = (e: IGESEntity, outer: Xf) => {
    const m = placed(e, outer),
      s = surface(ptr(e, 0), m);
    if (!s) throw invalid(`${name(e)}: its surface is missing`);
    const j = job(s, 1, name(e), colorOf(e, E(ptr(e, 0)))),
      inner = n(e, 2),
      loops: { segs: Segment[]; outer?: boolean }[] = [
        { segs: n(e, 1) === 0 || !ptr(e, 3) ? domainLoop(s) : curveOnSurface(ptr(e, 3), m, s), outer: true },
      ];
    for (let i = 0; i < inner; i++) loops.push({ segs: curveOnSurface(ptr(e, 4 + i), m, s), outer: false });
    faceOf(j, loops);
  };
  const bounded = (e: IGESEntity, outer: Xf) => {
    const m = placed(e, outer),
      s = surface(ptr(e, 1), m);
    if (!s) throw invalid(`${name(e)}: its surface is missing`);
    const j = job(s, 1, name(e), colorOf(e, E(ptr(e, 1)))),
      loops: { segs: Segment[]; outer?: boolean }[] = [];
    for (let i = 0; i < n(e, 2); i++) {
      const b = E(ptr(e, 3 + i));
      if (!b || b.type !== 141) throw invalid(`${name(e)}: boundary ${ptr(e, 3 + i)} is not a type 141 entity`);
      const mb = placed(b, m),
        segs: Segment[] = [];
      let at = 4;
      for (let c = 0; c < n(b, 3); c++) {
        const crv = ptr(b, at),
          reverse = n(b, at + 1) === 2,
          K = n(b, at + 2),
          model = crv ? curve(crv, mb) : undefined;
        if (model) segs.push(...forwardPieces(model, reverse));
        else if (K > 0) {
          const run: Segment[] = [];
          for (let q = 0; q < K; q++) {
            const pc = paramCurve(ptr(b, at + 3 + q));
            if (pc) run.push(...throughSurface(pc, s));
          }
          segs.push(...(reverse ? run.reverse().map((x) => ({ ...x, forward: !x.forward })) : run));
        }
        at += 3 + K;
      }
      loops.push({ segs });
    }
    faceOf(j, loops);
  };
  const boundedPlane = (e: IGESEntity, outer: Xf) => {
    const m = placed(e, outer),
      s = surface(e.de, outer),
      c = curve(ptr(e, 4), m);
    if (!s || !c) throw invalid(`${name(e)}: its boundary curve is missing`);
    faceOf(job(s, 1, name(e), colorOf(e)), [{ segs: forwardPieces(c), outer: true }]);
  };
  const untrimmed = (e: IGESEntity, outer: Xf) => {
    const s = surface(e.de, outer);
    if (!s) return;
    faceOf(job(s, 1, name(e), colorOf(e)), [{ segs: domainLoop(s), outer: true }]);
  };

  // --- manifold solid B-rep objects (186) and shells (514) --------------------------------------------------------
  const vertexIds = new Map<string, { id: string; p: V3 }>();
  const listVertex = (de: number, index: number, m: Xf) => {
    const key = `${de}:${index}`;
    let v = vertexIds.get(key);
    if (!v) {
      const e = E(de);
      if (!e || e.type !== 502) throw invalid(`vertex list ${de} is missing or not a type 502 entity`);
      if (!(index >= 1 && index <= n(e, 0))) throw invalid(`${name(e)} has no vertex ${index}`);
      const p = apply(m, xyz(e, 1 + 3 * (index - 1)));
      v = { id: w.add(`VERTEX_POINT('',${w.point(p)})`), p };
      vertexIds.set(key, v);
    }
    return v;
  };
  const edgeIds = new Map<string, string[]>();
  /** An edge list entry as STEP edges in its natural order (one per piece of a composite curve). */
  const listEdge = (de: number, index: number, m: Xf): string[] => {
    const key = `${de}:${index}`,
      known = edgeIds.get(key);
    if (known) return known;
    const e = E(de);
    if (!e || e.type !== 504) throw invalid(`edge list ${de} is missing or not a type 504 entity`);
    if (!(index >= 1 && index <= n(e, 0))) throw invalid(`${name(e)} has no edge ${index}`);
    const at = 1 + 5 * (index - 1),
      c = curve(ptr(e, at), m);
    if (!c) throw invalid(`${name(e)}: edge ${index} has no curve`);
    const v1 = listVertex(ptr(e, at + 1), n(e, at + 2), m),
      v2 = listVertex(ptr(e, at + 3), n(e, at + 4), m),
      ps = pieces(c, tol),
      out: string[] = [];
    let from = v1.id;
    ps.forEach((piece, i) => {
      const to = i === ps.length - 1 ? v2.id : w.add(`VERTEX_POINT('',${w.point(endOf(piece))})`);
      out.push(w.add(`EDGE_CURVE('',${from},${to},${stepCurve(piece)},.T.)`));
      from = to;
    });
    edgeIds.set(key, out);
    return out;
  };
  const loopOf = (de: number, m: Xf): string | undefined => {
    const e = E(de);
    if (!e || e.type !== 508) throw invalid(`loop ${de} is missing or not a type 508 entity`);
    const oriented: string[] = [];
    let pole: string | undefined,
      at = 1;
    for (let i = 0; i < n(e, 0); i++) {
      const type = n(e, at),
        list = ptr(e, at + 1),
        index = n(e, at + 2),
        agrees = n(e, at + 3) !== 0,
        K = n(e, at + 4);
      if (type === 1) pole = listVertex(list, index, m).id;
      else {
        const edges = listEdge(list, index, m),
          run = edges.map((id) => w.add(`ORIENTED_EDGE('',*,*,${id},${agrees ? '.T.' : '.F.'})`));
        oriented.push(...(agrees ? run : run.reverse()));
      }
      at += 5 + 2 * K;
    }
    if (oriented.length) return w.add(`EDGE_LOOP('',(${oriented.join(',')}))`);
    return pole ? w.add(`VERTEX_LOOP('',${pole})`) : undefined;
  };
  const faceOf510 = (de: number, sign: number, m: Xf, colors: (IGESEntity | undefined)[]): string => {
    const e = E(de);
    if (!e || e.type !== 510) throw invalid(`face ${de} is missing or not a type 510 entity`);
    const s = surface(ptr(e, 0), m);
    if (!s) throw invalid(`${name(e)}: its surface is missing`);
    const outerFlag = n(e, 2) !== 0,
      bounds: Bound[] = [];
    for (let i = 0; i < n(e, 1); i++) {
      const loop = loopOf(ptr(e, 3 + i), m);
      // IGES loops keep the face's material on their left about the surface normal; STEP's about the face's.
      if (loop) bounds.push({ loop, outer: i === 0 && outerFlag, orientation: sign > 0 });
    }
    if (!bounds.length) throw invalid(`${name(e)} has no loops`);
    const j = job(s, sign, name(e), colorOf(e, ...colors));
    j.bounds.push(...bounds);
    return j.id;
  };
  const shellFaces = (de: number, flip: boolean, m: Xf, colors: (IGESEntity | undefined)[]) => {
    const e = E(de);
    if (!e || e.type !== 514) throw invalid(`shell ${de} is missing or not a type 514 entity`);
    const faces: string[] = [];
    for (let i = 0; i < n(e, 0); i++) {
      const agrees = n(e, 2 + 2 * i) !== 0;
      try {
        faces.push(faceOf510(ptr(e, 1 + 2 * i), (agrees ? 1 : -1) * (flip ? -1 : 1), m, [e, ...colors]));
      } catch (error) {
        warn(`face ${ptr(e, 1 + 2 * i)} of ${name(e)} left out: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { faces, closed: e.form !== 2 };
  };

  // --- what to convert ------------------------------------------------------------------------------------------
  const referenced = new Set<number>();
  for (const e of file.entities.values()) {
    const mark = (...des: number[]) => des.forEach((d) => d > 0 && referenced.add(d));
    switch (e.type) {
      case 186:
        mark(ptr(e, 0), ...Array.from({ length: n(e, 2) }, (_, i) => ptr(e, 3 + 2 * i)));
        break;
      case 144:
        mark(ptr(e, 0));
        break;
      case 143:
        mark(ptr(e, 1));
        break;
      case 510:
      case 141:
        mark(ptr(e, e.type === 510 ? 0 : 2));
        break;
      case 142:
        mark(ptr(e, 1));
        break;
      case 140:
        mark(ptr(e, 4));
        break;
      case 308:
        mark(...Array.from({ length: n(e, 2) }, (_, i) => ptr(e, 3 + i)));
        break;
    }
  }
  const solids: { outer: { faces: string[] }; voids: { faces: string[] }[] }[] = [],
    shells: { faces: string[]; closed: boolean }[] = [],
    loose: string[] = [];
  let blanked = 0,
    instances = 0;
  for (const e of file.entities.values()) {
    if (e.type === 408 || e.type === 412 || e.type === 414 || e.type === 430) instances++;
    const candidate = [186, 514, 144, 143, 108, 114, 118, 120, 122, 128, 140].includes(e.type);
    if (!candidate || referenced.has(e.de) || e.use === 5 || e.use === 6) continue;
    if (e.type === 108 && e.form !== 1) continue;
    if (e.blanked) {
      blanked++;
      continue;
    }
    const before = jobs.length;
    try {
      if (e.type === 186) {
        const m = placed(e, root),
          outer = shellFaces(ptr(e, 0), n(e, 1) === 0, m, [e]),
          voids = Array.from({ length: n(e, 2) }, (_, i) =>
            shellFaces(ptr(e, 3 + 2 * i), n(e, 4 + 2 * i) === 0, m, [e]),
          );
        if (outer.faces.length) solids.push({ outer, voids: voids.filter((v) => v.faces.length) });
      } else if (e.type === 514) {
        const shell = shellFaces(e.de, false, placed(e, root), []);
        if (shell.faces.length) shells.push(shell);
      } else {
        if (e.type === 144) trimmed(e, root);
        else if (e.type === 143) bounded(e, root);
        else if (e.type === 108) boundedPlane(e, root);
        else untrimmed(e, root);
        loose.push(...jobs.slice(before).map((j) => j.id));
      }
    } catch (error) {
      // A face that failed part way is dropped with whatever it reserved.
      jobs.length = before;
      if (error instanceof MargoError) refusals.push(error);
      warn(`${name(e)} left out: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (blanked) warn(`${blanked} blanked (hidden) surfaces or solids left out`);
  if (instances) warn(`${instances} subfigure or solid instances left out; the converter does not place instances yet`);

  // --- orientation from the kernel's own evaluators ---------------------------------------------------------------
  let draft: STEPFile | undefined;
  const kernelSurfaces = new Map<string, Surface>(),
    kernelCurves = new Map<number, Curve>();
  const redraft = () => {
    draft = new STEPFile(stepText(w.draft()));
    kernelSurfaces.clear();
    kernelCurves.clear();
  };
  const kernel = (id: string): Surface => {
    let s = kernelSurfaces.get(id);
    if (!s) {
      const file = draft!,
        curves = (c: number) => {
          let found = kernelCurves.get(c);
          if (!found) kernelCurves.set(c, (found = curveOf(file, c)));
          return found;
        };
      kernelSurfaces.set(id, (s = surfaceOf(file, Number(id.slice(1)), 1, curves)));
    }
    return s;
  };
  /** +1 when the kernel's normal of STEP surface `id` runs with the IGES normal of `s`, -1 when against. */
  const relation = (id: string, s: Surf): number => {
    const ks = kernel(id),
      [u0, u1, v0, v1] = surfDomain(s),
      pick = (a: number, b: number, f: number) =>
        Number.isFinite(a) && Number.isFinite(b)
          ? a + (b - a) * f
          : Number.isFinite(a)
            ? a + f
            : Number.isFinite(b)
              ? b - f
              : f - 0.5;
    for (const [fu, fv] of [
      [0.5, 0.5],
      [0.31, 0.62],
      [0.73, 0.27],
      [0.12, 0.88],
    ]) {
      const u = pick(u0, u1, fu),
        v = pick(v0, v1, fv),
        p = s.kind === 'plane' && !s.x ? s.o : surfPoint(s, u, v),
        normal = surfNormal(s, u, v);
      if (!p || !normal) continue;
      const [ku, kv] = ks.parameters(p),
        back = ks.at(ku, kv);
      if (dist(back, p) > Math.max(1e3 * tol, 1e-6 * size)) continue;
      const d = dot(ks.normal(ku, kv), normal);
      if (Math.abs(d) > 0.5) return d > 0 ? 1 : -1;
    }
    return 1;
  };
  const nearest = (x: number, ref: number, period: number) =>
    period ? x + Math.round((ref - x) / period) * period : x;
  /** The signed area a loop's samples enclose in the kernel's (u, v), or undefined when it wraps round a period. */
  const area = (ks: Surface, samples: readonly V3[]): number | undefined => {
    let hint: [number, number] | undefined,
      sum = 0;
    const uv = samples.map((p) => {
      let [u, v] = ks.parameters(p, hint);
      if (hint) {
        u = nearest(u, hint[0], ks.uPeriod);
        v = nearest(v, hint[1], ks.vPeriod);
      }
      hint = [u, v];
      return hint;
    });
    const first = uv[0],
      last = uv[uv.length - 1];
    if (
      (ks.uPeriod && Math.abs(nearest(first[0], last[0], ks.uPeriod) - first[0]) > ks.uPeriod / 2) ||
      (ks.vPeriod && Math.abs(nearest(first[1], last[1], ks.vPeriod) - first[1]) > ks.vPeriod / 2)
    )
      return undefined;
    for (let i = 0; i < uv.length; i++) {
      const a = uv[i],
        b = uv[(i + 1) % uv.length];
      sum += a[0] * b[1] - b[0] * a[1];
    }
    return sum / 2;
  };
  while (pendingOffsets.length) {
    redraft();
    const pending = new Set(pendingOffsets.map((o) => o.id));
    const ready = pendingOffsets.filter((o) => !pending.has(o.baseId));
    if (!ready.length) break;
    for (const o of ready) {
      w.fill(o.id, `OFFSET_SURFACE('',${o.baseId},${w.real(o.d * relation(o.baseId, o.base))},.F.)`);
      pendingOffsets.splice(pendingOffsets.indexOf(o), 1);
    }
  }
  if (jobs.length) redraft();
  for (const j of jobs) {
    if (!j.bounds.length) continue;
    try {
      const sameSense = relation(j.surfId, j.surf) * j.sign > 0,
        ks = kernel(j.surfId);
      const areas = j.bounds.map((b) => (b.orientation === undefined && b.samples ? area(ks, b.samples) : undefined));
      if (j.bounds.some((b) => b.outer === undefined)) {
        let best = -1;
        areas.forEach((a, i) => {
          if (a !== undefined && (best < 0 || Math.abs(a) > Math.abs(areas[best]!))) best = i;
        });
        j.bounds.forEach((b, i) => {
          b.outer = i === (best < 0 ? 0 : best);
        });
      }
      const bounds = j.bounds.map((b, i) => {
        // The face lies left of its bounds (about its own normal): counterclockwise outside, clockwise round holes.
        const a = areas[i],
          rel = a === undefined ? undefined : a * (sameSense ? 1 : -1),
          orientation = b.orientation ?? (rel === undefined || rel === 0 ? true : b.outer ? rel > 0 : rel < 0);
        return w.add(`${b.outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${b.loop},${orientation ? '.T.' : '.F.'})`);
      });
      w.fill(j.id, `ADVANCED_FACE('',(${bounds.join(',')}),${j.surfId},${sameSense ? '.T.' : '.F.'})`);
      if (j.color) w.style(j.id, j.color);
      j.filled = true;
    } catch (error) {
      warn(`${j.where} left out: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- bodies ---------------------------------------------------------------------------------------------------
  const filled = new Set(jobs.filter((j) => j.filled).map((j) => j.id)),
    keep = (faces: readonly string[]) => faces.filter((f) => filled.has(f)),
    items: string[] = [];
  let faceCount = 0,
    solidCount = 0,
    shellCount = 0;
  for (const s of solids) {
    const outer = keep(s.outer.faces);
    if (!outer.length) continue;
    faceCount += outer.length;
    const closed = w.add(`CLOSED_SHELL('',(${outer.join(',')}))`),
      voids = s.voids
        .map((v) => keep(v.faces))
        .filter((f) => f.length)
        .map((f) => {
          faceCount += f.length;
          return w.add(`ORIENTED_CLOSED_SHELL('',*,${w.add(`CLOSED_SHELL('',(${f.join(',')}))`)},.T.)`);
        });
    items.push(
      voids.length
        ? w.add(`BREP_WITH_VOIDS('',${closed},(${voids.join(',')}))`)
        : w.add(`MANIFOLD_SOLID_BREP('',${closed})`),
    );
    solidCount++;
  }
  for (const s of shells) {
    const faces = keep(s.faces);
    if (!faces.length) continue;
    faceCount += faces.length;
    if (s.closed) {
      items.push(w.add(`MANIFOLD_SOLID_BREP('',${w.add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`));
      solidCount++;
    } else {
      items.push(w.add(`SHELL_BASED_SURFACE_MODEL('',(${w.add(`OPEN_SHELL('',(${faces.join(',')}))`)}))`));
      shellCount++;
    }
  }
  const sheet = keep(loose);
  if (sheet.length) {
    faceCount += sheet.length;
    items.push(w.add(`SHELL_BASED_SURFACE_MODEL('',(${w.add(`OPEN_SHELL('',(${sheet.join(',')}))`)}))`));
  }
  // Nothing else to convert: an entity the converter refuses outright says why.
  if (!items.length && refusals.length) throw refusals[0];
  if (!items.length) {
    const first = warnings.length ? ` (${warnings[0]})` : '';
    throw new TypeError(
      `Invalid IGES file: no surfaces or solids to convert among its ${file.entities.size} entities${first}; export surfaces or solids, not only wireframe`,
    );
  }
  return {
    step: w.finish(items, { unit: 'mm', source: `IGES ${g.system || g.preprocessor || g.sender}`.trim() }),
    global: g,
    unit: k,
    counts: { solids: solidCount, shells: shellCount, faces: faceCount },
    warnings,
  };
}
