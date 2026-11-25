// Locality: two bodies that never touch do not change each other's paths. A box pushed sideways on a floor and a box
// tumbling down onto the same floor two metres away share nothing but the fixed floor, which insulates islands; the second
// box must land on the same bits whether or not the first is pushed. Open as KB-PHYS-LOCALITY1 (docs/known-bugs.md): the
// test runs and is reported as a known failure (`todo`) until islands step independently (per-island substeps, with
// KB-PHYS-SPINFRICTION1), when it passes and the `todo` comes off.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

/** Box B's position after `steps` steps, with box A pushed by 0.05 N s along x before each step or not. */
function landing(push, steps = 30) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const a = physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] } }),
    b = physics.addBody(null, {
      position: [2, 2, 0],
      angularVelocity: [0, 1, 2],
      colliders: { shape: 'box', halfExtents: [0.2, 0.4, 0.2] },
    });
  for (let i = 0; i < steps; i++) {
    if (push) a.applyImpulse([0.05, 0, 0]);
    physics.step();
  }
  const at = b.position;
  physics.dispose();
  return at;
}

test('two boxes that never touch do not change each other: pushing one leaves the other on the same bits', {
  todo: 'KB-PHYS-LOCALITY1: box B ends about 2 cm apart in 30 steps; fixed with per-island substeps',
}, () => {
  assert.deepEqual(landing(true), landing(false));
});

test('without a shared floor the two boxes are already apart: pushing one leaves the other on the same bits', () => {
  // The same boxes falling in empty space: the coupling needs the shared fixed floor.
  const fall = (push) => {
    const physics = new Physics(null, { fixedTimestep: 1 / 60 });
    const a = physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] } }),
      b = physics.addBody(null, {
        position: [2, 2, 0],
        angularVelocity: [0, 1, 2],
        colliders: { shape: 'box', halfExtents: [0.2, 0.4, 0.2] },
      });
    for (let i = 0; i < 30; i++) {
      if (push) a.applyImpulse([0.05, 0, 0]);
      physics.step();
    }
    const at = b.position;
    physics.dispose();
    return at;
  };
  assert.deepEqual(fall(true), fall(false));
});
