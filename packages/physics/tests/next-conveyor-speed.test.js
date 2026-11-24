// The tangent target velocity of a contact reaches the friction rows: a crate on a belt reaches the belt's speed and keeps it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

test('a crate on a belt settles at the set speed, in both directions and at an angle to its edge', async () => {
  await Physics.load();
  for (const [vx, vz] of [
    [3, 0],
    [-2, 0],
    [1.5, 1.5],
  ]) {
    const physics = new Physics(null, {
      contactModifier: (contact) => {
        const sign = contact.first.body.type === 'fixed' ? 1 : -1;
        contact.surfaceVelocity = [sign * vx, 0, sign * vz];
      },
    });
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [80, 0.5, 80], friction: 1, modifyContacts: true },
    });
    const crate = physics.addBody(null, {
      position: [0, 0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], friction: 1 },
    });
    for (let i = 0; i < 240; i++) physics.step();
    const v = crate.linearVelocity;
    assert.ok(
      Math.abs(v[0] - vx) < 0.02 && Math.abs(v[2] - vz) < 0.02,
      `belt [${vx}, ${vz}] carries at [${v[0]}, ${v[2]}]`,
    );
    assert.ok(Math.abs(v[1]) < 0.02);
    physics.dispose();
  }
});
