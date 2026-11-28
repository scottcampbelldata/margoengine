// Bodies for the anatomy tests, with their own small vector and quaternion maths so the tests do not lean on the code
// they check. One body (1.75 m, facing +z, x to its left) in any arm pose, with finger bones, optional modelled bends,
// mirrored, or with every bone's axes rolled at random.
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a) => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
/** v turned by q, as q v q*. */
export const qrot = (q, v) => qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q)).slice(0, 3);
export const qaxis = (axis, angle) => [...mul(axis, Math.sin(angle / 2)), Math.cos(angle / 2)];
/** v turned about the unit axis by angle (Rodrigues). */
export const turn = (v, axis, angle) =>
  add(
    add(mul(v, Math.cos(angle)), mul(cross(axis, v), Math.sin(angle))),
    mul(axis, dot(axis, v) * (1 - Math.cos(angle))),
  );

/** A seeded generator of numbers in [0, 1). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** World rotations and positions of a local pose (10 numbers per bone, parents first, unit scale). */
export function forward(parents, pose) {
  const rot = [],
    pos = [];
  parents.forEach((p, i) => {
    const t = Array.from(pose.slice(i * 10, i * 10 + 3)),
      q = Array.from(pose.slice(i * 10 + 3, i * 10 + 7));
    rot[i] = p < 0 ? q : qmul(rot[p], q);
    pos[i] = p < 0 ? t : add(pos[p], qrot(rot[p], t));
  });
  return { rot, pos };
}

const index = (joints, name) => joints.findIndex((joint) => joint.name === name);
const put = (joints, name, parent, position) =>
  joints.push({ name, parent: parent === null ? -1 : index(joints, parent), position });

/**
 * Adds finger bones to both hands of a body made by {@link bodyRig} with `fingers: false`. The knuckles lie across the
 * hand with the index toward the front of the body when the palm faces the thigh; `palm` degrees of supination turns
 * them about the hand (90 in a T pose is palms forward).
 */
export function addHand(joints, palm = 0) {
  for (const [side, s] of [
    ['Left', 1],
    ['Right', -1],
  ]) {
    const wrist = joints[index(joints, `${side}Hand`)].position,
      f = unit(sub(wrist, joints[index(joints, `${side}ForeArm`)].position)),
      flat = unit(sub([0, 0, 1], mul(f, f[2]))),
      across = turn(flat, f, (-s * palm * Math.PI) / 180);
    const thumb = add(wrist, add(mul(f, 0.02), mul(across, 0.02))),
      thumbWay = unit(add(f, across));
    put(joints, `${side}HandThumb1`, `${side}Hand`, thumb);
    put(joints, `${side}HandThumb2`, `${side}HandThumb1`, add(thumb, mul(thumbWay, 0.04)));
    put(joints, `${side}HandThumb3`, `${side}HandThumb2`, add(thumb, mul(thumbWay, 0.07)));
    for (const [finger, along, aside] of [
      ['Index', 0.09, 0.03],
      ['Middle', 0.095, 0.01],
      ['Ring', 0.09, -0.01],
      ['Pinky', 0.085, -0.028],
    ]) {
      const knuckle = add(wrist, add(mul(f, along), mul(across, aside)));
      put(joints, `${side}Hand${finger}1`, `${side}Hand`, knuckle);
      put(joints, `${side}Hand${finger}2`, `${side}Hand${finger}1`, add(knuckle, mul(f, 0.04)));
      put(joints, `${side}Hand${finger}3`, `${side}Hand${finger}2`, add(knuckle, mul(f, 0.065)));
    }
  }
  return joints;
}

/**
 * The body as `{ name, parent, position }` joints with Mixamo-style names.
 * @param arms Degrees the arms are held out from hanging: 0 down, 45 an A pose, 90 a T pose.
 * @param elbow Degrees of elbow bend modelled into the rest pose (toward the front of the arm).
 * @param knee Degrees of knee bend modelled into the rest pose.
 * @param mirror Reflects the body left to right and keeps the names, so "Left" bones sit on the right.
 * @param fingers Whether the hands have finger bones.
 */
