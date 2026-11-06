// Spring bones and jiggle: secondary motion for hair, tails, cloth strips and accessories with no physics world. A
// chain follows the scheme of the VRMC_springBone 1.0 specification (VRM Consortium): each bone's tail is a point moved
// by Verlet integration under inertia, stiffness toward the animated direction and gravity, held at the bone's length
// and pushed out of sphere and capsule colliders; the bone then turns to face its tail. Two things go beyond the
// specification's reference. The tail follows the animated pose, not the rest pose, so a clip keeps its say. And the
// step is time-corrected: the specification's numbers are per frame at 60 Hz, here they are that rate's forces and decay
// at any frame rate, so the same character swings the same at 30, 60 or 144 frames a second.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import {
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import type { Animator } from '@margoengine/animator';
import type { Mesh } from '@margoengine/core/extension';

/** How one bone of a chain moves; the numbers mean what VRMC_springBone's joint fields mean. */
export interface SpringSettings {
  /** Pull back toward the animated direction, 0 or more (default 1). */
  stiffness?: number;
  /** Share of the speed lost each 1/60 s, 0 to 1 (default 0.5). */
  drag?: number;
  /** Strength of gravity on the tail (default 0: hair settles on the animated pose). */
  gravity?: number;
  /** World direction of gravity (default straight down, [0, -1, 0]); need not be unit length. */
  gravityDirection?: Vec3;
  /** Radius of the tail against colliders, world units at scale 1 (default 0). */
  radius?: number;
}

/** One chain of swinging bones. */
export interface SpringChain extends SpringSettings {
  /**
   * Bones from the first to the last (glTF node indices with {@link addSpringBones}), each an ancestor of the next;
   * bones left out between two joints ride along. The last joint is only a tail and does not turn, unless `tail` is
   * set. At most 256.
   */
  joints: readonly number[];
  /** Settings of single joints, by position in `joints`, over the chain's own. */
  settings?: readonly (SpringSettings | undefined)[];
  /**
   * End point past the last joint, in that joint's local space, so the last joint turns too. A single joint with a
   * `tail` is an accessory: an earring or an antenna. Default none.
   */
  tail?: Vec3 | null;
  /**
   * Bone the chain's inertia is measured against: `joints[0]` or one of its ancestors. Motion of that bone does not
   * swing the chain, so a running character's hair moves with the head alone. Default none: world space.
   */
  center?: number | null;
  /** Indices into {@link SpringBonesOptions.colliders} this chain hits. Default all of them. */
  colliders?: readonly number[];
}

/** A sphere, or a capsule when `tail` is set, that tails cannot enter. */
export interface SpringCollider {
  /** Bone the shape rides on. Default none: `offset` and `tail` are world points. */
  node?: number | null;
  /** Centre of the sphere, or of the capsule's first end, in the bone's space. Default [0, 0, 0]. */
  offset?: Vec3;
  /** Centre of the capsule's second end, in the bone's space. Default none: a sphere. */
  tail?: Vec3 | null;
  /** Radius, above 0. */
  radius: number;
}

/** A bone that lags and wobbles in place: its position trails the animated one on a damped spring. */
export interface Jiggle {
  /** The bone. */
  joint: number;
  /** Wobbles a second, above 0 and at most 15 (default 4). */
  frequency?: number;
  /** Share of critical damping, above 0 (default 0.35): 1 stops without a wobble. */
  damping?: number;
  /** Farthest the bone strays from its animated position, world units at scale 1 (default 0.05). */
  limit?: number;
  /** Share of the movement shown, 0 to 1 (default 1). */
  amount?: number;
}

/** What {@link SpringBones} simulates. The object is kept and read every frame, so settings can change live. */
export interface SpringBonesOptions {
  /** Swinging chains. A joint can belong to one chain only. */
  chains?: readonly SpringChain[];
  /** Spheres and capsules. */
  colliders?: readonly SpringCollider[];
  /** Bones that wobble in place. */
  jiggles?: readonly Jiggle[];
  /** Extra world force on every tail, such as wind, in `gravity` units. Default none. */
  force?: Vec3 | null;
  /** Blend from the animated pose (0) to the simulated one (1); default 1. */
  weight?: number;
  /**
   * World speed (units a second at scale 1) above which a chain counts as teleported and restarts from the animated
   * pose instead of whipping across the gap. Default 100.
   */
  teleportSpeed?: number;
}

