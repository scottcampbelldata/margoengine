import test from 'node:test';
import assert from 'node:assert/strict';
import { stepLocomotion } from '../dist/index.js';

test('camera pitch crosses the horizon for upward look and stops short of the poles', () => {
  const state = new Float32Array([0, 2, 0, 0, 0, 0.18, 0, 0]),
    actions = new Float32Array([0, 0, 0, -0.4, 0]);
  stepLocomotion(state, actions, 1 / 60, () => 2);
  assert.ok(state[5] < 0);
  assert.deepEqual(Array.from(state.slice(0, 3)), [0, 2, 0]);
  actions[3] = -20;
  stepLocomotion(state, actions, 1 / 60, () => 2);
  assert.equal(state[5], Math.fround(-1.4));
  actions[3] = 20;
  stepLocomotion(state, actions, 1 / 60, () => 2);
  assert.equal(state[5], Math.fround(0.9));
});

test('ground locomotion normalizes diagonal speed and turns across the heading seam', () => {
  const a = new Float32Array(8),
    b = new Float32Array(8),
    forward = new Float32Array([0, 1, 0, 0, 0]),
    diagonal = new Float32Array([1, 1, 0, 0, 0]);
  const ground = (x, z) => 2 + x * 0.02 + z * 0.01;
  for (let i = 0; i < 120; i++) {
    stepLocomotion(a, forward, 1 / 60, ground);
    stepLocomotion(b, diagonal, 1 / 60, ground);
  }
  assert.ok(Math.abs(Math.abs(a[2]) - Math.hypot(b[0], b[2])) < 1e-4);
  assert.ok(Math.abs(b[1] - ground(b[0], b[2])) < 1e-6);
  const state = new Float32Array([0, 2, 0, Math.PI - 0.01, 0, 0.3, 0, 0]),
    input = new Float32Array([-0.01, 1, 0, 0, 0]),
    before = state.slice();
  stepLocomotion(state, input, 0, () => 2);
  assert.deepEqual(state, before);
  stepLocomotion(state, input, 1 / 60, () => 2);
  assert.ok(Math.abs(state[3] - before[3]) < 0.02);
});

test('locomotion bounds are configurable and invalid heights leave the retained state intact', () => {
  const state = new Float32Array([1, 2, 1, 0, 0, 0.3, 0, 0]),
    input = new Float32Array([1, 1, 0, 0, 1]),
    options = { bounds: [0, 1, 0, 1], minHeight: 0.45 };
  for (let i = 0; i < 60; i++) stepLocomotion(state, input, 1, () => -2, options);
  assert.ok(state[0] >= 0 && state[0] <= 1 && state[2] >= 0 && state[2] <= 1);
  assert.equal(state[1], Math.fround(0.45));
  const before = state.slice();
  assert.throws(() => stepLocomotion(state, input, 1 / 60, () => NaN), /finite/);
  assert.deepEqual(state, before);
  assert.throws(() => stepLocomotion(state, input, -1, () => 0), /inputs/);
  assert.throws(() => stepLocomotion(state, input, 0, () => 0, { bounds: [1, 0, 0, 1] }), /inputs/);
  assert.throws(() => stepLocomotion(state, input, 0, () => 0, { bounds: [0, , 0, 1] }), /inputs/);
});
