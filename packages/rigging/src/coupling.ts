// Coupled motion: the joints that move with another one in a real body, driven from it on any fitted rig. The shoulder
// blade and collarbone rise with the arm, a forearm's skin twists along its length with the hand, the last joint of a
// finger curls with the middle one, a trunk or neck bend is shared by its levels, and a straightening knee screws home.
// Every number is a coupling of the species table (`human.couplings`), with its source; this file knows no species.
//
// A rule fills in what the pose leaves out: a follower the pose holds at its rest or its anatomical neutral is driven
// from its driver, by the change of the driver from the same base, so the rest pose stays the rest pose and a clip that
// moves the follower itself keeps its own motion. The shoulder's angles are read against the thorax, so the arm keeps
// its direction while the girdle under it moves.
//
// Method, written clean room from these papers (no other engine's or tool's source was read):
// - Shoulder girdle: Inman, Saunders and Abbott, "Observations on the function of the shoulder joint", J Bone Joint
//   Surg 26(1):1-30, 1944 (the 2:1 rhythm, the clavicle turning mostly past 90 degrees); Ludewig et al., "Motion of the
//   shoulder complex during multiplanar humeral elevation", J Bone Joint Surg Am 91(2):378-389, 2009 (bone pins: the
//   clavicle's elevation, retraction and posterior rotation, the scapula's turns on the clavicle); McClure et al.,
//   "Direct 3-dimensional measurement of scapular kinematics during dynamic movements in vivo", J Shoulder Elbow Surg
//   10(3):269-277, 2001.
// - Limb twist: the radius turns about the ulna along the whole forearm (Kapandji, The Physiology of the Joints, vol 1),
//   so the skin twists from none at the elbow to all of it at the wrist; a twist bone carries the share of its place.
// - Knee screw-home: Kim et al., "Screw-home movement of the tibiofemoral joint during normal gait", Clin Orthop Surg
//   7(3):303-309, 2015, with the RSA range of Karrholm et al. it reports.
// - Spine: White and Panjabi, Clinical Biomechanics of the Spine, 1990, and the level weights of the table.
// - Fingers: Rijpkema and Girard, "Computer animation of knowledge-based human grasping", SIGGRAPH 1991.
import type { Animator } from '@margoengine/animator';
import {
  type AnatomicalJoint,
  type AnatomicalRig,
  type CouplingHook,
  poseFromAngles,
  readJointAngles,
} from './anatomy.js';
import { parentOrder, worldFrames } from './rig.js';

/** Which rules {@link couplePose} applies. Each defaults to true when the species has its coupling. */
export interface CouplingOptions {
  /** The shoulder blade and collarbone follow arm elevation (`shoulder-girdle`). */
  readonly girdle?: boolean;
  /** Twist bones carry their share of a limb segment's twist (`limb-twist`). */
  readonly twist?: boolean;
  /** The last joint of a finger follows the middle one (`finger-curl`). */
  readonly fingers?: boolean;
  /** A bend held by one level of the trunk or neck is shared by every level (`spine-share`). */
  readonly spine?: boolean;
  /** The tibia turns inward as a straight knee bends and outward as it locks (`screw-home`). */
  readonly knee?: boolean;
}

/** What {@link couplePose} drove: one entry per follower. */
export interface CouplingIssue {
  /** The coupling's id in the species table. */
  readonly rule: string;
  /** The joint or bone that followed. */
  readonly follower: string;
  /** The joint that drove it. */
  readonly driver: string;
}

type Q4 = [number, number, number, number];
type V3 = [number, number, number];
const qmul = (a: ArrayLike<number>, b: ArrayLike<number>): Q4 => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: ArrayLike<number>): Q4 => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q: ArrayLike<number>, v: ArrayLike<number>): V3 => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
};
const qaxis = (axis: V3, angle: number): Q4 => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const unit = (v: V3): V3 | null => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
};
/** The twist of `q` about the unit `axis`, in radians (swing and twist: Dobrowolski 2015). */
const twistAngle = (q: Q4, axis: V3): number => {
  const along = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  let angle = 2 * Math.atan2(along, q[3]);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
};
const local = (pose: ArrayLike<number>, bone: number): Q4 => [
  pose[bone * 10 + 3],
  pose[bone * 10 + 4],
  pose[bone * 10 + 5],
  pose[bone * 10 + 6],
];
/** Whether a bone's local rotation in `pose` is the one in `base`. */
const same = (pose: ArrayLike<number>, base: ArrayLike<number>, bone: number): boolean => {
  const o = bone * 10 + 3;
  const d = pose[o] * base[o] + pose[o + 1] * base[o + 1] + pose[o + 2] * base[o + 2] + pose[o + 3] * base[o + 3];
  return Math.abs(d) > 1 - 1e-9;
};

