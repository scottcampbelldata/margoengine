import assert from 'node:assert/strict';
import test from 'node:test';
import { bedVertexAreas, TerrainBed } from '../../dist/earth.js';
import { LandscapeEvolution } from '../../dist/landscape.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const grid = { columns: 1, rows: 1, width: 1, depth: 1, centre: [0, 0] };
const error = (message) => ({ name: 'MargoError', code: 'state', message });
const inactive = { rainfall: 0, erodibility: 0, hillslopeDiffusivity: 0, thermalDiffusivity: 0, alluvialDepth: 0 };

function stateBytes(world, solver) {
  return solver
    .stateRegions()
    .map(({ byteOffset, byteLength }) => Buffer.from(new Uint8Array(world.memory.buffer, byteOffset, byteLength)));
}

test('landscape rejects malformed grids and material inputs with coded corrections', async () => {
  await assert.rejects(LandscapeEvolution.load(null), error(/Pass an options object/));
  await assert.rejects(LandscapeEvolution.load({ id: ' ' }), error(/nonempty name/));
  const landscape = await LandscapeEvolution.load();
  for (const [params, expected] of [
    [{ grid: { ...grid, centre: [] } }, /valid TerrainBed rectangle/],
    [{ grid: { ...grid, columns: 20_000, rows: 20_000 } }, /fewer vertices or grain classes/],
    [{ grid: { ...grid, centre: [2 ** 53, 0] } }, /nearer local origin/],
    [{ grid: { ...grid, width: 1e-170, depth: 1e-170 } }, /vertex area/],
    [{ grains: [null] }, /array of diameter and fraction/],
    [{ grains: [{ diameter: 0.001, fraction: 0 }] }, /positive fraction/],
    [{ waterDensity: Number.MIN_VALUE }, /grain density ratio/],
    [{ grid: { ...grid, width: 10 }, alluvialDepth: 1e308 }, /initial loose volume/],
  ])
    assert.throws(() => new PhysicsWorld({ rate }).add(landscape, { grid, ...params }), error(expected));
  new PhysicsWorld({ rate }).add(landscape, { grid });
  assert.throws(() => landscape.read(-1, 0), error(/integer column and row/));
});

test('landscape refuses a finite native change that would overflow TerrainBed before publishing it', async (t) => {
  for (const [shared, threads] of [
    [false, 1],
    [true, 1],
    [true, 4],
  ]) {
    const bed = new TerrainBed();
    const landscape = await LandscapeEvolution.load({ threads });
    t.after(() => landscape[Symbol.dispose]());
    const world = new PhysicsWorld({ rate, memory: worldMemory(shared) })
      .add(bed, { ...grid, elevations: [1e38, 1e38, 1e38, 1e38] })
      .add(landscape, { ...inactive, grid, uplift: 9e39 });
    world.advance(1);
    const before = stateBytes(world, landscape);
    const work = landscape.workCounts();
    const acceptedTick = world.tick;
    const saved = world.takeSnapshot();
    assert.ok(landscape.budget.uplift > 1.4e38);
    for (let replay = 0; replay < 2; replay++) {
      assert.throws(() => world.advance(2), error(/TerrainBed float32 range.*Reduce uplift/));
      assert.equal(world.tick, acceptedTick);
      assert.deepEqual(stateBytes(world, landscape), before);
      assert.deepEqual(landscape.workCounts(), work);
      assert.ok(bed.elevations().every((value) => value > 0 && Number.isFinite(value)));
      world.restoreSnapshot(saved.bytes);
    }
  }
});

const rain = { name: 'large-landscape-rain', kind: 'uniformGrid', quantity: 'rainfall', unit: 'm/s', centring: 'cell' };

function largeRain() {
  let host;
  let region;
  return {
    describe: () => ({ id: 'large-rain', fields: [{ field: rain, access: 'write' }], rate: 0, stableRate: () => 0 }),
    init(owner) {
      host = owner;
      region = host.allocate('rain-rate', 32, 'f64', 1);
      regionWords(host.memory, region).fill(1e308);
    },
    importPorts() {},
    step() {},
    exportPorts: (tick) => [{ field: rain.name, region, tick, cell: host.cell }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('large uniform cell rain stays finite at shared vertices across a far world-cell shift', async () => {
  const tiny = { columns: 2, rows: 2, width: 2e-100, depth: 2e-100, centre: [0, 0] };
  const originCell = [550_000, 0, -100_000];
  const bed = new TerrainBed();
  const landscape = await LandscapeEvolution.load({ rainField: rain });
  const world = new PhysicsWorld({ rate })
    .add(bed, { ...tiny, elevations: new Float64Array(9) }, originCell)
    .add(largeRain(), {}, originCell)
    .add(landscape, { ...inactive, grid: tiny }, originCell);
  assert.deepEqual(landscape.exportPorts(0)[0].cell, originCell);
  world.shiftOrigin(originCell);
  assert.deepEqual(landscape.exportPorts(0)[0].cell, [0, 0, 0]);
  world.advance(1);
  const expected = bedVertexAreas(tiny)[4] * 1e308;
  assert.equal(landscape.read(1, 1).discharge, expected);
  assert.ok(Number.isFinite(expected) && expected > 0);
});
