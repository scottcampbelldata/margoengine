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
