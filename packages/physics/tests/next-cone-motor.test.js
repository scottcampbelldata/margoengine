// A rotation motor on a cone joint: a spring that drives bodyB's rotation in bodyA's frame to a target while the cone's
// swing and twist limits keep acting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const about = (axis, angle) => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const rod = (options = {}) => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const top = physics.addBody(null, { type: 'fixed', colliders: [] }),
    body = physics.addBody(null, {
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], density: 10 },
    }),
    joint = physics.addJoint(top, body, {
      type: 'cone',
      anchorB: [0, 0.5, 0],
      axis: [0, -1, 0],
      swing: 0.5,
      twist: [-0.4, 0.4],
      ...options,
    });
  return { physics, body, joint };
};
// The angle between the rod's own axis and straight down, from its rotation.
const swingOf = ([x, , z]) => {
  // The rod's own axis (local Y) in the world is [2(xy - zw)... ]; only its Y component matters for the angle from straight down.
  const ay = 1 - 2 * (x * x + z * z);
  return Math.acos(Math.max(-1, Math.min(1, -ay)) * -1);
};
const near = (a, e, t, label) => assert.ok(Math.abs(a - e) <= t, `${label}: ${a} is not within ${t} of ${e}`);
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
  assert.ok(
    Math.abs(Math.abs(twistOf(over.body.rotation)) - 0.4) < 0.01,
    `twist ${twistOf(over.body.rotation)} stops at 0.4`,
  );
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
  assert.ok(
    swingOf(capped.body.rotation) < 0.2 * swingOf(free.body.rotation),
    `${swingOf(capped.body.rotation)} against ${swingOf(free.body.rotation)}`,
  );
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

test('a driven cone holds a swing against gravity with its anchor where it was: the motor pushes along its own rows, not the cone\'s', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const top = physics.addBody(null, { type: 'fixed', colliders: [] }),
    body = physics.addBody(null, { position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], density: 10 } }),
    joint = physics.addJoint(top, body, { type: 'cone', anchorB: [0, 0.5, 0], axis: [0, -1, 0], swing: 0.5, twist: [-0.4, 0.4] });
  joint.setRotationMotor(about([0, 0, 1], 0.3), { model: 'force', stiffness: 40, damping: 4 });
  let stray = 0;
  for (let i = 0; i < 360; i++) {
    physics.step();
    // The rod's top end is the pivot; its centre stays half a metre from it.
    stray = Math.max(stray, Math.abs(Math.hypot(...body.position) - 0.5));
  }
  assert.ok(stray < 1e-3, `the pivot of the rod strayed ${stray} m`);
  assert.ok(Math.hypot(...body.linearVelocity) < 1e-2, 'at rest');
  // Spring 40 N m/rad against the weight's torque 0.1 kg x 9.81 x 0.5 m x sin(angle): about 0.296 rad.
  near(swingOf(body.rotation), 0.296, 0.01, 'swing');
  physics.dispose();
});

test('a cone whose rest pose lies off its frames holds that pose under a motor aimed at it (KB-PHYS-SWITCH-CONE1)', async () => {
  await Physics.load();
  const quarter = about([0, 0, 1], Math.PI / 2);
  const product = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  for (const model of ['force', 'acceleration']) {
    const physics = new Physics(null);
    const rest = about([1, 0, 0], 0.15);
    const top = physics.addBody(null, { type: 'fixed', colliders: [] }),
      rod = physics.addBody(null, {
        rotation: rest,
        colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], offset: [0, 0.5, 0], mass: 2 },
      }),
      joint = physics.addJoint(top, rod, { type: 'cone', frameA: product(rest, quarter), frameB: quarter, swing: 3, twist: [-0.5, 0.5] });
    const w = 2 * Math.PI * 8;
    let widest = 0;
    for (let i = 0; i < 120; i++) {
      joint.setRotationMotor([0, 0, 0, 1], { model, stiffness: model === 'force' ? 0.67 * w * w : w * w, damping: model === 'force' ? 2 * 0.67 * w * 0.7 : 2 * w * 0.7, maxForce: 1e6 });
      physics.step();
      // The rod's turn from where it was placed.
      const q = product([-rest[0], -rest[1], -rest[2], rest[3]], rod.rotation);
      widest = Math.max(widest, 2 * Math.acos(Math.min(1, Math.abs(q[3]))));
    }
    assert.ok(widest < 0.2, `${model}: the rod left its rest pose by ${widest} rad`);
    physics.dispose();
  }
});
