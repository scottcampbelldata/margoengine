// Hulls and manifolds through Wasm: what the native tests prove, here at the JavaScript boundary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, loadKernel } from '../dist/next.js';

const PYRAMID = [
  [
    [1, 0, 1],
    [1, 0, -1],
    [-1, 0, -1],
    [-1, 0, 1],
    [0, 1, 0],
  ],
  [
    [3, 2, 1, 0],
    [0, 1, 4],
    [1, 2, 4],
    [2, 3, 4],
    [3, 0, 4],
  ],
];

test('a hull resting on a box has four points and a normal from the first collider to the second', async () => {
  await loadKernel();
  const world = new KernelWorld(4);
  world.setGravity(0, 0, 0);
  const hull = world.addHull(...PYRAMID),
    floor = world.addBody('fixed'),
    body = world.addBody('dynamic'),
    a = world.addCollider(floor, 'box', [5, 0.5, 5], { density: 0 }),
    b = world.addCollider(body, 'hull', [hull]);
  world.columns.positionY[body] = 0.49;
  world.step(1 / 60);
  const contacts = world.contacts();
  assert.equal(contacts.length, 1);
  const [{ colliderA, colliderB, normal, points }] = contacts;
  assert.deepEqual([colliderA, colliderB], [a, b]);
  assert.deepEqual(normal, [0, 1, 0]);
  assert.equal(points.length, 4);
  for (const { separation, position } of points) {
    assert.ok(Math.abs(separation + 0.01) < 1e-5, `${separation}`);
    assert.ok(Math.abs(position[1] - 0.495) < 1e-5);
  }
  assert.equal(new Set(points.map(({ id }) => id)).size, 4, 'each point has its own id');
});

test('a body of a hull takes its mass from the faces, and a snapshot carries the hull', async () => {
  await loadKernel();
  const world = new KernelWorld(4);
  world.setGravity(0, 0, 0);
  const hull = world.addHull(...PYRAMID),
    body = world.addBody('dynamic');
  world.addCollider(body, 'hull', [hull], { density: 3 });
  // A pyramid on a square of side 2 and height 1: volume 4/3, centroid at a quarter of its height.
  assert.ok(Math.abs(1 / world.columns.inverseMass[body] - 4) < 1e-5);
  assert.ok(Math.abs(world.columns.localCenterY[body] - 0.25) < 1e-6);
  const saved = world.snapshot(),
    other = new KernelWorld(1);
  other.restore(saved);
  const second = other.addBody('dynamic');
  assert.ok(other.addCollider(second, 'hull', [hull]) >= 0, 'a restored world knows the hull rows');
  assert.equal(other.columns.hullVertices[hull], 5);
});

test('addHull names what is wrong with a shape', async () => {
  await loadKernel();
  const world = new KernelWorld(4),
    [vertices, faces] = PYRAMID;
  assert.throws(() => world.addHull(vertices.slice(0, 3), [[0, 1, 2]]), /at least 4 vertices/);
  assert.throws(() => world.addHull(vertices, faces.slice(1)), /do not close/);
  assert.throws(() => world.addHull(vertices, [[0, 1, 2, 9], ...faces.slice(1)]), /does not exist/);
  assert.throws(() => world.addHull([[NaN, 0, 0], ...vertices.slice(1)], faces), /finite/);
  assert.throws(() => world.addHull(vertices, [[0, 1, 2.5], ...faces.slice(1)]), /whole number/);
  const body = world.addBody('dynamic');
  assert.throws(() => world.addCollider(body, 'hull', [0]), /row addHull returned/);
  assert.equal(world.addHull(...PYRAMID), 0, 'a refused hull leaves its rows free');
  assert.ok(world.addCollider(body, 'hull', [0]) >= 0);
});

test('many hulls grow the world and keep what is in it', async () => {
  await loadKernel();
  const world = new KernelWorld(4);
  world.setGravity(0, 0, 0);
  const body = world.addBody('dynamic');
  world.columns.positionY[body] = 7;
  for (let i = 0; i < 40; i++) assert.equal(world.addHull(...PYRAMID), i);
  assert.equal(world.columns.positionY[body], 7);
  assert.equal(world.columns.hullFaces[39], 5);
});

test('a ball and a capsule touch the floor through the same contacts', async () => {
  await loadKernel();
  const world = new KernelWorld(4);
  world.setGravity(0, 0, 0);
  const floor = world.addBody('fixed'),
    ball = world.addBody('dynamic'),
    capsule = world.addBody('dynamic');
  world.addCollider(floor, 'box', [5, 0.5, 5], { density: 0 });
  world.addCollider(ball, 'ball', [0.5]);
  world.addCollider(capsule, 'capsule', [0.25, 0.5]);
  world.columns.positionX[ball] = -2;
  world.columns.positionY[ball] = 0.99;
  world.columns.positionX[capsule] = 2;
  world.columns.positionY[capsule] = 1.24;
  world.step(1 / 60);
  const counts = world.contacts().map((contact) => contact.points.length);
  assert.deepEqual(counts.sort(), [1, 1]);
  assert.ok(Math.abs(world.contacts()[0].points[0].separation + 0.01) < 1e-4);
});
