import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../core/dist/index.js';
import { ShotBlend } from '../dist/shots.js';

// ShotBlend replaces the overview/close-up camera move every optics demo wrote by hand: an eased blend between two
// eye-target shots, a portrait back-off and an optional field of view.

const near = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-12, `${actual} vs ${expected}`));
const wide = { target: [0, 0.2, 0], offset: [1, 1, 2], fit: 1.2, fov: 42 };
const close = { target: [0.4, 0.3, 0], offset: [0.2, 0.1, 0.5], fit: 1, fov: 38 };

test('blend 0 and 1 frame the two shots exactly; landscape views keep the offset', () => {
  const camera = new Camera();
  const shots = new ShotBlend(camera, wide, close);
  assert.equal(shots.update(1 / 60, 1600, 900), false);
  assert.deepEqual(camera.target, [0, 0.2, 0]);
  assert.deepEqual(camera.position, [1, 1.2, 2]);
  assert.equal(camera.fov, 42);
  shots.goal = 1;
  shots.blend = 1;
  shots.update(1 / 60, 1600, 900);
  near(camera.target, [0.4, 0.3, 0]);
  near(camera.position, [0.6, 0.4, 0.5]);
  assert.equal(camera.fov, 38);
});

test('a portrait view backs away by fit * height / width', () => {
  const camera = new Camera();
  new ShotBlend(camera, wide, close).update(0, 900, 1600);
  const scale = (1.2 * 1600) / 900;
  near(camera.position, [scale, 0.2 + scale, 2 * scale]);
});

test('the move eases at the same speed at any frame rate and ends exactly on the goal', () => {
  const run = (steps) => {
    const shots = new ShotBlend(new Camera(), wide, close, { rate: 16 });
    shots.goal = 1;
    for (let i = 0; i < steps; i++) shots.update(0.25 / steps, 1600, 900);
    return shots.blend;
  };
  assert.ok(Math.abs(run(15) - run(60)) < 1e-12, 'a quarter second at 60 Hz and at 240 Hz lands at the same blend');
  assert.ok(Math.abs(run(15) - (1 - Math.exp(-4))) < 1e-12);
  const shots = new ShotBlend(new Camera(), wide, close, { rate: 16 });
  shots.goal = 1;
  let frames = 0;
  while (shots.update(1 / 60, 1600, 900)) frames++;
  assert.equal(shots.blend, 1);
  assert.equal(shots.moving, false);
  assert.ok(frames > 10 && frames < 40, `settles in ${frames} frames`);
});

test('reduced motion jumps straight to the goal', () => {
  const still = { matches: true };
  const shots = new ShotBlend(new Camera(), wide, close, { still });
  shots.goal = 1;
  assert.equal(shots.update(1 / 60, 1600, 900), false);
  assert.equal(shots.blend, 1);
});

test('field of view is left alone unless both shots give one; targets are read live', () => {
  const camera = new Camera({ fov: 50 });
  const from = { target: [0, 0, 0], offset: [0, 0, 3] };
  const shots = new ShotBlend(camera, from, { target: [1, 0, 0], offset: [0, 0, 1], fov: 30 });
  shots.update(0, 100, 100);
  assert.equal(camera.fov, 50);
  from.target[0] = 2;
  shots.update(0, 100, 100);
  assert.deepEqual(camera.target, [2, 0, 0]);
});

test('bad rates, deltas and sizes are refused', () => {
  assert.throws(() => new ShotBlend(new Camera(), wide, close, { rate: 0 }), RangeError);
  assert.throws(() => new ShotBlend(new Camera(), wide, close, { rate: Infinity }), RangeError);
  const shots = new ShotBlend(new Camera(), wide, close);
  assert.throws(() => shots.update(-1, 10, 10), RangeError);
  assert.throws(() => shots.update(NaN, 10, 10), RangeError);
  assert.throws(() => shots.update(0, 0, 10), RangeError);
});