/** A curve of rows [x, a, b, ...]: straight between rows, held past the ends. */
function curveAt(curve: readonly (readonly number[])[], x: number, column: number): number {
  if (x <= curve[0][0]) return curve[0][column];
  for (let k = 1; k < curve.length; k++)
    if (x <= curve[k][0]) {
      const a = curve[k - 1],
        b = curve[k];
      return a[column] + ((x - a[0]) / (b[0] - a[0])) * (b[column] - a[column]);
    }
  return curve.at(-1)![column];
}
const ramp = (x: number, from: number, to: number): number => Math.min(1, Math.max(0, (x - from) / (to - from)));

interface Girdle {
  readonly shoulder: number;
  readonly clavicle: number;
  readonly scapula: number;
  readonly curve: readonly (readonly number[])[];
  readonly values: Readonly<Record<string, number>>;
}
interface Twist {
  readonly bone: number;
  readonly name: string;
  readonly driver: string;
  /** The bone whose turn is measured, and the bone it is measured against. */
  readonly turned: number;
  readonly against: number;
  /** The rest rotation of `turned` in the frame of `against`, and the segment's axis in `turned`'s own rest frame. */
  readonly rest: Q4;
  readonly axis: V3;
  /** The segment's axis in the twist bone's own rest frame. */
  readonly own: V3;
  /** The share of the measured twist the twist bone turns by, against its parent. */
  readonly share: number;
}
interface Plan {
  readonly girdles: readonly Girdle[];
  readonly twists: readonly Twist[];
  readonly fingers: readonly (readonly [number, number, number])[];
  readonly knees: readonly { readonly joint: number; readonly rotation: number; readonly over: number }[];
  readonly spines: readonly (readonly number[])[];
  readonly hooks: ReadonlyMap<string, CouplingHook>;
  readonly angles: Float64Array;
  readonly base: Float64Array;
}
const PLANS = new WeakMap<AnatomicalRig, Plan>();

/** Every fitted joint of a hook's id and its mirror, by index into `body.joints`; only joints with a bone of their own. */
function both(body: AnatomicalRig, id: string): number[] {
  const spec = body.species.joints.find((joint) => joint.id === id),
    out: number[] = [];
  for (const each of [id, spec?.mirror]) {
    if (!each) continue;
    const k = body.index.get(each);
    if (k !== undefined && body.joints[k].id === each && body.joints[k].limited) out.push(k);
  }
  return out;
}
const mirrorOf = (body: AnatomicalRig, id: string): string =>
  body.species.joints.find((joint) => joint.id === id)?.mirror ?? id;

