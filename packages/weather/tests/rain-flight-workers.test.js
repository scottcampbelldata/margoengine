import assert from 'node:assert/strict';
import test from 'node:test';
import { FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';
import { rainFallSpeed, rainSphere, WATER_DENSITY } from '@margoengine/weather/precipitation';
import { followRainFlight, rainCell } from './fixtures/rain-flight-workers.mjs';

const data = ({ snapshot, poses, draw, cell }) => ({ snapshot, poses, draw, cell });

for (const count of [511, 769]) {
  test(`K23 advances ${count} size-resolved rain drops with exact ordered contacts and signed replay`, async () => {
    const plain = await followRainFlight(count, 1);
    assert.deepEqual(data(plain.accepted), data(plain.replay));
    assert.deepEqual(plain.accepted.cell, rainCell);
    assert.ok(plain.accepted.grounded.position[1] < 0.001);
    assert.ok(plain.accepted.large.velocity[1] < plain.accepted.small.velocity[1]);
    for (const [threads, shared] of [
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const native = await followRainFlight(count, threads, shared);
      assert.deepEqual(data(native.accepted), data(plain.accepted));
      assert.deepEqual(data(native.accepted), data(native.replay));
      assert.deepEqual(native.accepted.work, native.replay.work);
      for (const [i, receipt] of native.accepted.work.entries()) {
        assert.equal(receipt.threads, threads);
        assert.equal(receipt.bodies, count);
        assert.equal(receipt.rk4Evaluations, plain.accepted.work[i].rk4Evaluations);
        assert.equal(receipt.simdStatePairs, plain.accepted.work[i].simdStatePairs);
        for (const [part, worker] of receipt.workers.entries()) {
          assert.equal(
            worker.bodies,
            Math.floor((count * (part + 1)) / threads) - Math.floor((count * part) / threads),
          );
          assert.ok(worker.rk4Evaluations >= 3 * worker.bodies);
          assert.equal(worker.simdStatePairs, 28 * worker.rk4Evaluations);
        }
      }
    }
  });
}

test('rain drag holds the analytic buoyancy-corrected terminal speed in native flight', async () => {
  const gravity = 9.81;
  const air = { density: 1.12, temperature: 287, gravity };
  const diameters = [0.00055, 0.0016, 0.0043];
  const vt = diameters.map((diameter) => rainFallSpeed(diameter, air));
  using flight = await FallingSolver.load({ rate: 0 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0] }).add(flight, {
    bodies: diameters.map((diameter, i) => rainSphere({ diameter, position: [0, 10, 0], velocity: [2, -vt[i], -1] })),
    wind: { cell: [0, 0, 0], medium: 'air', sample: () => ({ ...air, velocity: [2, 0, -1] }) },
  });
  world.advance(60);
  for (const [i, diameter] of diameters.entries()) {
    const drop = rainSphere({ diameter });
    const area = Math.PI * (diameter / 2) * (diameter / 2);
    const drag = 0.5 * air.density * area * drop.drag(air) * vt[i] * vt[i];
    const weight = drop.mass * (1 - air.density / WATER_DENSITY) * gravity;
    assert.ok(Math.abs(drag / weight - 1) <= 8 * Number.EPSILON);
    const pose = flight.pose(i);
    assert.ok(Math.abs(pose.velocity[1] + vt[i]) < 2e-13);
    assert.ok(Math.abs(pose.position[1] - (10 - vt[i])) < 5e-13);
    assert.equal(pose.velocity[0], 2);
    assert.equal(pose.velocity[2], -1);
  }
});

test('rain spheres name the correction for invalid geometry, air and restitution', () => {
  const coded = { name: 'MargoError', message: /#precipitation/ };
  assert.throws(() => rainSphere({ diameter: 0 }), coded);
  assert.throws(() => rainSphere({ diameter: 1e-250 }), coded);
  assert.throws(() => rainSphere({ diameter: 0.002, position: [0, Infinity, 0] }), coded);
  assert.throws(() => rainSphere({ diameter: 0.002, restitution: -0.1 }), coded);
  const drop = rainSphere({ diameter: 0.002 });
  assert.equal(drop.restitution, 0);
  assert.throws(() => drop.drag({ density: WATER_DENSITY, temperature: 288, gravity: 9.81 }), coded);
  assert.ok(drop.drag({ density: 1.2, temperature: 288, gravity: 0 }) > 0);
});

test('a rejected contact keeps accepted rain poses and work after all four native participants finish', async () => {
  using rain = await FallingSolver.load({ rate: 0, threads: 4 });
  let reject = false;
  const bodies = Array.from({ length: 9 }, (_, i) =>
    rainSphere({ diameter: 0.001 + 0.0001 * i, position: [i, 2, 0], velocity: [0, -0.8, 0] }),
  );
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(rain, {
    bodies,
    boundary: {
      cell: [0, 0, 0],
      sweep: (center) => (reject && center[0] >= 8 ? { fraction: 1.5, normal: [0, 1, 0] } : null),
    },
  });
  world.advance(1);
  const accepted = world.takeSnapshot();
  const words = () => rain.stateRegions().map((r) => regionWords(world.memory, r).slice());
  const before = words();
  const work = rain.readNativeWork();
  assert.equal(work.workers.length, 4);
  reject = true;
  assert.throws(() => world.advance(2), { name: 'MargoError', message: /Provide a segment fraction/ });
  assert.deepEqual(words(), before);
  assert.deepEqual(rain.readNativeWork(), work);
  reject = false;
  world.restoreSnapshot(accepted.bytes);
  world.advance(2);
  const reached = world.takeSnapshot();
  world.restoreSnapshot(accepted.bytes);
  world.advance(2);
  assert.deepEqual(world.takeSnapshot(), reached);
});
