import assert from 'node:assert/strict';
import test from 'node:test';
import { maeRgb, paperPose, psnrRgb, verticalFov } from '../../../scripts/rival-splats-camera.mjs';

test('vertical field of view from the focal length', () => {
  assert.equal(verticalFov(100, 50), 90);
});

test('both camera orientations of an identity rotation look down plus Z', () => {
  const cam = {
    position: [1, 2, 3],
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    width: 100,
    height: 100,
    fy: 50,
  };
  for (const mode of ['w2c', 'c2w']) {
    const pose = paperPose(cam, mode);
    assert.deepEqual(pose.position, [1, 2, 3]);
    assert.deepEqual(pose.target, [1, 2, 4]);
    assert.deepEqual(pose.up, [0, -1, 0]);
    assert.equal(pose.fov, 90);
  }
});

test('world-to-camera and camera-to-world disagree on a non-symmetric rotation', () => {
  const cam = {
    position: [0, 0, 0],
    rotation: [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ],
    width: 10,
    height: 10,
    fy: 5,
  };
  assert.deepEqual(paperPose(cam, 'w2c').target, [1, 0, 0]);
  assert.deepEqual(paperPose(cam, 'w2c').up, [0, 0, -1]);
  assert.deepEqual(paperPose(cam, 'c2w').target, [0, 1, 0]);
  assert.deepEqual(paperPose(cam, 'c2w').up, [-1, 0, 0]);
});

test('PSNR and mean absolute error of RGB', () => {
  const same = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
  assert.equal(psnrRgb(same, same), Infinity);
  assert.equal(maeRgb(same, same), 0);
  const other = new Uint8Array([1, 2, 4, 255, 4, 5, 6, 255]);
  assert.equal(maeRgb(same, other), 1 / 6);
  assert.ok(psnrRgb(same, other) > 48);
});
