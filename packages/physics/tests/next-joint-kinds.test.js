// More kinds of joint: an acceleration-based spring, a winch on a rope, and the pin-slot (a slide and a turn about one axis).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const G = 9.81;

test('an acceleration-based spring swings light and heavy bodies alike, a force spring does not', async () => {
  await Physics.load();
  // Hung from a spring of k = 100 and stretched 0.4 m past rest, then let go: a mass-free spring has w = sqrt(k) whatever hangs on it.
  function swing(mass, model) {
    const physics = new Physics(null);
    const anchor = physics.addBody(null, { type: 'fixed' });
    const weight = physics.addBody(null, {
      position: [0, -1.4, 0],
      colliders: { shape: 'sphere', radius: 0.1, mass },
    });
    physics.addJoint(anchor, weight, { type: 'spring', restLength: 1, stiffness: 100, damping: 0, model });
    const path = [];
    for (let i = 0; i < 40; i++) {
      physics.step();
      path.push(weight.position[1]);
    }
    physics.dispose();
    return path;
  }
  const light = swing(1, 'acceleration'),
    heavy = swing(4, 'acceleration'),
    forceLight = swing(1, 'force'),
    forceHeavy = swing(4, 'force');
  // Equilibrium sits g/k = 0.0981 below rest; the stretch from it starts at 0.4 - 0.0981 and turns at sqrt(100) = 10 rad/s.
  const x0 = 0.4 - G / 100;
  for (const i of [9, 29]) {
    const t = (i + 1) / 60;
    const exact = -1 - G / 100 - x0 * Math.cos(10 * t);
    assert.ok(Math.abs(light[i] - exact) < 0.02, `light follows w = sqrt(k) at ${t}s: ${light[i]} against ${exact}`);
    assert.ok(
      Math.abs(heavy[i] - light[i]) < 0.01,
      `the heavy body keeps pace at ${t}s: ${heavy[i]} against ${light[i]}`,
    );
  }
  // A force spring slows by the root of the mass: at 0.5 s the 4 kg body has turned only 2.5 rad.
  assert.ok(
    Math.abs(forceHeavy[29] - forceLight[29]) > 0.1,
    `force springs differ: ${forceHeavy[29]} against ${forceLight[29]}`,
  );
  const world = new Physics(null),
    a = world.addBody(null, { type: 'fixed' }),
    b = world.addBody(null, { position: [0, -1, 0], colliders: { shape: 'sphere', radius: 0.1 } });
  assert.throws(() => world.addJoint(a, b, { type: 'spring', restLength: 1, stiffness: 1, model: 'nonsense' }), {
    code: 'unsupported',
  });
  world.dispose();
});

test('a winch on a rope reels the anchors in at the speed it is given, and a rope without one is only a limit', async () => {
  await Physics.load();
  function hoist(motor) {
    const physics = new Physics(null);
    const anchor = physics.addBody(null, { type: 'fixed' });
    const weight = physics.addBody(null, {
      position: [0, -2, 0],
      colliders: { shape: 'sphere', radius: 0.25, mass: 10 },
    });
    const joint = physics.addJoint(anchor, weight, { type: 'rope', length: 2, anchorB: [0, 0, 0], motor });
    return { physics, weight, joint };
  }
  const winch = hoist({ targetVelocity: -1, damping: 200, maxForce: 2000 });
  for (let i = 0; i < 60; i++) winch.physics.step();
  // Reeled in at 1 m/s for one second: the weight is 1 m higher (the first few steps spin the motor up).
  assert.ok(Math.abs(winch.weight.position[1] + 1) < 0.06, `up 1 m after a second: ${winch.weight.position[1]}`);
  assert.ok(
    winch.weight.linearVelocity[1] > 0.9 && winch.weight.linearVelocity[1] < 1.1,
    `at 1 m/s: ${winch.weight.linearVelocity}`,
  );
  // Without a motor the rope is a limit: it holds the weight at its length.
  const free = hoist(undefined);
  for (let i = 0; i < 60; i++) free.physics.step();
  assert.ok(
    Math.abs(free.weight.position[1] + 2) < 0.01,
    `a plain rope holds the weight at its length: ${free.weight.position[1]}`,
  );
  // A cap below the weight lets it down: 10 kg at 9.81 m/s2 needs 98.1 N.
  const weak = hoist({ targetVelocity: -1, damping: 200, maxForce: 50 });
  for (let i = 0; i < 60; i++) weak.physics.step();
  assert.ok(weak.weight.position[1] <= -1.99, `50 N cannot lift 98.1 N: ${weak.weight.position[1]}`);
  winch.joint.clearMotor();
  for (let i = 0; i < 120; i++) winch.physics.step();
  assert.ok(winch.weight.position[1] < -1.0, 'with the motor off the weight falls to the end of the rope again');
  for (const world of [winch, free, weak]) world.physics.dispose();
});

