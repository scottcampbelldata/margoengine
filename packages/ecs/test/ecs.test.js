import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/index.js';
test('packed rows move intact, generations reject stale handles and queries intersect component sets', () => {
  const world = new World(3),
    position = world.component({ x: Float32Array, y: Float32Array }),
    health = world.component({ value: Uint8Array });
  const a = world.create(),
    b = world.create(),
    c = world.create();
  position.add(a, { x: 1 });
  position.add(b, { x: 2 });
  position.add(c, { x: 3 });
  health.add(b, { value: 100 });
  const output = new Uint32Array(3);
  assert.equal(world.query([position, health], output), 1);
  assert.equal(output[0], b);
  world.destroy(a);
  assert.equal(position.fields.x[position.index(c)], 3);
  assert.equal(position.size, 2);
  const reused = world.create();
  assert.notEqual(reused, a);
  assert.equal(world.alive(a), false);
  assert.throws(() => position.add(a), /stale/);
  assert.throws(() => world.create(), /capacity/);
  assert.throws(() => position.add(b, { x: NaN }), /Invalid/);
  assert.equal(position.fields.x[position.index(b)], 2);
  const foreign = new World(2).component({ x: Float32Array });
  assert.throws(() => world.query([foreign], output), /world/);
  for (const value of [-1, 256, 2.5]) assert.throws(() => health.add(b, { value }), /Invalid/);
  assert.equal(health.fields.value[health.index(b)], 100);
  assert.throws(() => world.query([position], new Uint32Array(0)), /small/);
});