/** Reads and writes of the bones {@link SpringBones.step} moves. */
export interface SpringAccess {
  /** World matrix of a bone, 16 numbers, column-major, current after `flush`. */
  world(bone: number): ArrayLike<number>;
  /** World matrix of a bone's parent, or null for a bone with none. */
  parentWorld(bone: number): ArrayLike<number> | null;
  /** Sets a bone's local rotation. */
  rotate(bone: number, rotation: readonly number[]): void;
  /** Adds to a bone's local translation. */
  move(bone: number, offset: readonly number[]): void;
  /** Brings `world` up to date with the writes so far. */
  flush(): void;
}

/** A pose as plain data: parents, and 10 numbers per bone (translation xyz, rotation xyzw, scale xyz). */
export interface SpringPose {
  readonly parents: readonly number[];
  readonly local: Float64Array | number[];
}

/** A skeleton {@link SpringBones.stepSkeleton} can pose: `@margoengine/animation`'s `Skeleton` fits. */
export interface SpringSkeleton {
  readonly parents: readonly number[];
  getPose(bone: number): { translation: ArrayLike<number>; rotation: ArrayLike<number>; scale: ArrayLike<number> };
  setPose(bone: number, pose: { translation: readonly number[]; rotation: readonly number[] }): unknown;
}

/** The rate the settings are per step of, as in VRM. */
const RATE = 60;
const MAX_STEPS = 8;
const MAX_JOINTS = 256;
const IDENTITY = [0, 0, 0, 1];

const conjugate = (q: ArrayLike<number>): number[] => [-q[0], -q[1], -q[2], q[3]];
const point = (m: ArrayLike<number>, v: ArrayLike<number>): number[] => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

function vector(value: unknown, label: string): void {
  const v = value as ArrayLike<number> | undefined;
  if (!v || v.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2]))
    throw new RangeError(`${label} must be three finite numbers`);
}

/** The scale along each axis of a world matrix. @throws MargoError for one that is flat or mirrored. */
function scales(m: ArrayLike<number>): [number, number, number] {
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]),
    det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (!(det > 0)) throw new MargoError('state', 'Spring bones need positive scales; remove zero or mirrored scales');
  return [sx, sy, sz];
}
// Exported rigs carry scales a little off uniform, so the mean stands for the three.
function scaleOf(m: ArrayLike<number>): number {
  const [sx, sy, sz] = scales(m);
  return (sx + sy + sz) / 3;
}
function rotationOf(m: ArrayLike<number>): number[] {
  const [sx, sy, sz] = scales(m);
  return normalizeQuaternion(rotationToQuaternion(m, [0, 0, 0, 0], sx, sy, sz));
}

/** The shortest rotation taking unit vector `a` to unit vector `b`. */
function arc(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -1 + 1e-10) {
    // Opposite: half a turn about any perpendicular.
    const x = Math.abs(a[0]) < 0.9 ? 1 : 0,
      y = 1 - x;
    return normalizeQuaternion([-a[2] * y, a[2] * x, a[0] * y - a[1] * x, 0]);
  }
  return normalizeQuaternion([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + d]);
}

/** A rotation carried `weight` of the way from none. */
function blend(q: readonly number[], weight: number): number[] {
  if (weight >= 1) return q as number[];
  const sign = q[3] < 0 ? -1 : 1;
  return normalizeQuaternion([
    q[0] * sign * weight,
    q[1] * sign * weight,
    q[2] * sign * weight,
    1 - weight + q[3] * sign * weight,
  ]);
}

/** A chain's running state. Positions are in the chain's space: world, or the `center` bone's. */
interface ChainState {
  readonly spec: SpringChain;
  /** Bones that turn, one per link. */
  readonly heads: readonly number[];
  /** A later chain hangs off this one, so its turns must reach the world matrices first. */
  readonly flush: boolean;
  /** Animated points, heads then the last tail, this frame and last. */
  readonly points: Float64Array;
  readonly before: Float64Array;
  /** Each link's tail now and one step ago. */
  readonly tails: Float64Array;
  readonly last: Float64Array;
  /** Per link: stiffness, decay base (1 - drag), gravity xyz, radius. */
  readonly links: Float64Array;
  /** The step before, for the time-corrected Verlet step. */
  step: number;
  started: boolean;
}

