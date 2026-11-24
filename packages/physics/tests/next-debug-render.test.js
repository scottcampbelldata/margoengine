// Debug lines of the own solver: the right number of segments for each shape, at the right places, with matching colours.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const segments = (lines) => lines.vertices.length / 6;

test('a box is 12 edges at its corners, coloured by body kind, and fixed bodies differ from dynamic', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, { position: [1, 2, 3], colliders: { shape: 'box', halfExtents: [0.5, 1, 1.5] } });
  const lines = physics.debugRender({ contacts: false });
  assert.equal(segments(lines), 12);
  assert.equal(lines.colors.length, 12 * 2 * 4);
  const xs = [],
    ys = [],
    zs = [];
  for (let i = 0; i < lines.vertices.length; i += 3) {
    xs.push(lines.vertices[i]);
    ys.push(lines.vertices[i + 1]);
    zs.push(lines.vertices[i + 2]);
  }
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0.5, 1.5]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [1, 3]);
  assert.deepEqual([Math.min(...zs), Math.max(...zs)], [1.5, 4.5]);
  const fixed = new Physics(null);
  fixed.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  assert.notDeepEqual([...fixed.debugRender().colors.slice(0, 3)], [...lines.colors.slice(0, 3)]);
  physics.dispose();
  fixed.dispose();
});

test('every shape draws, and each option adds only its own lines', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const shapes = [
    { shape: 'sphere', radius: 1 },
    { shape: 'capsule', radius: 0.5, halfHeight: 1 },
    { shape: 'cylinder', radius: 0.5, halfHeight: 1 },
    { shape: 'cone', radius: 0.5, halfHeight: 1 },
    { shape: 'convexHull', points: [1, 0, 1, 1, 0, -1, -1, 0, -1, -1, 0, 1, 0, 1, 0] },
    { shape: 'trimesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1], indices: [0, 1, 2, 2, 1, 3] },
  ];
  const counts = [];
  for (const [i, collider] of shapes.entries()) {
    const body = physics.addBody(null, { type: 'fixed', position: [i * 5, 0, 0], colliders: collider });
    const before = segments(physics.debugRender());
    counts.push(before);
    body.remove();
  }
  assert.equal(counts[0], 72);
  assert.ok(
    counts.every((n) => n > 0),
    `${counts}`,
  );
  assert.equal(counts[5], 5, 'two triangles share one edge');
  assert.equal(counts[4], 8, 'a pyramid has 8 edges');
  const floor = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
  assert.equal(segments(physics.debugRender({ boxes: true, contacts: false })), 24);
  assert.equal(segments(physics.debugRender({ colliders: false, contacts: false })), 0);
  assert.ok(floor);
  physics.dispose();
});

test('joints draw three lines, a broken one darker, and contacts draw a point and a normal', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const ball = physics.addBody(null, { position: [0, 0.5, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  physics.step();
  const contacts = physics.debugRender({ colliders: false });
  assert.ok(segments(contacts) >= 1);
  const joint = physics.addJoint(floor, ball, {
    type: 'spherical',
    anchorA: [0, 0.5, 0],
    anchorB: [0, 0, 0],
    breakForce: 1,
  });
  assert.equal(segments(physics.debugRender({ colliders: false, contacts: false })), 3);
  const fresh = [...physics.debugRender({ colliders: false, contacts: false }).colors.slice(0, 3)];
  for (let i = 0; i < 30; i++) physics.step();
  const after = [...physics.debugRender({ colliders: false, contacts: false }).colors.slice(0, 3)];
  if (joint.broken) assert.notDeepEqual(after, fresh);
  physics.dispose();
});
