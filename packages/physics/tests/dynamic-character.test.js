// The dynamic character: a rigid body kept upright by a stable PD torque and walked by a velocity controller.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, DynamicCharacter, eulerToQuat } from '../dist/index.js';

await Physics.load();
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);
const radius = 0.3,
  halfHeight = 0.4,
  rest = halfHeight + radius;
const floor = (physics, angle = 0) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    rotation: eulerToQuat(0, 0, angle),
    colliders: { shape: 'box', halfExtents: [100, 0.5, 100], friction: 0 },
  });
const hero = (physics, options = {}) =>
  physics.addBody(null, {
    position: [0, rest + 0.01, 0],
    colliders: { shape: 'capsule', halfHeight, radius, density: 1, friction: 0 },
    ...options,
  });
const tilt = (q) => {
  // The angle between the capsule's axis and up.
  const [x, y, z, w] = q,
    ux = 2 * (x * y - w * z),
    uy = 1 - 2 * (x * x + z * z),
    uz = 2 * (y * z + w * x);
  return Math.acos(Math.min(1, uy / Math.hypot(ux, uy, uz)));
};
const drive = (physics, character, steps, before) => {
  for (let i = 0; i < steps; i++) {
    before?.(i);
    character.update();
    physics.step();
  }
};

test('a tilted character rights itself with no overshoot, for any step and any stiffness', () => {
  for (const [frequency, dt] of [
    [4, 1 / 60],
    [20, 1 / 60],
    [200, 1 / 30],
  ]) {
    const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: dt }),
      body = hero(physics, { rotation: eulerToQuat(0, 0, 0.7) }),
      character = physics.createDynamicCharacter(body, { uprightFrequency: frequency });
    assert.ok(character instanceof DynamicCharacter);
    let worst = 0;
    drive(physics, character, Math.round(3 / dt), () => {
      worst = Math.max(worst, tilt(body.rotation));
    });
    assert.ok(tilt(body.rotation) < 0.01, `upright at ${frequency} Hz, ${dt} s: ${tilt(body.rotation)} rad`);
    assert.ok(worst <= 0.7 + 1e-3, `it never tilted further than it started: ${worst}`);
    physics.dispose();
  }
});

test('a limit on the upright torque lets a character stay knocked over', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    body = hero(physics, { rotation: eulerToQuat(0, 0, 0.7) }),
    character = physics.createDynamicCharacter(body, { maxUprightTorque: 1e-6 });
  drive(physics, character, 120);
  assert.ok(tilt(body.rotation) > 0.5, `still tilted: ${tilt(body.rotation)}`);
  physics.dispose();
});

test('it walks to the target velocity within its grip, and stops when asked', () => {
  const physics = new Physics(null);
  floor(physics);
  const body = hero(physics),
    character = physics.createDynamicCharacter(body, { groundAcceleration: 20 });
  let reached = -1;
  drive(physics, character, 120, (i) => {
    character.setTargetVelocity([2, 0, 0]);
    if (reached < 0 && Math.abs(body.linearVelocity[0] - 2) < 0.02) reached = i;
  });
  assert.ok(character.grounded, 'standing on the floor');
  near(body.linearVelocity[0], 2, 0.05, 'the target speed');
  // 2 m/s at 20 m/s^2 takes 0.1 s: six steps (and one for the step before it is seen).
  assert.ok(reached >= 5 && reached <= 9, `reached it after ${reached} steps`);
  assert.ok(tilt(body.rotation) < 0.02, 'upright while walking');
  drive(physics, character, 30, () => character.setTargetVelocity([0, 0, 0]));
  near(body.linearVelocity[0], 0, 0.05, 'stopped');
  physics.dispose();
});

test('it holds still on a slope it can stand on, walks up it, and slides down one that is too steep', () => {
  const run = (angle, wish) => {
    const physics = new Physics(null);
    floor(physics, angle);
    const slope = [Math.cos(angle), Math.sin(angle), 0];
    const body = hero(physics, { position: [0, Math.tan(angle) * 0 + rest + 0.05, 0] }),
      character = physics.createDynamicCharacter(body, { maxSlopeClimbAngle: Math.PI / 4 });
    drive(physics, character, 60, () => character.setTargetVelocity([0, 0, 0]));
    const x0 = body.position[0];
    drive(physics, character, 120, () => character.setTargetVelocity(wish));
    const result = { moved: body.position[0] - x0, grounded: character.grounded, slope };
    physics.dispose();
    return result;
  };
  const angle = (30 * Math.PI) / 180;
  const holds = run(angle, [0, 0, 0]);
  assert.ok(holds.grounded && Math.abs(holds.moved) < 0.05, `held on 30 degrees: moved ${holds.moved}`);
  const climbs = run(angle, [-2, 0, 0]);
  // The floor tilts so that +x is uphill for a positive angle about z: walking along -x goes downhill.
  const up = run(angle, [2, 0, 0]);
  assert.ok(up.moved > 1, `walked up: ${up.moved}`);
  assert.ok(climbs.moved < -1, `walked down: ${climbs.moved}`);
  const steep = run((60 * Math.PI) / 180, [0, 0, 0]);
  assert.ok(!steep.grounded && steep.moved < -1, `slid down 60 degrees: moved ${steep.moved}`);
});

