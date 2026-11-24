// A box or convex hull with a borderRadius on the own solver, against Rapier's round cuboid and round convex hull (the root
// entry as a black box). Closed forms are proved in kernel/tests/round_polyhedra.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const both = (build) => [new Physics(null), new RapierPhysics(null)].map((physics) => ({ physics, ...build(physics) }));
const cube = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];

test('rays, point projection and casts meet a round box and a round hull where Rapier does', () => {
  const worlds = both((physics) => {
    physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: { shape: 'box', halfExtents: [1, 0.5, 0.75], borderRadius: 0.25 } });
    physics.addBody(null, { type: 'fixed', position: [6, 0, 0], colliders: { shape: 'convexHull', points: cube, borderRadius: 0.3 } });
    physics.step();
    return {};
  });
  const diagonal = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), -1 / Math.sqrt(3)];
  for (const [origin, direction] of [
    [[-5, 0.1, 0.2], [1, 0, 0]],
    [[5, 5, 5], diagonal],
    [[11, 5, 5], [-0.6, -0.5, -0.5]],
    [[6, 6, 0.3], [0, -1, 0]],
  ]) {
    const [own, rapier] = worlds.map((w) => w.physics.raycast(origin, direction));
    assert.equal(!!own, !!rapier);
    if (!own) continue;
    assert.ok(Math.abs(own.distance - rapier.distance) < 1e-3, `${own.distance} vs ${rapier.distance}`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(own.normal[k] - rapier.normal[k]) < 2e-2, `${own.normal} vs ${rapier.normal}`);
  }
  for (const point of [[2, 0, 0], [1.1, 0.6, 0.9], [8, 1.5, 0], [0.2, 0.1, 0.1]]) {
    const [own, rapier] = worlds.map((w) => w.physics.projectPoint(point, { solid: false }));
    assert.ok(Math.abs(own.distance - rapier.distance) < 1e-3, `${point}: ${own.distance} vs ${rapier.distance}`);
    // Rapier's projection onto a round hull is iterative and lands within 1e-2 of the exact point; ours is closed form.
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(own.point[k] - rapier.point[k]) < 1e-2, `${point}: ${own.point} vs ${rapier.point}`);
  }
  // Exact: the core's nearest point (7, 1, 0) to (8, 1.5, 0), then 0.3 further along the way to the point.
  const [exact] = worlds.map((w) => w.physics.projectPoint([8, 1.5, 0], { solid: false }));
  const way = Math.hypot(1, 0.5);
  assert.ok(Math.abs(exact.point[0] - (7 + (0.3 * 1) / way)) < 1e-4 && Math.abs(exact.point[1] - (1 + (0.3 * 0.5) / way)) < 1e-4);
  const casts = worlds.map((w) => w.physics.shapeCast({ shape: 'sphere', radius: 0.2 }, [-4, 0.3, 0.1], [0, 0, 0, 1], [1, 0, 0]));
  assert.ok(Math.abs(casts[0].distance - casts[1].distance) < 1e-3, `${casts[0].distance} vs ${casts[1].distance}`);
  for (const w of worlds) w.physics.dispose();
});

test('a round box rests a border above where a sharp one does, as on Rapier', () => {
  const worlds = both((physics) => {
    physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
    const crate = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], borderRadius: 0.1 } });
    return { crate };
  });
  for (let i = 0; i < 300; i++) for (const w of worlds) w.physics.step();
  for (const w of worlds) assert.ok(Math.abs(w.crate.position[1] - 0.6) < 0.01, `${w.crate.position[1]}`);
  for (const w of worlds) w.physics.dispose();
});

test('a border is refused when negative', () => {
  const physics = new Physics(null);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 1, 1], borderRadius: -1 } }), /borderRadius/);
  physics.dispose();
});

test('a convex hull from a mesh is the hull of the vertices its triangles use, as on Rapier', () => {
  // A cube with a stray vertex no triangle uses, far away: it must not stretch the hull.
  const vertices = [...cube, 50, 50, 50],
    indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const worlds = both((physics) => {
    physics.addBody(null, { type: 'fixed', colliders: { shape: 'convexHull', vertices: vertices.slice(), indices } });
    physics.step();
    return {};
  });
  const [own, rapier] = worlds.map((w) => w.physics.raycast([-9, 0.2, 0.1], [1, 0, 0]));
  assert.ok(Math.abs(own.distance - 8) < 1e-4 && Math.abs(rapier.distance - 8) < 1e-4, `${own.distance} ${rapier.distance}`);
  assert.throws(() => new Physics(null).addBody(null, { colliders: { shape: 'convexHull', vertices, indices: [0, 1, 99] } }), /out of range/);
  for (const w of worlds) w.physics.dispose();
});

