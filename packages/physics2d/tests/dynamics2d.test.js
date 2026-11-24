// Forces and torques at a point, locked rotation, the collider settings that change after creation, and what the character
// controller does with a ledge, a slope and a crate, each held to a closed form. Rapier 2D comparisons for the same scenes
// are in oracle-rapier.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const DT = 1 / 60;
const world = (options = {}) => new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0], ...options });
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};
const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`,
  );
// A disc of radius 1 and mass 2 turns with an inertia of 1/2 m r^2 = 1.
const disc = { shape: 'circle', radius: 1, mass: 2 };

test('a force at a point pushes by F / m and turns by r x F / I, and resetTorques keeps the push', () => {
  const physics = world();
  const body = physics.addBody(null, { colliders: disc });
  // (1, 0) x (0, 4) = 4
  body.applyForceAtPoint([0, 4], [1, 0]);
  physics.step();
  near(body.linearVelocity[1], (4 / 2) * DT, 1e-5, 'F / m for a step');
  near(body.angularVelocity, 4 * DT, 1e-5, 'torque / I for a step');
  run(physics, 1);
  near(body.linearVelocity[1], (4 / 2) * DT * 2, 1e-5, 'the force stays');
  near(body.angularVelocity, 4 * DT * 2, 1e-5, 'and so does the torque');
  const turned = body.angularVelocity;
  body.resetTorques();
  run(physics, 2);
  near(body.angularVelocity, turned, 1e-6, 'no torque, no more turning');
  near(body.linearVelocity[1], (4 / 2) * DT * 4, 1e-5, 'the force still pushes');
  body.resetForces();
  const speed = body.linearVelocity[1];
  run(physics, 2);
  near(body.linearVelocity[1], speed, 1e-6, 'a reset force pushes no more');
  assert.throws(() => body.applyForceAtPoint([0, Number.NaN], [0, 0]), RangeError);
  physics.dispose();
});

test('a locked rotation holds the angle against torque and impulse, and frees again', () => {
  const physics = world();
  const body = physics.addBody(null, { colliders: disc, angularVelocity: 3 });
  assert.equal(body.rotationLocked, false);
  body.lockRotation();
  assert.equal(body.rotationLocked, true);
  body.applyTorque(5);
  body.applyTorqueImpulse(2);
  body.applyImpulseAtPoint([0, 3], [1, 0]);
  run(physics, 30);
  near(body.rotation, 0, 1e-9, 'the angle holds');
  near(body.angularVelocity, 0, 1e-9, 'with no spin');
  assert.ok(body.linearVelocity[1] > 0.5, 'and it still travels');
  body.resetForces();
  body.lockRotation(false);
  body.applyTorqueImpulse(2);
  run(physics, 10);
  near(body.angularVelocity, 2, 1e-4, 'freed, an impulse spins it by L / I');
  const fixed = physics.addBody(null, { type: 'fixed', colliders: disc });
  assert.throws(() => fixed.lockRotation(), TypeError);
  const born = physics.addBody(null, { lockRotation: true, colliders: disc });
  assert.equal(born.rotationLocked, true, 'the creation option reads back');
  physics.dispose();
});

test('active collision types decide which pairs a collider meets, and read back', () => {
  const physics = world({ gravity: [0, 9.81] });
  const floor = physics.addBody(null, {
      type: 'fixed',
      position: [0, 10],
      colliders: { shape: 'box', width: 100, height: 2 },
    }),
    ball = physics.addBody(null, { colliders: { shape: 'circle', radius: 0.5 } }),
    collider = floor.colliders[0];
  assert.equal(collider.activeCollisionTypes(), 7, 'dynamic with dynamic, kinematic and fixed');
  collider.setActiveCollisionTypes(1);
  assert.equal(collider.activeCollisionTypes(), 1);
  run(physics, 180);
  assert.ok(ball.position[1] > 20, `a floor that leaves out dynamic-fixed lets it fall (${ball.position[1]})`);
  collider.setActiveCollisionTypes(7);
  ball.teleport([0, 0]);
  ball.linearVelocity = [0, 0];
  run(physics, 180);
  assert.ok(ball.position[1] < 10, `with the default back the floor holds it (${ball.position[1]})`);
  assert.throws(() => collider.setActiveCollisionTypes(64), { name: 'RangeError', message: /use 7 for the default/ });
  assert.throws(() => collider.setActiveCollisionTypes(1.5), RangeError);
  physics.dispose();
});

test('active events and the contact force threshold change what a collider reports', () => {
  const physics = world({ gravity: [0, 9.81] });
  const floor = physics.addBody(null, {
      type: 'fixed',
      position: [0, 10],
      colliders: { shape: 'box', width: 100, height: 2 },
    }),
    ball = physics.addBody(null, { position: [0, 5], colliders: { shape: 'circle', radius: 0.5, mass: 1 } });
  const starts = [],
    forces = [];
  physics.on('contactstart', (event) => starts.push(event));
  physics.on('contactforce', (event) => forces.push(event));
  const colliders = [floor.colliders[0], ball.colliders[0]];
  assert.deepEqual(colliders[1].activeEvents(), { collision: true, contactForce: false });
  for (const collider of colliders) collider.setActiveEvents({ collision: false });
  assert.deepEqual(colliders[0].activeEvents(), { collision: false, contactForce: false });
  run(physics, 120);
  assert.equal(starts.length, 0, 'with collision events off for both nothing starts');
  for (const collider of colliders) collider.setActiveEvents({ collision: true });
  ball.teleport([0, 5]);
  ball.linearVelocity = [0, 0];
  run(physics, 120);
  assert.ok(starts.length >= 1, 'back on, the landing is reported');
  assert.equal(forces.length, 0, 'no force events asked for');
  colliders[1].setContactForceEventThreshold(1);
  assert.equal(colliders[1].activeEvents().contactForce, true, 'a threshold asks for the event');
  ball.teleport([0, 5]);
  ball.linearVelocity = [0, 0];
  run(physics, 120);
  assert.ok(forces.length >= 1, 'past its threshold a force event comes');
  assert.ok(
    forces.every((event) => event.force >= 1),
    'and none under it',
  );
  assert.throws(() => colliders[1].setContactForceEventThreshold(-1), RangeError);
  physics.dispose();
});

/** A floor, and a kinematic box that walks along it under the character controller. */
const walker = (build, options, steps = 90) => {
  const physics = world({ gravity: [0, 0] });
  physics.addBody(null, { type: 'fixed', position: [50, 10], colliders: { shape: 'box', width: 200, height: 2 } });
  build(physics);
  const hero = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [0, 6.95],
    colliders: { shape: 'box', width: 2, height: 4 },
  });
  const controller = physics.createCharacterController(hero, { offset: 0.01, ...options });
  let last;
  physics.on('beforestep', (dt) => {
    last = controller.move([6 * dt, 0]);
  });
  run(physics, steps);
  const result = { x: hero.position[0], y: hero.position[1], last };
  physics.dispose();
  return result;
};

test('autostep climbs a ledge that is no higher than its limit, and a taller one stops the character', () => {
  const ledge = (height) => (physics) =>
    physics.addBody(null, {
      type: 'fixed',
      position: [20, 9 - height / 2],
      colliders: { shape: 'box', width: 4, height },
    });
  const free = walker(() => {}, {});
  near(free.x, 9, 0.2, 'on a bare floor it walks the whole 90 steps at 6 per second');
  const blocked = walker(ledge(1), {});
  assert.ok(blocked.x < 19, `a ledge 1 high stops it without autostep (${blocked.x})`);
  const stepped = walker(ledge(1), { autostep: { maxHeight: 1.5, minWidth: 0.5 } });
  assert.ok(stepped.x > 8, `with autostep of 1.5 it is over the ledge and walking on (${stepped.x})`);
  const tall = walker(ledge(3), { autostep: { maxHeight: 1.5, minWidth: 0.5 } });
  assert.ok(tall.x < 19, `a ledge 3 high is taller than the limit (${tall.x})`);
});

test('a slope is climbed up to maxSlopeClimbAngle and not beyond it', () => {
  // A ramp rising to the right (y is down) at 30 degrees from x = 20 to x = 40, then flat.
  const rise = Math.tan(Math.PI / 6) * 20;
  const ramp = (physics) =>
    physics.addBody(null, {
      type: 'fixed',
      position: [0, 0],
      colliders: {
        shape: 'polygon',
        points: [
          [20, 9],
          [40, 9 - rise],
          [40, 9],
        ],
      },
    });
  const climbs = walker(ramp, { maxSlopeClimbAngle: Math.PI / 4, snapToGround: 0.5 }, 300);
  assert.ok(climbs.x > 25, `a 30 degree slope under a 45 degree limit is climbed (${climbs.x})`);
  const stopped = walker(ramp, { maxSlopeClimbAngle: Math.PI / 9 }, 300);
  near(stopped.x, 19, 1, 'it stops at the foot of the slope');
  assert.ok(stopped.x < climbs.x - 3, `under a 20 degree limit it is not (${stopped.x} against ${climbs.x})`);
});

test('snap to ground keeps the character on a floor that drops away by less than its distance', () => {
  // The floor steps down by 0.3 at x = 20.
  const drop = (physics) =>
    physics.addBody(null, { type: 'fixed', position: [60, 10.3], colliders: { shape: 'box', width: 80, height: 2 } });
  const run2 = (options) => {
    const physics = world({ gravity: [0, 0] });
    physics.addBody(null, { type: 'fixed', position: [10, 10], colliders: { shape: 'box', width: 20, height: 2 } });
    drop(physics);
    const hero = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, 6.95],
      colliders: { shape: 'box', width: 2, height: 4 },
    });
    const controller = physics.createCharacterController(hero, { offset: 0.01, ...options });
    let last;
    physics.on('beforestep', (dt) => {
      last = controller.move([6 * dt, 0]);
    });
    run(physics, 300);
    const result = { y: hero.position[1], grounded: last.grounded };
    physics.dispose();
    return result;
  };
  const snapped = run2({ snapToGround: 0.5 });
  near(snapped.y, 7.25, 0.05, 'it follows the floor down');
  assert.equal(snapped.grounded, true);
  const hovering = run2({});
  assert.ok(
    hovering.y < snapped.y - 0.05 || hovering.y < 7.25,
    `without it the character is left in the air (${hovering.y})`,
  );
});

test('a character pushes a dynamic crate when it is asked to, and is stopped by it when not', () => {
  const push = (pushDynamic) => {
    const physics = world({ gravity: [0, 0] });
    physics.addBody(null, { type: 'fixed', position: [50, 10], colliders: { shape: 'box', width: 200, height: 2 } });
    const crate = physics.addBody(null, {
      position: [10, 7],
      canSleep: false,
      colliders: { shape: 'box', width: 2, height: 4, mass: 1 },
    });
    const hero = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, 6.95],
      colliders: { shape: 'box', width: 2, height: 4 },
    });
    const controller = physics.createCharacterController(hero, { offset: 0.01, pushDynamic, mass: 50 });
    physics.on('beforestep', (dt) => controller.move([6 * dt, 0]));
    run(physics, 120);
    const result = { crate: crate.position[0], hero: hero.position[0] };
    physics.dispose();
    return result;
  };
  const pushed = push(true);
  assert.ok(pushed.crate > 14, `the crate is shoved along (${pushed.crate})`);
  assert.ok(pushed.hero > 5, `and the character gets through (${pushed.hero})`);
  const blocked = push(false);
  near(blocked.crate, 10, 0.5, 'without it the crate stays');
  assert.ok(blocked.hero < 9, `and the character stops at it (${blocked.hero})`);
});
