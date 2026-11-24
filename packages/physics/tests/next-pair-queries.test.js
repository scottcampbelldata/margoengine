// Questions about two colliders: contact manifolds within a prediction, intersection, distance with the nearest points, and
// the tight box of one, against analytic answers and Rapier (the root entry as a black box).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const near = (a, b, tol = 1e-4, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b}`);
const scene = () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const ball = physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: { shape: 'sphere', radius: 1 } })
    .colliders[0];
  const box = physics.addBody(null, {
    type: 'fixed',
    position: [3, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 1, 1] },
  }).colliders[0];
  const far = physics.addBody(null, {
    type: 'fixed',
    position: [0, 10, 0],
    rotation: [0, 0, 0.2, 0.98],
    colliders: { shape: 'capsule', halfHeight: 1, radius: 0.5 },
  }).colliders[0];
  physics.step();
  return { physics, ball, box, far };
};

test('the distance between a ball and a box is the gap, with the nearest points on each', () => {
  const { physics, ball, box } = scene();
  const d = physics.colliderDistance(ball, box);
  near(d.distance, 1.5);
  near(d.pointA[0], 1);
  near(d.pointB[0], 2.5);
  near(physics.colliderDistance(box, ball).pointA[0], 2.5, 1e-4, 'swapped');
  physics.dispose();
});

test('overlapping colliders are 0 apart and intersect, and a gap does not', () => {
  const { physics, ball, box } = scene();
  assert.equal(physics.intersectionPair(ball, box), false);
  physics.addBody(null, {
    type: 'fixed',
    position: [0.5, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  physics.step();
  const overlapping = physics.addBody(null, {
    type: 'fixed',
    position: [1.2, 0, 0],
    colliders: { shape: 'sphere', radius: 0.5 },
  }).colliders[0];
  physics.step();
  assert.equal(physics.intersectionPair(ball, overlapping), true);
  assert.equal(physics.colliderDistance(ball, overlapping).distance, 0);
  physics.dispose();
});

test('a contact pair reports points within the prediction, and none outside it', () => {
  const { physics, ball, box } = scene();
  assert.deepEqual(physics.contactPair(ball, box), []);
  assert.deepEqual(physics.contactPair(ball, box, 1), []);
  const [near15] = physics.contactPair(ball, box, 1.6);
  near(near15.normal[0], 1, 1e-4);
  near(near15.points[0].separation, 1.5);
  near(near15.points[0].pointA[0], 1);
  near(near15.points[0].pointB[0], 2.5);
  const [back] = physics.contactPair(box, ball, 1.6);
  near(back.normal[0], -1, 1e-4);
  physics.dispose();
});

test('a contact pair against a mesh gives a manifold for each triangle near, a compound one for each child pair', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const floor = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: [-2, 0, -2, -2, 0, 2, 2, 0, -2, 2, 0, 2], indices: [0, 1, 2, 2, 1, 3] },
  }).colliders[0];
  const ball = physics.addBody(null, {
    type: 'fixed',
    position: [0.1, 0.45, 0.1],
    colliders: { shape: 'sphere', radius: 0.5 },
  }).colliders[0];
  const pair = physics.addBody(null, {
    type: 'fixed',
    position: [0, 3, 0],
    colliders: {
      shape: 'compound',
      parts: [
        { shape: 'sphere', radius: 0.5, offset: [-1, 0, 0] },
        { shape: 'sphere', radius: 0.5, offset: [1, 0, 0] },
      ],
    },
  }).colliders[0];
  const target = physics.addBody(null, {
    type: 'fixed',
    position: [0, 3, 0],
    colliders: { shape: 'box', halfExtents: [3, 0.5, 0.5] },
  }).colliders[0];
  physics.step();
  const onFloor = physics.contactPair(floor, ball, 0.1);
  assert.ok(onFloor.length >= 1);
  // The ball is over the seam between the two triangles: the one under it gives the face normal, its neighbour an edge's.
  const face = onFloor.find((m) => Math.abs(m.normal[1] - 1) < 1e-3);
  assert.ok(face, JSON.stringify(onFloor.map((m) => m.normal)));
  near(face.points[0].separation, -0.05, 2e-3);
  assert.equal(physics.contactPair(pair, target, 0.1).length, 2);
  assert.equal(physics.contactPair(floor, floor).length, 0, 'a mesh meets no mesh');
  near(physics.colliderDistance(floor, ball).distance, 0);
  physics.dispose();
});

