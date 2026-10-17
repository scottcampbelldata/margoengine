// B-rep tessellation (stages 3 and 4 of docs/brep-kernel.md). Every edge is discretized once, between its exact
// vertices, and every face that shares it uses the same points, so the mesh has no cracks. Each face's bounds are mapped
// into its surface's (u, v) space: periodic coordinates are unwrapped along each loop, a pole or apex becomes a line of
// the domain walked the way that keeps the face on its side, and bounds that wrap round a cylinder, cone or sphere are
// cut open at a seam (two of them make a band; one closes at the pole). The domain is triangulated there with a
// constrained Delaunay triangulation over interior points spaced by the surface's curvature, then refined until every
// interior triangle edge stays within the deflection of the true surface. Normals come from the exact surface, so curved
// faces shade smoothly and every B-rep edge stays hard.
import { Enum, type STEPFile, type Value } from '../step/file.js';
import type { STEPBody, STEPColor } from '../step/structure.js';
import { curveOf, type Curve } from '../geometry/curves.js';
import { surfaceOf, type Surface } from '../geometry/surfaces.js';
import { list, point, ref } from '../geometry/read.js';
import { add, angle as between, cross, distance, nearest, scale, sub, unit, type V3 } from '../geometry/vec.js';
import { interiorEdges, triangulate } from './cdt.js';

/**
 * Options of {@link Tessellator} and {@link tessellateSTEP}. Deflection is the largest distance between a triangle
 * (or an edge's chord) and the exact geometry; angle is the largest turn between neighbouring samples' tangents or
 * normals. Edges use `deflection` and `angle`; face interiors use the `interior` values, which default to them.
 */
export interface TessellationOptions {
  /** Deflection as a fraction of each body's bounding-box diagonal (default 0.001). Ignored when `deflection` is given. */
  readonly relativeDeflection?: number;
  /** Deflection in metres, the same for every body. */
  readonly deflection?: number;
  /** Largest turn between neighbouring edge samples, in radians (default 0.5). */
  readonly angle?: number;
  /** Deflection inside faces, in metres (default: the edges' deflection). */
  readonly interiorDeflection?: number;
  /** Largest turn between neighbouring normals inside faces, in radians (default: `angle`). */
  readonly interiorAngle?: number;
  /** Shortest triangle edge that refinement may create, in metres (default: a tenth of the deflection). */
  readonly minSize?: number;
  /** Most vertices per face (default 50,000); a face that needs more stays at that density. */
  readonly maxFaceVertices?: number;
}

/** One face's triangles in a body mesh. */
export interface BodyMeshFace {
  /** The face's entity id. */
  readonly id: number;
  /** First index into `indices` of the face's triangles. */
  readonly first: number;
  /** Number of indices (3 per triangle). */
  readonly count: number;
  /** The face's own style colour, when the file gives one. */
  readonly color?: STEPColor;
}

/** A tessellated body: vertices per face (so B-rep edges stay hard), exact surface normals, triangle indices. */
export interface BodyMesh {
  /** The body's entity id. */
  readonly id: number;
  /** Positions in the body's coordinates (multiply by `unit` for metres), 3 per vertex. */
  readonly positions: Float32Array;
  /** Unit normals, 3 per vertex. */
  readonly normals: Float32Array;
  /** Triangle vertex indices, counter-clockwise seen from outside the solid. */
  readonly indices: Uint32Array;
  /** The faces in order, each a run of `indices`. */
  readonly faces: readonly BodyMeshFace[];
  /** Faces left out, with the reason (a surface or curve the kernel lacks, or bounds it could not resolve). */
  readonly failures: readonly { readonly id: number; readonly reason: string }[];
  /** Metres per body unit. */
  readonly unit: number;
  /** The edge deflection used, in body units. */
  readonly deflection: number;
}

const isTrue = (v: Value | undefined) => !(v instanceof Enum) || v.name !== 'F';

/** A point of a face's domain: its exact 3D position and (u, v). `line` marks a straight (u, v) segment to the next
 * point that is not a B-rep edge (a pole, or a cut through a band), which is sampled across the surface. */
interface LoopPoint {
  p: V3;
  u: number;
  v: number;
  line?: boolean;
}
interface Wrap {
  points: LoopPoint[];
  ku: number;
  kv: number;
}
interface FaceMesh {
  positions: number[];
  normals: number[];
  indices: number[];
}
/** Tolerances for one body, in its units. */
interface Tolerances {
  edge: number;
  interior: number;
  interiorAngle: number;
  minSize: number;
}

