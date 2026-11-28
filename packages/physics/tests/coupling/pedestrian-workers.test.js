import assert from 'node:assert/strict';
import test from 'node:test';
import { PedestrianCrowd } from '../../dist/pedestrians.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import {
  corridorWalkers,
  corridorWalls,
  followPedestrians,
  height,
  pedestrianCell,
} from '../fixtures/pedestrian-workers.mjs';

for (const count of [79, 113]) {
  test(`LIFE-05 native corridor, wall contact and signed rewind agree for ${count} walkers`, async () => {
    const serial = await followPedestrians(count, 1);
    const { state } = serial.accepted;
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, pedestrianCell);
    assert.ok(state.walkers.some(({ anticipationForce }) => anticipationForce.some((force) => force !== 0)));
    assert.ok(state.walkers.slice(0, 4).some(({ normalLoad }) => normalLoad > 0));
    assert.ok(state.walkers.some(({ velocity }) => velocity[1] !== 0));
    for (const {
      position: [x, y, z],
      distanceTravelled,
    } of state.walkers) {
      assert.equal(y, height(x, z));
      assert.ok(distanceTravelled > 0);
    }

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const run = shared ? await followPedestrians(count, threads, shared) : serial;
      assert.deepEqual(run.accepted.state, state);
      assert.deepEqual(run.replay, run.accepted);
      for (const [frame, receipt] of run.accepted.work.entries()) {
        assert.equal(receipt.threads, threads);
        const { workers, threads: _threads, ...totals } = receipt;
        const { workers: _serial, threads: _one, ...serialTotals } = serial.accepted.work[frame];
        assert.deepEqual(totals, serialTotals);
        for (const [part, work] of workers.entries()) {
          const rows = Math.floor((count * (part + 1)) / threads) - Math.floor((count * part) / threads);
          const checks = rows * corridorWalls.length;
          assert.equal(work.driven, rows);
          assert.equal(work.integrated, rows);
          assert.equal(work.wallChecks, checks);
          // Positive stiffness and zero approach damping make every solved tangent a loaded normal wall contact.
          assert.equal(work.pairedDots, 2 * rows + 8 * checks + work.wallContacts);
          assert.ok(work.wallContacts > 0);
        }
      }
    }
  });
}

test('LIFE-05 projection rejection preserves accepted contacts, poses and native work', async () => {
  using solver = await PedestrianCrowd.load({ threads: 4 });
  const rate = { num: 60, den: 1 };
  const world = new PhysicsWorld({ rate, memory: worldMemory(true) });
  let reject = false;
  world.add(solver, {
    bodies: corridorWalkers(15),
    walls: corridorWalls,
    stiffness: 3200,
    ground: { locate: () => 0, heightAt: (_, x, z) => (reject ? Infinity : height(x, z)) },
  });
  world.advance(1);
  const before = world.takeSnapshot();
  const work = solver.readNativeWork();
  reject = true;
  assert.throws(
    () => solver.step({ tick: 1, seed: 7, level: 0, inputs: new Map(), cell: [0, 0, 0] }, 1 / 60),
    /height.*#pedestrians/i,
  );
  assert.deepEqual(world.takeSnapshot(), before);
  assert.deepEqual(solver.readNativeWork(), work);
  reject = false;
  world.advance(2);
  assert.notEqual(world.hash(), before.hash);
});
