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

test('a slope at or above minSlopeSlideAngle slides the character down it, a gentler one holds it, as Rapier does', async () => {
  const { RapierPhysics } = await import('./oracle.js');
  const warn = console.warn;
  console.warn = () => {};
  await RapierPhysics.load();
  console.warn = warn;
  const angle = (25 * Math.PI) / 180;
  const run = (World, slideAngle) => {
    const physics = new World(null);
    physics.addBody(null, {
      type: 'fixed',
      rotation: eulerToQuat(0, 0, angle),
      colliders: { shape: 'box', halfExtents: [10, 0.05, 10] },
    });
    const character = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, 1.2, 0],
      colliders: { shape: 'capsule', halfHeight, radius },
    });
    const controller = physics.createCharacterController(character, {
      minSlopeSlideAngle: slideAngle,
      maxSlopeClimbAngle: Math.PI / 3,
      autostep: false,
      snapToGround: 0.2,
    });
    // Settle onto the slope, then let it stand there pulled down a little each step.
    for (let i = 0; i < 90; i++) {
      physics.step();
      controller.move([0, -0.08, 0]);
    }
    const [x0] = character.position;
    for (let i = 0; i < 120; i++) {
      physics.step();
      controller.move([0, -0.05, 0]);
    }
    const slid = x0 - character.position[0];
    physics.dispose();
    return slid;
  };
  for (const World of [Physics, RapierPhysics]) {
    const name = World === Physics ? 'own' : 'Rapier';
    // 25 degrees is at or above 20 degrees: it slides downhill (towards -x); it is gentler than 40: it holds.
    const slides = run(World, (20 * Math.PI) / 180),
      holds = run(World, (40 * Math.PI) / 180);
    assert.ok(slides > 0.5, `${name}: slid ${slides} m on a slope over the slide angle`);
    assert.ok(Math.abs(holds) < 0.05, `${name}: moved ${holds} m on a slope under the slide angle`);
  }
});

test('a character walking into a light crate takes it up to the walking pace, not a fraction of it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    crate = physics.addBody(null, {
      position: [1, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], density: 1 },
    }),
    body = physics.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 0.3 } }),
    controller = physics.createCharacterController(body, {
      applyImpulsesToDynamicBodies: true,
      characterMass: 80,
      snapToGround: false,
      autostep: false,
    }),
    pace = 3;
  for (let i = 0; i < 90; i++) {
    physics.step();
    controller.move([pace / 60, 0, 0]);
  }
  near(crate.linearVelocity[0], pace, 0.3, 'the crate goes at the walking pace');
  physics.dispose();
});

test('maxPushStrength caps the push, and maxPushMassRatio leaves a heavy body as a wall', () => {
  const run = (options, density) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      crate = physics.addBody(null, {
        position: [1, 0, 0],
        colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], density },
      }),
      body = physics.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 0.3 } }),
      controller = physics.createCharacterController(body, {
        applyImpulsesToDynamicBodies: true,
        characterMass: 80,
        snapToGround: false,
        autostep: false,
        ...options,
      });
    for (let i = 0; i < 60; i++) {
      physics.step();
      controller.move([3 / 60, 0, 0]);
    }
    const speed = crate.linearVelocity[0];
    physics.dispose();
    return speed;
  };
  // A crate of 21.6 kg (density 100): 20 N for a second moves it about 0.9 m/s, so the cap is what limits it.
  const free = run({}, 100),
    capped = run({ maxPushStrength: 20 }, 100),
    refused = run({ maxPushMassRatio: 0.1 }, 100);
  assert.ok(free > 2.5, `uncapped crate speed ${free}`);
  near(capped, 0.9, 0.2, 'a 20 N limit gives it 20 N times a second over its mass');
  assert.equal(refused, 0, 'a body 2.7 times the allowed ratio is not pushed');
  assert.throws(() => {
    const world = new Physics(null);
    world.createCharacterController(
      world.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 1 } }),
      { maxPushStrength: 0 },
    );
  }, /maxPushStrength must be more than zero/);
});

