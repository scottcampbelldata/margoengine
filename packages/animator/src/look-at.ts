// Look-at and aim constraints on an Animator's skeleton: after the pose, a bone (or a spine-neck-head run of bones,
// each taking a share of the turn) turns so a local axis points at a world target, optionally rolled so a second axis
// stays toward world up. Kept out of the Animator class so an app that never adds one does not bundle it.
//
// No allocation per solve (as ccd.ts): the solve's numbers live in preallocated arrays, and helpers take arrays, never
// numbers, because a number passed to or returned from a call that the optimizer does not inline is boxed on the heap.
// The helpers repeat the arithmetic of @margoengine/math's quaternion functions and Math.hypot (through
// shared/hypot.js), operation for operation, so the solve gives the same numbers it gave before.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { hypotOf, hypotTerms } from '../../shared/hypot.js';
import type { Animator } from './index.js';

/** A look-at constraint ({@link addLookAt}). The Animator keeps the object and reads it every frame. */
export interface LookAt {
  /**
   * glTF node indices of the bones that turn, from the first (a spine or neck bone) to the last (the head or eye),
   * each a descendant of the one before (1-32 bones). The last bone's `axis` ends up pointing at the target.
   */
  joints: readonly number[];
  /** World point to look at; mutate it per frame. */
  target: Vec3;
  /** Share of the turn each bone takes, index-aligned with `joints`, each >= 0 (default equal shares). */
  shares?: readonly number[];
  /** The last bone's local look direction (default [0, 0, 1], glTF's forward). */
  axis?: Vec3;
  /**
   * Point in the last bone's local space the look is aimed from, such as an eye or a camera lens away from the neck
   * pivot (default [0, 0, 0], the bone's origin). The bone still turns about its origin, so that the ray from this
   * point along `axis` passes through the target. A target too near the bone to lie on that ray gets the ray's
   * nearest point turned toward it.
   */
  origin?: Vec3;
  /** The last bone's local up direction, rolled toward `worldUp` after aiming (default [0, 1, 0]); null skips the roll. */
  up?: Vec3 | null;
  /** World up for the roll (default [0, 1, 0]). */
  worldUp?: Vec3;
  /** Largest turn away from the animated look direction, radians (0-π, default π). */
  maxAngle?: number;
  /** Blend from the animated pose (0) to the full turn (1); default 1. */
  weight?: number;
}

/** An aim constraint on one bone ({@link addAimConstraint}): {@link LookAt} with a single joint. */
export interface AimConstraint extends Omit<LookAt, 'joints' | 'shares'> {
  /** glTF node index of the bone that turns. */
  joint: number;
}

/** Inside this distance of the last bone's origin (1 mm in glTF metres) a target gives no usable direction. */
const NEAR = 1e-3;
const Z_AXIS: Vec3 = [0, 0, 1],
  Y_AXIS: Vec3 = [0, 1, 0],
  X_AXIS: Vec3 = [1, 0, 0],
  IDENTITY: readonly number[] = [0, 0, 0, 1];
// Slots of each constraint's number array.
const WEIGHT = 0,
  MAX_ANGLE = 1,
  HELD = 2, // distance of the held aim, 0 before the first aim
  FRACTION = 3, // the part of a turn partial() keeps
  DISTANCE = 4, // the distance look() measures the ray at
  SLOTS = 5;

/** Writes Math.hypot of `v`'s three components (same bits) to hypotTerms[4]. */
function measure(v: ArrayLike<number>): void {
  hypotTerms[0] = v[0];
  hypotTerms[1] = v[1];
  hypotTerms[2] = v[2];
  hypotOf(3);
}

/** Writes `v` divided by its length into `out`. */
function unitInto(v: ArrayLike<number> | null | undefined, label: string, out: number[]): void {
  if (v != null) measure(v);
  const length = v == null ? Number.NaN : hypotTerms[4];
  if (!(length > 0 && length < Infinity) || v!.length !== 3)
    throw new RangeError(`${label} must be a nonzero direction of three finite numbers`);
  out[0] = v![0] / length;
  out[1] = v![1] / length;
  out[2] = v![2] / length;
}

/**
 * Adds a look-at constraint to `animator`, solved every frame after the pose, additive layers, foot IK and the solvers
 * added before it: the bones in `lookAt.joints` turn in order, each taking its share of what is left of the turn, so
 * the last bone's `axis` (from `origin`) points at `lookAt.target` (within `maxAngle` of the animated direction), then
 * that bone rolls about the look direction so its `up` axis is as close to `worldUp` as it can be. A target within
 * 1 mm of the last bone's origin has no usable direction: the bones hold the last aim until it moves out again (the
 * animated pose until there is one), and a bone that would turn the last bone toward an aim point less than 1 mm from
 * it skips its share. Bones and their ancestors need positive uniform scales; rotations commit through the Animator's
 * `writeRotation` when it has one. The solve allocates nothing per frame. Returns a function that removes the
 * constraint.
 * @throws RangeError for invalid joints or settings.
 */