test('a jump reaches the height its speed gives, only from the ground', () => {
  const physics = new Physics(null);
  floor(physics);
  const body = hero(physics),
    character = physics.createDynamicCharacter(body);
  drive(physics, character, 30);
  const base = body.position[1];
  const g = 9.81,
    height = 1,
    speed = Math.sqrt(2 * g * height);
  assert.ok(character.jump(speed));
  let apex = 0,
    mid = false;
  for (let i = 0; i < 90; i++) {
    character.update();
    physics.step();
    apex = Math.max(apex, body.position[1] - base);
    if (i === 10 && !character.jump(speed)) mid = true;
  }
  near(apex, height, 0.1, 'the apex');
  assert.ok(mid, 'no jump in the air');
  physics.dispose();
});

test('it rides a moving platform, and is carried at the platform speed', () => {
  const physics = new Physics(null),
    platform = physics.addBody(null, {
      type: 'kinematicVelocity',
      position: [0, -0.5, 0],
      linearVelocity: [1, 0, 0],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50], friction: 0 },
    }),
    body = hero(physics),
    character = physics.createDynamicCharacter(body);
  drive(physics, character, 120, () => character.setTargetVelocity([0, 0, 0]));
  near(body.linearVelocity[0], 1, 0.05, 'moving with the platform');
  assert.equal(character.platform, platform);
  physics.dispose();
});

test('a hard blow tips it and it rises again; a facing turns it about up', () => {
  const physics = new Physics(null);
  floor(physics);
  const body = hero(physics),
    character = physics.createDynamicCharacter(body);
  drive(physics, character, 30);
  body.applyImpulse([20, 0, 0], [0, 0.6, 0]);
  let worst = 0;
  drive(physics, character, 30, () => (worst = Math.max(worst, tilt(body.rotation))));
  assert.ok(worst > 0.05, `the blow tipped it: ${worst}`);
  drive(physics, character, 180);
  assert.ok(tilt(body.rotation) < 0.02, `and it stood up again: ${tilt(body.rotation)}`);
  character.setFacing([1, 0, 0]);
  drive(physics, character, 120, () => character.setFacing([1, 0, 0]));
  const [x, y, z, w] = body.rotation;
  // The forward axis (+z) after the turn, flattened.
  const fx = 2 * (x * z + w * y),
    fz = 1 - 2 * (x * x + y * y);
  near(Math.atan2(fx, fz), Math.PI / 2, 0.05, 'facing +x');
  physics.dispose();
});

test('a hover spring floats it at the height asked, settles after a drop, and carries its weight onto a dynamic ground', () => {
  const physics = new Physics(null);
  floor(physics);
  const body = hero(physics, { position: [0, rest + 0.8, 0] }),
    character = physics.createDynamicCharacter(body, { hover: { height: 0.2 } });
  let worst = 0;
  drive(physics, character, 240, (i) => {
    if (i > 120) worst = Math.max(worst, Math.abs(body.position[1] - (rest + 0.2)));
  });
  near(body.position[1], rest + 0.2, 0.005, 'floating 20 cm above the floor');
  assert.ok(worst < 0.005, `and it stays there: ${worst}`);
  assert.ok(character.grounded, 'a hovering character is grounded');
  physics.dispose();
  // On a dynamic box the weight goes into the box: a light box under a heavy character sinks only as far as the spring lets it.
  const world = new Physics(null);
  const slab = world.addBody(null, {
      position: [0, 0.25, 0],
      colliders: { shape: 'box', halfExtents: [3, 0.25, 3], density: 1, friction: 0 },
    }),
    ground = floor(world),
    walker = hero(world, { position: [0, 0.5 + rest + 0.2, 0] }),
    stand = world.createDynamicCharacter(walker, { hover: { height: 0.2 } });
  assert.ok(ground.valid);
  drive(world, stand, 240);
  near(walker.position[1], 0.5 + rest + 0.2, 0.02, 'floating above the box');
  assert.ok(
    slab.position[1] < 0.2501 + 1e-3 && slab.position[1] > 0.2,
    `the box holds the weight at rest: ${slab.position[1]}`,
  );
  world.dispose();
});

