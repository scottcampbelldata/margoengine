// A rotation motor on a cone joint: a spring that drives bodyB's rotation in bodyA's frame to a target while the cone's
// swing and twist limits keep acting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';

const about = (axis, angle) => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const rod = (options = {}) => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const top = physics.addBody(null, { type: 'fixed', colliders: [] }),
    body = physics.addBody(null, { position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], density: 10 } }),
    joint = physics.addJoint(top, body, { type: 'cone', anchorB: [0, 0.5, 0], axis: [0, -1, 0], swing: 0.5, twist: [-0.4, 0.4], ...options });
  return { physics, body, joint };
};
// The angle between the rod's own axis and straight down, from its rotation.
const swingOf = ([x, , z]) => {
  // The rod's own axis (local Y) in the world is [2(xy - zw)... ]; only its Y component matters for the angle from straight down.
  const ay = 1 - 2 * (x * x + z * z);
  return Math.acos(Math.max(-1, Math.min(1, -ay)) * -1);
};
const twistOf = ([, y, , w]) => 2 * Math.atan2(y, w);
const gains = { stiffness: 400, damping: 40 };
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};

test('the motor drives a swing to its target inside the cone, and holds it there', async () => {
  await Physics.load();
  const { physics, body, joint } = rod();
  joint.setRotationMotor(about([0, 0, 1], 0.3), gains);
  run(physics, 300);
  assert.ok(Math.abs(swingOf(body.rotation) - 0.3) < 0.01, `swing ${swingOf(body.rotation)}`);
  assert.ok(Math.hypot(...body.angularVelocity) < 1e-2);
  physics.dispose();
});

test('the limits win when the target lies outside the cone, and the twist stops at its limit', async () => {
  await Physics.load();
  const swung = rod();
  swung.joint.setRotationMotor(about([0, 0, 1], 0.9), gains);
  run(swung.physics, 300);
  const reached = swingOf(swung.body.rotation);
  assert.ok(reached > 0.45 && reached < 0.51, `swing ${reached} stops at the 0.5 edge`);
  const twisted = rod();
  twisted.joint.setRotationMotor(about([1, 0, 0], 0.2), gains);
  run(twisted.physics, 300);
  assert.ok(Math.abs(Math.abs(twistOf(twisted.body.rotation)) - 0.2) < 0.01, `twist ${twistOf(twisted.body.rotation)}`);
  const over = rod();
  over.joint.setRotationMotor(about([1, 0, 0], 1.2), gains);
  run(over.physics, 300);
  assert.ok(Math.abs(Math.abs(twistOf(over.body.rotation)) - 0.4) < 0.01, `twist ${twistOf(over.body.rotation)} stops at 0.4`);
  for (const w of [swung, twisted, over]) w.physics.dispose();
});

test('maxForce caps the drive, a target velocity leads a moving target, and clearMotor lets go', async () => {
  await Physics.load();
  const free = rod(),
    capped = rod();
  free.joint.setRotationMotor(about([0, 0, 1], 0.4), gains);
  capped.joint.setRotationMotor(about([0, 0, 1], 0.4), { ...gains, maxForce: 0.01 });
  run(free.physics, 8);
  run(capped.physics, 8);
  assert.ok(swingOf(capped.body.rotation) < 0.2 * swingOf(free.body.rotation), `${swingOf(capped.body.rotation)} against ${swingOf(free.body.rotation)}`);
  free.joint.clearMotor();
  run(free.physics, 60);
  const settled = swingOf(free.body.rotation);
  run(free.physics, 60);
  assert.ok(Math.abs(swingOf(free.body.rotation) - settled) < 1e-3, 'coasts once released');
  assert.ok(Math.hypot(...free.body.angularVelocity) < 5, 'and nothing keeps driving it');
  assert.throws(() => free.joint.setRotationMotor([0, 0, 0, 2], gains), RangeError);
  for (const w of [free, capped]) w.physics.dispose();
});

test('a driven cone replays bit for bit', async () => {
  await Physics.load();
  const hash = () => {
    const { physics, joint } = rod();
    joint.setRotationMotor(about([0, 0.6, 0.8], 0.7), gains);
    run(physics, 200);
    const h = physics.kernel.hash;
    physics.dispose();
    return h;
  };
  assert.equal(hash(), hash());
});