/** Tessellates the bodies of one STEP file, caching curves, surfaces and edge discretizations. */
export class Tessellator {
  private readonly curves = new Map<number, Curve>();
  private readonly surfaces = new Map<number, Surface>();
  private readonly edges = new Map<number, V3[]>();
  private readonly turn: number;
  private readonly maxFaceVertices: number;

  /**
   * @param file - The parsed STEP file.
   * @param faceColors - Face style colours by face id (`STEPStructure.faceColors`).
   * @param options - Deflection, angle and size limits.
   */
  constructor(
    private readonly file: STEPFile,
    private readonly faceColors: ReadonlyMap<number, STEPColor> = new Map(),
    private readonly options: TessellationOptions = {},
  ) {
    const { relativeDeflection = 0.001, deflection, angle = 0.5, interiorDeflection, interiorAngle } = options;
    const positive = (v: number | undefined) => v === undefined || (v > 0 && Number.isFinite(v));
    if (!(relativeDeflection > 0 && relativeDeflection < 1))
      throw new RangeError('relativeDeflection must be between 0 and 1, such as 0.001');
    if (!positive(deflection)) throw new RangeError('deflection must be a positive number of metres');
    if (!positive(interiorDeflection)) throw new RangeError('interiorDeflection must be a positive number of metres');
    if (!positive(options.minSize)) throw new RangeError('minSize must be a positive number of metres');
    if (!(angle > 0 && angle < Math.PI)) throw new RangeError('angle must be between 0 and pi radians, such as 0.5');
    if (interiorAngle !== undefined && !(interiorAngle > 0 && interiorAngle < Math.PI))
      throw new RangeError('interiorAngle must be between 0 and pi radians, such as 0.5');
    const max = options.maxFaceVertices ?? 50_000;
    if (!(Number.isSafeInteger(max) && max >= 64))
      throw new RangeError('maxFaceVertices must be an integer of at least 64');
    this.turn = angle;
    this.maxFaceVertices = max;
  }

  private curve(id: number): Curve {
    let c = this.curves.get(id);
    if (!c) this.curves.set(id, (c = curveOf(this.file, id)));
    return c;
  }
  private surface(id: number, angleUnit: number): Surface {
    let s = this.surfaces.get(id);
    if (!s) this.surfaces.set(id, (s = surfaceOf(this.file, id, angleUnit, (c) => this.curve(c))));
    return s;
  }
  private vertex(id: number | undefined): V3 {
    if (id === undefined || !this.file.is(id, 'VERTEX_POINT'))
      throw new TypeError(`Invalid STEP file: #${id} is not a vertex point`);
    return point(this.file, ref(this.file.args(id, 'VERTEX_POINT')[1]));
  }

  /** Points of edge `id` from its start vertex to its end vertex (the vertex alone for a degenerate edge). */
  private edge(id: number, deflection: number): V3[] {
    const cached = this.edges.get(id);
    if (cached) return cached;
    const [, start, end, geometry, sameSense] = this.file.args(id, 'EDGE_CURVE'),
      p1 = this.vertex(ref(start)),
      p2 = this.vertex(ref(end)),
      closed = ref(start) === ref(end) || distance(p1, p2) <= deflection * 1e-3,
      geom = ref(geometry);
    let out: V3[] = closed ? [p1] : [p1, p2];
    if (geom !== undefined) {
      const c = this.curve(geom),
        forward = isTrue(sameSense);
      let t1 = c.parameter(p1),
        t2: number | undefined;
      if (c.period) {
        // The edge runs from t1 the way its sense says: a full turn when it is closed, less otherwise.
        const ahead = (((c.parameter(p2) - t1) % c.period) + c.period) % c.period,
          span = closed ? c.period : forward ? ahead : (c.period - ahead) % c.period;
        t2 = forward ? t1 + span : t1 - span;
      } else if (closed) {
        // A closed curve that is not marked periodic (a B-spline circle): the whole domain, when its ends meet.
        const [d0, d1] = c.domain;
        if (Number.isFinite(d0) && Number.isFinite(d1) && distance(c.at(d0), c.at(d1)) <= deflection) {
          t1 = forward ? d0 : d1;
          t2 = forward ? d1 : d0;
        }
      } else t2 = c.parameter(p2);
      if (t2 !== undefined && t1 !== t2) {
        out = c.sample(t1, t2, deflection, this.turn).map((t) => c.at(t).slice(0, 3) as V3);
        out[0] = p1;
        out[out.length - 1] = p2;
      }
    }
    this.edges.set(id, out);
    return out;
  }

