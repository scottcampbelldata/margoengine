// Contacts through the names of the own entry: touching, points, friction, restitution and the solver's two counts.
// The mechanics themselves are proved in kernel/tests/solver.rs; here each option has to reach the kernel and mean it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, Physics, loadKernel } from '../dist/next.js';

await Physics.load();
const G = 9.81;

const addFloor = (physics, options = {}) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [200, 0.5, 20], ...options },
  });

function floorAndBall(physics, height, ball = {}) {
  return {
    floor: addFloor(physics),
    ball: physics.addBody(null, {
      position: [0, height, 0],
      colliders: { shape: 'sphere', radius: 0.5, density: 1, ...ball },
    }),
  };
}

test('a point ahead of a body is not a touch', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    { floor, ball } = floorAndBall(physics, 0.5 + 1e-3);
  physics.step();
  const [contact] = physics.kernel.contacts();
  assert.ok(contact.points[0].separation > 0, 'the kernel holds a point in front of the ball');
  assert.equal(contact.points[0].normalImpulse, 0);
  assert.equal(physics.touching(ball, floor), false);
  assert.deepEqual(physics.contactPoints(ball), []);
  physics.dispose();
});

test('a ball lands, rests and touches', () => {
  const physics = new Physics(null),
    { floor, ball } = floorAndBall(physics, 3);
  physics.step();
  assert.equal(physics.touching(ball, floor), false);
  assert.deepEqual(physics.contactPoints(ball), []);
  for (let i = 0; i < 240; i++) physics.step();
  assert.ok(Math.abs(ball.position[1] - 0.5) < 2e-3, `rests at its radius, got ${ball.position[1]}`);
  assert.equal(physics.touching(ball, floor), true);
  assert.equal(physics.touching(floor, ball), true);
  assert.equal(physics.contactPoints(ball).length, 1);
  assert.equal(physics.contactPoints(floor).length, 1);
  physics.dispose();
});

test('a body asleep on a floor still touches it', () => {
  const physics = new Physics(null),
    { floor, ball } = floorAndBall(physics, 0.5);
  for (let i = 0; i < 300 && !ball.sleeping; i++) physics.step();
  assert.equal(ball.sleeping, true);
  assert.equal(physics.touching(ball, floor), true);
  physics.dispose();
});

test('a box flat on a floor is pushed at its four corners', () => {
  const physics = new Physics(null),
    floor = addFloor(physics),
    box = physics.addBody(null, {
      position: [0, 0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 1 },
    });
  for (let i = 0; i < 30; i++) physics.step();
  const corners = physics.contactPoints(box);
  assert.equal(corners.length, 4);
  for (const [x, y, z] of corners) {
    assert.ok(Math.abs(Math.abs(x) - 0.5) < 1e-3 && Math.abs(Math.abs(z) - 0.5) < 1e-3, `a corner, got ${x}, ${z}`);
    assert.ok(Math.abs(y) < 2e-3);
  }
  assert.equal(physics.touching(box, floor), true);
  physics.dispose();
});

test('bodies that never met do not touch, and a body of another shape answers the same', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    a = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } }),
    b = physics.addBody(null, { position: [10, 0, 0], colliders: { shape: 'capsule', radius: 1, halfHeight: 1 } });
  physics.step();
  assert.equal(physics.touching(a, b), false);
  physics.dispose();
});

/** A block on a floor under gravity tilted by the angle whose tangent is `slope`: how far it moves in `seconds` once under way, from what speed. */
function slide(slope, friction, seconds) {
  const hypotenuse = Math.sqrt(1 + slope * slope),
    physics = new Physics(null, { gravity: [(G * slope) / hypotenuse, -G / hypotenuse, 0] }),
    block = physics.addBody(null, {
      position: [0, 0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 1, friction: 0 },
    });
  addFloor(physics, { friction, frictionCombine: 'max' });
  for (let i = 0; i < 30; i++) physics.step();
  const start = block.position[0],
    speed = block.linearVelocity[0];
  for (let i = 0; i < seconds * 60; i++) physics.step();
  const moved = block.position[0] - start;
  physics.dispose();
  return { moved, speed };
}

test('friction: a block holds below tan t = mu and slides above it', () => {
  assert.ok(Math.abs(slide(0.4, 0.5, 2).moved) < 1e-4);
  const { moved, speed } = slide(0.6, 0.5, 2),
    acceleration = (G * (0.6 - 0.5)) / Math.sqrt(1 + 0.36),
    expected = speed * 2 + 0.5 * acceleration * 4;
  assert.ok(Math.abs(moved - expected) < 0.01 * expected, `moved ${moved}, expected about ${expected}`);
});

test('setFriction reaches the next step and wakes a sleeper it no longer holds', () => {
  const physics = new Physics(null, { gravity: [G * 0.3, -G, 0] }),
    block = physics.addBody(null, {
      position: [0, 0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 1, friction: 1, frictionCombine: 'min' },
    }),
    collider = block.colliders[0];
  addFloor(physics);
  for (let i = 0; i < 400 && !block.sleeping; i++) physics.step();
  assert.equal(block.sleeping, true, 'mu 0.5 holds a slope of 0.3');
  assert.equal(collider.friction(), 1);
  assert.equal(collider.setFriction(0).setRestitution(0.25), collider);
  assert.equal(collider.friction(), 0);
  assert.equal(collider.restitution(), 0.25);
  assert.equal(block.sleeping, false);
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(block.position[0] > 1, `with no friction it runs away, got ${block.position[0]}`);
  physics.dispose();
});

