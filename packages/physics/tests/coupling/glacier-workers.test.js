import assert from 'node:assert/strict';
import test from 'node:test';
import { GlacierSolver } from '../../dist/glacier.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedCell, followGlacier } from '../fixtures/glacier-workers.mjs';

function checkWork(work, n, threads) {
  assert.equal(work.threads, threads);
  assert.equal(work.weightsRows, n);
  assert.equal(work.fractureRows, n);
  assert.ok(work.faceWeights > 1.6 * n);
  assert.ok(work.pairedFaceWeights > 0.85 * work.faceWeights);
  assert.ok(work.pairedFaceWeights < work.faceWeights);
  assert.ok(work.crevasseRoots > 0.5 * n);
  assert.equal(work.workers.length, threads);
  for (const [part, worker] of work.workers.entries()) {
    const start = Math.floor((part * n) / threads);
    const end = Math.floor(((part + 1) * n) / threads);
    assert.equal(worker.weightsRows, end - start);
    assert.equal(worker.fractureRows, worker.weightsRows);
    assert.ok(worker.pairedFaceWeights > 0);
    assert.equal(worker.pairedFaceWeights % 2, 0);
    assert.ok(worker.crevasseRoots > 0);
  }
}

for (const [nx, nz] of [[23, 19], [27, 21]]) {
  test('ICE-02 native face conductance, fracture and signed replay agree on ' + nx + '×' + nz + ' cells', async () => {
    const baseline = await followGlacier(nx, nz, 1);
    const { state, work } = baseline.accepted;
    assert.deepEqual(baseline.replay, baseline.accepted);
    const { ice, accumulation, melted, calved, fallen } = state.budget;
    assert.ok(accumulation > 0 && melted > 0 && calved > 0);
    assert.ok(state.midSlope.crevasseDepth > 0 && state.midSlope.velocity[0] > 0);
    const observed = ice + melted + calved + fallen;
    const expected = state.initialVolume + accumulation;
    const rounding = 7 * (nx * nz) * 32 * Number.EPSILON * expected;
    assert.ok(Math.abs(observed - expected) <= rounding);
    assert.ok(state.ports['glacier.meltwater'].words.some((discharge) => discharge > 0));
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, expectedCell);
    for (const [threads, shared] of [[1, true], [2, true], [4, true]]) {
      const result = await followGlacier(nx, nz, threads, shared);
      assert.deepEqual(result.accepted.state, state);
      assert.deepEqual(result.replay, result.accepted);
      for (const [frame, receipt] of result.accepted.work.entries()) {
        checkWork(receipt, nx * nz, threads);
        const { threads: _one, workers: _serial, ...counts } = work[frame];
        const { threads: _many, workers: _parallel, ...sameCounts } = receipt;
        assert.deepEqual(sameCounts, counts);
      }
    }
  });
}

test('ICE-02 validates helper options and records an idle flow phase for a paused one-cell glacier', async () => {
  await assert.rejects(GlacierSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#glacier/);
  const params = { nx: 1, nz: 1, dx: 3, bed: [15], thickness: [150], timeScale: 0 };
  using rejected = await GlacierSolver.load({ threads: 2 });
  const plain = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(() => plain.add(rejected, params), /Use shared world memory.*#glacier/);

  using ice = await GlacierSolver.load({ threads: 4 });
  const shared = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
  shared.add(ice, params);
  shared.advance(1);
  const work = ice.readNativeWork();
  const zero = { weightsRows: 0, faceWeights: 0, pairedFaceWeights: 0, fractureRows: 0, crevasseRoots: 0 };
  assert.deepEqual(work.workers, [zero, zero, zero, { ...zero, fractureRows: 1 }]);
  assert.equal(ice.sample(0, 0).thickness, 150);
});