function planOf(body: AnatomicalRig): Plan {
  const known = PLANS.get(body);
  if (known) return known;
  const hooks = new Map(body.species.couplings.map((hook) => [hook.id, hook])),
    joints = body.joints,
    n = body.names.length,
    order = parentOrder(body.parents, 'Rig'),
    frames = worldFrames(body.parents, body.rest, order),
    P = (bone: number): V3 => [frames.position[bone * 3], frames.position[bone * 3 + 1], frames.position[bone * 3 + 2]],
    W = (bone: number): Q4 => [
      frames.rotation[bone * 4],
      frames.rotation[bone * 4 + 1],
      frames.rotation[bone * 4 + 2],
      frames.rotation[bone * 4 + 3],
    ];

  const girdles: Girdle[] = [],
    girdle = hooks.get('shoulder-girdle');
  if (girdle && girdle.joints.length >= 2)
    for (const shoulder of both(body, girdle.joints[0])) {
      const side = joints[shoulder].id === girdle.joints[0] ? (id: string) => id : (id: string) => mirrorOf(body, id),
        clavicle = body.index.get(side(girdle.joints[1])),
        scapula = girdle.joints[2] === undefined ? undefined : body.index.get(side(girdle.joints[2]));
      if (clavicle === undefined || joints[clavicle].id !== side(girdle.joints[1]) || !joints[clavicle].limited) continue;
      const curve = joints[clavicle].spec.rhythm?.curve;
      if (!curve) continue;
      girdles.push({
        shoulder,
        clavicle,
        scapula:
          scapula !== undefined && joints[scapula].id === side(girdle.joints[2]!) && joints[scapula].limited
            ? scapula
            : -1,
        curve,
        values: girdle.values,
      });
    }

  // Twist bones: bones that are no joint of the table, under a limb segment's bone (through other such bones), lying
  // along the segment between its two ends. On a segment whose far joint spills its twist into it (a forearm under its
  // hand) a twist bone takes its place's share of the far joint's twist; otherwise of the segment's own twist, undone
  // toward its root.
  const twists: Twist[] = [],
    spread = hooks.get('limb-twist'),
    mapped = new Set(joints.map((joint) => joint.bone));
  if (spread)
    for (const id of spread.joints)
      for (const k of both(body, id)) {
        const joint = joints[k],
          segment = joint.bone,
          far = joints.find((other) => other.reference === segment && other.limited && body.parents[other.bone] >= 0);
        if (!far) continue;
        const a = P(segment),
          d: V3 = [P(far.bone)[0] - a[0], P(far.bone)[1] - a[1], P(far.bone)[2] - a[2]],
          length2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2],
          way = unit(d);
        if (!way || !(length2 > 0)) continue;
        const spills = !!far.spec.dofs?.[2].spill;
        for (let b = 0; b < n; b++) {
          if (mapped.has(b)) continue;
          let up = body.parents[b];
          while (up >= 0 && up !== segment && !mapped.has(up)) up = body.parents[up];
          if (up !== segment) continue;
          const r: V3 = [P(b)[0] - a[0], P(b)[1] - a[1], P(b)[2] - a[2]],
            t = (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / length2,
            off: V3 = [r[0] - d[0] * t, r[1] - d[1] * t, r[2] - d[2] * t];
          if (!(t > 0.02 && t < 0.98) || off[0] * off[0] + off[1] * off[1] + off[2] * off[2] > 0.0225 * length2) continue;
          // A twist bone carries its share of the hand's twist when the hand turns on a still forearm; otherwise it
          // undoes the share of the segment's own twist that its place does not have.
          const distal = spills,
            turned = distal ? far.bone : segment,
            against = distal ? segment : body.parents[segment];
          if (against < 0) continue;
          const rest = qmul(qconj(W(against)), W(turned)),
            axis = qrot(qconj(W(turned)), way),
            own = qrot(qconj(W(b)), way);
          twists.push({
            bone: b,
            name: body.names[b],
            driver: distal ? far.id : joint.id,
            turned,
            against,
            rest,
            axis,
            own,
            share: (distal ? t : t - 1) * (spread.values.spread ?? 1),
          });
        }
      }

  const fingers: [number, number, number][] = [],
    curl = hooks.get('finger-curl');
  if (curl)
    for (let i = 0; i + 1 < curl.joints.length; i += 2)
      for (const middle of both(body, curl.joints[i])) {
        const id = joints[middle].id === curl.joints[i] ? curl.joints[i + 1] : mirrorOf(body, curl.joints[i + 1]),
          last = body.index.get(id);
        if (last !== undefined && joints[last].id === id && joints[last].limited)
          fingers.push([middle, last, curl.values.ratio ?? 2 / 3]);
      }

  const knees: { joint: number; rotation: number; over: number }[] = [],
    screw = hooks.get('screw-home');
  if (screw)
    for (const id of screw.joints)
      for (const k of both(body, id))
        knees.push({ joint: k, rotation: screw.values.rotation ?? 0, over: screw.values.over ?? 20 });

  const spines = hooks.has('spine-share')
    ? body.regions.filter((region) => region.joints.length >= 2).map((region) => region.joints)
    : [];

  const plan: Plan = {
    girdles,
    twists,
    fingers,
    knees,
    spines,
    hooks,
    angles: new Float64Array(joints.length * 3),
    base: new Float64Array(joints.length * 3),
  };
  PLANS.set(body, plan);
  return plan;
}

