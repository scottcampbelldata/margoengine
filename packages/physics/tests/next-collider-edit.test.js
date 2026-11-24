// A collider edited after it was made: its pose in the body's frame, and its whole shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

test('moving a collider in its body moves the centre of mass and the contact', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [20, 0.5, 20] } });
  const body = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'sphere', radius: 0.5, density: 1 } });
  const [ball] = body.colliders;
  ball.setTranslationWrtParent([0, 1, 0]);
  assert.deepEqual(Object.values(ball.translationWrtParent()), [0, 1, 0]);
  for (let i = 0; i < 240; i++) physics.step();
  // The ball is a metre above the body's origin now, so the origin rests a metre below the ball's resting height.
  assert.ok(Math.abs(body.position[1] - (0.5 - 1)) < 0.02, `${body.position[1]}`);
  assert.throws(() => ball.setRotationWrtParent([0, 0, 0, 2]), /unit quaternion/);
  physics.dispose();
});

test('a collider takes another shape and the mass follows', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [20, 0.5, 20] } });
  const body = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'sphere', radius: 0.5, density: 1000 } });
  const [piece] = body.colliders;
  const sphere = body.mass;
  piece.setShape({ shape: 'box', halfExtents: [0.5, 0.25, 0.5] });
  assert.equal(piece.shape, 'box');
  assert.ok(Math.abs(body.mass - 1000 * 0.5) < 1e-3, `${body.mass} was ${sphere}`);
  assert.deepEqual(Object.values(piece.halfExtents()), [0.5, 0.25, 0.5]);
  for (let i = 0; i < 240; i++) physics.step();
  assert.ok(Math.abs(body.position[1] - 0.25) < 0.01, `rests on its new shape ${body.position[1]}`);
  piece.setShape({ shape: 'capsule', halfHeight: 0.5, radius: 0.25, offset: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
  assert.equal(piece.shape, 'capsule');
  for (let i = 0; i < 240; i++) physics.step();
  assert.ok(Math.abs(body.position[1] - 0.25) < 0.02, `lies on its side ${body.position[1]}`);
  physics.dispose();
});

test('a shape change keeps friction and groups, and a compound cannot be made or changed', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 1, 1], friction: 0.9, collisionGroups: 0x00020002 } });
  const [piece] = body.colliders;
  piece.setShape({ shape: 'sphere', radius: 1 });
  assert.ok(Math.abs(piece.friction() - 0.9) < 1e-6);
  assert.equal(piece.collisionGroups(), 0x00020002);
  assert.throws(() => piece.setShape({ shape: 'compound', parts: [{ shape: 'sphere', radius: 1 }] }), /compound/);
  const compound = physics.addBody(null, { colliders: { shape: 'compound', parts: [{ shape: 'sphere', radius: 1 }] } }).colliders[0];
  assert.throws(() => compound.setShape({ shape: 'sphere', radius: 1 }), /compound/);
  piece.setShape({ shape: 'halfSpace' });
  assert.equal(piece.shape, 'halfSpace');
  body.removeCollider(piece);
  assert.throws(() => piece.setShape({ shape: 'sphere', radius: 1 }), /removed/);
  physics.dispose();
});
