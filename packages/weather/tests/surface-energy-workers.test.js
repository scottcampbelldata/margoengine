import assert from 'node:assert/strict';
import test from 'node:test';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';
import { surfaceCell, surfaceEnergyRun } from './fixtures/surface-energy-workers.mjs';

for (const [columns, rows] of [
  [37, 29],
  [61, 43],
]) {
  test(`surface energy native workers reproduce the ${columns}×${rows} grid byte for byte`, async () => {
    const count = columns * rows;
    const scalar = await surfaceEnergyRun(columns, rows, 0);
    assert.ok(scalar.accepted.partial.melt > 0 && scalar.accepted.partial.snow > 0);
    assert.equal(scalar.accepted.partial.temperature, 273.15);
    assert.equal(scalar.accepted.complete.snow, 0);
    assert.ok(scalar.accepted.condensing.evaporation < 0);
    assert.ok(Number.isFinite(scalar.accepted.end.temperature));
    const pairs = Math.floor(count / 2);
    let single;
    for (const threads of [1, 2, 4]) {
      const { start, accepted, replay, restoredCells } = await surfaceEnergyRun(columns, rows, threads);
      assert.deepEqual(start.bytes, scalar.start.bytes);
      assert.deepEqual(accepted.snapshot.bytes, scalar.accepted.snapshot.bytes);
      assert.deepEqual(accepted.fields, scalar.accepted.fields);
      assert.deepEqual(replay.snapshot.bytes, accepted.snapshot.bytes);
      assert.deepEqual(replay.fields, accepted.fields);
      assert.deepEqual(replay.work, accepted.work);
      assert.deepEqual(
        restoredCells,
        Array.from({ length: 5 }, () => surfaceCell),
      );
      assert.deepEqual(
        accepted.fields.map(({ cell }) => cell),
        Array.from({ length: 5 }, () => [0, 0, 0]),
      );
      assert.equal(accepted.work.rows, count);
      assert.equal(accepted.work.pairs, pairs);
      assert.equal(accepted.work.threads, threads);
      assert.ok(accepted.work.pairedBalanceEvaluations > 15 * pairs);
      for (const [part, worker] of accepted.work.workers.entries()) {
        const offset = Math.floor((part * pairs) / threads);
        const stop = Math.floor(((part + 1) * pairs) / threads);
        assert.equal(worker.pairs, stop - offset);
        assert.equal(worker.rows, 2 * worker.pairs + (part === threads - 1 ? 1 : 0));
        assert.ok(worker.pairedBalanceEvaluations > 15 * worker.pairs);
      }
      single ??= accepted.work;
      assert.equal(accepted.work.balanceEvaluations, single.balanceEvaluations);
      assert.equal(accepted.work.pairedBalanceEvaluations, single.pairedBalanceEvaluations);
    }
  });
}

test('one surface patch and an even grid use the same accepted solve with empty worker ranges', async () => {
  for (const grid of [undefined, { rows: 2, columns: 2, spacing: [1, 1] }]) {
    const threads = 4;
    const native = await SurfaceEnergySolver.load({}, { threads });
    try {
      const scalar = new SurfaceEnergySolver();
      const params = { grid, initialTemperature: 290, shortwave: 530, rain: 0.00003 };
      const make = (solver) => new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, params, surfaceCell);
      const a = make(scalar);
      const b = make(native);
      a.advance(4);
      b.advance(4);
      assert.deepEqual(b.takeSnapshot().bytes, a.takeSnapshot().bytes);
      const work = native.workCounts();
      assert.equal(work.rows, grid ? 4 : 1);
      assert.deepEqual(
        work.workers.map(({ rows }) => rows),
        grid ? [0, 2, 0, 2] : [0, 0, 0, 1],
      );
      assert.equal(work.pairedBalanceEvaluations > 0, Boolean(grid));
    } finally {
      native[Symbol.dispose]();
    }
  }
});

test('a nonfinite last patch from a native helper leaves the whole accepted batch and receipt intact', async () => {
  const columns = 11;
  const rows = 3;
  const patches = columns * rows;
  const forcing = {
    name: 'worker-insolation',
    kind: 'scalarSeries',
    quantity: 'irradiance',
    unit: 'W/m^2',
    centring: 'cell',
  };
  const surface = await SurfaceEnergySolver.load(
    { inputs: { shortwave: { field: forcing, patchStride: 1 } } },
    { threads: 4 },
  );
  try {
    let host;
    let storage;
    let extreme = false;
    const source = {
      describe: () => ({
        id: 'worker-sun',
        rate: 0,
        stableRate: () => 0,
        fields: [{ field: forcing, access: 'write' }],
      }),
      init(solverHost) {
        host = solverHost;
        storage = host.allocate('insolation', 8 * patches, 'f64', 1);
        regionWords(host.memory, storage).fill(530);
      },
      step() {
        regionWords(host.memory, storage)[patches - 1] = extreme ? Number.MAX_VALUE : 530;
      },
      importPorts() {},
      exportPorts(tick) {
        return [{ field: forcing.name, region: storage, tick, cell: host.cell }];
      },
      stateRegions: () => [storage],
      extraState: () => [],
    };
    const clock = { num: 60, den: 1 };
    const world = new PhysicsWorld({ rate: clock })
      .add(source, {}, surfaceCell)
      .add(surface, { grid: { columns, rows, spacing: [3, 7] } }, surfaceCell);
    const accepted = () => surface.stateRegions().map((region) => regionWords(world.memory, region).slice());
    world.advance(1);
    const checkpoint = world.takeSnapshot();
    const before = accepted();
    const work = surface.workCounts();
    extreme = true;
    assert.throws(
      () => world.advance(2),
      (error) => error.code === 'state' && /finite implicit balance range.*Reduce forcing/.test(error.message),
    );
    assert.deepEqual(accepted(), before);
    assert.deepEqual(surface.workCounts(), work);
    extreme = false;
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(2);
    assert.notDeepEqual(accepted(), before, 'the same helpers can accept a later finite batch');
  } finally {
    surface[Symbol.dispose]();
  }
});