  /** A face bound's points in order (the face on their left seen from the face's normal side), or its single vertex. */
  private bound(id: number, deflection: number): { points: V3[]; pole?: V3 } {
    const [, loopRef, orientation] = this.file.get(id).args,
      loop = ref(loopRef);
    if (loop === undefined) throw new TypeError(`Invalid STEP file: face bound #${id} has no loop`);
    const type = this.file.get(loop).type;
    if (type === 'VERTEX_LOOP') return { points: [], pole: this.vertex(ref(this.file.get(loop).args[1])) };
    let points: V3[] = [];
    if (type === 'POLY_LOOP') points = list(this.file.get(loop).args[1]).map((v) => point(this.file, ref(v)));
    else if (type === 'EDGE_LOOP')
      for (const oriented of list(this.file.args(loop, 'EDGE_LOOP')[1])) {
        const [, , , element, sense] = this.file.args(ref(oriented) ?? -1, 'ORIENTED_EDGE'),
          edge = this.edge(ref(element) ?? -1, deflection),
          run = isTrue(sense) ? edge : [...edge].reverse();
        // Each edge's last point is the next edge's first.
        for (let i = 0; i < Math.max(1, run.length - 1); i++) points.push(run[i]);
      }
    else throw new TypeError(`Unsupported STEP face bound: #${loop} ${type}; export it again from the CAD tool`);
    // Repeated points (a degenerate edge beside its vertex) add nothing.
    points = points.filter((p, i, all) => all.length === 1 || distance(p, all[(i + all.length - 1) % all.length]) > 0);
    return { points: isTrue(orientation) ? points : points.reverse() };
  }

