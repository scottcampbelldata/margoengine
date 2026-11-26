import assert from 'node:assert/strict';
import test from 'node:test';
import { SeaIce } from '../../../water/dist/ice.js';
import { PackIceSolver } from '../../dist/pack-ice.js';
import { PhysicsWorld } from '../../dist/world.js';

test('PackIceSolver: Water renders the submitted footprint, thickness and yaw after each world step and seek', async () => {
  const solver = await PackIceSolver.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, {
    restitution: 0,
    floes: [
      { position: [-1.01, 0], velocity: [10, 0], radius: 1, thickness: 0.06, spin: 0.2 },
      { position: [1.01, 0], velocity: [-10, 0], radius: 1, thickness: 0.06 },
    ],
  });
  const water = { sample: () => ({ height: 0 }) };
  const view = new SeaIce({ size: [10, 10], floeSource: solver, wind: { speed: 30 } });
  const start = world.takeSnapshot();
  world.advance(1);
  view.update(water, 1 / 60);
  const saved = view.matrices.slice();
  const floe = solver.sample(0);
  assert.ok(floe.raftedVolume > 0);
  assert.equal(view.matrices[5], Math.fround(floe.equivalentThickness));
  assert.equal(view.matrices[0], Math.fround(2 * floe.radius * Math.cos(floe.heading)));
  assert.equal(view.matrices[12], Math.fround(floe.position[0]));
  assert.equal(view.matrices[14], Math.fround(floe.position[1]));
  assert.deepEqual(view.at(0), floe.position);
  view.update(water, 1);
  assert.deepEqual(view.matrices, saved, 'render updates have no authority over the physics poses');
  world.restoreSnapshot(start.bytes);
  view.update(water, 0);
  assert.equal(view.matrices[0], 2);
  world.advance(1);
  view.update(water, 0);
  assert.deepEqual(view.matrices, saved);
});
