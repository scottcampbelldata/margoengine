import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeHullPanels } from '../../dist/seakeeping.js';
import { equalPanels, followHull, hemisphere, options } from '../fixtures/hull-panel-workers.mjs';

test('the native pivot pairs give the same hull coefficients on the caller and on actual Node helpers', async () => {
  for (const [rings, around, count, depth] of [
    [2, 11, 8, Infinity],
    [2, 15, 4, 2],
  ]) {
    const mesh = hemisphere(rings, around);
    const input = options(count, depth);
    const reference = await bakeHullPanels(mesh, input);
    assert.equal(reference.work, undefined);
    assert.equal(reference.panelCount % 2, 1);
    for (const threads of [1, 2, 4]) {
      const result = await bakeHullPanels(mesh, { ...input, threads });
      assert.ok(equalPanels(result, reference));
      assert.ok(Object.isFrozen(result.work) && Object.isFrozen(result.work.workers));
      const work = result.work;
      assert.equal(work.threads, threads);
      assert.equal(work.systems, count + 1);
      assert.equal(work.frequencySolves, count);
      assert.deepEqual(
        work.workers.map(({ systems }) => systems),
        Array.from({ length: threads }, (_, part) => 1 + Math.floor((count - part) / threads)),
      );
      const n = result.panelCount;
      const rowUpdates = (n * (n - 1)) / 2;
      let matrixPairs = 0;
      let matrixTail = 0;
      for (let columns = 1; columns < n; columns++) {
        matrixPairs += columns * Math.floor(columns / 2);
        matrixTail += columns * (columns % 2);
      }
      const columns = 6 + input.headings;
      for (const worker of work.workers) {
        assert.equal(
          worker.eliminationPairs,
          worker.systems * (matrixPairs + rowUpdates * 3) +
            worker.frequencySolves * rowUpdates * (Math.floor(columns / 2) - 3),
        );
        assert.equal(
          worker.eliminationTail,
          worker.systems * matrixTail + worker.frequencySolves * rowUpdates * (columns % 2),
        );
      }
      assert.equal(
        work.eliminationPairs,
        work.workers.reduce((sum, row) => sum + row.eliminationPairs, 0),
      );
      assert.equal(
        work.eliminationTail,
        work.workers.reduce((sum, row) => sum + row.eliminationTail, 0),
      );
    }
  }
});

test('signed rigid hull panel use and replay preserve accepted native radiation bytes', async () => {
  const mesh = hemisphere(2, 11);
  const scalar = await followHull(mesh, await bakeHullPanels(mesh, options(8)));
  const parallel = await followHull(mesh, await bakeHullPanels(mesh, { ...options(8), threads: 4 }));
  assert.equal(scalar.exact, true);
  assert.equal(parallel.exact, true);
  assert.deepEqual(parallel.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
  assert.deepEqual(parallel.accepted.bytes, scalar.accepted.bytes);
  assert.equal(parallel.load, scalar.load);
  assert.ok(Number.isFinite(parallel.load) && parallel.load !== 0);
});

test('hull panel helper counts are bounded by actual systems and invalid options are coded', async () => {
  const mesh = hemisphere(2, 11);
  const input = options(2);
  const result = await bakeHullPanels(mesh, { ...input, threads: 4 });
  assert.equal(result.work.threads, 3);
  assert.deepEqual(
    result.work.workers.map(({ systems }) => systems),
    [1, 1, 1],
  );
  await assert.rejects(bakeHullPanels(mesh, { ...input, threads: 8 }), {
    code: 'state',
    message: /Choose 1, 2 or 4 hull panel threads.+#ship-seakeeping/,
  });
});

test('unrepresentable hull panel wavelengths and SI coefficients report corrective errors', async () => {
  const mesh = hemisphere(2, 11);
  await assert.rejects(bakeHullPanels(mesh, { ...options(2), frequencies: [1e-300, 1e-290] }), {
    code: 'state',
    message: /Use representable hull edge lengths.+#ship-seakeeping/,
  });
  await assert.rejects(bakeHullPanels(mesh, { ...options(2), density: 1e308, threads: 2 }), {
    code: 'state',
    message: /Reduce the hull scale.+finite SI coefficients.+#ship-seakeeping/,
  });
});
