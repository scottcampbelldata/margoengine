import type { Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
const subtract = (a: Vec3, b: Vec3) => a.map((v, i) => v - b[i]) as [number, number, number];
/**
 * Analytical two-bone IK (a leg or an arm): places the knee and ankle so the ankle reaches `target`, bending the knee
 * toward `pole`. A target out of reach clamps to the limb's reach.
 * @param root The hip (or shoulder) position.
 * @param knee The knee (or elbow) position; its distance to `root` is the upper bone length.
 * @param ankle The ankle (or wrist) position; its distance to `knee` is the lower bone length.
 * @param target Where the ankle should go.
 * @param pole A point the knee bends toward; any point off the root-to-target line.
 * @returns The new knee and ankle positions (world space, same space as the inputs).
 * @throws RangeError when a bone has zero length; TypeError when a point is not three finite numbers.
 * @example
 * const {knee, ankle} = solveTwoBoneIK([0, 1, 0], [0, 0.5, 0.1], [0, 0, 0], [0, 0.2, 0.3], [0, 0.5, 1]);
 */
export function solveTwoBoneIK(
  root: Vec3,
  knee: Vec3,
  ankle: Vec3,
  target: Vec3,
  pole: Vec3,
): { knee: Vec3; ankle: Vec3 } {
  for (const v of [root, knee, ankle, target, pole]) finiteVector(v, 3, 'IK point');
  const upper = Math.hypot(...subtract(knee, root)),
    lower = Math.hypot(...subtract(ankle, knee));
  if (upper <= 1e-8 || lower <= 1e-8)
    throw new RangeError('IK bones have zero length; give root, knee and ankle three distinct positions');
  let axis = subtract(target, root),
    distance = Math.hypot(...axis);
  if (distance < 1e-8) {
    axis = subtract(ankle, root);
    distance = Math.hypot(...axis);
    if (distance < 1e-8) {
      axis = subtract(knee, root);
      distance = upper;
    }
  }
  axis = axis.map((v) => v / distance) as [number, number, number];
  const reach = Math.max(
    Math.abs(upper - lower) + 1e-8,
    Math.min(upper + lower - 1e-8, Math.hypot(...subtract(target, root))),
  );
  const bend = subtract(pole, root),
    dot = bend.reduce((sum, v, i) => sum + v * axis[i], 0);
  let normal = bend.map((v, i) => v - dot * axis[i]),
    length = Math.hypot(...normal);
  if (length < 1e-8) {
    const fallback = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0],
      d = fallback.reduce((sum, v, i) => sum + v * axis[i], 0);
    normal = fallback.map((v, i) => v - d * axis[i]);
    length = Math.hypot(...normal);
  }
  const along = (upper * upper + reach * reach - lower * lower) / (2 * reach),
    height = Math.sqrt(Math.max(0, upper * upper - along * along));
  return {
    knee: root.map((v, i) => v + axis[i] * along + (normal[i] / length) * height) as [number, number, number],
    ankle: root.map((v, i) => v + axis[i] * reach) as [number, number, number],
  };
}
export function rotationBetween(from: Vec3, to: Vec3): number[] {
  const aLength = Math.hypot(...from),
    bLength = Math.hypot(...to);
  if (aLength < 1e-8 || bLength < 1e-8) throw new RangeError('Zero IK direction; pass non-zero from and to vectors');
  const a = from.map((v) => v / aLength),
    b = to.map((v) => v / bLength),
    dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  let q = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + dot];
  if (dot < -0.999999) {
    const axis = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    q = [a[1] * axis[2] - a[2] * axis[1], a[2] * axis[0] - a[0] * axis[2], a[0] * axis[1] - a[1] * axis[0], 0];
  }
  const length = Math.hypot(...q);
  return q.map((v) => v / length);
}

// Anatomy for the solvers. A fitted body (an `AnatomicalRig` from `@margoengine/rigging/anatomy`) says, per joint, which
// way it turns and how far. The solvers of this package read it through the small shapes below, so this package needs
// no import from the rigging package. Written clean room from these papers (no other engine's or tool's source was read):
// - A limb is solved in closed form by its swivel angle: the hinge angle follows from the distance to the target alone,
//   and what is left is one turn of the whole limb about the line from its root to the target (D. Tolani, A. Goswami and
//   N. Badler, "Real-time inverse kinematics techniques for anthropomorphic limbs", Graphical Models 62(5):353-388,
//   2000). The pole only picks that turn, inside the range of the shoulder or hip (M. Kallmann, "Analytical inverse
//   kinematics with body posture control", Computer Animation and Virtual Worlds 19(2):79-91, 2008).
// - Each joint's turn is split into a swing of the bone and a twist about it (P. Baerlocher, "Inverse kinematics
//   techniques for the interactive posture control of articulated figures", EPFL thesis 2392, 2001; P. Dobrowolski,
//   "Swing-twist decomposition in Clifford algebra", arXiv:1506.05481, 2015), the swing read as a rotation vector (F. S.
//   Grassia, "Practical parameterization of rotations using the exponential map", J Graphics Tools 3(3):29-48, 1998)
//   and held inside an ellipse per quadrant (J. Wilhelms and A. Van Gelder, "Fast and easy reach-cone joint limits",
//   J Graphics Tools 6(2):27-41, 2001). The axes follow the ISB joint coordinate systems (G. Wu et al., J Biomech
//   35(4):543-548, 2002 and 38(5):981-992, 2005).
// - With no pole, a limb that is bent in the pose keeps the side it bends to, and a straight one takes the swivel that
//   leaves the shoulder or hip nearest its neutral, each angle counted as a share of its range: the least sum of
//   squares of those shares, the per-joint cost with its minimum at the comfortable angle that H. Cruse, E. Wischmeyer,
//   M. Bruwer, P. Brockfeld and A. Dress fitted to human arm postures ("On the cost functions for the control of the
//   human arm movement", Biological Cybernetics 62(6):519-528, 1990). An arm raised forward keeps its elbow down and
//   a lifted leg its knee forward, whatever pose the rig rests in.
// - A reach that eases in near full stretch, so a knee or elbow does not snap straight: the end follows the target by
//   an exponential over the last `soft` share of the limb's length (a smooth clamp of the distance, for the reason S. R.
//   Buss and J.-S. Kim clamp the error in "Selectively damped least squares for inverse kinematics", J Graphics Tools
//   10(3):37-49, 2005).