test('a collider reports its tight box, and the box query finds colliders by it', () => {
  const { physics, ball, box, far } = scene();
  const b = ball.aabb();
  assert.deepEqual(
    [b.min, b.max],
    [
      [-1, -1, -1],
      [1, 1, 1],
    ],
  );
  const x = box.aabb();
  assert.deepEqual(
    [x.min, x.max],
    [
      [2.5, -1, -1],
      [3.5, 1, 1],
    ],
  );
  const c = far.aabb();
  assert.ok(c.max[1] > 10.5 && c.min[1] < 9.5);
  assert.equal(physics.intersectAabb([0.9, -5, -5], [2.6, 5, 5]).length, 2, 'the ball and the box');
  assert.equal(physics.intersectAabb([1.1, -5, -5], [2.4, 5, 5]).length, 0, 'the gap between');
  assert.throws(() => physics.intersectAabb([1, 0, 0], [0, 0, 0]), /low at or under high/);
  physics.dispose();
});

test('a removed collider is refused by name', () => {
  const { physics, ball, box } = scene();
  box.body.removeCollider?.(box);
  physics.removeBody(box.body);
  assert.throws(() => physics.contactPair(ball, box), /removed/);
  assert.throws(() => physics.intersectionPair(box, ball), /removed/);
  physics.dispose();
});

test('a swept box holds the collider at both poses, and a collision box is the box grown by the prediction', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    type: 'fixed',
    position: [1, 2, 3],
    colliders: { shape: 'box', halfExtents: [0.5, 0.25, 1], offset: [0.5, 0, 0] },
  });
  physics.step();
  const [collider] = body.colliders,
    here = collider.aabb();
  // The collider stands at (1.5, 2, 3). Moved to (4.5, 2, 3) with no turn the swept box spans both places.
  const swept = collider.sweptAabb([4.5, 2, 3]);
  assert.deepEqual(swept.min, here.min, 'the low corner is where it is');
  assert.ok(
    Math.abs(swept.max[0] - (4.5 + 0.5)) < 1e-6 && swept.max[1] === here.max[1],
    `the high corner is where it goes (${swept.max})`,
  );
  // A quarter turn about z in place: the half extents (0.5, 0.25) trade places, so the box grows along y and shrinks along x.
  const quarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    turned = collider.sweptAabb([1.5, 2, 3], quarter);
  assert.ok(
    Math.abs(turned.max[1] - (2 + 0.5)) < 1e-5 && Math.abs(turned.min[1] - (2 - 0.5)) < 1e-5,
    `grown along y (${turned.min}, ${turned.max})`,
  );
  assert.deepEqual(turned.min[0], Math.min(here.min[0], 1.5 - 0.25), 'and the two boxes merge along x');
  // Nothing moved: the world still holds the collider where it was.
  assert.deepEqual(collider.aabb(), here);
  // The collision box adds the world's prediction distance to the box, which holds the skin already.
  const base = collider.collisionAabb(0);
  assert.deepEqual(base, here, 'no prediction and no skin: the tight box');
  const grown = collider.collisionAabb();
  assert.ok(Math.abs(grown.min[0] - (here.min[0] - physics.kernel.predictionDistance)) < 1e-6);
  collider.setContactSkin(0.1);
  assert.ok(Math.abs(collider.aabb().max[2] - (here.max[2] + 0.1)) < 1e-6, 'the skin thickens the shape');
  assert.ok(
    Math.abs(collider.collisionAabb(0.05).max[2] - (here.max[2] + 0.15)) < 1e-6,
    'and the prediction grows the box again',
  );
  assert.throws(() => collider.collisionAabb(-1), /0 or more/);
  assert.throws(() => collider.sweptAabb([0, 0, Number.NaN]), RangeError);
  assert.throws(() => collider.sweptAabb([0, 0, 0], [0, 0, 0, 2]), /unit quaternion/);
  physics.dispose();
});
