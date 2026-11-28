// The wrapped rope as a solver of the physics framework: rope ends and wraps on rigid bodies that move and turn (a mooring
// line on a ship's bollard, a winch's drum on a deck), the rope's tension handed to those bodies as held forces
// (`bodyForces`) and their motion read back from `bodies`. The rope's model is `WrappedRope`'s (wrapped.ts): mass in nodes,
// wraps that the material slides through, capstan friction on each. What changes on a body is that each side's stretch is
// measured against the drum's surface where the span leaves it, u . (v_node - v_drum(T)) (on a turning drum the node's
// velocity about the axis adds nothing along u, as (A - T) is along u), and that each pull on a node is matched by its
// reaction on the drum at the tangent point, so momentum and angular momentum pass between rope and bodies whole and a
// drum's torque from friction, R (T_high - T_low), comes out of the two pulls.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { exp } from '@margoengine/math/pinned';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { atContact, impulseAt } from '../crush/rigid-contact.js';
import {
  RATE_LEVELS,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, FORCE_WORDS } from '../world/solvers/rigid.js';
import { type Frame, sweep, tangent } from './wrapped.js';

function invalid(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#rods`);
}

type V = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add = (a: readonly number[], b: readonly number[]): V => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const scale = (a: readonly number[], s: number): V => [a[0]! * s, a[1]! * s, a[2]! * s];
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a));

/** A rope node: a free mass of the rope, or a point fixed on a rigid body (the body is its mass). */
export type WrappedRopeSolverNode =
  | { readonly position: Vec3; readonly mass: number; readonly velocity?: Vec3 }
  | { readonly body: number; readonly point?: Vec3 };

/** A cylinder the rope runs over between two nodes: on a rigid body (its frame) or fixed in the world. */
export interface WrappedRopeSolverWrap {
  /** The rigid body row that carries it (a ship, a winch's drum); fixed in the world when left out. */
  readonly body?: number;
  /** A point on its axis, in the body's frame (from its origin), or the world's. */
  readonly center: Vec3;
  /** Its axis, in the body's frame or the world's. */
  readonly axis: Vec3;
  /** Radius to the rope's centreline, m. */
  readonly radius: number;
  /** Friction coefficient between rope and cylinder (default 0). */
  readonly friction?: number;
  /** Which way round the rope goes from the first node to the second, seen down the axis: 1 counter-clockwise, -1 clockwise. */
  readonly turn: 1 | -1;
}

/**
 * What a wrapped-rope solver is made from: the ordered rope nodes, for each span the cylinder it wraps (or
 * null), solver passes a step (default 8) and the rate level (default 0, 60 Hz).
 */
export interface WrappedRopeSolverParams {
  /** The rope's nodes in order along it, two or more. */
  readonly nodes: readonly WrappedRopeSolverNode[];
  /** For each span, the cylinder it runs over, or null for a straight span. */
  readonly wraps?: readonly (WrappedRopeSolverWrap | null)[];
  /** Solver passes a step (default 8). */
  readonly passes?: number;
  /** Match the RigidSolver's rate level (default 0, 60 Hz). */
  readonly rate?: RateLevel;
}

interface Node {
  readonly free: boolean;
  readonly w: number;
  readonly row: number;
  readonly point: V;
}
interface Wrap {
  readonly row: number;
  readonly center: V;
  readonly axis: V;
  readonly e1: V;
  readonly e2: V;
  readonly r: number;
  readonly mu: number;
  readonly turn: 1 | -1;
}

// State words: each node x, v (six f64); each span rest A, rest B, tension A, tension B, held, anchor (six f64).
const NODE_WORDS = 6;
const SPAN_WORDS = 6;

/**
 * A rope wrapped over cylinders on rigid bodies, with capstan friction, coupled both ways to the rigid world: add it to a
 * `PhysicsWorld` beside `RigidSolver` and couple them (`world.couple(['wrappedRope', 'rigid'], 'staggered')`).
 * @throws MargoError (code `unsupported`) for fewer than two nodes, a wrap list of the wrong length, a body row the world
 * lacks, or a mass, radius or friction out of range.
 */
export class WrappedRopeSolver implements Solver<WrappedRopeSolverParams> {
  private host?: SolverHost;
  private state?: Region;
  private spans?: Region;
  private forces?: Region;
  private nodes: Node[] = [];
  private wraps: (Wrap | null)[] = [];
  private passes = 8;
  private rate: RateLevel = 0;

