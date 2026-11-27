/// <reference lib="esnext.disposable" preserve="true" />
// Elastic rods: cables, mooring lines, hoses, tentacles, hair and grass blades that bend, twist and stretch, as a chain of
// rigid capsule links held to reduced coordinates (a multibody) whose joints carry the rod's elasticity as implicit springs
// solved inside the tree's direct solve (Deul, Kugelstadt, Weiler and Bender, "Direct Position-Based Solver for Stiff Rods",
// 2018; the springs as backward Euler terms of Featherstone's articulated-body pass, kernel/src/multibody.rs). A link of length
// l bends with stiffness EI / l about its two cross axes, twists with GJ / l and stretches with EA / l, which is the
// Cosserat rod's elastic energy (Kugelstadt and Schoemer, "Position and Orientation Based Cosserat Rods", 2016) taken link by
// link. Loads on the links come from a provider of the loads entry (`segmentLoads` of `@margoengine/physics/loads`: buoyancy,
// Morison's drag and inertia, vortex lift) as forces held for a step, an added mass, and a drag the tree solves with the
// springs as a damping toward the flow. Contact goes through the rigid solver: the links are capsules.
import { MargoError } from '@margoengine/math/errors';
import type { BodyOptions, PhysicsBody } from '../body.js';
import type { JointOptions, MotorOptions, PhysicsJoint } from '../joints.js';
import type { Multibody } from '../multibody.js';
import type { Physics, PhysicsAttachment } from '../physics.js';
import type { ColliderSettings } from '../shapes.js';
import type { SegmentLoad, SegmentLoads, SegmentState } from '../loads/segments.js';
import { checkVec, type Vec3 } from '../math.js';

/** Options of {@link Rod.setTarget}. */
export interface RodTargetOptions {
  /** Natural frequency of the pull toward the shape, Hz (default 1). */
  frequency?: number;
  /** Damping ratio of the pull (default 1, critical: the rod settles on the shape without overshoot). */
  damping?: number;
}

/** Which end of a rod. */
export type RodEnd = 'start' | 'end';

/** Options of `new Rod(physics, options)`. Every field but the centre line has a default. */
export interface RodOptions {
  /** The rod's rest centre line, two or more points from its start to its end; a bent line gives the rod a rest curvature. */
  points?: readonly Vec3[];
  /** The first end, with `end`, for a straight rod (instead of `points`). */
  start?: Vec3;
  /** The second end of a straight rod. */
  end?: Vec3;
  /** Number of links (default 24). More bend more smoothly; a link should be longer than the rod is thick. */
  segments?: number;
  /** Radius in metres (default 0.01). */
  radius?: number;
  /** Density in kg/m^3 (default 1140, nylon). */
  density?: number;
  /** Young's modulus in pascals (default 3e9, nylon); bending and stretching stiffness follow from it and the section. */
  youngModulus?: number;
  /** Shear modulus in pascals (default E / (2 (1 + 0.4)), a Poisson ratio of 0.4); twisting stiffness follows from it. */
  shearModulus?: number;
  /** Bending stiffness EI in N m^2 (default E pi r^4 / 4); overrides what `youngModulus` gives. */
  bendStiffness?: number;
  /** Twisting stiffness GJ in N m^2 (default G pi r^4 / 2). */
  twistStiffness?: number;
  /** Axial stiffness EA in newtons (default E pi r^2); `Infinity` makes the rod inextensible. */
  axialStiffness?: number;
  /** Damping time in seconds: each spring is damped by this times its stiffness (default 0.005, a little material damping). */
  damping?: number;
  /** Hold the start to this body (at the start point) or to a fixed point (`'fixed'`); default free. */
  attachStart?: PhysicsBody | 'fixed';
  /** Hold the end to this body (at the end point) or to a fixed point (`'fixed'`); default free. */
  attachEnd?: PhysicsBody | 'fixed';
  /**
   * The ends that are clamped, holding their direction as well as their place (default none: pinned ends, free to turn).
   * A clamp to `'fixed'` at the start is solved with the rod's own springs; any other clamp is a joint spring of its own.
   */
  clamp?: 'start' | 'end' | 'both' | 'none';
  /**
   * The loads on its links, before each step: `segmentLoads(sea)` of `@margoengine/physics/loads` for the water (buoyancy,
   * Morison's drag and inertia, vortex lift), or any {@link SegmentLoads} (default none).
   */
  loads?: SegmentLoads;
  /** Let links of the rod touch one another (default false). */
  selfContacts?: boolean;
  /** Seconds on the loads' clock at the world's step 0 (default 0); the clock then runs with the world's steps. */
  time?: number;
  /** Material, group and event settings for every link collider (its density is the rod's). */
  collider?: Omit<ColliderSettings, 'offset' | 'rotation' | 'density' | 'mass' | 'massProperties'>;
  /** Extra body options for every link (CCD, user data). */
  body?: Omit<BodyOptions, 'type' | 'position' | 'rotation' | 'colliders'>;
}

