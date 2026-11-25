// Forces and torques at a point, locked rotation, the collider settings that change after creation, and what the character
// controller does with a ledge, a slope and a crate, each held to a closed form. Rapier 2D comparisons for the same scenes
// are in oracle-rapier.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D, interactionGroups } from '../dist/index.js';

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
  // The hero walks 6 a second: 240 steps take it to x = 24, past the ledge's front face at 19 (its own front edge is 1 ahead of its centre).
  const free = walker(() => {}, {}, 240);
  near(free.x, 24, 0.2, 'on a bare floor it walks the whole 240 steps at 6 per second');
  const blocked = walker(ledge(1), {}, 240);
  assert.ok(blocked.x < 19, `a ledge 1 high stops it without autostep (${blocked.x})`);
  const stepped = walker(ledge(1), { autostep: { maxHeight: 1.5, minWidth: 0.5 } }, 240);
  assert.ok(stepped.x > 21, `with autostep of 1.5 it is over the ledge and walking on (${stepped.x})`);
  near(stepped.y, 5.95, 0.1, 'and standing on top of it, 1 higher');
  const tall = walker(ledge(3), { autostep: { maxHeight: 1.5, minWidth: 0.5 } }, 240);
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

test('minSlopeSlideAngle decides whether a slope is slid along or climbed at the walker speed', () => {
  // A ramp of 40 degrees from x = 20 to x = 40: under the default 45 degree climb limit it is climbable, and past the default 30 degree
  // slide angle. A character pressed into it either slides along the surface (what is left of its movement after the contact, r, turned
  // along the slope: r cos(a) along it, r cos^2(a) of it across) or climbs it keeping its horizontal speed (r across).
  const angle = (40 * Math.PI) / 180;
  const rise = Math.tan(angle) * 20;
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
  const across = (options) => {
    const physics = world({ gravity: [0, 0] });
    physics.addBody(null, { type: 'fixed', position: [50, 10], colliders: { shape: 'box', width: 200, height: 2 } });
    ramp(physics);
    const hero = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [14, 6.95],
      colliders: { shape: 'box', width: 2, height: 4 },
    });
    const controller = physics.createCharacterController(hero, { offset: 0.01, ...options });
    // One long move into the foot of the ramp: where it ends says what was done with the movement left after the contact.
    const result = controller.move([12, 0]);
    physics.dispose();
    return result.movement;
  };
  const slides = across({});
  const climbs = across({ minSlopeSlideAngle: (50 * Math.PI) / 180 });
  // The hero's front edge, 1 ahead of its centre, meets the ramp's foot at x = 20 (its corner there, the offset 0.01 short of it): 4.99
  // travelled, 7.01 left. Climbing keeps all of it across; sliding keeps cos^2(40 degrees) of it.
  const left = 12 - 4.99;
  near(climbs[0], 4.99 + left, 0.3, 'climbing keeps the horizontal movement');
  near(slides[0], 4.99 + left * Math.cos(angle) ** 2, 0.4, 'sliding keeps cos^2 of it');
  assert.ok(climbs[0] > slides[0] + 1.5, `the two differ: ${climbs[0]} against ${slides[0]}`);
});

test('a character with another up walks the floor that is below it that way, grounded, and steps its ledges', () => {
  // The walker's scene turned a quarter turn: up is +x, the floor is at x = -10 (2 thick) and the hero walks along +y.
  const turned = (options, ledge, steps = 90) => {
    const physics = world({ gravity: [0, 0] });
    physics.addBody(null, { type: 'fixed', position: [-10, 50], colliders: { shape: 'box', width: 2, height: 200 } });
    if (ledge)
      physics.addBody(null, {
        type: 'fixed',
        position: [-(9 - ledge / 2), 20],
        colliders: { shape: 'box', width: ledge, height: 4 },
      });
    const hero = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [-6.95, 0],
      colliders: { shape: 'box', width: 4, height: 2 },
    });
    const controller = physics.createCharacterController(hero, { offset: 0.01, ...options });
    let last;
    physics.on('beforestep', (dt) => {
      last = controller.move([0, 6 * dt]);
    });
    run(physics, steps);
    const result = { x: hero.position[0], y: hero.position[1], grounded: last.grounded };
    physics.dispose();
    return result;
  };
  const upright = turned({ up: [1, 0], snapToGround: 0.5 });
  near(upright.y, 9, 0.2, 'it walks the 90 steps');
  near(upright.x, -6.95, 0.05, 'and stays on its floor');
  assert.ok(upright.grounded, 'grounded against a floor below it');
  assert.ok(
    !turned({ snapToGround: 0.5 }).grounded,
    'with the default up the same floor is a wall at its side, not a ground',
  );
  assert.ok(turned({ up: [1, 0] }, 1, 240).y < 19, 'a ledge 1 high stops it without autostep');
  assert.ok(
    turned({ up: [1, 0], autostep: { maxHeight: 1.5, minWidth: 0.5 } }, 1).y > 8,
    'and it steps over it with autostep',
  );
  assert.throws(() => turned({ up: [0, 0] }), RangeError);
});

