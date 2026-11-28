import assert from 'node:assert/strict';
import test from 'node:test';
import { RainfallRunoff } from '../../dist/runoff.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const cell = { nx: 1, nz: 1, dx: 1, downstream: [-1], conductivity: 0, slope: 0 };
const error = (message) => ({ name: 'MargoError', code: 'state', message });

function stateBytes(world, solver) {
  return solver
    .stateRegions()
    .map(({ byteOffset, byteLength }) => Buffer.from(new Uint8Array(world.memory.buffer, byteOffset, byteLength)));
}

test('runoff setup and sampling errors give coded corrections', async () => {
  await assert.rejects(RainfallRunoff.load(null), error(/Pass an options object/));
  await assert.rejects(RainfallRunoff.load({ id: ' ' }), error(/nonempty name/));
  await assert.rejects(RainfallRunoff.load({ rain: { word: 1 } }), error(/named field in m\/s/));
  const runoff = await RainfallRunoff.load();
  for (const [options, expected] of [
    [{ nx: 0 }, /positive integers/],
    [{ nx: 20_000, nz: 20_000 }, /Use fewer cells/],
    [{ nx: 2, downstream: [1, 0] }, /acyclic drainage graph/],
    [{ dx: 0 }, /dx.*positive/],
    [{ dx: Number.MIN_VALUE }, /cell centres exceed coordinate resolution/],
    [{ origin: [2 ** 53, 0] }, /Use a nearer local origin/],
    [{ dx: 1e100, initialDepth: 1e150 }, /initial stored volume/],
    [{ precipitation: {} }, /source with a sample method/],
  ])
    assert.throws(() => new PhysicsWorld({ rate }).add(runoff, { ...cell, ...options }), error(expected));

  new PhysicsWorld({ rate }).add(runoff, cell);
  assert.throws(() => runoff.read(0, 1), error(/column and row in the configured grid/));
});

test('a cumulative runoff overflow rejects the whole native candidate in either memory mode', async (t) => {
  for (const [shared, threads] of [
    [false, 1],
    [true, 1],
    [true, 4],
  ]) {
    const runoff = await RainfallRunoff.load({ threads });
    t.after(() => runoff[Symbol.dispose]());
    const world = new PhysicsWorld({ rate, memory: worldMemory(shared) }).add(runoff, {
      ...cell,
      dx: 100,
      rainRate: 1e305,
    });
    world.advance(10);
    assert.ok(runoff.budget.rain > 1.6e308);
    const tick = world.tick;
    const before = stateBytes(world, runoff);
    const work = runoff.workCounts();
    const saved = world.takeSnapshot();
    for (let replay = 0; replay < 2; replay++) {
      assert.throws(() => world.advance(11), error(/finite water or flow range.*Use compatible grid/));
      assert.equal(world.tick, tick);
      assert.deepEqual(stateBytes(world, runoff), before);
      assert.deepEqual(runoff.workCounts(), work);
      world.restoreSnapshot(saved.bytes);
    }
  }
});

const rainField = {
  name: 'runoff-spatial-rain',
  kind: 'uniformGrid',
  quantity: 'precipitationRate',
  unit: 'm/s',
  centring: 'cell',
};

function spatialRain() {
  let host;
  let region;
  return {
    describe: () => ({
      id: 'spatial-rain',
      fields: [{ field: rainField, access: 'write' }],
      rate: 0,
      stableRate: () => 0,
    }),
    init(owner) {
      host = owner;
      region = host.allocate('rain-rates', 16, 'f64', 1);
      regionWords(host.memory, region).set([0.06, 0.03]);
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: rainField.name, region, tick, cell: host.cell }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('a spatial rain port shares the runoff cell and accepted ports follow a live rebase', async () => {
  const configure = async (rainCell) => {
    const runoff = await RainfallRunoff.load({ rain: { field: rainField } });
    const runoffCell = [100_000, 0, -50_000];
    const world = new PhysicsWorld({ rate })
      .add(runoff, { ...cell, nx: 2, downstream: [-1, -1] }, runoffCell)
      .add(spatialRain(), {}, rainCell ?? runoffCell);
    return { world, runoff, runoffCell };
  };
  const mismatch = await configure([0, 0, 0]);
  const before = stateBytes(mismatch.world, mismatch.runoff);
  assert.throws(() => mismatch.world.advance(1), error(/grid words in the same world cell/));
  assert.deepEqual(stateBytes(mismatch.world, mismatch.runoff), before);

  const { world, runoff, runoffCell } = await configure();
  assert.deepEqual(runoff.exportPorts(0)[0].cell, runoffCell);
  world.shiftOrigin(runoffCell);
  assert.deepEqual(runoff.exportPorts(0)[0].cell, [0, 0, 0]);
  world.advance(1);
  assert.equal(runoff.read(0, 0).depth, 0.001);
  assert.equal(runoff.read(1, 0).depth, 0.0005);
});
