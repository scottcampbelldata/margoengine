import assert from 'node:assert/strict';
import test from 'node:test';
import { DfsphSolver } from '../dist/dfsph.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const newWorld = () => new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });

test('the native liquid refuses aborted loads and belongs to its destination world', async () => {
  const world = newWorld();
  const signal = AbortSignal.abort(new Error('cancelled DFSPH load'));
  await assert.rejects(DfsphSolver.load(world.memory, { signal }), /cancelled DFSPH load/);
  const dfsph = await DfsphSolver.load(world.memory);
  assert.throws(() => dfsph.sample(0), { code: 'state' });
  assert.throws(() => newWorld().add(dfsph, {}), /Pass the destination world memory to load/);
  world.add(dfsph, { capacity: 1 });
  assert.equal(dfsph.mass, 0);
  assert.equal(dfsph.positions().length, 0);
});

test('a bad emitted batch does not take any reserved rows, and rendering uses only the live XYZ prefix', async () => {
  const world = newWorld();
  const dfsph = await DfsphSolver.load(world.memory);
  world.add(dfsph, { capacity: 3 });
  const point = { position: [0.25, 0.5, 0.75] };
  assert.equal(dfsph.emit([point]), 0);
  const mass = dfsph.mass;
  assert.throws(() => dfsph.emit([point, { position: [1, Infinity, 2] }]), /Pass an XYZ vector/);
  assert.equal(dfsph.statistics.particles, 1);
  assert.equal(dfsph.mass, mass);
  const vertices = new Float32Array(9).fill(7);
  const active = dfsph.positions(vertices);
  assert.equal(active.buffer, vertices.buffer);
  assert.deepEqual([...active], point.position);
  assert.deepEqual([...vertices.slice(3)], [7, 7, 7, 7, 7, 7]);
  assert.throws(() => dfsph.positions(new Float32Array(2)), /Provide three floats per active point/);
});