/**
 * Where a follower stands: at its rest, at anatomical neutral, or moved by the pose (null). A follower whose rest is its
 * neutral takes the base of its driver: the rest when the driver is at rest, neutral otherwise (its zero is the pose of
 * the arm at the side, the finger straight, the knee locked).
 */
const baseOf = (body: AnatomicalRig, pose: ArrayLike<number>, bone: number, driver = -1): 'rest' | 'neutral' | null => {
  const rest = same(pose, body.rest, bone),
    neutral = same(pose, body.neutral, bone);
  if (rest && neutral) return driver >= 0 && same(pose, body.rest, driver) ? 'rest' : 'neutral';
  return rest ? 'rest' : neutral ? 'neutral' : null;
};

/** A joint's angles in the rest pose, or zeros at neutral, by index into `body.joints`. */
const baseAngles = (joint: AnatomicalJoint, base: 'rest' | 'neutral'): [number, number, number] =>
  base === 'rest' ? [joint.rest.flexion, joint.rest.abduction, joint.rest.rotation] : [0, 0, 0];

/**
 * Moves the joints a real body moves together with another, in place: the shoulder blade and collarbone with arm
 * elevation (the arm keeps its direction against the thorax), twist bones with their limb's twist, the last finger
 * joint with the middle one, the levels of the trunk and neck with a bend one level holds (the top of the run keeps
 * its turn), and the tibia with knee extension. A follower the pose moves itself is left as it is, so the rest pose and
 * a clip that animates the follower are unchanged. Run it before `clampPose`, which then holds the result in range.
 * @example
 * const pose = poseFromAngles(body, { l_shoulder: { abduction: 170 } });
 * couplePose(body, pose); // the left collarbone rises and draws back, the shoulder blade turns up
 * @param pose A local pose, 10 numbers per bone, edited in place.
 * @param issues An array that receives one entry per follower driven.
 * @returns How many followers were driven.
 * @throws TypeError for a pose that is not a Float64Array of the right length.
 */
