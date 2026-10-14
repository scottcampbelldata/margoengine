// Array helpers shared by the other packages. Bit-for-bit equality with the copies they replaced is proven by
// examples/package-benchmarks/proofs/math-consolidation.proof.js; these are behaviour checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Matrix4} from '../dist/index.js';
import * as mat4 from '../dist/mat4.js';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('mat4 multiplyMatrices is column-major a * b into out, matching Matrix4', () => {
  const a = new Matrix4().makeRotationY(0.3).setPosition(1, 2, 3), b = new Matrix4().makeScale(2, 3, 4);
  const out = new Float32Array(16);
  assert.equal(mat4.multiplyMatrices(a.elements, b.elements, out), out);
  assert.deepEqual(out, new Float32Array(new Matrix4().multiplyMatrices(a, b).elements));
  assert.deepEqual(mat4.multiplyMatrices(I, [...b.elements], []), [...b.elements]);
});