  constructor(readonly id = 'wrappedRope') {}

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => this.rate,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost, params: WrappedRopeSolverParams): void {
    const nodes = params?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2) throw invalid('A wrapped rope needs two or more nodes; pass them.');
    const spans = nodes.length - 1,
      wraps = params.wraps ?? [];
    if (wraps.length !== 0 && wraps.length !== spans)
      throw invalid(
        `A wrapped rope's wraps list has one entry per span (${spans}), each a wrap or null; pass that many.`,
      );
    const rate = params.rate ?? 0;
    if (!Number.isInteger(rate) || rate < 0 || rate >= RATE_LEVELS)
      throw invalid('Choose a wrapped rope rate level from 0 to 7 that matches the rigid solver.');
    const rows = host.bodyRows();
    const rowOf = (row: number) => {
      if (!Number.isSafeInteger(row) || row < 0 || row >= rows)
        throw invalid(`A wrapped rope's body row ${row} is not one of the world's ${rows}; pass a body's row.`);
      return row;
    };
    this.nodes = nodes.map((node) => {
      if ('body' in node) {
        const p = node.point ?? [0, 0, 0];
        return {
          free: false,
          w: 0,
          row: rowOf(node.body),
          point: [p[0], p[1], p[2]] as V,
        };
      }
      if (!(node.mass > 0 && Number.isFinite(node.mass)))
        throw invalid('A free wrapped rope node has a mass above 0 kg; pass one.');
      if (![...node.position, ...(node.velocity ?? [0, 0, 0])].every(Number.isFinite))
        throw invalid("A free wrapped rope node's position and velocity are finite; pass finite numbers.");
      return { free: true, w: 1 / node.mass, row: -1, point: [0, 0, 0] as V };
    });
    this.wraps = Array.from({ length: spans }, (_, i) => {
      const wrap = wraps[i] ?? null;
      if (wrap === null) return null;
      const len = norm(wrap.axis);
      if (!(len > 0) || !(wrap.radius > 0) || !((wrap.friction ?? 0) >= 0))
        throw invalid('A wrap has an axis, a radius above 0 and a friction of 0 or more; pass them.');
      const n = scale(wrap.axis, 1 / len),
        seed: V = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
        c = cross(seed, n),
        e1 = scale(c, 1 / norm(c));
      return {
        row: wrap.body === undefined ? -1 : rowOf(wrap.body),
        center: [wrap.center[0], wrap.center[1], wrap.center[2]],
        axis: n,
        e1,
        e2: cross(n, e1),
        r: wrap.radius,
        mu: wrap.friction ?? 0,
        turn: wrap.turn,
      } as Wrap;
    });
    this.passes = params.passes ?? 8;
    this.rate = rate as RateLevel;
    this.state = host.allocate('wrappedRopeNodes', nodes.length * NODE_WORDS * 8, 'f64', 1);
    // The spans' words, then one word that is 1 once the first step has taken the rests (state, so a seek restores it).
    this.spans = host.allocate('wrappedRopeSpans', (spans * SPAN_WORDS + 1) * 8, 'f64', 1);
    this.forces = host.allocate('wrappedRopeForces', rows * FORCE_WORDS * 8, 'f64', 1);
    this.host = host;
    const state = this.words(this.state);
    nodes.forEach((node, k) => {
      if ('body' in node) return;
      const v = node.velocity ?? [0, 0, 0];
      state.set([node.position[0], node.position[1], node.position[2], v[0], v[1], v[2]], k * NODE_WORDS);
    });
  }

  private words(region: Region | undefined): Float64Array {
    if (!region || !this.host) throw new MargoError('state', 'Add the wrapped rope to a PhysicsWorld before using it.');
    return new Float64Array(this.host.memory.buffer, region.byteOffset, region.byteLength / 8);
  }

  /** A body's frame: its origin, rotation (xyzw), from the bodies record. */
  private pose(bodies: Float32Array, row: number): { o: V; q: [number, number, number, number] } {
    const at = row * BODY_WORDS;
    return {
      o: [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!],
      q: [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!],
    };
  }

  private frame(bodies: Float32Array, wrap: Wrap, anchor: number): Frame {
    if (wrap.row < 0)
      return {
        c: wrap.center,
        n: wrap.axis,
        e1: wrap.e1,
        e2: wrap.e2,
        r: wrap.r,
        mu: wrap.mu,
        turn: wrap.turn,
        anchor,
      };
    const { o, q } = this.pose(bodies, wrap.row),
      turnBy = (v: V) => rotateByQuaternion<V>(v, q);
    return {
      c: add(o, turnBy(wrap.center)),
      n: turnBy(wrap.axis),
      e1: turnBy(wrap.e1),
      e2: turnBy(wrap.e2),
      r: wrap.r,
      mu: wrap.mu,
      turn: wrap.turn,
      anchor,
    };
  }

  step({ inputs }: StepContext, dt: number): void {
    const host = this.host!,
      source = inputs.get(BODIES_FIELD.name)?.region,
      forces = this.words(this.forces),
      rows = forces.length / FORCE_WORDS;
    if (!source || source.type !== 'f32' || source.byteLength / (4 * BODY_WORDS) !== rows)
      throw new MargoError(
        'state',
        'You must couple the wrapped rope with a RigidSolver whose bodies field matches its body rows.',
      );
    const bodies = new Float32Array((source.memory ?? host.memory).buffer, source.byteOffset, source.byteLength / 4),
      state = this.words(this.state),
      spans = this.words(this.spans),
      applied = new Float64Array(rows * 6),
      g = host.gravity,
      beta = 0.2 / dt,
      // Rest lengths and anchors are taken from the first step's geometry, where the body poses are first known.
      starting = spans[spans.length - 1] === 0;
    // The bodies' gravity this step, which the rigid solver adds: staged first, so the rope meets the speeds the step ends with.
    for (let row = 0; row < rows; row++) {
      const at = row * BODY_WORDS,
        inverse = bodies[at + 16]!;
      if (inverse > 0 && bodies[at + 23]! !== 0)
        applied.set([(g[0] * dt) / inverse, (g[1] * dt) / inverse, (g[2] * dt) / inverse], row * 6);
    }
    const gravityStaged = applied.slice();
    // Node positions and velocities, read from the state or the bodies.
    const position = (k: number): V => {
      const node = this.nodes[k]!;
      if (node.free) return [state[k * NODE_WORDS]!, state[k * NODE_WORDS + 1]!, state[k * NODE_WORDS + 2]!];
      const { o, q } = this.pose(bodies, node.row);
      return add(o, rotateByQuaternion<V>(node.point, q));
    };
    for (let k = 0; k < this.nodes.length; k++)
      if (this.nodes[k]!.free) for (let a = 0; a < 3; a++) state[k * NODE_WORDS + 3 + a]! += g[a]! * dt;
    const at = this.nodes.map((_, k) => position(k));
    // A node's velocity along u and its inverse mass there; a pull of T along -u on it.
    const nodeSpeed = (k: number, u: V): { v: number; w: number; arm: V } => {
      const node = this.nodes[k]!;
      if (node.free)
        return {
          v: dot(u, [state[k * NODE_WORDS + 3]!, state[k * NODE_WORDS + 4]!, state[k * NODE_WORDS + 5]!]),
          w: node.w,
          arm: [0, 0, 0],
        };
      const contact = atContact(bodies, applied, node.row, at[k] as never, u as never);
      return {
        v: dot(u, contact.velocity as unknown as V),
        w: contact.inverseMass,
        arm: contact.arm as unknown as V,
      };
    };
    const pullNode = (k: number, u: V, t: number, arm: V) => {
      const node = this.nodes[k]!;
      if (node.free) for (let a = 0; a < 3; a++) state[k * NODE_WORDS + 3 + a]! -= u[a]! * t * node.w;
      else impulseAt(applied, node.row, scale(u, -t) as never, arm as never);
    };
    // A wrap's drum at a tangent point: its surface velocity along u, inverse mass there, and the reaction of a pull.
    const drum = (wrap: Wrap, p: V, u: V): { v: number; w: number; arm: V } => {
      if (wrap.row < 0) return { v: 0, w: 0, arm: [0, 0, 0] };
      const contact = atContact(bodies, applied, wrap.row, p as never, u as never);
      return {
        v: dot(u, contact.velocity as unknown as V),
        w: contact.inverseMass,
        arm: contact.arm as unknown as V,
      };
    };
    const geometry = (i: number) => {
      const wrap = this.wraps[i]!,
        f = this.frame(bodies, wrap, spans[i * SPAN_WORDS + 5]!),
        ta = tangent(f, at[i]!, f.turn),
        tb = tangent(f, at[i + 1]!, -f.turn as 1 | -1);
      const armA = f.r * sweep(ta.angle, f.anchor, f.turn),
        armB = f.r * sweep(f.anchor, tb.angle, f.turn);
      return {
        f,
        a: ta.length + armA,
        b: tb.length + armB,
        uA: scale(sub(at[i]!, ta.at), 1 / ta.length),
        uB: scale(sub(at[i + 1]!, tb.at), 1 / tb.length),
        pA: ta.at,
        pB: tb.at,
        phi: sweep(ta.angle, tb.angle, f.turn),
        angleA: ta.angle,
      };
    };
    // Each wrap's anchor, the point of the drum its two sides' material is counted to, is put back at the middle of the arc
    // the rope touches, the shift moved from one side's rest to the other's: on a turning drum it would otherwise leave the
    // arc. The first step takes the rests from the geometry; after a step that slid, the sides keep the material they now
    // have, the whole length kept. Done here, where the bodies and the free nodes stand at the same time.
    for (let i = 0; i < this.wraps.length; i++) {
      const o = i * SPAN_WORDS;
      if (this.wraps[i] === null) {
        if (starting) spans[o] = norm(sub(at[i + 1]!, at[i]!));
        continue;
      }
      const geo = geometry(i),
        centre = geo.angleA + (geo.f.turn * geo.phi) / 2;
      if (starting) {
        spans[o + 5] = centre;
        const fresh = geometry(i);
        spans.set([fresh.a, fresh.b, 0, 0, 1, centre], o);
        continue;
      }
      if (spans[o + 4] === 0) {
        // Slid: side A has what it spans now, to the arc's middle; side B the rest.
        const total = spans[o]! + spans[o + 1]!;
        spans[o] = geo.a - geo.f.r * sweep(geo.angleA, geo.f.anchor, geo.f.turn) + (geo.f.r * geo.phi) / 2;
        spans[o + 1] = total - spans[o]!;
      } else {
        // Held: the anchor turned with the drum; the shift back to the middle (less than half a turn a step) moves material
        // from one side's count to the other's.
        let shift = centre - spans[o + 5]!;
        shift -= 2 * Math.PI * Math.round(shift / (2 * Math.PI));
        spans[o] += geo.f.r * geo.f.turn * shift;
        spans[o + 1] -= geo.f.r * geo.f.turn * shift;
      }
      spans[o + 5] = centre;
    }
    spans[spans.length - 1] = 1;
    for (let i = 0; i < this.wraps.length; i++) spans.fill(0, i * SPAN_WORDS + 2, i * SPAN_WORDS + 4);
    for (let pass = 0; pass < this.passes; pass++) {
      for (let i = 0; i < this.wraps.length; i++) {
        const o = i * SPAN_WORDS,
          wrap = this.wraps[i];
        if (wrap === null) {
          const d = sub(at[i + 1]!, at[i]!),
            l = norm(d);
          if (!(l > 0)) continue;
          const u = scale(d, 1 / l),
            first = nodeSpeed(i, scale(u, -1)),
            second = nodeSpeed(i + 1, u),
            w = first.w + second.w;
          if (w === 0) continue;
          const gap = l - spans[o]!,
            rate = first.v + second.v + (gap > 0 ? beta * gap : 0),
            t0 = spans[o + 2]!,
            t = Math.max(0, t0 + rate / w);
          pullNode(i, scale(u, -1), t - t0, first.arm);
          pullNode(i + 1, u, t - t0, second.arm);
          spans[o + 2] = spans[o + 3] = t;
          continue;
        }
        const geo = geometry(i),
          [ra, rb, ta0, tb0] = [spans[o]!, spans[o + 1]!, spans[o + 2]!, spans[o + 3]!],
          k = exp(geo.f.mu * geo.phi);
        const nA = nodeSpeed(i, geo.uA),
          nB = nodeSpeed(i + 1, geo.uB),
          dA = drum(wrap, geo.pA, geo.uA),
          dB = drum(wrap, geo.pB, geo.uB);
        const wa = nA.w + dA.w,
          wb = nB.w + dB.w,
          rateA = nA.v - dA.v + (geo.a > ra ? beta * (geo.a - ra) : 0),
          rateB = nB.v - dB.v + (geo.b > rb ? beta * (geo.b - rb) : 0);
        let tA: number, tB: number, holds: boolean;
        if (wa === 0 || wb === 0) {
          const fixedA = wa === 0,
            stretched = fixedA ? geo.a > ra : geo.b > rb,
            [w0, t0, rate0] = fixedA ? [wb, tb0, rateB] : [wa, ta0, rateA];
          let tMoving: number;
          if (stretched && w0 > 0) {
            tMoving = Math.max(0, t0 + (rateA + rateB) / w0);
            holds = false;
          } else {
            tMoving = w0 > 0 ? Math.max(0, t0 + rate0 / w0) : 0;
            holds = true;
          }
          const tFixed = holds ? tMoving / k : tMoving * k;
          [tA, tB] = fixedA ? [tFixed, tMoving] : [tMoving, tFixed];
        } else {
          tA = Math.max(0, ta0 + rateA / wa);
          tB = Math.max(0, tb0 + rateB / wb);
          holds = tB <= k * tA * (1 + 1e-12) && tA <= k * tB * (1 + 1e-12);
          if (!holds) {
            const ratio = tB > tA ? k : 1 / k,
              rate = nA.v - dA.v + nB.v - dB.v + Math.max(0, beta * (geo.a + geo.b - ra - rb));
            tA = Math.max(0, (rate + ta0 * wa + tb0 * wb) / (wa + ratio * wb));
            tB = ratio * tA;
          }
        }
        pullNode(i, geo.uA, tA - ta0, nA.arm);
        pullNode(i + 1, geo.uB, tB - tb0, nB.arm);
        if (wrap.row >= 0) {
          impulseAt(applied, wrap.row, scale(geo.uA, tA - ta0) as never, dA.arm as never);
          impulseAt(applied, wrap.row, scale(geo.uB, tB - tb0) as never, dB.arm as never);
        }
        spans.set([ra, rb, tA, tB, holds ? 1 : 0], o);
      }
    }
    for (let k = 0; k < this.nodes.length; k++)
      if (this.nodes[k]!.free)
        for (let a = 0; a < 3; a++) state[k * NODE_WORDS + a]! += state[k * NODE_WORDS + 3 + a]! * dt;
    for (let i = 0; i < this.wraps.length; i++) {
      const o = i * SPAN_WORDS;
      spans[o + 2]! /= dt;
      spans[o + 3]! /= dt;
    }
    // The rope's pulls on the bodies, less the gravity staged for them, held over the step as forces.
    for (let row = 0; row < rows; row++)
      for (let a = 0; a < 6; a++)
        forces[row * FORCE_WORDS + a] = (applied[row * 6 + a]! - gravityStaged[row * 6 + a]!) / dt;
  }

  /** Free node `k`'s position and velocity as of the last step (a node on a body moves with its body: read the body). */
  read(k: number): { position: Vec3; velocity: Vec3 } {
    const node = this.nodes[k];
    if (!node?.free) throw invalid('Read a free wrapped rope node by its index; a node on a body moves with the body.');
    const state = this.words(this.state),
      o = k * NODE_WORDS;
    return {
      position: [state[o]!, state[o + 1]!, state[o + 2]!],
      velocity: [state[o + 3]!, state[o + 4]!, state[o + 5]!],
    };
  }
  /** Span `i`'s tension in the last step at its first and second node, N. */
  tension(i: number): readonly [number, number] {
    const spans = this.words(this.spans);
    return [spans[i * SPAN_WORDS + 2]!, spans[i * SPAN_WORDS + 3]!];
  }
  /** True when span `i`'s wrap held in the last step. */
  holding(i: number): boolean {
    return this.words(this.spans)[i * SPAN_WORDS + 4] !== 0;
  }

  exportPorts(tick: number): readonly Port[] {
    return this.forces
      ? [
          {
            field: BODY_FORCES_FIELD.name,
            region: this.forces,
            tick,
            cell: [0, 0, 0],
          },
        ]
      : [];
  }
  importPorts(): void {}
  stateRegions(): readonly Region[] {
    return this.state && this.spans ? [this.state, this.spans] : [];
  }
  extraState(): readonly Region[] {
    return [];
  }
}
