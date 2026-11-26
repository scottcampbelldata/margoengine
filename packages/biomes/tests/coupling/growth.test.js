import assert from 'node:assert/strict';
import test from 'node:test';
import { RainfallRunoff } from '@margoengine/physics/runoff';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { tubes } from '@margoengine/procedural/lsystem';
import { frameRateIndependent, seekEqualsContinuous } from '../../../physics/tests/coupling/harness.js';
import { PLANT_GROWTH_LAYOUT, PLANT_GROWTH_WORDS, PlantGrowth } from '../../dist/growth.js';

const rate = { num: 60, den: 1 };
const voxels = { origin: [0, 0, 0], dimensions: [4, 8, 4], size: 1 };
const species = {
  productiveSeasons: 3,
  seasonalExtension: 2,
  minimumExtension: 0.05,
  internodeLength: 0.4,
  tipRadius: 0.02,
  apicalWeight: 0.5,
  branchingAngle: Math.PI / 3,
  divergence: 0,
  phototropism: 0,
  gravitropism: 0,
  leafShadow: 0,
};
const plant = { position: [0.25, 0.25, 0.25], species };
const close = (got, want, bound = 48 * Number.EPSILON * Math.max(1, Math.abs(want))) =>
  assert.ok(Math.abs(got - want) <= bound, `${got} differs from ${want} beyond ${bound}`);

function attach(growth, params = {}, frameRate = rate, memory = worldMemory(false)) {
  return new PhysicsWorld({ rate: frameRate, memory }).add(growth, {
    plants: [plant],
    voxels,
    ticksPerSeason: 60,
    ...params,
  });
}

test('parallel bud production forms the analytic branching angle and pipe-model area', async () => {
  const growth = await PlantGrowth.load();
  const world = attach(growth);
  world.advance(59);
  assert.equal(growth.season, 0);
  assert.deepEqual(growth.internodes(), []);
  world.advance(60);
  const [stem] = growth.internodes();
  assert.equal(growth.internodes().length, 1);
  assert.deepEqual(stem.start, plant.position);
  close(stem.end[1] - stem.start[1], 0.4);
  assert.equal(stem.birthSeason, 1);
  world.advance(120);
  const [trunk, leader, lateral] = growth.internodes();
  assert.equal(growth.internodes().length, 3);
  assert.deepEqual(lateral.start, leader.start);
  assert.deepEqual(leader.direction, [0, 1, 0]);
  close(lateral.direction[1], 0.5);
  close(lateral.direction[2], Math.sqrt(3) / 2);
  close(trunk.radius, Math.sqrt(leader.radius * leader.radius + lateral.radius * lateral.radius));
  assert.equal(leader.parent, trunk.id);
  assert.equal(lateral.parent, trunk.id);
  assert.equal(lateral.order, 1);
  const saved = world.fields.port(growth.branchesField.name);
  assert.equal(saved.region.layout, PLANT_GROWTH_LAYOUT);
  assert.equal(regionWords(world.memory, saved.region)[0], 4);
  const lateralAt = 2 + PLANT_GROWTH_WORDS * lateral.id;
  assert.equal(regionWords(world.memory, saved.region)[lateralAt + 7], trunk.id);
});

function centeredVoxel(x, y, z, amount, shape = voxels) {
  const [nx, ny, nz] = shape.dimensions;
  const field = new Float64Array(nx * ny * nz);
  field[(z * ny + y) * nx + x] = amount;
  return field;
}

test('pyramidal penumbra decays by a calibrated layer factor', async () => {
  const transmitted = await PlantGrowth.load();
  const isolated = await PlantGrowth.load();
  const fast = { ...species, seasonalExtension: 0.3, minimumExtension: 0.01 };
  const planting = [{ ...plant, species: fast }];
  const depth = 2;
  const transmission = 0.5;
  attach(transmitted, {
    plants: planting,
    voxels: {
      ...voxels,
      obstacles: centeredVoxel(0, depth, 0, 1),
      shadowDepth: depth,
      shadowTransmission: transmission,
    },
  }).advance(60);
  attach(isolated, { plants: planting }).advance(60);
  const [dim] = transmitted.internodes();
  close(dim.end[1] - dim.start[1], fast.seasonalExtension * (1 - transmission * transmission));
  const [open] = isolated.internodes();
  close(open.end[1] - open.start[1], fast.seasonalExtension);
});

test('a solid obstacle blocks a segment crossing its interior between two open endpoints', async () => {
  const shape = { ...voxels, size: 0.5 };
  const obstruction = centeredVoxel(0, 1, 0, 1, shape);
  const blocked = await PlantGrowth.load();
  const clear = await PlantGrowth.load();
  const fast = { ...species, seasonalExtension: 1.1, internodeLength: 1.1 };
  attach(blocked, {
    plants: [{ ...plant, species: fast }],
    voxels: { ...shape, obstacles: obstruction, shadowDepth: 0 },
  }).advance(60);
  attach(clear, { plants: [{ ...plant, species: fast }], voxels: shape }).advance(60);
  assert.equal(blocked.internodes().length, 0);
  assert.equal(clear.internodes().length, 1);
  close(clear.internodes()[0].end[1], 1.35);
});