  /** Tessellates face `id`; throws a TypeError when its geometry or bounds cannot be resolved. */
  private face(id: number, body: STEPBody, tol: Tolerances): FaceMesh {
    const args = this.file.get(id).args,
      bounds = list(args[1]).map((v) => this.bound(ref(v) ?? -1, tol.edge)),
      geometry = ref(args[2]),
      sameSense = isTrue(args[3]),
      s =
        geometry !== undefined
          ? this.surface(geometry, body.angleUnit)
          : planeOf(bounds.find((b) => b.points.length >= 3)?.points ?? []),
      // The face lies left of its bounds in (u, v) when its normal is the surface's, right of them otherwise.
      left = sameSense ? 1 : -1;
    // Points and normals from (u, v) taken back into one period first, so the two sides of a seam give identical bits.
    const wrapU = (u: number) =>
        s.uPeriod ? s.uDomain[0] + ((((u - s.uDomain[0]) % s.uPeriod) + s.uPeriod) % s.uPeriod) : u,
      wrapV = (v: number) =>
        s.vPeriod ? s.vDomain[0] + ((((v - s.vDomain[0]) % s.vPeriod) + s.vPeriod) % s.vPeriod) : v,
      at = (u: number, v: number) => s.at(wrapU(u), wrapV(v)),
      spot = (u: number, v: number) => at(u, v).slice(0, 3) as V3,
      normalAt = (u: number, v: number) => s.normal(wrapU(u), wrapV(v)),
      gap = tol.edge * 1e-4;

    // --- bounds to (u, v) -------------------------------------------------------------------------------------------
    const loops: LoopPoint[][] = [],
      wraps: Wrap[] = [],
      poles: V3[] = [];
    for (const b of bounds) {
      if (b.pole) {
        poles.push(b.pole);
        continue;
      }
      if (b.points.length < 3) continue;
      let hint: [number, number] | undefined;
      const raw = b.points.map((p) => {
        const uv = s.parameters(p, hint);
        hint = uv;
        return { p, u: uv[0], v: uv[1], singular: s.singular(uv[0], uv[1]) };
      });
      const regular = raw.filter((r) => !r.singular);
      if (!regular.length) {
        poles.push(raw[0].p);
        continue;
      }
      const n = raw.length,
        start = raw.indexOf(regular[0]),
        meanV = regular.reduce((sum, r) => sum + r.v, 0) / regular.length,
        tiny = s.uPeriod * 1e-9;
      const out: LoopPoint[] = [];
      let u = regular[0].u,
        v = regular[0].v;
      for (let k = 0; k < n; ) {
        const r = raw[(start + k) % n];
        if (!r.singular) {
          u = nearest(r.u, u, s.uPeriod);
          v = nearest(r.v, v, s.vPeriod);
          out.push({ p: r.p, u, v });
          k++;
          continue;
        }
        // A pole or apex, where u has no meaning: a line of the domain from the u the loop arrives with to the u it
        // leaves with, walked so the face stays on its side (away from the pole). Passing back down the same seam
        // makes that line a full period.
        let j = k + 1;
        while (j < n && raw[(start + j) % n].singular) j++;
        const after = raw[(start + j) % n],
          poleV = nearest(r.v, v, s.vPeriod),
          walk = -(poleV > meanV ? 1 : -1) * left;
        let nextU = nearest(after.u, u, s.uPeriod);
        if (s.uPeriod) {
          if (walk > 0 && nextU <= u + tiny) nextU += s.uPeriod;
          else if (walk < 0 && nextU >= u - tiny) nextU -= s.uPeriod;
        }
        if (Math.abs(nextU - u) > tiny) out.push({ p: r.p, u, v: poleV, line: true }, { p: r.p, u: nextU, v: poleV });
        else out.push({ p: r.p, u, v: poleV });
        u = nextU;
        v = poleV;
        k = j;
      }
      const ku = s.uPeriod ? Math.round((nearest(out[0].u, u, s.uPeriod) - out[0].u) / s.uPeriod) : 0,
        kv = s.vPeriod ? Math.round((nearest(out[0].v, v, s.vPeriod) - out[0].v) / s.vPeriod) : 0;
      if (ku || kv) wraps.push({ points: out, ku, kv });
      else loops.push(out);
    }

    // --- the domain: closed loops, a band cut open at a seam, or a cap closed at a pole -------------------------------
    const domain: LoopPoint[][] = [];
    if (wraps.some((w) => w.ku && w.kv))
      throw new TypeError(`Unsupported STEP face #${id}: a bound wraps both ways round its surface`);
    const transposed = wraps.length > 0 && !!wraps[0].kv,
      period = transposed ? s.vPeriod : s.uPeriod;
    // Work in (a, b) with a the coordinate the bounds wrap in.
    const A = (q: LoopPoint) => (transposed ? q.v : q.u),
      B = (q: LoopPoint) => (transposed ? q.u : q.v),
      make = (p: V3, a: number, b: number, line?: boolean): LoopPoint =>
        transposed ? { p, u: b, v: a, line } : { p, u: a, v: b, line };
    /** A wrapping bound cut where it crosses a = cut (mod the period), from that crossing round to it one period on. */
    const open = (w: Wrap, cut: number): { run: LoopPoint[]; k: number } => {
      const k = transposed ? w.kv : w.ku,
        pts = w.points,
        n = pts.length,
        shift = k * period;
      for (let i = 0; i < n; i++) {
        const q0 = pts[i],
          q1 = pts[(i + 1) % n],
          a0 = A(q0),
          a1 = A(q1) + (i + 1 === n ? shift : 0),
          target = nearest(cut, (a0 + a1) / 2, period);
        if (a0 === a1 || (target - a0) * (target - a1) > 0 || target === a1) continue;
        const t = (target - a0) / (a1 - a0),
          crossing = make(add(q0.p, scale(sub(q1.p, q0.p), t)), target, B(q0) + (B(q1) - B(q0)) * t, q0.line);
        const run: LoopPoint[] = [crossing];
        for (let j = 1; j <= n; j++) {
          const q = pts[(i + j) % n];
          run.push(make(q.p, A(q) + (i + j >= n ? shift : 0), B(q), q.line));
        }
        run.push(make(crossing.p, target + shift, B(crossing)));
        return { run: dedupe(run), k };
      }
      throw new TypeError(`STEP face #${id}: could not cut a wrapping bound at its seam`);
    };
    if (wraps.length === 2) {
      // A band (the side of a cylinder or cone, a sphere between two latitudes): both bounds cut at one seam, joined
      // by the cut walked once each way.
      const first = open(wraps[0], A(wraps[0].points[0]));
      if (Math.sign(transposed ? wraps[1].kv : wraps[1].ku) === Math.sign(first.k)) {
        // Both bounds run the same way round, against the standard: reverse the second.
        const pts = wraps[1].points,
          reversed = pts.map((_, i) => ({ ...pts[pts.length - 1 - i], line: pts[(pts.length - i) % pts.length].line }));
        wraps[1] = { points: reversed, ku: -wraps[1].ku, kv: -wraps[1].kv };
      }
      const second = open(wraps[1], A(first.run[0])),
        end = first.run[first.run.length - 1],
        shift = A(end) - A(second.run[0]),
        moved = second.run.map((q) => make(q.p, A(q) + shift, B(q), q.line));
      end.line = true;
      moved[moved.length - 1].line = true;
      domain.push([...first.run, ...moved]);
    } else if (wraps.length === 1) {
      // A cap (a sphere or cone end): the bound cut at a seam and closed along the pole on the face's side.
      if (transposed) throw new TypeError(`Unsupported STEP face #${id}: a single bound wrapping in v`);
      const { run, k } = open(wraps[0], A(wraps[0].points[0])),
        side = (Math.sign(k) * left) as 1 | -1;
      let vPole = s.pole(side);
      if (vPole === undefined && poles.length) vPole = s.parameters(poles[0], [run[0].u, run[0].v])[1];
      if (vPole === undefined)
        throw new TypeError(`STEP face #${id}: a bound wraps round a surface that does not close at a pole`);
      const a0 = run[0].u,
        a1 = run[run.length - 1].u,
        pole = poles[0] ?? spot(a0, vPole);
      run[run.length - 1].line = true;
      domain.push([...run, { p: pole, u: a1, v: vPole, line: true }, { p: pole, u: a0, v: vPole, line: true }]);
    } else if (wraps.length > 2)
      throw new TypeError(`Unsupported STEP face #${id}: three or more bounds wrap round it`);
    if (!domain.length && !loops.length) {
      // No edge bounds: the whole closed surface (a full sphere or torus).
      const [u0, u1] = s.uPeriod ? [s.uDomain[0], s.uDomain[0] + s.uPeriod] : s.uDomain,
        [v0, v1] = s.vPeriod ? [s.vDomain[0], s.vDomain[0] + s.vPeriod] : s.vDomain;
      if (![u0, u1, v0, v1].every(Number.isFinite))
        throw new TypeError(`Invalid STEP file: face #${id} has no bounds on an unbounded surface`);
      const corner = (u: number, v: number): LoopPoint => ({ p: spot(u, v), u, v, line: true }),
        corners = [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
      // Corners on one pole are one point.
      if (distance(corners[0].p, corners[1].p) <= gap) corners[1].p = corners[0].p;
      if (distance(corners[2].p, corners[3].p) <= gap) corners[3].p = corners[2].p;
      domain.push(corners);
    }
    // Closed loops: the largest is the outer one unless a band or cap made it; holes move by whole periods into it.
    loops.sort((a, b) => boxArea(b) - boxArea(a));
    const outer = domain[0] ?? loops[0],
      box = bounds2(outer);
    for (const loop of loops) {
      if (loop === outer) {
        domain.push(loop);
        continue;
      }
      const lb = bounds2(loop),
        du = s.uPeriod ? nearest((lb[0] + lb[1]) / 2, (box[0] + box[1]) / 2, s.uPeriod) - (lb[0] + lb[1]) / 2 : 0,
        dv = s.vPeriod ? nearest((lb[2] + lb[3]) / 2, (box[2] + box[3]) / 2, s.vPeriod) - (lb[2] + lb[3]) / 2 : 0;
      domain.push(du || dv ? loop.map((q) => ({ ...q, u: q.u + du, v: q.v + dv })) : loop);
    }

    // --- sampling: pole and cut lines across the surface, then interior points ------------------------------------------
    const all = bounds2(domain.flat()),
      mid = at((all[0] + all[1]) / 2, (all[2] + all[3]) / 2),
      // (u, v) scaled to rough lengths, so the triangulation is Delaunay on the surface rather than in parameters.
      su = Math.hypot(mid[3], mid[4], mid[5]) || 1,
      sv = Math.hypot(mid[6], mid[7], mid[8]) || 1;
    let [du, dv] = s.steps(all, tol.interior, tol.interiorAngle);
    const uv: number[] = [],
      xyz: V3[] = [],
      loopIndices: number[][] = [],
      // A cut appears on both sides of its seam, walked opposite ways: both use one set of points, so they weld exactly.
      lines = new Map<string, V3[]>(),
      canon = (q: LoopPoint) => `${Math.round(wrapU(q.u) * 1e8)},${Math.round(wrapV(q.v) * 1e8)}`;
    for (const loop of domain) {
      const indices: number[] = [],
        put = (p: V3, u: number, v: number) => {
          indices.push(uv.length / 2);
          uv.push(u, v);
          xyz.push(p);
        };
      loop.forEach((q, i) => {
        put(q.p, q.u, q.v);
        if (!q.line) return;
        const r = loop[(i + 1) % loop.length],
          steps = Math.min(1024, Math.ceil(Math.max(Math.abs(r.u - q.u) / du, Math.abs(r.v - q.v) / dv) - 1e-9));
        if (!(steps > 1)) return;
        const qk = canon(q),
          rk = canon(r),
          forward = qk <= rk,
          key = forward ? `${qk};${rk};${steps}` : `${rk};${qk};${steps}`;
        let points = lines.get(key);
        if (!points) {
          const [lo, hi] = forward ? [q, r] : [r, q],
            // Along a pole every point is the pole itself.
            pole = distance(q.p, r.p) <= gap;
          points = [];
          for (let j = 1; j < steps; j++)
            points.push(pole ? q.p : spot(lo.u + ((hi.u - lo.u) * j) / steps, lo.v + ((hi.v - lo.v) * j) / steps));
          lines.set(key, points);
        }
        for (let j = 1; j < steps; j++)
          put(
            points[forward ? j - 1 : steps - 1 - j],
            q.u + ((r.u - q.u) * j) / steps,
            q.v + ((r.v - q.v) * j) / steps,
          );
      });
      loopIndices.push(indices);
    }
    if (Number.isFinite(du) && Number.isFinite(dv) && du > 0 && dv > 0) {
      const w = all[1] - all[0],
        h = all[3] - all[2],
        budget = this.maxFaceVertices / 4;
      while ((w / du) * (h / dv) > budget) {
        du *= 1.5;
        dv *= 1.5;
      }
      const near = boundaryFilter(scaled(uv, su, sv), loopIndices, 0.3 * Math.min(du * su, dv * sv));
      for (let u = all[0] + du / 2; u < all[1]; u += du)
        for (let v = all[2] + dv / 2; v < all[3]; v += dv) {
          if (near(u * su, v * sv)) continue;
          uv.push(u, v);
          xyz.push(spot(u, v));
        }
    }

    // --- triangulation and refinement -----------------------------------------------------------------------------------
    let triangles = triangulate(scaled(uv, su, sv), loopIndices);
    for (let pass = 0; pass < 6 && uv.length / 2 < this.maxFaceVertices; pass++) {
      const added: number[] = [],
        seen = new Set<string>(),
        edges = interiorEdges(triangles, loopIndices);
      for (let e = 0; e < edges.length; e += 2) {
        const a = edges[e],
          b = edges[e + 1];
        if (distance(xyz[a], xyz[b]) < tol.minSize * 2) continue;
        const mu = (uv[a * 2] + uv[b * 2]) / 2,
          mv = (uv[a * 2 + 1] + uv[b * 2 + 1]) / 2,
          far =
            distance(at(mu, mv), scale(add(xyz[a], xyz[b]), 0.5)) > tol.interior ||
            between(normalAt(uv[a * 2], uv[a * 2 + 1]), normalAt(uv[b * 2], uv[b * 2 + 1])) > tol.interiorAngle;
        const key = `${mu},${mv}`;
        if (!far || seen.has(key)) continue;
        seen.add(key);
        added.push(mu, mv);
      }
      // Triangle centres too: a triangle whose edges all hug the surface can still bulge away from it in the middle.
      for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t],
          b = triangles[t + 1],
          c = triangles[t + 2],
          ab = distance(xyz[a], xyz[b]),
          bc = distance(xyz[b], xyz[c]),
          ca = distance(xyz[c], xyz[a]);
        if (Math.min(ab, bc, ca) <= gap || Math.max(ab, bc, ca) < tol.minSize * 2) continue;
        const mu = (uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3,
          mv = (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3,
          centre = scale(add(add(xyz[a], xyz[b]), xyz[c]), 1 / 3);
        if (distance(at(mu, mv), centre) <= tol.interior) continue;
        const key = `${mu},${mv}`;
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(mu, mv);
      }
      if (!added.length) break;
      for (let i = 0; i < added.length && uv.length / 2 < this.maxFaceVertices; i += 2) {
        uv.push(added[i], added[i + 1]);
        xyz.push(spot(added[i], added[i + 1]));
      }
      triangles = triangulate(scaled(uv, su, sv), loopIndices);
    }

    // --- output: triangles wound to face outward, collapsed ones (at a pole) dropped, unused points removed -------------
    const count = uv.length / 2,
      kept: number[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t],
        b = triangles[t + 1],
        c = triangles[t + 2];
      if (!(distance(xyz[a], xyz[b]) > gap && distance(xyz[b], xyz[c]) > gap && distance(xyz[c], xyz[a]) > gap))
        continue;
      if (sameSense) kept.push(a, b, c);
      else kept.push(a, c, b);
    }
    const remap = new Int32Array(count).fill(-1);
    for (const i of kept) remap[i] = 0;
    const positions: number[] = [],
      normals: number[] = [];
    let next = 0;
    for (let i = 0; i < count; i++) {
      if (remap[i] < 0) continue;
      remap[i] = next++;
      const n = normalAt(uv[i * 2], uv[i * 2 + 1]);
      positions.push(xyz[i][0], xyz[i][1], xyz[i][2]);
      if (sameSense) normals.push(n[0], n[1], n[2]);
      else normals.push(-n[0], -n[1], -n[2]);
    }
    return { positions, normals, indices: kept.map((i) => remap[i]) };
  }