test('a round triangle meets rays, projections, casts and a falling ball where Rapier does', () => {
  const worlds = both((physics) => {
    physics.addBody(null, { type: 'fixed', colliders: { shape: 'triangle', a: [-2, 0, -2], b: [-2, 0, 2], c: [3, 0, 0], borderRadius: 0.3 } });
    const ball = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.25 } });
    physics.step();
    return { ball };
  });
  const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);
  for (const [origin, direction] of [[[0, 5, 0.1], [0, -1, 0]], [[-6, 0.1, 0], [1, 0, 0]], [[3.5, 3, 0], [-0.2, -1, 0]]]) {
    const [own, rapier] = worlds.map((w) => w.physics.raycast(origin, direction, { predicate: (body) => body !== w.ball }));
    assert.equal(!!own, !!rapier);
    if (own) near(own.distance, rapier.distance, 2e-3, `ray ${origin}`);
  }
  for (const point of [[0, 0.2, 0], [4, 0.1, 0], [-2.1, 0.4, 1]]) {
    const [own, rapier] = worlds.map((w) => w.physics.projectPoint(point, { solid: false, predicate: (body) => body !== w.ball }));
    near(own.distance, rapier.distance, 5e-3, `distance ${point}`);
  }
  for (const w of worlds) w.physics.dispose();
  const rests = both((physics) => {
    physics.addBody(null, { type: 'fixed', colliders: { shape: 'triangle', a: [-4, 0, -4], b: [-4, 0, 4], c: [4, 0, 0], borderRadius: 0.3 } });
    const ball = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.25 } });
    return { ball };
  });
  for (let i = 0; i < 240; i++) for (const w of rests) w.physics.step();
  for (const w of rests) near(w.ball.position[1], 0.55, 0.01, 'rests a border and a radius above');
  for (const w of rests) w.physics.dispose();
});

test('a compound with round box and hull parts meets rays and a falling ball where Rapier does', () => {
  const worlds = both((physics) => {
    physics.addBody(null, {
      type: 'fixed',
      colliders: {
        shape: 'compound',
        parts: [
          { shape: 'box', halfExtents: [0.5, 0.5, 0.5], borderRadius: 0.2, offset: [-2, 0, 0] },
          { shape: 'convexHull', points: cube, borderRadius: 0.3, offset: [2, 0, 0] },
          { shape: 'sphere', radius: 0.4, offset: [0, 3, 0] },
        ],
      },
    });
    const ball = physics.addBody(null, { position: [-2, 3, 0], colliders: { shape: 'sphere', radius: 0.25 } });
    physics.step();
    return { ball };
  });
  for (const [origin, direction] of [[[-6, 0.1, 0.1], [1, 0, 0]], [[6, 0.2, 0], [-1, 0, 0]], [[-2, 5, 0.1], [0, -1, 0]]]) {
    const [own, rapier] = worlds.map((w) => w.physics.raycast(origin, direction, { predicate: (body) => body !== w.ball }));
    assert.ok(own && rapier, `${origin}`);
    assert.ok(Math.abs(own.distance - rapier.distance) < 2e-3, `${origin}: ${own.distance} vs ${rapier.distance}`);
  }
  for (let i = 0; i < 180; i++) for (const w of worlds) w.physics.step();
  // The ball lands on the round box's top: 0.5 + 0.2 + 0.25.
  for (const w of worlds) assert.ok(Math.abs(w.ball.position[1] - 0.95) < 0.015, `${w.ball.position[1]}`);
  assert.throws(
    () => new Physics(null).addBody(null, { colliders: { shape: 'compound', parts: [{ shape: 'box', halfExtents: [1, 1, 1], borderRadius: -1 }] } }),
    /borderRadius/,
  );
  for (const w of worlds) w.physics.dispose();
});