export function addLookAt(animator: Animator, lookAt: LookAt): () => void {
  const nodes = animator.animation.model.nodes,
    engine = animator.animation.model.root.engine,
    store = engine.store,
    parents = store.parents,
    joints = lookAt?.joints;
  if (!Array.isArray(joints) || joints.length < 1 || joints.length > 32)
    throw new TypeError('Look-at joints must be 1-32 glTF node indices from the first bone to the last');
  for (const j of joints)
    if (!Number.isInteger(j) || j < 0 || j >= nodes.length)
      throw new RangeError(`Look-at joint ${j} is not one of the model's ${nodes.length} glTF nodes`);
  const chain: Mesh[] = joints.map((j) => nodes[j]);
  for (let i = 1; i < chain.length; i++) {
    let at = parents[chain[i].id];
    while (at !== -1 && at !== chain[i - 1].id) at = parents[at];
    if (at === -1)
      throw new RangeError(`Look-at joint ${joints[i]} is not below ${joints[i - 1]}; list bones from first to last`);
  }
  const count = chain.length,
    equal: readonly number[] = joints.map(() => 1),
    // The settings read() checks and copies every frame (the caller may change any of them), then the scratch.
    num = new Float64Array(SLOTS),
    axis = [0, 0, 1],
    up = [0, 1, 0],
    worldUp = [0, 1, 0],
    origin = [0, 0, 0],
    held = [0, 0, 0],
    aimed = [0, 0, 0],
    from = [0, 0, 0],
    to = [0, 0, 0],
    goal = [0, 0, 0],
    turn = [0, 0, 0, 1],
    now = [0, 0, 0, 1],
    base = [0, 0, 0, 1],
    local = [0, 0, 0, 1],
    blended = [0, 0, 0, 1],
    before = chain.map(() => [0, 0, 0, 1]);
  let shares = equal,
    target: ArrayLike<number> = Z_AXIS,
    rolls = true,
    offset = false;
  const read = (): void => {
    const s = lookAt.shares ?? equal;
    // Straight into the number array: a double option read into a local would be boxed.
    num[WEIGHT] = lookAt.weight ?? 1;
    num[MAX_ANGLE] = lookAt.maxAngle ?? Math.PI;
    let valid = Array.isArray(s) && s.length === count,
      some = false;
    for (let i = 0; valid && i < count; i++) {
      const share = s[i];
      valid = share >= 0 && share < Infinity;
      if (share > 0) some = true;
    }
    if (!valid) throw new RangeError('Look-at shares need one finite share >= 0 per joint');
    if (!some) throw new RangeError('Look-at shares must not all be 0; give a bone a share');
    if (!(num[WEIGHT] >= 0 && num[WEIGHT] <= 1)) throw new RangeError('Look-at weight must be from 0 to 1');
    if (!(num[MAX_ANGLE] >= 0 && num[MAX_ANGLE] <= Math.PI))
      throw new RangeError('Look-at maxAngle must be from 0 to π');
    const t = lookAt.target;
    if (!t || t.length !== 3 || !(Number.isFinite(t[0]) && Number.isFinite(t[1]) && Number.isFinite(t[2])))
      throw new RangeError('Look-at target must be three finite numbers');
    unitInto(lookAt.axis ?? Z_AXIS, 'Look-at axis', axis);
    if (lookAt.up !== null) unitInto(lookAt.up ?? Y_AXIS, 'Look-at up', up);
    unitInto(lookAt.worldUp ?? Y_AXIS, 'Look-at worldUp', worldUp);
    const o = lookAt.origin;
    if (o != null) {
      if (o.length !== 3 || !(Number.isFinite(o[0]) && Number.isFinite(o[1]) && Number.isFinite(o[2])))
        throw new RangeError("Look-at origin must be three finite numbers in the last bone's space");
      origin[0] = o[0];
      origin[1] = o[1];
      origin[2] = o[2];
    }
    shares = s;
    target = t;
    rolls = lookAt.up !== null;
    offset = o != null && (o[0] !== 0 || o[1] !== 0 || o[2] !== 0);
  };
  read();
  const last = chain[count - 1];
  return animator.addSolver(() => {
    read();
    if (num[WEIGHT] === 0) return;
    // The target from the last bone's origin, the centre of its turn. At the origin there is no direction, and within
    // a hair of it the direction swings through any angle as the target passes, so inside 1 mm the last aim holds.
    let m = last.matrix;
    to[0] = target[0] - m[12];
    to[1] = target[1] - m[13];
    to[2] = target[2] - m[14];
    measure(to);
    const distance = hypotTerms[4];
    let aim = target;
    if (distance >= NEAR && distance < Infinity) {
      held[0] = to[0] / distance;
      held[1] = to[1] / distance;
      held[2] = to[2] / distance;
      num[HELD] = distance;
    } else if (num[HELD] > 0) {
      aimed[0] = m[12] + held[0] * num[HELD];
      aimed[1] = m[13] + held[1] * num[HELD];
      aimed[2] = m[14] + held[2] * num[HELD];
      aim = aimed;
    } else return; // no aim yet: keep the animated pose
    // The animated look direction against the wanted one; beyond maxAngle, aim at the point at the same distance
    // maxAngle from the animated look.
    num[DISTANCE] = num[HELD];
    look(m, from);
    const cosine = from[0] * held[0] + from[1] * held[1] + from[2] * held[2],
      angle = Math.acos(cosine > 1 ? 1 : cosine < -1 ? -1 : cosine);
    if (angle > num[MAX_ANGLE]) {
      between(from, held, turn);
      num[FRACTION] = num[MAX_ANGLE] / angle;
      partial(turn, num);
      rotate(from, turn, to);
      aimed[0] = m[12] + to[0] * num[HELD];
      aimed[1] = m[13] + to[1] * num[HELD];
      aimed[2] = m[14] + to[2] * num[HELD];
      aim = aimed;
    }
    const t = store.transforms;
    for (let i = 0; i < count; i++) {
      const id = chain[i].id,
        q = before[i];
      q[0] = t.qx[id];
      q[1] = t.qy[id];
      q[2] = t.qz[id];
      q[3] = t.qw[id];
    }
    let remaining = 0;
    for (let i = 0; i < count; i++) remaining += shares[i];
    for (let i = 0; i < count; i++) {
      const share = shares[i];
      if (!(share > 0)) continue;
      // Each bone takes its share of what is left, measured from the last bone's current frame and position. A bone
      // before this one may have carried the last bone onto the aim point: no direction is left, so no turn.
      m = last.matrix;
      to[0] = aim[0] - m[12];
      to[1] = aim[1] - m[13];
      to[2] = aim[2] - m[14];
      measure(to);
      const length = hypotTerms[4];
      if (length >= NEAR && length < Infinity) {
        to[0] /= length;
        to[1] /= length;
        to[2] /= length;
        num[DISTANCE] = length;
        look(m, from);
        between(from, to, turn);
        num[FRACTION] = share / remaining;
        partial(turn, num);
        turnBone(chain[i], turn);
      }
      remaining -= share;
    }
    if (rolls) {
      // Roll about the look direction so `up` points as near world up as it can. With an origin the roll turns about
      // the line from the bone's origin to the aim point instead, the one roll that keeps that point on the look ray.
      m = last.matrix;
      rotation(m, now);
      rotate(axis, now, from);
      if (offset) {
        to[0] = aim[0] - m[12];
        to[1] = aim[1] - m[13];
        to[2] = aim[2] - m[14];
        measure(to);
        const length = hypotTerms[4];
        if (length >= NEAR && length < Infinity) {
          from[0] = to[0] / length;
          from[1] = to[1] / length;
          from[2] = to[2] / length;
        }
      }
      rotate(up, now, to);
      if (reject(to, from, to) && reject(worldUp, from, goal)) {
        between(to, goal, turn);
        turnBone(last, turn);
      }
    }
    if (num[WEIGHT] < 1) {
      // Blend each bone's local rotation from the animated one to the solved one.
      num[FRACTION] = num[WEIGHT];
      for (let i = 0; i < count; i++) {
        const id = chain[i].id;
        local[0] = t.qx[id];
        local[1] = t.qy[id];
        local[2] = t.qz[id];
        local[3] = t.qw[id];
        blend(before[i], local, num, blended);
        animator.writeNodeRotation(chain[i], blended);
      }
      store.tick(false);
    }
  });
  /**
   * The world direction, from the last bone's origin, of the point on its look ray at num[DISTANCE] from that origin
   * (the ray from `origin` along `axis` in the bone's world frame `m`). Turning it onto the target's direction about
   * the bone's origin puts the target on the ray. With no origin it is the look axis.
   */
  function look(m: ArrayLike<number>, out: number[]): void {
    rotation(m, now);
    rotate(axis, now, out);
    if (!offset) return;
    // The origin from the bone's origin in world units (rotated and scaled), then the ray's point o + λa with
    // |o + λa| = distance and λ >= 0. When no point of the ray is that near, the ray's nearest point: λ = max(0, -o·a).
    const distance = num[DISTANCE],
      ox = m[0] * origin[0] + m[4] * origin[1] + m[8] * origin[2],
      oy = m[1] * origin[0] + m[5] * origin[1] + m[9] * origin[2],
      oz = m[2] * origin[0] + m[6] * origin[1] + m[10] * origin[2],
      along = ox * out[0] + oy * out[1] + oz * out[2],
      reach = along * along - (ox * ox + oy * oy + oz * oz) + distance * distance;
    let lambda = reach > 0 ? Math.sqrt(reach) - along : -along;
    if (!(lambda > 0)) lambda = 0;
    goal[0] = ox + out[0] * lambda;
    goal[1] = oy + out[1] * lambda;
    goal[2] = oz + out[2] * lambda;
    measure(goal);
    const length = hypotTerms[4];
    if (!(length > 0)) return;
    out[0] = goal[0] / length;
    out[1] = goal[1] / length;
    out[2] = goal[2] / length;
  }
  function turnBone(bone: Mesh, by: ArrayLike<number>): void {
    const parent = parents[bone.id];
    if (parent === -1) {
      base[0] = base[1] = base[2] = 0;
      base[3] = 1;
    } else rotation(engine.meshes.get(parent)!.matrix, base);
    rotation(bone.matrix, now);
    multiply(by, now, now);
    base[0] = -base[0];
    base[1] = -base[1];
    base[2] = -base[2];
    multiply(base, now, local);
    normalize(local, local);
    animator.writeNodeRotation(bone, local);
    store.tick(false);
  }
}

