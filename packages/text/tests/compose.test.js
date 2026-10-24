// Text.setTransform writes its world matrix with the local compose(); it must equal composeMatrix from math exactly
// after Float32 storage, and follow translation * rotation * scale.
import assert from 'node:assert/strict';
import test from 'node:test';
import { eulerToQuaternion } from '@margoengine/math/quat';
import { createRandom } from '@margoengine/math/mathutils';
import { composeMatrix } from '@margoengine/math/mat4';
import { Text } from '../dist/index.js';

test('Text.setTransform matches composeMatrix entry for entry (Float32)', () => {
  const random = createRandom(11),
    f = (range) => Math.fround((random() - 0.5) * range);
  for (let i = 0; i < 500; i++) {
    const position = [f(200), f(200), f(200)],
      rotation = [f(20), f(20), f(20)],
      scale = [f(8) || 1, f(8) || 1, f(8) || 1];
    const text = new Text().setTransform(position, rotation, scale);
    const expected = composeMatrix(position, eulerToQuaternion(...rotation), scale, new Float32Array(16));
    assert.deepEqual([...text.matrix], [...expected], `case ${i}`);
  }
});

test('compose: identity rotation with uniform scale, and a quarter turn about +Z', () => {
  const text = new Text().setTransform([1, 2, 3], [0, 0, 0], 2);
  assert.deepEqual([...text.matrix], [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);
  const turned = new Text().setTransform([0, 0, 0], [0, 0, Math.PI / 2], 1).matrix;
  // +X maps to +Y: column 0 is (0, 1, 0).
  for (const [i, value] of [0, 1, 0].entries()) assert.ok(Math.abs(turned[i] - value) < 1e-7);
  assert.equal(turned[15], 1);
});
