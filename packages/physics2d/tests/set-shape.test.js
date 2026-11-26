// A collider's outline changed after it is made (C2-09, Rapier's `setShape`): the body rests on the new outline, its
// mass follows the new area at the collider's density, a ray meets the new outline, and outlines of several kernel
// shapes or a removed collider are refused, naming the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
  physics.sync(1);
};

test('setShape turns a box into a circle: it rests on its radius, with the circle mass, and rays meet the circle', () => {
  // One unit is one metre here; y grows downward (the screen's), so the floor's top is at y 0 and a body above it at -y.
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 9.81] });
  physics.addBody(null, { type: 'fixed', position: [0, 0.5], colliders: { shape: 'box', width: 20, height: 1 } });
  const sprite = { x: 0, y: -0.25, rotation: 0 },
    body = physics.addBody(sprite, { colliders: { shape: 'box', width: 0.5, height: 0.5, density: 2 } }),
    [collider] = body.colliders;
  run(physics, 60);
  assert.ok(Math.abs(sprite.y + 0.25) < 0.02, `the box rests on its half height, y ${sprite.y}`);
  collider.setShape({ shape: 'circle', radius: 0.6 });
  const mass = 2 * Math.PI * 0.36;
  assert.ok(Math.abs(body.mass - mass) < 1e-4 * mass, `mass ${body.mass} against ${mass}`);
  run(physics, 120);
  assert.ok(Math.abs(sprite.y + 0.6) < 0.02, `the circle rests on its radius, y ${sprite.y}`);
  const hit = physics.raycast([-3, -0.6], [1, 0], { maxDistance: 10 });
  assert.ok(hit && hit.collider === collider, 'the ray meets the circle');
  assert.ok(Math.abs(hit.distance - 2.4) < 1e-3, `distance ${hit.distance}`);
  physics.dispose();
});

test('setShape refuses an outline of several shapes and a removed collider, naming the fix', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1 });
  const body = physics.addBody(null, { colliders: { shape: 'circle', radius: 0.5 } }),
    [collider] = body.colliders;
  assert.throws(
    () =>
      collider.setShape({
        shape: 'polygon',
        points: [
          [0, 0],
          [2, 0],
          [2, 2],
          [1, 0.5],
          [0, 2],
        ],
      }),
    /remove this collider and add a new one/,
  );
  physics.removeCollider(collider);
  assert.throws(() => collider.setShape({ shape: 'circle', radius: 1 }), /was removed/);
  physics.dispose();
});