test('a hovering character passes over a step lower than its hover, and a jump still clears the spring', () => {
  const physics = new Physics(null);
  floor(physics);
  physics.addBody(null, {
    type: 'fixed',
    position: [3, 0.1, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.1, 3], friction: 0 },
  });
  const body = hero(physics, { position: [0, rest + 0.25, 0] }),
    character = physics.createDynamicCharacter(body, { hover: { height: 0.25 } });
  drive(physics, character, 60);
  drive(physics, character, 240, () => character.setTargetVelocity([2, 0, 0]));
  assert.ok(body.position[0] > 2.5, `it went on to the step: x = ${body.position[0]}`);
  const top = body.position[0] > 3 ? 0.2 : 0;
  assert.ok(top === 0.2 || body.position[1] > rest, 'it rode up onto the step');
  drive(physics, character, 120, () => character.setTargetVelocity([0, 0, 0]));
  const base = body.position[1];
  assert.ok(character.jump(4));
  let apex = 0;
  for (let i = 0; i < 90; i++) {
    character.update();
    physics.step();
    apex = Math.max(apex, body.position[1] - base);
  }
  near(apex, (4 * 4) / (2 * 9.81), 0.1, 'the jump goes as high as its speed gives');
  physics.dispose();
});

test('stairs lift it over a riser it could not pass, and not over one that is too high', () => {
  const run = (stairs, riser) => {
    const physics = new Physics(null);
    floor(physics);
    physics.addBody(null, {
      type: 'fixed',
      position: [3, riser / 2, 0],
      colliders: { shape: 'box', halfExtents: [1, riser / 2, 3], friction: 0 },
    });
    const body = hero(physics),
      character = physics.createDynamicCharacter(body, stairs ? { stairs } : {});
    drive(physics, character, 30);
    let top = 0;
    drive(physics, character, 110, () => {
      character.setTargetVelocity([2, 0, 0]);
      top = Math.max(top, body.position[1]);
    });
    const result = { x: body.position[0], y: top };
    physics.dispose();
    return result;
  };
  const without = run(undefined, 0.2),
    over = run({ maxHeight: 0.3 }, 0.2),
    high = run({ maxHeight: 0.3 }, 0.5);
  assert.ok(without.x < 2.75, `blocked without stairs: x = ${without.x}`);
  assert.ok(over.x > 2.9 && over.y > rest + 0.19, `up onto it with stairs: x = ${over.x}, y = ${over.y}`);
  assert.ok(high.x < 2.75, `a 50 cm riser is too high for 30 cm stairs: x = ${high.x}`);
});

test('a flight of stairs is climbed with the hover and the steps', () => {
  const physics = new Physics(null);
  floor(physics);
  for (let k = 0; k < 6; k++)
    physics.addBody(null, {
      type: 'fixed',
      position: [2 + 0.5 * k + 0.25, 0.075 * (k + 1), 0],
      colliders: { shape: 'box', halfExtents: [0.25, 0.075 * (k + 1), 3], friction: 0 },
    });
  const body = hero(physics),
    character = physics.createDynamicCharacter(body, {
      hover: { height: 0.05 },
      stairs: { maxHeight: 0.2, minDepth: 0.1 },
    });
  drive(physics, character, 60);
  let top = 0;
  drive(physics, character, 300, () => {
    character.setTargetVelocity([1.5, 0, 0]);
    top = Math.max(top, body.position[1]);
  });
  // Six risers of 15 cm: the top tread is 90 cm up.
  assert.ok(top > rest + 0.05 + 0.85, `up the flight: the highest it got was ${top}`);
  physics.dispose();
});

test('a dynamic character needs a dynamic body of this world with a collider, and a disposed one refuses', () => {
  const physics = new Physics(null),
    fixed = physics.addBody(null, { type: 'fixed', colliders: { shape: 'sphere', radius: 1 } }),
    bare = physics.addBody(null, { colliders: [] }),
    other = new Physics(null),
    outsider = other.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  assert.throws(() => physics.createDynamicCharacter(fixed), /dynamic body/);
  assert.throws(() => physics.createDynamicCharacter(bare), /collider/);
  assert.throws(() => physics.createDynamicCharacter(outsider), { code: 'state', message: /addBody first/ });
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  assert.throws(() => physics.createDynamicCharacter(body, { up: [0, 0, 0] }), /Up must not be the zero vector/);
  assert.throws(
    () => physics.createDynamicCharacter(body, { uprightFrequency: 0 }),
    /uprightFrequency must be more than zero/,
  );
  const character = physics.createDynamicCharacter(body);
  assert.throws(() => character.jump(0), /jump speed/);
  assert.equal(character.jump(3), false, 'not grounded, so no jump');
  character.dispose();
  assert.throws(() => character.update(), { code: 'disposed' });
  physics.dispose();
  other.dispose();
});