type V = [number, number, number];
type Q = [number, number, number, number];

const UP: V = [0, 1, 0];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: readonly number[], s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const length = (a: readonly number[]): number => Math.hypot(a[0], a[1], a[2]);
const mul = (a: readonly number[], b: readonly number[]): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conj = (q: readonly number[]): Q => [-q[0], -q[1], -q[2], q[3]];
/** `q` turning `v`. */
const rotate = (q: readonly number[], v: readonly number[]): V => {
  const t = scale(cross(q, v), 2);
  const u = cross(q, t);
  return [v[0] + q[3] * t[0] + u[0], v[1] + q[3] * t[1] + u[1], v[2] + q[3] * t[2] + u[2]];
};
/** The shortest turn taking unit `a` onto unit `b`. */
function arc(a: readonly number[], b: readonly number[]): Q {
  const d = dot(a, b);
  if (d < -0.999999) {
    // Half a turn about any axis across `a`.
    const axis = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
    const n = length(axis);
    return [axis[0] / n, axis[1] / n, axis[2] / n, 0];
  }
  const c = cross(a, b),
    w = 1 + d,
    n = Math.hypot(c[0], c[1], c[2], w);
  return [c[0] / n, c[1] / n, c[2] / n, w / n];
}

/** The centre line resampled into `n` links of equal length along it. */
function resample(points: readonly Vec3[], n: number): V[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + length(sub(points[i], points[i - 1])));
  const total = lengths[lengths.length - 1],
    out: V[] = [];
  let at = 1;
  for (let k = 0; k <= n; k++) {
    const s = (total * k) / n;
    while (at < points.length - 1 && lengths[at] < s) at++;
    const span = lengths[at] - lengths[at - 1],
      t = span > 0 ? (s - lengths[at - 1]) / span : 0,
      a = points[at - 1],
      b = points[at];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/** A rod input that cannot be used: code `unsupported`, the message naming the input and its fix, and the help link. */
function invalidRod(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#rods`);
}

/** A positive finite number or the default. */
function positive(value: number | undefined, fallback: number, label: string, unit: string): number {
  if (value === undefined) return fallback;
  if (!(value > 0) || !Number.isFinite(value))
    throw invalidRod(`Rod ${label} must be a positive finite number of ${unit}.`);
  return value;
}

/**
 * An elastic rod: `new Rod(physics, {points, radius, youngModulus})`. Its links are capsules held to reduced coordinates as one
 * multibody, so the rod neither stretches past its springs nor comes apart, and its bending, twisting and stretching are
 * springs solved together with the tree, stable at any stiffness and any number of links. With `loads:
 * segmentLoads(sea)` (`@margoengine/physics/loads`) it floats or sinks, is pushed by currents and waves, and strums in a
 * cross flow. Import it from `@margoengine/physics/rod`; it is removed with the world.
 */
export class Rod implements PhysicsAttachment {
  /** The link bodies, from the start to the end. */
  readonly segments: PhysicsBody[] = [];
  /** The multibody that holds the links. */
  readonly multibody: Multibody;
  /** Length of one link in metres, at rest. */
  readonly segmentLength: number;
  /** Bending, twisting and axial stiffness in N m^2, N m^2 and N. */
  readonly stiffness: { readonly bend: number; readonly twist: number; readonly axial: number };
  private readonly ends: Record<RodEnd, { joint: PhysicsJoint | null; anchor: PhysicsBody | null }> = {
    start: { joint: null, anchor: null },
    end: { joint: null, anchor: null },
  };
  private readonly root: PhysicsBody | null = null;
  private readonly radius: number;
  /** The springs' damping time, s. */
  private readonly damping: number;
  private readonly loads?: SegmentLoads;
  private readonly time: number;
  /** What the loads provider reads of each link, and writes for it, reused every step. */
  private readonly states: {
    position: [number, number, number];
    tangent: [number, number, number];
    velocity: [number, number, number];
    angularVelocity: [number, number, number];
    diameter: number;
    length: number;
  }[] = [];
  private readonly out: SegmentLoad[] = [];
  /** Per link, the force and torque the water put on for the step, taken off after it. */
  private readonly held6: Float64Array;
  /** The target shape's link centres (xyz each), its angular frequency and damping ratio; null for none. */
  private target: Float64Array | null = null;
  private targetOmega = 0;
  private targetZeta = 1;
  private removed = false;

  /**
   * @param physics The world to add the rod to.
   * @param options The centre line, section, material, ends and water.
   * @throws RangeError for a centre line of fewer than two distinct points or a value out of range.
   */
  constructor(
    private readonly owner: Physics,
    options: RodOptions,
  ) {
    if (typeof owner?.addBody !== 'function' || owner.isDisposed)
      throw invalidRod('A rod needs a live Physics world: new Rod(physics, {points}).');
    const line = options?.points ?? (options?.start && options.end ? [options.start, options.end] : undefined);
    if (!line || line.length < 2)
      throw invalidRod('A rod needs its centre line: pass points (two or more) or start and end.');
    line.forEach((p, i) => checkVec(p, `Rod point ${i}`));
    const segments = options.segments ?? 24;
    if (!Number.isInteger(segments) || segments < 2 || segments > 4096)
      throw invalidRod('Rod segments must be an integer from 2 to 4096; a rod bends between its links.');
    const radius = positive(options.radius, 0.01, 'radius', 'metres'),
      density = positive(options.density, 1140, 'density', 'kg/m^3'),
      young = positive(options.youngModulus, 3e9, 'youngModulus', 'pascals'),
      shear = positive(options.shearModulus, young / 2.8, 'shearModulus', 'pascals'),
      area = Math.PI * radius * radius,
      second = (Math.PI * radius ** 4) / 4,
      bend = positive(options.bendStiffness, young * second, 'bendStiffness', 'N m^2'),
      twist = positive(options.twistStiffness, shear * 2 * second, 'twistStiffness', 'N m^2'),
      axial =
        options.axialStiffness === Infinity
          ? Infinity
          : positive(options.axialStiffness, young * area, 'axialStiffness', 'N'),
      damping = options.damping ?? 0.005;
    if (!(damping >= 0) || !Number.isFinite(damping)) throw invalidRod('Rod damping must be 0 or more seconds.');
    const nodes = resample(line, segments),
      l = length(sub(nodes[1], nodes[0]));
    if (!(l > 0)) throw invalidRod('Rod points must not all be the same; pass a centre line with a length.');
    this.segmentLength = l;
    this.radius = radius;
    this.damping = damping;
    this.stiffness = { bend, twist, axial };
    this.loads = options.loads;
    if (this.loads !== undefined && typeof this.loads?.apply !== 'function')
      throw invalidRod(
        'Rod loads are a provider with apply(segments, context, out); pass segmentLoads(sea) from @margoengine/physics/loads.',
      );
    this.loads?.prepare?.(segments);
    this.time = options.time ?? 0;
    if (!Number.isFinite(this.time)) throw invalidRod('Rod time must be a finite number of seconds; pass one, or 0.');
    for (let i = 0; i < segments; i++) {
      this.states.push({
        position: [0, 0, 0],
        tangent: [0, 1, 0],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        diameter: 2 * radius,
        length: 0,
      });
      this.out.push({
        force: [0, 0, 0],
        moment: [0, 0, 0],
        drag: { across: 0, along: 0, flow: [0, 0, 0], at: [0, 0, 0] },
        addedMass: 0,
        addedInertia: 0,
      });
    }
    this.held6 = new Float64Array(segments * 6);
    const clamp = options.clamp ?? 'none',
      clampStart = clamp === 'start' || clamp === 'both',
      clampEnd = clamp === 'end' || clamp === 'both';
    // Each link's frame: +Y along the link, carried from link to link by the least turn, so a straight rod has no twist.
    const frames: Q[] = [];
    for (let i = 0; i < segments; i++) {
      const d = scale(sub(nodes[i + 1], nodes[i]), 1 / length(sub(nodes[i + 1], nodes[i])));
      frames.push(i === 0 ? arc(UP, d) : mul(arc(rotate(frames[i - 1], UP), d), frames[i - 1]));
    }
    const half = l / 2,
      capsuleHalf = Math.max(half - radius, half * 0.25),
      capsuleRadius = Math.min(radius, half),
      mass = density * area * l,
      // A solid rod's link: its mass where its length is, so a link of any thickness carries the rod's own mass and inertia.
      transverse = (mass * l * l) / 12 + (mass * radius * radius) / 4,
      spring = (k: number): MotorOptions => ({ targetPosition: 0, stiffness: k, damping: damping * k, model: 'force' });
    const rootFixed = clampStart && options.attachStart === 'fixed';
    try {
      for (let i = 0; i < segments; i++) {
        const c = scale(
          [nodes[i][0] + nodes[i + 1][0], nodes[i][1] + nodes[i + 1][1], nodes[i][2] + nodes[i + 1][2]],
          0.5,
        );
        this.segments.push(
          owner.addBody(null, {
            linearDamping: 0,
            angularDamping: 0,
            ...options.body,
            type: 'dynamic',
            position: c,
            rotation: frames[i],
            colliders: {
              ...options.collider,
              shape: 'capsule',
              halfHeight: capsuleHalf,
              radius: capsuleRadius,
              massProperties: {
                mass,
                centerOfMass: [0, 0, 0],
                principalInertia: [transverse, (mass * radius * radius) / 2, transverse],
              },
            },
          }),
        );
      }
      // The joint from link i - 1 to link i: its frame on the parent is the rest turn between them, so the rest shape is the
      // springs' zero; the links' ends stay together except along the link, where the rod stretches.
      const link = (parentFrame: Q, childFrame: Q, anchorA: Vec3, factor: number): JointOptions => ({
        type: 'generic',
        anchorA,
        anchorB: [0, -half, 0],
        frameA: mul(conj(parentFrame), childFrame),
        locked: axial === Infinity ? ['linX', 'linY', 'linZ'] : ['linX', 'linZ'],
        motors: {
          ...(axial === Infinity ? {} : { linY: spring((factor * axial) / l) }),
          angX: spring((factor * bend) / l),
          angY: spring((factor * twist) / l),
          angZ: spring((factor * bend) / l),
        },
      });
      let root: PhysicsBody, first: number;
      if (rootFixed) {
        // A fixed anchor of the rod's own as the tree's root, the clamp a joint of the tree with half a link's springs.
        root = owner.addBody(null, { type: 'fixed', position: nodes[0], colliders: [] });
        this.ends.start.anchor = root;
        first = 0;
      } else {
        root = this.segments[0];
        first = 1;
      }
      this.root = root;
      const links = [];
      for (let i = first; i < segments; i++) {
        const parent = i === 0 ? root : this.segments[i - 1],
          parentFrame: Q = i === 0 ? [0, 0, 0, 1] : frames[i - 1],
          anchorA: Vec3 = i === 0 ? [0, 0, 0] : [0, half, 0];
        links.push({ body: this.segments[i], parent, joint: link(parentFrame, frames[i], anchorA, i === 0 ? 2 : 1) });
      }
      this.multibody = owner.addMultibody(root, links);
      this.multibody.setImplicitMotors(links.map((entry) => entry.body));
      this.multibody.selfContacts = options.selfContacts ?? false;
      if (rootFixed) this.ends.start.joint = this.multibody.links[0].joint;
      if (!rootFixed) this.hold('start', options.attachStart, nodes[0], [0, -half, 0], frames[0], clampStart);
      this.hold('end', options.attachEnd, nodes[segments], [0, half, 0], frames[segments - 1], clampEnd);
    } catch (error) {
      this.releaseAll();
      throw error;
    }
    owner.attach(this);
  }

  /** Holds an end to a body or a fixed point, pinned or clamped (a joint of its own, solved in the joint passes). */
  private hold(
    end: RodEnd,
    target: PhysicsBody | 'fixed' | undefined,
    point: Vec3,
    anchor: Vec3,
    frame: Q,
    clamp: boolean,
  ): void {
    if (target === undefined) return;
    let body: PhysicsBody;
    if (target === 'fixed') {
      body = this.owner.addBody(null, { type: 'fixed', position: point, colliders: [] });
      this.ends[end].anchor = body;
    } else {
      if (!target?.valid)
        throw new MargoError('state', 'Rod attachment body was removed; pass a body from physics.addBody.');
      body = target;
    }
    const p = body.position,
      r = body.rotation,
      local = rotate(conj(r), sub(point, p)),
      link = end === 'start' ? this.segments[0] : this.segments[this.segments.length - 1];
    const { bend, twist } = this.stiffness,
      l = this.segmentLength;
    const joint = this.owner.addJoint(body, link, {
      type: 'spherical',
      anchorA: local,
      anchorB: anchor,
    });
    if (clamp)
      // The rest turn of the link in the body's frame; half a link bends here, so twice a link's springs. One joint, so the
      // joint passes hold it as the implicit spring of its two bodies.
      joint.setRotationMotor(mul(conj(r), frame), {
        stiffness: (2 * Math.max(bend, twist)) / l,
        damping: 0,
        model: 'force',
      });
    // The pin is held in the tree's solve with the rod's springs, so a rod pulled taut between two pins stays closed at them.
    // Its half link stretches along the link as the rest of the rod does, twice a link's axial spring.
    const { axial } = this.stiffness,
      give = axial === Infinity ? undefined : { stiffness: (2 * axial) / l, damping: (this.damping * 2 * axial) / l };
    this.multibody.pinJoint(joint, true, give);
    this.ends[end].joint = joint;
  }

  /**
   * Blends the rod toward a shape, for direction: a tentacle reaching, a vine curling to a mark, a hose laid along a path.
   * Each link is pulled toward its place on `points` (resampled along their length to the rod's links, start to end) by a
   * spring of natural `frequency` and `damping` ratio on the link's own mass, `m (w^2 (x_target - x) - 2 zeta w v)`, so the
   * rod moves there as a mass on such a spring does, with its own bending and the loads and contacts acting as well. The
   * force is held over a step, so `2 pi frequency` times the step is held to 0.5 or less, and `damping` to what the step can
   * take. `null` lets go.
   * @throws MargoError (code `unsupported`) for fewer than two points, a shape of no length, or a frequency or damping out of
   * range, naming the bound.
   */
  setTarget(points: readonly Vec3[] | null, options: RodTargetOptions = {}): this {
    this.check();
    if (points === null) {
      this.target = null;
      return this;
    }
    if (!Array.isArray(points) || points.length < 2)
      throw invalidRod(
        'A rod target is two or more points of the shape to blend toward, or null to let go; pass them.',
      );
    for (const point of points) checkVec(point, 'Rod target point');
    const dt = this.owner.fixedTimestep,
      { frequency = 1, damping = 1 } = options,
      most = 0.5 / (2 * Math.PI * dt);
    if (!(frequency > 0 && frequency <= most))
      throw invalidRod(
        `A rod target's frequency is above 0 and at most ${most.toFixed(2)} Hz at this world's step (got ${frequency}); pass one in range.`,
      );
    const omega = 2 * Math.PI * frequency;
    if (!(damping >= 0 && 2 * damping * omega * dt <= 1))
      throw invalidRod(
        `A rod target's damping is 0 or more and at most ${(1 / (2 * omega * dt)).toFixed(2)} at this frequency and step (got ${damping}); pass one in range.`,
      );
    const n = this.segments.length,
      nodes = resample(points, n),
      centres = new Float64Array(3 * n);
    if (!(length(sub(nodes[n]!, nodes[0]!)) > 0 || nodes.some((node) => length(sub(node, nodes[0]!)) > 0)))
      throw invalidRod('A rod target has no length: its points are all one; pass a shape along the rod.');
    for (let i = 0; i < n; i++)
      for (let a = 0; a < 3; a++) centres[3 * i + a] = (nodes[i]![a]! + nodes[i + 1]![a]!) / 2;
    this.target = centres;
    this.targetOmega = omega;
    this.targetZeta = damping;
    for (const body of this.segments) if (body.sleeping) body.wakeUp();
    return this;
  }

  /** The target's springs on each link for the step, added to what `held6` holds. */
  private applyTarget(): void {
    const target = this.target!,
      held = this.held6,
      w = this.targetOmega,
      stiff = w * w,
      damp = 2 * this.targetZeta * w;
    for (let i = 0; i < this.segments.length; i++) {
      const body = this.segments[i]!;
      if (!body.valid) continue;
      const m = body.mass,
        c = body.worldCenterOfMass,
        v = body.linearVelocity,
        force: V = [0, 0, 0];
      for (let a = 0; a < 3; a++) force[a] = m * (stiff * (target[3 * i + a]! - c[a]!) - damp * v[a]!);
      held[6 * i] += force[0];
      held[6 * i + 1] += force[1];
      held[6 * i + 2] += force[2];
      body.addForce(force, undefined, true);
    }
  }

  /** False after `remove()`. */
  get valid(): boolean {
    return !this.removed;
  }

  /** True while the end is held to a body or a fixed point. */
  held(end: RodEnd): boolean {
    return this.ends[end]?.joint?.valid === true;
  }

  /**
   * Lets an end go, as a mooring line is cast off: its joint (and the fixed point the rod made for it) is removed and the end
   * moves free. A start clamped to `'fixed'` is the tree's root and cannot be let go: hold such a rod with a pin instead.
   * @throws MargoError (`state`) for a start that is the rod's own root.
   */
  release(end: RodEnd): this {
    this.check();
    if (end !== 'start' && end !== 'end') throw invalidRod(`A rod end is 'start' or 'end'; got ${String(end)}.`);
    const held = this.ends[end];
    if (end === 'start' && held.anchor && held.anchor === this.root)
      throw new MargoError(
        'state',
        'This rod is clamped to its own fixed root at the start; create it with clamp "end" or a pin to let it go.',
      );
    if (held.joint?.valid) held.joint.remove();
    if (held.anchor?.valid) this.owner.removeBody(held.anchor);
    held.joint = null;
    held.anchor = null;
    for (const body of this.segments) body.wakeUp();
    return this;
  }

  private releaseAll(): void {
    for (const body of this.segments) if (body.valid) this.owner.removeBody(body);
    for (const side of ['start', 'end'] as const) {
      const anchor = this.ends[side].anchor;
      if (anchor?.valid) this.owner.removeBody(anchor);
    }
    this.segments.length = 0;
  }

  /**
   * The rod's centre line as `segments + 1` packed xyz points from start to end, at the last step. Writes into `out` when
   * given (length `(segments + 1) * 3`), so a per-frame update allocates nothing.
   */
  points(out: Float32Array = new Float32Array((this.segments.length + 1) * 3)): Float32Array {
    this.check();
    if (out.length < (this.segments.length + 1) * 3)
      throw invalidRod('Rod points buffer is too short; pass a Float32Array of (segments + 1) * 3 numbers.');
    const half = this.segmentLength / 2;
    for (let i = 0; i < this.segments.length; i++) {
      const body = this.segments[i],
        p = body.position,
        u = rotate(body.rotation, UP);
      if (i === 0) {
        out[0] = p[0] - u[0] * half;
        out[1] = p[1] - u[1] * half;
        out[2] = p[2] - u[2] * half;
      }
      out[(i + 1) * 3] = p[0] + u[0] * half;
      out[(i + 1) * 3 + 1] = p[1] + u[1] * half;
      out[(i + 1) * 3 + 2] = p[2] + u[2] * half;
    }
    return out;
  }

  /**
   * Each link's rotation as packed xyzw quaternions, +Y along the link: the rod's material frames, for a mesh that twists
   * with it. Writes into `out` when given (length `segments * 4`).
   */
  frames(out: Float32Array = new Float32Array(this.segments.length * 4)): Float32Array {
    this.check();
    if (out.length < this.segments.length * 4)
      throw invalidRod('Rod frames buffer is too short; pass a Float32Array of segments * 4 numbers.');
    this.segments.forEach((body, i) => out.set(body.rotation, i * 4));
    return out;
  }

  /**
   * @internal The loads on every link for the coming step, from the `loads` provider: its forces held for every substep,
   * its added mass on the link (with that water's weight cancelled), and its drag as a damping toward the flow that the
   * tree solves implicitly with the rod's springs (kernel FLOW_X and DRAG_ACROSS).
   */
  beforeStep(dt: number): void {
    if (this.removed) return;
    if (this.loads) this.applyLoads(this.loads, dt);
    if (this.target) this.applyTarget();
  }

  /** The loads provider's forces on each link for the step, held in `held6` for `afterStep` to take off. */
  private applyLoads(loads: SegmentLoads, dt: number): void {
    const g = this.owner.gravity,
      columns = this.owner.kernel.columns,
      l = this.segmentLength;
    for (let i = 0; i < this.segments.length; i++) {
      const body = this.segments[i]!,
        state = this.states[i]!,
        c = body.worldCenterOfMass;
      state.position[0] = c[0];
      state.position[1] = c[1];
      state.position[2] = c[2];
      const axis = rotate(body.rotation, UP);
      state.tangent[0] = axis[0];
      state.tangent[1] = axis[1];
      state.tangent[2] = axis[2];
      const v = body.linearVelocity,
        w = body.angularVelocity;
      state.velocity[0] = v[0];
      state.velocity[1] = v[1];
      state.velocity[2] = v[2];
      state.angularVelocity[0] = w[0];
      state.angularVelocity[1] = w[1];
      state.angularVelocity[2] = w[2];
      state.length = l;
    }
    loads.apply(
      this.states as readonly SegmentState[],
      { time: this.time + this.owner.kernel.steps * dt, dt, gravity: g },
      this.out,
    );
    const held = this.held6;
    for (let i = 0; i < this.segments.length; i++) {
      const body = this.segments[i]!,
        load = this.out[i]!,
        row = body.row;
      if (!body.valid || body.sleeping) continue;
      const added = load.addedMass;
      // The added mass rides with the link: the water it must move as it moves, on its mass (all three ways; along the link
      // the chain carries it) and its turn across.
      body.setAdditionalMass(added, [load.addedInertia, 0, load.addedInertia]);
      const drag = load.drag,
        local = rotate(conj(body.rotation), sub(drag.at, body.position));
      columns.flowX[row] = drag.flow[0];
      columns.flowY[row] = drag.flow[1];
      columns.flowZ[row] = drag.flow[2];
      columns.dragAcross[row] = drag.across;
      columns.dragAlong[row] = drag.along;
      columns.dragAtX[row] = local[0];
      columns.dragAtY[row] = local[1];
      columns.dragAtZ[row] = local[2];
      // As forces for the whole step, every substep, as gravity is: the water's push and the link's weight then cancel
      // substep by substep (an impulse at the step's start against gravity in each substep left a still rod a speed of its
      // own, and the drag that speed met bent it 1.6 % too far). The added mass is water, not weight: the world's gravity
      // pulls on all of a body's mass, so its share is pushed back up at the centre of mass (on a standing rod that weight
      // squeezed it along its length and bent it 1.7 % further in a current). `afterStep` takes off what was put on.
      const total: V = [load.force[0] - added * g[0], load.force[1] - added * g[1], load.force[2] - added * g[2]];
      held.set(total, i * 6);
      held.set(load.moment, i * 6 + 3);
      body.addForce(total, undefined, false);
      body.addTorque(load.moment, false);
    }
  }

  /**
   * The rod's state beyond the world's: its loads provider's (each link's wake oscillator and last speed for
   * `segmentLoads`). `physics.takeSnapshot()` holds the links; take this beside it, and give both back, for a restored world
   * to step on to the same bits. Empty without a provider or one with no state.
   */
  takeState(): Float64Array {
    this.check();
    return this.loads?.takeState?.() ?? new Float64Array(0);
  }
  /**
   * Puts back what {@link Rod.takeState} took.
   * @throws RangeError for a malformed state, or the loads provider's coded error for its own incompatible state.
   */
  restoreState(state: Float64Array): this {
    this.check();
    if (!(state instanceof Float64Array))
      throw invalidRod("A rod state is the Float64Array this rod's takeState() gave; pass that one.");
    if (this.loads?.restoreState) this.loads.restoreState(state);
    else if (state.length !== 0)
      throw invalidRod("A rod state is the Float64Array this rod's takeState() gave; pass that one.");
    return this;
  }

  /** @internal Takes off the water's forces of the step just taken. */
  afterStep(): void {
    if (this.removed) return;
    const held = this.held6;
    for (let i = 0; i < this.segments.length; i++) {
      const k = i * 6;
      if (
        held[k] === 0 &&
        held[k + 1] === 0 &&
        held[k + 2] === 0 &&
        held[k + 3] === 0 &&
        held[k + 4] === 0 &&
        held[k + 5] === 0
      )
        continue;
      const body = this.segments[i];
      if (body.valid) {
        body.addForce([-held[k], -held[k + 1], -held[k + 2]], undefined, false);
        body.addTorque([-held[k + 3], -held[k + 4], -held[k + 5]], false);
      }
      held.fill(0, k, k + 6);
    }
  }

  private check(): void {
    if (this.removed)
      throw new MargoError('state', 'Rod was removed; create a new one with new Rod(physics, options).');
  }

  /** Removes every link, joint and fixed point of the rod. Attached bodies stay. */
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.multibody?.valid) this.multibody.remove();
    this.releaseAll();
    this.owner.detach(this);
  }
  /** Same as `remove()`; the world calls it when it is disposed. */
  dispose(): void {
    this.remove();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.remove();
  }
}
