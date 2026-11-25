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

const path = process.env.RAPIER2D_MODULE;
test('disabling a body does what Rapier 2D does: its colliders read disabled, a ball falls through, a moving body keeps its velocity', {
  skip: path ? false : 'not run: RAPIER2D_MODULE names no Rapier 2D module',
}, async () => {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const R = (await import(pathToFileURL(resolve(path)).href)).default;
  await R.init();
  for (const kind of ['rapier', 'own']) {
    let floorEnabled, colliderEnabled, ballY, probeX, probeVx, resumedX;
    if (kind === 'rapier') {
      const w = new R.World({ x: 0, y: -10 });
      const floor = w.createRigidBody(R.RigidBodyDesc.fixed());
      const collider = w.createCollider(R.ColliderDesc.cuboid(10, 0.5), floor);
      const ball = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 3));
      w.createCollider(R.ColliderDesc.ball(0.5), ball);
      floor.setEnabled(false);
      for (let i = 0; i < 120; i++) w.step();
      [floorEnabled, colliderEnabled, ballY] = [floor.isEnabled(), collider.isEnabled(), ball.translation().y];
      const probe = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 20).setLinvel(3, 0));
      w.createCollider(R.ColliderDesc.ball(0.5), probe);
      probe.setEnabled(false);
      for (let i = 0; i < 60; i++) w.step();
      [probeX, probeVx] = [probe.translation().x, probe.linvel().x];
      probe.setEnabled(true);
      for (let i = 0; i < 60; i++) w.step();
      resumedX = probe.translation().x;
    } else {
      const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, -10] });
      const floor = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', width: 20, height: 1 } });
      const ball = physics.addBody(null, { position: [0, 3], colliders: { shape: 'circle', radius: 0.5 } });
      floor.enabled = false;
      for (let i = 0; i < 120; i++) physics.step();
      [floorEnabled, colliderEnabled, ballY] = [
        floor.enabled,
        floor.colliders?.[0]?.isEnabled ?? false,
        ball.position[1],
      ];
      const probe = physics.addBody(null, { position: [0, 20], colliders: { shape: 'circle', radius: 0.5 } });
      probe.linearVelocity = [3, 0];
      probe.enabled = false;
      for (let i = 0; i < 60; i++) physics.step();
      [probeX, probeVx] = [probe.position[0], probe.linearVelocity[0]];
      probe.enabled = true;
      for (let i = 0; i < 60; i++) physics.step();
      resumedX = probe.position[0];
    }
    assert.equal(floorEnabled, false, `${kind}: the body reads disabled`);
    assert.equal(colliderEnabled, false, `${kind}: so does its collider`);
    assert.ok(ballY < -1, `${kind}: a ball falls through (${ballY})`);
    near(probeX, 0, 1e-6, `${kind}: a disabled body does not move`);
    near(probeVx, 3, 1e-6, `${kind}: and keeps its velocity`);
    near(resumedX, 3, 0.06, `${kind}: and goes on at it once enabled`);
  }
});
