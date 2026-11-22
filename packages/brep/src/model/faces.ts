// A face in its surface's (u, v) parameters, for splitting faces and telling inside from outside: loops sampled into
// (u, v) polylines, continuous across a periodic surface's seam (a loop round a cylinder runs a whole period in u),
// with u mirrored when the face normal opposes the surface's, so the face always lies left of its loops. Inside is
// decided loop by loop, by signed crossings of a line up from the point, which works for loops round a cylinder or a
// sphere's pole as well as for closed ones. On a torus the loops of a face that go round it all go the same way (two
// that went different ways would cross): round its axis, in u; or round its tube, in v, and then u and v are swapped.
import type { Curve } from '../geometry/curves.js';
import { onPole, type Surface } from '../geometry/surfaces.js';
import { add, distance, dot, length, scale, sub, type XYZ } from '../geometry/vec.js';
import { curveEvaluator, surfaceEvaluator } from './geometry.js';
import type { Edge, Face } from './topology.js';
import { edgeParameters } from './validate.js';

export type UV = [number, number];

/** A closed loop in (u', v): points in order, the last joined back to the first moved by `wrap` periods in u'. */
export interface UVLoop {
  readonly points: UV[];
  /** Whole periods the loop goes round in u' (a loop round a cylinder: 1 or -1). */
  readonly wrap: number;
  /**
   * A slit: a loop of edges each run both ways, through no pole and not round the period, so it bounds nothing (a seam
   * from near one pole to near the other, run up and back). The face lies all round it, as round a hole.
   */
  readonly slit?: boolean;
  /**
   * The loop's signed area with each edge's curve end put in where it is apart from the next edge's start (at a
   * tolerant vertex), when that differs from the points'; its sign is the loop's sense.
   */
  readonly area?: number;
}

/** Samples per edge in (u, v): a line maps to a straight line on the surfaces Booleans take; a curve takes enough points to follow its turn. */
export const edgeSamples = (edge: Edge) => (edge.curve.kind === 'line' ? 1 : 128);

/**
 * A surface with its parameters swapped, S'(u, v) = S(v, u): for a face whose loops go round a torus's tube, so that
 * they go round in u. Its natural normal is the reverse of the surface's.
 */
class Swapped implements Surface {
  readonly uPeriod: number;
  readonly vPeriod: number;
  readonly uDomain: readonly [number, number];
  readonly vDomain: readonly [number, number];
  readonly breaks?: () => readonly [readonly number[], readonly number[]];
  constructor(readonly raw: Surface) {
    this.uPeriod = raw.vPeriod;
    this.vPeriod = raw.uPeriod;
    this.uDomain = raw.vDomain;
    this.vDomain = raw.uDomain;
    const breaks = raw.breaks?.bind(raw);
    if (breaks)
      this.breaks = () => {
        const [u, v] = breaks();
        return [v, u];
      };
  }
  at(u: number, v: number): number[] {
    const d = this.raw.at(v, u);
    return [d[0], d[1], d[2], d[6], d[7], d[8], d[3], d[4], d[5]];
  }
  normal(u: number, v: number): XYZ {
    return scale(this.raw.normal(v, u), -1);
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    const [u, v] = this.raw.parameters(p, hint && [hint[1], hint[0]]);
    return [v, u];
  }
  steps(box: readonly number[], deflection: number, turn: number): [number, number] {
    const [du, dv] = this.raw.steps([box[2], box[3], box[0], box[1]], deflection, turn);
    return [dv, du];
  }
  pole(side: 1 | -1): number | undefined {
    return this.raw.uPole?.(side);
  }
  uPole(side: 1 | -1): number | undefined {
    return this.raw.pole(side);
  }
  singular(u: number, v: number): boolean {
    return this.raw.singular(v, u);
  }
}

/**
 * Whether a face's u and v are swapped so its loops can go round in u': always on a surface closed in v only (a ruled
 * band round in v); on one closed both ways, when closed loops through these points go round it in v (a torus cut
 * through its axis: round its tube). Throws a RangeError for a loop that goes round both ways (a helix's thread across a torus).
 */
export function roundV(s: Surface, loops: readonly (readonly XYZ[])[], name: string): boolean {
  // Closed in v only (a ruled band round in v): swapped, so the closed way is u', as round a cylinder.
  if (!s.uPeriod) return !!s.vPeriod;
  if (!s.vPeriod) return false;
  let around = false;
  for (const samples of loops) {
    if (!samples.length) continue;
    const start = s.parameters(samples[0]);
    let [u, v] = start;
    for (let k = 1; k <= samples.length; k++) {
      const [pu, pv] = s.parameters(samples[k % samples.length], [u, v]);
      u = pu + Math.round((u - pu) / s.uPeriod) * s.uPeriod;
      v = pv + Math.round((v - pv) / s.vPeriod) * s.vPeriod;
    }
    const ku = Math.round((u - start[0]) / s.uPeriod),
      kv = Math.round((v - start[1]) / s.vPeriod);
    if (ku && kv)
      throw new RangeError(
        `face ${name}: a loop goes round a torus both ways: not supported yet; move one body slightly and try again`,
      );
    if (kv) around = true;
  }
  return around;
}

