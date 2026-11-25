// Locality: two bodies that never touch do not change each other's paths. A box pushed sideways on a floor and a box tumbling
// down onto the same floor 20 m away share nothing but the fixed floor, which keeps islands apart; the second box must land on
// the same bits whether or not the first is pushed. The guard of per-island substep levels: an island's level, and so its
// path, is a function of its own state alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

const FAR = 20;

/**
 * Box B's position after `steps` steps, with box A pushed by 0.05 N s along x before each step or not, and how far A got: A's
 * own push carries it several metres, so the test also holds that it never comes near B.
 */
function landing(push, steps, floor = true) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  if (floor)
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [40, 0.5, 10] },
    });
  const a = physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] } }),
    b = physics.addBody(null, {
      position: [FAR, 2, 0],
      angularVelocity: [0, 1, 2],
      colliders: { shape: 'box', halfExtents: [0.2, 0.4, 0.2] },
    });
  let reach = 0;
  for (let i = 0; i < steps; i++) {
    if (push) a.applyImpulse([0.05, 0, 0]);
    physics.step();
    reach = Math.max(reach, a.position[0]);
  }
  const at = b.position;
  physics.dispose();
  return { at, reach };
}

test('two boxes that never touch do not change each other: pushing one leaves the other on the same bits', () => {
  for (const steps of [30, 60, 90]) {
    const pushed = landing(true, steps),
      still = landing(false, steps);
    // A's far face against B's near face, with a metre to spare: they never touch.
    assert.ok(pushed.reach + 0.3 < FAR - 0.4 - 1, `A reached x ${pushed.reach} in ${steps} steps`);
    assert.deepEqual(pushed.at, still.at, `B after ${steps} steps`);
  }
});

test('without a shared floor the two boxes are apart too: pushing one leaves the other on the same bits', () => {
  const pushed = landing(true, 60, false),
    still = landing(false, 60, false);
  assert.ok(pushed.reach + 0.3 < FAR - 0.4 - 1, `A reached x ${pushed.reach}`);
  assert.deepEqual(pushed.at, still.at);
});