  /** A body's tolerances in its units: from the options in metres, or relative to its vertices' bounding box. */
  private tolerances(body: STEPBody): Tolerances {
    const o = this.options;
    let edge: number;
    if (o.deflection !== undefined) edge = o.deflection / body.unit;
    else {
      const lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity],
        grow = (p: V3) => {
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], p[k]);
            hi[k] = Math.max(hi[k], p[k]);
          }
        };
      for (const face of body.faces)
        for (const b of list(this.file.get(face).args[1])) {
          const loop = ref(this.file.get(ref(b) ?? -1).args[1]);
          if (loop === undefined) continue;
          const type = this.file.get(loop).type;
          if (type === 'VERTEX_LOOP') grow(this.vertex(ref(this.file.get(loop).args[1])));
          else if (type === 'POLY_LOOP')
            for (const v of list(this.file.get(loop).args[1])) grow(point(this.file, ref(v)));
          else if (type === 'EDGE_LOOP')
            for (const oriented of list(this.file.args(loop, 'EDGE_LOOP')[1])) {
              const edge = ref(this.file.args(ref(oriented) ?? -1, 'ORIENTED_EDGE')[3]);
              if (edge !== undefined)
                for (const v of this.file.args(edge, 'EDGE_CURVE').slice(1, 3)) grow(this.vertex(ref(v)));
            }
        }
      const diagonal = distance(lo, hi);
      edge = (Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 1) * (o.relativeDeflection ?? 0.001);
    }
    const interior = o.interiorDeflection !== undefined ? o.interiorDeflection / body.unit : edge;
    return {
      edge,
      interior,
      interiorAngle: o.interiorAngle ?? this.turn,
      minSize: o.minSize !== undefined ? o.minSize / body.unit : Math.min(edge, interior) / 10,
    };
  }

  /** Tessellates a body. Faces that fail are listed in `failures`; the rest form the mesh. */
  body(body: STEPBody): BodyMesh {
    const tol = this.tolerances(body),
      positions: number[] = [],
      normals: number[] = [],
      indices: number[] = [],
      faces: BodyMeshFace[] = [],
      failures: { id: number; reason: string }[] = [];
    for (const id of body.faces) {
      let mesh: FaceMesh;
      try {
        mesh = this.face(id, body, tol);
      } catch (error) {
        failures.push({ id, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const base = positions.length / 3,
        first = indices.length;
      for (const c of mesh.positions) positions.push(c);
      for (const c of mesh.normals) normals.push(c);
      for (const i of mesh.indices) indices.push(base + i);
      const color = this.faceColors.get(id);
      faces.push({ id, first, count: mesh.indices.length, ...(color ? { color } : {}) });
    }
    return {
      id: body.id,
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices: Uint32Array.from(indices),
      faces,
      failures,
      unit: body.unit,
      deflection: tol.edge,
    };
  }
}

/** The plane through a polygon (Newell's normal), for a face the file gives no surface. */
function planeOf(points: readonly V3[]): Surface {
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  const z = unit(n) ?? [0, 0, 1],
    x = unit(Math.abs(z[0]) < 0.9 ? cross([1, 0, 0], z) : cross([0, 1, 0], z)) ?? [1, 0, 0],
    y = cross(z, x),
    o = points[0] ?? [0, 0, 0];
  return {
    uPeriod: 0,
    vPeriod: 0,
    uDomain: [-Infinity, Infinity],
    vDomain: [-Infinity, Infinity],
    at: (u, v) => [...add(o, add(scale(x, u), scale(y, v))), ...x, ...y],
    normal: () => z,
    parameters: (p) => {
      const d = sub(p, o);
      return [d[0] * x[0] + d[1] * x[1] + d[2] * x[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2]];
    },
    steps: () => [Infinity, Infinity],
    pole: () => undefined,
    singular: () => false,
  };
}

/** [u0, u1, v0, v1] of some (u, v) points. */
function bounds2(points: readonly LoopPoint[]): [number, number, number, number] {
  const out: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const q of points) {
    out[0] = Math.min(out[0], q.u);
    out[1] = Math.max(out[1], q.u);
    out[2] = Math.min(out[2], q.v);
    out[3] = Math.max(out[3], q.v);
  }
  return out;
}
function boxArea(loop: readonly LoopPoint[]): number {
  const b = bounds2(loop);
  return (b[1] - b[0]) * (b[3] - b[2]);
}
/** Drops consecutive repeats from an open run of (u, v) points. */
function dedupe(run: LoopPoint[]): LoopPoint[] {
  let size = 1;
  for (const q of run) size = Math.max(size, Math.abs(q.u), Math.abs(q.v));
  return run.filter((q, i) => !i || Math.abs(q.u - run[i - 1].u) + Math.abs(q.v - run[i - 1].v) > size * 1e-12);
}
/** (u, v) pairs scaled to rough lengths. */
function scaled(uv: readonly number[], su: number, sv: number): number[] {
  return uv.map((c, i) => (i % 2 ? c * sv : c * su));
}

/** A test for points within `r` of any loop segment, over a grid of cells that each list the segments near them. */
function boundaryFilter(
  xy: readonly number[],
  loops: readonly number[][],
  r: number,
): (x: number, y: number) => boolean {
  if (!(r > 0)) return () => false;
  const cell = 2 * r,
    cells = new Map<number, number[]>(),
    segments: number[] = [];
  let x0 = Infinity,
    y0 = Infinity;
  for (const loop of loops)
    for (const i of loop) {
      x0 = Math.min(x0, xy[i * 2]);
      y0 = Math.min(y0, xy[i * 2 + 1]);
    }
  x0 -= cell * 2;
  y0 -= cell * 2;
  const key = (x: number, y: number) => Math.floor((x - x0) / cell) * 1e7 + Math.floor((y - y0) / cell);
  for (const loop of loops)
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i],
        b = loop[(i + 1) % loop.length],
        ax = xy[a * 2],
        ay = xy[a * 2 + 1],
        bx = xy[b * 2],
        by = xy[b * 2 + 1],
        index = segments.length / 4,
        steps = Math.min(1e5, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
      segments.push(ax, ay, bx, by);
      let last = Number.NaN;
      for (let j = 0; j <= steps; j++) {
        const k = key(ax + ((bx - ax) * j) / (steps || 1), ay + ((by - ay) * j) / (steps || 1));
        if (k === last) continue;
        last = k;
        const entry = cells.get(k);
        if (entry) entry.push(index);
        else cells.set(k, [index]);
      }
    }
  return (x, y) => {
    const base = key(x, y);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const index of cells.get(base + dx * 1e7 + dy) ?? []) {
          const ax = segments[index * 4],
            ay = segments[index * 4 + 1],
            ex = segments[index * 4 + 2] - ax,
            ey = segments[index * 4 + 3] - ay,
            t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
          if (Math.hypot(ax + ex * t - x, ay + ey * t - y) < r) return true;
        }
    return false;
  };
}
