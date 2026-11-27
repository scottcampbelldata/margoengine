// A rope wrapped over fixed cylinders (bollards, pulleys, fairleads), with capstan friction on each wrap.
//
// Clean room, after the Eulerian-on-Lagrangian strands of Sueda, Jones, Levin and Pai ("Large-scale dynamic simulation of
// highly constrained strands", ACM TOG 30(4), 2011): the rope's material slides through the wrap, so the wrap is a place
// on the cylinder, not a set of contacts that come and go. Its mass sits in nodes (Lagrangian, each a material point of the
// rope), and between two nodes the rope runs straight, or straight onto a cylinder, round it and straight off. Their
// paper takes the wrap frictionless or without slip and leaves finite friction to future work; the capstan law here is our
// own derivation on that frame:
//
// - The length of the path from node A to node B over a wrap, the two tangent spans plus the arc, has the gradient u_A at A
//   and u_B at B, the unit vectors from the tangent points to the nodes (a tangent length plus its arc grows as the node
//   moves along the span: the rope winds and unwinds as it must).
// - Held (static friction), the rope does not slide over the cylinder: each side keeps the material it has, measured to a
//   material point fixed on the cylinder, and pulls its node with its own tension.
// - Sliding, the path keeps its whole length, and the tension rises across the wrap by the capstan ratio: T_high =
//   T_low e^(mu phi), phi the wrap's angle (Euler 1762, Eytelwein 1808). It holds while T_B / T_A lies within e^(-+mu phi).
//
// The constraints are solved as impulses on the nodes' velocities, a step at a time, with Baumgarte's push on the length.
// For a rope over one wrap with two hanging masses, one step reproduces the capstan Atwood machine exactly:
// a = g (m2 - k m1) / (m2 + k m1), k = e^(mu phi).
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { atan2, cos, exp, hypot, sin } from '@margoengine/math/pinned';

function invalid(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#rods`);
}

/** A mass of the rope: a material point of it, with the rope's own mass near it and any load hung on it. */
export interface WrappedRopeNode {
  /** Where it starts, m. */
  readonly position: Vec3;
  /** Its mass, kg (a load hung on the rope, or the rope's own share). Ignored when `fixed`. */
  readonly mass?: number;
  /** Held where it is (a cleat, a mooring point); its position can be driven with `setNodePosition`. */
  readonly fixed?: boolean;
}

/** A fixed cylinder the rope runs over between two nodes. */
export interface WrappedRopeWrap {
  /** A point on the cylinder's axis, m. */
  readonly center: Vec3;
  /** The cylinder's axis; the rope runs across it, in the plane through `center` square to it. */
  readonly axis: Vec3;
  /** Radius to the rope's centreline (the cylinder's radius plus the rope's), m. */
  readonly radius: number;
  /** Friction coefficient between rope and cylinder (default 0: a frictionless pulley). */
  readonly friction?: number;
  /** Which way round the rope goes, seen down the axis: 1 counter-clockwise from the first node to the second, -1 clockwise. */
  readonly turn: 1 | -1;
}

/** Options of `new WrappedRope(options)`. */
export interface WrappedRopeOptions {
  /** The rope's masses in order along it, two or more. */
  readonly nodes: readonly WrappedRopeNode[];
  /** For each pair of neighbouring nodes, the cylinder the rope runs over between them, or null for a straight span. */
  readonly wraps?: readonly (WrappedRopeWrap | null)[];
  /** Gravity, m/s^2 (default [0, -9.81, 0]). */
  readonly gravity?: Vec3;
  /** Solver passes a step (default 8). */
  readonly passes?: number;
}

type V = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const scale = (a: readonly number[], s: number): V => [a[0]! * s, a[1]! * s, a[2]! * s];
const add = (a: readonly number[], b: readonly number[]): V => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a));

/** A wrap's plane: its centre, the axis, and two unit vectors e1, e2 square to it with e1 x e2 = axis. */
interface Frame {
  c: V;
  n: V;
  e1: V;
  e2: V;
  r: number;
  mu: number;
  turn: 1 | -1;
  /** The material angle fixed on the cylinder the held sides are measured to. */
  anchor: number;
}

