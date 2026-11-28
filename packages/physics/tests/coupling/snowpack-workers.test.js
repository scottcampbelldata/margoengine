import assert from 'node:assert/strict';
import test from 'node:test';
import { Snowpack } from '../../dist/snowpack.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedCell, followSnowpack, layerCount } from '../fixtures/snowpack-workers.mjs';

function checkWork(work, columns, threads) {
  const pairs = Math.floor(columns / 2);
  assert.equal(work.threads, threads);
  assert.equal(work.columns, columns);
  assert.equal(work.layers, columns * layerCount);
  assert.ok(work.conductionInterfaces > 3 * columns);
  assert.ok(work.pairedInterfaces > work.conductionInterfaces * 0.85);
  assert.ok(work.pairedInterfaces < work.conductionInterfaces); // Unmatched layers and the odd column used scalar.
  assert.equal(work.bisectionIterations, 54 * work.conductionInterfaces);
  assert.equal(work.workers.length, threads);
  for (const [part, worker] of work.workers.entries()) {
    const begin = Math.floor((part * pairs) / threads) * 2;
    const end = Math.floor(((part + 1) * pairs) / threads) * 2 + (part + 1 === threads ? columns % 2 : 0);
    assert.equal(worker.columns, end - begin);
    assert.equal(worker.layers, worker.columns * layerCount);
    assert.ok(worker.pairedInterfaces > 0);
    assert.equal(worker.pairedInterfaces % 2, 0);
    assert.equal(worker.bisectionIterations, 54 * worker.conductionInterfaces);
  }
}

for (const [width, depth] of [[17, 13], [19, 15]]) {
  test('ICE-01 ordered drift and paired thermal solves replay exactly on ' + width + '×' + depth + ' signed columns', async () => {
    const baseline = await followSnowpack(width, depth, 1);
    const { state, work } = baseline.accepted;
    assert.deepEqual(baseline.replay, baseline.accepted);
    assert.ok(state.wet.runoff > 0 && state.wet.runoffHeat > 0);
    assert.ok(state.cliff.corniceMass > 0);
    for (const port of Object.values(state.fields)) assert.deepEqual(port.cell, expectedCell);
    for (const [threads, shared] of [[1, true], [2, true], [4, true]]) {
      const result = await followSnowpack(width, depth, threads, shared);
      assert.deepEqual(result.accepted.state, state);
      assert.deepEqual(result.replay, result.accepted);
      for (const [frame, receipt] of result.accepted.work.entries()) {
        checkWork(receipt, width * depth, threads);
        const { threads: _one, workers: _serial, ...counts } = work[frame];
        const { threads: _many, workers: _parallel, ...sameCounts } = receipt;
        assert.deepEqual(sameCounts, counts);
      }
    }
    checkWork(work.at(-1), width * depth, 1);
  });
}

test('ICE-01 validates native options and closes helpers that cannot attach to a plain world', async () => {
  await assert.rejects(Snowpack.load({ threads: 3 }), /Choose 1, 2 or 4.*#snowpack/);
  using pack = await Snowpack.load({ threads: 2 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(() => world.add(pack, { width: 1, depth: 1 }), /Use shared world memory.*#snowpack/);
});
