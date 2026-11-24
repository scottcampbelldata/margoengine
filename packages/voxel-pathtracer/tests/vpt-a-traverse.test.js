// CPU traversal (traverse.ts) on rays that start exactly on a cell plane and run toward lower coordinates: the point
// belongs to the cell ahead of the ray, as in the shader's march (forwardCell), never to the cell behind it. Amanatides
// and Woo 1987 start the walk in the cell the ray is in; a ray leaving the plane y = k downward is in cell k - 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { bruteForce, fakeEngine, materials, model, simpleScene } from './support.js';

const attach = (scene) => VoxelPathTracer.attach(fakeEngine().engine, { scene });

test('a ray starting on a cell plane walks from the cell ahead of it, inside a mixed brick', () => {
  // Palette 2 above the plane y = 10 (behind the ray), empty below it down to y = 5, palette 1 under that.
  const m = model('m', [8, 16, 8], (x, y) => (y === 10 ? 2 : y < 5 ? 1 : 0));
  const tracer = attach(simpleScene({ models: [m], materials: materials([1, 2]) }));
  const o = [4.5, 10, 4.5],
    d = [0, -1, 0],
    hit = tracer.raycast(o, d),
    want = bruteForce(m, [o[0], o[1] - 1e-9, o[2]], d);
  assert.equal(hit?.paletteIndex, 1);
  assert.equal(hit.distance, 5);
  assert.deepEqual(hit.cell, want.cell);
  // The same along -x and -z.
  const side = tracer.raycast([4, 10.5, 4.5], [-1, 0, 0]);
  assert.equal(side?.paletteIndex, 2);
  assert.equal(side.distance, 0);
  assert.deepEqual(side.cell, [3, 10, 4]);
  tracer.dispose();
});

test('a ray starting on a brick plane walks from the brick ahead of it', () => {
  // Palette 2 in the cell layer y = 8 (first layer of brick 1, behind the ray), palette 1 at y < 3.
  const m = model('m', [8, 16, 8], (x, y) => (y === 8 ? 2 : y < 3 ? 1 : 0));
  const tracer = attach(simpleScene({ models: [m], materials: materials([1, 2]) }));
  const hit = tracer.raycast([4.5, 8, 4.5], [0, -1, 0]);
  assert.equal(hit?.paletteIndex, 1);
  assert.equal(hit.distance, 5);
  assert.deepEqual(hit.cell, [4, 2, 4]);
  tracer.dispose();
});

test('a ray starting on a uniform brick plane is not stopped by the brick behind it', () => {
  // Brick y 1 (cells 8..15) is uniform palette 2; brick y 0 is empty above y = 3 and palette 1 below.
  const m = model('m', [8, 16, 8], (x, y) => (y >= 8 ? 2 : y < 3 ? 1 : 0));
  const tracer = attach(simpleScene({ models: [m], materials: materials([1, 2]) }));
  const hit = tracer.raycast([4.5, 8, 4.5], [0, -1, 0]);
  assert.equal(hit?.paletteIndex, 1);
  assert.equal(hit.distance, 5);
  tracer.dispose();
});
