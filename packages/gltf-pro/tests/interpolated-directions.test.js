import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePreparedGeometry } from '../dist/index.js';
test('clipped prepared geometry opts into convex direction interpolants without changing authored validation', () => {
  const vertices = new Float32Array(60),
    indices = new Uint32Array([0, 1, 2]);
  for (let i = 0; i < 3; i++) {
    vertices[i * 20 + 3] = 1;
    vertices[i * 20 + 4] = 0.5;
    vertices[i * 20 + 5] = 0.5;
    vertices.set([1, 1, 1, 1], i * 20 + 16);
  }
  assert.throws(() => validatePreparedGeometry({ vertices, indices }), /normal/);
  validatePreparedGeometry({ vertices, indices, interpolatedDirections: true });
  vertices[4] = 2;
  assert.throws(() => validatePreparedGeometry({ vertices, indices, interpolatedDirections: true }), /normal/);
  vertices[4] = NaN;
  assert.throws(() => validatePreparedGeometry({ vertices, indices, interpolatedDirections: true }), /Non-finite/);
});