/** Where a point's span meets the circle, its angle there and the span's length; the point outside the circle. */
function tangent(f: Frame, p: V, side: 1 | -1): { angle: number; length: number; at: V } {
  const d = sub(p, f.c),
    x = dot(d, f.e1),
    y = dot(d, f.e2),
    q = hypot(x, y);
  if (!(q > f.r))
    throw new MargoError('state', 'A wrapped rope node went inside its cylinder; keep its nodes outside it.');
  const length = Math.sqrt(q * q - f.r * f.r),
    // The angle at the centre between the point and its tangent point: acos(r / q), written as atan2 of the span and r.
    beta = atan2(length, f.r),
    angle = atan2(y, x) + side * beta,
    at = add(f.c, add(scale(f.e1, f.r * cos(angle)), scale(f.e2, f.r * sin(angle))));
  return { angle, length, at };
}

/** The signed sweep from angle a to angle b the `turn` way round, in [0, 2 pi). */
function sweep(a: number, b: number, turn: 1 | -1): number {
  let s = turn * (b - a);
  const tau = 2 * Math.PI;
  s -= tau * Math.floor(s / tau);
  return s;
}

/**
 * A rope over fixed cylinders with capstan friction, its mass in nodes: mooring lines over fairleads, a block and tackle,
 * a rope over a bollard, a winch's line. Step it with `step(dt)`; read `position(i)`, `velocity(i)` and `tension(i)`.
 * @throws MargoError (code `unsupported`) for fewer than two nodes, a wrap list of the wrong length, a mass, radius or
 * friction out of range, or a node inside its cylinder.
 */
export class WrappedRope {
  private readonly x: V[];
  private readonly v: V[];
  private readonly w: number[];
  private readonly frames: (Frame | null)[];
  /** Each span's material length: a straight span's length, or for a wrap its two sides' to the anchor. */
  private readonly rest: [number, number][];
  private readonly held: boolean[];
  private readonly tensions: [number, number][];
  private readonly gravity: V;
  private readonly passes: number;

