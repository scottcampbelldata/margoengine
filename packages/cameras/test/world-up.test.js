import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection } from '../dist/index.js';

test('projection singularities follow world up rather than a hardcoded Y axis', () => {
  const camera = new Camera({ position: [0, -10, 0], target: [0, 0, 0] });
  camera.up = [0, 0, 1];
  using projection = new CameraProjection({ up: [0, 1, 0] });
  projection.attach(camera);
  assert.deepEqual(camera.up, [0, 0, 1]);
  camera.update(1, true);
  camera.position = [0, 0, 10];
  assert.deepEqual(camera.up, [0, 1, 0]);
  camera.update(1, true);
  projection.up = [0, 0, -1];
  assert.throws(() => camera.update(1, true), /vertical up/);
  camera.up = [NaN, 0, 0];
  assert.throws(() => camera.update(1, true), /world up/);
});
