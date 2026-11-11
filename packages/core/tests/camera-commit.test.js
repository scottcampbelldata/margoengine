import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../dist/extension.js';

test('a rejected camera update keeps the last good matrix and planes', () => {
  const camera = new Camera({ position: [0, 2, 5], target: [0, 0, 0] });
  camera.update(1.5, true);
  const matrix = camera.matrix.slice(),
    planes = camera.planes.slice();
  // fov 1e-37 degrees: 1 / tan(fov / 2) passes float32's largest value, so the matrix is not finite.
  camera.fov = 1e-37;
  assert.throws(() => camera.update(1.5, true), RangeError);
  assert.deepEqual(camera.matrix, matrix, 'matrix unchanged');
  assert.deepEqual(camera.planes, planes, 'planes unchanged');
  camera.fov = 60;
  camera.update(1.5, true);
  assert.deepEqual(camera.matrix, matrix, 'a valid update publishes again');
});
