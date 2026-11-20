import test from 'node:test';
import assert from 'node:assert/strict';
import { splitNodeMatrix, splitTRS, normalizeQuaternion } from '../dist/quat.js';
import { composeMatrix } from '../dist/mat4.js';

const matrix = (scale = [1, 1, 1]) => composeMatrix([4, -2, 7], [0, 0, 0, 1], scale, new Float64Array(16));

test('splitTRS exposes named success parts and round-trips rotations and reflections', () => {
  for (const scale of [
    [2, 3, 4],
    [-2, 3, 4],
    [2, -3, 4],
    [-2, -3, 4],
  ]) {
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

test('splitNodeMatrix reads a zero column as a zero scale on that axis and keeps the rest of the split', () => {
  const flat = composeMatrix([1, 2, 3], normalizeQuaternion([0.2, -0.4, 0.1, 0.8]), [2, 0, 4], new Float64Array(16));
  assert.deepEqual(splitTRS(flat), { ok: false, reason: 'singular' });
  const parts = splitNodeMatrix(flat);
  assert.equal(parts.ok, true);
  assert.deepEqual(parts.position, [1, 2, 3]);
  assert.deepEqual(
    parts.scale.map((v) => Math.round(v * 1e9) / 1e9),
    [2, 0, 4],
  );
  const rebuilt = composeMatrix(parts.position, parts.rotation, parts.scale, new Float64Array(16));
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rebuilt[i] - flat[i]) < 1e-12, `component ${i}`);
  for (const scale of [
    [0, 3, 0],
    [0, 0, 0],
  ]) {
    const one = splitNodeMatrix(composeMatrix([0, 0, 0], [0, 0, 0, 1], scale, new Float64Array(16)));
    assert.equal(one.ok, true);
    assert.deepEqual(one.scale, scale);
  }
  // A column of float32 zeros counts only when asked: glTF numbers are float32.
  const tiny = matrix([1e-50, 1, 1]);
  assert.equal(splitNodeMatrix(tiny).scale[0], 1e-50, 'an exact read keeps a tiny scale');
  assert.deepEqual(splitNodeMatrix(tiny, { float32: true }).scale, [0, 1, 1]);
  const dependent = matrix([0, 1, 1]);
  dependent.set(dependent.subarray(4, 8), 8);
  assert.deepEqual(splitNodeMatrix(dependent), { ok: false, reason: 'singular' });
  const sheared = matrix([0, 1, 1]);
  sheared[8] = 0.5;
  sheared[4] = 0.5;
  assert.deepEqual(splitNodeMatrix(sheared), { ok: false, reason: 'shear' });
});
