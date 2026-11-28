import assert from 'node:assert/strict';
import test from 'node:test';
import { RainfallRunoff } from '../../dist/runoff.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import {
  authoredInput,
  farCell,
  makeCatchment,
  rate,
  runCatchment,
  setupRain,
  smallGrid,
} from '../fixtures/runoff-threads-case.mjs';

function verifySpans(n, threads, work) {
  const workers = Array.from({ length: threads }, (_, part) => {
    const cells = Math.floor(((part + 1) * n) / threads) - Math.floor((part * n) / threads);
    return { soilCells: cells, rainMeltCells: cells };
  });
  assert.deepEqual(work, { threads, soilCells: n, rainMeltCells: n, routedCells: n, workers });
  assert.ok(work.workers.every((worker) => worker.soilCells > 0));
}

function checkLedger(result, n) {
  const { stored, budget, wet, soilCells, outlet } = result.settled;
  const { rain, melt, condensation, evaporation, recharge, outflow } = budget;
  for (const value of Object.values(budget)) assert.ok(Number.isFinite(value) && value > 0);
  // Each tick accumulates forcing and discharge over the full catchment.
  const tolerance = 16 * n * 39 * Number.EPSILON * (rain + melt + condensation);
  const near = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, [actual, 'versus', expected].join(' '));
  near(rain, result.authored.rain);
  near(melt, result.authored.melt);
  near(condensation, result.authored.condensation);
  near(stored + evaporation + recharge + outflow, rain + melt + condensation);
  assert.ok(result.wet.wet > 0 && result.wet.wet < n);
  assert.ok(wet > 0 && soilCells > 0);
  assert.ok(outlet > 0 && result.wet.budget.rain < rain);
}

test('Runoff threads preserve mixed storm, melt and evaporation across a signed far-cell shift and replay', async () => {
  const lanes = [
    await runCatchment(smallGrid, { shared: false }),
    await runCatchment(smallGrid, { shared: true, threads: 1 }),
    await runCatchment(smallGrid, { shared: true, threads: 2 }),
    await runCatchment(smallGrid, { shared: true, threads: 4 }),
  ];
  const count = smallGrid[0] * smallGrid[1];
  const base = lanes[0];
  for (const [i, run] of lanes.entries()) {
    const threads = [1, 1, 2, 4][i];
    assert.deepEqual(run.initial.bytes, base.initial.bytes);
    assert.deepEqual(run.checkpoint.bytes, base.checkpoint.bytes);
    assert.deepEqual(run.final.bytes, base.final.bytes);
    assert.equal(run.final.hash, base.final.hash);
    assert.equal(run.replayed, true);
    assert.deepEqual(run.initialCell, farCell);
    assert.deepEqual(run.finalPort, [0, 0, 0]);
    assert.deepEqual(run.restoredPort, farCell);
    assert.deepEqual(run.initialWork, {
      threads,
      soilCells: 0,
      rainMeltCells: 0,
      routedCells: 0,
      workers: Array.from({ length: threads }, () => ({ soilCells: 0, rainMeltCells: 0 })),
    });
    verifySpans(count, threads, run.work);
    assert.deepEqual(run.replayWork, run.work);
    checkLedger(run, count);
  }
  console.log('HYDRO-02 91-cell replay', base.final.hash, 'ledgers', base.settled.budget);
});

test('Four runoff threads produce exact odd-grid SIMD tail counts with ordered, unchanged routing', async () => {
  for (const grid of [
    [129, 97],
    [257, 193],
  ]) {
    const count = grid[0] * grid[1];
    let expected;
    for (const threads of [1, 4]) {
      using runoff = await RainfallRunoff.load({ ...setupRain(), threads });
      const { world, summary } = makeCatchment(runoff, grid, true);
      try {
        world.advance(9);
        const work = runoff.workCounts();
        verifySpans(count, threads, work);
        const accepted = world.takeSnapshot();
        const state = summary();
        assert.ok(state.wet > 0 && state.wet < count && state.budget.outflow > 0);
        const rain = authoredInput(grid, 9).rain;
        // The largest sum adds one contribution per cell on each hydraulic tick.
        assert.ok(Math.abs(state.budget.rain - rain) <= 9 * count * Number.EPSILON * rain);
        if (threads === 1) expected = accepted;
        else {
          assert.equal(accepted.hash, expected.hash);
          assert.deepEqual(accepted.bytes, expected.bytes);
          console.log(
            'HYDRO-02 four-worker cells',
            count,
            work.workers.map(({ soilCells }) => soilCells),
          );
        }
      } finally {
        world.remove('runoff');
      }
    }
  }
});

const cell = { nx: 1, nz: 1, dx: 1, downstream: [-1], conductivity: 0, slope: 0 };
const remedy = (message) => ({ name: 'MargoError', code: 'state', message });

test('Runoff thread setup and disposal give coded remedies', async () => {
  for (const threads of [0, 2.5, 65, Infinity])
    await assert.rejects(RainfallRunoff.load({ threads }), remedy(/threads/i));
  using runoff = await RainfallRunoff.load({ threads: 2 });
  assert.throws(() => new PhysicsWorld({ rate, memory: worldMemory(false) }).add(runoff, cell), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Use worldMemory\(true\).*threads: 1/i,
  });
  using live = await RainfallRunoff.load({ threads: 2 });
  const world = new PhysicsWorld({ rate, memory: worldMemory(true) }).add(live, cell);
  try {
    world.advance(1);
    const tick = world.tick;
    live[Symbol.dispose]();
    assert.throws(() => world.advance(2), remedy(/disposed.*load|load.*new.*solver/i));
    assert.equal(world.tick, tick);
  } finally {
    world.remove('runoff');
  }
});

test('A parallel candidate with a cumulative overflow keeps the accepted runoff fields and work counts', async () => {
  using runoff = await RainfallRunoff.load({ threads: 4 });
  const world = new PhysicsWorld({ rate, memory: worldMemory(true) }).add(runoff, {
    ...cell,
    nx: 5,
    dx: 100,
    downstream: [-1, -1, -1, -1, -1],
    rainRate: [0, 0, 1e305, 0, 0],
  });
  try {
    world.advance(10);
    const tick = world.tick;
    const snapshot = world.takeSnapshot();
    const accepted = () => runoff.stateRegions().map((region) => regionWords(world.memory, region).slice());
    const before = accepted();
    const work = runoff.workCounts();
    assert.ok(runoff.budget.rain > 1.6e308);
    assert.throws(() => world.advance(11), remedy(/finite water or flow range.*Use compatible grid/i));
    assert.equal(world.tick, tick);
    assert.deepEqual(accepted(), before);
    assert.deepEqual(runoff.workCounts(), work);
    world.restoreSnapshot(snapshot.bytes);
    assert.deepEqual(world.takeSnapshot().bytes, snapshot.bytes);
  } finally {
    world.remove('runoff');
  }
});
