import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { LavaSolver } from '../../dist/lava.js';
import { TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const cells = [17, 11];
const coastCell = [400_000, 0, -700_000];
const terrain = { columns: cells[0], rows: cells[1], width: cells[0], depth: cells[1], centre: [8.5, 5.5] };
const bed = (x, z) => (x < 6 ? 0.2 : -0.75) + 0.008 * (z - 5.5);
const vent = { cell: [5, 5], flow: 8, start: 0.007, end: 0.638, temperature: 1450 };

function checkWork(lava, [nx, nz], threads, transport) {
  const { microsteps, boundCells, transportFaces, localCells, workers, threads: usedThreads } = lava.workCounts();
  const count = nx * nz;
  const span = (n, part) => Math.floor(((part + 1) * n) / threads) - Math.floor((part * n) / threads);
  assert.equal(usedThreads, threads);
  assert.ok(Number.isSafeInteger(microsteps) && microsteps > 0);
  assert.equal(boundCells, count * microsteps);
  assert.equal(localCells, count * microsteps);
  const faces = transport === 'terminal' ? 2 * count - nx - nz : 2 * count + nx + nz;
  assert.equal(transportFaces, faces * microsteps);
  const expected = Array.from({ length: threads }, (_, part) => {
    let faces = span(nz, part) * (nx + 1) + span(nx, part) * (nz + 1);
    if (transport === 'terminal') {
      faces = 0;
      const start = Math.floor((part * count) / threads);
      const end = start + span(count, part);
      for (let i = start; i < end; i++) {
        if (i % nx < nx - 1) faces++;
        if (i < count - nx) faces++;
      }
    }
    return {
      boundCells: span(count, part) * microsteps,
      transportFaces: faces * microsteps,
      localCells: span(count, part) * microsteps,
    };
  });
  assert.deepEqual(workers, expected);
  assert.ok(workers.every((part) => part.boundCells > 0 && part.transportFaces > 0 && part.localCells > 0));
}

async function coast(t, shared, threads, transport) {
  const lava = await LavaSolver.load({ terrain, threads });
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) });
  t.after(() => {
    world.remove('lava');
    lava[Symbol.dispose]();
  });
  const sea = await TsunamiSolver.load({ sources: [lava.seaSourceField] });
  const bathymetry = Array.from({ length: cells[0] * cells[1] }, (_, i) =>
    bed((i % cells[0]) + 0.5, Math.floor(i / cells[0]) + 0.5),
  );
  world
    .add(new TerrainBed(), { ...terrain, elevations: bed }, coastCell)
    .add(
      lava,
      {
        cells,
        spacing: 1,
        transport,
        bed: 0.2,
        seaLevel: 0,
        viscosity: 150,
        yieldStrength: 0,
        vents: [vent],
      },
      coastCell,
    )
    .add(sea, { cells, spacing: 1, bathymetry }, coastCell);
  return { world, lava, sea, threads: threads ?? 1, transport };
}

function sameAccepted(lanes) {
  const first = lanes[0];
  const { bytes, hash } = first.world.takeSnapshot();
  for (const { world, lava, sea } of lanes.slice(1)) {
    assert.equal(world.hash(), hash);
    assert.deepEqual(world.takeSnapshot().bytes, bytes);
    assert.deepEqual(lava.budget, first.lava.budget);
    assert.deepEqual(sea.budget, first.sea.budget);
  }
}

test('LavaSolver threads keep exact inertial and terminal state, coastal ledgers and floating-origin replay', async (t) => {
  const frame = 84;
  for (const transport of ['inertial', 'terminal']) {
    const lanes = [
      await coast(t, false, undefined, transport),
      await coast(t, true, 1, transport),
      await coast(t, true, 2, transport),
      await coast(t, true, 4, transport),
    ];
    sameAccepted(lanes);
    const saved = lanes.map(({ world }) => {
      world.advance(24);
      return world.takeSnapshot().bytes;
    });
    sameAccepted(lanes);

    const run = ({ world, lava, sea, threads }) => {
      world.shiftOrigin(coastCell);
      world.advance(frame);
      const b = lava.budget;
      const supplied = vent.flow * (vent.end - vent.start);
      // Each accepted tick sums and transfers the contributions of all cells.
      const roundoff = 64 * frame * cells[0] * cells[1] * Number.EPSILON;
      const near = (a, b) => assert.ok(Math.abs(a - b) <= roundoff * Math.max(1, Math.abs(b)));
      near(b.suppliedVolume, supplied);
      near(b.storedVolume, supplied);
      near(b.storedEnthalpy + b.environmentalHeat + b.iceHeat, b.suppliedEnthalpy);
      // A wave cell can be unable to remove the full signed displaced volume.
      near(sea.budget.admittedSourceVolume + sea.budget.unplacedSourceVolume, b.displacedWater);
      assert.ok(b.displacedWater > 0 && b.waterHeat > 0);
      assert.ok(lava.sample(7, 5).depth > 0 && lava.sample(5, 4).depth > 0);
      assert.deepEqual(lava.exportPorts(frame)[0].cell, [0, 0, 0]);
      checkWork(lava, cells, threads, transport);
    };
    for (const lane of lanes) run(lane);
    sameAccepted(lanes);
    const final = lanes.map(({ world, lava }) => ({ bytes: world.takeSnapshot().bytes, work: lava.workCounts() }));
    for (const [i, lane] of lanes.entries()) {
      lane.world.restoreSnapshot(saved[i]);
      run(lane);
      assert.deepEqual(lane.world.takeSnapshot().bytes, final[i].bytes);
      assert.deepEqual(lane.lava.workCounts(), final[i].work);
    }
  }
});

