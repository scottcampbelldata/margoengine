// A joint's locked axes as a spring of its own: a frequency and a damping ratio, mass independent, so a soft weld or ball joint
// gives way under a steady load by the load's acceleration over omega squared, whatever hangs on it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const G = 9.81;
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

function sag(mass, softness) {
  const physics = new Physics(null);
  const wall = physics.addBody(null, { type: 'fixed' });
  const weight = physics.addBody(null, {
    position: [0, -2, 0],
    colliders: { shape: 'sphere', radius: 0.25, mass },
  });
  const joint = physics.addJoint(wall, weight, { type: 'spherical', anchorB: [0, 2, 0] });
  if (softness) joint.setSoftness(...softness);
  for (let i = 0; i < 240; i++) physics.step();
  const y = weight.position[1] + 2;
  physics.dispose();
  return y;
}

test('a soft ball joint sags by g over omega squared, whether a light or a heavy body hangs on it', async () => {
  await Physics.load();
  const omega = 2 * Math.PI * 2,
    expected = -G / (omega * omega);
  near(sag(1, [2, 0.5]), expected, 0.004, 'light');
  near(sag(10, [2, 0.5]), expected, 0.004, 'heavy, the same');
  assert.ok(Math.abs(sag(1)) < 0.001, 'a rigid joint hardly sags');
  // A stiffer joint sags less: 4 Hz is a quarter of the sag.
  near(sag(1, [4, 0.5]), expected / 4, 0.002, 'twice the frequency, a quarter the sag');
});

test('a soft fixed joint turns by torque over inertia over omega squared under a steady torque', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const wall = physics.addBody(null, { type: 'fixed' });
  // A solid sphere of 1 kg and radius 0.5: inertia 0.4 m r^2 = 0.1 kg m^2.
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 1 } });
  const joint = physics.addJoint(wall, body, { type: 'fixed' });
  joint.setSoftness(2, 0.7);
  body.addTorque([0, 0, 1]);
  for (let i = 0; i < 240; i++) physics.step();
  const omega = 2 * Math.PI * 2,
    angle = 1 / (0.1 * omega * omega),
    q = body.rotation;
  near(2 * Math.asin(q[2]), angle, 0.005, 'the turn about z');
  near(body.position[0], 0, 1e-3, 'and no slide: the linear locks are soft too, and nothing pulls on them');
  physics.dispose();
});

test('softness reads back, 0 makes the joint rigid again, and it checks its input', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const wall = physics.addBody(null, { type: 'fixed' });
  const weight = physics.addBody(null, { position: [0, -2, 0], colliders: { shape: 'sphere', radius: 0.25, mass: 1 } });
  const joint = physics.addJoint(wall, weight, {
    type: 'spherical',
    anchorB: [0, 2, 0],
    softness: { hertz: 2, damping: 0.5 },
  });
  assert.deepEqual(joint.softness, [2, 0.5]);
  joint.setSoftness(0);
  assert.deepEqual(joint.softness, [0, 1]);
  for (let i = 0; i < 240; i++) physics.step();
  near(weight.position[1], -2, 0.001, 'rigid again');
  assert.throws(() => joint.setSoftness(-1), RangeError);
  assert.throws(() => joint.setSoftness(2, 0), RangeError);
  assert.throws(() => joint.setSoftness(Number.NaN), RangeError);
  physics.dispose();
});

test('a soft hinge gives way about its turning locks too, and still turns freely about its axis', async () => {
  await Physics.load();
  const omega = 2 * Math.PI * 2;
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const wall = physics.addBody(null, { type: 'fixed' });
  // Inertia of a solid sphere of 1 kg and radius 0.5: 0.1 kg m^2.
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 1 } });
  const joint = physics.addJoint(wall, body, {
    type: 'revolute',
    axis: [0, 0, 1],
    softness: { hertz: 2, damping: 0.7 },
  });
  [2, 0.7].forEach((v, i) => near(joint.softness[i], v, 1e-6, 'softness read back'));
  body.addTorque([1, 0, 0]);
  for (let i = 0; i < 240; i++) physics.step();
  near(
    2 * Math.asin(body.rotation[0]),
    1 / (0.1 * omega * omega),
    0.006,
    'tilted by torque over inertia over omega squared',
  );
  physics.dispose();
  // The free axis is still free: a torque about z spins the body up at torque over inertia.
  const spin = new Physics(null, { gravity: [0, 0, 0] });
  const post = spin.addBody(null, { type: 'fixed' });
  const wheel = spin.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 1 } });
  spin.addJoint(post, wheel, { type: 'revolute', axis: [0, 0, 1], softness: { hertz: 2 } });
  wheel.addTorque([0, 0, 1]);
  for (let i = 0; i < 60; i++) spin.step();
  near(wheel.angularVelocity[2], 10, 0.2, 'a spin of 10 rad/s after a second');
  spin.dispose();
});

test('a weld takes its sliding and turning softness apart: a stiff pin that turns like a spring', async () => {
  await Physics.load();
  const omega = 2 * Math.PI * 2;
  const physics = new Physics(null);
  const wall = physics.addBody(null, { type: 'fixed' });
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 1 } });
  const joint = physics.addJoint(wall, body, { type: 'fixed' });
  joint.setSoftness(0, 1, { hertz: 2, damping: 0.7 });
  assert.deepEqual(joint.softness, [0, 1]);
  [2, 0.7].forEach((v, i) => near(joint.angularSoftness[i], v, 1e-6, 'angular softness read back'));
  body.addTorque([0, 0, 1]);
  body.addForce([5, 0, 0]);
  for (let i = 0; i < 240; i++) physics.step();
  near(body.position[0], 0, 0.002, 'the sliding locks stay rigid under a push');
  near(2 * Math.asin(body.rotation[2]), 1 / (0.1 * omega * omega), 0.006, 'the turning locks are the spring');
  physics.dispose();
});

test('a motor takes a frequency and damping ratio, mass independent: the peak of a step response', async () => {
  await Physics.load();
  function peak(mass) {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const wall = physics.addBody(null, { type: 'fixed' });
    const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass } });
    physics.addJoint(wall, body, {
      type: 'revolute',
      axis: [0, 0, 1],
      motor: { targetPosition: 0.5, frequency: 2, dampingRatio: 0.1 },
    });
    let high = 0,
      when = 0;
    for (let i = 1; i <= 60; i++) {
      physics.step();
      const angle = 2 * Math.asin(body.rotation[2]);
      if (angle > high) [high, when] = [angle, i / 60];
    }
    physics.dispose();
    return { high, when };
  }
  const omega = 2 * Math.PI * 2,
    zeta = 0.1,
    overshoot = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
  for (const mass of [1, 8]) {
    const { high, when } = peak(mass);
    near(when, Math.PI / (omega * Math.sqrt(1 - zeta * zeta)), 0.02, `peak time at ${mass} kg`);
    near(high, 0.5 * (1 + overshoot), 0.03, `peak height at ${mass} kg`);
  }
  const physics = new Physics(null);
  const a = physics.addBody(null, { type: 'fixed' });
  const b = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 } });
  const hinge = physics.addJoint(a, b, { type: 'revolute', axis: [0, 0, 1] });
  assert.throws(() => hinge.setMotor({ targetPosition: 0, frequency: 2, model: 'force' }), RangeError);
  assert.throws(() => hinge.setMotor({ targetPosition: 0, frequency: -1 }), RangeError);
  assert.throws(() => hinge.setMotor({ targetPosition: 0, frequency: 2, dampingRatio: -1 }), RangeError);
  physics.dispose();
});
