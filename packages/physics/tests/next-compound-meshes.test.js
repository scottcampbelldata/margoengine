// A compound with a mesh, height field or voxel grid among its parts. Rapier's JavaScript fails on such a compound (checked:
// its `ColliderDesc.compound` aborts inside the Wasm), so each answer is compared with the same parts as colliders of their
// own, which the other tests hold to Rapier.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const ground = { shape: 'trimesh', vertices: [-5, 0, -5, -5, 0, 5, 5, 0, -5, 5, 0, 5], indices: [0, 1, 2, 2, 1, 3] };
const field = { shape: 'heightfield', rows: 2, columns: 2, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0], scale: [10, 1, 10] };
const wall = { shape: 'box', halfExtents: [0.1, 1, 5] };
const parts = [
  [ground, [0, 0, 0]],
  [wall, [5.1, 1, 0]],
  [field, [12, 0, 0]],
];

/** One world with the parts as one compound, one with them as bodies of their own. */
const worlds = (extra) => {
  const joined = new Physics(null),
    apart = new Physics(null);
  joined.addBody(null, { type: 'fixed', colliders: { shape: 'compound', parts: parts.map(([part, offset]) => ({ ...part, offset })) } });
  for (const [part, offset] of parts) apart.addBody(null, { type: 'fixed', position: offset, colliders: part });
  return [joined, apart].map((physics) => ({ physics, ...extra(physics) }));
};

test('balls and boxes rest on, and stop at, the mesh, wall and height field of one compound as they do on parts of their own', () => {
  const pair = worlds((physics) => ({
    a: physics.addBody(null, { position: [0.2, 2, 0.1], colliders: { shape: 'sphere', radius: 0.4 } }),
    b: physics.addBody(null, { position: [12.3, 3, 0.2], colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] } }),
    c: physics.addBody(null, { position: [4, 1, 0], linearVelocity: [6, 0, 0], colliders: { shape: 'sphere', radius: 0.3 } }),
  }));
  for (let i = 0; i < 300; i++) for (const w of pair) w.physics.step();
  for (const w of pair) {
    assert.ok(Math.abs(w.a.position[1] - 0.4) < 0.01, `ball on the mesh ${w.a.position[1]}`);
    assert.ok(Math.abs(w.b.position[1] - 0.3) < 0.01, `box on the height field ${w.b.position[1]}`);
    assert.ok(w.c.position[0] < 5, `stopped by the wall box ${w.c.position[0]}`);
  }
  for (const w of pair) w.physics.dispose();
});

test('rays, projections and overlaps meet the mesh parts of a compound where the parts alone do', () => {
  const pair = worlds(() => ({}));
  for (const w of pair) w.physics.step();
  for (const [origin, direction] of [[[1, 8, 1], [0, -1, 0]], [[-9, 0.4, 0.2], [1, 0, 0]], [[13, 8, 1], [0, -1, 0]], [[12, 2, -9], [0, -0.2, 1]]]) {
    const [joined, apart] = pair.map((w) => w.physics.raycast(origin, direction));
    assert.ok(joined && apart, `${origin}`);
    assert.ok(Math.abs(joined.distance - apart.distance) < 1e-4, `${origin}: ${joined.distance} vs ${apart.distance}`);
  }
  const [joined, apart] = pair.map((w) => w.physics.intersectShape({ shape: 'sphere', radius: 0.3 }, [1, 0.2, 1]).length);
  assert.equal(joined, apart);
  assert.equal(joined, 1);
  assert.equal(pair[0].physics.intersectShape({ shape: 'sphere', radius: 0.3 }, [1, 2, 1]).length, 0);
  for (const w of pair) w.physics.dispose();
});

test('a compound with a mesh part carries a compound that rests on it, and a mesh meets no mesh', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'compound', parts: [{ ...ground }, { shape: 'box', halfExtents: [0.1, 1, 5], offset: [5.1, 1, 0] }] } });
  const crate = physics.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'compound', parts: [{ shape: 'box', halfExtents: [0.3, 0.3, 0.3] }, { shape: 'sphere', radius: 0.2, offset: [0.6, -0.1, 0] }] },
  });
  // A plain mesh through the same place: the mesh of the compound meets the compound's parts, and not this mesh.
  physics.addBody(null, { type: 'fixed', position: [0, -3, 0], colliders: { ...ground } });
  for (let i = 0; i < 300; i++) physics.step();
  // The box part's base on the mesh (0.3) and the ball's lowest point (-0.1 - 0.2 = -0.3 below the body origin) both meet it: the
  // body rests with the lower of the two on the floor.
  assert.ok(Math.abs(crate.position[1] - 0.3) < 0.02, `rests on the mesh part ${crate.position[1]}`);
  const other = new Physics(null);
  other.addBody(null, { type: 'fixed', colliders: { shape: 'compound', parts: [{ ...ground }] } });
  const passing = other.addBody(null, { type: 'fixed', position: [0, 0.2, 0], colliders: { shape: 'compound', parts: [{ ...ground }] } });
  other.step();
  assert.equal(other.contactPoints(passing).length, 0, 'two meshes meet nothing');
  physics.dispose();
  other.dispose();
});

test('a half space is a part of a compound: an endless floor beside a box', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'compound', parts: [{ shape: 'halfSpace' }, { shape: 'box', halfExtents: [1, 1, 1], offset: [10, 1, 0] }] } });
  const ball = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'sphere', radius: 0.4 } });
  const onBox = physics.addBody(null, { position: [10, 4, 0], colliders: { shape: 'sphere', radius: 0.4 } });
  for (let i = 0; i < 300; i++) physics.step();
  assert.ok(Math.abs(ball.position[1] - 0.4) < 0.01, `on the plane ${ball.position[1]}`);
  assert.ok(Math.abs(onBox.position[1] - 2.4) < 0.01, `on the box ${onBox.position[1]}`);
  assert.equal(physics.raycast([100, 5, 7], [0, -1, 0]).distance, 5);
  physics.dispose();
});

test('a custom shape cannot be a part, and Rapier says so for a mesh part instead of aborting', () => {
  const physics = new Physics(null);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'compound', parts: [{ shape: 'custom', desc: {} }] } }), /cannot be a part/);
  physics.dispose();
  const rapier = new RapierPhysics(null);
  assert.throws(() => rapier.addBody(null, { colliders: { shape: 'compound', parts: [{ ...ground }] } }), /own solver/);
  rapier.dispose();
});