/**
 * Adds an aim constraint to `animator`: one bone turns so its local `axis` points at `aim.target`, rolled so `up`
 * stays toward `worldUp` ({@link addLookAt} with one joint). Returns a function that removes it.
 */
export function addAimConstraint(animator: Animator, aim: AimConstraint): () => void {
  if (!aim || typeof aim !== 'object') throw new TypeError('Aim constraint needs {joint, target}');
  // A live view of the caller's object, so later writes to target, weight and the axes take effect.
  const lookAt: LookAt = {
    joints: [aim.joint],
    get target() {
      return aim.target;
    },
    get axis() {
      return aim.axis;
    },
    get origin() {
      return aim.origin;
    },
    get up() {
      return aim.up;
    },
    get worldUp() {
      return aim.worldUp;
    },
    get maxAngle() {
      return aim.maxAngle;
    },
    get weight() {
      return aim.weight;
    },
  };
  return addLookAt(animator, lookAt);
}

/** a * b (apply b, then a) into `out`, which may be either input (as multiplyQuaternions). */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: number[]): void {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
}
/** `q` divided by its length into `out`, which may be `q` (as normalizeQuaternion). */
function normalize(q: ArrayLike<number>, out: number[]): void {
  let a = q[0],
    b = q[1],
    c = q[2],
    d = q[3],
    l = Math.sqrt(a * a + b * b + c * c + d * d);
  if (!(l > 2 ** -511 && l < Infinity)) {
    const m = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    if (m > 0 && m < Infinity) {
      a /= m;
      b /= m;
      c /= m;
      d /= m;
      l = Math.sqrt(a * a + b * b + c * c + d * d);
    }
  }
  l ||= 1;
  out[0] = a / l;
  out[1] = b / l;
  out[2] = c / l;
  out[3] = d / l;
}
/** `v` rotated by unit `q` into `out`, which may be `v` (as rotateByQuaternion). */
function rotate(v: ArrayLike<number>, q: ArrayLike<number>, out: number[]): void {
  const x = v[0],
    y = v[1],
    z = v[2],
    qx = q[0],
    qy = q[1],
    qz = q[2],
    qw = q[3],
    tx = 2 * (qy * z - qz * y),
    ty = 2 * (qz * x - qx * z),
    tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + qy * tz - qz * ty;
  out[1] = y + qw * ty + qz * tx - qx * tz;
  out[2] = z + qw * tz + qx * ty - qy * tx;
}
/**
 * Slerp from `a` to `b` by `n[FRACTION]` along the shorter arc into `out`, which may be `a` or `b` (as the package's
 * quaternionBlend). Unit inputs never cancel out.
 */
