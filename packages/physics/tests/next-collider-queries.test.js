// Queries against one collider (Rapier's collider.castRay, projectPoint, containsPoint, castShape, intersectsShape): the
// answers are the world query's, limited to that collider, and a query sees a pose written by hand at once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const near = (a, b, tol = 1e-4, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b}`);
const world = () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const front = physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: { shape: 'sphere', radius: 1 } });
  const back = physics.addBody(null, { type: 'fixed', position: [5, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 1, 1] } });
  physics.step();
  return { physics, front: front.colliders[0], back: back.colliders[0], backBody: back };
};

test('a ray against one collider ignores what is in front of it', () => {
  const { physics, front, back } = world();
  const world_ = physics.raycast([-5, 0, 0], [1, 0, 0]);
  near(world_.distance, 4);
  near(physics.raycastCollider(back, [-5, 0, 0], [1, 0, 0]).distance, 9.5);
  near(physics.raycastCollider(front, [-5, 0, 0], [1, 0, 0]).distance, 4);
  assert.equal(physics.raycastCollider(back, [-5, 0, 0], [-1, 0, 0]), null);
  assert.equal(physics.raycastCollider(back, [-5, 0, 0], [1, 0, 0], { maxDistance: 5 }), null);
  physics.dispose();
});

test('a point projects onto one collider, and containsPoint says inside', () => {
  const { physics, front, back } = world();
  const p = physics.projectPointOnCollider(back, [3, 0.5, 0]);
  near(p.point[0], 4.5);
  near(p.distance, Math.hypot(1.5, 0));
  assert.equal(physics.colliderContainsPoint(front, [0.5, 0, 0]), true);
  assert.equal(physics.colliderContainsPoint(front, [2, 0, 0]), false);
  assert.equal(physics.colliderContainsPoint(back, [5, 0.2, 0.2]), true);
  const inside = physics.projectPointOnCollider(front, [0.5, 0, 0]);
  assert.equal(inside.inside, true);
  assert.equal(inside.distance, 0);
  physics.dispose();
});

test('a shape cast and an overlap test against one collider', () => {
  const { physics, front, back } = world();
  const hit = physics.castShapeAtCollider(back, { shape: 'sphere', radius: 0.5 }, [0, 0, 0], [0, 0, 0, 1], [1, 0, 0]);
  near(hit.distance, 4);
  assert.equal(hit.collider, back);
  assert.equal(physics.castShapeAtCollider(back, { shape: 'sphere', radius: 0.5 }, [0, 5, 0], [0, 0, 0, 1], [1, 0, 0]), null);
  assert.equal(physics.colliderIntersectsShape(front, { shape: 'box', halfExtents: [0.5, 0.5, 0.5] }, [1.2, 0, 0]), true);
  assert.equal(physics.colliderIntersectsShape(front, { shape: 'box', halfExtents: [0.5, 0.5, 0.5] }, [3, 0, 0]), false);
  physics.dispose();
});

test('a query sees a pose written by hand without a step', () => {
  const { physics, backBody, back } = world();
  backBody.setPosition([5, 10, 0]);
  assert.equal(physics.raycastCollider(back, [5, 20, 0], [0, -1, 0]).distance > 8, true);
  assert.equal(physics.raycast([5, 20, 0], [0, -1, 0]).collider, back);
  physics.dispose();
});

test('a removed collider is refused', () => {
  const { physics, back, backBody } = world();
  physics.removeBody(backBody);
  assert.throws(() => physics.raycastCollider(back, [0, 0, 0], [1, 0, 0]), /removed/);
  physics.dispose();
});
