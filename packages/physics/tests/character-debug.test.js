// What a character controller reports of its ground and draws for the debug view: slope angle, ground normal, platform velocity.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, eulerToQuat } from '../dist/index.js';

await Physics.load();
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);
const capsule = (physics, position) =>
  physics.addBody(null, {
    type: 'kinematicPosition',
    position,
    colliders: { shape: 'capsule', halfHeight: 0.4, radius: 0.3 },
  });

test('on a 20 degree slope the controller reports the slope and its normal, in the air up and 0', () => {
  const physics = new Physics(null),
    angle = (20 * Math.PI) / 180;
  physics.addBody(null, {
    type: 'fixed',
    rotation: eulerToQuat(0, 0, angle),
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });
  // The top face passes through (0, 0.5 / cos a, 0); stand the capsule's bottom just over it.
  const body = capsule(physics, [0, 0.5 / Math.cos(angle) + 0.7 + 0.011, 0]),
    controller = physics.createCharacterController(body);
  for (let i = 0; i < 5; i++) {
    controller.move([0, -0.05, 0]);
    physics.step();
  }
  assert.equal(controller.grounded, true);
  near(controller.slopeAngle, angle, 1e-4, 'slope angle');
  const n = controller.groundNormal;
  near(n[0], -Math.sin(angle), 1e-4, 'normal x');
  near(n[1], Math.cos(angle), 1e-4, 'normal y');
  const lines = controller.debugRender();
  assert.ok(lines.vertices.length > 0 && lines.colors.length === (lines.vertices.length / 3) * 4);
  assert.equal(
    controller.debugRender({ capsule: false, ground: false, autostep: false, contacts: false }).vertices.length,
    0,
  );

  controller.move([0, 2, 0]);
  physics.step();
  assert.equal(controller.grounded, false);
  assert.equal(controller.slopeAngle, 0);
  assert.deepEqual(controller.groundNormal, [0, 1, 0]);
});

test('on a moving platform the controller reports the velocity it inherits', () => {
  const physics = new Physics(null),
    platform = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
    }),
    body = capsule(physics, [0, 0.711, 0]),
    controller = physics.createCharacterController(body);
  for (let i = 0; i < 10; i++) {
    platform.setNextPosition([(i + 1) * 1.5 * physics.fixedTimestep, -0.5, 0]);
    controller.move([0, -0.01, 0]);
    physics.step();
  }
  const v = controller.platformVelocity;
  near(v[0], 1.5, 1e-3, 'platform velocity x');
  near(v[1], 0, 1e-6, 'platform velocity y');
});