export function couplePose(
  body: AnatomicalRig,
  pose: Float64Array,
  options: CouplingOptions = {},
  issues?: CouplingIssue[],
): number {
  if (!(pose instanceof Float64Array) || pose.length !== body.names.length * 10)
    throw new TypeError('couplePose needs a local pose as a Float64Array with 10 numbers per bone');
  const plan = planOf(body),
    joints = body.joints,
    angles = readJointAngles(body, pose, plan.angles);
  let count = 0;
  const note = (rule: string, follower: string, driver: string) => {
    count++;
    issues?.push({ rule, follower, driver });
  };
  const targets: Record<string, { flexion?: number; abduction?: number; rotation?: number }> = {};
  const set = (k: number, v: readonly number[]) =>
    (targets[joints[k].id] = { flexion: v[0], abduction: v[1], rotation: v[2] });

  // The shoulder girdle: the collarbone (and a shoulder blade, where the rig has one) rides on the arm's elevation
  // against the thorax, from the same base the follower holds; the shoulder is then written back with its own angles
  // against the thorax, so the arm points where it did.
  if (options.girdle !== false)
    for (const g of plan.girdles) {
      const clavicle = joints[g.clavicle],
        base = baseOf(body, pose, clavicle.bone, joints[g.shoulder].bone);
      if (!base) continue;
      const lift = (k: number, from: Float64Array) => Math.hypot(from[k * 3], from[k * 3 + 1]),
        now = lift(g.shoulder, angles),
        shoulder = joints[g.shoulder],
        was = base === 'rest' ? Math.hypot(shoulder.rest.flexion, shoulder.rest.abduction) : 0;
      if (Math.abs(now - was) < 1e-6) continue;
      const v = g.values,
        roll = (x: number) =>
          (v.clavicleRoll ?? 0) * ramp(x, v.clavicleRollFrom ?? 90, v.clavicleRollTo ?? 180),
        b = baseAngles(clavicle, base);
      set(g.clavicle, [
        b[0] + curveAt(g.curve, now, 1) - curveAt(g.curve, was, 1),
        b[1] - (curveAt(g.curve, now, 2) - curveAt(g.curve, was, 2)),
        b[2] + roll(now) - roll(was),
      ]);
      note('shoulder-girdle', clavicle.id, shoulder.id);
      if (g.scapula >= 0) {
        const scapula = joints[g.scapula],
          sb = baseOf(body, pose, scapula.bone, joints[g.shoulder].bone);
        if (sb) {
          const s = (x: number) => ramp(x, v.scapulaFrom ?? 30, v.scapulaTo ?? 120),
            d = s(now) - s(was),
            bs = baseAngles(scapula, sb);
          set(g.scapula, [
            bs[0] + (v.scapulaUpward ?? 0) * d,
            bs[1] + (v.scapulaInternal ?? 0) * d,
            bs[2] + (v.scapulaTilt ?? 0) * d,
          ]);
          note('shoulder-girdle', scapula.id, shoulder.id);
        }
      }
      set(g.shoulder, [angles[g.shoulder * 3], angles[g.shoulder * 3 + 1], angles[g.shoulder * 3 + 2]]);
    }

  // The last joint of a finger follows the middle one, from the same base.
  if (options.fingers !== false)
    for (const [middle, last, ratio] of plan.fingers) {
      const tip = joints[last],
        base = baseOf(body, pose, tip.bone, joints[middle].bone);
      if (!base) continue;
      const mid = joints[middle],
        from = baseAngles(mid, base)[0],
        change = angles[middle * 3] - from;
      if (Math.abs(change) < 1e-6) continue;
      const b = baseAngles(tip, base);
      set(last, [b[0] + ratio * change, b[1], b[2]]);
      note('finger-curl', tip.id, mid.id);
    }

  // The knee screws home: a knee whose twist the pose leaves at its base turns inward as it bends off straight.
  if (options.knee !== false)
    for (const { joint: k, rotation, over } of plan.knees) {
      const knee = joints[k],
        rest = [knee.rest.flexion, knee.rest.abduction, knee.rest.rotation],
        twist = angles[k * 3 + 2],
        base = Math.abs(twist - rest[2]) < 1e-3 ? 'rest' : Math.abs(twist) < 1e-3 ? 'neutral' : null;
      if (!base) continue;
      const b = base === 'rest' ? rest : [0, 0, 0],
        turn = rotation * (ramp(angles[k * 3], 0, over) - ramp(b[0], 0, over));
      if (Math.abs(turn) < 1e-6) continue;
      set(k, [angles[k * 3], angles[k * 3 + 1], b[2] + turn]);
      note('screw-home', knee.id, knee.id);
    }

  let out = Object.keys(targets).length ? poseFromAngles(body, targets, pose) : pose;

  // A bend one level of the trunk or neck holds is shared by every level of the run, each by its range; the top level
  // is then turned so the top of the run keeps its turn in the world.
  if (options.spine !== false)
    for (const run of plan.spines) {
      const moved = run.filter((k) => !baseOf(body, out, joints[k].bone));
      if (moved.length !== 1) continue;
      const bases = run.map((k) => baseOf(body, out, joints[k].bone) ?? 'rest'),
        now = readJointAngles(body, out, plan.base),
        weight = [0, 1, 2].map((s) => run.reduce((sum, k) => sum + joints[k].normal[s * 2 + 1] - joints[k].normal[s * 2], 0)),
        total = [0, 1, 2].map((s) =>
          run.reduce((sum, k, i) => sum + now[k * 3 + s] - baseAngles(joints[k], bases[i])[s], 0),
        );
      if (Math.hypot(...total) < 1e-6) continue;
      const order = parentOrder(body.parents, 'Rig'),
        top = joints[run.at(-1)!],
        kept = worldFrames(body.parents, out, order).rotation.slice(top.bone * 4, top.bone * 4 + 4);
      const shares: Record<string, { flexion: number; abduction: number; rotation: number }> = {};
      run.forEach((k, i) => {
        if (k === run.at(-1)) return;
        const b = baseAngles(joints[k], bases[i]),
          w = (s: number) => (weight[s] > 0 ? (joints[k].normal[s * 2 + 1] - joints[k].normal[s * 2]) / weight[s] : 0);
        shares[joints[k].id] = { flexion: b[0] + w(0) * total[0], abduction: b[1] + w(1) * total[1], rotation: b[2] + w(2) * total[2] };
        note('spine-share', joints[k].id, joints[moved[0]].id);
      });
      out = poseFromAngles(body, shares, out);
      const parent = body.parents[top.bone],
        above = parent < 0 ? [0, 0, 0, 1] : worldFrames(body.parents, out, order).rotation.slice(parent * 4, parent * 4 + 4);
      out.set(qmul(qconj(above), kept), top.bone * 10 + 3);
      if (top !== joints[moved[0]]) note('spine-share', top.id, joints[moved[0]].id);
    }

  // Twist bones carry their share of their segment's twist, measured from the rest.
  if (options.twist !== false && plan.twists.length) {
    const rotation = worldFrames(body.parents, out, parentOrder(body.parents, 'Rig')).rotation,
      world = (bone: number): Q4 => [rotation[bone * 4], rotation[bone * 4 + 1], rotation[bone * 4 + 2], rotation[bone * 4 + 3]];
    for (const t of plan.twists) {
      if (!same(out, body.rest, t.bone)) continue;
      const turn = qmul(qconj(t.rest), qmul(qconj(world(t.against)), world(t.turned))),
        angle = twistAngle(turn, t.axis) * t.share;
      if (Math.abs(angle) < 1e-7) continue;
      out.set(qmul(local(out, t.bone), qaxis(t.own, angle)), t.bone * 10 + 3);
      note('limb-twist', t.name, t.driver);
    }
  }
  if (out !== pose) pose.set(out);
  return count;
}

