import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushShellSolver } from '../../dist/crush.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { followCrushShell, rebasedCell, shellSheet } from '../fixtures/crush-shell-workers.mjs';

for (const withPressure of [false, true]) {
  test(`shell participants preserve accepted panel state under ${withPressure ? 'Hill plasticity and pressure' : 'isotropic membrane stretch'}`, async () => {
    const plain = await followCrushShell(1, false, withPressure);
    const pairs = Math.floor(plain.faceCount / 2);
    assert.equal(plain.faceCount % 2, 1);
    assert.deepEqual(plain.cell, rebasedCell);
    assert.ok(plain.budget.plasticDissipation > 0);
    assert.ok(plain.receipts.some(({ plasticReturns }) => plasticReturns > 0));
    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const run = threads === 1 && !shared ? plain : await followCrushShell(threads, shared, withPressure);
      assert.deepEqual(run.accepted, plain.accepted);
      assert.deepEqual(run.positions, plain.positions);
      assert.deepEqual(run.budget, plain.budget);
      assert.deepEqual(run.work, plain.work);
      assert.deepEqual(run.cell, rebasedCell);
      assert.deepEqual(run.accepted, run.replay.accepted);
      assert.deepEqual(run.positions, run.replay.positions);
      assert.deepEqual(run.receipts, run.replay.receipts);
      assert.equal(run.receipts.at(-1).forceEvaluations, run.work.substeps + 1);
      for (const [tick, receipt] of run.receipts.entries()) {
        assert.equal(receipt.threads, threads);
        assert.equal(receipt.faces, receipt.forceEvaluations * run.faceCount);
        assert.equal(receipt.pairedFaces, threads === 1 ? 0 : 2 * pairs * receipt.forceEvaluations);
        assert.equal(receipt.plasticReturns, plain.receipts[tick].plasticReturns);
        assert.equal(receipt.pressureFaces, run.pressureFaceCount * receipt.forceEvaluations);
        for (const [part, worker] of receipt.workers.entries()) {
          const ownPairs = Math.floor(((part + 1) * pairs) / threads) - Math.floor((part * pairs) / threads);
          assert.equal(worker.forceEvaluations, receipt.forceEvaluations);
          assert.equal(worker.faces, (2 * ownPairs + Number(part === threads - 1)) * receipt.forceEvaluations);
          assert.equal(worker.pairedFaces, threads === 1 ? 0 : 2 * ownPairs * receipt.forceEvaluations);
          if (withPressure) assert.ok(worker.pressureFaces > 0);
        }
      }
    }
  });
}

test('crush shell rejects unsupported participant counts with a fix', async () => {
  await assert.rejects(CrushShellSolver.load({ threads: 3 }), {
    name: 'MargoError',
    message: /Choose 1, 2 or 4 crush shell participants.*#ductile-crush/,
  });
});

test('rejected finite-geometry trial keeps accepted four-participant state and work', async () => {
  using shell = await CrushShellSolver.load({ threads: 4 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true), gravity: [0, 0, 0] });
  world.add(shell, {
    ...shellSheet(5, 3),
    material: { thickness: 0.015, density: 7800, youngModulus: 200e6, poissonRatio: 0.3, yieldStress: 350e3 },
  });
  world.advance(1);
  const accepted = world.takeSnapshot();
  const receipt = shell.readNativeWork();
  assert.ok(receipt.workers.every(({ pairedFaces }) => pairedFaces > 0));
  const mesh = shell.readMesh();
  const budget = shell.readBudget();
  shell.setForce(1, [0, 0, 1e200]);
  assert.throws(() => world.advance(2), { code: 'failed', message: /Reduce the load.*#ductile-crush/ });
  assert.deepEqual(shell.readMesh(), mesh);
  assert.deepEqual(shell.readBudget(), budget);
  assert.deepEqual(shell.readNativeWork(), receipt);
  world.restoreSnapshot(accepted.bytes);
  world.advance(2);
  assert.ok(shell.readNativeWork().faces > 0);
  assert.notDeepEqual(shell.readMesh(), mesh);
});