/** A range that opens with another motion of the same joint: a knee twists only when it is bent. */
export interface AnatomyGate {
  /** The motion that opens it: 0 the first swing, 1 the second, 2 the twist. */
  readonly by: number;
  /** Degrees of that motion at which the range is still shut. */
  readonly from: number;
  /** Degrees of that motion at which the range is fully open. */
  readonly to: number;
  /** Degrees each way that stay free when shut. */
  readonly floor: number;
}

/** One joint of a fitted body as a solver reads it. An `AnatomicalJoint` of `@margoengine/rigging/anatomy` is one. */
export interface AnatomyJoint {
  /** The joint's name in its species table. */
  readonly id: string;
  /** The bone that turns at this joint. */
  readonly bone: number;
  /** The bone its angles are measured against, -1 for none. */
  readonly reference: number;
  /** `hinge`, `ball` and so on. */
  readonly kind: string;
  /** Whether it has a range. */
  readonly limited: boolean;
  /** The three motion axes (first swing, second swing, twist) in the reference segment's anatomical frame. */
  readonly axes: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** The same axes in the bone's own local frame. */
  readonly boneAxes: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** The anatomical frame as a rotation in the bone's own local frame. */
  readonly frame: ArrayLike<number>;
  /** The reference segment's anatomical frame in the reference bone's local frame. */
  readonly referenceFrame: ArrayLike<number>;
  /** The bone's local rotation at anatomical zero. */
  readonly neutral: ArrayLike<number>;
  /** Clinical range: [min, max] of the first swing, the second swing and the twist, degrees. */
  readonly normal: ArrayLike<number>;
  /** The stops, in the same layout. */
  readonly structural: ArrayLike<number>;
  /** Its table entry; only a twist gate is read. */
  readonly spec: { readonly dofs?: ArrayLike<{ readonly gate?: AnatomyGate }> };
}

/** A run of joints that shares one range (the neck, the trunk). */
export interface AnatomyRegion {
  /** Its name. */
  readonly id: string;
  /** Indices into {@link Anatomy.joints}, the nearest to the body first. */
  readonly joints: readonly number[];
  /** The clinical range of the whole run. */
  readonly normal: ArrayLike<number>;
  /** The stops of the whole run. */
  readonly structural: ArrayLike<number>;
}

/** A fitted body as the solvers read it. An `AnatomicalRig` of `@margoengine/rigging/anatomy` is one. */
export interface Anatomy {
  /** False turns every limit off by name. */
  readonly limits: boolean;
  /** Parent bone per bone, -1 at the top. */
  readonly parents: readonly number[];
  /** The fitted joints. */
  readonly joints: readonly AnatomyJoint[];
  /** The shared regions that have a bone. */
  readonly regions: readonly AnatomyRegion[];
}

/** `normal` is the clinical range; `structural` is the stop no pose may pass. */
export type AnatomyTier = 'normal' | 'structural';

const BODIES = /* @__PURE__ */ new WeakMap<object, Anatomy>(),
  BONES = /* @__PURE__ */ new WeakMap<Anatomy, Map<number, AnatomyJoint>>();

/**
 * Says which fitted body an Animator, a Skeleton or a pose is, so every IK solver that works on it holds the body's
 * joint ranges from then on: elbows and knees bend the anatomical way and stop at their limits, and shoulders, hips,
 * the spine and the neck stay in range. Fit the body to the same bones, index for index. Pass null to forget it.
 * @example
 * setAnatomy(animator, fitAnatomy(rig, { species: human }));
 * @throws TypeError for an owner that is not an object or a body without joints.
 */
export function setAnatomy(owner: object, body: Anatomy | null): void {
  if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function'))
    throw new TypeError('setAnatomy needs the Animator, Skeleton or pose object the body belongs to');
  if (body === null) BODIES.delete(owner);
  else if (!Array.isArray(body?.joints) || !Array.isArray(body.parents))
    throw new TypeError('setAnatomy needs a body from fitAnatomy(rig, { species }) or null');
  else BODIES.set(owner, body);
}

/** The body {@link setAnatomy} gave `owner`, or null. */
export function anatomyOf(owner: object): Anatomy | null {
  return (owner && BODIES.get(owner)) || null;
}

/** The limited joint of `body` that turns `bone`, or null. */
export function jointOf(body: Anatomy, bone: number): AnatomyJoint | null {
  let map = BONES.get(body);
  if (!map) {
    map = new Map();
    for (const joint of body.joints) if (joint.limited && !map.has(joint.bone)) map.set(joint.bone, joint);
    BONES.set(body, map);
  }
  return map.get(bone) ?? null;
}