  constructor(options: WrappedRopeOptions) {
    const nodes = options?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2) throw invalid('A wrapped rope needs two or more nodes; pass them.');
    const spans = nodes.length - 1,
      wraps = options.wraps ?? [];
    if (wraps.length !== 0 && wraps.length !== spans)
      throw invalid(
        `A wrapped rope's wraps list has one entry per span (${spans}), each a wrap or null; pass that many.`,
      );
    this.x = nodes.map((node) => [node.position[0], node.position[1], node.position[2]] as V);
    this.v = nodes.map(() => [0, 0, 0] as V);
    this.w = nodes.map((node) => {
      if (node.fixed) return 0;
      const m = node.mass ?? 0;
      if (!(m > 0 && Number.isFinite(m)))
        throw invalid('A wrapped rope node that moves has a mass above 0 kg; pass one.');
      return 1 / m;
    });
    this.gravity = (options.gravity ?? [0, -9.81, 0]).slice(0, 3) as V;
    this.passes = options.passes ?? 8;
    this.frames = [];
    this.rest = [];
    this.held = [];
    this.tensions = [];
    for (let i = 0; i < spans; i++) {
      const wrap = wraps[i] ?? null;
      if (wrap === null) {
        this.frames.push(null);
        this.rest.push([norm(sub(this.x[i + 1]!, this.x[i]!)), 0]);
      } else {
        const a = wrap.axis,
          len = norm(a);
        if (!(len > 0) || !(wrap.radius > 0) || !((wrap.friction ?? 0) >= 0))
          throw invalid('A wrap has an axis, a radius above 0 and a friction of 0 or more; pass them.');
        const n = scale(a, 1 / len),
          seed: V = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
          e1 = scale(cross(seed, n), 1 / norm(cross(seed, n))),
          e2 = cross(n, e1);
        const f: Frame = {
          c: [wrap.center[0], wrap.center[1], wrap.center[2]],
          n,
          e1,
          e2,
          r: wrap.radius,
          mu: wrap.friction ?? 0,
          turn: wrap.turn,
          anchor: 0,
        };
        // The anchor: the arc's middle at the start.
        const ta = tangent(f, this.x[i]!, f.turn),
          tb = tangent(f, this.x[i + 1]!, -f.turn as 1 | -1);
        f.anchor = ta.angle + (f.turn * sweep(ta.angle, tb.angle, f.turn)) / 2;
        this.frames.push(f);
        this.rest.push(this.sides(i));
      }
      this.held.push(true);
      this.tensions.push([0, 0]);
    }
  }

  /** A wrapped span's two sides now: each node's span plus its arc to the anchor, and the gradients u_A and u_B. */
  private geometry(i: number): { a: number; b: number; uA: V; uB: V; phi: number } {
    const f = this.frames[i]!,
      ta = tangent(f, this.x[i]!, f.turn),
      tb = tangent(f, this.x[i + 1]!, -f.turn as 1 | -1),
      armA = f.r * sweep(ta.angle, f.anchor, f.turn),
      armB = f.r * sweep(f.anchor, tb.angle, f.turn),
      uA = scale(sub(this.x[i]!, ta.at), 1 / ta.length),
      uB = scale(sub(this.x[i + 1]!, tb.at), 1 / tb.length);
    return { a: ta.length + armA, b: tb.length + armB, uA, uB, phi: sweep(ta.angle, tb.angle, f.turn) };
  }

  private sides(i: number): [number, number] {
    const g = this.geometry(i);
    return [g.a, g.b];
  }

  /** Advances the rope by `dt` seconds. */
  step(dt: number): void {
    if (!(dt > 0 && Number.isFinite(dt))) throw invalid('A wrapped rope steps by a finite time above 0 s; pass one.');
    const { x, v, w, gravity } = this,
      beta = 0.2 / dt;
    for (let k = 0; k < x.length; k++) if (w[k]! > 0) v[k] = add(v[k]!, scale(gravity, dt));
    for (let i = 0; i < this.tensions.length; i++) this.tensions[i] = [0, 0];
    for (let pass = 0; pass < this.passes; pass++) {
      for (let i = 0; i < this.frames.length; i++) {
        const f = this.frames[i],
          [wa, wb] = [w[i]!, w[i + 1]!];
        if (f === null) {
          // A straight span: it may go slack, never longer than its rope.
          const d = sub(x[i + 1]!, x[i]!),
            l = norm(d);
          if (!(l > 0) || wa + wb === 0) continue;
          const u = scale(d, 1 / l),
            gap = l - this.rest[i]![0],
            rate = dot(u, sub(v[i + 1]!, v[i]!)) + (gap > 0 ? beta * gap : 0),
            total = this.tensions[i]![0],
            next = Math.max(0, total + rate / (wa + wb)),
            j = next - total;
          this.tensions[i] = [next, next];
          v[i] = add(v[i]!, scale(u, j * wa));
          v[i + 1] = sub(v[i + 1]!, scale(u, j * wb));
          continue;
        }
        const g = this.geometry(i),
          [ra, rb] = this.rest[i]!,
          [ta0, tb0] = this.tensions[i]!,
          k = exp(f.mu * g.phi);
        // Rates of stretch on each side, with Baumgarte's push on a side longer than its rope; impulses T pull each node
        // along -u toward the cylinder, accumulated over the passes (never pushing: a slack rope pulls nothing).
        const rateA = dot(g.uA, v[i]!) + (g.a > ra ? beta * (g.a - ra) : 0),
          rateB = dot(g.uB, v[i + 1]!) + (g.b > rb ? beta * (g.b - rb) : 0);
        let tA: number, tB: number, holds: boolean;
        if (wa === 0 || wb === 0) {
          // A fixed node (a cleat, a winch) on one side. Its side holds whatever the other side's load needs, so the wrap
          // holds and the cleat carries the load over the capstan ratio; but a winch drawing its side past its rope makes
          // the rope slide toward it, its side then at k times the other.
          const fixedA = wa === 0,
            stretched = fixedA ? g.a > ra : g.b > rb;
          const [moving, w0, t0, rateMoving] = fixedA ? [i + 1, wb, tb0, rateB] : [i, wa, ta0, rateA];
          let tMoving: number;
          if (stretched && w0 > 0) {
            const total = dot(g.uA, v[i]!) + dot(g.uB, v[i + 1]!) + beta * Math.max(0, g.a + g.b - ra - rb);
            tMoving = Math.max(0, t0 + total / w0);
            holds = false;
          } else {
            tMoving = w0 > 0 ? Math.max(0, t0 + rateMoving / w0) : 0;
            holds = true;
          }
          void moving;
          const tFixed = holds ? tMoving / k : tMoving * k;
          [tA, tB] = fixedA ? [tFixed, tMoving] : [tMoving, tFixed];
        } else {
          // Held: each side on its own. It holds while the two tensions are within the capstan ratio.
          tA = Math.max(0, ta0 + rateA / wa);
          tB = Math.max(0, tb0 + rateB / wb);
          holds = tB <= k * tA * (1 + 1e-12) && tA <= k * tB * (1 + 1e-12);
          if (!holds) {
            // Sliding: one length, T_B = ratio T_A, ratio = k toward the higher side (1 on a frictionless wrap):
            // rate_A + rate_B - (T_A - T_A0) w_A - (ratio T_A - T_B0) w_B = 0.
            const ratio = tB > tA ? k : 1 / k,
              rate =
                rateA +
                rateB -
                (g.a > ra ? beta * (g.a - ra) : 0) -
                (g.b > rb ? beta * (g.b - rb) : 0) +
                (g.a + g.b > ra + rb ? beta * (g.a + g.b - ra - rb) : 0);
            tA = Math.max(0, (rate + ta0 * wa + tb0 * wb) / (wa + ratio * wb));
            tB = ratio * tA;
          }
        }
        v[i] = sub(v[i]!, scale(g.uA, (tA - ta0) * wa));
        v[i + 1] = sub(v[i + 1]!, scale(g.uB, (tB - tb0) * wb));
        this.tensions[i] = [tA, tB];
        this.held[i] = holds;
      }
    }
    for (let k = 0; k < x.length; k++) if (w[k]! > 0) x[k] = add(x[k]!, scale(v[k]!, dt));
    // A slid wrap's anchor comes along: its sides keep the material they now have, its whole length kept.
    for (let i = 0; i < this.frames.length; i++)
      if (this.frames[i] && !this.held[i]) {
        const [a, b] = this.sides(i),
          total = this.rest[i]![0] + this.rest[i]![1];
        this.rest[i] = [a, total - a];
        void b;
      }
    for (let i = 0; i < this.tensions.length; i++)
      this.tensions[i] = [this.tensions[i]![0] / dt, this.tensions[i]![1] / dt];
  }

  /** Node `i`'s position, m. */
  position(i: number): Vec3 {
    return [...this.x[i]!] as unknown as Vec3;
  }
  /** Node `i`'s velocity, m/s. */
  velocity(i: number): Vec3 {
    return [...this.v[i]!] as unknown as Vec3;
  }
  /** Span `i`'s tension in the last step at its first and its second node, N (equal on a straight span). */
  tension(i: number): readonly [number, number] {
    return this.tensions[i]!;
  }
  /** True when span `i`'s wrap held in the last step (static friction), false when the rope slid over it. */
  holding(i: number): boolean {
    return this.held[i]!;
  }
  /** Drives a fixed node to a position (a winch, a cleat on a moving boat). */
  setNodePosition(i: number, position: Vec3): void {
    if (this.w[i] !== 0) throw invalid('Only a fixed node of a wrapped rope is driven; fix it with fixed: true.');
    this.x[i] = [position[0], position[1], position[2]];
  }
}
