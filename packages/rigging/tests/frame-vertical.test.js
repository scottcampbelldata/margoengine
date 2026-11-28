// KB-RIG-FRAMEUP1: a body that stands stooped in its rest pose (the Fauld cast's old man leans his trunk 7.3 degrees
// forward) keeps the trunk's lean in `body.frame.up`, which the anatomical angles are read against, but its heights
// and ground tests are measured along the world's up, `body.frame.vertical`. Before the fix the pose checker measured
// along the leaning up: a toe 0.016 m above the ground read as below it on a walk drawn in place, and a walk that
// travelled 6.7 m forward read its toes 0.11 m higher than they were, so real faults were missed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitAnatomy } from '../dist/anatomy.js';
import { fitHuman, human } from '../dist/anatomy-human.js';
import { checkPose } from '../dist/validate.js';
import { add, bodyRig, dot, forward, rolled, sub, turn } from './anatomy-fixtures.js';

const LEAN = 7.3;

/** The anatomy tests' body with everything above the hips leaned `lean` degrees forward about the hips. */
function stooped(lean = LEAN) {
  const joints = bodyRig({ arms: 45 }),
    hips = joints.find((joint) => joint.name === 'Hips').position,
    above = new Set();
  joints.forEach((joint, i) => {
    if (joint.name === 'Spine' || above.has(joint.parent)) above.add(i);
  });
  for (const i of above) {
    const p = joints[i].position;
    joints[i].position = add(hips, turn(sub(p, hips), [1, 0, 0], (lean * Math.PI) / 180));
  }
  return joints;
}

const degrees = (a, b) => (Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * 180) / Math.PI;
const sunkJoints = (report) =>
  report.issues.filter((issue) => issue.code === 'ground-penetration').map((issue) => issue.joint);

test('a stooped rest leans the trunk frame but not the vertical', () => {
  const upright = fitHuman(bodyRig({ arms: 45 }));
  for (const make of [() => stooped(), () => rolled(stooped(), 11)]) {
    const body = fitHuman(make());
    assert.ok(degrees(body.frame.up, [0, 1, 0]) > 5, `trunk up ${body.frame.up}`);
    assert.ok(degrees(body.frame.vertical, [0, 1, 0]) < 1e-9, `vertical ${body.frame.vertical}`);
    // The stature is read along the vertical: the same as the upright body's.
    assert.ok(Math.abs(body.stature - upright.stature) < 1e-9, `${body.stature} against ${upright.stature}`);
  }
});

test('an upright body keeps its up as the vertical, and a given vertical wins', () => {
  const body = fitHuman(bodyRig({ arms: 45 }));
  assert.ok(degrees(body.frame.vertical, body.frame.up) < 1e-9);
  const given = fitAnatomy(stooped(), { species: human, vertical: [0, 2, 0] });
  assert.deepEqual([...given.frame.vertical], [0, 1, 0]);
  assert.throws(() => fitAnatomy(stooped(), { species: human, vertical: [0, 0, 0] }), /options.vertical/);
});

test('a body whose rest feet are not level keeps the trunk up as its vertical', () => {
  const joints = stooped(),
    lift = new Set();
  joints.forEach((joint, i) => {
    if (joint.name === 'LeftFoot' || lift.has(joint.parent)) lift.add(i);
  });
  for (const i of lift) joints[i].position = add(joints[i].position, [0, 0.12, 0]);
  const body = fitHuman(joints);
  assert.ok(degrees(body.frame.vertical, body.frame.up) < 1e-9);
});

test('ground tests of a stooped body measure along the world up, in place and after travel', () => {
  const body = fitHuman(stooped()),
    toe = body.joints[body.index.get('r_metatarsophalangeal_1')],
    root = body.joints[body.index.get('humanoid_root')].bone,
    { pos } = forward(body.parents, body.rest),
    // The ground 0.016 m below the toes: nothing is below it.
    ground = pos[toe.bone][1] - 0.016;
  for (const travel of [0, 6.7]) {
    const pose = body.rest.slice(),
      at = [pose[root * 10], pose[root * 10 + 1], pose[root * 10 + 2]];
    pose.set(add(at, [0, 0, travel]), root * 10);
    assert.deepEqual(sunkJoints(checkPose(body, pose, { ground })), [], `travel ${travel}`);
    // Lowered 0.05 m, the toes are 0.034 m through the ground, as measured in the world.
    pose.set(add(at, [0, -0.05, travel]), root * 10);
    const sunk = checkPose(body, pose, { ground }).issues.find((issue) => issue.code === 'ground-penetration');
    assert.ok(sunk && /metatarsophalangeal/.test(sunk.joint), `travel ${travel}: the sunk toe is found`);
    assert.ok(Math.abs(-sunk.value * body.stature - 0.034) < 1e-6, `travel ${travel}: ${sunk.value * body.stature} m`);
  }
});
