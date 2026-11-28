import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { SurgeSolver } from '../../dist/surge.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { followSurgePotential, surgeCell } from '../fixtures/surge-potential-workers.mjs';

const data = ({ accepted, potential, parts, bodyVectors, water, volume, cell }) => ({
  accepted,
  potential,
  parts,
  bodyVectors,
  water,
  volume,
  cell,
});

for (const scenario of ['combined', 'pressure', 'dry']) {
  test(`native surge tide and pressure match scalar signed replay for ${scenario}`, async () => {
    const scalar = await followSurgePotential(scenario);
    assert.deepEqual(data(scalar), data(scalar.replay));
    assert.deepEqual(scalar.cell, surgeCell);
    assert.ok(scalar.potential.some((value) => Math.abs(value) > 1e-5));
    if (scenario === 'dry') assert.equal(scalar.volume, 0);
    else assert.ok(scalar.volume > 0);
    let serial;
    for (const threads of [1, 2, 4]) {
      const native = await followSurgePotential(scenario, threads);
      assert.deepEqual(data(native), data(scalar));
      assert.deepEqual(data(native), data(native.replay));
      assert.deepEqual(native.work, native.replay.work);
      const totals = native.work.map(({ threads: actual, workers, ...work }) => {
        assert.equal(actual, threads);
        assert.equal(work.synthesizedCells, native.cells);
        assert.equal(work.pressureCells, native.cells);
        assert.equal(work.pairedSynthesis, native.cells - 1);
        assert.equal(work.tideCells, native.tide ? native.cells : 0);
        assert.equal(work.pairedTides, native.tide ? native.cells - 1 : 0);
        if (scenario === 'dry') assert.equal(work.wetCells, 0);
        else assert.ok(work.wetCells > 0 && work.wetCells < native.cells);
        const pairs = Math.floor(native.cells / 2);
        for (const [part, worker] of workers.entries()) {
          const lanes = 2 * (Math.floor((pairs * (part + 1)) / threads) - Math.floor((pairs * part) / threads));
          const cells = lanes + Number(part === threads - 1);
          assert.equal(worker.synthesizedCells, cells);
          assert.equal(worker.pressureCells, cells);
          assert.equal(worker.pairedSynthesis, lanes);
          assert.equal(worker.tideCells, native.tide ? cells : 0);
          assert.equal(worker.pairedTides, native.tide ? lanes : 0);
        }
        return work;
      });
      serial ??= totals;
      assert.deepEqual(totals, serial);
    }
  });
}

test('the surge potential loader rejects unsupported participants with a fix', async () => {
  await assert.rejects(SurgeSolver.load('surge', { tide: true }, { threads: 3 }), {
    name: 'MargoError',
    message: /Choose 1, 2 or 4 surge potential participants.*#storm-surge/,
  });
});

test('a finite pressure input whose ordered sum overflows leaves native surge and coupled water unchanged', async () => {
  using surge = await SurgeSolver.load('surge', {}, { threads: 4 });
  const water = new ShallowWaterSolver();
  const bed = bedSurface(
    { columns: 3, rows: 3, width: 3000, depth: 3000, centre: [1500, 1500] },
    new Float64Array(16).fill(-15),
  );
  let overload = false;
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(water, { bed, level: 0 })
    .add(surge, { water, pressure: (x, z) => (overload ? 1e308 : 101325 + 0.01 * (x - z)) })
    .couple(['surge', 'water'], 'staggered');
  world.advance(1);
  const accepted = world.takeSnapshot();
  const words = () => [...surge.extraState(), ...water.stateRegions()].map((r) => regionWords(world.memory, r).slice());
  const before = words();
  const work = surge.readNativeWork();
  assert.equal(work.wetCells, 9);
  overload = true;
  assert.throws(() => world.advance(2), {
    name: 'MargoError',
    message: /wet-cell mean exceeds finite range.*#storm-surge/,
  });
  assert.deepEqual(words(), before);
  assert.deepEqual(surge.readNativeWork(), work);
  overload = false;
  world.restoreSnapshot(accepted.bytes);
  world.advance(2);
  const recovered = world.takeSnapshot();
  world.restoreSnapshot(accepted.bytes);
  world.advance(2);
  assert.deepEqual(world.takeSnapshot(), recovered);
});
