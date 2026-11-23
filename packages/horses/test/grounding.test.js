import assert from 'node:assert/strict';
import test from 'node:test';
import { horseBody } from '../dist/anatomy.js';
import { fitHorseHooves, horsePose, horseSkeleton, poseHooves, poseJoints, poseSaddle } from '../dist/model.js';

const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

test('sloped and asymmetric hoof targets keep the measured leg lengths and original tail rotations', () => {
  for (const type of ['riding', 'cavalry', 'draft']) {
    const skeleton = horseSkeleton(horseBody({ type }));
    const pose = horsePose(skeleton, null, 0, 0.8);
    const goals = poseHooves(skeleton, pose).map(([x, , z], i) => ({
      point: [x + 0.018, 0.19 * z - 0.14 * x + 0.008 * i, z - 0.026],
      pitch: -0.19,
      roll: -0.14,
    }));
    const projected = fitHorseHooves(skeleton, pose, goals, -0.19, -0.14);
    const joints = poseJoints(skeleton, projected);
    for (const leg of skeleton.legs) {
      for (const i of leg.slice(1)) {
        const parent = skeleton.joints[i].parent;
        const length = distance(skeleton.joints[i].rest, skeleton.joints[parent].rest);
        assert.ok(Math.abs(distance(joints[i], joints[parent]) - length) < 1e-9);
      }
    }
    projected.rotations.forEach((q) => assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-12));
    poseHooves(skeleton, projected).forEach((point, i) => assert.ok(distance(point, goals[i].point) < 1e-8));
    assert.deepEqual(projected.bodyOffset, pose.bodyOffset);
    assert.deepEqual(projected.rotations[skeleton.index('tail1')], pose.rotations[skeleton.index('tail1')]);
    assert.ok(Math.abs(poseSaddle(skeleton, projected).rotation[0]) > 0.085);
  }
});
