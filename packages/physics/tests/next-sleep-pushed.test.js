// A body the solver is still pulling home is not at rest: the soft solver closes a joint's or a contact's error by moving the
// pose and leaves no velocity, so the sleep test must read the pose as well as the velocity.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

test('a body a joint pulls home from 1.5 m away does not fall asleep on the way', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const anchor = physics.addBody(null, { type: 'fixed' });
  const weight = physics.addBody(null, {
    position: [0, -2, 0],
    colliders: { shape: 'sphere', radius: 0.25, mass: 10 },
  });
  physics.addJoint(anchor, weight, { type: 'spherical', anchorA: [0, 0.5, 0], anchorB: [0, 1, 0] });
  for (let i = 0; i < 200; i++) physics.step();
  // The joint closes 3 m/s of error and the body reads still: it used to sleep 0.05 m short of home.
  assert.ok(Math.abs(weight.position[1] + 0.5) < 1e-3, `home at -0.5: ${weight.position[1]}`);
  physics.dispose();
});