test('the least-shadowed horizontal direction bends a continuing shoot away from an opaque neighbor', async () => {
  const growth = await PlantGrowth.load();
  const shoot = { ...plant, position: [1.25, 0.25, 1.25], species: { ...species, phototropism: 1 } };
  const obstacles = centeredVoxel(2, 0, 1, 1);
  attach(growth, { plants: [shoot], voxels: { ...voxels, obstacles, shadowDepth: 0 } }).advance(60);
  const [first] = growth.internodes();
  // The preferred light vector is halfway from +Y to -X, and developmental heading bisects it with +Y.
  close(first.direction[0], -Math.sin(Math.PI / 8));
  close(first.direction[1], Math.cos(Math.PI / 8));
  assert.ok(first.end[0] < first.start[0]);
});

test('neighboring crowns share one extinction grid and reduce one another’s extension', async () => {
  const crowded = await PlantGrowth.load();
  const isolated = await PlantGrowth.load();
  const small = { ...species, seasonalExtension: 0.3, minimumExtension: 0.01, leafShadow: 0.75 };
  const parent = { ...plant, species: small };
  const rival = { ...parent, position: [0.75, 0.25, 0.25] };
  attach(crowded, { plants: [parent, rival] }).advance(120);
  attach(isolated, { plants: [parent] }).advance(120);
  const getLeader = (solver) =>
    solver.internodes().find((row) => row.plant === 0 && row.order === 0 && row.birthSeason === 2);
  const [a, b] = [getLeader(crowded), getLeader(isolated)];
  close(a.end[1] - a.start[1], 0.075);
  close(b.end[1] - b.start[1], 0.15);
});

test('live HYDRO-02 root-zone storage differentiates neighboring plants in a single planting', async () => {
  const runoff = await RainfallRunoff.load();
  const growth = await PlantGrowth.load({
    soil: {
      field: runoff.soilWaterField,
      origin: [0, 0],
      dimensions: [2, 1],
      size: [1, 1],
      full: 0.15,
    },
  });
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) })
    .add(runoff, {
      nx: 2,
      nz: 1,
      dx: 1,
      downstream: [-1, -1],
      soilCapacity: 0.15,
      initialSaturation: [0, 1],
      drainage: 0,
    })
    .add(growth, { plants: [plant, { ...plant, position: [1.25, 0.25, 0.25] }], voxels, ticksPerSeason: 60 });
  world.advance(120);
  assert.equal(growth.internodes().length, 3);
  assert.ok(growth.internodes().every((segment) => segment.plant === 1));
});

test('growth is invariant across arena memory modes, display rates, memory growth, and a capped seek', async () => {
  const [plain, shared, fps1, fps2, fps3, first, second] = await Promise.all(
    Array.from({ length: 7 }, () => PlantGrowth.load()),
  );
  const a = attach(plain);
  const b = attach(shared, {}, rate, worldMemory(true));
  a.advance(35);
  b.advance(35);
  assert.equal(a.hash(), b.hash());
  const saved = b.takeSnapshot();
  b.memory.grow(1);
  a.advance(180);
  b.advance(180);
  assert.equal(a.hash(), b.hash());
  b.restoreSnapshot(saved.bytes);
  b.advance(180);
  assert.equal(b.hash(), a.hash());
  const queue = [fps1, fps2, fps3];
  frameRateIndependent((fps) => attach(queue.shift(), {}, fps));
  const seekQueue = [first, second];
  seekEqualsContinuous(() => attach(seekQueue.shift(), {}, { num: 24, den: 1 }), { at: 13, frames: 48 });
});

test('the live branch graph meshes through the Procedural package with valid frames and remapped parents', async () => {
  const growth = await PlantGrowth.load();
  const world = attach(growth);
  world.advance(120);
  const graph = growth.toBranches();
  assert.deepEqual([...graph.parents], [-1, 0, 0]);
  assert.deepEqual([...graph.depths], [0, 0, 1]);
  assert.ok([...graph.ups].every(Number.isFinite));
  assert.ok(graph.radii[0] > graph.radii[1]);
  const geometry = tubes(graph);
  assert.ok(geometry.vertices.length > 0);
  assert.ok(geometry.indices.length > 0);
  assert.ok(geometry.vertices.every(Number.isFinite));
});

test('invalid obstacle shapes and occupied planting coordinates identify the required repair', async () => {
  const badShape = await PlantGrowth.load();
  assert.throws(() => attach(badShape, { voxels: { ...voxels, obstacles: [0] } }), /Provide one obstacle occupancy/);
  const occupied = await PlantGrowth.load();
  assert.throws(
    () => attach(occupied, { voxels: { ...voxels, obstacles: centeredVoxel(0, 0, 0, 1) } }),
    /Choose plant seeds/,
  );
});