export class FaceUV {
  readonly surface: Surface;
  /** The face's own surface (`surface` is it with u and v swapped when its loops go round a torus's tube). */
  readonly raw: Surface;
  /** Whether u and v are swapped: the face's loops go round in v of its own surface. */
  readonly swapped: boolean;
  /** The face's sense against `surface`'s natural normal (reversed when u and v are swapped). */
  readonly sense: boolean;
  /** u is mirrored (u' = -u) when the face normal is the reverse of the surface's natural normal. */
  readonly flip: boolean;
  /** The u' period (0 when u is open). */
  readonly period: number;
  readonly loops: UVLoop[] = [];
  /** The loops' (u', v) bounds: [u0, u1, v0, v1]. */
  readonly box: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
  /**
   * On a surface closed in v as well (a torus): where its tube is cut open, a v no loop crosses and outside the face,
   * so v runs from here one period on and the face's loops and points lie in that range.
   */
  vCut = -Math.PI;
  /** Whether the face contains the circle at `vCut` (a torus with holes): its v then runs the whole period from it. */
  cutInside = false;
  /** A millionth of the face's size (from its vertices): points this close to a pole are at it. */
  #miss = 0;
  /** The v of the surface's poles at its high and low ends (undefined where it has none), found once. */
  #poleVs?: (number | undefined)[];
  /** The surface's poles (where u, or v, has no meaning) and their points, found once. */
  #poles?: { at: { v: number } | { u: number }; point: number[] }[];
  /** The points of the surface's poles, for `edgeCurve`. */
  readonly #polePoints: number[][] = [];
  /** Each edge's curve as `edgeCurve` gives it, and the curve itself (the same where it is not moved), found once. */
  readonly #curves = new Map<Edge, { curve: Curve; edge: Curve; kinks: number[] }>();
  /**
   * Where a loop runs through a pole or apex (a cone's sector, a sphere's lune): there u has no meaning, so the loop
   * runs along the pole's line at v (its points `at` and `at + 1`) from the u' it arrives with to the u' it leaves with.
   * `from` and `to` are those exactly: the meridians its edges run along into and out of the pole, where the loop's
   * points take the samples beside it (an edge that is not a meridian drifts off its meridian on the way).
   */
  readonly poleLines: { loop: number; at: number; v: number; from: number; to: number }[] = [];

