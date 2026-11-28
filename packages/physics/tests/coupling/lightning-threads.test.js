import assert from 'node:assert/strict';
import test from 'node:test';
import { LIGHTNING_LAYOUT, LightningSolver } from '../../dist/lightning.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const originCell = [400_000, 0, -700_000];
const shiftedCell = [1, 0, -2];
const cellSize = 4096;
const size = [7, 9, 5];
const spacing = 40;
const sweeps = 13;
const charged = {
  size,
  spacing,
  origin: [13, 5, -9],
  cell: originCell,
  cellSize,
  cloudPotential: -1.2e6,
  charge: (x, _y, z) => 3e-11 * ((x - 133) / 120 + (z - 71) / 80),
  leaderSpeed: 4800,
  breakdown: { initiation: 350, propagation: 200 },
  tolerance: 1e-12,
  sweeps,
};

async function basin(t, shared, threads, params) {
  const lightning = await LightningSolver.load(threads === undefined ? undefined : { threads });
  const world = new PhysicsWorld({ rate, cellSize, seed: 67, memory: worldMemory(shared) });
  t.after(() => {
    world.remove('lightning');
    lightning[Symbol.dispose]();
  });
  world.add(lightning, params, params.cell);
  return { world, lightning, threads: threads ?? 1 };
}

function checkWork({ lightning, threads }, [nx, ny, nz], expectedSweeps) {
  const work = lightning.workCounts();
  assert.equal(work.threads, threads);
  assert.equal(work.sweeps, expectedSweeps);
  const rows = ny * nz;
  const pairsPerRow = Math.ceil(nx / 2);
  assert.equal(work.simdPairs, expectedSweeps * rows * pairsPerRow);
  assert.equal(work.haloCopies, expectedSweeps * 2 * ny * (nx + nz));
  const portions = Array.from({ length: threads }, (_, part) => {
    const from = Math.floor((rows * part) / threads);
    const to = Math.floor((rows * (part + 1)) / threads);
    return expectedSweeps * (to - from) * pairsPerRow;
  });
  assert.deepEqual(work.threadSimdPairs, portions);
  assert.equal(
    portions.reduce((sum, portion) => sum + portion, 0),
    work.simdPairs,
  );
  assert.ok(portions.every((portion) => portion > 0));
  return work;
}

function readPorts({ world, lightning }) {
  return [lightning.channelField, lightning.thunderField].map(({ name }) => {
    const port = world.fields.port(name);
    assert.ok(port);
    const { tick, cell, region } = port;
    assert.equal(region.layout, LIGHTNING_LAYOUT);
    return { tick, cell, words: regionWords(world.memory, region).slice() };
  });
}

function assertSameState(lanes) {
  const [reference, ...others] = lanes;
  const hash = reference.world.hash();
  const bytes = reference.world.takeSnapshot().bytes;
  for (const other of others) {
    assert.equal(other.world.hash(), hash);
    assert.deepEqual(other.world.takeSnapshot().bytes, bytes);
  }
}

test('Lightning threads preserve accepted bytes, shifted ports and replay for signed space charge', async (t) => {
  const lanes = [
    await basin(t, false, undefined, charged),
    await basin(t, true, 1, charged),
    await basin(t, true, 2, charged),
    await basin(t, true, 4, charged),
  ];
  assertSameState(lanes);
  for (const lane of lanes) {
    const { lightning } = lane;
    // Opposite charges at the same elevation bend the initial potential in opposite directions.
    const middleVoltage = charged.cloudPotential / 2;
    assert.ok(lightning.potentialAt(0, 4, 2) < middleVoltage);
    assert.ok(lightning.potentialAt(6, 4, 2) > middleVoltage);
    assert.equal(lightning.potentialAt(0, 0, 2), -0);
    assert.equal(lightning.potentialAt(6, 8, 2), charged.cloudPotential);
    assert.equal(lightning.status, 'pending');
    checkWork(lane, size, sweeps);

    lane.world.advance(1);
    assert.equal(lightning.status, 'growing');
    assert.equal(lightning.channel().count, 2);
    checkWork(lane, size, 2 * sweeps);
  }
  assertSameState(lanes);
  const inFlight = lanes.map(({ world }) => world.takeSnapshot().bytes);

  function finish(lane) {
    const { world, lightning } = lane;
    world.shiftOrigin(originCell.map((coordinate, axis) => coordinate - shiftedCell[axis]));
    world.advance(2);
    assert.deepEqual(world.cellOf('lightning'), shiftedCell);
    for (const port of readPorts(lane)) {
      assert.deepEqual(port.cell, shiftedCell);
      assert.equal(port.tick, 1);
    }
    assert.deepEqual(lightning.boltSource(2 / 60, [0, 0, 0]).offset, [cellSize, 0, -2 * cellSize]);
    checkWork(lane, size, 2 * sweeps);

    world.advance(160);
    assert.equal(lightning.status, 'grounded');
    assert.equal(lightning.flash.position[1], charged.origin[1]);
    const [{ words: channel }, { words: thunder }] = readPorts(lane);
    assert.equal(channel[0], lightning.channel().count);
    assert.equal(thunder[0], channel[0]);
    assert.ok(thunder[0] > 2);
    assert.ok(lightning.thunder().every(({ emissionTime }) => emissionTime > lightning.flash.time));
  }

  for (const lane of lanes) finish(lane);
  assertSameState(lanes);
  const accepted = lanes[0].world.takeSnapshot();

  for (const [i, lane] of lanes.entries()) {
    lane.world.restoreSnapshot(inFlight[i]);
    finish(lane);
    assert.equal(lane.world.hash(), accepted.hash);
    assert.deepEqual(lane.world.takeSnapshot().bytes, accepted.bytes);
  }
});

