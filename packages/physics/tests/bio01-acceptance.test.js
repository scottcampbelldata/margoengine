import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlantSway } from '../dist/vegetation.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const plant = { root: [2, -1, 4], height: 3, baseDiameter: 0.05, youngModulus: 1e9, density: 650 };

function stillAir(cell, velocity = [2, 0, 1], point) {
  return {
    medium: 'air',
    cell,
    sample(x, y, z) {
      point?.([x, y, z]);
      return { velocity, density: 1.225, temperature: 288.15 };
    },
  };
}

test('BIO-01 samples flow in a distinct signed origin and republishes its roots after shift and rewind', async () => {
  const cellSize = 2048;
  const origin = [1234567, -2345678, 3456789];
  const field = [origin[0] + 2, origin[1] - 1, origin[2] + 3];
  const shift = [-5600000, 7600000, -2220000];
  const points = [];
  const sway = await PlantSway.load();
  const world = new PhysicsWorld({ rate }).add(
    sway,
    { plants: [plant], flow: stillAir(field, undefined, (p) => points.push(p)), cellSize },
    origin,
  );
  const baseline = await PlantSway.load();
  const comparison = new PhysicsWorld({ rate }).add(
    baseline,
    { plants: [plant], flow: stillAir(origin), cellSize },
    origin,
  );
  world.advance(1);
  comparison.advance(1);
  assert.deepEqual(sway.readSway(), baseline.readSway());
  assert.deepEqual([points[0][0], points[0][2]], [plant.root[0] - 2 * cellSize, plant.root[2] - 3 * cellSize]);
  assert(points[0][1] > plant.root[1] + cellSize && points[0][1] < plant.root[1] + cellSize + plant.height);
  assert(sway.exportPorts(world.tick).every((port) => port.cell.every((value, axis) => value === origin[axis])));
  const prior = world.takeSnapshot();
  world.shiftOrigin(shift);
  comparison.shiftOrigin(shift);
  world.advance(2);
  comparison.advance(2);
  assert.deepEqual(sway.readSway(), baseline.readSway());
  const moved = origin.map((value, axis) => value - shift[axis]);
  assert.deepEqual(sway.cell, moved);
  assert(sway.exportPorts(world.tick).every((port) => port.cell.every((value, axis) => value === moved[axis])));
  const later = world.takeSnapshot();
  world.restoreSnapshot(prior.bytes);
  assert.deepEqual(sway.cell, origin);
  world.shiftOrigin(shift);
  world.advance(2);
  assert.deepEqual(world.takeSnapshot().bytes, later.bytes);
});

test('BIO-01 rejects finite flow samples whose acceleration overflows without clearing a live pose', async () => {
  let bad = false;
  let calls = 0;
  const flow = {
    medium: 'air',
    cell: [0, 0, 0],
    sample() {
      const x = !bad ? 3 : [0, -Number.MAX_VALUE, Number.MAX_VALUE][calls++ % 3];
      return { velocity: [x, 0, 1], density: 1.225, temperature: 288.15 };
    },
  };
  const sway = await PlantSway.load();
  const world = new PhysicsWorld({ rate }).add(sway, { plants: [plant], flow });
  world.advance(1);
  const before = sway.readSway();
  const acceptedTick = world.tick;
  assert(before[0] !== 0);
  bad = true;
  assert.throws(() => world.advance(2), {
    name: 'MargoError',
    code: 'state',
    message: /flow acceleration.*physically scaled/i,
  });
  assert.equal(world.tick, acceptedTick);
  assert.deepEqual(sway.readSway(), before);
});