const DEG = 180 / Math.PI,
  RAD = Math.PI / 180;
type Four = number[] | Float64Array;

/** out = a b; with `ca` or `cb` that factor is conjugated. `out` may be a or b. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>, out: Four, ca = false, cb = false): Four {
  const sa = ca ? -1 : 1,
    sb = cb ? -1 : 1,
    ax = a[0] * sa,
    ay = a[1] * sa,
    az = a[2] * sa,
    aw = a[3],
    bx = b[0] * sb,
    by = b[1] * sb,
    bz = b[2] * sb,
    bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}
/** out = v turned by q. `out` may be v. */
function turnVector(q: ArrayLike<number>, v: ArrayLike<number>, out: number[]): [number, number, number] {
  const x = v[0],
    y = v[1],
    z = v[2],
    tx = 2 * (q[1] * z - q[2] * y),
    ty = 2 * (q[2] * x - q[0] * z),
    tz = 2 * (q[0] * y - q[1] * x);
  out[0] = x + q[3] * tx + (q[1] * tz - q[2] * ty);
  out[1] = y + q[3] * ty + (q[2] * tx - q[0] * tz);
  out[2] = z + q[3] * tz + (q[0] * ty - q[1] * tx);
  return out as never;
}
const scratch = /* @__PURE__ */ new Float64Array(8),
  near = [0, 0],
  angles = [0, 0, 0],
  relative = [0, 0, 0, 1];

/**
 * The turn of a joint's bone against its reference bone as clinical angles in degrees, into `out`: the two parts of
 * the swing (flexion and abduction for most joints) and the twist about the bone. Both rotations are world rotations
 * (x, y, z, w); pass [0, 0, 0, 1] for a joint with no reference. Allocates nothing.
 */
export function jointTurn(
  joint: Pick<AnatomyJoint, 'axes' | 'frame' | 'referenceFrame'>,
  reference: ArrayLike<number>,
  bone: ArrayLike<number>,
  out: number[] | Float64Array,
): void {
  const q = scratch;
  mul(reference, bone, q, true);
  mul(q, joint.frame, q);
  mul(joint.referenceFrame, q, q, true);
  let x = q[0],
    y = q[1],
    z = q[2],
    w = q[3];
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const F = joint.axes[0],
    A = joint.axes[1],
    T = joint.axes[2],
    p = x * T[0] + y * T[1] + z * T[2],
    n = Math.sqrt(p * p + w * w);
  let sx = x,
    sy = y,
    sz = z,
    sw = w,
    twist = 0;
  if (n > 1e-12) {
    // turn = swing * twist: the twist is the part about the long axis, the swing is what is left.
    twist = 2 * Math.atan2(p, w);
    const c = w / n,
      bx = (-T[0] * p) / n,
      by = (-T[1] * p) / n,
      bz = (-T[2] * p) / n;
    sx = w * bx + x * c + y * bz - z * by;
    sy = w * by - x * bz + y * c + z * bx;
    sz = w * bz + x * by - y * bx + z * c;
    sw = w * c - x * bx - y * by - z * bz;
  }
  const m = Math.sqrt(sx * sx + sy * sy + sz * sz),
    g = (m > 1e-12 ? (2 * Math.atan2(m, Math.abs(sw))) / m : 2) * DEG;
  out[0] = (sx * F[0] + sy * F[1] + sz * F[2]) * g;
  out[1] = (sx * A[0] + sy * A[1] + sz * A[2]) * g;
  out[2] = twist * DEG;
}

/**
 * The inverse of {@link jointTurn}: the bone's rotation relative to its reference bone (the reference's world rotation
 * times this is the bone's world rotation) for the angles `v` in degrees, into `out`. Allocates nothing.
 */
export function turnRotation(
  joint: Pick<AnatomyJoint, 'axes' | 'frame' | 'referenceFrame'>,
  v: ArrayLike<number>,
  out: number[] | Float64Array,
): void {
  const q = scratch,
    F = joint.axes[0],
    A = joint.axes[1],
    T = joint.axes[2],
    f = v[0] * RAD,
    a = v[1] * RAD,
    sx = f * F[0] + a * A[0],
    sy = f * F[1] + a * A[1],
    sz = f * F[2] + a * A[2],
    angle = Math.sqrt(sx * sx + sy * sy + sz * sz),
    half = Math.min(angle, Math.PI) / 2,
    k = angle > 1e-12 ? Math.sin(half) / angle : 0.5,
    h = (v[2] * RAD) / 2,
    s = Math.sin(h),
    c = Math.cos(h),
    // swing * twist, written out so nothing is allocated.
    ax = sx * k,
    ay = sy * k,
    az = sz * k,
    aw = Math.cos(half),
    bx = T[0] * s,
    by = T[1] * s,
    bz = T[2] * s;
  q[0] = aw * bx + ax * c + ay * bz - az * by;
  q[1] = aw * by - ax * bz + ay * c + az * bx;
  q[2] = aw * bz + ax * by - ay * bx + az * c;
  q[3] = aw * c - ax * bx - ay * by - az * bz;
  mul(joint.referenceFrame, q, out);
  mul(out, joint.frame, out, false, true);
  const l = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]) || 1;
  out[0] /= l;
  out[1] /= l;
  out[2] /= l;
  out[3] /= l;
}