test('a character stands on a moving platform and rides it, unless asked not to', () => {
  const run = (options, spin = 0) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      platform = physics.addBody(null, {
        type: 'kinematicPosition',
        position: [0, -0.5, 0],
        colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
      }),
      body = physics.addBody(null, {
        type: 'kinematicPosition',
        position: [0, halfHeight + radius + 0.005, 0],
        colliders: { shape: 'capsule', halfHeight, radius },
      }),
      controller = physics.createCharacterController(body, { snapToGround: 0.2, autostep: false, ...options });
    let angle = 0;
    for (let i = 0; i < 120; i++) {
      angle += spin / 60;
      platform.setNextPosition([i * (1 / 60) * 1 + 1 / 60, -0.5, 0]);
      platform.setNextRotation(eulerToQuat(0, angle, 0));
      physics.step();
      controller.move([0, -0.01, 0]);
    }
    const result = {
      x: body.position[0],
      z: body.position[2],
      rotation: body.rotation,
      platform: controller.platform === platform,
    };
    physics.dispose();
    return result;
  };
  const carried = run({}),
    left = run({ inheritPlatformVelocity: false });
  near(carried.x, 2, 0.1, 'carried two metres in two seconds at 1 m/s');
  assert.ok(carried.platform, 'the controller says what it stands on');
  near(left.x, 0, 1e-6, 'left behind when it does not inherit');
  const turned = run({}, 0.5);
  assert.ok(
    Math.abs(turned.rotation[1]) > 0.2,
    `the character turned with a platform turning about up: ${turned.rotation}`,
  );
});

test('a platform that runs into a wall stops the character against it too', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    platform = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
    });
  physics.addBody(null, { type: 'fixed', position: [3, 1, 0], colliders: { shape: 'box', halfExtents: [0.1, 1, 5] } });
  const body = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, halfHeight + radius + 0.005, 0],
      colliders: { shape: 'capsule', halfHeight, radius },
    }),
    controller = physics.createCharacterController(body, { snapToGround: 0.2, autostep: false });
  for (let i = 0; i < 300; i++) {
    platform.setNextPosition([(i + 1) / 60, -0.5, 0]);
    physics.step();
    controller.move([0, -0.01, 0]);
  }
  assert.ok(body.position[0] < 2.9 - radius + 1e-3, `the wall stopped it at ${body.position[0]}`);
  physics.dispose();
});

test('a contact listener sees each obstacle and can refuse the push', () => {
  const run = (refuse) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      crate = physics.addBody(null, {
        position: [1, 0, 0],
        colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], density: 1 },
      }),
      body = physics.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 0.3 } }),
      controller = physics.createCharacterController(body, {
        applyImpulsesToDynamicBodies: true,
        characterMass: 80,
        snapToGround: false,
        autostep: false,
      }),
      seen = [],
      stop = controller.onContact((contact) => {
        seen.push(contact);
        if (refuse) contact.canPush = false;
      });
    for (let i = 0; i < 60; i++) {
      physics.step();
      controller.move([3 / 60, 0, 0]);
    }
    const speed = crate.linearVelocity[0];
    stop();
    controller.move([0.01, 0, 0]);
    const after = seen.length;
    physics.dispose();
    return { speed, seen, after, crate };
  };
  const refused = run(true),
    allowed = run(false);
  assert.ok(allowed.speed > 2, `pushed when the listener leaves it: ${allowed.speed}`);
  assert.equal(refused.speed, 0, 'not pushed when the listener refuses');
  assert.ok(refused.seen.length > 0 && refused.seen[0].body === refused.crate, 'the listener got the crate');
  near(Math.abs(refused.seen[0].normal[0]), 1, 0.01, 'and the contact normal');
  assert.equal(refused.after, refused.seen.length, 'a removed listener hears nothing more');
});

test('an inner body follows the character for other bodies to hit, is never an obstacle to it, and goes with it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    body = physics.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 0.3 } }),
    controller = physics.createCharacterController(body, {
      snapToGround: false,
      autostep: false,
      innerBody: { colliders: { shape: 'sphere', radius: 1 } },
    }),
    inner = controller.innerBody;
  assert.ok(inner && inner !== body && inner.type === 'kinematicPosition');
  // A ball rolling in from x = 4 meets the inner sphere of radius 1, not the character's 0.3.
  const ball = physics.addBody(null, {
    position: [4, 0, 0],
    linearVelocity: [-2, 0, 0],
    colliders: { shape: 'sphere', radius: 0.2, restitution: 0 },
  });
  for (let i = 0; i < 120; i++) {
    physics.step();
    const move = controller.move([0.5 / 60, 0, 0]);
    assert.equal(move.collisions, 0, 'the inner body is no obstacle to its own character');
  }
  near(inner.position[0], body.position[0], 1e-6, 'it follows the character');
  assert.ok(
    ball.position[0] - body.position[0] > 1.15,
    `the ball is held off by the inner body: ${ball.position[0] - body.position[0]}`,
  );
  controller.dispose();
  assert.ok(!inner.valid, 'disposing the controller removes the inner body');
  physics.dispose();
});
