// The character controller's options and outputs, each on a scene with a closed form and, where Rapier's JavaScript has the
// option, against Rapier (`tests/oracle.js`, as a black box): a non-default up, sliding switched off, lengths relative to the
// character's height, the normal nudge, climbing a dynamic body, the filter of a move, what a move reports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics, eulerToQuat } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);
const radius = 0.3,
  halfHeight = 0.4;
const floor = (physics) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
  });
const character = (physics, position, collider = { shape: 'capsule', halfHeight, radius }) =>
  physics.addBody(null, { type: 'kinematicPosition', position, colliders: collider });
/** Moves a controller for `steps` steps by `desired` and returns the last result. */
const walk = (physics, controller, desired, steps, filter) => {
  let result;
  for (let i = 0; i < steps; i++) {
    physics.step();
    result = controller.move(desired, filter);
  }
  return result;
};

for (const World of [Physics, RapierPhysics]) {
  const name = World === Physics ? 'own' : 'Rapier';
  test(`${name}: a character with another up direction stands on a floor that faces it and is grounded`, () => {
    const physics = new World(null);
    // The floor is the plane z = 0 and up is +z: a sphere dropped along -z rests a radius and the offset above it.
    physics.addBody(null, {
      type: 'fixed',
      position: [0, 0, -0.5],
      colliders: { shape: 'box', halfExtents: [50, 50, 0.5] },
    });
    const ball = character(physics, [0, 0, 1], { shape: 'sphere', radius: 0.3 });
    const controller = physics.createCharacterController(ball, { up: [0, 0, 1], autostep: false });
    const result = walk(physics, controller, [0, 0, -0.1], 40);
    assert.equal(result.grounded, true, 'grounded');
    near(ball.position[2], 0.3 + 0.01, 3e-3, 'a radius and the offset above the floor');
    physics.dispose();
  });

  test(`${name}: with sliding off, a character that meets a wall at an angle stops there and does not slide along it`, () => {
    const run = (slide) => {
      const physics = new World(null);
      floor(physics);
      physics.addBody(null, {
        type: 'fixed',
        position: [3, 1, 0],
        colliders: { shape: 'box', halfExtents: [0.1, 1, 5] },
      });
      const walker = character(physics, [0, 0.72, 0]);
      const controller = physics.createCharacterController(walker, { slide, autostep: false, snapToGround: false });
      walk(physics, controller, [0.1, 0, 0.1], 40);
      const at = [...walker.position];
      physics.dispose();
      return at;
    };
    const [sliding, stuck] = [run(true), run(false)];
    assert.ok(sliding[2] > 3.5, `sliding: it goes on along the wall (z ${sliding[2]})`);
    near(stuck[2], stuck[0], 0.05, 'not sliding: it stops where it met the wall, on the diagonal');
    assert.ok(sliding[0] > 2.5 && stuck[0] > 2.5, 'both reach the wall');
  });
}

test('a length given relative to the character is that share of its height', () => {
  // The capsule is 2 (0.4 + 0.3) = 1.4 m tall: an offset of 0.1 of it rests 0.14 m off the floor.
  const rest = (offset) => {
    const physics = new Physics(null);
    floor(physics);
    const walker = character(physics, [0, 1.5, 0]);
    const controller = physics.createCharacterController(walker, { offset, autostep: false, snapToGround: false });
    walk(physics, controller, [0, -0.2, 0], 30);
    const y = walker.position[1] - (halfHeight + radius);
    physics.dispose();
    return y;
  };
  near(rest({ relative: 0.1 }), 0.14, 2e-3, 'relative 0.1 of 1.4 m');
  near(rest(0.14), 0.14, 2e-3, 'the same in metres');
  near(rest({ relative: 0.01 }), 0.014, 2e-3, 'relative 0.01');
  const other = new Physics(null);
  assert.throws(
    () =>
      other.createCharacterController(
        other.addBody(null, { type: 'kinematicPosition', colliders: { shape: 'sphere', radius: 1 } }),
        { offset: -1 },
      ),
    /offset must be zero or more/,
  );
  other.dispose();
  // Autostep lengths and the snap distance take the same form.
  const physics = new Physics(null);
  floor(physics);
  physics.addBody(null, {
    type: 'fixed',
    position: [1.2, 0.1, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.1, 5] },
  });
  const walker = character(physics, [0, halfHeight + radius + 0.02, 0]);
  const controller = physics.createCharacterController(walker, {
    autostep: { maxHeight: { relative: 0.25 }, minWidth: { relative: 0.1 } },
  });
  let peak = 0;
  for (let i = 0; i < 50; i++) {
    physics.step();
    controller.move([0.05, -0.05, 0]);
    peak = Math.max(peak, walker.position[1]);
  }
  assert.ok(
    peak > halfHeight + radius + 0.15,
    `a step of 0.2 m is climbed with maxHeight 0.25 of 1.4 m = 0.35 m: peak y ${peak}`,
  );
  physics.dispose();
});

test('the normal nudge pushes a sliding character off what it slides along by that much', () => {
  const gap = (nudgeFactor) => {
    const physics = new Physics(null);
    floor(physics);
    physics.addBody(null, {
      type: 'fixed',
      position: [3, 1, 0],
      colliders: { shape: 'box', halfExtents: [0.1, 1, 5] },
    });
    const walker = character(physics, [0, 0.72, 0]);
    const controller = physics.createCharacterController(walker, {
      autostep: false,
      snapToGround: false,
      normalNudgeFactor: nudgeFactor,
    });
    walk(physics, controller, [0.1, 0, 0.1], 40);
    const x = 3 - 0.1 - walker.position[0] - radius;
    physics.dispose();
    return x;
  };
  const [none, big] = [gap(0), gap(0.02)];
  assert.ok(big - none > 0.015 && big - none < 0.03, `the nudge opens the gap by about 0.02 m: ${none} then ${big}`);
});

