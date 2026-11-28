import assert from 'node:assert/strict';
import test from 'node:test';
import { TSUNAMI_LAYOUT, TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const cells = [17, 11];
const spacing = 0.125;
const cellSize = 4096;
const coastCell = [400_000, 0, -700_000];
const sourceCell = [coastCell[0] + 1, coastCell[1], coastCell[2]];
const basin = {
  cells,
  spacing,
  bathymetry: Array.from(
    { length: cells[0] * cells[1] },
    (_, i) => -0.4 + (i % cells[0]) * 0.04 + Math.floor(i / cells[0]) * 0.01,
  ),
  open: [true, false, false, true],
  incoming: [(time) => incoming(time, 0.075, 0.27), undefined, undefined, (time) => incoming(time, 0.035, 0.16)],
  laminarBed: { kinematicViscosity: 1e-6, period: 20 },
};
const sourceField = {
  name: 'threaded-coastal-impulse',
  kind: 'bodySet',
  quantity: 'seaSource',
  unit: 'SI',
  centring: 'particle',
};
const injectedVolume = 1 / 512;
const withdrawnVolume = -1 / 2048;

function incoming(time, surface, speed) {
  const fraction = Math.min(1, time * 8);
  return { surface: fraction * surface, outwardVelocity: -fraction * speed };
}

class OffshoreImpulse {
  describe() {
    return {
      id: 'threaded-offshore-impulse',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: sourceField, access: 'write' }],
    };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate('impulse', 5 * Float64Array.BYTES_PER_ELEMENT, 'f64', TSUNAMI_LAYOUT);
  }

  importPorts() {}

  step({ tick }) {
    const row = regionWords(this.host.memory, this.region);
    // A smaller-than-cell radius centred on one submerged grid sample. The
    // producer is in the next origin cell, so the solver must relocate the row.
    const pressure = tick === 2 ? 120 : tick === 3 ? -75 : 0;
    const volume = tick === 2 ? injectedVolume : tick === 3 ? withdrawnVolume : 0;
    row.set([3.5 * spacing - cellSize, 3.5 * spacing, spacing / 4, pressure, volume]);
  }

  exportPorts(tick) {
    return [{ field: sourceField.name, region: this.region, tick, cell: this.host.cell }];
  }

  stateRegions() {
    return [this.region];
  }

  extraState() {
    return [];
  }
}

async function shoreline(t, shared, threads) {
  const tsunami = await TsunamiSolver.load({ threads, sources: [sourceField] });
  const world = new PhysicsWorld({ rate, cellSize, memory: worldMemory(shared) });
  t.after(() => {
    world.remove('tsunami');
    tsunami[Symbol.dispose]();
  });
  world.add(tsunami, basin, coastCell).add(new OffshoreImpulse(), {}, sourceCell);
  return { world, tsunami, threads: threads ?? 1 };
}

function checkWork({ tsunami, threads }) {
  const [nx, nz] = cells;
  const work = tsunami.workCounts();
  assert.equal(work.cells, nx * nz);
  assert.equal(work.threads, threads);
  assert.equal(work.substeps, tsunami.budget.substeps);
  // The two HLL sweeps in each of the two RK stages each include both edge
  // faces and all interior faces along a line.
  assert.equal(work.faceFluxes, 2 * (nz * (nx + 1) + nx * (nz + 1)) * work.substeps);
  const span = (n, i) => Math.floor((n * (i + 1)) / threads) - Math.floor((n * i) / threads);
  const byThread = Array.from(
    { length: threads },
    (_, i) => 2 * (span(nz, i) * (nx + 1) + span(nx, i) * (nz + 1)) * work.substeps,
  );
  assert.deepEqual(Array.from(work.threadFaceFluxes), byThread);
  assert.equal(
    byThread.reduce((sum, n) => sum + n, 0),
    work.faceFluxes,
  );
  assert.ok(byThread.every((n) => n > 0));
}

function equalAccepted(lanes) {
  const [reference, ...others] = lanes;
  const hash = reference.world.hash();
  const bytes = reference.world.takeSnapshot().bytes;
  for (const lane of others) {
    assert.equal(lane.world.hash(), hash);
    assert.deepEqual(lane.world.takeSnapshot().bytes, bytes);
    assert.deepEqual(lane.tsunami.budget, reference.tsunami.budget);
  }
}