function blend(a: ArrayLike<number>, b: ArrayLike<number>, n: Float64Array, out: number[]): void {
  const weight = n[FRACTION];
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a[i] * b[i];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  let x = 1 - weight,
    y = weight;
  if (dot < 0.9995) {
    const angle = Math.acos(dot),
      s = Math.sin(angle);
    x = Math.sin((1 - weight) * angle) / s;
    y = Math.sin(weight * angle) / s;
  }
  const q0 = a[0] * x + b[0] * y * sign,
    q1 = a[1] * x + b[1] * y * sign,
    q2 = a[2] * x + b[2] * y * sign,
    q3 = a[3] * x + b[3] * y * sign;
  hypotTerms[0] = q0;
  hypotTerms[1] = q1;
  hypotTerms[2] = q2;
  hypotTerms[3] = q3;
  hypotOf(4);
  const length = hypotTerms[4];
  out[0] = q0 / length;
  out[1] = q1 / length;
  out[2] = q2 / length;
  out[3] = q3 / length;
}
/** `v` without its component along unit `axis`, normalised, into `out` (may be `v`); false when nothing is left. */
function reject(v: ArrayLike<number>, axis: ArrayLike<number>, out: number[]): boolean {
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  out[0] = v[0] - axis[0] * d;
  out[1] = v[1] - axis[1] * d;
  out[2] = v[2] - axis[2] * d;
  measure(out);
  const length = hypotTerms[4];
  if (!(length > 1e-9)) return false;
  out[0] /= length;
  out[1] /= length;
  out[2] /= length;
  return true;
}
/** Shortest-arc rotation from unit `a` to unit `b`, into `out`. */
function between(a: ArrayLike<number>, b: ArrayLike<number>, out: number[]): void {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -1 + 1e-12) {
    reject(Math.abs(a[0]) < 0.9 ? X_AXIS : Y_AXIS, a, out);
    out[3] = 0;
    return;
  }
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  out[3] = 1 + d;
  normalize(out, out);
}
/** `n[FRACTION]` of rotation `q` (slerp from identity), in place. */
function partial(q: number[], n: Float64Array): void {
  if (n[FRACTION] < 1) blend(IDENTITY, q, n, q);
}
/** Rotation of a world matrix with a positive uniform scale, into `out` (as rotationToQuaternion, normalized). */
function rotation(e: ArrayLike<number>, out: number[]): void {
  measure(e);
  const sx = hypotTerms[4];
  hypotTerms[0] = e[4];
  hypotTerms[1] = e[5];
  hypotTerms[2] = e[6];
  hypotOf(3);
  const sy = hypotTerms[4];
  hypotTerms[0] = e[8];
  hypotTerms[1] = e[9];
  hypotTerms[2] = e[10];
  hypotOf(3);
  const sz = hypotTerms[4];
  if (!(sx > 0) || Math.abs(sx - sy) > 1e-5 * sx || Math.abs(sx - sz) > 1e-5 * sx)
    throw new MargoError('state', 'Look-at bones need positive uniform scales; remove non-uniform scales above them');
  // Shepperd's method with quat-core's fixed branch rule: the trace when strictly positive, else the strictly largest
  // diagonal term, ties to the later axis.
  const m00 = e[0] / sx,
    m10 = e[1] / sx,
    m20 = e[2] / sx,
    m01 = e[4] / sy,
    m11 = e[5] / sy,
    m21 = e[6] / sy,
    m02 = e[8] / sz,
    m12 = e[9] / sz,
    m22 = e[10] / sz,
    trace = m00 + m11 + m22;
  if (trace > 0) {
    const r = Math.sqrt(1 + trace),
      f = 0.5 / r;
    out[0] = (m21 - m12) * f;
    out[1] = (m02 - m20) * f;
    out[2] = (m10 - m01) * f;
    out[3] = r / 2;
  } else if (m00 > m11 && m00 > m22) {
    const r = Math.sqrt(1 + m00 - m11 - m22),
      f = 0.5 / r;
    out[0] = r / 2;
    out[1] = (m01 + m10) * f;
    out[2] = (m02 + m20) * f;
    out[3] = (m21 - m12) * f;
  } else if (m11 > m22) {
    const r = Math.sqrt(1 + m11 - m00 - m22),
      f = 0.5 / r;
    out[0] = (m01 + m10) * f;
    out[1] = r / 2;
    out[2] = (m12 + m21) * f;
    out[3] = (m02 - m20) * f;
  } else {
    const r = Math.sqrt(1 + m22 - m00 - m11),
      f = 0.5 / r;
    out[0] = (m02 + m20) * f;
    out[1] = (m12 + m21) * f;
    out[2] = r / 2;
    out[3] = (m10 - m01) * f;
  }
  normalize(out, out);
}
