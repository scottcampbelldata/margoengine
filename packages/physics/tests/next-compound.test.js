// Compound colliders on the own solver, held to what Rapier (the root entry, as a black box) gives the same compound: its
// mass, centre and inertia, where it rests, one collider with one contact pair, and the same refusals. The contact
// mechanics are proved in kernel/tests/compound.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

await Promise.all([Physics.load(), RapierPhysics.load()]);

const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} against ${expected}`);

/** A dumbbell: two balls on a bar along X, a box and a hull part, offset and turned, so every part kind is in it. */
const parts = [
  { shape: 'sphere', radius: 0.5, offset: [-1, 0, 0] },
  { shape: 'sphere', radius: 0.5, offset: [1, 0, 0] },
  { shape: 'capsule', halfHeight: 0.5, radius: 0.1, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
  { shape: 'box', halfExtents: [0.1, 0.2, 0.3], offset: [0, 0.3, 0.1], rotation: [0.2, 0.1, 0, Math.sqrt(1 - 0.05)] },
  { shape: 'convexHull', points: [0, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.4, 0.3, 0.3, 0.3], offset: [0, -0.2, -0.3] },
];

function drop(PhysicsClass, colliders, steps = 240) {
  const physics = new PhysicsClass(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
  const body = physics.addBody(null, { position: [0, 3, 0], colliders }),
    events = [];
  physics.on('contactstart', (event) => events.push(event));
  for (let i = 0; i < steps; i++) PhysicsClass === Physics ? physics.step() : physics.update(1 / 60);
  return { physics, body, events };
}

test('a compound weighs what Rapier says it weighs, with its centre where Rapier puts it', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null),
    options = { position: [0, 3, 0], colliders: { shape: 'compound', density: 2, parts } },
    a = own.addBody(null, options),
    b = rapier.addBody(null, options);
  near(a.mass, b.mass, 1e-5 * b.mass, 'mass');
  for (let k = 0; k < 3; k++) near(a.centerOfMass[k], b.centerOfMass[k], 1e-5, `centre ${k}`);
  // Mass given: density follows from the parts' volume, as Rapier's does.
  const c = own.addBody(null, { colliders: { shape: 'compound', mass: 3, parts } }),
    d = rapier.addBody(null, { colliders: { shape: 'compound', mass: 3, parts } });
  near(c.mass, 3, 1e-5, 'own mass from option');
  near(d.mass, 3, 1e-5, 'Rapier mass from option');
  own.dispose();
  rapier.dispose();
});

test('the inertia of a compound is the inertia of its parts as colliders of their own, as Rapier adds them', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null),
    welded = own.addBody(null, { colliders: { shape: 'compound', parts } }),
    apart = own.addBody(null, {
      colliders: parts.map(({ offset, rotation, ...shape }) => ({ ...shape, offset, rotation })),
    }),
    reference = rapier.addBody(null, { colliders: { shape: 'compound', parts } }),
    { inertiaX, inertiaY, inertiaZ } = own.kernel.columns,
    moments = (row) => [inertiaX[row], inertiaY[row], inertiaZ[row]].sort((x, y) => x - y),
    ours = moments(welded.row),
    theirs = [...reference.principalInertia].sort((x, y) => x - y);
  assert.deepEqual(ours, moments(apart.row), 'the same numbers, bit for bit, as separate colliders');
  for (let k = 0; k < 3; k++) near(ours[k], theirs[k], 1e-4 * theirs[2], `principal moment ${k}`);
  own.dispose();
  rapier.dispose();
});

test('a dumbbell rests on its two balls where Rapier rests it, as one collider with one contact pair', () => {
  const dumbbell = {
      shape: 'compound',
      parts: [
        { shape: 'sphere', radius: 0.5, offset: [-1, 0, 0] },
        { shape: 'sphere', radius: 0.5, offset: [1, 0, 0] },
        { shape: 'capsule', halfHeight: 0.5, radius: 0.1, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      ],
    },
    own = drop(Physics, dumbbell),
    rapier = drop(RapierPhysics, dumbbell);
  assert.equal(own.body.colliders.length, 1, 'one collider');
  assert.equal(own.events.length, 1, 'one contact pair for the whole compound');
  assert.equal(rapier.events.length, 1);
  assert.equal(own.events[0].colliderA === own.body.colliders[0] || own.events[0].colliderB === own.body.colliders[0], true);
  for (let k = 0; k < 3; k++) near(own.body.position[k], rapier.body.position[k], 0.01, `rest ${k}`);
  near(own.body.position[1], 0.5, 0.01, 'on its balls');
  own.physics.dispose();
  rapier.physics.dispose();
});

test('a compound refuses what Rapier refuses, with a fix in the message', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, {});
  assert.throws(() => body.addCollider({ shape: 'compound', parts: [] }), RangeError);
  assert.throws(() => body.addCollider({ shape: 'compound', parts: [{ shape: 'trimesh', vertices: [], indices: [] }] }), /not convex/);
  assert.throws(() => body.addCollider({ shape: 'compound', parts: [{ shape: 'box' }] }), /halfExtents/);
  assert.throws(() => body.addCollider({ shape: 'compound', parts: [{ shape: 'sphere' }] }), /radius/);
  assert.throws(() => body.addCollider({ shape: 'compound', parts: [{ shape: 'convexHull' }] }), /points/);
  assert.throws(() => body.addCollider({ shape: 'compound', parts: [{ shape: 'box', halfExtents: [1, 1, 1], offset: [0, NaN, 0] }] }), /offset/);
  assert.equal(body.colliders.length, 0, 'a refused compound leaves nothing behind');
  assert.ok(physics.supportsShape('compound'));
  physics.dispose();
});

test('removing a compound takes its parts with it, and the body falls through where it stood', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
  const shelf = physics.addBody(null, {
      type: 'fixed',
      position: [0, 2, 0],
      colliders: { shape: 'compound', parts: [{ shape: 'box', halfExtents: [1, 0.1, 1] }, { shape: 'box', halfExtents: [0.1, 1, 0.1], offset: [0, -1, 0] }] },
    }),
    ball = physics.addBody(null, { position: [0.5, 3, 0.5], colliders: { shape: 'sphere', radius: 0.2 } });
  for (let i = 0; i < 120; i++) physics.step();
  near(ball.position[1], 2.3, 0.01, 'rests on the shelf');
  shelf.removeCollider(shelf.colliders[0]);
  for (let i = 0; i < 120; i++) physics.step();
  near(ball.position[1], 0.2, 0.01, 'falls to the floor once the compound is gone');
  physics.dispose();
});

test('a compound and a hull have no bounding radius to read, as on the Rapier entry', () => {
  const own = new Physics(null),
    rapier = new RapierPhysics(null);
  for (const colliders of [{ shape: 'compound', parts }, { shape: 'convexHull', points: parts[4].points }]) {
    const a = own.addBody(null, { colliders }).colliders[0],
      b = rapier.addBody(null, { colliders }).colliders[0];
    assert.equal(a.boundingRadius, null, colliders.shape);
    assert.equal(b.boundingRadius, null, colliders.shape);
  }
  own.dispose();
  rapier.dispose();
});