interface JiggleState {
  readonly spec: Jiggle;
  readonly position: Float64Array;
  readonly speed: Float64Array;
  readonly target: Float64Array;
  started: boolean;
}

interface LiveSettings {
  readonly weight: number;
  readonly force: Vec3 | null;
  readonly teleport: number;
}

/**
 * The simulation behind {@link addSpringBones}, for any skeleton: pure data in and out, no engine or GPU. Use
 * {@link stepPose} for a plain pose, {@link stepSkeleton} for a `Skeleton`, or {@link step} for your own bones.
 */
export class SpringBones {
  private readonly chains: ChainState[];
  private readonly jiggles: JiggleState[];
  private world: Float64Array | null = null;
  /**
   * @param parents parent of each bone, -1 at the top (glTF nodes in node order with {@link addSpringBones}).
   * @param options what to simulate; kept and read every frame.
   * @throws RangeError for bad bones or settings, TypeError for chains that are not ancestor lines.
   */
  constructor(
    private readonly parents: readonly number[],
    readonly options: SpringBonesOptions,
  ) {
    if (
      !Array.isArray(parents) ||
      parents.some((p, i) => !Number.isInteger(p) || p < -1 || p >= parents.length || p === i)
    )
      throw new TypeError('SpringBones needs an array of parent indices, -1 at the top');
    const specs = options?.chains ?? [],
      claimed = new Set<number>(),
      bone = (value: unknown, label: string): void => {
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= parents.length)
          throw new RangeError(`${label} ${String(value)} is not a bone of this skeleton; use a bone index`);
      },
      depth = (b: number): number => {
        let d = 0;
        for (; parents[b] !== -1; b = parents[b])
          if (++d > parents.length) throw new RangeError('SpringBones parents form a cycle; every bone must reach -1');
        return d;
      },
      above = (low: number, high: number): boolean => {
        for (let b = parents[low]; b !== -1; b = parents[b]) if (b === high) return true;
        return false;
      };
    parents.forEach((_, i) => depth(i));
    for (const spec of specs) {
      const joints = spec?.joints;
      if (!Array.isArray(joints) || joints.length < 1 || joints.length > MAX_JOINTS)
        throw new RangeError(`A spring chain needs 1 to ${MAX_JOINTS} joints`);
      if (joints.length === 1 && !spec.tail)
        throw new RangeError('A one-joint spring chain needs a tail: the local end point that gives it a direction');
      joints.forEach((joint, i) => {
        bone(joint, 'Spring joint');
        if (claimed.has(joint))
          throw new RangeError(`Bone ${joint} is in two spring chains; a joint can have only one`);
        claimed.add(joint);
        if (i && !above(joint, joints[i - 1]))
          throw new TypeError(`Spring joint ${joint} must descend from the joint before it; list them root to tip`);
      });
      if (spec.center !== undefined && spec.center !== null) {
        bone(spec.center, 'Spring center');
        if (spec.center !== joints[0] && !above(joints[0], spec.center))
          throw new RangeError("Spring center must be the chain's first joint or an ancestor of it");
      }
    }
    const sorted = [...specs].sort((a, b) => depth(a.joints[0]) - depth(b.joints[0]));
    this.chains = sorted.map((spec, i) => {
      const heads = spec.tail ? spec.joints : spec.joints.slice(0, -1),
        mine = new Set(spec.joints),
        hangs = (b: number): boolean => {
          for (let p = parents[b]; p !== -1; p = parents[p]) if (mine.has(p)) return true;
          return false;
        },
        points = heads.length + 1;
      return {
        spec,
        heads,
        flush: sorted.slice(i + 1).some((other) => hangs(other.joints[0])),
        points: new Float64Array(points * 3),
        before: new Float64Array(points * 3),
        tails: new Float64Array(heads.length * 3),
        last: new Float64Array(heads.length * 3),
        links: new Float64Array(heads.length * 6),
        step: 1 / RATE,
        started: false,
      };
    });
    this.jiggles = (options?.jiggles ?? []).map((spec) => {
      bone(spec?.joint, 'Jiggle joint');
      return {
        spec,
        position: new Float64Array(3),
        speed: new Float64Array(3),
        target: new Float64Array(3),
        started: false,
      };
    });
    for (const collider of options?.colliders ?? [])
      if (collider?.node !== undefined && collider?.node !== null) bone(collider.node, 'Spring collider node');
    this.settings();
  }

  /** The bones this simulation turns or moves, each once. */
  bones(): number[] {
    return [...new Set([...this.chains.flatMap((chain) => chain.heads), ...this.jiggles.map((j) => j.spec.joint)])];
  }

  /** Forgets all motion: the next step starts from the animated pose. Call it after moving a character by hand. */
  reset(): void {
    for (const chain of this.chains) chain.started = false;
    for (const jiggle of this.jiggles) jiggle.started = false;
  }

  /** Reads and checks the live settings. */
  private settings(): LiveSettings {
    const { weight = 1, force = null, teleportSpeed = 100, colliders = [] } = this.options ?? {};
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('Spring weight must be from 0 to 1');
    if (!(teleportSpeed > 0)) throw new RangeError('Spring teleportSpeed must be above 0');
    if (force !== null) vector(force, 'Spring force');
    for (const collider of colliders) {
      if (!(collider?.radius > 0 && collider.radius < Infinity))
        throw new RangeError('A spring collider radius must be finite and above 0');
      if (collider.offset !== undefined) vector(collider.offset, 'Spring collider offset');
      if (collider.tail !== undefined && collider.tail !== null) vector(collider.tail, 'Spring collider tail');
    }
    for (const chain of this.chains) {
      const spec = chain.spec;
      if (spec.tail) vector(spec.tail, 'Spring chain tail');
      for (const index of spec.colliders ?? [])
        if (!Number.isInteger(index) || index < 0 || index >= colliders.length)
          throw new RangeError(`Spring chain collider ${index} is not in options.colliders; use an index into it`);
      chain.heads.forEach((_, i) => {
        const own = spec.settings?.[i],
          stiffness = own?.stiffness ?? spec.stiffness ?? 1,
          drag = own?.drag ?? spec.drag ?? 0.5,
          gravity = own?.gravity ?? spec.gravity ?? 0,
          direction = own?.gravityDirection ?? spec.gravityDirection ?? [0, -1, 0],
          radius = own?.radius ?? spec.radius ?? 0;
        if (!(stiffness >= 0 && stiffness < Infinity)) throw new RangeError('Spring stiffness must be 0 or more');
        if (!(drag >= 0 && drag <= 1)) throw new RangeError('Spring drag must be from 0 to 1');
        if (!Number.isFinite(gravity)) throw new RangeError('Spring gravity must be finite');
        if (!(radius >= 0 && radius < Infinity)) throw new RangeError('Spring radius must be 0 or more');
        vector(direction, 'Spring gravityDirection');
        const length = Math.hypot(direction[0], direction[1], direction[2]);
        if (!(length > 0) && gravity !== 0) throw new RangeError('Spring gravityDirection must not be zero');
        const k = length > 0 ? gravity / length : 0;
        chain.links.set([stiffness, 1 - drag, direction[0] * k, direction[1] * k, direction[2] * k, radius], i * 6);
      });
    }
    for (const { spec } of this.jiggles) {
      const { frequency = 4, damping = 0.35, limit = 0.05, amount = 1 } = spec;
      if (!(frequency > 0 && frequency <= 15)) throw new RangeError('Jiggle frequency must be above 0 and at most 15');
      if (!(damping > 0 && damping < Infinity)) throw new RangeError('Jiggle damping must be above 0');
      if (!(limit >= 0 && limit < Infinity)) throw new RangeError('Jiggle limit must be 0 or more');
      if (!(amount >= 0 && amount <= 1)) throw new RangeError('Jiggle amount must be from 0 to 1');
    }
    return { weight, force, teleport: teleportSpeed };
  }

  /**
   * Advances `delta` seconds on bones reached through `access`: reads their animated world matrices and writes the
   * swung rotations and jiggled positions. Run it after the frame's animation, once per frame. A `delta` of 0 holds
   * the motion. Long frames take at most 8 steps of 1/60 s, so a stall slows the swing and cannot blow it up.
   * @throws RangeError for a bad `delta` or settings.
   */
  step(delta: number, access: SpringAccess): void {
    if (!(delta >= 0 && delta < Infinity)) throw new RangeError('Spring delta must be a finite time of 0 or more');
    const live = this.settings(),
      steps = Math.min(MAX_STEPS, Math.ceil(delta * RATE - 1e-9)),
      dt = steps ? Math.min(delta / steps, 1 / RATE) : 0;
    for (const chain of this.chains) {
      this.solveChain(chain, delta, steps, dt, live, access);
      if (chain.flush) access.flush();
    }
    if (this.chains.length) access.flush();
    if (this.jiggles.length) {
      for (const jiggle of this.jiggles) this.solveJiggle(jiggle, delta, steps, dt, live, access);
      access.flush();
    }
  }

  private solveChain(
    chain: ChainState,
    delta: number,
    steps: number,
    dt: number,
    live: LiveSettings,
    access: SpringAccess,
  ): void {
    const { spec, heads, points, before, tails, last, links } = chain,
      count = heads.length,
      centerBone = spec.center ?? null,
      c = centerBone === null ? null : access.world(centerBone),
      centerScale = c ? scaleOf(c) : 1,
      centerRotation = c ? rotationOf(c) : IDENTITY,
      centerInverse = conjugate(centerRotation),
      toSpace = (v: ArrayLike<number>): ArrayLike<number> =>
        c
          ? rotateByQuaternion([v[0] - c[12], v[1] - c[13], v[2] - c[14]], centerInverse).map((x) => x / centerScale)
          : v,
      worlds = heads.map((bone) => access.world(bone)),
      turning = worlds.map(rotationOf),
      scale = scaleOf(worlds[0]) / centerScale;
    // Animated points of this frame, in the chain's space.
    for (let i = 0; i < count; i++) {
      const m = worlds[i];
      points.set(toSpace([m[12], m[13], m[14]]), i * 3);
    }
    const tip = access.world(spec.joints[spec.joints.length - 1]);
    points.set(toSpace(spec.tail ? point(tip, spec.tail) : [tip[12], tip[13], tip[14]]), count * 3);
    const moved = Math.hypot(points[0] - before[0], points[1] - before[1], points[2] - before[2]);
    if (!chain.started || (delta > 0 && moved / delta > live.teleport * scale)) {
      before.set(points);
      for (let i = 0; i < count; i++)
        for (let k = 0; k < 3; k++) tails[i * 3 + k] = last[i * 3 + k] = points[i * 3 + 3 + k];
      chain.step = 1 / RATE;
      chain.started = true;
    }
    // Colliders of this chain in its space; bones have their pose for the frame.
    const all = this.options.colliders ?? [],
      shapes = (spec.colliders ?? all.map((_, i) => i)).map((index) => {
        const collider = all[index],
          m = collider.node === undefined || collider.node === null ? null : access.world(collider.node),
          offset = collider.offset ?? [0, 0, 0],
          a = toSpace(m ? point(m, offset) : offset),
          b = collider.tail ? toSpace(m ? point(m, collider.tail) : collider.tail) : null;
        return { a, b, radius: (collider.radius * (m ? scaleOf(m) : 1)) / centerScale };
      });
    const external = [0, 0, 0],
      force = live.force;
    for (let s = 1; s <= steps; s++) {
      const alpha = s / steps,
        ratio = dt / chain.step,
        decayPower = RATE * dt,
        push = dt * dt * RATE * scale;
      let turn = IDENTITY;
      for (let i = 0; i < count; i++) {
        const o = i * 3,
          l = i * 6,
          // Head: the first follows the animation; the others sit on the tail before.
          hx = i ? tails[o - 3] : before[0] + (points[0] - before[0]) * alpha,
          hy = i ? tails[o - 2] : before[1] + (points[1] - before[1]) * alpha,
          hz = i ? tails[o - 1] : before[2] + (points[2] - before[2]) * alpha,
          bx = before[o + 3] - before[o] + (points[o + 3] - points[o] - before[o + 3] + before[o]) * alpha,
          by = before[o + 4] - before[o + 1] + (points[o + 4] - points[o + 1] - before[o + 4] + before[o + 1]) * alpha,
          bz = before[o + 5] - before[o + 2] + (points[o + 5] - points[o + 2] - before[o + 5] + before[o + 2]) * alpha,
          reach = Math.hypot(bx, by, bz),
          length = Math.hypot(points[o + 3] - points[o], points[o + 4] - points[o + 1], points[o + 5] - points[o + 2]);
        if (!(length > 0) || !(reach > 0)) {
          // Two joints at one point give no direction; the tail stays on its head.
          last[o] = tails[o] = hx;
          last[o + 1] = tails[o + 1] = hy;
          last[o + 2] = tails[o + 2] = hz;
          continue;
        }
        const aim = rotateByQuaternion([bx / reach, by / reach, bz / reach], turn),
          decay = links[l + 1] ** decayPower,
          stiffness = links[l];
        external[0] = links[l + 2] + (force ? force[0] : 0);
        external[1] = links[l + 3] + (force ? force[1] : 0);
        external[2] = links[l + 4] + (force ? force[2] : 0);
        const fall = c ? rotateByQuaternion(external, centerInverse) : external;
        let x = tails[o] + (tails[o] - last[o]) * ratio * decay + push * (aim[0] * stiffness + fall[0]),
          y = tails[o + 1] + (tails[o + 1] - last[o + 1]) * ratio * decay + push * (aim[1] * stiffness + fall[1]),
          z = tails[o + 2] + (tails[o + 2] - last[o + 2]) * ratio * decay + push * (aim[2] * stiffness + fall[2]);
        const hold = (): void => {
          const dx = x - hx,
            dy = y - hy,
            dz = z - hz,
            d = Math.hypot(dx, dy, dz);
          x = d > 0 ? hx + (dx / d) * length : hx + aim[0] * length;
          y = d > 0 ? hy + (dy / d) * length : hy + aim[1] * length;
          z = d > 0 ? hz + (dz / d) * length : hz + aim[2] * length;
        };
        hold();
        const radius = links[l + 5] * scale;
        for (const { a, b, radius: size } of shapes) {
          let dx = x - a[0],
            dy = y - a[1],
            dz = z - a[2];
          if (b) {
            const ex = b[0] - a[0],
              ey = b[1] - a[1],
              ez = b[2] - a[2],
              e2 = ex * ex + ey * ey + ez * ez,
              t = e2 > 0 ? Math.min(1, Math.max(0, (dx * ex + dy * ey + dz * ez) / e2)) : 0;
            dx -= ex * t;
            dy -= ey * t;
            dz -= ez * t;
          }
          const d = Math.hypot(dx, dy, dz),
            depth = size + radius - d;
          if (depth <= 0) continue;
          // Dead centre has no way out; leave along the bone.
          x += d > 0 ? (dx / d) * depth : aim[0] * depth;
          y += d > 0 ? (dy / d) * depth : aim[1] * depth;
          z += d > 0 ? (dz / d) * depth : aim[2] * depth;
          hold();
        }
        last[o] = tails[o];
        last[o + 1] = tails[o + 1];
        last[o + 2] = tails[o + 2];
        tails[o] = x;
        tails[o + 1] = y;
        tails[o + 2] = z;
        const dx = x - hx,
          dy = y - hy,
          dz = z - hz,
          d = Math.hypot(dx, dy, dz);
        if (d > 0) turn = normalizeQuaternion(multiplyQuaternions(arc(aim, [dx / d, dy / d, dz / d]), turn));
      }
      chain.step = dt;
    }
    if (steps) before.set(points);
    // Each bone's turn on the frame's own pose, carried to world space, then to its local rotation.
    let turn = IDENTITY,
      above = IDENTITY;
    for (let i = 0; i < count; i++) {
      const o = i * 3,
        hx = i ? tails[o - 3] : points[0],
        hy = i ? tails[o - 2] : points[1],
        hz = i ? tails[o - 1] : points[2],
        bx = points[o + 3] - points[o],
        by = points[o + 4] - points[o + 1],
        bz = points[o + 5] - points[o + 2],
        length = Math.hypot(bx, by, bz),
        dx = tails[o] - hx,
        dy = tails[o + 1] - hy,
        dz = tails[o + 2] - hz,
        d = Math.hypot(dx, dy, dz);
      if (length > 0 && d > 0) {
        const aim = rotateByQuaternion([bx / length, by / length, bz / length], turn);
        turn = normalizeQuaternion(multiplyQuaternions(arc(aim, [dx / d, dy / d, dz / d]), turn));
      }
      const world = blend(
          c ? multiplyQuaternions(multiplyQuaternions(centerRotation, turn), centerInverse) : turn,
          live.weight,
        ),
        parent = access.parentWorld(heads[i]),
        base = parent ? rotationOf(parent) : IDENTITY,
        change = multiplyQuaternions(conjugate(above), world);
      access.rotate(
        heads[i],
        normalizeQuaternion(multiplyQuaternions(conjugate(base), multiplyQuaternions(change, turning[i]))),
      );
      above = world;
    }
  }

  private solveJiggle(
    jiggle: JiggleState,
    delta: number,
    steps: number,
    dt: number,
    live: LiveSettings,
    access: SpringAccess,
  ): void {
    const { spec, position, speed, target } = jiggle,
      m = access.world(spec.joint),
      scale = scaleOf(m),
      { frequency = 4, damping = 0.35, limit = 0.05, amount = 1 } = spec,
      omega = 2 * Math.PI * frequency,
      reach = limit * scale,
      now = [m[12], m[13], m[14]],
      moved = Math.hypot(now[0] - target[0], now[1] - target[1], now[2] - target[2]);
    if (!jiggle.started || (delta > 0 && moved / delta > live.teleport * scale)) {
      position.set(now);
      target.set(now);
      speed.fill(0);
      jiggle.started = true;
    }
    for (let s = 1; s <= steps; s++) {
      const alpha = s / steps,
        offset = [0, 0, 0],
        pace = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const goal = target[k] + (now[k] - target[k]) * alpha;
        pace[k] = (now[k] - target[k]) / delta;
        // Semi-implicit Euler on a damped spring about the moving bone: steady motion leaves no lag.
        const stretch = position[k] - (goal - pace[k] * dt);
        speed[k] += (-omega * omega * stretch - 2 * damping * omega * (speed[k] - pace[k])) * dt;
        position[k] += speed[k] * dt;
        offset[k] = position[k] - goal;
      }
      const far = Math.hypot(offset[0], offset[1], offset[2]);
      if (far > reach) {
        // At the limit the bone rides along: no speed outward.
        let out = 0;
        for (let k = 0; k < 3; k++) {
          out += ((speed[k] - pace[k]) * offset[k]) / far;
          position[k] += (offset[k] / far) * reach - offset[k];
        }
        if (out > 0) for (let k = 0; k < 3; k++) speed[k] -= (out * offset[k]) / far;
      }
    }
    if (steps) target.set(now);
    const share = amount * live.weight,
      parent = access.parentWorld(spec.joint),
      world = [(position[0] - now[0]) * share, (position[1] - now[1]) * share, (position[2] - now[2]) * share];
    if (!parent) {
      access.move(spec.joint, world);
      return;
    }
    const size = scaleOf(parent);
    access.move(
      spec.joint,
      rotateByQuaternion(world, conjugate(rotationOf(parent))).map((v) => v / size),
    );
  }

  /**
   * Advances a plain pose in place: `pose.local` holds the animated pose going in and the swung one coming out.
   * @param root World matrix of the skeleton (16 numbers), for a character that moves. Default none: skeleton space.
   */
  stepPose(pose: SpringPose, delta: number, root?: ArrayLike<number>): void {
    const { parents, local } = pose ?? ({} as SpringPose),
      n = this.parents.length;
    if (parents !== this.parents && (parents?.length !== n || parents.some((p, i) => p !== this.parents[i])))
      throw new TypeError('stepPose needs the parents this SpringBones was made with');
    if (local?.length !== n * 10) throw new RangeError('stepPose needs 10 numbers per bone in pose.local');
    const world = (this.world ??= new Float64Array(n * 16)),
      done = new Uint8Array(n),
      refresh = (b: number): void => {
        if (done[b]) return;
        const p = this.parents[b];
        if (p !== -1) refresh(p);
        done[b] = 1;
        const l = b * 10,
          [qx, qy, qz, qw] = normalizeQuaternion([local[l + 3], local[l + 4], local[l + 5], local[l + 6]]),
          sx = local[l + 7],
          sy = local[l + 8],
          sz = local[l + 9],
          columns = [
            [(1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx],
            [2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy],
            [2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz],
            [local[l], local[l + 1], local[l + 2]],
          ],
          base = p === -1 ? root : world.subarray(p * 16, p * 16 + 16);
        columns.forEach((v, col) => {
          for (let row = 0; row < 3; row++)
            world[b * 16 + col * 4 + row] = base
              ? base[row] * v[0] + base[4 + row] * v[1] + base[8 + row] * v[2] + (col === 3 ? base[12 + row] : 0)
              : v[row];
          world[b * 16 + col * 4 + 3] = col === 3 ? 1 : 0;
        });
      };
    this.step(delta, {
      world: (bone) => {
        refresh(bone);
        return world.subarray(bone * 16, bone * 16 + 16);
      },
      parentWorld: (bone) => {
        const p = this.parents[bone];
        if (p === -1) return root ?? null;
        refresh(p);
        return world.subarray(p * 16, p * 16 + 16);
      },
      rotate: (bone, rotation) => {
        for (let k = 0; k < 4; k++) local[bone * 10 + 3 + k] = rotation[k];
      },
      move: (bone, offset) => {
        for (let k = 0; k < 3; k++) local[bone * 10 + k] += offset[k];
      },
      flush: () => done.fill(0),
    });
  }

  /** Advances a `Skeleton` from `@margoengine/animation` in place, after its pose is set. `root` as in {@link stepPose}. */
  stepSkeleton(skeleton: SpringSkeleton, delta: number, root?: ArrayLike<number>): void {
    if (typeof skeleton?.getPose !== 'function' || typeof skeleton.setPose !== 'function')
      throw new TypeError('stepSkeleton needs a Skeleton from @margoengine/animation');
    const n = this.parents.length,
      local = new Float64Array(n * 10);
    for (let b = 0; b < n; b++) {
      const { translation, rotation, scale } = skeleton.getPose(b);
      local.set(translation, b * 10);
      local.set(rotation, b * 10 + 3);
      local.set(scale, b * 10 + 7);
    }
    this.stepPose({ parents: this.parents, local }, delta, root);
    for (const b of this.bones())
      skeleton.setPose(b, {
        translation: Array.from(local.subarray(b * 10, b * 10 + 3)),
        rotation: Array.from(local.subarray(b * 10 + 3, b * 10 + 7)),
      });
  }
}

