// A body switched off through the facade: it stays where it is, its contacts end with their events, no query meets it, and it
// comes back with the velocity it had. The kernel's own proof is kernel/tests/enabled.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

test('a disabled body ends its contacts, is found by no query, and resumes with its velocity', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, -10] });
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5],
    colliders: { shape: 'box', width: 20, height: 1 },
  });
  const crate = physics.addBody(null, {
    position: [0, 0.5],
    colliders: { shape: 'box', width: 1, height: 1 },
    canSleep: false,
  });
  const events = [];
  physics.on('contactstart', (e) => events.push('start'));
  physics.on('contactend', (e) => events.push('end'));
  for (let i = 0; i < 30; i++) physics.step();
  assert.deepEqual(events, ['start'], 'resting on the floor');
  assert.equal(crate.enabled, true);
  floor.enabled = false;
  assert.equal(floor.enabled, false);
  physics.step();
  assert.deepEqual(events, ['start', 'end'], 'its contact ends');
  assert.equal(physics.raycast([-5, -0.5], [1, 0]), null, 'no ray meets the floor');
  assert.equal(physics.overlapPoint([0, -0.5]).length, 0, 'no point query finds it');
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(crate.position[1] < -2, `the crate falls through the switched-off floor: ${crate.position[1]}`);
  floor.enabled = true;
  assert.ok(physics.raycast([-5, -0.5], [1, 0]), 'switched on, the ray meets it');
  // A moving body, switched off and on, goes on with its velocity.
  const probe = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  const ball = probe.addBody(null, { position: [0, 0], colliders: { shape: 'circle', radius: 0.5 } });
  ball.linearVelocity = [3, 0];
  ball.enabled = false;
  for (let i = 0; i < 60; i++) probe.step();
  near(ball.position[0], 0, 1e-6, 'it did not move');
  near(ball.linearVelocity[0], 3, 1e-6, 'and keeps its speed');
  ball.enabled = true;
  for (let i = 0; i < 60; i++) probe.step();
  near(ball.position[0], 3, 0.06, 'a second of 3 m/s once back');
});

test('a snapshot carries the switch (a version 6 snapshot, which has none, restores in mass2d.test.js with every body enabled)', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, -10] });
  const a = physics.addBody(null, { position: [0, 3], colliders: { shape: 'circle', radius: 0.5 } });
  a.enabled = false;
  const bytes = physics.snapshot();
  a.enabled = true;
  physics.restore(bytes);
  assert.equal(a.enabled, false, 'restored off');
});
