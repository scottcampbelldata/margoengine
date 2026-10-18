// A face in its surface's (u, v) parameters, for splitting faces and telling inside from outside: loops sampled into
// (u, v) polylines, continuous across a periodic surface's seam (a loop round a cylinder runs a whole period in u),
// with u mirrored when the face normal opposes the surface's, so the face always lies left of its loops. Inside is
// decided loop by loop, by signed crossings of a line up from the point, which works for loops round a cylinder or a
// sphere's pole as well as for closed ones.
import type { Surface } from '../geometry/surfaces.js';
import type { V3 } from '../geometry/vec.js';
import { curveEvaluator, surfaceEvaluator } from './geometry.js';
import type { Edge, Face } from './topology.js';
import { edgeParameters } from './validate.js';

export type UV = [number, number];

/** A closed loop in (u', v): points in order, the last joined back to the first moved by `wrap` periods in u'. */
export interface UVLoop {
  readonly points: UV[];
  /** Whole periods the loop goes round in u' (a loop round a cylinder: 1 or -1). */
  readonly wrap: number;
}

/** Samples per edge in (u, v): a line maps to a straight line on the surfaces Booleans take; a curve takes enough points to follow its turn. */
export const edgeSamples = (edge: Edge) => (edge.curve.kind === 'line' ? 1 : 128);

export class FaceUV {
  readonly surface: Surface;
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

  constructor(readonly face: Face) {
    this.surface = surfaceEvaluator(face.surface);
    this.flip = !face.sense;
    this.period = this.surface.uPeriod;
    for (const loop of face.loops) {
      const points: UV[] = [];
      let hint: UV | undefined;
      for (const c of loop.coedges) {
        const ts = edgeParameters(c.edge, edgeSamples(c.edge));
        if (!c.forward) ts.reverse();
        const curve = curveEvaluator(c.edge.curve);
        for (let k = 0; k < ts.length - 1; k++) {
          const uv = this.near(curve.at(ts[k]).slice(0, 3) as V3, hint);
          points.push(uv);
          hint = uv;
        }
      }
      this.loops.push(this.close(points));
    }
    const vPeriod = this.surface.vPeriod;
    if (vPeriod && this.loops.length) {
      // The cut is a circle round the tube that no loop crosses, so it lies wholly inside or wholly outside the face.
      const cut = gaps(
        this.loops.map((l) => vRange(l)),
        vPeriod,
      ).find((g) => {
        const shifted = this.loops.map((l) => shiftV(l, g, vPeriod));
        return !shifted.every((l) => leftOf(l, this.period, shifted[0].points[0][0], g + 1e-9 * vPeriod));
      });
      if (cut === undefined)
        throw new RangeError(`face ${this.face.name}: it goes all the way round a torus's tube: not supported yet`);
      this.vCut = cut;
      this.loops.forEach((l, i) => {
        this.loops[i] = shiftV(l, cut, vPeriod);
      });
      this.box[2] = Math.min(...this.loops.map((l) => vRange(l)[0]));
      this.box[3] = Math.max(...this.loops.map((l) => vRange(l)[1]));
    }
  }

  /** A loop from continuous (u', v) points: how many periods it goes round, from where its start falls when reached again. */
  close(points: UV[]): UVLoop {
    points.forEach(([u, v], k) => {
      this.box[0] = Math.min(this.box[0], u);
      this.box[1] = Math.max(this.box[1], u);
      this.box[2] = Math.min(this.box[2], v);
      this.box[3] = Math.max(this.box[3], v);
      // A loop over a pole jumps half a turn in u between neighbouring samples.
      if (
        this.surface.singular(this.flip ? -u : u, v) ||
        (this.period && k && Math.abs(u - points[k - 1][0]) > this.period / 4)
      )
        throw new RangeError(`face ${this.face.name}: a loop through a pole or apex is not supported yet`);
    });
    if (!points.length || !this.period) return { points, wrap: 0 };
    const back = this.near(this.at(points[0]), points[points.length - 1]);
    if (this.surface.vPeriod && Math.abs(back[1] - points[0][1]) > this.surface.vPeriod / 2)
      throw new RangeError(`face ${this.face.name}: a loop round a torus's tube is not supported yet`);
    return { points, wrap: Math.round((back[0] - points[0][0]) / this.period) };
  }

  /** (u', v) of a point on the surface, its u (and v) moved by whole periods next to `hint` when given. */
  near(p: V3, hint?: UV): UV {
    const s = this.surface,
      raw = s.parameters(p, hint ? [this.flip ? -hint[0] : hint[0], hint[1]] : undefined);
    let u = this.flip ? -raw[0] : raw[0],
      v = raw[1];
    if (hint) {
      if (s.uPeriod) u += Math.round((hint[0] - u) / s.uPeriod) * s.uPeriod;
      if (s.vPeriod) v += Math.round((hint[1] - v) / s.vPeriod) * s.vPeriod;
    } else if (s.vPeriod) v = this.vCut + ((((v - this.vCut) % s.vPeriod) + s.vPeriod) % s.vPeriod);
    return [u, v];
  }

  /** The 3D point at (u', v). */
  at(uv: UV): V3 {
    return this.surface.at(this.flip ? -uv[0] : uv[0], uv[1]).slice(0, 3) as V3;
  }

  /** The face normal (out of its solid) at a point of the face. */
  normal(p: V3): V3 {
    const raw = this.surface.parameters(p),
      n = this.surface.normal(raw[0], raw[1]);
    return this.face.sense ? n : [-n[0], -n[1], -n[2]];
  }

  /** Whether a point of the surface lies inside the face: left of every loop (a face with no loops is the whole surface). */
  contains(p: V3): boolean {
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
export function crossings(loop: UVLoop, period: number, u: number, v: number): number {
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
  const k0 = period ? Math.ceil((lo - u) / period) : 0,
    k1 = period ? Math.floor((hi - u) / period) : 0;
  let count = 0;
  for (let k = k0; k <= k1; k++) {
    const x = u + k * period;
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
  const bias = loop.wrap > 0 ? 1 : loop.wrap < 0 ? 0 : polygonArea(loop.points) < 0 ? 1 : 0;
  return crossings(loop, period, u, v) + bias === 1;
}

/** Signed area of a closed polyline (counter-clockwise positive). */
export function polygonArea(points: readonly UV[]): number {
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
  return k ? { points: loop.points.map(([u, v]) => [u, v + k * period] as UV), wrap: loop.wrap } : loop;
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
