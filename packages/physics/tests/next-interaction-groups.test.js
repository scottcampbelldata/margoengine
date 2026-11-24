// Interaction groups 32 bits wide with Rapier's test modes (its Rust `InteractionGroups` and `InteractionTestMode`; the
// JavaScript build packs 16 + 16 bits and tests by `and` only). Proved by closed forms on contacts, solver groups and
// queries, and against Rapier's own packed groups for the 16-bit words, where the two solvers must agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics, collisionGroups, interactionGroups } from '../dist/index.js';

await Promise.all([Physics.load(), RapierPhysics.load()]);

/** A ball dropped on a floor, each with its own groups; the rest height tells whether they met. */
function drop(World, floorGroups, ballGroups, key = 'collisionGroups') {
  const physics = new World(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5], [key]: floorGroups },
  });
  const ball = physics.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'sphere', radius: 0.5, [key]: ballGroups },
  });
  for (let i = 0; i < 90; i++) physics.step();
  const y = ball.position[1];
  physics.dispose();
  return y;
}

test('the packed 16-bit groups keep their meaning and agree with Rapier, pair by pair', () => {
  const cases = [
    [collisionGroups(1, 2), collisionGroups(2, 1)],
    [collisionGroups(1, 2), collisionGroups(2, 4)],
    [collisionGroups([0, 3], [5]), collisionGroups([5], [3])],
    [collisionGroups(1, 1), collisionGroups(2, 2)],
    [0xffffffff, collisionGroups(8, 8)],
  ];
  for (const [a, b] of cases) {
    const own = drop(Physics, a, b) > 0.4,
      rapier = drop(RapierPhysics, a, b) > 0.4;
    assert.equal(own, rapier, `groups ${a.toString(16)} and ${b.toString(16)}`);
  }
});

test('groups above bit 15 meet by and, and a collider with all groups meets any group', () => {
  const floor = interactionGroups(1 << 20, 1 << 21),
    ball = interactionGroups(1 << 21, 1 << 20);
  assert.ok(
    Math.abs(drop(Physics, floor, ball) - 0.5) < 0.01,
    'group 20 and 21 want each other: the ball rests on the floor',
  );
  const stranger = interactionGroups(1 << 21, 1 << 22);
  assert.ok(drop(Physics, floor, stranger) < 0, 'the ball wants another group: it falls through');
  assert.ok(Math.abs(drop(Physics, floor, undefined) - 0.5) < 0.01, 'a collider left at its default is in every group');
  assert.ok(drop(Physics, interactionGroups(2 ** 31, 2 ** 31), interactionGroups(1, 1)) < 0, 'group 31 is not group 0');
  assert.ok(
    Math.abs(drop(Physics, interactionGroups(2 ** 31, 2 ** 31), interactionGroups(2 ** 31, 2 ** 31)) - 0.5) < 0.01,
  );
});

test('or tests either way, only when both colliders ask for it; a mixed pair tests by and', () => {
  // Floor in group 20 wanting 21; ball in group 22 wanting 20: only the ball's side agrees.
  const base = { memberships: 1 << 20, filter: 1 << 21 };
  const ballSide = { memberships: 1 << 22, filter: 1 << 20 };
  const rest = drop(
    Physics,
    interactionGroups(base.memberships, base.filter, 'or'),
    interactionGroups(ballSide.memberships, ballSide.filter, 'or'),
  );
  assert.ok(Math.abs(rest - 0.5) < 0.01, 'or on both: one agreeing side is enough');
  assert.ok(
    drop(
      Physics,
      interactionGroups(base.memberships, base.filter, 'and'),
      interactionGroups(ballSide.memberships, ballSide.filter, 'and'),
    ) < 0,
    'and on both: it needs both',
  );
  assert.ok(
    drop(
      Physics,
      interactionGroups(base.memberships, base.filter, 'or'),
      interactionGroups(ballSide.memberships, ballSide.filter, 'and'),
    ) < 0,
    'a mixed pair tests by and',
  );
  assert.ok(
    drop(Physics, interactionGroups(1 << 20, 1 << 21, 'or'), interactionGroups(1 << 22, 1 << 23, 'or')) < 0,
    'or with nothing in common fails too',
  );
});

test('solver groups take the same words: the pair is found and fires events but pushes nothing when they do not meet', () => {
  const floor = interactionGroups(1 << 25, 1 << 26),
    ball = interactionGroups(1 << 26, 1 << 27);
  assert.ok(
    drop(Physics, floor, ball, 'solverGroups') < 0,
    'a ball whose solver groups do not meet falls through, as Rapier does',
  );
  assert.ok(Math.abs(drop(Physics, floor, interactionGroups(1 << 26, 1 << 25), 'solverGroups') - 0.5) < 0.01);
});

test('queries take 32-bit groups too, and the packed ones as before', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'sphere', radius: 1, collisionGroups: interactionGroups(1 << 20, 1 << 21) },
  });
  physics.step();
  const ray = (groups) => physics.raycast([-5, 0, 0], [1, 0, 0], { groups });
  assert.ok(ray(interactionGroups(1 << 21, 1 << 20)), 'a query in group 21 wanting group 20 sees it');
  assert.equal(ray(interactionGroups(1 << 22, 1 << 20)), null, 'one in group 22 is not in its filter');
  assert.ok(ray(interactionGroups(1 << 22, 1 << 20, 'or')) === null, 'or needs the collider to ask for it too');
  body.colliders[0].setCollisionGroups(interactionGroups(1 << 20, 1 << 21, 'or'));
  assert.ok(ray(interactionGroups(1 << 22, 1 << 20, 'or')), 'now both ask: one side agrees');
  assert.ok(ray(undefined), 'no groups sees everything');
  body.colliders[0].setCollisionGroups(collisionGroups(1, 2));
  assert.ok(ray(collisionGroups(2, 1)), 'a packed collider and a packed query meet as before');
  assert.equal(ray(collisionGroups(2, 4)), null);
  physics.dispose();
});

test('a collider reads its groups back wide, packed groups read as 16 bits, and bad masks are refused', () => {
  const physics = new Physics(null),
    collider = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } }).colliders[0];
  assert.deepEqual(
    { ...collider.interactionGroups() },
    { memberships: 0xffffffff, filter: 0xffffffff, testMode: 'and' },
    'the default is all of them',
  );
  collider.setCollisionGroups(interactionGroups([0, 17, 31], [5, 20], 'or'));
  const read = collider.interactionGroups();
  assert.equal(read.memberships, ((1 << 0) | (1 << 17) | (1 << 31)) >>> 0);
  assert.equal(read.filter, ((1 << 5) | (1 << 20)) >>> 0);
  assert.equal(read.testMode, 'or');
  assert.equal(
    collider.collisionGroups(),
    (((1 << 0) << 16) | (1 << 5)) >>> 0,
    'the packed word holds the lower 16 bits of each',
  );
  collider.setCollisionGroups(collisionGroups(0x0d, 0x04));
  assert.deepEqual(
    { ...collider.interactionGroups() },
    { memberships: 0x0d, filter: 0x04, testMode: 'and' },
    'a packed number has no upper bits',
  );
  collider.setSolverGroups(interactionGroups(1 << 30, 1 << 29));
  assert.equal(collider.solverInteractionGroups().memberships, 1 << 30);
  assert.throws(() => interactionGroups(2 ** 32, 1), /32-bit mask/);
  assert.throws(() => interactionGroups([32], 1), /0 to 31/);
  assert.throws(() => interactionGroups(1, 1, 'xor'), /'and' or 'or'/);
  physics.dispose();
});
