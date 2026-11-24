// The character controller on the own solver: a step, a wall, the ground, slopes, a refused collider and a pushed box.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, CharacterController } from '../dist/index.js';
import { eulerToQuat } from '../dist/index.js';

await Physics.load();
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);
const ground = (physics) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
  });
const radius = 0.3,
  halfHeight = 0.4;
const capsule = (physics, y = halfHeight + radius + 0.02) =>
  physics.addBody(null, {
    type: 'kinematicPosition',
    position: [0, y, 0],
    colliders: { shape: 'capsule', halfHeight, radius },
  });

test('a character climbs a step, stops at a wall and snaps to the ground', () => {
  const physics = new Physics(null);
  ground(physics);
  physics.addBody(null, {
    type: 'fixed',
    position: [3, 0.1, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.1, 2] },
  });
  physics.addBody(null, { type: 'fixed', position: [6, 1, 0], colliders: { shape: 'box', halfExtents: [0.1, 1, 2] } });
  const character = capsule(physics),
    controller = physics.createCharacterController(character, {
      offset: 0.01,
      autostep: { maxHeight: 0.3, minWidth: 0.1, includeDynamicBodies: false },
      snapToGround: 0.3,
    });
  assert.ok(controller instanceof CharacterController);
  const speed = 2,
    dt = 1 / 60;
  let fall = 0,
    onStep = false;
  physics.on('beforestep', (step) => {
    fall = controller.grounded ? 0 : fall - 9.81 * step;
    controller.move([speed * step, Math.min(fall, -0.1) * step, 0]);
  });
  for (let i = 0; i < 240; i++) {
    physics.update(dt);
    const [x, y] = character.position;
    if (x > 2.5 && x < 3.5) {
      onStep = true;
      near(y, 0.2 + halfHeight + radius, 0.05, `height on the step at x=${x.toFixed(2)}`);
    }
  }
  assert.ok(onStep, 'the character reached the step');
  near(character.position[0], 5.9 - radius, 0.05, 'stops at the wall');
  assert.ok(controller.grounded);
  for (let i = 0; i < 240; i++) {
    physics.step();
    controller.move([-speed * dt, -0.1 * dt, 0]);
  }
  near(character.position[1], halfHeight + radius, 0.05, 'back on the floor');
  physics.dispose();
});

test('a slope steeper than maxSlopeClimbAngle is not climbed, a gentle one is', () => {
  const run = (angle) => {
    const physics = new Physics(null);
    ground(physics);
    physics.addBody(null, {
      type: 'fixed',
      position: [3, 0, 0],
      rotation: eulerToQuat(0, 0, angle),
      colliders: { shape: 'box', halfExtents: [2, 0.05, 2] },
    });
    const climber = capsule(physics),
      controller = physics.createCharacterController(climber, { maxSlopeClimbAngle: Math.PI / 4, autostep: false });
    for (let i = 0; i < 240; i++) {
      physics.step();
      controller.move([2 / 60, -0.1 / 60, 0]);
    }
    const y = climber.position[1];
    physics.dispose();
    return y;
  };
  assert.ok(run(Math.PI / 3) < 1, 'a 60 degree slope is not climbed');
  assert.ok(run(Math.PI / 8) > 0.8, 'a 22 degree slope is climbed');
});

test('a predicate gets the collider and can let the character through', () => {
  const physics = new Physics(null),
    wall = physics.addBody(null, {
      type: 'fixed',
      position: [1, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.2, 2, 2] },
    }),
    body = physics.addBody(null, {
      type: 'kinematicPosition',
      colliders: { shape: 'capsule', radius: 0.3, halfHeight: 0.5 },
    }),
    character = physics.createCharacterController(body, { snapToGround: false, autostep: false }),
    seen = new Set();
  physics.step();
  const blocked = character.move([2, 0, 0]);
  assert.ok(blocked.movement[0] < 0.6, `the wall stopped it at ${blocked.movement[0]}`);
  assert.equal(blocked.collisions, 1);
  const free = character.move([2, 0, 0], {
    predicate: (collider) => {
      seen.add(collider);
      return collider !== wall.colliders[0];
    },
  });
  assert.ok(free.movement[0] > 1.9, `a refused wall lets it through: ${free.movement[0]}`);
  assert.ok(seen.has(wall.colliders[0]));
  physics.dispose();
});

test('a character pushes a dynamic box only when asked to', () => {
  const run = (push) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      crate = physics.addBody(null, {
        position: [1, 0, 0],
        colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], density: 1 },
      }),
      body = physics.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 0.3 } }),
      controller = physics.createCharacterController(body, {
        applyImpulsesToDynamicBodies: push,
        characterMass: 80,
        snapToGround: false,
        autostep: false,
      });
    for (let i = 0; i < 60; i++) {
      physics.step();
      controller.move([0.05, 0, 0]);
    }
    const x = crate.position[0];
    physics.dispose();
    return x;
  };
  assert.ok(run(true) > run(false) + 0.2, 'a pushing character moves the crate');
});

test('a controller needs a kinematic position body of this world, and a disposed one refuses', () => {
  const physics = new Physics(null),
    dynamic = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } }),
    other = new Physics(null),
    outsider = other.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 1 } });
  assert.throws(() => physics.createCharacterController(dynamic), /kinematicPosition/);
  assert.throws(() => physics.createCharacterController(outsider), { code: 'state', message: /addBody first/ });
  const body = physics.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 1 } });
  assert.throws(() => physics.createCharacterController(body, { up: [NaN, 1, 0] }), /Up must be three finite numbers/);
  const controller = physics.createCharacterController(body);
  controller.dispose();
  assert.throws(() => controller.move([0, 0, 0]), { code: 'disposed' });
  physics.dispose();
  other.dispose();
});

test('a character 2 cm above a floor slides along it without a hit, and a wall still stops it', () => {
  const physics = new Physics(null);
  ground(physics);
  physics.addBody(null, { type: 'fixed', position: [3, 1, 0], colliders: { shape: 'box', halfExtents: [0.1, 1, 2] } });
  const body = capsule(physics, halfHeight + radius + 0.02),
    controller = physics.createCharacterController(body, { snapToGround: false, autostep: false });
  physics.step();
  const slide = controller.move([1, 0, 0]);
  near(slide.movement[0], 1, 1e-4, 'the whole slide');
  assert.equal(slide.collisions, 0, 'a shape that does not touch what it moves along meets nothing');
  const wall = controller.move([5, 0, 0]);
  near(wall.movement[0], 2.9 - radius - 0.01, 1e-3, 'the wall face at x = 2.9 stops it a skin short');
  assert.equal(wall.collisions, 1);
  physics.dispose();
});
