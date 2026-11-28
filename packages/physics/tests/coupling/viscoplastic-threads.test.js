import assert from 'node:assert/strict';
import test from 'node:test';
import { ViscoplasticSolver } from '../../dist/viscoplastic.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { injectedVolume, outletVolume, rate, runFlume, seedVolume } from '../fixtures/viscoplastic-threads-flume.mjs';

function checkWork(work, threads, substeps, occupied, pointVisits) {
  assert.equal(work.threads, threads);
  assert.equal(work.workers.length, threads);
  assert.equal(work.substeps, substeps);
  assert.equal(work.particleToGridPoints, pointVisits);
  assert.equal(work.gridToParticlePoints, pointVisits);
  assert.equal(work.occupiedNodeRows, occupied);
  for (const key of ['gridToParticlePoints', 'occupiedNodeRows']) {
    assert.equal(
      work.workers.reduce((sum, part) => sum + part[key], 0),
      work[key],
    );
    assert.ok(work.workers.every((part) => part[key] > 0));
  }
}

function checkEmpty(work, threads) {
  assert.equal(work.threads, threads);
  assert.equal(work.substeps, 0);
  assert.equal(work.particleToGridPoints, 0);
  assert.equal(work.gridToParticlePoints, 0);
  assert.equal(work.occupiedNodeRows, 0);
}

test('ViscoplasticSolver threads preserve the held/released material, real ground, and exact far-cell replay', async () => {
  const hashes = [];
  for (const solvent of [0, 3]) {
    const serial = await runFlume({ shared: false, solvent });
    for (const [shared, threads] of [
      [false, 1],
      [true, 1],
      [true, 2],
      [true, 4],
    ]) {
      const result = threads === 1 && !shared ? serial : await runFlume({ shared, threads, solvent });
      assert.deepEqual(result.initial.bytes, serial.initial.bytes);
      assert.deepEqual(result.checkpoint.bytes, serial.checkpoint.bytes);
      assert.deepEqual(result.bytes, serial.bytes);
      assert.equal(result.hash, serial.hash);
      assert.equal(result.replayed, true);
      assert.deepEqual(result.work, result.replayWork);
      checkEmpty(result.coldWork, threads);
      assert.deepEqual(result.budget, serial.budget);
      assert.ok(Object.values(result.budget).every(Number.isFinite));
      assert.deepEqual(result.portCell, [-1, 0, 0]);
      assert.ok(result.front > 0.65);
      assert.ok(result.minimumBedClearance >= -(2 ** -24) && result.minimumBedClearance < 0.01);
      assert.ok(result.inflow > 0 && result.inflow < injectedVolume);
      const total = seedVolume + injectedVolume;
      const tolerance = 128 * Number.EPSILON * total;
      assert.ok(Math.abs(result.budget.injectedReferenceVolume - injectedVolume) <= tolerance);
      assert.ok(Math.abs(result.budget.escapedReferenceVolume - outletVolume) <= tolerance);
      assert.ok(
        Math.abs(result.budget.storedReferenceVolume + result.budget.escapedReferenceVolume - total) <= tolerance,
      );
      const { substeps, activePoints, occupiedNodes } = result.budget;
      assert.ok(substeps === 2 && occupiedNodes > 0);
      checkWork(result.work, threads, substeps, serial.work.occupiedNodeRows, activePoints * substeps);
    }
    hashes.push(serial.hash);
    console.log(
      'FLUID-06 Newtonian solvent',
      solvent,
      'Pa s: flume hash',
      serial.hash,
      'with',
      serial.budget.activePoints,
      'active points.',
    );
  }
  assert.notEqual(hashes[0], hashes[1], 'implicit solvent viscosity must affect the accepted motion');
});

function slabPoints([nx, ny, nz], spacing) {
  const points = [];
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        for (const offset of [0.25, 0.375]) {
          points.push({
            position: [(x + offset) * spacing, (y + offset) * spacing, (z + offset) * spacing],
            velocity: [0.13 + x / 128, y / 256, -z / 512],
            volume: spacing ** 3 / 14,
          });
        }
      }
    }
  }
  // Odd capacity and unchanged quadratic stencil support on the final cell.
  points.pop();
  return points;
}

function span(count, part, parts) {
  return Math.floor(((part + 1) * count) / parts) - Math.floor((part * count) / parts);
}

test('Four viscoplastic threads distribute active transfers and exact quadratic-grid rows as workload grows', async () => {
  for (const cells of [
    [13, 10, 9],
    [19, 12, 15],
  ]) {
    const spacing = 0.25;
    const points = slabPoints(cells, spacing);
    const nodeCount = cells[0] * cells[1] * cells[2];
    const options = { cells, spacing, points, bulkModulus: 8000, shearModulus: 320 };
    let serial;
    for (const threads of [1, 4]) {
      using mud = await ViscoplasticSolver.load({ threads });
      const world = new PhysicsWorld({ rate, gravity: [0, 0, 0], memory: worldMemory(true) }).add(mud, options);
      try {
        world.advance(1);
        const work = mud.workCounts();
        checkWork(work, threads, 1, nodeCount, points.length);
        for (const [i, contribution] of work.workers.entries()) {
          assert.deepEqual(contribution, {
            gridToParticlePoints: span(points.length, i, threads),
            occupiedNodeRows: span(nodeCount, i, threads),
          });
        }
        const accepted = world.takeSnapshot();
        if (threads === 1) serial = accepted;
        else {
          assert.equal(accepted.hash, serial.hash);
          assert.deepEqual(accepted.bytes, serial.bytes);
          console.log(
            'FLUID-06 four-thread slab',
            work.gridToParticlePoints,
            'point transfers and',
            work.occupiedNodeRows,
            'occupied grid rows.',
          );
        }
      } finally {
        world.remove('viscoplastic');
      }
    }
  }
});

test('Threaded ViscoplasticSolver gives remedies for invalid count, plain memory, and disposed workers', async () => {
  for (const threads of [0, 1.5, 65, Infinity])
    await assert.rejects(ViscoplasticSolver.load({ threads }), {
      name: 'MargoError',
      code: 'state',
      message: /threads/i,
    });
  using mud = await ViscoplasticSolver.load({ threads: 2 });
  const plain = new PhysicsWorld({ rate, memory: worldMemory(false) });
  const options = { cells: [3, 3, 3], spacing: 1, points: [{ position: [1.5, 1.5, 1.5], volume: 0.01 }] };
  assert.throws(() => plain.add(mud, options), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Use worldMemory\(true\).*threads: 1/,
  });
  using live = await ViscoplasticSolver.load({ threads: 2 });
  const shared = new PhysicsWorld({ rate, memory: worldMemory(true) }).add(live, options);
  try {
    shared.advance(1);
    const tick = shared.tick;
    const region = live.exportPorts(1)[0].region;
    const previous = regionWords(shared.memory, region).slice();
    assert.equal(live.workCounts().gridToParticlePoints, 1);
    live[Symbol.dispose]();
    const disposed = {
      name: 'MargoError',
      code: 'state',
      message: /disposed.*load|load.*new.*solver/i,
    };
    assert.throws(() => shared.advance(2), disposed);
    assert.equal(shared.tick, tick);
    assert.deepEqual(regionWords(shared.memory, region), previous);
    assert.throws(() => live.workCounts(), disposed);
  } finally {
    shared.remove('viscoplastic');
  }
});
