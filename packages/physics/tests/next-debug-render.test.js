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

test('a style recolours each kind and sizes the contact normal, and axes draw three coloured lines a body', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, { position: [1, 2, 3], colliders: { shape: 'box', halfExtents: [0.5, 1, 1.5] } });
  const plain = physics.debugRender({ contacts: false }),
    styled = physics.debugRender({ contacts: false, style: { dynamic: [0.1, 0.2, 0.3, 0.4] } });
  assert.deepEqual(
    [...styled.colors.slice(0, 4)].map((v) => Math.round(v * 10)),
    [1, 2, 3, 4],
  );
  assert.notDeepEqual([...plain.colors.slice(0, 4)], [...styled.colors.slice(0, 4)]);
  assert.equal(segments(styled), segments(plain), 'a style changes colours, not lines');
  const axes = physics.debugRender({ colliders: false, contacts: false, axes: true, style: { axisLength: 2 } });
  assert.equal(segments(axes), 3, 'one line a axis');
  const lengths = [0, 1, 2].map((k) =>
    Math.hypot(
      axes.vertices[6 * k + 3] - axes.vertices[6 * k],
      axes.vertices[6 * k + 4] - axes.vertices[6 * k + 1],
      axes.vertices[6 * k + 5] - axes.vertices[6 * k + 2],
    ),
  );
  assert.ok(
    lengths.every((length) => Math.abs(length - 2) < 1e-5),
    `each axis is 2 m (${lengths})`,
  );
  assert.ok(axes.colors[0] === 1 && axes.colors[8 + 1] === 1, 'red x then green y');
  physics.dispose();
});

test('solver contacts draw a gap line and a normal tick a point, and pseudo normals one tick a face and a shared edge', async () => {
  await Physics.load();
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
  });
  physics.addBody(null, {
    position: [0, 0.5, 0],
    canSleep: false,
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  for (let i = 0; i < 30; i++) physics.step();
  const solver = physics.debugRender({ colliders: false, contacts: false, solverContacts: true });
  assert.equal(segments(solver), 4 * 2, 'four points, each a gap line and a normal tick');
  const [r, g, b] = solver.colors.slice(0, 3);
  assert.ok(r === 1 && g > 0.5 && b < 0.2, 'in the solver contact colour');
  // The gap line is tiny for a resting box, and the tick is 0.1 m long.
  const tick = [0, 1, 2].map((k) => solver.vertices[18 + 3 + k] - solver.vertices[18 + k]);
  assert.ok(Math.abs(Math.hypot(...tick) - 0.1) < 1e-4, `the second segment of a point is the normal tick (${tick})`);
  physics.dispose();
  const world = new Physics(null);
  world.addBody(null, {
    type: 'fixed',
    colliders: {
      shape: 'trimesh',
      vertices: [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1],
      indices: [0, 1, 2, 2, 1, 3],
      fixInternalEdges: true,
    },
  });
  const normals = world.debugRender({ colliders: false, contacts: false, pseudoNormals: true });
  assert.equal(segments(normals), 3, 'a tick at each of the two triangles and one at the edge they share');
  const plain = new Physics(null);
  plain.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: [0, 0, 0, 0, 0, 1, 1, 0, 0], indices: [0, 1, 2] },
  });
  assert.equal(
    segments(plain.debugRender({ colliders: false, contacts: false, pseudoNormals: true })),
    0,
    'a mesh without fixInternalEdges has none',
  );
  world.dispose();
  plain.dispose();
});