/** The point of the ellipse with half axes a and b nearest to (p, q), all positive, into `near`. */
function nearestOnEllipse(p: number, q: number, a: number, b: number): void {
  // At the nearest point the offset is along the ellipse's normal: x = a^2 p / (t + a^2), y = b^2 q / (t + b^2) for
  // one t >= 0, found by bisection.
  let low = 0,
    high = Math.max(Math.SQRT2 * a * p - a * a, Math.SQRT2 * b * q - b * b, 0) + 1e-9;
  for (let i = 0; i < 64; i++) {
    const t = (low + high) / 2,
      x = (a * p) / (t + a * a),
      y = (b * q) / (t + b * b);
    if (x * x + y * y > 1) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  near[0] = (a * a * p) / (t + a * a);
  near[1] = (b * b * q) / (t + b * b);
}

/**
 * Brings the angles `v` (degrees, as {@link jointTurn} gives them) inside a joint's or a region's range, in place: the
 * twist inside its range (a gated twist by how far its gate is open) and the swing inside the ellipse of the quadrant
 * it is in. Returns true when any angle changed. Allocates nothing.
 * @param tier Which range. Default `structural`.
 */
export function clampTurn(
  item: Pick<AnatomyJoint, 'normal' | 'structural'> & { readonly spec?: AnatomyJoint['spec'] },
  v: number[] | Float64Array,
  tier: AnatomyTier = 'structural',
): boolean {
  const r = tier === 'normal' ? item.normal : item.structural,
    gate = item.spec?.dofs?.[2]?.gate;
  let changed = false;
  // The swing stays inside an ellipse whose half axes are the ranges of the quadrant it is in.
  const f = v[0],
    a = v[1],
    rf = f >= 0 ? r[1] : -r[0],
    ra = a >= 0 ? r[3] : -r[2];
  let nf = f,
    na = a;
  if (rf <= 0 && ra <= 0) nf = na = 0;
  else if (ra <= 0) {
    na = 0;
    nf = f < r[0] ? r[0] : f > r[1] ? r[1] : f;
  } else if (rf <= 0) {
    nf = 0;
    na = a < r[2] ? r[2] : a > r[3] ? r[3] : a;
  } else if ((f / rf) ** 2 + (a / ra) ** 2 > 1 + 1e-12) {
    nearestOnEllipse(Math.abs(f), Math.abs(a), rf, ra);
    nf = f < 0 ? -near[0] : near[0];
    na = a < 0 ? -near[1] : near[1];
  }
  if (Math.abs(nf - f) > 1e-7 || Math.abs(na - a) > 1e-7) {
    v[0] = nf;
    v[1] = na;
    changed = true;
  }
  // The twist, by how far its gate is open at the swing just settled: a gate read before the swing was brought in
  // would leave a twist that the next clamp narrows again.
  let low = r[4],
    high = r[5];
  if (gate) {
    const open = Math.min(1, Math.max(0, (v[gate.by] - gate.from) / (gate.to - gate.from)));
    low = -Math.min(-low, Math.max(gate.floor, -low * open));
    high = Math.min(high, Math.max(gate.floor, high * open));
  }
  const twist = v[2] < low ? low : v[2] > high ? high : v[2];
  if (Math.abs(twist - v[2]) > 1e-7) {
    v[2] = twist;
    changed = true;
  }
  return changed;
}

/**
 * Holds a bone's world rotation inside its joint's range: returns true and writes the nearest allowed world rotation
 * into `out` when `bone` is out of range, else returns false and leaves `out` alone. Allocates nothing.
 * @param reference World rotation of the joint's reference bone; [0, 0, 0, 1] when it has none.
 */
export function limitRotation(
  joint: AnatomyJoint,
  reference: ArrayLike<number>,
  bone: ArrayLike<number>,
  out: number[] | Float64Array,
  tier: AnatomyTier = 'structural',
): boolean {
  jointTurn(joint, reference, bone, angles);
  if (!clampTurn(joint, angles, tier)) return false;
  turnRotation(joint, angles, relative);
  mul(reference, relative, out);
  return true;
}

/** How {@link limitBones} reads and turns the bones of a posed skeleton. */
export interface BoneAccess {
  /** Writes bone `bone`'s world rotation (x, y, z, w) into `out`. */
  read(bone: number, out: number[]): void;
  /** Gives bone `bone` the world rotation `world`; a later `read` of it or of a bone below it must show the change. */
  write(bone: number, world: ArrayLike<number>): void;
}

const SPANS = /* @__PURE__ */ new WeakMap<AnatomyRegion, Pick<AnatomyJoint, 'axes' | 'frame' | 'referenceFrame'>>(),
  refQ = [0, 0, 0, 1],
  boneQ = [0, 0, 0, 1],
  heldQ = [0, 0, 0, 1],
  turnV = [0, 0, 0],
  wasV = [0, 0, 0],
  easeV = [1, 1, 1];

/**
 * Holds bones of a posed skeleton inside the body's ranges: each listed bone inside its own joint's range, the nearest
 * to the body first, then each shared run of joints (the trunk, the neck) that has one of them eased back together
 * while the run as a whole is past its range, so a bend is shared across the levels. Only listed bones are turned.
 * Returns true when a bone moved. Allocates nothing once a region has been seen.
 * @param bones Bone indices, parents before children.
 * @param tier Which range. Default `structural`.
 */
export function limitBones(
  body: Anatomy,
  bones: readonly number[],
  access: BoneAccess,
  tier: AnatomyTier = 'structural',
): boolean {
  let moved = false;
  const reference = (joint: AnatomyJoint): void => {
    if (joint.reference < 0) {
      refQ[0] = refQ[1] = refQ[2] = 0;
      refQ[3] = 1;
    } else access.read(joint.reference, refQ);
  };
  for (let i = 0; i < bones.length; i++) {
    const joint = jointOf(body, bones[i]);
    if (!joint) continue;
    reference(joint);
    access.read(joint.bone, boneQ);
    if (!limitRotation(joint, refQ, boneQ, heldQ, tier)) continue;
    access.write(joint.bone, heldQ);
    moved = true;
  }
  for (const region of body.regions) {
    let ours = false;
    for (let k = 0; k < region.joints.length && !ours; k++) ours = bones.includes(body.joints[region.joints[k]].bone);
    if (!ours) continue;
    const first = body.joints[region.joints[0]],
      last = body.joints[region.joints[region.joints.length - 1]];
    let span = SPANS.get(region);
    if (!span) {
      span = { axes: first.axes, frame: last.frame, referenceFrame: first.referenceFrame };
      SPANS.set(region, span);
    }
    for (let pass = 0; pass < 6; pass++) {
      reference(first);
      access.read(last.bone, boneQ);
      jointTurn(span, refQ, boneQ, turnV);
      for (let s = 0; s < 3; s++) wasV[s] = turnV[s];
      if (!clampTurn(region, turnV, tier)) break;
      for (let s = 0; s < 3; s++) easeV[s] = Math.abs(wasV[s]) > 1e-9 ? turnV[s] / wasV[s] : 1;
      for (let k = 0; k < region.joints.length; k++) {
        const joint = body.joints[region.joints[k]];
        if (!joint.limited || !bones.includes(joint.bone)) continue;
        reference(joint);
        access.read(joint.bone, boneQ);
        jointTurn(joint, refQ, boneQ, turnV);
        for (let s = 0; s < 3; s++) turnV[s] *= easeV[s];
        clampTurn(joint, turnV, tier);
        turnRotation(joint, turnV, heldQ);
        mul(refQ, heldQ, heldQ);
        access.write(joint.bone, heldQ);
      }
      moved = true;
    }
  }
  return moved;
}

/** A joint's range for a `CCDSolver` joint ({@link ccdLimit}). */
export interface AnatomyCCDLimit {
  /** The local rotation the limit is measured from. */
  neutral: [number, number, number, number];
  /** The limit, in the shape `CCDSolver.setLimit` takes. */
  limit:
    | { type: 'hinge'; axis: Vec3; min: number; max: number; twist?: { axis: Vec3; range: [number, number] } }
    | { type: 'cone'; angle: number; axis: Vec3; twist: [number, number] };
}

/**
 * A joint's range in the hinge and cone forms `CCDSolver` holds, with the local rotation they are measured from. A
 * hinge (elbow, knee, finger joint) is exact, with its twist, and stops at straight: a solver never bends a hinge
 * into the few degrees past straight that the structural tier allows a captured pose (`pastStraight` keeps them). A
 * joint that reaches further one way than the other gets the nearest cone: about the middle of its reach, as wide as
 * the wider half; {@link limitRotation} holds the exact reach.
 */
export function ccdLimit(joint: AnatomyJoint, tier: AnatomyTier = 'structural', pastStraight = false): AnatomyCCDLimit {
  const r = tier === 'normal' ? joint.normal : joint.structural,
    flex = joint.boneAxes[0],
    long = joint.boneAxes[2],
    twist: [number, number] = [r[4] * RAD, r[5] * RAD],
    neutral = Array.from(joint.neutral) as [number, number, number, number];
  if (joint.kind === 'hinge')
    return {
      neutral,
      limit: {
        type: 'hinge',
        axis: [flex[0], flex[1], flex[2]],
        min: (pastStraight ? r[0] : Math.min(Math.max(r[0], 0), r[1])) * RAD,
        max: r[1] * RAD,
        ...(twist[0] || twist[1] ? { twist: { axis: [long[0], long[1], long[2]] as Vec3, range: twist } } : {}),
      },
    };
  const f = ((r[0] + r[1]) / 2) * RAD,
    a = ((r[2] + r[3]) / 2) * RAD,
    F = joint.axes[0],
    A = joint.axes[1],
    s = [f * F[0] + a * A[0], f * F[1] + a * A[1], f * F[2] + a * A[2]],
    angle = Math.hypot(s[0], s[1], s[2]),
    k = angle > 1e-12 ? Math.sin(angle / 2) / angle : 0,
    middle = [s[0] * k, s[1] * k, s[2] * k, Math.cos(angle / 2)],
    turned = [0, 0, 0, 1];
  // The neutral rotation, then the middle of the reach in the bone's own frame.
  mul(joint.frame, middle, turned);
  mul(turned, joint.frame, turned, false, true);
  mul(joint.neutral, turned, turned);
  return {
    neutral: turned as [number, number, number, number],
    limit: {
      type: 'cone',
      angle: Math.min(Math.PI, (Math.max(r[1] - r[0], r[3] - r[2]) / 2) * RAD),
      axis: [long[0], long[1], long[2]],
      twist,
    },
  };
}

/** A limb for {@link solveLimbIK}: where its three joints are now, and the anatomy of its two turning joints. */
export interface LimbIK {
  /** World position of the shoulder or hip joint. */
  root: ArrayLike<number>;
  /** World position of the elbow or knee, in the pose being solved. */
  mid: ArrayLike<number>;
  /** World position of the wrist or ankle, in the pose being solved. */
  end: ArrayLike<number>;
  /** World rotation (x, y, z, w) of the upper bone, in the pose being solved. */
  upperRotation: ArrayLike<number>;
  /** World rotation of the lower bone, in the pose being solved. */
  lowerRotation: ArrayLike<number>;
  /** World point the end reaches for. */
  target: ArrayLike<number>;
  /** The elbow or knee: a hinge whose reference bone is the upper bone. */
  hinge: AnatomyJoint;
  /** The shoulder or hip; null or absent for no limit there. */
  ball?: AnatomyJoint | null;
  /** World rotation of the bone the shoulder or hip is measured against. Default [0, 0, 0, 1]. */
  reference?: ArrayLike<number>;
  /**
   * World point the elbow or knee leans toward, as far as the shoulder or hip allows. Default: the side the limb
   * already bends to in the pose; for a limb that is straight in the pose, the swivel that leaves the shoulder or hip
   * nearest its neutral (elbow down, knee forward).
   */
  pole?: ArrayLike<number> | null;
  /** Which range holds. Default `structural`. */
  tier?: AnatomyTier;
  /**
   * How deep the limb would be inside the body with its elbow or knee at `mid` and its end at `end` (world points), in
   * world units; 0 when clear. The swivel then keeps the limb out of the body as it keeps the shoulder or hip inside
   * its range: the nearest swivel to the wanted one that is clear of both. Default: no body volumes.
   */
  avoid?: ((mid: ArrayLike<number>, end: ArrayLike<number>) => number) | null;
  /** The elbow's or knee's twist, degrees, in place of the pose's. Default: the pose's twist. */
  twist?: number | null;
  /** Share of the limb's length over which the reach eases in before full stretch, 0-0.5 (default 0: exact). */
  soft?: number;
  /** Distance from the target that counts as reached (default 1e-4). */
  tolerance?: number;
}

/** What {@link solveLimbIK} found. */
export interface LimbIKResult {
  /** New world rotation of the upper bone. */
  upper: [number, number, number, number];
  /** New world rotation of the lower bone. */
  lower: [number, number, number, number];
  /** Where the elbow or knee now is. */
  mid: [number, number, number];
  /** Where the end now is. */
  end: [number, number, number];
  /** The hinge's flexion, degrees. */
  flexion: number;
  /** The end is within `tolerance` of the target. */
  reached: boolean;
  /** Distance from the end to the target. */
  distance: number;
  /** A joint stopped at its range short of a target that the bone lengths alone would reach. */
  held: boolean;
}

/**
 * Two-bone IK that obeys anatomy: bends an arm or a leg so its end reaches `target`. The elbow or knee turns only
 * about its own axis, the anatomical way, between straight and its stop, so a straight limb bends the right way and
 * never folds backwards. The whole limb then turns about the line from its root to the target (the swivel): toward
 * `pole` when one is given, else to the side the pose already bends to, else (a straight limb) to where the shoulder
 * or hip is nearest its neutral, so an arm raised forward keeps its elbow down whatever pose the rig rests in; and
 * always inside the shoulder's or hip's reach and twist. A target the ranges do not allow is approached as closely as they allow.
 * @example
 * const { upper, lower } = solveLimbIK({ root, mid, end, upperRotation, lowerRotation, target, hinge: knee, ball: hip, reference: pelvisRotation });
 * @throws RangeError for a bone of zero length, a hinge without a range, or `soft` outside 0-0.5.
 */
export function solveLimbIK(limb: LimbIK): LimbIKResult {
  const { hinge, ball = null } = limb,
    tier = limb.tier ?? 'structural',
    soft = limb.soft ?? 0,
    tolerance = limb.tolerance ?? 1e-4;
  for (const point of [limb.root, limb.mid, limb.end, limb.target]) finiteVector(point as Vec3, 3, 'IK point');
  if (limb.pole) finiteVector(limb.pole as Vec3, 3, 'IK pole');
  if (!hinge?.limited)
    throw new RangeError('solveLimbIK needs a hinge with a range: the elbow or knee of a fitted body');
  if (!(soft >= 0 && soft <= 0.5)) throw new RangeError('IK soft must be from 0 to 0.5 of the limb length');
  const root = limb.root,
    up = limb.upperRotation,
    low = limb.lowerRotation,
    // The bones as offsets in their own frames: root to mid in the upper bone, mid to end in the lower.
    a = turnVector([-up[0], -up[1], -up[2], up[3]], subtract(limb.mid as Vec3, root as Vec3), [0, 0, 0]),
    b = turnVector([-low[0], -low[1], -low[2], low[3]], subtract(limb.end as Vec3, limb.mid as Vec3), [0, 0, 0]),
    upperLength = Math.hypot(a[0], a[1], a[2]),
    lowerLength = Math.hypot(b[0], b[1], b[2]);
  if (upperLength <= 1e-8 || lowerLength <= 1e-8)
    throw new RangeError('IK bones have zero length; give root, mid and end three distinct positions');
  const range = tier === 'normal' ? hinge.normal : hinge.structural,
    v = [0, 0, 0],
    now = [0, 0, 0],
    bend = [0, 0, 0, 1],
    e = [0, 0, 0];
  jointTurn(hinge, up, low, now);
  if (limb.twist !== undefined && limb.twist !== null) {
    if (!Number.isFinite(limb.twist)) throw new RangeError('IK twist must be a finite number of degrees');
    now[2] = limb.twist;
  }
  /** The length from root to end with the hinge flexed `flexion` degrees; leaves the offset in `e` and the lower bone's turn in `bend`. */
  const span = (flexion: number): number => {
    v[0] = flexion;
    v[1] = now[1];
    v[2] = now[2];
    clampTurn(hinge, v, tier);
    turnRotation(hinge, v, bend);
    turnVector(bend, b, e);
    e[0] += a[0];
    e[1] += a[1];
    e[2] += a[2];
    return Math.hypot(e[0], e[1], e[2]);
  };
  // Never past straight: from straight (or the hinge's own stop, when that is bent) to the stop of full flexion.
  let lo = Math.max(range[0], 0);
  const hi = Math.max(lo, range[1]);
  // Where the limb is longest. A rig's bones seldom lie exactly on a line, so this can sit a little inside the range.
  for (let i = 0, top = hi; i < 48 && top - lo > 1e-9; i++) {
    const m1 = lo + (top - lo) / 3,
      m2 = top - (top - lo) / 3;
    if (span(m1) >= span(m2)) top = m2;
    else lo = m1;
  }
  const longest = span(lo),
    shortest = span(hi),
    to = subtract(limb.target as Vec3, root as Vec3),
    far = Math.hypot(to[0], to[1], to[2]),
    ease = soft * (upperLength + lowerLength);
  let wanted = far;
  if (ease > 0 && far > longest - ease) wanted = longest - ease * Math.exp(-(far - (longest - ease)) / ease);
  let flexion = lo;
  if (wanted <= shortest) flexion = hi;
  else if (wanted < longest) {
    // The span falls as the hinge bends: bisect for the flexion that spans the distance.
    let from = lo,
      until = hi;
    for (let i = 0; i < 60; i++) {
      const middle = (from + until) / 2;
      if (span(middle) > wanted) from = middle;
      else until = middle;
    }
    flexion = (from + until) / 2;
  }
  const length = span(flexion),
    hingeTurn = bend.slice(),
    reach = [e[0], e[1], e[2]],
    // The line the limb lies along: toward the target, or where it points now when the target is on the root.
    line =
      far > 1e-9
        ? [to[0] / far, to[1] / far, to[2] / far]
        : turnVector(up, [reach[0] / length, reach[1] / length, reach[2] / length], [0, 0, 0]),
    pointing = turnVector(up, reach, [0, 0, 0]),
    base = mul(rotationBetween(pointing, line as [number, number, number]), up, [0, 0, 0, 1]),
    upper = [0, 0, 0, 1],
    spin = [0, 0, 0, 1],
    reference = limb.reference ?? [0, 0, 0, 1],
    w = [0, 0, 0],
    kept = [0, 0, 0],
    avoid = limb.avoid ?? null,
    at = [0, 0, 0],
    tipAt = [0, 0, 0];
  /** Degrees of swivel-equivalent cost for the limb inside the body: its depth as an angle seen from the root. */
  const inside = (): number => {
    if (!avoid) return 0;
    turnVector(upper, a, at);
    turnVector(upper, reach, tipAt);
    for (let i = 0; i < 3; i++) {
      at[i] += root[i];
      tipAt[i] += root[i];
    }
    const depth = avoid(at, tipAt);
    return depth > 0 ? (depth / upperLength) * DEG : 0;
  };
  /**
   * Turns the upper bone `phi` about the line, into `upper`; returns how far outside its range the shoulder or hip
   * then is, degrees, plus how deep the limb then is inside the body as an angle.
   */
  const outside = (phi: number): number => {
    const s = Math.sin(phi / 2);
    spin[0] = line[0] * s;
    spin[1] = line[1] * s;
    spin[2] = line[2] * s;
    spin[3] = Math.cos(phi / 2);
    mul(spin, base, upper);
    const body = inside();
    if (!ball?.limited) return body;
    jointTurn(ball, reference, upper, w);
    kept[0] = w[0];
    kept[1] = w[1];
    kept[2] = w[2];
    if (!clampTurn(ball, w, tier)) return body;
    return Math.hypot(w[0] - kept[0], w[1] - kept[1], w[2] - kept[2]) + body;
  };
  // The swivel the pole asks for: the side the elbow or knee is on (for a straight limb, the side it would bend to)
  // turned onto the pole's side of the line.
  let phi = 0;
  // No pole: a limb bent more than 5 degrees in the pose keeps the side it bends to.
  const pole = limb.pole ?? (now[0] > 5 ? limb.mid : null);
  if (pole) {
    const side = turnVector(base, a, [0, 0, 0]),
      along = side[0] * line[0] + side[1] * line[1] + side[2] * line[2];
    side[0] -= line[0] * along;
    side[1] -= line[1] * along;
    side[2] -= line[2] * along;
    if (Math.hypot(side[0], side[1], side[2]) < 1e-3 * upperLength) {
      // Straight: flexing turns the lower bone about the hinge's axis, which moves the joint off the line this way.
      const axis = turnVector(hinge.referenceFrame, hinge.axes[0], [0, 0, 0]),
        off = [
          reach[1] * axis[2] - reach[2] * axis[1],
          reach[2] * axis[0] - reach[0] * axis[2],
          reach[0] * axis[1] - reach[1] * axis[0],
        ];
      turnVector(base, off, side);
      const lean = side[0] * line[0] + side[1] * line[1] + side[2] * line[2];
      side[0] -= line[0] * lean;
      side[1] -= line[1] * lean;
      side[2] -= line[2] * lean;
    }
    const p = subtract(pole as Vec3, root as Vec3),
      onLine = p[0] * line[0] + p[1] * line[1] + p[2] * line[2];
    p[0] -= line[0] * onLine;
    p[1] -= line[1] * onLine;
    p[2] -= line[2] * onLine;
    if (Math.hypot(p[0], p[1], p[2]) > 1e-9 && Math.hypot(side[0], side[1], side[2]) > 1e-12)
      phi = Math.atan2(
        line[0] * (side[1] * p[2] - side[2] * p[1]) +
          line[1] * (side[2] * p[0] - side[0] * p[2]) +
          line[2] * (side[0] * p[1] - side[1] * p[0]),
        side[0] * p[0] + side[1] * p[1] + side[2] * p[2],
      );
  }
  /**
   * The swivel that leaves the shoulder or hip nearest its neutral, each angle as a share of its clinical range (a
   * swivel outside the stops costs far more): an arm's elbow down, a leg's knee forward.
   */
  const comfortable = (ball: AnatomyJoint): number => {
    const comfort = ball.normal,
      TEN = Math.PI / 18,
      cost = (at: number): number => {
        const over = outside(at);
        let sum = over * over * 100;
        for (let s = 0; s < 3; s++) {
          const bound = kept[s] >= 0 ? comfort[s * 2 + 1] : -comfort[s * 2];
          sum += (kept[s] / (bound > 1 ? bound : 1)) ** 2;
        }
        return sum;
      };
    let nearest = 0,
      least = cost(0);
    for (let k = 1; k < 36; k++) {
      const c = cost(k * TEN);
      if (c < least) {
        least = c;
        nearest = k * TEN;
      }
    }
    let from = nearest - TEN,
      until = nearest + TEN;
    for (let i = 0; i < 30; i++) {
      const m1 = from + (until - from) / 3,
        m2 = until - (until - from) / 3;
      if (cost(m1) <= cost(m2)) until = m2;
      else from = m1;
    }
    return (from + until) / 2;
  };
  // A straight limb and no pole: the comfortable swivel.
  if (!pole && ball?.limited) phi = comfortable(ball);
  let stopped = false;
  if (outside(phi) > 1e-6) {
    // The nearest swivel the shoulder or hip allows, searched outward from the wanted one in 5 degree steps.
    const STEP = (5 * Math.PI) / 180;
    let found = Number.NaN,
      edge = phi,
      best = phi,
      least = outside(phi);
    for (let k = 1; k <= 36 && Number.isNaN(found); k++)
      for (const sign of [1, -1]) {
        const at = phi + sign * k * STEP,
          over = outside(at);
        if (over <= 1e-6) {
          found = at;
          edge = phi + sign * (k - 1) * STEP;
          break;
        }
        if (over < least) {
          least = over;
          best = at;
        }
      }
    // A pole more than a right angle from every swivel the shoulder or hip allows is on the side the elbow or knee
    // cannot face (a pole behind a knee): its nearest allowed swivel is the joint's stop, a knee turned out as far as
    // the hip turns. The pole is then left out and the limb takes its comfortable swivel (KB-ANIM-POLEBEHIND1).
    if (pole && ball?.limited && !Number.isNaN(found) && Math.abs(found - phi) > Math.PI / 2) {
      phi = comfortable(ball);
      if (outside(phi) <= 1e-6) found = Number.NaN;
    }
    if (Number.isNaN(found) && outside(phi) <= 1e-6) {
      // The comfortable swivel fits: nothing to search.
    } else if (!Number.isNaN(found)) {
      // Back toward the wanted swivel as far as the range lets it.
      for (let i = 0; i < 24; i++) {
        const middle = (found + edge) / 2;
        if (outside(middle) <= 1e-6) found = middle;
        else edge = middle;
      }
      outside(found);
    } else {
      // No swivel fits: take the one that is least outside, then stop the joint at its range.
      let from = best - STEP,
        until = best + STEP;
      for (let i = 0; i < 32; i++) {
        const m1 = from + (until - from) / 3,
          m2 = until - (until - from) / 3;
        if (outside(m1) <= outside(m2)) until = m2;
        else from = m1;
      }
      outside((from + until) / 2);
      // Only a shoulder or hip past its range is stopped; a limb that only touches the body keeps its swivel.
      if (ball?.limited) {
        jointTurn(ball, reference, upper, w);
        stopped = clampTurn(ball, w, tier);
        turnRotation(ball, w, spin);
        mul(reference, spin, upper);
      }
    }
  }
  const lower = mul(upper, hingeTurn, [0, 0, 0, 1]) as [number, number, number, number],
    mid = turnVector(upper, a, [0, 0, 0]),
    tip = turnVector(upper, reach, [0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    mid[i] += root[i];
    tip[i] += root[i];
  }
  const distance = Math.hypot(tip[0] - limb.target[0], tip[1] - limb.target[1], tip[2] - limb.target[2]);
  return {
    upper: [upper[0], upper[1], upper[2], upper[3]],
    lower,
    mid: mid as [number, number, number],
    end: tip as [number, number, number],
    flexion,
    reached: distance <= tolerance,
    distance,
    held:
      stopped || (distance > tolerance && far < upperLength + lowerLength && far > Math.abs(upperLength - lowerLength)),
  };
}
