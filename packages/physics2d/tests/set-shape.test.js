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

test('setShape replaces multi-shape outlines in place and preserves settings, mass mode and touching state (C2-09, KB-PHYSICS2D-SETSHAPE1)', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 9.81] });
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.5],
    colliders: { shape: 'box', width: 20, height: 1 },
  });
  const body = physics.addBody(null, {
    position: [0, -0.5],
    colliders: { shape: 'circle', radius: 0.5, density: 2, friction: 0.8 },
  });
  const [collider] = body.colliders;
  collider.setMass(7);
  let starts = 0,
    ends = 0;
  physics.on('contactstart', () => starts++);
  physics.on('contactend', () => ends++);
  run(physics, 30);
  assert.equal(starts, 1, 'initial landing emits one contactstart');
  // Replace convex circle with a concave L-shaped polygon (multiple kernel shapes).
  collider.setShape({
    shape: 'polygon',
    points: [
      [-1, -1],
      [1, -1],
      [1, 0.5],
      [0, 0],
      [-1, 0.5],
    ],
  });
  assert.ok(collider.shapes.length > 1, 'concave polygon splits into multiple kernel shapes');
  assert.ok(Math.abs(body.mass - 7) < 1e-4, `explicit mass preserved across multi-shape setShape: ${body.mass}`);
  // Stepping while still touching the floor does not emit a duplicate contactstart.
  run(physics, 30);
  assert.equal(starts, 1, 'ongoing contact carried across multi-shape setShape');
  assert.equal(ends, 0, 'no spurious contactend while still touching');
  // Swap to a compound collider, then a trimesh, then back to a convex box.
  collider.setShape({
    shape: 'compound',
    shapes: [
      { shape: 'box', width: 0.6, height: 0.6, offset: [-0.4, 0] },
      { shape: 'box', width: 0.6, height: 0.6, offset: [0.4, 0] },
    ],
  });
  assert.equal(collider.shapes.length, 2);
  assert.ok(Math.abs(body.mass - 7) < 1e-4, 'explicit mass holds on compound');
  const floorCol = floor.colliders[0];
  floorCol.setShape({
    shape: 'trimesh',
    vertices: [
      [-10, 0],
      [0, 0],
      [10, 0],
      [-10, 1],
      [0, 1],
      [10, 1],
    ],
    indices: [0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2],
    fixInternalEdges: true,
  });
  assert.equal(floorCol.shapes.length, 4);
  const hit = physics.raycast([0.4, -5], [0, 1], { maxDistance: 10 });
  assert.ok(hit && hit.collider === collider, 'ray hits the compound collider');
  collider.setShape({ shape: 'box', width: 1, height: 1 });
  assert.equal(collider.shapes.length, 1);
  // Removed collider is still refused.
  physics.removeCollider(collider);
  assert.throws(() => collider.setShape({ shape: 'circle', radius: 1 }), /was removed/);
  physics.dispose();
});

test('multi-shape colliders aggregate contact events and contactPair per collider pair (KB-PHYSICS2D-PAIRS1)', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 9.81] });
  const strip = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0],
    colliders: {
      shape: 'trimesh',
      vertices: [
        [-4, 0],
        [0, 0],
        [4, 0],
        [-4, 1],
        [0, 1],
        [4, 1],
      ],
      indices: [0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2],
      fixInternalEdges: true,
      friction: 0,
    },
  });
  const ball = physics.addBody(null, {
    position: [-2, -0.5],
    linearVelocity: [4, 0],
    colliders: { shape: 'circle', radius: 0.5, friction: 0 },
  });
  let starts = 0,
    ends = 0;
  physics.on('contactstart', () => starts++);
  physics.on('contactend', () => ends++);
  // Roll across the seam at x = 0 from the left half of the trimesh to the right half.
  for (let i = 0; i < 60; i++) {
    physics.step();
    if (i >= 5) {
      const pair = physics.contactPair(ball.colliders[0], strip.colliders[0]);
      assert.ok(pair && pair.touching, `step ${i}: contactPair stays touching across piece seam`);
      assert.equal(
        physics.contactPairs(ball.colliders[0]).length,
        1,
        `step ${i}: one aggregated ContactPair2D per collider pair`,
      );
    }
  }
  assert.ok(ball.position[0] > 0.5, `ball crossed the seam to x = ${ball.position[0]}`);
  assert.equal(starts, 1, 'crossing triangles emits only one contactstart');
  assert.equal(ends, 0, 'crossing triangles emits no spurious contactend');
  physics.dispose();
});