test('with includeDynamicBodies a character climbs a dynamic crate, and without it does not', () => {
  const climb = (includeDynamicBodies) => {
    const physics = new Physics(null);
    floor(physics);
    physics.addBody(null, {
      position: [1.2, 0.1, 0],
      type: 'dynamic',
      colliders: { shape: 'box', halfExtents: [0.5, 0.1, 5], mass: 500 },
    });
    const walker = character(physics, [0, halfHeight + radius + 0.02, 0]);
    const controller = physics.createCharacterController(walker, {
      autostep: { maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies },
    });
    // The highest the character gets: the step is a moment, and the crate it climbed is a dynamic body that its contact pushes away.
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      physics.step();
      controller.move([0.05, -0.05, 0]);
      peak = Math.max(peak, walker.position[1]);
    }
    physics.dispose();
    return peak;
  };
  assert.ok(climb(true) > halfHeight + radius + 0.15, 'climbs the crate: the top of the 0.2 m crate lifts it');
  assert.ok(climb(false) < halfHeight + radius + 0.1, 'stopped by the crate');
});

test("a move reports what Rapier's controller does: sliding down a slope, the movement, and each collision it met", () => {
  const ramp = (angle, slideAngle) => {
    const physics = new Physics(null);
    physics.addBody(null, {
      type: 'fixed',
      rotation: eulerToQuat(0, 0, angle),
      colliders: { shape: 'box', halfExtents: [10, 0.05, 10] },
    });
    const walker = character(physics, [0, 1.2, 0]);
    const controller = physics.createCharacterController(walker, {
      minSlopeSlideAngle: slideAngle,
      maxSlopeClimbAngle: Math.PI / 3,
      autostep: false,
      snapToGround: 0.2,
    });
    const result = walk(physics, controller, [0, -0.08, 0], 80);
    return { physics, controller, result };
  };
  const down = ramp((25 * Math.PI) / 180, (20 * Math.PI) / 180);
  assert.equal(down.result.slidingDownSlope, true);
  assert.equal(down.controller.isSlidingDownSlope, true);
  assert.ok(down.result.movement[0] < 0 && down.result.movement[1] < 0, 'the movement is down the slope');
  assert.deepEqual(down.controller.computedMovement(), down.result.movement);
  assert.equal(down.controller.computedGrounded(), true);
  const held = ramp((25 * Math.PI) / 180, (40 * Math.PI) / 180);
  assert.equal(held.result.slidingDownSlope, false, 'a slope under the slide angle holds it');
  down.physics.dispose();
  held.physics.dispose();
  // The collisions of a move: the character walks into a wall and the entry says where, with what normal, and how much was left.
  const physics = new Physics(null);
  floor(physics);
  physics.addBody(null, { type: 'fixed', position: [2, 1, 0], colliders: { shape: 'box', halfExtents: [0.1, 1, 5] } });
  const walker = character(physics, [1.5, 0.72, 0]);
  const controller = physics.createCharacterController(walker, { autostep: false, snapToGround: false });
  physics.step();
  const result = controller.move([1, 0, 0]);
  assert.equal(controller.numComputedCollisions(), result.collisions);
  const hit = controller.computedCollision(0);
  assert.ok(hit, 'a collision');
  // The wall's near face is at x = 1.9; the capsule's side is 0.3 + the 0.01 offset from it: it travels from 1.5 to 1.59.
  near(hit.translationApplied[0], 1.9 - 0.31 - 1.5, 2e-3, 'how far it went');
  near(hit.translationRemaining[0], 1 - (1.9 - 0.31 - 1.5), 2e-3, 'what was left');
  near(hit.normal[0], -1, 1e-3, 'the wall faces back at it');
  near(hit.point[0], 1.9, 3e-3, 'the point on the wall');
  assert.equal(controller.computedCollision(5), undefined);
  physics.dispose();
});

test('a move takes groups and flags: it passes what they leave out and stops at what they keep', () => {
  const run = (filter) => {
    const physics = new Physics(null);
    floor(physics);
    const wall = physics.addBody(null, {
      type: 'fixed',
      position: [2, 1, 0],
      colliders: { shape: 'box', halfExtents: [0.1, 1, 5], collisionGroups: 0x0002_0002 },
    });
    const crate = physics.addBody(null, {
      type: 'dynamic',
      position: [4, 0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.1, 0.5, 5], mass: 1000 },
    });
    const walker = character(physics, [0, 0.72, 0]);
    const controller = physics.createCharacterController(walker, { autostep: false, snapToGround: false });
    walk(physics, controller, [0.1, 0, 0], 60, filter);
    const x = walker.position[0];
    physics.dispose();
    void wall;
    void crate;
    return x;
  };
  near(run(undefined), 1.59, 0.02, 'with no filter it stops at the wall');
  near(
    run({ flags: 1 }),
    3.59,
    0.1,
    'skipping fixed bodies, it passes the wall and the dynamic crate stops it at x = 3.9',
  );
  assert.ok(run({ flags: 1 | 4 }) > 5, 'skipping fixed and dynamic bodies, nothing stops it');
  near(
    run({ groups: 0x0001_0001 }),
    3.59,
    0.1,
    'groups that do not meet the wall pass it (the crate is in every group)',
  );
  near(run({ groups: 0x0002_0002 }), 1.59, 0.02, 'groups that meet the wall stop at it');
});