test('autostep needs minWidth of free room across the top of the ledge, and includeDynamic lets it step onto a dynamic body', () => {
  // A ledge 1 high from x = 20 to 24, with a wall standing on it 0.4 from its front edge: room for a hero of width 2 and offset 0.01 is about 0.4.
  const ledgeAndWall = (physics) => {
    physics.addBody(null, { type: 'fixed', position: [22, 8.5], colliders: { shape: 'box', width: 4, height: 1 } });
    physics.addBody(null, { type: 'fixed', position: [20.45, 5], colliders: { shape: 'box', width: 0.1, height: 6 } });
  };
  const roomy = walker(ledgeAndWall, { autostep: { maxHeight: 1.5, minWidth: 0.3 } }, 240);
  const cramped = walker(ledgeAndWall, { autostep: { maxHeight: 1.5, minWidth: 0.6 } }, 240);
  assert.ok(roomy.y < 6.5, `with 0.3 of room needed it steps up onto the ledge (${roomy.y})`);
  near(cramped.y, 6.95, 0.05, 'with 0.6 needed it does not');
  // A dynamic crate in the same place as the ledge (no gravity, so it stays): stepped onto by default and when asked, not when refused.
  const crate = (physics) =>
    physics.addBody(null, {
      position: [22, 8.5],
      canSleep: false,
      colliders: { shape: 'box', width: 4, height: 1, density: 1000 },
    });
  const onto = (autostep) => walker(crate, { autostep }, 240);
  assert.ok(onto({ maxHeight: 1.5, minWidth: 0.5 }).y < 6.5, 'by default it steps onto a dynamic body');
  assert.ok(onto({ maxHeight: 1.5, minWidth: 0.5, includeDynamic: true }).y < 6.5, 'as it does when asked');
  const refused = onto({ maxHeight: 1.5, minWidth: 0.5, includeDynamic: false });
  assert.ok(refused.x < 19 && refused.y > 6.9, `and not when it is told not to: ${refused.x}, ${refused.y}`);
});

test('a filter on the controller, or on one move, leaves colliders out of what the character meets', () => {
  const wallAt = (physics, options = {}) =>
    physics.addBody(null, {
      type: 'fixed',
      position: [20, 5],
      colliders: { shape: 'box', width: 1, height: 10, ...options },
    });
  const walk = (build, options, filter, steps = 240) => {
    const physics = world({ gravity: [0, 0] });
    physics.addBody(null, { type: 'fixed', position: [50, 10], colliders: { shape: 'box', width: 200, height: 2 } });
    const wall = build(physics);
    const hero = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, 6.95],
      colliders: { shape: 'box', width: 2, height: 4 },
    });
    const controller = physics.createCharacterController(hero, { offset: 0.01, ...options });
    physics.on('beforestep', (dt) => controller.move([6 * dt, 0], filter));
    run(physics, steps);
    const x = hero.position[0];
    physics.dispose();
    return { x, wall };
  };
  assert.ok(walk(wallAt, {}).x < 19, 'a wall stops it');
  near(
    walk(wallAt, { filter: { excludeFixed: true } }).x,
    24,
    0.2,
    'excludeFixed: the wall and the floor are not met, so it passes',
  );
  near(
    walk((p) => wallAt(p, { collisionGroups: interactionGroups([2], [2]) }), {
      filter: { groups: interactionGroups([1], [1]) },
    }).x,
    24,
    0.2,
    'groups that do not meet pass',
  );
  assert.ok(
    walk((p) => wallAt(p, { collisionGroups: interactionGroups([1], [1]) }), {
      filter: { groups: interactionGroups([1], [1]) },
    }).x < 19,
    'groups that meet stop it',
  );
  const byPredicate = walk(wallAt, { filter: { predicate: (body) => body.position[0] !== 20 } });
  near(byPredicate.x, 24, 0.2, 'a predicate that skips the wall lets it through');
  // A filter given to one move replaces the controller's: the controller leaves the wall out, the move says to meet it.
  assert.ok(
    walk(wallAt, { filter: { excludeFixed: true } }, {}).x < 19,
    "a filter on the move replaces the controller's",
  );
  // The controller's own body is never one of its obstacles, whatever the filter says.
  near(walk(() => {}, { filter: { excludeDynamic: false } }).x, 24, 0.2, 'it does not block itself');
});