  /** `swapped` takes u and v swapped or not (for loops traced later); by default, as the face's own loops need. */
  constructor(
    readonly face: Face,
    swapped?: boolean,
  ) {
    this.raw = surfaceEvaluator(face.surface);
    const corners = face.loops.flatMap((l) => l.coedges.map((c) => c.start.point));
    if (corners.length)
      this.#miss =
        1e-6 *
        Math.max(
          ...[0, 1, 2].map((k) => Math.max(...corners.map((q) => q[k])) - Math.min(...corners.map((q) => q[k]))),
          1e-9,
        );
    // The surface's poles in space (the same points with u and v swapped or not).
    const poles = this.#polePoints;
    for (const side of [1, -1] as const) {
      const v = this.raw.pole(side),
        u = this.raw.uPole?.(side);
      if (v !== undefined) poles.push(this.raw.at(0, v));
      if (u !== undefined) poles.push(this.raw.at(u, 0));
    }
    // Each sample's curve and its parameter there and at the next sample along the loop (the curve taken into the pole
    // where it ends at one, `toPole`).
    const spansOf: { curve: Curve; t: number; next: number }[][] = [],
      // Where each edge's curve ends along the loop, and the sample the next edge starts from.
      endsOf: { after: number; point: XYZ }[][] = [];
    const samplesOf = face.loops.map((loop) => {
      const samples: XYZ[] = [],
        spans: { curve: Curve; t: number; next: number }[] = [],
        ends: { after: number; point: XYZ }[] = [];
      for (const c of loop.coedges) {
        const { curve, kinks } = this.edgeCurves(c.edge),
          ts = this.graded(curve, withBreaks(edgeParameters(c.edge, edgeSamples(c.edge)), kinks));
        if (!c.forward) ts.reverse();
        if (ends.length) ends[ends.length - 1].after = samples.length;
        ends.push({ after: 0, point: curve.at(ts[ts.length - 1]).slice(0, 3) as XYZ });
        for (let k = 0; k < ts.length - 1; k++) {
          samples.push(curve.at(ts[k]).slice(0, 3) as XYZ);
          // An edge over a pole between two samples (a meridian through a sphere's pole) takes the pole as a sample of
          // its own, so the loop runs along the pole's line there as it does through a pole vertex.
          const t = poles.length ? this.overPole(curve, ts[k], ts[k + 1], poles) : undefined;
          if (t === undefined) spans.push({ curve, t: ts[k], next: ts[k + 1] });
          else {
            spans.push({ curve, t: ts[k], next: t }, { curve, t, next: ts[k + 1] });
            samples.push(curve.at(t).slice(0, 3) as XYZ);
          }
        }
      }
      spansOf.push(spans);
      endsOf.push(ends);
      return samples;
    });
    this.swapped = swapped ?? roundV(this.raw, samplesOf, face.name);
    this.surface = this.swapped ? new Swapped(this.raw) : this.raw;
    this.sense = this.swapped ? !face.sense : face.sense;
    this.flip = !this.sense;
    this.period = this.surface.uPeriod;
    samplesOf.forEach((samples, li) => {
      const { loop: traced, lines } = this.trace(samples),
        spans = spansOf[li];
      // A slit's points run back over themselves: its area is rounding, and its sign said the face was empty.
      const uses = new Map<Edge, number>();
      for (const c of face.loops[li].coedges) uses.set(c.edge, (uses.get(c.edge) ?? 0) + (c.forward ? 1 : -1));
      const slit =
        !traced.wrap &&
        !lines.length &&
        [...uses.values()].every((n) => n === 0) &&
        samples.every((p) => this.poleOf(p) === undefined);
      for (const { at, before, after } of lines) {
        // In along the curve from the sample before the line, which meets the pole at the next sample's parameter; out
        // along the curve of the last sample at the pole, from its parameter on.
        const v = traced.points[at][1],
          a = spans[before],
          b = spans[(after + spans.length - 1) % spans.length],
          from = this.meridian(a.curve, a.next, a.t, traced.points[at]),
          to = this.lineEnd(v, from, this.meridian(b.curve, b.t, b.next, traced.points[at + 1]));
        this.poleLines.push({ loop: li, at, v, from, to });
      }
      // At a tolerant vertex an edge's curve ends up to the vertex's tolerance from where the next one starts, and the
      // samples, each edge's from its start, cut across that gap. A face no wider than the gap (a sliver along a line
      // tangent to a circle, its corner a vertex 3.7 um off both curves) then has samples winding the other way, and
      // the face would hold everything but itself: its sense is taken with each curve's end put in.
      const gaps =
        traced.wrap || lines.length || slit || traced.points.length !== samples.length
          ? []
          : endsOf[li].filter(({ after, point }) => distance(point, samples[after]) > this.#miss);
      if (gaps.length) {
        const points: UV[] = [];
        let g = 0;
        traced.points.forEach((q, i) => {
          points.push(q);
          while (g < gaps.length && (gaps[g].after || samples.length) === i + 1)
            points.push(this.near(gaps[g++].point, q));
        });
        this.loops.push({ ...traced, area: polygonArea(points) });
      } else this.loops.push(slit ? { ...traced, slit } : traced);
    });
    // The face's corners at a pole lie side by side round it: their lines span a turn at most. More, and the loops
    // overlap there (two edges taken through a pole from either side of it, the face between them narrower than the
    // pole's reach): no single face, so no integral either.
    for (const v of new Set(this.poleLines.map((l) => l.v))) {
      const turn = this.poleLines.filter((l) => l.v === v).reduce((sum, l) => sum + Math.abs(l.to - l.from), 0);
      if (this.period && turn > this.period * (1 + 1e-9))
        throw new RangeError(
          `face ${face.name}: its loops overlap round a pole: a loop over a pole between its vertices is not supported yet`,
        );
    }
    const vPeriod = this.surface.vPeriod;
    if (vPeriod && this.loops.length) {
      // The cut is a circle round the tube that no loop crosses, so it lies wholly inside or wholly outside the face.
      // Between loops that go round the other way it must lie outside, or the face would lie in two parts; a face
      // whose loops all close (a torus with holes) may contain every such circle, and then contains the cut.
      const options = gaps(
          this.loops.map((l) => vRange(l)),
          vPeriod,
        ),
        wraps = this.loops.some((l) => l.wrap),
        // A loop whose v runs a whole period is bounded by a seam: an edge round the axis used both ways (a torus swept
        // part way round, its tube whole). The seam is the cut, on the face's boundary, not inside it.
        seam = this.loops.find((l) => {
          const [lo, hi] = vRange(l);
          return hi - lo >= vPeriod * (1 - 1e-9);
        }),
        cut = seam
          ? vRange(seam)[0]
          : wraps
            ? options.find(
                (g) =>
                  !inAbove(
                    this.loops.map((l) => shiftV(l, g, vPeriod)),
                    this.period,
                    g,
                  ),
              )
            : options[0];
      if (cut === undefined)
        throw new RangeError(
          `face ${this.face.name}: no circle round its torus's tube cuts it open; move one body slightly and try again`,
        );
      this.vCut = cut;
      this.loops.forEach((l, i) => {
        this.loops[i] = shiftV(l, cut, vPeriod);
      });
      this.cutInside = !seam && !wraps && inAbove(this.loops, this.period, cut);
      this.box[2] = this.cutInside ? cut : Math.min(...this.loops.map((l) => vRange(l)[0]));
      this.box[3] = this.cutInside ? cut + vPeriod : Math.max(...this.loops.map((l) => vRange(l)[1]));
    }
  }

  /**
   * Where a curve passes through one of the poles strictly between parameters t0 and t1 (not at either end, where the
   * sample itself is at the pole): the parameter there, found as the least distance to the pole by golden section once
   * the chord passes near it. Undefined when it does not reach a pole (within the distance at which points are at it).
   */
  overPole(curve: Curve, t0: number, t1: number, poles: readonly number[][]): number | undefined {
    const a = curve.at(t0),
      b = curve.at(t1),
      chord = sub(b, a),
      span = length(chord),
      within = Math.max(this.#miss, 1e-12) * 100;
    if (!span) return undefined;
    for (const pole of poles) {
      if (distance(a, pole) <= within || distance(b, pole) <= within) continue;
      const along = Math.max(0, Math.min(1, dot(sub(pole, a), chord) / (span * span)));
      if (distance(pole, add(a, scale(chord, along))) > 0.5 * span) continue;
      const off = (t: number) => distance(curve.at(t), pole),
        g = (Math.sqrt(5) - 1) / 2;
      let lo = t0,
        hi = t1,
        x1 = hi - g * (hi - lo),
        x2 = lo + g * (hi - lo),
        f1 = off(x1),
        f2 = off(x2);
      for (let k = 0; k < 100 && Math.abs(hi - lo) > 1e-14 * Math.max(1, Math.abs(lo)); k++) {
        if (f1 < f2) {
          hi = x2;
          x2 = x1;
          f2 = f1;
          x1 = hi - g * (hi - lo);
          f1 = off(x1);
        } else {
          lo = x1;
          x1 = x2;
          f1 = f2;
          x2 = lo + g * (hi - lo);
          f2 = off(x2);
        }
      }
      if (Math.min(f1, f2) <= within) return f1 < f2 ? x1 : x2;
    }
    return undefined;
  }

  /**
   * An edge's curve as the face's loops follow it: the curve itself, or where it ends or passes within a pole's reach
   * (`poleReach`) but not at it, the curve taken through the pole. An imported vertex lies a little off a pole (within
   * its tolerance), and an edge passes a little off one: within that distance of the pole it turns round it, by up to
   * half a turn in u. The loop counts the point at the pole, its line running from the meridian the edge comes in along
   * to the one it leaves along; a walk along the edge itself counted the turn as well, or part of it, as finely as it
   * sampled there (a spline sphere's seam tilted 1e-9 rad came out 25% low). So the curve is moved by the offset from
   * the pole of its end there, and of its nearest point where it passes one, in full there and less in proportion to the
   * parameter towards the next such point or end: it reaches each pole along a meridian, with no turn. `kinks` are the
   * passes' parameters, where it turns at the pole (a walk along it breaks there). Mass integrals take the strip from
   * its feet out to the edge itself, so the shell still closes along the edge.
   */
  edgeCurve(edge: Edge): Curve {
    return this.edgeCurves(edge).curve;
  }

  /** `edgeCurve`, the edge's own curve (the same object where it is not moved), and where it passes a pole. */
  edgeCurves(edge: Edge): { curve: Curve; edge: Curve; kinks: number[] } {
    const known = this.#curves.get(edge);
    if (known) return known;
    const own = curveEvaluator(edge.curve),
      [t0, t1] = edgeParameters(edge, 1),
      reach = this.poleReach,
      poles = this.#polePoints,
      offset = (c: Curve, t: number): XYZ => {
        const p = c.at(t);
        for (const pole of poles) if (distance(p, pole) <= reach) return sub(pole, p);
        return [0, 0, 0];
      },
      zero = (o: XYZ) => o[0] === 0 && o[1] === 0 && o[2] === 0;
    let curve = own;
    const kinks: number[] = [];
    if (poles.length && t1 !== t0) {
      // Into its ends' poles first: the curve then leaves each along a meridian, and passes it no more just beside it.
      const a = offset(own, t0),
        b = offset(own, t1);
      if (!zero(a) || !zero(b)) curve = moved(own, [t0, t1], [a, b]);
      // Then each pass within reach of a pole between its ends.
      const passes = polePasses(curve, t0, t1, poles, reach);
      if (passes.length) {
        curve = moved(
          curve,
          [t0, ...passes.map((q) => q.t), t1],
          [[0, 0, 0], ...passes.map((q) => q.offset), [0, 0, 0]],
        );
        kinks.push(...passes.map((q) => q.t));
      }
    }
    const out = { curve, edge: own, kinks };
    this.#curves.set(edge, out);
    return out;
  }

  /**
   * Parameters along a curve (ascending or descending), more between them where it passes a pole of the surface nearer
   * than they lie apart. Round a pole u' turns as fast as the curve passes it is near: an edge from a vertex 0.8
   * micrometres off a 4 mm sphere's pole (just past `poleReach`) turns up to half a turn round it within about that, so
   * its samples a 128th of the edge apart left u' jumping by over a quarter turn between two (refused as a loop over the
   * pole), or by nearly half, read the wrong way round (a loop round the pole read as one beside it), and a walk's
   * nodes missed its turn. Cut in halves until each part is no longer than its distance from the pole: u' turns by
   * under 60 degrees along it, smoothly. A part that reaches a pole (within `poleReach`: into a pole vertex, or over a
   * pole, where the loop runs along its line) is not cut for it; nor past 48 halvings.
   */
  graded(curve: Curve, ts: readonly number[]): number[] {
    const poles = this.#polePoints,
      reach = this.poleReach,
      out = [ts[0]];
    if (!poles.length) return [...ts];
    const split = (a: number, pa: number[], b: number, pb: number[], depth: number) => {
      let near = Infinity;
      for (const pole of poles) near = Math.min(near, toSegment(pole, pa, pb));
      if (depth < 48 && near > reach && distance(pa, pb) > near) {
        const m = (a + b) / 2,
          pm = curve.at(m);
        split(a, pa, m, pm, depth + 1);
        split(m, pm, b, pb, depth + 1);
      } else out.push(b);
    };
    let pa = curve.at(ts[0]);
    for (let i = 0; i + 1 < ts.length; i++) {
      const pb = curve.at(ts[i + 1]);
      split(ts[i], pa, ts[i + 1], pb, 0);
      pa = pb;
    }
    return out;
  }

  /**
   * A loop through points of the surface, in order: continuous (u', v) points, running along a pole's line where it
   * passes through a pole or apex (`lines`: the first point of each such line, and the samples just before and just
   * after the line), and growing the face's box.
   */
  trace(samples: readonly XYZ[]): { loop: UVLoop; lines: { at: number; before: number; after: number }[] } {
    // Start from a sample off the poles, so each pole is reached with a u'.
    const first = Math.max(
        0,
        samples.findIndex((p) => this.poleOf(p) === undefined),
      ),
      points: UV[] = [],
      lines: { at: number; before: number; after: number }[] = [],
      uLines: number[] = [];
    let hint: UV | undefined;
    for (let j = 0; j < samples.length; j++) {
      const p = samples[(first + j) % samples.length],
        pole = hint && this.poleOf(p);
      if (pole === undefined || !hint) {
        const uv = this.near(p, hint);
        points.push(uv);
        hint = uv;
        continue;
      }
      // At a pole: along its line from the u' it arrives with to the u' of the next sample off it (at a pole where v has
      // no meaning, along u' = pole from v to v).
      let k = j + 1;
      while (k < samples.length && this.poleOf(samples[(first + k) % samples.length]) !== undefined) k++;
      const next = samples[(first + k) % samples.length];
      if ('v' in pole) {
        const out = this.lineEnd(pole.v, hint[0], this.near(next, [hint[0], pole.v])[0]);
        lines.push({
          at: points.length,
          before: (first + j - 1) % samples.length,
          after: (first + k) % samples.length,
        });
        points.push([hint[0], pole.v], [out, pole.v]);
        hint = [out, pole.v];
      } else {
        const out = this.near(next, [pole.u, hint[1]]);
        uLines.push(points.length);
        points.push([pole.u, hint[1]], [pole.u, out[1]]);
        hint = [pole.u, out[1]];
      }
      j = k - 1;
    }
    // A loop through a pole bounds a sector (wrap 0), or goes round once more where the face holds the other pole too.
    const closed = this.close(
      points,
      new Set([...lines.map((l) => l.at), ...uLines].flatMap((i) => [i, i + 1])),
      false,
    );
    for (const [u, v] of points) {
      this.box[0] = Math.min(this.box[0], u);
      this.box[1] = Math.max(this.box[1], u);
      this.box[2] = Math.min(this.box[2], v);
      this.box[3] = Math.max(this.box[3], v);
    }
    return { loop: closed, lines };
  }

  /**
   * A loop from continuous (u', v) points: how many periods it goes round, from where its start falls when reached again.
   * `onPoles` are the points of its pole lines; the face's box grows to take the points unless `grow` is false.
   */
  close(points: UV[], onPoles: ReadonlySet<number> = new Set(), grow = true): { points: UV[]; wrap: number } {
    points.forEach(([u, v], k) => {
      if (grow) {
        this.box[0] = Math.min(this.box[0], u);
        this.box[1] = Math.max(this.box[1], u);
        this.box[2] = Math.min(this.box[2], v);
        this.box[3] = Math.max(this.box[3], v);
      }
      if (onPoles.has(k)) return;
      // A loop over a pole between samples (not through one of its vertices) jumps half a turn in u between them.
      if (
        onPole(this.surface, this.flip ? -u : u, v, this.poleReach) ||
        (this.period && k && !onPoles.has(k - 1) && Math.abs(u - points[k - 1][0]) > this.period / 4)
      )
        throw new RangeError(`face ${this.face.name}: a loop over a pole between its vertices is not supported yet`);
    });
    if (!points.length || !this.period) return { points, wrap: 0 };
    const back = this.near(this.at(points[0]), points[points.length - 1]);
    if (this.surface.vPeriod && Math.abs(back[1] - points[0][1]) > this.surface.vPeriod / 2)
      throw new RangeError(
        `face ${this.face.name}: a loop goes round a torus both ways: not supported yet; move one body slightly and try again`,
      );
    return { points, wrap: Math.round((back[0] - points[0][0]) / this.period) };
  }

  /**
   * `out` moved by whole turns so a pole's line at v from `from` runs the way the face lies. The face lies below the line
   * at the high pole and above it at the low one, and on the left of the loop, so the line runs towards -u' at the high
   * pole and +u' at the low, by more than none and at most a whole turn (a loop up a seam to an apex and back down runs a
   * whole turn round it). Rounding to the nearer u' would pick a side at random for half a turn (a hemisphere cut
   * through both poles) and the wrong one beyond it.
   */
  lineEnd(v: number, from: number, out: number): number {
    if (!this.period) return out;
    const turn = v === this.surface.pole(1) ? -1 : 1,
      gap = 1e-9 * this.period;
    return out - turn * this.period * (Math.ceil((turn * (out - from) - gap) / this.period) - 1);
  }

  /**
   * The u' of the meridian along which a curve meets the pole at `hint`'s v, at its parameter t, coming from or going
   * on to parameter `toward`: the limit there, moved by whole periods next to `hint`. Where u is the angle about an axis
   * through the pole (a sphere, a cone's apex), that is the angle of the curve's tangent itself. Elsewhere, u' from two
   * short steps along the curve, extrapolated to the pole (it drifts in proportion to the step).
   */
  meridian(curve: Curve, t: number, toward: number, hint: UV): number {
    const kind = this.face.surface.kind;
    if (!this.swapped && (kind === 'sphere' || kind === 'cone')) {
      // Its tangent on the side towards `toward`: a curve taken through a pole (edgeCurve) turns there.
      const d = (curve as Moved).toward?.(t, toward) ?? curve.at(t),
        pole = this.surface.at(0, hint[1]),
        reach = (Math.sign(toward - t) * distance(pole, curve.at(toward))) / length([d[3], d[4], d[5]]);
      if (Number.isFinite(reach) && reach)
        return this.near([pole[0] + reach * d[3], pole[1] + reach * d[4], pole[2] + reach * d[5]], hint)[0];
    }
    const h = (toward - t) / 64,
      foot = (q: number[]) => this.exact(q, this.near(q.slice(0, 3) as XYZ, hint))[0],
      near = foot(curve.at(t + h)),
      far = foot(curve.at(t + 2 * h)),
      u = 2 * near - far;
    return h && Number.isFinite(u) ? u : hint[0];
  }

  /** The points of the surface's poles and apexes. */
  get polePoints(): readonly (readonly number[])[] {
    return this.#polePoints;
  }

  /** How near a pole a point is at it (`poleOf`): a ten-thousandth of the face's size. */
  get poleReach(): number {
    return Math.max(this.#miss, 1e-12) * 100;
  }

  /**
   * Whether `p` lies at a pole or apex to within a billionth of the face's size, where a foot's u' is no more than its
   * projection's rounding (an edge taken through a pole by `edgeCurve` reaches it exactly).
   */
  atPole(p: readonly number[]): boolean {
    const within = Math.max(this.#miss, 1e-12) * 1e-3;
    return this.#polePoints.some((pole) => distance(pole, p) <= within);
  }

  /** Where `p` is a pole or apex: the v of one where u has no meaning, or the u' of one where v has none. */
  poleOf(p: XYZ): { v: number } | { u: number } | undefined {
    if (!this.#poles) {
      const s = this.surface;
      this.#poles = [];
      for (const side of [1, -1] as const) {
        const v = s.pole(side),
          u = s.uPole?.(side);
        if (v !== undefined) this.#poles.push({ at: { v }, point: s.at(0, v) });
        if (u !== undefined) this.#poles.push({ at: { u: this.flip ? -u : u }, point: s.at(u, 0) });
      }
    }
    const within = Math.max(this.#miss, 1e-12) * 100;
    for (const pole of this.#poles) if (distance(pole.point, p) <= within) return pole.at;
    return undefined;
  }

  /** (u', v) of a point on the surface, its u (and v) moved by whole periods next to `hint` when given. */
  near(p: XYZ, hint?: UV): UV {
    // A spline surface checks a far hint itself (it can settle on the next turn of a helical sweep). A hint on a pole's
    // line says nothing of u there (a B-spline's search from it stays near its u): it is passed without, and u is then
    // moved by whole periods next to it as any other.
    const s = this.surface,
      poleVs = (this.#poleVs ??= [s.pole(1), s.pole(-1)]),
      atPole = hint !== undefined && (hint[1] === poleVs[0] || hint[1] === poleVs[1]),
      raw = s.parameters(p, hint && !atPole ? [this.flip ? -hint[0] : hint[0], hint[1]] : undefined);
    let u = this.flip ? -raw[0] : raw[0],
      v = raw[1];
    if (hint) {
      if (s.uPeriod) u += Math.round((hint[0] - u) / s.uPeriod) * s.uPeriod;
      if (s.vPeriod) v += Math.round((hint[1] - v) / s.vPeriod) * s.vPeriod;
    } else if (s.vPeriod) v = this.vCut + ((((v - this.vCut) % s.vPeriod) + s.vPeriod) % s.vPeriod);
    return [u, v];
  }

  /**
   * The foot uv of p to the last digits the surface's evaluation holds. A spline's projection stops once its steps move
   * the foot under a millionth of a millionth of the surface's size, and near a pole (Su almost nothing) that leaves u'
   * off by that over the distance to the pole: 1e-10 of a turn 8 micrometres from it on a 4 mm sphere. Mass integrals
   * weigh u' there by the whole meridian's integral (a seam's rates moved a sphere's volume by 3e-10, a pole's line from
   * an edge's meridian by 8e-11). Gauss-Newton steps on from it while they shrink (it converges in two), never past an
   * open parameter's end (a foot held there stays). The surface is left evaluated at the foot.
   */
  exact(p: readonly number[], uv: UV): UV {
    const s = this.surface,
      inside = (t: number, period: number, [lo, hi]: readonly [number, number]) => period > 0 || (t > lo && t < hi);
    let u = this.flip ? -uv[0] : uv[0],
      v = uv[1],
      d = s.at(u, v),
      last = Infinity;
    for (let i = 0; i < 4 && inside(u, s.uPeriod, s.uDomain) && inside(v, s.vPeriod, s.vDomain); i++) {
      const a = d[3] * d[3] + d[4] * d[4] + d[5] * d[5],
        b = d[3] * d[6] + d[4] * d[7] + d[5] * d[8],
        e = d[6] * d[6] + d[7] * d[7] + d[8] * d[8],
        det = a * e - b * b;
      if (!(Math.abs(det) > 1e-30 * (a * e + 1e-300))) break;
      // The Gauss-Newton step towards the foot of p, and its length on the surface.
      const w0 = p[0] - d[0],
        w1 = p[1] - d[1],
        w2 = p[2] - d[2],
        gu = d[3] * w0 + d[4] * w1 + d[5] * w2,
        gv = d[6] * w0 + d[7] * w1 + d[8] * w2,
        du = (gu * e - gv * b) / det,
        dv = (a * gv - b * gu) / det,
        step = Math.hypot(du * Math.sqrt(a), dv * Math.sqrt(e));
      if (!(step < last / 2) || !inside(u + du, s.uPeriod, s.uDomain) || !inside(v + dv, s.vPeriod, s.vDomain)) break;
      last = step;
      u += du;
      v += dv;
      d = s.at(u, v);
    }
    s.at(u, v);
    return [this.flip ? -u : u, v];
  }

  /** The 3D point at (u', v). */
  at(uv: UV): XYZ {
    return this.surface.at(this.flip ? -uv[0] : uv[0], uv[1]).slice(0, 3) as XYZ;
  }

  /** The face normal (out of its solid) at a point of the face. */
  normal(p: XYZ): XYZ {
    const raw = this.surface.parameters(p),
      n = this.surface.normal(raw[0], raw[1]);
    return this.sense ? n : [-n[0], -n[1], -n[2]];
  }

  /** Whether a point of the surface lies inside the face: left of every loop (a face with no loops is the whole surface). */
  contains(p: XYZ): boolean {
    if (!this.loops.length) return true;
    const [u, v] = this.near(p);
    return this.loops.every((l) => leftOf(l, this.period, u, v));
  }
}

/**
 * Signed crossings of a loop with the line up from (u, v) (at every whole-period shift of u): +1 for each crossing
 * above the point running towards -u', -1 for each running towards +u'. A counter-clockwise loop round the point
 * gives 1; a loop going once round the period gives -1 below it and 0 above.
 */
function crossings(loop: UVLoop, period: number, u: number, v: number): number {
  const pts = loop.points,
    n = pts.length;
  if (n < 2 && !loop.wrap) return 0;
  const last: UV = [pts[0][0] + loop.wrap * period, pts[0][1]];
  let lo = last[0],
    hi = last[0];
  for (const q of pts) {
    lo = Math.min(lo, q[0]);
    hi = Math.max(hi, q[0]);
  }
  // The line's whole-period copies that meet the loop. A loop round the period covers [lo, lo + |wrap| P) exactly,
  // its segments half-open on it, so u is folded into that span once: copies counted from rounded bounds missed a loop
  // that starts a rounding error past u (a seam cut through one of its vertices) by landing only on its open end.
  const xs: number[] = [];
  if (period && loop.wrap) {
    let x = lo + ((((u - lo) % period) + period) % period);
    if (x >= lo + period) x = lo;
    for (let j = 0; j < Math.abs(loop.wrap); j++) xs.push(x + j * period);
  } else {
    const k0 = period ? Math.ceil((lo - u) / period) : 0,
      k1 = period ? Math.floor((hi - u) / period) : 0;
    for (let k = k0; k <= k1; k++) xs.push(u + k * period);
  }
  let count = 0;
  for (const x of xs) {
    for (let i = 0; i < n; i++) {
      const a = pts[i],
        b = i + 1 < n ? pts[i + 1] : last;
      if ((a[0] <= x && x < b[0]) || (b[0] <= x && x < a[0])) {
        const y = a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
        if (y > v) count += b[0] < a[0] ? 1 : -1;
      }
    }
  }
  return count;
}

/** Whether (u, v) lies on the left of a loop: inside a counter-clockwise one, outside a clockwise one, on the side a loop round the period turns to. */
export function leftOf(loop: UVLoop, period: number, u: number, v: number): boolean {
  const bias = loop.wrap > 0 ? 1 : loop.wrap < 0 ? 0 : loop.slit || (loop.area ?? polygonArea(loop.points)) < 0 ? 1 : 0;
  return crossings(loop, period, u, v) + bias === 1;
}

/**
 * Whether the point just above v = `cut` lies inside the face bounded by `loops` (all at or above the cut): left of
 * every loop when none goes round in u'; else as the first loop the line up from there crosses says, the face lying
 * above a loop that runs towards +u' there and below one that runs towards -u'.
 */
function inAbove(loops: readonly UVLoop[], period: number, cut: number): boolean {
  const round = loops.find((l) => l.wrap);
  if (!round) return loops.every((l) => leftOf(l, period, loops[0].points[0][0], cut + 1e-9 * (period || 1)));
  const p = round.points,
    q = p.length > 1 ? p[1] : [p[0][0] + round.wrap * period, p[0][1]],
    u = (p[0][0] + q[0]) / 2;
  let lowest = Infinity,
    up = true;
  for (const l of loops) {
    const n = l.points.length;
    for (let i = 0; i < n; i++) {
      const a = l.points[i],
        b: UV = i + 1 < n ? l.points[i + 1] : [l.points[0][0] + l.wrap * period, l.points[0][1]];
      if (a[0] === b[0]) continue;
      const lo = Math.min(a[0], b[0]),
        hi = Math.max(a[0], b[0]);
      for (let k = period ? Math.ceil((lo - u) / period) : 0; k <= (period ? Math.floor((hi - u) / period) : 0); k++) {
        const x = u + k * period;
        if (x < lo || x >= hi) continue;
        const y = a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
        if (y < lowest) [lowest, up] = [y, b[0] > a[0]];
      }
    }
  }
  return !up;
}

/** A curve moved by `edgeCurve`: `toward(t, u)` is its point at t with its tangent on the side towards u. */
interface Moved extends Curve {
  toward(t: number, u: number): number[];
}

/** A curve moved by offsets given at ascending parameters `knots`, linear between them (and its tangent with them). */
function moved(base: Curve, knots: readonly number[], offsets: readonly XYZ[]): Moved {
  const at = (t: number, after = false) => {
    const d = base.at(t).slice();
    let k = 0;
    while (k + 2 < knots.length && (after ? t >= knots[k + 1] : t > knots[k + 1])) k++;
    const span = knots[k + 1] - knots[k],
      f = (t - knots[k]) / span,
      a = offsets[k],
      b = offsets[k + 1];
    for (let i = 0; i < 3; i++) {
      d[i] += a[i] + f * (b[i] - a[i]);
      d[i + 3] += (b[i] - a[i]) / span;
    }
    return d;
  };
  return {
    period: base.period,
    domain: base.domain,
    at: (t: number) => at(t),
    toward: (t: number, u: number) => at(t, u > t),
    parameter: (q, hint) => base.parameter(q, hint),
    sample: (from, to, deflection, turn) => base.sample(from, to, deflection, turn),
  };
}

/**
 * Where a curve passes within `reach` of a pole strictly between t0 and t1 (ascending, each pole once a pass; a curve
 * whose end lies within reach of that pole is taken into it at that end instead): the parameter of its least distance
 * there and the offset from it to the pole. Found from samples a 128th of the range apart, by golden section between
 * the neighbours of each sample no farther than they are (and near enough that the curve may come within reach there).
 */
function polePasses(
  curve: Curve,
  t0: number,
  t1: number,
  poles: readonly (readonly number[])[],
  reach: number,
): { t: number; offset: XYZ }[] {
  const n = 128,
    ts = Array.from({ length: n + 1 }, (_, i) => (i === n ? t1 : t0 + ((t1 - t0) * i) / n)),
    ps = ts.map((t) => curve.at(t)),
    out: { t: number; offset: XYZ }[] = [],
    g = (Math.sqrt(5) - 1) / 2;
  for (const pole of poles) {
    const off = (t: number) => distance(curve.at(t), pole),
      ds = ps.map((p) => distance(p, pole));
    if (ds[0] <= reach || ds[n] <= reach) continue;
    for (let i = 0; i <= n; i++) {
      if ((i > 0 && ds[i - 1] < ds[i]) || (i < n && ds[i + 1] < ds[i])) continue;
      const gap = Math.max(i > 0 ? distance(ps[i - 1], ps[i]) : 0, i < n ? distance(ps[i + 1], ps[i]) : 0);
      if (ds[i] - gap > reach) continue;
      let lo = ts[Math.max(0, i - 1)],
        hi = ts[Math.min(n, i + 1)],
        x1 = hi - g * (hi - lo),
        x2 = lo + g * (hi - lo),
        f1 = off(x1),
        f2 = off(x2);
      for (let k = 0; k < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(lo)); k++)
        if (f1 < f2) {
          hi = x2;
          x2 = x1;
          f2 = f1;
          x1 = hi - g * (hi - lo);
          f1 = off(x1);
        } else {
          lo = x1;
          x1 = x2;
          f1 = f2;
          x2 = lo + g * (hi - lo);
          f2 = off(x2);
        }
      const t = f1 < f2 ? x1 : x2;
      if (
        Math.min(f1, f2) <= reach &&
        Math.min(t - t0, t1 - t) > 1e-9 * (t1 - t0) &&
        !out.some((q) => Math.abs(q.t - t) <= 1e-9 * (t1 - t0))
      )
        out.push({ t, offset: sub(pole, curve.at(t)) as XYZ });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

/** Parameters `ts` (ascending or descending) with `breaks` among them added in order (those strictly inside). */
export function withBreaks(ts: readonly number[], breaks: readonly number[]): number[] {
  if (!breaks.length || ts.length < 2) return [...ts];
  const up = ts[ts.length - 1] >= ts[0],
    lo = Math.min(ts[0], ts[ts.length - 1]),
    hi = Math.max(ts[0], ts[ts.length - 1]);
  return [...new Set([...ts, ...breaks.filter((t) => t > lo && t < hi)])].sort((a, b) => (up ? a - b : b - a));
}

/** The distance from p to the segment from a to b. */
function toSegment(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const ab = sub(b, a),
    ap = sub(p, a),
    ll = dot(ab, ab),
    t = ll ? Math.max(0, Math.min(1, dot(ap, ab) / ll)) : 0;
  return distance(p, add(a, scale(ab, t)));
}

/** Signed area of a closed polyline (counter-clockwise positive). */
function polygonArea(points: readonly UV[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++)
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return a / 2;
}

/** The v extent of a loop. */
export function vRange(loop: UVLoop): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const q of loop.points) {
    lo = Math.min(lo, q[1]);
    hi = Math.max(hi, q[1]);
  }
  return [lo, hi];
}

/** The loop moved by whole periods in v so it starts at or above `cut` (it lies below `cut` + period when no part crosses the cut). */
export function shiftV(loop: UVLoop, cut: number, period: number): UVLoop {
  const k = Math.ceil((cut - vRange(loop)[0]) / period);
  return k ? { ...loop, points: loop.points.map(([u, v]) => [u, v + k * period] as UV) } : loop;
}

/** Middles of the stretches of a periodic coordinate that none of the ranges covers, widest first. */
export function gaps(ranges: readonly (readonly [number, number])[], period: number): number[] {
  if (!ranges.length) return [0];
  const spans = ranges
    .map(([lo, hi]) => {
      const start = lo - Math.floor(lo / period) * period;
      return [start, start + hi - lo];
    })
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let end = Math.max(spans[0][1], ...spans.map((r) => r[1] - period));
  for (let i = 1; i <= spans.length; i++) {
    const next = i < spans.length ? spans[i][0] : spans[0][0] + period;
    if (next > end) out.push([next - end, (end + next) / 2]);
    if (i < spans.length) end = Math.max(end, spans[i][1]);
  }
  return out.sort((a, b) => b[0] - a[0]).map((g) => g[1]);
}
