// The hand on a real rig, as Character Creator people have it: knuckles that follow the transverse metacarpal arch, and
// forearm twist bones that spread the hand's pronation along the forearm. Guards KB-RIG-HANDARCH1 (the hand's roll was
// read along the arched line to the little finger's knuckle, which rolled every finger's flexion axis, so clamping a
// clip bent the fingers sideways) and KB-RIG-TWISTBONE1 (a hand turned for pronation on a twist-bone rig was spilled
// into the forearm bone, which twisted the forearm's skin a second time on top of its twist bones).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPose, fitAnatomy } from '@margoengine/rigging/anatomy';
import { human } from '@margoengine/rigging/anatomy/human';
import { add, bodyRig, mul, qaxis, sub, unit } from './anatomy-fixtures.js';

const DEG = 180 / Math.PI;
const named = (joints, name) => joints.findIndex((joint) => joint.name === name);

test('the arch of the knuckles does not roll the hand: its frame comes from the index and middle knuckles (KB-RIG-HANDARCH1)', () => {
  for (const drop of [0, 0.012]) {
    // A T pose, palms down; the ring and little finger knuckles sit lower toward the palm, as in a real hand.
    const joints = bodyRig({ fingers: true });
    for (const side of ['Left', 'Right'])
      for (const [finger, share] of [
        ['Ring', 0.5],
        ['Pinky', 1],
      ])
        for (const part of [1, 2, 3]) {
          const joint = joints[named(joints, `${side}Hand${finger}${part}`)];
          joint.position = add(joint.position, [0, -drop * share, 0]);
        }
    const body = fitAnatomy(joints, { species: human });
    for (const id of ['l_radiocarpal', 'r_radiocarpal', 'l_metacarpophalangeal_3', 'r_metacarpophalangeal_3']) {
      // The rig's bones have no rest rotation, so a joint's axes in its bone's frame are its world axes: the flexion
      // axis lies across the flat palm, with nothing toward the palm's normal (straight down).
      const flexion = body.joints[body.index.get(id)].boneAxes[0],
        tilt = Math.asin(Math.min(1, Math.abs(flexion[1]))) * DEG;
      assert.ok(tilt < 0.5, `${id} with knuckles ${drop} m lower: flexion axis rolled ${tilt.toFixed(1)} degrees`);
    }
  }
});

test('a twist-bone rig turns the hand for pronation and the turn stays on the hand (KB-RIG-TWISTBONE1)', () => {
  for (const twistBones of [false, true]) {
    const joints = bodyRig({ fingers: false });
    if (twistBones)
      for (const side of ['Left', 'Right']) {
        // As Character Creator rigs have them: one at the elbow, a second half way down the forearm below it.
        const elbow = named(joints, `${side}ForeArm`),
          from = joints[elbow].position,
          wrist = joints[named(joints, `${side}Hand`)].position;
        joints.push({ name: `${side}ForeArmTwist01`, parent: elbow, position: from });
        joints.push({
          name: `${side}ForeArmTwist02`,
          parent: joints.length - 1,
          position: add(from, mul(sub(wrist, from), 0.5)),
        });
      }
    const body = fitAnatomy(joints, { species: human }),
      wrist = body.joints[body.index.get('l_radiocarpal')],
      elbow = body.joints[body.index.get('l_elbow')],
      forearm = unit(sub(joints[named(joints, 'LeftHand')].position, joints[named(joints, 'LeftForeArm')].position));
    // The hand alone turned 60 degrees about the forearm, the forearm bone still.
    const pose = body.rest.slice();
    pose.set(qaxis(forearm, 60 / DEG), wrist.bone * 10 + 3);
    const before = pose.slice(),
      issues = [];
    clampPose(body, pose, { issues });
    const moved = (bone) =>
      Math.max(...[0, 1, 2, 3].map((i) => Math.abs(pose[bone * 10 + 3 + i] - before[bone * 10 + 3 + i])));
    if (twistBones) {
      // The wrist's twist takes the forearm's pronation and supination as well.
      assert.equal(wrist.structural[4], -15 + elbow.structural[4]);
      assert.equal(wrist.structural[5], 15 + elbow.structural[5]);
      assert.equal(moved(elbow.bone), 0, 'the forearm bone stays still');
      assert.equal(moved(wrist.bone), 0, 'the hand keeps its turn');
      assert.deepEqual(issues, []);
    } else {
      // Without twist bones the turn past the wrist's own 15 degrees moves into the forearm, as before.
      assert.deepEqual(wrist.structural.slice(4), [-15, 15]);
      assert.ok(moved(elbow.bone) > 0.1, 'the forearm takes the turn');
    }
  }
  // A bone off the forearm that does not lie along it is no twist bone.
  const joints = bodyRig({ fingers: false }),
    elbow = named(joints, 'LeftForeArm');
  joints.push({ name: 'LeftElbowPad', parent: elbow, position: add(joints[elbow].position, [0, 0, -0.05]) });
  const body = fitAnatomy(joints, { species: human });
  assert.deepEqual(body.joints[body.index.get('l_radiocarpal')].structural.slice(4), [-15, 15]);
});