test('Lightning four-thread SIMD work scales with odd grid dimensions and keeps exact partition totals', async (t) => {
  const grids = [
    [17, 11, 13],
    [35, 13, 17],
  ];
  for (const dims of grids) {
    const params = { ...charged, size: dims, sweeps: 7, charge: (x) => (x < 253 ? -3e-11 : 3e-11) };
    const serial = await basin(t, true, 1, params);
    const parallel = await basin(t, true, 4, params);
    assertSameState([serial, parallel]);
    const work = checkWork(parallel, dims, 7);
    assert.equal(checkWork(serial, dims, 7).simdPairs, work.simdPairs);
    assert.ok(Math.max(...work.threadSimdPairs) - Math.min(...work.threadSimdPairs) <= 7 * Math.ceil(dims[0] / 2));
    assert.ok(parallel.lightning.residual > params.tolerance, 'These cases take every prescribed sweep');
  }
});

test('Lightning threads keep the last accepted fields and work when late return timing fails', async (t) => {
  // A one-node transit still fits f64. The return time along several nodes does not.
  const lane = await basin(t, true, 4, { size: [3, 8, 3], spacing: 1, returnSpeed: 3e-308 });
  const { world, lightning } = lane;
  const acceptedRegions = () =>
    lightning
      .stateRegions()
      .map(({ byteOffset, byteLength }) => new Uint8Array(world.memory.buffer, byteOffset, byteLength).slice());
  const regions = acceptedRegions();
  const ports = readPorts(lane);
  const work = lightning.workCounts();

  function reject(action) {
    assert.throws(action, {
      name: 'MargoError',
      code: 'state',
      message: /return-stroke delay exceeds numeric resolution/,
    });
    assert.equal(world.tick, 0);
    assert.equal(lightning.status, 'pending');
    assert.deepEqual(readPorts(lane), ports);
    assert.deepEqual(lightning.workCounts(), work);
    assert.deepEqual(acceptedRegions(), regions);
  }

  reject(() => world.advance(1));
  // advance records its requested frame in the world clock even if a solver
  // refuses the step. Settling that same owed step leaves the full snapshot intact.
  assert.equal(world.settled, false);
  const pending = world.takeSnapshot();
  reject(() => world.settle());
  assert.equal(world.hash(), pending.hash);
  assert.deepEqual(world.takeSnapshot().bytes, pending.bytes);
});

test('Lightning rejects unsupported thread counts and threaded use on plain memory with coded repairs', async () => {
  for (const threads of [0, 1.5, 65, Infinity])
    await assert.rejects(LightningSolver.load({ threads }), {
      name: 'MargoError',
      code: 'state',
      message: /whole number of lightning threads from 1 to 64/i,
    });

  const lightning = await LightningSolver.load({ threads: 2 });
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  try {
    assert.throws(() => world.add(lightning, { size }), {
      name: 'MargoError',
      code: 'unsupported',
      message: /shared-memory world or load with threads: 1/,
    });
    assert.equal(world.fields.port(lightning.channelField.name), undefined);
  } finally {
    lightning[Symbol.dispose]();
  }
});
