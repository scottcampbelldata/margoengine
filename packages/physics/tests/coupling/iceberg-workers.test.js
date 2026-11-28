import assert from 'node:assert/strict';
import test from 'node:test';
import { IcebergSolver } from '../../dist/iceberg.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedCell, followIcebergs } from '../fixtures/iceberg-workers.mjs';

function checkWork(work, active, count, threads) {
  assert.equal(work.threads, threads);
  assert.equal(work.rows, count);
  assert.ok(work.activeRows > active && work.activeRows < count);
  assert.ok(work.substeps > 2 * work.activeRows);
  assert.equal(work.wrenchEvaluations, 2 * work.substeps + work.activeRows);
  assert.ok(work.pairedPanelDots >= 12 * work.wrenchEvaluations);
  assert.equal(work.workers.length, threads);
  for (const [part, worker] of work.workers.entries()) {
    const start = Math.floor((part * count) / threads);
    const end = Math.floor(((part + 1) * count) / threads);
    assert.equal(worker.rows, end - start);
    assert.ok(worker.activeRows > 0);
    assert.ok(worker.substeps >= worker.activeRows);
    assert.equal(worker.wrenchEvaluations, 2 * worker.substeps + worker.activeRows);
    assert.ok(worker.pairedPanelDots >= 12 * worker.wrenchEvaluations);
  }
}

for (const [active, slots] of [[233, 26], [349, 36]]) {
  const count = active + slots;
  test('ICE-03 native adaptive work and signed replay agree on ' + count + ' mixed body rows', async () => {
    const baseline = await followIcebergs(active, slots, 1);
    const { state, work } = baseline.accepted;
    assert.deepEqual(baseline.replay, baseline.accepted);
    assert.ok(state.budget.calved > 0 && state.budget.melted > 0);
    assert.ok(state.first.melted > 0);
    assert.ok(state.firstCalved.displaced > 0);
    assert.deepEqual(state.empty.size, [0, 0, 0]);
    assert.ok(state.ports['iceberg.waveVolume'].words.some((x) => x < 0));
    assert.ok(state.ports['iceberg.waveVolume'].words.some((x) => x > 0));
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, expectedCell);
    for (const [threads, shared] of [[1, true], [2, true], [4, true]]) {
      const result = await followIcebergs(active, slots, threads, shared);
      assert.deepEqual(result.accepted.state, state);
      assert.deepEqual(result.replay, result.accepted);
      for (const [frame, receipt] of result.accepted.work.entries()) {
        checkWork(receipt, active, count, threads);
        const { threads: _one, workers: _serial, ...counts } = work[frame];
        const { threads: _many, workers: _parallel, ...sameCounts } = receipt;
        assert.deepEqual(sameCounts, counts);
      }
    }
  });
}

test('ICE-03 guards helper setup and leaves empty native ranges with zero recorded work', async () => {
  await assert.rejects(IcebergSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#iceberg/);
  using rejected = await IcebergSolver.load({ threads: 2 });
  const plain = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(() => plain.add(rejected, { bodies: [{ size: [1, 4, 3] }] }), /Use shared world memory.*#iceberg/);

  using berg = await IcebergSolver.load({ threads: 4 });
  const shared = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
  shared.add(berg, { bodies: [{ size: [1, 4, 3] }] });
  shared.advance(1);
  const work = berg.readNativeWork();
  const zero = { rows: 0, activeRows: 0, substeps: 0, wrenchEvaluations: 0, pairedPanelDots: 0 };
  assert.deepEqual(work.workers.slice(0, 3), [zero, zero, zero]);
  assert.equal(work.workers[3].activeRows, 1);
  assert.ok(work.workers[3].pairedPanelDots > 0);
});
