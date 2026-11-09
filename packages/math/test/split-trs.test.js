import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTRS, normalizeQuaternion } from '../dist/quat.js';
import { composeMatrix } from '../dist/mat4.js';

const matrix = (scale = [1, 1, 1]) => composeMatrix([4, -2, 7], [0, 0, 0, 1], scale, new Float64Array(16));

test('splitTRS exposes named success parts and round-trips rotations and reflections', () => {
  for (const scale of [[2, 3, 4], [-2, 3, 4], [2, -3, 4], [-2, -3, 4]]) {
    const original = composeMatrix([4, -2, 7], normalizeQuaternion([0.2, -0.4, 0.1, 0.8]), scale, new Float64Array(16));
    const before = original.slice();
    const result = splitTRS(original);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'position', 'rotation', 'scale']);
    assert.deepEqual(result.position, [4, -2, 7]);
    assert.equal(result.rotation.length, 4);
    assert.ok(Math.abs(Math.hypot(...result.rotation) - 1) < 1e-12);
    assert.equal(Math.sign(result.scale[0]), Math.sign(scale[0] * scale[1] * scale[2]));
    assert.ok(result.scale[1] > 0 && result.scale[2] > 0);
    const rebuilt = composeMatrix(result.position, result.rotation, result.scale, new Float64Array(16));
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(rebuilt[i] - original[i]) < 1e-12, `component ${i}`);
    assert.deepEqual(original, before, 'does not change the input');
  }
});

test('splitTRS exposes named failure reasons and retains the shear tolerance', () => {
  assert.deepEqual(splitTRS(matrix([0, 1, 1])), { ok: false, reason: 'singular' });
  const dependent = matrix();
  dependent.set(dependent.subarray(0, 4), 4);
  assert.deepEqual(splitTRS(dependent), { ok: false, reason: 'singular' });
  const shear = matrix();
  shear[4] = 0.01;
  assert.deepEqual(splitTRS(shear), { ok: false, reason: 'shear' });
  assert.equal(splitTRS(shear, 0.02).ok, true);
  assert.equal(splitTRS(shear, Infinity).ok, true, 'scene and DAE explicitly allow shear');
  shear[4] = 1e-6;
  assert.equal(splitTRS(shear).ok, true, 'default tolerance is 1e-5');
  assert.deepEqual(splitTRS(shear, 1e-7), { ok: false, reason: 'shear' });
});

test('splitTRS rejects non-finite column lengths and determinants instead of succeeding with NaN', () => {
  const infiniteColumn = [Infinity, 1, 1, 0, 1, 2, 1, 0, 1, 1, 2, 0, 4, -2, 7, 1];
  assert.deepEqual(splitTRS(infiniteColumn), { ok: false, reason: 'singular' });
  for (const value of [Infinity, -Infinity, NaN, 1e200, Number.MAX_VALUE]) {
    const invalid = matrix([value, value, value]);
    assert.deepEqual(splitTRS(invalid), { ok: false, reason: 'singular' }, String(value));
    assert.deepEqual(splitTRS(invalid, Infinity), { ok: false, reason: 'singular' });
  }
});
