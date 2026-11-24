// Joints that break: a load past the limit ends the joint, once, with an event; below it the joint holds.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';

function hang(options) {
  const physics = new Physics(null);
  const anchor = physics.addBody(null, { type: 'fixed' });
  const weight = physics.addBody(null, { position: [0, -2, 0], colliders: { shape: 'sphere', radius: 0.25, mass: 10 } });
  const joint = physics.addJoint(anchor, weight, { type: 'spherical', anchorB: [0, 2, 0], ...options });
  return { physics, anchor, weight, joint };
}

test('a hanging weight of 98.1 N breaks a 50 N joint, once, and holds under a 200 N one', async () => {
  await Physics.load();
  const broken = hang({ breakForce: 50 });
  const events = [];
  broken.physics.on('jointbreak', (e) => events.push(e));
  for (let i = 0; i < 120; i++) broken.physics.step();
  assert.equal(broken.joint.broken, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].joint, broken.joint);
  assert.equal(events[0].bodyB, broken.weight);
  assert.ok(broken.weight.position[1] < -10, `falls free: ${broken.weight.position[1]}`);
  const held = hang({ breakForce: 200 });
  for (let i = 0; i < 240; i++) held.physics.step();
  assert.equal(held.joint.broken, false);
  assert.ok(Math.abs(held.weight.position[1] + 2) < 0.01, `holds: ${held.weight.position[1]}`);
  broken.physics.dispose();
  held.physics.dispose();
});

test('a torque limit counts the angular rows: a beam held level by a fixed joint', async () => {
  await Physics.load();
  const build = (breakTorque) => {
    const physics = new Physics(null);
    const wall = physics.addBody(null, { type: 'fixed' });
    const beam = physics.addBody(null, { position: [2, 0, 0], colliders: { shape: 'sphere', radius: 0.25, mass: 10 } });
    const joint = physics.addJoint(wall, beam, { type: 'fixed', anchorA: [0, 0, 0], anchorB: [-2, 0, 0], breakTorque });
    return { physics, joint, beam };
  };
  // 10 kg at 2 m: about 196 N m.
  const weak = build(100),
    strong = build(400);
  for (let i = 0; i < 120; i++) {
    weak.physics.step();
    strong.physics.step();
  }
  assert.equal(weak.joint.broken, true);
  assert.equal(strong.joint.broken, false);
  weak.physics.dispose();
  strong.physics.dispose();
});

test('a broken joint lets its bodies collide, repair puts it back, and limits check their input', async () => {
  await Physics.load();
  const { physics, anchor, weight, joint } = hang({ breakForce: 50 });
  assert.deepEqual(joint.breakLimits, [50, Infinity]);
  for (let i = 0; i < 10; i++) physics.step();
  assert.equal(joint.broken, true);
  joint.setBreakLimits(Infinity);
  joint.repair();
  assert.equal(joint.broken, false);
  weight.setPosition([0, -2, 0]);
  weight.setLinearVelocity([0, 0, 0]);
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(Math.abs(weight.position[1] + 2) < 0.05, `held again: ${weight.position[1]}`);
  assert.throws(() => joint.setBreakLimits(0), RangeError);
  assert.throws(() => joint.setBreakLimits(10, -1), RangeError);
  assert.throws(() => physics.addJoint(anchor, weight, { type: 'spherical', breakForce: NaN }), RangeError);
  physics.dispose();
});

test('breaking is deterministic', async () => {
  await Physics.load();
  const run = () => {
    const { physics } = hang({ breakForce: 60 });
    for (let i = 0; i < 200; i++) physics.step();
    const hash = physics.kernel.hash;
    physics.dispose();
    return hash;
  };
  assert.equal(run(), run());
});
