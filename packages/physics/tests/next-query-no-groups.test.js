// A query with no `groups` applies no group test at all, as Rapier's query filter does, so it sees a collider whose
// filter (or whole group word) is 0; a query that names groups still applies them. Every query kind, own kernel against Rapier.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics, collisionGroups } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const worlds = [new Physics(null, { gravity: [0, 0, 0] }), new RapierPhysics(null, { gravity: [0, 0, 0] })];
const bodies = [];
for (const physics of worlds) {
  // A box with a zero filter and zero memberships: it meets no group, and no group test lets a query see it.
  const silent = physics.addBody(null, {
    type: 'fixed',
    position: [5, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], collisionGroups: 0 },
  });
  // A mesh whose filter is 0 and whose memberships are one group, as a probe mesh.
  const probe = physics.addBody(null, {
    type: 'fixed',
    position: [0, 5, 0],
    colliders: {
      shape: 'trimesh',
      vertices: [-1, 0, -1, 1, 0, -1, 0, 0, 1, 0, 1, 0],
      indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
      collisionGroups: (0x4000 << 16) >>> 0,
    },
  });
  physics.step();
  bodies.push([silent, probe]);
}
const named = collisionGroups([1], [1]);
const kinds = [
  ['ray', (w, o) => w.raycast([0, 0, 0], [1, 0, 0], { maxDistance: 20, ...o }), (r) => !!r],
  ['ray down onto the mesh', (w, o) => w.raycast([0, 0.0, 0.0], [0, 1, 0], { maxDistance: 20, ...o }), (r) => !!r],
  ['ray all', (w, o) => w.raycastAll([0, 0, 0], [1, 0, 0], { maxDistance: 20, ...o }), (r) => r.length],
  [
    'shape cast',
    (w, o) =>
      w.shapeCast({ shape: 'sphere', radius: 0.25 }, [0, 0, 0], [0, 0, 0, 1], [1, 0, 0], { maxDistance: 20, ...o }),
    (r) => !!r,
  ],
  ['project point', (w, o) => w.projectPoint([8, 0, 0], o), (r) => !!r && r.point[0] < 6],
  ['intersect point', (w, o) => w.intersectPoint([5, 0, 0], o), (r) => r.length],
  [
    'intersect shape',
    (w, o) => w.intersectShape({ shape: 'sphere', radius: 0.4 }, [5, 0, 0], undefined, o),
    (r) => r.length,
  ],
  [
    'intersect box',
    (w, o) =>
      w.intersectAabb
        ? w.intersectAabb([4, -1, -1], [6, 1, 1], o)
        : w.intersectShape({ shape: 'box', halfExtents: [1, 1, 1] }, [5, 0, 0], undefined, o),
    (r) => r.length,
  ],
];
for (const [name, query, seen] of kinds) {
  test(`a ${name} query without groups sees a collider whose filter is 0, and with groups does not, as Rapier's`, () => {
    for (const [index, world] of worlds.entries()) {
      const label = index === 0 ? 'own' : 'rapier';
      assert.ok(seen(query(world, {})), `${label}: ${name} without groups`);
      assert.ok(!seen(query(world, { groups: named })), `${label}: ${name} with groups ${named}`);
    }
  });
}

test('containsPoint needs no groups either', () => {
  const collider = bodies[0][0].colliders[0];
  assert.equal(collider.containsPoint({ x: 5, y: 0, z: 0 }), true);
  assert.equal(collider.containsPoint({ x: 9, y: 0, z: 0 }), false);
});
