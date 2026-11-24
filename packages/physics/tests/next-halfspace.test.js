// A half space on the own solver against Rapier's (the root entry as a black box). Closed forms: kernel/tests/halfspace.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const both = (build) => [new Physics(null), new RapierPhysics(null)].map((physics) => ({ physics, ...build(physics) }));

test('bodies rest on a half space, flat and tilted, as on Rapier', () => {
  const worlds = both((physics) => {
    physics.addBody(null, { type: 'fixed', position: [0, 0.5, 0], colliders: { shape: 'halfSpace' } });
    const ball = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'sphere', radius: 0.4 } });
    const crate = physics.addBody(null, {
      position: [3, 4, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
    const capsule = physics.addBody(null, {
      position: [-3, 5, 0],
      rotation: [0, 0, 0.3, 0.954],
      colliders: { shape: 'capsule', halfHeight: 0.5, radius: 0.25 },
    });
    return { ball, crate, capsule };
  });
  for (let i = 0; i < 360; i++) for (const w of worlds) w.physics.step();
  for (const w of worlds) {
    assert.ok(Math.abs(w.ball.position[1] - 0.9) < 0.01, `ball ${w.ball.position[1]}`);
    assert.ok(Math.abs(w.crate.position[1] - 1.0) < 0.01, `crate ${w.crate.position[1]}`);
    assert.ok(Math.abs(w.capsule.position[1] - 0.75) < 0.02, `capsule ${w.capsule.position[1]}`);
  }
  for (const w of worlds) w.physics.dispose();
});

test('rays, casts, projections and overlaps meet a tilted half space where Rapier does', () => {
  const normal = [-0.3, 0.9, 0.2];
  const worlds = both((physics) => {
    physics.addBody(null, { type: 'fixed', position: [1, 2, -1], colliders: { shape: 'halfSpace', normal } });
    physics.step();
    return {};
  });
  const [own, rapier] = [worlds[0].physics, worlds[1].physics];
  const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  for (const [origin, direction] of [
    [
      [0, 9, 0],
      [0, -1, 0],
    ],
    [
      [4, 6, 3],
      [-0.3, -1, -0.2],
    ],
    [
      [0, -4, 0],
      [0.1, 1, 0],
    ],
  ]) {
    const a = own.raycast(origin, direction),
      b = rapier.raycast(origin, direction);
    assert.equal(!!a, !!b);
    if (a) near(a.distance, b.distance);
  }
  const a = own.shapeCast({ shape: 'sphere', radius: 0.5 }, [0, 8, 0], [0, 0, 0, 1], [0, -1, 0]),
    b = rapier.shapeCast({ shape: 'sphere', radius: 0.5 }, [0, 8, 0], [0, 0, 0, 1], [0, -1, 0]);
  near(a.distance, b.distance);
  for (const point of [
    [0, 9, 0],
    [2, -3, 1],
  ]) {
    const pa = own.projectPoint(point, { solid: false }),
      pb = rapier.projectPoint(point, { solid: false });
    near(pa.distance, pb.distance);
    assert.equal(own.intersectPoint(point).length, rapier.intersectPoint(point).length);
  }
  assert.equal(
    own.intersectShape({ shape: 'box', halfExtents: [1, 1, 1] }, [0, 1.5, 0]).length,
    rapier.intersectShape({ shape: 'box', halfExtents: [1, 1, 1] }, [0, 1.5, 0]).length,
  );
  for (const w of worlds) w.physics.dispose();
});

test('a half space refuses a zero normal and a mass', () => {
  const physics = new Physics(null);
  assert.throws(
    () => physics.addBody(null, { type: 'fixed', colliders: { shape: 'halfSpace', normal: [0, 0, 0] } }),
    /nonzero normal/,
  );
  assert.throws(
    () => physics.addBody(null, { type: 'fixed', colliders: { shape: 'halfSpace', mass: 1 } }),
    /no volume/,
  );
  physics.dispose();
});

test('a half space as the query shape casts and overlaps as on Rapier', () => {
  const worlds = both((physics) => {
    physics.addBody(null, {
      type: 'fixed',
      position: [6, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 2, 2] },
    });
    physics.addBody(null, { type: 'fixed', position: [0, 6, 0], colliders: { shape: 'sphere', radius: 1 } });
    physics.addBody(null, {
      type: 'fixed',
      position: [0, 0, 7],
      colliders: { shape: 'capsule', halfHeight: 1, radius: 0.5 },
    });
    physics.step();
    return {};
  });
  let hits = 0;
  for (const [normal, position, rotation, direction] of [
    [
      [1, 0, 0],
      [3, 0, 0],
      [0, 0, 0, 1],
      [1, 0, 0],
    ],
    [
      [1, 0, 0],
      [3, 0, 0],
      [0, 0, 0, 1],
      [-1, 0, 0],
    ],
    [
      [0.6, 0.8, 0],
      [0, 0, 0],
      [0, 0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [0, 2, 0],
      [0, 0, 0.2, 0.98],
      [0, 1, 0.1],
    ],
    [
      [0, 0, 1],
      [0, 0, 2],
      [0, 0, 0, 1],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [0, 0, 0],
      [0, 0, 0, 1],
      [1, 0, 0],
    ],
  ]) {
    const shape = { shape: 'halfSpace', normal },
      [own, rapier] = worlds.map((w) =>
        w.physics.shapeCast(shape, position, rotation, direction, { maxDistance: 100 }),
      );
    assert.equal(!!own, !!rapier, `${normal} at ${position} along ${direction}`);
    if (own) {
      hits++;
      assert.ok(Math.abs(own.distance - rapier.distance) < 5e-3, `${normal}: ${own.distance} vs ${rapier.distance}`);
    }
  }
  assert.ok(hits >= 4, `${hits} casts hit`);
  for (const [normal, position] of [
    [
      [1, 0, 0],
      [5.8, 0, 0],
    ],
    [
      [1, 0, 0],
      [3, 0, 0],
    ],
    [
      [0, -1, 0],
      [0, 5.5, 0],
    ],
    [
      [0, 1, 0],
      [0, 4.5, 0],
    ],
    [
      [0, 0, 1],
      [0, 0, 9],
    ],
  ]) {
    const [own, rapier] = worlds.map((w) => w.physics.intersectShape({ shape: 'halfSpace', normal }, position).length);
    assert.equal(own, rapier, `overlap ${normal} at ${position}`);
  }
  for (const w of worlds) w.physics.dispose();
});
