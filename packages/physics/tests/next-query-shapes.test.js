// Shape casts and overlaps with a segment, a triangle and a round box or hull as the query shape, against Rapier (the root
// entry as a black box).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const worlds = [new Physics(null, { gravity: [0, 0, 0] }), new RapierPhysics(null, { gravity: [0, 0, 0] })];
for (const physics of worlds) {
  physics.addBody(null, { type: 'fixed', position: [6, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 2, 2] } });
  physics.addBody(null, { type: 'fixed', position: [0, 0, 8], colliders: { shape: 'sphere', radius: 1.5 } });
  physics.addBody(null, { type: 'fixed', position: [0, 6, 0], colliders: { shape: 'capsule', halfHeight: 1, radius: 0.5 } });
  physics.step();
}
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 2e-3, `${label}: ${a} vs ${b}`);

const casts = [
  ['segment', { shape: 'segment', a: [0, -1, 0], b: [0, 1, 0.5] }, [0, 0, 0], [0.2, 0.1, 0.3, 0.927], [1, 0, 0]],
  ['segment aimed at the sphere', { shape: 'segment', a: [-0.5, 0, 0], b: [0.5, 0, 0] }, [0, 0, 0], [0, 0, 0, 1], [0, 0, 1]],
  ['triangle', { shape: 'triangle', a: [0, -1, -1], b: [0, 1, -1], c: [0, 0, 1.5] }, [0, 0, 0], [0, 0, 0, 1], [1, 0, 0]],
  ['turned triangle up at the capsule', { shape: 'triangle', a: [-1, 0, -1], b: [1, 0, -1], c: [0, 0, 1] }, [0, 0, 0], [0.2, 0.3, 0, 0.933], [0, 1, 0]],
  ['round box', { shape: 'box', halfExtents: [0.4, 0.6, 0.5], borderRadius: 0.2 }, [0, 0, 0], [0, 0.2, 0, 0.98], [1, 0, 0]],
  ['round hull', { shape: 'convexHull', points: [-1, -1, -1, 1, -1, -1, 0, 1, -1, 0, 0, 1], borderRadius: 0.25 }, [0, 0, 0], [0, 0, 0, 1], [1, 0.1, 0]],
];
for (const [name, shape, position, rotation, direction] of casts)
  test(`a ${name} cast meets what Rapier's does`, () => {
    const [own, rapier] = worlds.map((w) => w.shapeCast(shape, position, rotation, direction, { maxDistance: 50 }));
    assert.equal(!!own, !!rapier, name);
    assert.ok(own, `${name} should hit something`);
    near(own.distance, rapier.distance, name);
  });

test('overlaps with a segment, a triangle and a round box match Rapier', () => {
  for (const [shape, position] of [
    [{ shape: 'segment', a: [0, 0, 0], b: [3, 0, 0] }, [4, 0, 0]],
    [{ shape: 'segment', a: [0, 0, 0], b: [3, 0, 0] }, [-4, 0, 0]],
    [{ shape: 'triangle', a: [0, -1, 0], b: [0, 1, 0], c: [1, 0, 0] }, [5.2, 0, 0]],
    [{ shape: 'triangle', a: [0, -1, 0], b: [0, 1, 0], c: [1, 0, 0] }, [3, 0, 0]],
    [{ shape: 'box', halfExtents: [0.5, 0.5, 0.5], borderRadius: 0.4 }, [5.2, 2.2, 0]],
    [{ shape: 'box', halfExtents: [0.5, 0.5, 0.5], borderRadius: 0.1 }, [5.2, 2.7, 0]],
  ]) {
    const [own, rapier] = worlds.map((w) => w.intersectShape(shape, position).length);
    assert.equal(own, rapier, `${JSON.stringify(shape)} at ${position}`);
  }
});