export function bodyRig({ arms = 90, elbow = 0, knee = 0, mirror = false, fingers = true, clavicle = [0, 0] } = {}) {
  const joints = [];
  put(joints, 'Hips', null, [0, 0.93, 0]);
  put(joints, 'Spine', 'Hips', [0, 1.03, 0]);
  put(joints, 'Spine1', 'Spine', [0, 1.18, 0]);
  put(joints, 'Spine2', 'Spine1', [0, 1.33, 0]);
  put(joints, 'Neck', 'Spine2', [0, 1.5, 0]);
  put(joints, 'Head', 'Neck', [0, 1.6, 0]);
  const a = (arms * Math.PI) / 180,
    e = (elbow * Math.PI) / 180,
    k = (knee * Math.PI) / 360;
  for (const [side, s] of [
    ['Left', 1],
    ['Right', -1],
  ]) {
    const hip = [0.09 * s, 0.9, 0],
      kneeAt = add(hip, mul([0, -Math.cos(k), Math.sin(k)], 0.41)),
      ankle = add(kneeAt, mul([0, -Math.cos(k), -Math.sin(k)], 0.42));
    put(joints, `${side}UpLeg`, 'Hips', hip);
    put(joints, `${side}Leg`, `${side}UpLeg`, kneeAt);
    put(joints, `${side}Foot`, `${side}Leg`, ankle);
    put(joints, `${side}ToeBase`, `${side}Foot`, add(ankle, [0, -0.06, 0.13]));
    const d = [Math.sin(a) * s, -Math.cos(a), 0],
      fore = add(mul(d, Math.cos(e)), mul([0, 0, 1], Math.sin(e))),
      [up, back] = clavicle.map((deg) => (deg * Math.PI) / 180),
      // The collarbone from the sternum, `clavicle` degrees up and back from straight out.
      shoulder = add([0.03 * s, 1.44, 0], mul([Math.cos(up) * Math.cos(back) * s, Math.sin(up), -Math.cos(up) * Math.sin(back)], 0.15)),
      elbowAt = add(shoulder, mul(d, 0.28));
    put(joints, `${side}Shoulder`, 'Spine2', [0.03 * s, 1.44, 0]);
    put(joints, `${side}Arm`, `${side}Shoulder`, shoulder);
    put(joints, `${side}ForeArm`, `${side}Arm`, elbowAt);
    put(joints, `${side}Hand`, `${side}ForeArm`, add(elbowAt, mul(fore, 0.26)));
  }
  if (fingers) addHand(joints);
  if (mirror) for (const joint of joints) joint.position = [-joint.position[0], joint.position[1], joint.position[2]];
  return joints;
}

/** The same body as `{ names, parents, rest }` with every bone's own axes turned at random: the joints stay put. */
export function rolled(joints, seed) {
  const rnd = random(seed),
    world = joints.map(() => {
      const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5],
        l = Math.hypot(...q);
      return q.map((v) => v / l);
    }),
    rest = new Float64Array(joints.length * 10);
  joints.forEach((joint, i) => {
    const p = joint.parent,
      above = p < 0 ? [0, 0, 0, 1] : world[p],
      from = p < 0 ? [0, 0, 0] : joints[p].position;
    rest.set([...qrot(qconj(above), sub(joint.position, from)), ...qmul(qconj(above), world[i]), 1, 1, 1], i * 10);
  });
  return { names: joints.map((joint) => joint.name), parents: joints.map((joint) => joint.parent), rest };
}

/**
 * A stick body with one bone per joint of a species table, named by the table's own ids and standing in its neutral
 * pose: each joint sits at the end of its parent's segment, and a joint that starts a side sits out to that side.
 */
export function stickRig(table) {
  const joints = [],
    specs = new Map(table.joints.map((spec) => [spec.id, spec]));
  for (const spec of table.joints) {
    const parent = spec.parent === null ? null : specs.get(spec.parent),
      from = parent ? joints[index(joints, parent.id)].position : [0, 1, 0],
      aside = parent && spec.side !== parent.side ? [spec.side === 'left' ? 0.1 : -0.1, 0, 0] : [0, 0, 0];
    put(joints, spec.id, spec.parent, parent ? add(add(from, mul(parent.long, 0.05)), aside) : from);
  }
  return joints;
}
