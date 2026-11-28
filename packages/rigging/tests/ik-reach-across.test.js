// An arm reaching across the chest (KB-RIG-REACHTRUNK1): the closed-form limb kept the swivel the pose bent to, so on
// a Character Creator old man the elbow dropped into the belly and the upper arm and forearm passed through the trunk,
// and the hand kept the idle clip's turn, palm up. The swivel now keeps the limb out of the body's volumes as it keeps
// the shoulder in range, and the hand ends relaxed at the body's neutral with the forearm at its anatomical zero.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitAnatomy, poseFromAngles, jointAngles } from '@margoengine/rigging/anatomy';
import { human } from '@margoengine/rigging/anatomy/human';
import { solvePoseIK } from '@margoengine/rigging/ik';
import { checkPose } from '@margoengine/rigging/validate';
import { add, bodyRig, forward, mul, sub, unit } from './anatomy-fixtures.js';

/** The fixture body with arms down and its left arm turned palm forward (supinated), as an idle clip may hold it. */
function body() {
  const joints = bodyRig({ arms: 10, elbow: 15 }),
    rig = { names: joints.map((j) => j.name), parents: joints.map((j) => j.parent), rest: new Float64Array(joints.length * 10) };
  joints.forEach((joint, i) => {
    const from = joint.parent < 0 ? [0, 0, 0] : joints[joint.parent].position;
    rig.rest.set([...sub(joint.position, from), 0, 0, 0, 1, 1, 1, 1], i * 10);
  });
  const fit = fitAnatomy(rig, { species: human }),
    bone = (name) => rig.names.indexOf(name),
    pose = poseFromAngles(fit, { l_elbow: { flexion: 15, abduction: 0, rotation: -70 } }, fit.rest);
  return { rig, fit, pose, arm: ['LeftArm', 'LeftForeArm', 'LeftHand'].map(bone), tip: bone('LeftHandMiddle3') };
}

/** Which way the palm faces: where the middle fingertip goes when the wrist flexes. */
function palm(b, local) {
  const a = jointAngles(b.fit, local).l_radiocarpal,
    bent = poseFromAngles(b.fit, { l_radiocarpal: { ...a, flexion: a.flexion + 20 } }, local),
    p0 = forward(b.rig.parents, local).pos[b.tip],
    p1 = forward(b.rig.parents, bent).pos[b.tip];
  return unit(sub(p1, p0));
}

/** The reach: from the left shoulder, across to the right side of the chest, scaled to the body. */
function reach(b) {
  const shoulder = forward(b.rig.parents, b.pose).pos[b.arm[0]],
    k = b.fit.stature / 1.75;
  return add(shoulder, mul([-0.3, -0.1, 0.12], k));
}

test('an arm reaching across the chest stays out of the trunk, its palm down or toward the body, not up', () => {
  const b = body(),
    target = reach(b),
    local = b.pose.slice(),
    result = solvePoseIK({ parents: b.rig.parents, local, body: b.fit }, { joints: b.arm, target });
  assert.ok(result.reached, `the reach is in range: ${result.distance}`);
  const through = checkPose(b.fit, local).issues.filter((i) => i.code === 'self-penetration');
  assert.deepEqual(through.map((i) => i.message), []);
  const up = palm(b, local);
  assert.ok(up[1] < 0.3, `palm faces up: ${up.map((v) => v.toFixed(2))}`);
  // The forearm at its anatomical zero, whatever the pose held.
  assert.ok(Math.abs(jointAngles(b.fit, local).l_elbow.rotation) < 1);
});

test('without the body volumes the same reach goes through the trunk: the fault this guards', () => {
  const b = body(),
    plain = { ...b.fit, species: { ...b.fit.species, volumes: [] } },
    local = b.pose.slice();
  solvePoseIK({ parents: b.rig.parents, local, body: plain }, { joints: b.arm, target: reach(b) });
  const through = checkPose(b.fit, local).issues.filter((i) => i.code === 'self-penetration');
  assert.ok(through.length >= 1, 'the swivel the pose bends to puts the arm through the trunk');
});

test("hand: 'keep' keeps the pose's forearm turn", () => {
  const b = body(),
    local = b.pose.slice();
  solvePoseIK({ parents: b.rig.parents, local, body: b.fit }, { joints: b.arm, target: reach(b), hand: 'keep' });
  assert.ok(jointAngles(b.fit, local).l_elbow.rotation < -60);
});
