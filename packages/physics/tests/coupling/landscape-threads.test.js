import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { LandscapeEvolution } from '../../dist/landscape.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { farCell, rate, runValley, size } from '../fixtures/landscape-threads-case.mjs';

const span = (n, part, threads) => [Math.floor((part * n) / threads), Math.floor(((part + 1) * n) / threads)];

function checkWork(work, count, threads, links) {
  assert.equal(work.threads, threads);
  assert.equal(work.preparedVertices, count);
  assert.equal(work.routedVertices, count);
  assert.equal(work.downhillLinks, links);
  assert.equal(work.workers.length, threads);
  assert.equal(
    work.workers.reduce((sum, entry) => sum + entry.downhillLinks, 0),
    links,
  );
  for (const [part, worker] of work.workers.entries()) {
    const [first, last] = span(count, part, threads);
    assert.equal(worker.preparedVertices, last - first);
    assert.ok(worker.downhillLinks > 0);
  }
}

test('Landscape threads keep the accepted valley, both grains and far-cell replay byte exact', async () => {
  const base = await runValley(false);
  const count = size[0] * size[1];
  for (const [shared, threads] of [
    [false, 1],
    [true, 1],
    [true, 2],
    [true, 4],
  ]) {
    const run = shared ? await runValley(shared, threads) : base;
    assert.deepEqual(run.start.bytes, base.start.bytes);
    assert.deepEqual(run.checkpoint.bytes, base.checkpoint.bytes);
    assert.deepEqual(run.final.bytes, base.final.bytes);
    assert.equal(run.final.hash, base.final.hash);
    assert.equal(run.replayed, true);
    assert.deepEqual(run.beforeShiftCell, farCell);
    assert.deepEqual(run.physical.terrainCell, [0, 0, 0]);
    assert.deepEqual(run.physical.fieldCell, [0, 0, 0]);
    assert.deepEqual(run.coldWork, {
      threads,
      preparedVertices: 0,
      downhillLinks: 0,
      routedVertices: 0,
      workers: Array.from({ length: threads }, () => ({ preparedVertices: 0, downhillLinks: 0 })),
    });
    checkWork(run.work, count, threads, base.work.downhillLinks);
    assert.deepEqual(run.replayWork, run.work);
    assert.deepEqual(run.physical, base.physical);
  }

  const p = base.physical;
  assert.equal(p.elapsedYears, 5400);
  assert.equal(p.fixedOutlet, true);
  assert.ok(p.maximumRise > 1 && p.maximumFall < -1);
  assert.ok(p.discharge > 0 && p.incision > 0 && p.sediment > 0 && p.outletDischarge > 0);
  assert.equal(p.budget.exported.length, 2);
  assert.ok(p.budget.exported.every((value) => Number.isFinite(value) && value > 0));
  assert.ok(p.budget.alluvium > 0);
  const exported = p.budget.exported.reduce((sum, value) => sum + value, 0);
  const tolerance = 16 * count * 54 * Number.EPSILON * p.volume;
  assert.ok(Math.abs(p.budget.uplift - p.expectedUplift) <= tolerance);
  assert.ok(Math.abs(p.volume - p.volume0 + p.pendingVolume + exported - p.expectedUplift) <= tolerance);
  console.log(
    'HYDRO-04',
    count,
    'vertex valley',
    base.final.hash,
    'with',
    base.work.downhillLinks,
    'ordered links, exported',
    p.budget.exported,
  );
});

test('Four landscape threads scale exact downhill links on an east-sloping plane and retain ordered accepted routing', async () => {
  for (const [nx, nz] of [
    [129, 97],
    [257, 193],
  ]) {
    const count = nx * nz;
    const links = (nx - 1) * (3 * nz - 2);
    const grid = { columns: nx - 1, rows: nz - 1, width: 12 * (nx - 1), depth: 8 * (nz - 1), centre: [0, 0] };
    const rainfall = 0.001;
    let serial;
    for (const threads of [1, 4]) {
      const terrain = new TerrainBed();
      using landscape = await LandscapeEvolution.load({ threads });
      const world = new PhysicsWorld({ rate, memory: worldMemory(true) })
        .add(terrain, { ...grid, elevations: (x) => 40 + (grid.width / 2 - x) / 16 })
        .add(landscape, {
          grid,
          rainfall,
          erodibility: 0,
          hillslopeDiffusivity: 0,
          thermalDiffusivity: 0,
          outlets: { maxX: true },
        });
      try {
        world.advance(1);
        const accepted = world.takeSnapshot();
        const work = landscape.workCounts();
        checkWork(work, count, threads, links);
        const expected = rainfall * grid.width * grid.depth;
        let outlet = 0;
        for (let r = 0; r < nz; r++) outlet += landscape.read(nx - 1, r).discharge;
        assert.ok(Math.abs(outlet - expected) <= 8 * count * Number.EPSILON * expected);
        for (const [part, worker] of work.workers.entries()) {
          const [first, last] = span(count, part, threads);
          let receiverCount = 0;
          for (let i = first; i < Math.min(last, count - nz); i++) {
            const row = i % nz;
            receiverCount += row === 0 || row === nz - 1 ? 2 : 3;
          }
          assert.equal(worker.downhillLinks, receiverCount);
        }
        if (threads === 1) serial = accepted;
        else {
          assert.equal(accepted.hash, serial.hash);
          assert.deepEqual(accepted.bytes, serial.bytes);
          console.log(
            'HYDRO-04 four-thread plane',
            count,
            'vertices and',
            links,
            'links',
            work.workers.map((part) => part.downhillLinks),
          );
        }
      } finally {
        world.remove('landscape');
      }
    }
  }
});

const grid = { columns: 1, rows: 1, width: 1, depth: 1, centre: [0, 0] };
const remedy = (message) => ({ name: 'MargoError', code: 'state', message });
const zeroProcesses = { rainfall: 0, erodibility: 0, hillslopeDiffusivity: 0, thermalDiffusivity: 0, alluvialDepth: 0 };

test('Threaded landscape setup and disposal report coded remedies', async () => {
  for (const threads of [0, 2.5, 65, Infinity])
    await assert.rejects(LandscapeEvolution.load({ threads }), remedy(/threads/i));
  using landscape = await LandscapeEvolution.load({ threads: 2 });
  assert.throws(() => new PhysicsWorld({ rate, memory: worldMemory(false) }).add(landscape, { grid }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Use worldMemory\(true\).*threads: 1/i,
  });
  using live = await LandscapeEvolution.load({ threads: 2 });
  const world = new PhysicsWorld({ rate, memory: worldMemory(true) })
    .add(new TerrainBed(), { ...grid, elevations: [3, 2, 1, 0] })
    .add(live, { grid, ...zeroProcesses });
  try {
    world.advance(1);
    const tick = world.tick;
    live[Symbol.dispose]();
    assert.throws(() => world.advance(2), remedy(/disposed.*load|load.*new.*solver/i));
    assert.equal(world.tick, tick);
  } finally {
    world.remove('landscape');
  }
});
