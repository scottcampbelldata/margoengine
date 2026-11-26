import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushSolver } from '../../dist/crush.js';
import { TerrainBed } from '../../dist/earth.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const zero = [0, 0, 0];
const shape = { columns: 4, rows: 2, width: 4, depth: 2, centre: [0, 0] };
const mass = 4;
const elastic = { stiffness: 800, yieldForce: 1e6, stroke: 12 };
const near = (got, want, limit = 2e-5) =>
  assert.ok(Math.abs(got - want) <= limit, `expected ${want}, got ${got}, tolerance ${limit}`);

async function assemble({
  elevations,
  position,
  linearVelocity = zero,
  normal = [0, -1, 0],
  shared = false,
  bedCell = zero,
  cellSize,
}) {
  await Physics.load({ threads: shared });
  const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(shared) });
  const physics = new Physics(null, { arena: world.arena, gravity: zero });
  const sled = physics.addBody(null, {
    position,
    linearVelocity,
    colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass, sensor: true },
  });
  const crush = new CrushSolver({ terrain: shape });
  const capacity = physics.kernel.capacity;
  world.add(new TerrainBed(), { ...shape, elevations });
  world.add(new RigidSolver(), { physics, capacity });
  world.add(crush, {
    bodyCapacity: capacity,
    cellSize,
    patches: [],
    groundPatches: [{ body: sled.row, anchor: zero, normal, material: elastic }],
  });
  world.setCell('bed', bedCell);
  world.couple(['bed', 'rigid', crush.id], 'staggered');
  return { world, physics, sled, crush };
}

test('a terrain-grounding patch exchanges the independently derived oblique plane impulse', async () => {
  const slope = 0.5;
  const approach = [3, -1, 0.2];
  const { world, physics, sled, crush } = await assemble({
    elevations: (x) => slope * x,
    position: [-0.05, 0.025 + 1 / 60, 0],
    linearVelocity: approach,
  });
  try {
    world.advance(1);
    const denom = Math.sqrt(1 + slope ** 2);
    const inward = [slope / denom, -1 / denom, 0];
    const closing = (slope * approach[0] - approach[1]) / denom;
    const impulse = 2 * mass * closing;
    const hit = crush.read(0);
    assert.equal(hit.impacts, 1);
    near(hit.impulse, impulse);
    near(hit.peakStroke, closing * Math.sqrt(mass / elastic.stiffness));
    assert.equal(hit.absorbedEnergy, 0);
    world.advance(2);
    for (let axis = 0; axis < 3; axis++) near(sled.linearVelocity[axis], approach[axis] - 2 * closing * inward[axis]);
    for (const component of sled.angularVelocity) near(component, 0, 1e-12);
  } finally {
    physics.dispose();
  }
});

test('a moving station intersects a middle ridge even when both tick endpoints clear it', async () => {
  const speed = 180;
  const height = 0.3125;
  const results = [];
  for (const shared of [false, true]) {
    const { world, physics, sled, crush } = await assemble({
      elevations: (x) => (x === 0 ? height : 0),
      position: [-4.5, 0.1, 0.32],
      shared,
    });
    try {
      world.advance(1);
      const start = world.takeSnapshot();
      const run = () => {
        sled.setLinearVelocity([speed, 0, 0]);
        world.advance(2);
        const hit = crush.read(0);
        const closing = (speed * height) / Math.sqrt(1 + height ** 2);
        assert.equal(hit.impacts, 1);
        near(hit.impulse, 2 * mass * closing);
        world.advance(3);
        assert.ok(sled.linearVelocity[0] < speed && sled.linearVelocity[1] > 0);
        return hit;
      };
      const hit = run();
      const hash = world.hash();
      world.restoreSnapshot(start.bytes);
      assert.deepEqual(run(), hit);
      assert.equal(world.hash(), hash);
      results.push(hit);
    } finally {
      physics.dispose();
    }
  }
  assert.deepEqual(results[1], results[0]);
});

test('outside the terrain and on the back of a hull station the bed adds no impulse', async () => {
  for (const config of [{ position: [2.2, 0.03, 0] }, { position: [0, 0.03, 0], normal: [0, 1, 0] }]) {
    const { world, physics, sled, crush } = await assemble({
      elevations: () => 0,
      linearVelocity: [0, -3, 0],
      ...config,
    });
    try {
      world.advance(5);
      assert.equal(crush.read(0).impacts, 0);
      assert.deepEqual(sled.linearVelocity, [0, -3, 0]);
    } finally {
      physics.dispose();
    }
  }
});

test('the first hit within a cell uses the face beyond its diagonal', async () => {
  const speed = 36;
  const { world, physics, crush } = await assemble({
    elevations: (x, z) => (x === 0 && z === 0 ? 0.5 : 0),
    position: [-1.4, 0.15, -1.4],
    linearVelocity: [speed, 0, speed],
  });
  try {
    world.advance(1);
    const hit = crush.read(0);
    assert.equal(hit.impacts, 1);
    const closing = speed / Math.sqrt(1 + 0.5 ** 2 + 0.5 ** 2);
    near(hit.impulse, 2 * mass * closing);
  } finally {
    physics.dispose();
  }
});

test('terrain and rigid bodies can refer to different floating-origin cells', async () => {
  const run = async (offset) => {
    const { world, physics, sled, crush } = await assemble({
      elevations: (x) => 0.5 * x,
      position: [offset - 0.05, 0.025 + 1 / 60, 0],
      linearVelocity: [3, -1, 0],
      bedCell: [offset / 100, 0, 0],
      cellSize: 100,
    });
    try {
      world.advance(2);
      assert.equal(crush.read(0).impacts, 1);
      return [crush.read(0).impulse, ...sled.linearVelocity];
    } finally {
      physics.dispose();
    }
  };
  assert.deepEqual(await run(100), await run(0));
});
