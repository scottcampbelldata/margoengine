// Soft limits: a joint with its own limit softness gives way past its edge as a spring of that frequency, and a rigid one does not.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const swingOf = ([x, , z]) => Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (x * x + z * z))));

function pressed(hertz) {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const top = physics.addBody(null, { type: 'fixed', colliders: [] }),
    rod = physics.addBody(null, {
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], density: 10 },
    }),
    joint = physics.addJoint(top, rod, { type: 'cone', anchorB: [0, 0.5, 0], axis: [0, -1, 0], swing: 0.4 });
  if (hertz !== undefined) joint.setLimitSoftness(hertz, 1);
  // A steady torque into the limit, about the axis the cone's swing turns about.
  for (let i = 0; i < 240; i++) {
    rod.resetForces(false);
    rod.addTorque([0, 0, 0.15]);
    physics.step();
  }
  const over = swingOf(rod.rotation) - 0.4;
  physics.dispose();
  return over;
}

test('a joint with its own limit softness gives way past its edge by torque over its spring, and a rigid one hardly', async () => {
  await Physics.load();
  const rigid = pressed(),
    soft = pressed(3),
    softer = pressed(1.5);
  assert.ok(rigid < 0.005, `rigid overshoot ${rigid}`);
  assert.ok(soft > 10 * rigid && soft > 0.008, `3 Hz overshoot ${soft}`);
  // A soft limit pushes back as a speed of omega / (2 zeta) times the depth (the soft step's bias), so under a steady torque the
  // give is inversely proportional to the frequency: half the frequency, twice the give.
  assert.ok(Math.abs(softer / soft - 2) < 0.2, `1.5 Hz gives ${softer / soft} times what 3 Hz does`);
});

test('limit softness checks its input, reads back, and 0 returns to a contact stiffness', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const a = physics.addBody(null, { type: 'fixed', colliders: [] }),
    b = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.1 } }),
    joint = physics.addJoint(a, b, { type: 'cone', swing: 0.5 });
  joint.setLimitSoftness(4, 0.7);
  assert.deepEqual(
    joint.limitSoftness.map((x) => Math.round(x * 10) / 10),
    [4, 0.7],
  );
  joint.setLimitSoftness(0);
  assert.equal(joint.limitSoftness[0], 0);
  assert.throws(() => joint.setLimitSoftness(-1), { code: 'unsupported' });
  assert.throws(() => joint.setLimitSoftness(NaN), { code: 'unsupported' });
  assert.throws(() => joint.setLimitSoftness(3, 0), { code: 'unsupported' });
  physics.dispose();
});
