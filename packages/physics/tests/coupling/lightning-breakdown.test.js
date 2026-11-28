import assert from 'node:assert/strict';
import test from 'node:test';
import { LightningSolver } from '../../dist/lightning.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const spacing = 100;
const size = [5, 5, 5];
const rate = { num: 60, den: 1 };
// A parallel-plate Laplace field is exactly linear. This benchmark prescribes
// the plate separation and voltage independently of the two bond thresholds.
const separation = (size[1] - 1) * spacing;
const initiation = 1_200;
const fieldError = 1e-7;

async function basin(shared, cloudPotential, propagation) {
  const solver = await LightningSolver.load();
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) }).add(solver, {
    size,
    spacing,
    cloudPotential,
    tolerance: 1e-10,
    breakdown: { initiation, propagation },
  });
  return { solver, world };
}

test('bond breakdown separates uniform fields below and above inception in SI units', async () => {
  for (const polarity of [-1, 1]) {
    for (const [field, ignites] of [
      [950, false],
      [1_450, true],
    ]) {
      const { solver, world } = await basin(false, polarity * field * separation, 5);
      const cloud = solver.potentialAt(2, 4, 2);
      const below = solver.potentialAt(2, 3, 2);
      assert.ok(Math.abs(Math.abs(cloud - below) / spacing - field) <= fieldError);
      world.advance(6);
      assert.equal(solver.status, ignites ? 'grounded' : 'halted');
      assert.equal(solver.flash !== undefined, ignites);
      if (ignites) {
        assert.equal(solver.channel().end[1], 0);
      } else {
        assert.equal(solver.channel().count, 0);
        assert.deepEqual(solver.thunder(), []);
      }
    }
  }
});

test('a seeded leader can stop under the propagation threshold without publishing a flash and replays identically', async () => {
  const accepted = [];
  for (const shared of [false, true]) {
    // The discrete maximum principle bounds every potential by the two plates
    // after the first node is pinned to the cloud. No bond can have a larger
    // field than the full potential difference over one grid spacing.
    const voltage = -1_450 * separation;
    const inaccessibleField = Math.abs(voltage) / spacing + 100;
    const { solver, world } = await basin(shared, voltage, inaccessibleField);
    const before = world.takeSnapshot();
    world.advance(2);
    assert.equal(solver.status, 'halted');
    assert.equal(solver.channel().count, 1);
    assert.equal(solver.flash, undefined);
    assert.deepEqual(solver.thunder(), []);
    const after = world.takeSnapshot();
    world.restoreSnapshot(before.bytes);
    world.advance(2);
    assert.deepEqual(world.takeSnapshot().bytes, after.bytes);
    accepted.push(after.bytes);
  }
  assert.deepEqual(accepted[0], accepted[1]);
});
