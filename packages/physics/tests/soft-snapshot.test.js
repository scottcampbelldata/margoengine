// Whole soft-world snapshots (`SoftBodies.takeSnapshot`, `restoreSnapshot`): a cloth in a gusting wind with a box on it and a
// tear partway, scrubbed back to the middle and stepped on, steps to the same bits as the first time; bodies made, removed and
// split after the snapshot come back as they were, the same objects; a lost surface collider is made again; and the rigid
// world's snapshot carries its clock, so a wind that reads the time blows as it did.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

const gust = (point, time) => [8 + 6 * Math.sin(3 * time + point[2]), 0, 2 * Math.cos(2 * time)];
const curtain = () =>
  SoftBodyDesc.cloth([0, 3, 0], [0, -0.15, 0], [0, 0, 0.15], 16, 12)
    .setPinnedParticles([...Array(12).keys()])
    .setMaterial(
      Object.assign(SoftBodyDesc.cloth([0, 0, 0], [1, 0, 0], [0, 0, 1], 2, 2).material.clone(), { tearStrain: 0.4 }),
    );

async function scene() {
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics);
  soft.splitOnTear = 'all';
  soft.wind = gust;
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
  });
  const box = physics.addBody(null, {
      position: [0.3, 1.2, 0.8],
      colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], density: 300 },
    }),
    cloth = soft.create(curtain()),
    rope = soft.create(SoftBodyDesc.rope([2, 3, 0], [2, 1, 0], 12).setPinnedParticles([0]));
  return { physics, soft, box, cloth, rope };
}

test('a cloth scrubbed back to the middle of a shot steps on to the same bits', async () => {
  const { physics, soft, cloth } = await scene();
  for (let i = 0; i < 60; i++) physics.step();
  // A cut partway through: the hand tears a run of edges, and the step after splits the cloth.
  const pairs = cloth.edges();
  // Every edge from column 5 to column 6 (particle (i, j) is i * 12 + j), diagonals both ways: the next step splits it.
  for (let e = 0; e < pairs.length / 2; e++) {
    const [a, b] = [pairs[2 * e], pairs[2 * e + 1]].sort((x, y) => (x % 12) - (y % 12));
    if (a % 12 === 5 && b % 12 === 6) cloth.tearEdge(e);
  }
  const rigid = physics.takeSnapshot(),
    snapshot = soft.takeSnapshot(),
    first = [];
  for (let i = 0; i < 60; i++) {
    physics.step();
    first.push(soft.hash());
  }
  assert.ok(soft.list().length > 2, 'the cloth split');
  physics.restoreSnapshot(rigid);
  soft.restoreSnapshot(snapshot);
  assert.equal(physics.stepCount, 60);
  for (let i = 0; i < 60; i++) {
    physics.step();
    assert.equal(soft.hash(), first[i], `step ${i + 1} after the restore`);
  }
});

test('bodies made, removed and split since the snapshot come back as they were', async () => {
  const { physics, soft, cloth, rope } = await scene();
  for (let i = 0; i < 30; i++) physics.step();
  const rigid = physics.takeSnapshot(),
    snapshot = soft.takeSnapshot(),
    ropeAt = rope.particlePositions(),
    truth = [];
  for (let i = 0; i < 30; i++) {
    physics.step();
    truth.push(soft.hash());
  }
  // Back, then change the world: a new body, the rope removed, the cloth torn apart.
  physics.restoreSnapshot(rigid);
  soft.restoreSnapshot(snapshot);
  const extra = soft.create(SoftBodyDesc.rope([-2, 3, 0], [-2, 2, 0], 6));
  soft.remove(rope);
  const pairs = cloth.edges();
  for (let e = 0; e < pairs.length / 2; e++) {
    const rows = [Math.floor(pairs[2 * e] / 12), Math.floor(pairs[2 * e + 1] / 12)].sort((x, y) => x - y);
    if (rows[0] === 8 && rows[1] === 9) cloth.tearEdge(e);
  }
  for (let i = 0; i < 10; i++) physics.step();
  assert.equal(rope.valid, false);
  assert.equal(cloth.valid, false, 'the cloth split into pieces');
  // And back again: the same two bodies, the rope where it was, the new body gone.
  physics.restoreSnapshot(rigid);
  soft.restoreSnapshot(snapshot);
  assert.deepEqual(soft.list(), [cloth, rope]);
  assert.equal(rope.valid, true);
  assert.equal(cloth.valid, true);
  assert.equal(extra.valid, false);
  assert.deepEqual(rope.particlePositions(), ropeAt);
  for (let i = 0; i < 30; i++) {
    physics.step();
    assert.equal(soft.hash(), truth[i], `step ${i + 1} after the second restore`);
  }
});

test('a surface collider removed with its body is made again on restore', async () => {
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics),
    sheet = soft.create(SoftBodyDesc.cloth([0, 2, 0], [0.2, 0, 0], [0, 0, 0.2], 5, 5));
  soft.createSurfaceCollider(sheet, { friction: 0.7 });
  const snapshot = soft.takeSnapshot();
  soft.remove(sheet);
  soft.restoreSnapshot(snapshot);
  assert.equal(sheet.valid, true);
  physics.step();
  // The sheet stands in the rigid world again: a ray from above meets it.
  const hit = physics.raycast([0.4, 5, 0.4], [0, -1, 0]);
  assert.ok(hit && Math.abs(hit.point[1] - 2) < 0.2, `the ray met ${hit?.point}`);
});

test('a snapshot is restored only into the world that took it', async () => {
  const a = await scene(),
    b = await scene();
  assert.throws(() => b.soft.restoreSnapshot(a.soft.takeSnapshot()), /another soft world/);
});