test('TsunamiSolver threads preserve every accepted bit, split face work, and replay a relocated coastal inlet', async (t) => {
  const lanes = [
    await shoreline(t, false),
    await shoreline(t, true, 1),
    await shoreline(t, true, 2),
    await shoreline(t, true, 4),
  ];

  equalAccepted(lanes);
  for (const { tsunami, threads } of lanes) {
    assert.equal(tsunami.workCounts().threads, threads);
    assert.equal(tsunami.workCounts().substeps, 0);
    assert.equal(tsunami.workCounts().faceFluxes, 0);
    assert.equal(tsunami.budget.wetLandArea, 0);
  }

  const saved = lanes.map(({ world }) => {
    world.advance(2);
    return world.takeSnapshot().bytes;
  });
  equalAccepted(lanes);

  const finalFrame = 84;
  function evolve({ world, tsunami, threads }) {
    world.shiftOrigin(coastCell);
    world.advance(3);
    assert.equal(tsunami.budget.admittedSourceVolume, injectedVolume);
    world.advance(4);
    assert.equal(tsunami.budget.admittedSourceVolume, injectedVolume + withdrawnVolume);

    let substeps = 0;
    for (let frame = 5; frame <= finalFrame; frame++) {
      world.advance(frame);
      substeps += tsunami.budget.substeps;
    }

    const budget = tsunami.budget;
    assert.ok(budget.substeps > 1, 'the receipt covers multiple CFL substeps in a tick');
    assert.ok(budget.wetLandArea > 0);
    assert.ok(budget.runup > 0);
    assert.ok(budget.boundaryExportVolume < 0, 'the ledger records boundary inflow as negative export');
    assert.equal(budget.admittedSourceVolume, injectedVolume + withdrawnVolume);
    assert.equal(budget.unplacedSourceVolume, 0);

    const expected = budget.initialVolume + injectedVolume + withdrawnVolume - budget.boundaryExportVolume;
    const volumeRoundoff = 64 * (substeps + cells[0] * cells[1]) * Number.EPSILON * expected;
    assert.ok(Math.abs(budget.storedVolume - expected) <= volumeRoundoff);

    const port = tsunami.exportPorts(finalFrame)[0];
    assert.deepEqual(port.cell, [0, 0, 0]);
    assert.equal(port.tick, finalFrame);
    let dry = 0;
    for (let z = 0; z < cells[1]; z++) {
      for (let x = 0; x < cells[0]; x++) {
        const sample = tsunami.sample(x, z);
        assert.ok(Number.isFinite(sample.depth) && sample.depth >= 0);
        assert.ok(sample.discharge.every(Number.isFinite));
        if (sample.depth === 0) dry++;
      }
    }
    assert.ok(dry > 0, 'land above the run-up is still dry');
    checkWork({ tsunami, threads });
  }

  for (const lane of lanes) evolve(lane);
  equalAccepted(lanes);
  const completed = lanes[0].world.takeSnapshot().bytes;

  for (const [i, lane] of lanes.entries()) {
    lane.world.restoreSnapshot(saved[i]);
    evolve(lane);
  }
  equalAccepted(lanes);
  assert.deepEqual(lanes[0].world.takeSnapshot().bytes, completed);
});

test('TsunamiSolver four-thread face work grows with grid area and keeps a large lake at rest', async (t) => {
  for (const [nx, nz] of [
    [129, 97],
    [257, 193],
  ]) {
    const tsunami = await TsunamiSolver.load({ threads: 4 });
    const world = new PhysicsWorld({ rate, memory: worldMemory(true) });
    t.after(() => {
      world.remove('tsunami');
      tsunami[Symbol.dispose]();
    });
    const bathymetry = Array.from({ length: nx * nz }, (_, i) => {
      const x = i % nx;
      const z = Math.floor(i / nx);
      return -0.25 - ((3 * x + 5 * z) % 17) / 32;
    });
    world.add(tsunami, { cells: [nx, nz], spacing: 1, bathymetry });
    const start = world.takeSnapshot();
    world.advance(1);

    const work = tsunami.workCounts();
    assert.equal(work.substeps, 1);
    assert.equal(work.cells, nx * nz);
    assert.equal(work.threads, 4);
    // Two RK stages, each with two outgoing faces per cell and one last
    // boundary face per complete row or column.
    assert.equal(work.faceFluxes, 4 * nx * nz + 2 * (nx + nz));
    const counts = Array.from(work.threadFaceFluxes);
    assert.equal(counts.length, 4);
    assert.equal(
      counts.reduce((sum, n) => sum + n, 0),
      work.faceFluxes,
    );
    assert.ok(counts.every((n) => n > 0));
    // With an even split to within one row and one column, each extra
    // line costs at most its number of faces in both RK stages.
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 2 * (nx + nz + 2));

    for (let i = 0; i < bathymetry.length; i++) {
      const row = tsunami.sample(i % nx, Math.floor(i / nx));
      assert.equal(row.depth, -bathymetry[i]);
      // The reconstructed hydrostatic forces cancel at rest up to
      // roundoff in the four face contributions and the two RK stages.
      assert.ok(row.discharge.every((q) => Math.abs(q) <= 32 * Number.EPSILON));
    }
    assert.equal(tsunami.budget.storedVolume, tsunami.budget.initialVolume);

    const hash = world.hash();
    world.restoreSnapshot(start.bytes);
    world.advance(1);
    assert.equal(world.hash(), hash);
    assert.deepEqual(tsunami.workCounts(), work);
  }
});

test('TsunamiSolver rejects invalid thread counts and parallel execution on plain memory with coded errors', async (t) => {
  for (const threads of [0, 1.5, Infinity]) {
    await assert.rejects(TsunamiSolver.load({ threads }), { name: 'MargoError', code: 'state', message: /thread/i });
  }
  const tsunami = await TsunamiSolver.load({ threads: 2 });
  t.after(() => tsunami[Symbol.dispose]());
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  assert.throws(() => world.add(tsunami, basin), {
    name: 'MargoError',
    code: 'unsupported',
    message: /shared.*(?:memory|world)|(?:memory|world).*shared/i,
  });
});

test('TsunamiSolver disposal rejects further worker ticks without publishing candidate water', async (t) => {
  const { world, tsunami } = await shoreline(t, true, 2);
  world.advance(4);
  const tick = world.tick;
  const port = tsunami.exportPorts(4)[0];
  const accepted = () => regionWords(world.memory, port.region);
  const before = accepted().slice();

  tsunami[Symbol.dispose]();
  assert.throws(() => world.advance(5), {
    name: 'MargoError',
    code: 'state',
    message: /load.*solver/i,
  });
  assert.equal(world.tick, tick);
  assert.deepEqual(accepted(), before);
});
