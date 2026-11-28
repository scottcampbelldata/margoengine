// Coupled motion (`@margoengine/rigging/coupling`) against the papers' numbers, read here from the table's own source
// rows so the test does not restate the solver: the collarbone and shoulder blade ride on arm elevation (Ludewig et al.
// 2009; Inman 1944), the forearm's skin twists along its length with the hand, the last finger joint follows the
// middle one (Rijpkema and Girard 1991), a bend one spine level holds is shared by the run, and the knee screws home
// (Kim et al. 2015). A follower the pose moves itself, and the rest pose, are left alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitAnatomy, jointAngles, poseFromAngles, regionAngles } from '../dist/anatomy.js';
import { fitHuman, human } from '../dist/anatomy-human.js';
import { couplePose, twistBones } from '../dist/coupling.js';
import { add, bodyRig, forward, mul, qconj, qmul, rolled, sub } from './anatomy-fixtures.js';

const close = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} against ${b}`);
const hook = (id) => human.couplings.find((c) => c.id === id);
const rowOf = (id, what) => hook(id).rows.find((row) => row.what.startsWith(what)).value;
const SHAPES = {
  'T pose': () => fitHuman(bodyRig({ arms: 90 })),
  'A pose': () => fitHuman(bodyRig({ arms: 45 })),
  'rolled axes': () => fitHuman(rolled(bodyRig({ arms: 45 }), 5)),
  mirrored: () => fitHuman(bodyRig({ arms: 45, mirror: true })),
};

test('the rest and the neutral pose are left as they are', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const body = make();
    for (const base of [body.rest, body.neutral]) {
      const pose = base.slice();
      assert.equal(couplePose(body, pose), 0, name);
      assert.deepEqual([...pose], [...base], name);
    }
  }
});

test('the collarbone follows arm elevation by the bone-pin curve, and the arm keeps its direction', () => {
  const sc = human.joints.find((joint) => joint.id === 'r_sternoclavicular').rhythm,
    // Ludewig 2009: 5.9 up and 19.2 back at the side; 11 and 23 at 30 degrees; 17 and 39 at the end of the curve.
    curve = sc.curve,
    roll = rowOf('shoulder-girdle', 'sternoclavicular posterior rotation');
  assert.deepEqual(curve[0], [0, 5.9, 19.2]);
  assert.equal(roll, 31);
  for (const [name, make] of Object.entries(SHAPES))
    for (const [lift, elevation, retraction, rotation] of [
      [30, 11 - 5.9, 23 - 19.2, 0],
      [120, 17 - 5.9, 39 - 19.2, (31 * 30) / 90],
      [150, 17 - 5.9, 39 - 19.2, (31 * 60) / 90],
    ])
      for (const side of ['l', 'r']) {
        const body = make(),
          pose = poseFromAngles(body, { [`${side}_shoulder`]: { abduction: lift } }, body.neutral),
          issues = [];
        couplePose(body, pose, {}, issues);
        const angles = jointAngles(body, pose),
          clavicle = angles[`${side}_sternoclavicular`],
          what = `${name} ${side} at ${lift}`;
        assert.ok(issues.some((issue) => issue.follower === `${side}_sternoclavicular`), what);
        close(clavicle.flexion, elevation, 1e-6, `${what} elevation`);
        close(clavicle.abduction, -retraction, 1e-6, `${what} retraction`);
        close(clavicle.rotation, rotation, 1e-6, `${what} posterior rotation`);
        // The shoulder is read against the thorax: the arm points where the pose put it.
        const arm = angles[`${side}_shoulder`];
        close(arm.abduction, lift, 1e-6, `${what} arm`);
        close(arm.flexion, 0, 1e-6, `${what} arm flexion`);
      }
});

test('a collarbone the pose moves itself, or a girdle turned off, is left alone', () => {
  const body = fitHuman(bodyRig({ arms: 45 })),
    moved = poseFromAngles(body, { l_sternoclavicular: { flexion: 3 }, l_shoulder: { abduction: 120 } }, body.neutral),
    before = moved.slice();
  couplePose(body, moved);
  close(jointAngles(body, moved).l_sternoclavicular.flexion, 3, 1e-6, 'kept');
  assert.deepEqual([...moved.subarray(0, 10)], [...before.subarray(0, 10)]);
  const off = poseFromAngles(body, { l_shoulder: { abduction: 120 } }, body.neutral),
    kept = off.slice();
  assert.equal(couplePose(body, off, { girdle: false }), 0);
  assert.deepEqual([...off], [...kept]);
});

test('from an A-pose rest, lowering the arm lowers the collarbone by the curve between the two lifts', () => {
  // A rig whose rest collarbone rises with its arms (13 up and 28 back, as the curve puts it at 60 degrees).
  const body = fitHuman(bodyRig({ arms: 45, clavicle: [13, 28] })),
    sc = human.joints.find((joint) => joint.id === 'l_sternoclavicular').rhythm.curve,
    at = (x, c) => {
      if (x <= sc[0][0]) return sc[0][c];
      for (let k = 1; k < sc.length; k++)
        if (x <= sc[k][0]) return sc[k - 1][c] + ((x - sc[k - 1][0]) / (sc[k][0] - sc[k - 1][0])) * (sc[k][c] - sc[k - 1][c]);
      return sc.at(-1)[c];
    },
    restLift = Math.hypot(body.joints[body.index.get('l_shoulder')].rest.flexion, body.joints[body.index.get('l_shoulder')].rest.abduction),
    pose = poseFromAngles(body, { l_shoulder: { abduction: 0, flexion: 0 } }, body.rest);
  couplePose(body, pose);
  const clavicle = jointAngles(body, pose).l_sternoclavicular,
    rest = body.joints[body.index.get('l_sternoclavicular')].rest;
  assert.ok(rest.flexion > 1, `the rest collarbone reads raised: ${rest.flexion}`);
  close(clavicle.flexion, rest.flexion + at(0, 1) - at(restLift, 1), 1e-6, 'depression');
  // A rig whose collarbone stays put as its arms rise has its rest as the zero of an arm at the side: lowering the arm
  // leaves it there.
  const flat = fitHuman(bodyRig({ arms: 45 })),
    lowered = poseFromAngles(flat, { l_shoulder: { abduction: 0, flexion: 0 } }, flat.rest);
  couplePose(flat, lowered);
  close(jointAngles(flat, lowered).l_sternoclavicular.flexion, 0, 1e-6, 'flat collarbone');
});

test('the last joint of a finger curls with the middle one at two thirds', () => {
  const body = fitHuman(bodyRig({ arms: 0 })),
    ratio = hook('finger-curl').values.ratio,
    pose = poseFromAngles(body, { l_carpal_proximal_interphalangeal_2: { flexion: 60 } }, body.neutral);
  assert.ok(Math.abs(ratio - 2 / 3) < 1e-12);
  couplePose(body, pose);
  close(jointAngles(body, pose).l_carpal_distal_interphalangeal_2.flexion, 40, 1e-6, 'DIP');
});

test('a bending knee turns its tibia inward over the last 20 degrees, and a straight one is locked', () => {
  const body = fitHuman(bodyRig({ arms: 45 })),
    { rotation, over } = hook('screw-home').values;
  assert.equal(rotation, rowOf('screw-home', 'tibial rotation range in active extension'));
  assert.equal(over, rowOf('screw-home', 'knee flexion over which'));
  for (const [flexion, turn] of [
    [0, 0],
    [over / 2, rotation / 2],
    [over, rotation],
    [60, rotation],
  ]) {
    const pose = poseFromAngles(body, { r_knee: { flexion } }, body.neutral);
    couplePose(body, pose);
    const knee = jointAngles(body, pose).r_knee;
    close(knee.rotation, turn, 1e-6, `rotation at ${flexion}`);
    close(knee.flexion, flexion, 1e-6, `flexion at ${flexion}`);
  }
});

test('a trunk bend held by one level is shared by every level, and the chest keeps its turn', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const body = make(),
      trunk = body.regions.find((region) => region.id === 'trunk'),
      middle = body.joints[trunk.joints[1]],
      pose = poseFromAngles(body, { [middle.id]: { flexion: 30, abduction: 10 } }, body.neutral),
      top = body.joints[trunk.joints.at(-1)].bone,
      before = forward(body.parents, pose).rot[top],
      total = regionAngles(body, pose).trunk;
    couplePose(body, pose);
    const after = forward(body.parents, pose).rot[top],
      d = qmul(qconj(before), after);
    assert.ok(Math.abs(Math.abs(d[3]) - 1) < 1e-9, `${name}: the chest turned`);
    const angles = jointAngles(body, pose),
      shares = trunk.joints.map((k) => angles[body.joints[k].id].flexion);
    assert.ok(shares.every((share) => share > 1), `${name}: ${shares}`);
    close(regionAngles(body, pose).trunk.flexion, total.flexion, 1e-6, `${name} total`);
  }
});

/** The anatomy tests' body with a twist bone half way along each forearm and upper arm. */
function twistRig() {
  const joints = bodyRig({ arms: 45 }),
    at = (name) => joints.findIndex((joint) => joint.name === name);
  for (const side of ['Left', 'Right'])
    for (const [segment, end] of [
      ['ForeArm', 'Hand'],
      ['Arm', 'ForeArm'],
    ]) {
      const a = joints[at(`${side}${segment}`)].position,
        b = joints[at(`${side}${end}`)].position;
      joints.push({ name: `${side}${segment}Twist`, parent: at(`${side}${segment}`), position: add(a, mul(sub(b, a), 0.5)) });
    }
  return joints;
}

test('twist bones carry the share of their place: half the hand on a forearm, half the arm on an upper arm', () => {
  const body = fitAnatomy(twistRig(), { species: human }),
    names = twistBones(body).map((t) => `${t.bone} ${t.driver} ${t.share.toFixed(2)}`).sort();
  assert.deepEqual(names, [
    'LeftArmTwist l_shoulder -0.50',
    'LeftForeArmTwist l_radiocarpal 0.50',
    'RightArmTwist r_shoulder -0.50',
    'RightForeArmTwist r_radiocarpal 0.50',
  ]);
  const bone = (name) => body.names.indexOf(name),
    twistOf = (pose, child, parent, axisFrom, axisTo) => {
      const { rot, pos } = forward(body.parents, pose),
        axis = sub(pos[axisTo], pos[axisFrom]),
        l = Math.hypot(...axis),
        d = qmul(qconj(qmul(qconj(forward(body.parents, body.rest).rot[parent]), forward(body.parents, body.rest).rot[child])), qmul(qconj(rot[parent]), rot[child])),
        restAxis = (() => {
          const r = forward(body.parents, body.rest);
          return qmul(qmul(qconj(r.rot[child]), [...mul(axis, 1 / l), 0]), r.rot[child]).slice(0, 3);
        })();
      return (2 * Math.atan2(d[0] * restAxis[0] + d[1] * restAxis[1] + d[2] * restAxis[2], d[3]) * 180) / Math.PI;
    };
  // The hand pronated 60 degrees on its forearm: the forearm's twist bone turns 30 the same way.
  const pose = poseFromAngles(body, { l_radiocarpal: { rotation: 60 } }, body.rest);
  couplePose(body, pose);
  const fore = bone('LeftForeArm'),
    hand = bone('LeftHand'),
    twist = bone('LeftForeArmTwist'),
    handTurn = twistOf(pose, hand, fore, fore, hand),
    twistTurn = twistOf(pose, twist, fore, fore, hand);
  close(twistTurn, handTurn / 2, 1e-6, 'forearm twist bone');
  assert.ok(Math.abs(handTurn) > 50, `hand ${handTurn}`);
  // The arm turned 40 degrees about its length: the upper arm's twist bone keeps half of it.
  const arm = bone('LeftArm'),
    elbow = bone('LeftForeArm'),
    armTwist = bone('LeftArmTwist'),
    turned = poseFromAngles(body, { l_shoulder: { rotation: 40 } }, body.rest);
  couplePose(body, turned);
  const own = twistOf(turned, armTwist, arm, arm, elbow);
  close(own, -twistOf(turned, arm, body.parents[arm], arm, elbow) / 2, 1e-6, 'upper arm twist bone');
});