/** What {@link springAccess} reads of a model: `animation.model` fits. */
export interface SpringModel {
  readonly nodes: readonly Mesh[];
  readonly root: Mesh;
}

/**
 * The {@link SpringAccess} of a model's glTF nodes, for running {@link SpringBones.step} by hand. `writeRotation`
 * replaces `setQuaternion`, as `animator.writeNodeRotation` does on an animated model.
 */
export function springAccess(
  model: SpringModel,
  writeRotation?: (bone: number, rotation: readonly number[]) => void,
): SpringAccess {
  const { nodes } = model,
    engine = model.root.engine,
    store = engine.store,
    t = store.transforms;
  return {
    world: (bone) => nodes[bone].matrix,
    parentWorld: (bone) => {
      const parent = store.parents[nodes[bone].id];
      return parent === -1 ? null : engine.meshes.get(parent)!.matrix;
    },
    rotate: writeRotation ?? ((bone, rotation) => nodes[bone].setQuaternion(rotation)),
    move: (bone, offset) => {
      const id = nodes[bone].id;
      nodes[bone].setPosition([t.x[id] + offset[0], t.y[id] + offset[1], t.z[id] + offset[2]]);
    },
    flush: () => store.tick(false),
  };
}

/** A running {@link addSpringBones}. */
export interface SpringBonesHandle {
  /** The simulation; its `options` are the object passed in. */
  readonly springs: SpringBones;
  /** Forgets all motion, for a character moved by hand. */
  reset(): void;
  /** Stops the simulation. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Runs spring bones on `animator` (`@margoengine/animator`), every frame after the pose, layers, foot IK and the solvers
 * added before it. Joints, centers and collider nodes are glTF node indices of the animator's model. Joints and their
 * ancestors need positive scales. Returns the handle; dispose it to stop.
 * @throws RangeError for bad bones or settings, TypeError for chains that are not ancestor lines.
 */
export function addSpringBones(animator: Animator, options: SpringBonesOptions): SpringBonesHandle {
  const model = animator.animation.model,
    { nodes } = model,
    parents = model.root.engine.store.parents,
    index = new Map(nodes.map((node, i) => [node.id, i])),
    springs = new SpringBones(
      nodes.map((node) => index.get(parents[node.id]) ?? -1),
      options,
    ),
    access = springAccess(model, (bone, rotation) => animator.writeNodeRotation(nodes[bone], rotation));
  let remove: (() => void) | null = animator.addSolver((delta) => springs.step(delta, access));
  const dispose = (): void => {
    remove?.();
    remove = null;
  };
  return { springs, reset: () => springs.reset(), dispose, [Symbol.dispose]: dispose };
}
