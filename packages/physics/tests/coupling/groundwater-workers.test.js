import assert from 'node:assert/strict';
import test from 'node:test';
import { GroundwaterSolver } from '../../dist/groundwater.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedCell, expectedFaces, followGroundwater } from '../fixtures/groundwater-workers.mjs';

function checkWork(receipt, nx, nz, threads) {
  const n = nx * nz;
  assert.equal(receipt.threads, threads);
  assert.equal(receipt.cells, n);
  assert.equal(receipt.workers.length, threads);
  const totals = expectedFaces(nx, nz, 0, n);
  assert.equal(receipt.faceConductances, totals.faceConductances);
  assert.equal(receipt.pairedFaceConductances, totals.pairedFaceConductances);
  for (const [part, worker] of receipt.workers.entries()) {
    const start = Math.floor((part * n) / threads);
    const end = Math.floor(((part + 1) * n) / threads);
    assert.equal(worker.cells, end - start);
    const counts = expectedFaces(nx, nz, start, end);
    assert.equal(worker.faceConductances, counts.faceConductances);
    assert.equal(worker.pairedFaceConductances, counts.pairedFaceConductances);
    assert.ok(worker.initialActiveSprings > 0 && worker.initialActiveSprings < worker.cells);
  }
}

for (const [nx, nz] of [[17, 13], [23, 17]]) {
  test('HYDRO-06 native anisotropic assembly and signed recharge replay agree on ' + nx + '×' + nz + ' cells', async () => {
    const baseline = await followGroundwater(nx, nz, 1);
    const { state, work } = baseline.accepted;
    assert.equal(baseline.replay.state.snapshot.hash, state.snapshot.hash);
    assert.deepEqual(baseline.replay, baseline.accepted);
    const { storage, recharge, boundaryIn, boundaryOut, spring, seepage } = state.budget;
    assert.ok(spring > 0 && seepage > 0 && boundaryIn > 0 && boundaryOut > 0 && recharge > 0);
    assert.ok(state.wet.thickness > 0, 'recharge wets the initially dry head row');
    assert.ok(state.ports['groundwater:springs'].words.some((q) => q > 0));
    assert.ok(state.ports['groundwater:seepage'].words.some((q) => q > 0));
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, expectedCell);
    const totalInput = state.initialStorage + recharge + boundaryIn;
    const accounted = storage + boundaryOut + spring + seepage;
    assert.ok(Math.abs(accounted - totalInput) < 7 * nx * nz * 32 * Number.EPSILON * totalInput);
    for (const [threads, shared] of [[1, true], [2, true], [4, true]]) {
      const actual = await followGroundwater(nx, nz, threads, shared);
      assert.equal(actual.accepted.state.snapshot.hash, state.snapshot.hash);
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      for (const [i, receipt] of actual.accepted.work.entries()) {
        checkWork(receipt, nx, nz, threads);
        assert.equal(receipt.initialActiveSprings, work[i].initialActiveSprings);
      }
    }
  });
}

test('HYDRO-06 validates native options and reports empty worker ranges on a single aquifer cell', async () => {
  await assert.rejects(GroundwaterSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#groundwater/);
  const params = { grid: { columns: 1, rows: 1, width: 2, depth: 1, centre: [0, 0] }, recharge: 0.001 };
  using rejected = await GroundwaterSolver.load({ threads: 2 });
  const plain = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(() => plain.add(rejected, params), /Use shared world memory.*#groundwater/);

  using aquifer = await GroundwaterSolver.load({ threads: 4 });
  const shared = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
  shared.add(aquifer, params);
  shared.advance(1);
  const { workers } = aquifer.readNativeWork();
  const zero = { cells: 0, faceConductances: 0, pairedFaceConductances: 0, initialActiveSprings: 0 };
  assert.deepEqual(workers, [zero, zero, zero, { ...zero, cells: 1 }]);
});