/**
 * The twist bones {@link couplePose} drives, with the joint each follows and its share of that joint's twist (1 at the
 * far end of the segment, negative for a bone that undoes the segment's own twist toward its root).
 */
export function twistBones(body: AnatomicalRig): { bone: string; driver: string; share: number }[] {
  return planOf(body).twists.map((t) => ({ bone: t.name, driver: t.driver, share: t.share }));
}

/**
 * Couples an Animator's pose every frame (see {@link couplePose}), after the clips and the solvers added before it.
 * The body must be fitted to the Animator's own model, bone for bone. Returns the remover.
 * @example
 * const stop = addCoupling(animator, body);
 * @throws RangeError when the body and the Animator's model differ in bone count.
 */
export function addCoupling(animator: Animator, body: AnatomicalRig, options: CouplingOptions = {}): () => void {
  planOf(body);
  const nodes = animator.animation.model.nodes,
    n = nodes.length;
  if (n !== body.names.length)
    throw new RangeError(
      `addCoupling: the body has ${body.names.length} bones and the Animator's model ${n}; fit the body to that model`,
    );
  const store = animator.animation.model.root.engine.store,
    t = store.transforms,
    pose = body.rest.slice(),
    before = new Float64Array(n * 4),
    rotation = [0, 0, 0, 1];
  return animator.addSolver(() => {
    for (let i = 0; i < n; i++) {
      const { id } = nodes[i],
        at = i * 10 + 3;
      before[i * 4] = pose[at] = t.qx[id];
      before[i * 4 + 1] = pose[at + 1] = t.qy[id];
      before[i * 4 + 2] = pose[at + 2] = t.qz[id];
      before[i * 4 + 3] = pose[at + 3] = t.qw[id];
    }
    if (!couplePose(body, pose, options)) return;
    let wrote = false;
    for (let bone = 0; bone < n; bone++) {
      const at = bone * 10 + 3;
      if (
        pose[at] === before[bone * 4] &&
        pose[at + 1] === before[bone * 4 + 1] &&
        pose[at + 2] === before[bone * 4 + 2] &&
        pose[at + 3] === before[bone * 4 + 3]
      )
        continue;
      for (let i = 0; i < 4; i++) rotation[i] = pose[at + i];
      animator.writeNodeRotation(nodes[bone], rotation);
      wrote = true;
    }
    if (wrote) store.tick(false);
  });
}
