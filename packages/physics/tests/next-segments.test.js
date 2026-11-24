// Segments, triangles and polylines on the own solver: what they touch, hit and hold, against Rapier's (the root entry as a black box).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const both = (build) => [new Physics(null), new RapierPhysics(null)].map((physics) => ({ physics, ...build(physics) }));

test('a segment, a triangle and a polyline refuse a mass and a density', () => {
  const physics = new Physics(null);
  for (const colliders of [
    { shape: 'segment', a: [0, 0, 0], b: [1, 0, 0], mass: 1 },
    { shape: 'triangle', a: [0, 0, 0], b: [1, 0, 0], c: [0, 0, 1], density: 2 },
    { shape: 'polyline', vertices: [0, 0, 0, 1, 0, 0], mass: 1 },
  ])
    assert.throws(() => physics.addBody(null, { type: 'fixed', colliders }), /no volume/);
  assert.throws(
    () => physics.addBody(null, { type: 'fixed', colliders: { shape: 'segment', a: [1, 1, 1], b: [1, 1, 1] } }),
    /two different points/,
  );
  physics.dispose();
});

test('a ball dropped on a turned segment rests on it, as on Rapier', () => {
  const rests = both((physics) => {
    // A 2 m bar along x, turned a quarter about y by the collider's own rotation (so it lies along z), 0.1 m up.
    physics.addBody(null, {
      type: 'fixed',
      position: [0.5, 0, 0.25],
      colliders: {
        shape: 'segment',
        a: [-1, 0, 0],
        b: [1, 0, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        offset: [0, 0.1, 0],
      },
    });
    const ball = physics.addBody(null, { position: [0.5, 1, 0.25], colliders: { shape: 'sphere', radius: 0.2 } });
    return { ball };
  });
  for (let i = 0; i < 240; i++) for (const r of rests) r.physics.step();
  const [own, rapier] = rests;
  // Both sit on the line at the radius above it.
  assert.ok(
    Math.abs(own.ball.position[1] - rapier.ball.position[1]) < 0.02,
    `${own.ball.position} vs ${rapier.ball.position}`,
  );
  assert.ok(Math.abs(own.ball.position[1] - 0.3) < 0.01, `rests ${own.ball.position[1]}`);
  for (const r of rests) r.physics.dispose();
});

test('a ball dropped on a triangle rests on it, and a ray hits it from both sides, as on Rapier', () => {
  const rests = both((physics) => {
    physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'triangle', a: [-2, 0, -2], b: [-2, 0, 2], c: [3, 0, 0] },
    });
    const ball = physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'sphere', radius: 0.25 } });
    return { ball };
  });
  for (let i = 0; i < 240; i++) for (const r of rests) r.physics.step();
  for (const r of rests) assert.ok(Math.abs(r.ball.position[1] - 0.25) < 0.01, `${r.ball.position}`);
  for (const r of rests) {
    r.physics.step();
    const down = r.physics.raycast([-1, 5, 0.5], [0, -1, 0]),
      up = r.physics.raycast([-1, -5, 0.5], [0, 1, 0]);
    assert.ok(Math.abs(down.distance - 5) < 1e-5 && Math.abs(up.distance - 5) < 1e-5);
    r.physics.dispose();
  }
});

test('a ball rolls along a polyline of two segments and stops in its corner, as on Rapier', () => {
  const rests = both((physics) => {
    // A V along x seen from the front: a corner at the origin, rising 45 degrees either way, long in z.
    physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'polyline', vertices: [-2, 2, 0, 0, 0, 0, 2, 2, 0] },
    });
    const ball = physics.addBody(null, {
      position: [-1, 3, 0],
      colliders: { shape: 'sphere', radius: 0.2 },
      linearDamping: 0.5,
    });
    return { ball };
  });
  for (let i = 0; i < 600; i++) for (const r of rests) r.physics.step();
  for (const r of rests) {
    // In the corner of a V of 45 degrees: the ball's centre sits at radius / cos(45) above the corner.
    assert.ok(Math.abs(r.ball.position[0]) < 0.05, `x ${r.ball.position[0]}`);
    assert.ok(Math.abs(r.ball.position[1] - 0.2 * Math.SQRT2) < 0.03, `y ${r.ball.position[1]}`);
    r.physics.dispose();
  }
});