test('restitution: a ball rebounds to e squared of its drop', () => {
  const physics = new Physics(null),
    { ball } = floorAndBall(physics, 2.5, { restitution: 0.5, restitutionCombine: 'max' });
  let landed = false,
    top = 0;
  for (let i = 0; i < 90; i++) {
    physics.step();
    if (ball.linearVelocity[1] > 0) landed = true;
    if (landed && ball.position[1] > top) top = ball.position[1];
  }
  assert.ok(landed);
  assert.ok(Math.abs(top - 0.5 - 0.25 * 2) < 0.01, `rose to ${top}`);
  physics.dispose();
});

test('combine rules: the pair takes the higher rule, max over multiply over min over average', async () => {
  await loadKernel();
  const pair = (a, b) => {
    const world = new KernelWorld();
    world.setGravity(0, 0, 0);
    const one = world.addBody('dynamic'),
      other = world.addBody('dynamic');
    world.addCollider(one, 'ball', [1], a);
    world.addCollider(other, 'ball', [1], b);
    world.columns.positionX[other] = 1.99;
    world.step(1 / 60);
    const { pairA, pairFriction, pairRestitution } = world.columns;
    const row = pairA.findIndex((value) => value !== 0xffffffff);
    return [pairFriction[row], pairRestitution[row]];
  };
  const near = (got, wanted) => assert.ok(Math.abs(got - wanted) < 1e-6, `got ${got}, wanted ${wanted}`);
  const values = { friction: 0.2, restitution: 0.4 },
    others = { friction: 0.6, restitution: 0.8 };
  for (const [rule, friction, restitution] of [
    ['average', 0.4, 0.6],
    ['min', 0.2, 0.4],
    ['multiply', 0.12, 0.32],
    ['max', 0.6, 0.8],
  ]) {
    const [f, r] = pair(
      { ...values, frictionCombine: rule, restitutionCombine: rule },
      { ...others, frictionCombine: rule, restitutionCombine: rule },
    );
    near(f, friction);
    near(r, restitution);
  }
  const [f, r] = pair({ ...values, frictionCombine: 'max' }, { ...others, restitutionCombine: 'multiply' });
  near(f, 0.6);
  near(r, 0.32);
  const [plain] = pair({}, {});
  near(plain, 0.5);
});

test('counts and values the solver cannot use are refused by name', async () => {
  await loadKernel();
  const world = new KernelWorld(),
    body = world.addBody('dynamic');
  assert.equal(world.substeps, 8);
  assert.equal(world.iterations, 2);
  world.iterations = 3;
  assert.equal(world.iterations, 3);
  for (const bad of [0, 1.5, -1, Number.NaN, 0x10000])
    assert.throws(
      () => {
        world.iterations = bad;
      },
      { name: 'RangeError', message: /Iterations must/ },
    );
  for (const [options, message] of [
    [{ friction: -1 }, /Friction must/],
    [{ friction: Number.POSITIVE_INFINITY }, /Friction must/],
    [{ friction: Number.NaN }, /Friction must/],
    [{ restitution: 1.5 }, /Restitution must/],
    [{ restitution: Number.NaN }, /Restitution must/],
    [{ frictionCombine: 'sum' }, /combine rule/],
    [{ restitutionCombine: 'sum' }, /combine rule/],
  ])
    assert.throws(() => world.addCollider(body, 'ball', [1], options), { name: 'RangeError', message });
  const physics = new Physics(null, { iterations: 4 }),
    block = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  assert.equal(physics.iterations, 4);
  assert.throws(() => block.colliders[0].setFriction(-1), RangeError);
  assert.throws(() => block.colliders[0].setRestitution(2), RangeError);
  physics.dispose();
});

test('more colliders than the world had room for keep their friction', async () => {
  await loadKernel();
  const world = new KernelWorld(1, 1),
    rows = [];
  for (let i = 0; i < 40; i++) {
    const body = world.addBody('dynamic');
    rows.push(world.addCollider(body, 'ball', [1], { friction: i / 40, restitution: i / 80, frictionCombine: 'max' }));
  }
  const { colliderFriction, colliderRestitution, colliderCombine } = world.columns;
  rows.forEach((row, i) => {
    assert.equal(colliderFriction[row], Math.fround(i / 40));
    assert.equal(colliderRestitution[row], Math.fround(i / 80));
    assert.equal(colliderCombine[row], 3);
  });
});

test('contactforce says how hard a pair pressed: a box at rest reads its weight', () => {
  const physics = new Physics(null),
    floor = physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } }),
    box = physics.addBody(null, { position: [0, 0.5, 0], canSleep: false, colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 3 } }),
    seen = [];
  const stop = physics.on('contactforce', (event) => seen.push(event));
  for (let i = 0; i < 30; i++) physics.step();
  stop();
  const last = seen.at(-1);
  assert.equal(seen.length, 30, 'once a step for the one pair');
  assert.ok(Math.abs(last.force - 3 * 9.81) < 0.05, `a weight of 29.43 N, read ${last.force}`);
  assert.ok(Math.abs(last.impulse - (3 * 9.81) / 60) < 0.001, `its impulse, read ${last.impulse}`);
  assert.deepEqual(new Set([last.bodyA, last.bodyB]), new Set([floor, box]));
  assert.equal(last.type, 'contactforce');
  assert.ok(last.colliderA.body === last.bodyA && last.meshA === null);
  physics.step();
  assert.equal(seen.length, 30, 'no listener: nothing is gathered');
  physics.dispose();
});

test('contactforce listeners may step and remove: each gathers into its own list', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
  const box = physics.addBody(null, { position: [0, 0.5, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  let calls = 0;
  physics.on('contactforce', () => {
    calls++;
    if (calls === 1) physics.step();
    if (calls === 2) physics.removeBody(box);
  });
  for (let i = 0; i < 5; i++) physics.step();
  assert.equal(calls, 2);
  physics.dispose();
});
