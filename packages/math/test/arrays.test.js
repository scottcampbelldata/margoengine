// Array helpers shared by the other packages. Bit-for-bit equality with the copies they replaced is proven by
// examples/package-benchmarks/proofs/math-consolidation.proof.js; these are behaviour checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Matrix4} from '../dist/index.js';
import * as mat4 from '../dist/mat4.js';
import * as validate from '../dist/validate.js';
import * as quat from '../dist/quat.js';
import {Quaternion, Euler} from '../dist/index.js';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('mat4 multiplyMatrices is column-major a * b into out, matching Matrix4', () => {
  const a = new Matrix4().makeRotationY(0.3).setPosition(1, 2, 3), b = new Matrix4().makeScale(2, 3, 4);
  const out = new Float32Array(16);
  assert.equal(mat4.multiplyMatrices(a.elements, b.elements, out), out);
  assert.deepEqual(out, new Float32Array(new Matrix4().multiplyMatrices(a, b).elements));
  assert.deepEqual(mat4.multiplyMatrices(I, [...b.elements], []), [...b.elements]);
});

test('mat4 invertMatrix inverts into out and returns null for singular or non-finite input', () => {
  const m = new Matrix4().makeRotationX(0.7).setPosition(4, -2, 1), out = new Float64Array(16);
  assert.equal(mat4.invertMatrix(m.elements, out), out);
  mat4.multiplyMatrices(m.elements, out, out.slice()).forEach((v, i) => assert.ok(Math.abs(v - I[i]) < 1e-12));
  const untouched = new Float32Array(16).fill(7);
  assert.equal(mat4.invertMatrix(new Array(16).fill(0), untouched), null);
  assert.equal(mat4.invertMatrix([NaN, ...I.slice(1)], untouched), null);
  assert.ok(untouched.every(v => v === 7));
});

test('mat4 invertMatrixStable allows out === m and rejects what it cannot represent', () => {
  const m = new Float64Array(new Matrix4().makeScale(2, 4, 8).setPosition(1, 2, 3).elements), inverse = new Float64Array(new Matrix4().fromArray(m).invert().elements);
  assert.equal(mat4.invertMatrixStable(m, m), m);
  m.forEach((v, i) => assert.ok(Math.abs(v - inverse[i]) < 1e-15));
  const out = new Float32Array(16).fill(7);
  assert.equal(mat4.invertMatrixStable([1e-39, ...I.slice(1)], out), null); // 1e39 overflows Float32
  assert.equal(mat4.invertMatrixStable(I, out, new Float32Array(52)), null);
  assert.ok(out.every(v => v === 7));
});

test('mat4 composeMatrix matches Matrix4.compose', () => {
  const q = [0.1, -0.5, 0.3, 0.8], l = Math.hypot(...q), unit = q.map(v => v / l), out = new Float64Array(16);
  assert.equal(mat4.composeMatrix([1, 2, 3], unit, [2, 3, 4], out), out);
  const expected = new Matrix4().compose({x: 1, y: 2, z: 3}, {x: unit[0], y: unit[1], z: unit[2], w: unit[3]}, {x: 2, y: 3, z: 4}).elements;
  out.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-15));
});

test('validate finiteVector checks length and Float32 range', () => {
  assert.doesNotThrow(() => validate.finiteVector([0, -1, 3e38], 3, 'Position'));
  assert.throws(() => validate.finiteVector([0, 1], 3, 'Position'), {name: 'TypeError', message: 'Position must contain 3 finite numbers'});
  assert.throws(() => validate.finiteVector([0, 1, 4e38], 3, 'Position'), {name: 'TypeError', message: 'Position must contain 3 finite Float32 numbers'});
});

test('quat eulerToQuaternion and multiplyQuaternions match Quaternion', () => {
  const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-15, `[${i}] ${v} != ${b[i]}`));
  near(quat.eulerToQuaternion(0.3, -1.2, 2.5), new Quaternion().setFromEuler(new Euler(0.3, -1.2, 2.5)).toArray());
  const a = [0.1, 0.2, 0.3, 0.9], b = [-0.4, 0.5, 0.1, 0.7];
  near(quat.multiplyQuaternions(a, b), new Quaternion(...a).multiply(new Quaternion(...b)).toArray());
});