test('Four LavaSolver threads preserve an insulated slab and report deterministic grid-linear work', async (t) => {
  for (const [nx, nz] of [
    [129, 97],
    [257, 193],
  ]) {
    const lava = await LavaSolver.load({ threads: 4 });
    const world = new PhysicsWorld({ rate, memory: worldMemory(true) });
    t.after(() => {
      world.remove('lava');
      lava[Symbol.dispose]();
    });
    world.add(lava, {
      cells: [nx, nz],
      spacing: 1,
      bed: 0,
      depth: 0.125,
      temperature: 1450,
      conductivity: 0,
      emissivity: 0,
      convection: 0,
    });
    const start = world.takeSnapshot();
    world.advance(1);
    const work = lava.workCounts();
    const after = world.takeSnapshot();
    assert.equal(work.microsteps, 1);
    checkWork(lava, [nx, nz], 4, 'inertial');
    assert.equal(lava.budget.storedVolume, (nx * nz) / 8);
    assert.equal(lava.budget.storedEnthalpy, lava.budget.initialEnthalpy);
    for (const [x, z] of [
      [0, 0],
      [nx >> 1, nz >> 1],
      [nx - 1, nz - 1],
    ]) {
      const point = lava.sample(x, z);
      assert.equal(point.depth, 0.125);
      assert.equal(point.temperature, 1450);
      assert.ok(point.discharge.every((q) => Math.abs(q) <= 32 * Number.EPSILON));
    }
    world.restoreSnapshot(start.bytes);
    world.advance(1);
    assert.equal(world.hash(), after.hash);
    assert.deepEqual(world.takeSnapshot().bytes, after.bytes);
    assert.deepEqual(lava.workCounts(), work);
  }
});

test('Threaded lava rejects late publication overflow without replacing accepted fields or work', async (t) => {
  const lava = await LavaSolver.load({ threads: 4 });
  const world = new PhysicsWorld({ rate, memory: worldMemory(true) });
  t.after(() => {
    world.remove('lava');
    lava[Symbol.dispose]();
  });
  world.add(lava, {
    cells: [1, 1],
    depth: 0.5,
    spacing: 1e100,
    density: 1e100,
    heatCapacity: 1e6,
    latentHeat: 0,
    solidus: 50,
    liquidus: 100,
    temperature: 200,
    bed: 0,
    seaLevel: 1,
    conductivity: 0,
    emissivity: 0,
    convection: 0,
    waterHeatTransfer: 0,
    vents: [{ cell: [0, 0], temperature: 200, flow: 3e201 }],
  });
  const snapshot = world.takeSnapshot();
  assert.ok(lava.budget.initialEnthalpy > 9.9e307);
  const accepted = () => lava.stateRegions().map((region) => regionWords(world.memory, region).slice());
  const state = accepted();
  const work = lava.workCounts();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => world.advance(1), {
      name: 'MargoError',
      code: 'state',
      message: /publication exceeds finite surface, source or budget range/,
    });
    assert.equal(world.tick, 0);
    assert.deepEqual(accepted(), state);
    assert.deepEqual(lava.workCounts(), work);
    world.restoreSnapshot(snapshot.bytes);
  }
});

test('LavaSolver gives coded errors for invalid threads, plain memory and disposed workers', async (t) => {
  for (const threads of [0, 1.5, 65, Infinity])
    await assert.rejects(LavaSolver.load({ threads }), { name: 'MargoError', code: 'state', message: /threads/i });

  const lava = await LavaSolver.load({ threads: 2 });
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  const options = { cells: [3, 3], spacing: 1, bed: 0, depth: 0.125 };
  t.after(() => lava[Symbol.dispose]());
  assert.throws(() => world.add(lava, options), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Use worldMemory\(true\).*threads: 1/,
  });

  const live = await LavaSolver.load({ threads: 2 });
  const shared = new PhysicsWorld({ rate, memory: worldMemory(true) });
  t.after(() => {
    shared.remove('lava');
    live[Symbol.dispose]();
  });
  shared.add(live, options);
  shared.advance(1);
  const tick = shared.tick;
  const region = live.exportPorts(1)[0].region;
  const previous = regionWords(shared.memory, region).slice();
  live[Symbol.dispose]();
  assert.throws(() => shared.advance(2), {
    name: 'MargoError',
    code: 'state',
    message: /disposed.*load|load.*new.*solver/i,
  });
  assert.equal(shared.tick, tick);
  assert.deepEqual(regionWords(shared.memory, region), previous);
});