test('a pin-slot joint slides and turns about one axis and holds every other motion', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const wall = physics.addBody(null, { type: 'fixed' });
  const bar = physics.addBody(null, {
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.2, 0.2], mass: 2 },
  });
  const joint = physics.addJoint(wall, bar, {
    type: 'pinSlot',
    axis: [1, 0, 0],
    slideLimits: [-1, 1],
  });
  assert.equal(joint.type, 'pinSlot');
  // Pushed along x and y and spun about x and y: only x and the spin about x survive.
  bar.setLinearVelocity([0.5, 3, 2]);
  bar.setAngularVelocity([4, 3, 2]);
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(Math.abs(bar.position[1]) < 0.01 && Math.abs(bar.position[2]) < 0.01, `holds y and z: ${bar.position}`);
  assert.ok(Math.abs(bar.position[0] - 0.5) < 0.02, `slides at 0.5 m/s for a second: ${bar.position[0]}`);
  assert.ok(Math.abs(bar.angularVelocity[0] - 4) < 0.05, `turns about x freely: ${bar.angularVelocity}`);
  assert.ok(
    Math.abs(bar.angularVelocity[1]) < 0.05 && Math.abs(bar.angularVelocity[2]) < 0.05,
    `not about y or z: ${bar.angularVelocity}`,
  );
  // The slide limit stops it at 1 m.
  bar.setLinearVelocity([2, 0, 0]);
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(Math.abs(bar.position[0] - 1) < 0.02, `stops at the slot's end: ${bar.position[0]}`);
  // What the slot locks has no range to set.
  assert.throws(() => joint.setAxisLimits('linY', -1, 1), { code: 'unsupported' });
  physics.dispose();
  // The turn limit is its own: a spin about the axis ends at the range's edge.
  const turning = new Physics(null, { gravity: [0, 0, 0] });
  const post = turning.addBody(null, { type: 'fixed' });
  const wheel = turning.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.2, 0.2], mass: 2 } });
  turning.addJoint(post, wheel, { type: 'pinSlot', axis: [1, 0, 0], turnLimits: [-0.5, 0.5] });
  wheel.setAngularVelocity([4, 0, 0]);
  for (let i = 0; i < 120; i++) turning.step();
  const q = wheel.rotation,
    angle = 2 * Math.atan2(q[0], q[3]);
  assert.ok(Math.abs(angle - 0.5) < 0.02, `stops its turn at 0.5 rad: ${angle}`);
  turning.dispose();
});

test('a pin-slot takes its slide and turn motors, and frames in place of an axis', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const wall = physics.addBody(null, { type: 'fixed' });
  const bar = physics.addBody(null, {
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.2, 0.2], mass: 2 },
  });
  const joint = physics.addJoint(wall, bar, {
    type: 'pinSlot',
    axis: [0, 0, 1],
    slideMotor: { targetVelocity: 0.5, damping: 100 },
    turnMotor: { targetVelocity: 2, damping: 100 },
  });
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(Math.abs(bar.position[2] - 0.5) < 0.05, `slides along z at 0.5 m/s: ${bar.position}`);
  assert.ok(Math.abs(bar.angularVelocity[2] - 2) < 0.1, `turns about z at 2 rad/s: ${bar.angularVelocity}`);
  assert.throws(() => physics.addJoint(wall, bar, { type: 'pinSlot' }), { code: 'unsupported' });
  joint.remove();
  physics.dispose();
});
