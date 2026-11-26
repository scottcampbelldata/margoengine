import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfSolver } from '../dist/pbf.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const newWorld = () => new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });

test('the native liquid refuses aborted loads and belongs to its destination world', async () => {
  const world = newWorld();
  const signal = AbortSignal.abort(new Error('cancelled PBF load'));
  await assert.rejects(PbfSolver.load(world.memory, { signal }), /cancelled PBF load/);
  const pbf = await PbfSolver.load(world.memory);
  assert.throws(() => pbf.sample(0), { code: 'state' });
  assert.throws(() => newWorld().add(pbf, {}), /Pass the destination world memory to load/);
  world.add(pbf, { capacity: 1 });
  assert.equal(pbf.mass, 0);
  assert.equal(pbf.positions().length, 0);
});

test('a bad emitted batch does not take any reserved rows, and rendering uses only the live XYZ prefix', async () => {
  const world = newWorld();
  const pbf = await PbfSolver.load(world.memory);
  world.add(pbf, { capacity: 3 });
  const point = { position: [0.25, 0.5, 0.75] };
  assert.equal(pbf.emit([point]), 0);
  const mass = pbf.mass;
  assert.throws(() => pbf.emit([point, { position: [1, Infinity, 2] }]), /Pass an XYZ vector/);
  assert.equal(pbf.statistics.particles, 1);
  assert.equal(pbf.mass, mass);
  const vertices = new Float32Array(9).fill(7);
  const active = pbf.positions(vertices);
  assert.equal(active.buffer, vertices.buffer);
  assert.deepEqual([...active], point.position);
  assert.deepEqual([...vertices.slice(3)], [7, 7, 7, 7, 7, 7]);
  assert.throws(() => pbf.positions(new Float32Array(2)), /Provide three floats per active point/);
});
