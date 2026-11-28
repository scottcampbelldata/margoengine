import assert from 'node:assert/strict';
import test from 'node:test';
import { ThinFilmSolver } from '../../dist/thin-film.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { followThinFilm } from '../fixtures/thin-film-workers.mjs';

test('thin-film native workers preserve signed sampled capillary state on planar/contact and suspended odd grids', async () => {
  for (const suspended of [false, true]) {
    const reference = await followThinFilm(1, false, suspended);
    assert.ok(reference.exact);
    assert.ok(reference.receipts.some(({ matrixProducts }) => matrixProducts > 0));
    for (const [threads, shared] of [
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const run = await followThinFilm(threads, shared, suspended);
      assert.ok(run.exact);
      assert.deepEqual(run.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
      assert.deepEqual(run.accepted.bytes, reference.accepted.bytes);
      assert.deepEqual(run.budget, reference.budget);
      assert.deepEqual(run.ports, reference.ports);
      assert.deepEqual(run.receipts, run.replay.receipts);
      for (const [tick, work] of run.receipts.entries()) {
        const { matrixProducts } = work;
        assert.equal(matrixProducts, reference.receipts[tick].matrixProducts);
        assert.equal(work.threads, threads);
        for (const [part, receipt] of work.workers.entries()) {
          const rows = Math.floor((run.n * (part + 1)) / threads) - Math.floor((run.n * part) / threads);
          assert.equal(receipt.matrixProducts, matrixProducts);
          assert.equal(receipt.transposeRows, rows * matrixProducts);
          assert.equal(receipt.pressureRows, rows * matrixProducts);
          assert.equal(receipt.gradientFaces, 2 * rows * matrixProducts);
          assert.equal(receipt.gradientPairs, threads === 1 ? 0 : rows * matrixProducts);
          if (threads > 1 && matrixProducts > 0) assert.ok(receipt.pressurePairs > 0);
        }
      }
    }
  }
});

test('a preloaded thin-film pool requires shared memory and can be disposed before attach', async () => {
  await assert.rejects(ThinFilmSolver.load({ threads: 3 }), {
    code: 'state',
    message: /Choose 1, 2 or 4.+#thin-film-flow/,
  });
  const film = await ThinFilmSolver.load({ threads: 2 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(() => world.add(film, { cells: [7, 5], spacing: 0.02, depth: 0.001 }), {
    code: 'unsupported',
    message: /Use shared world memory.+#thin-film-flow/,
  });
  film[Symbol.dispose]();
  using unused = await ThinFilmSolver.load({ threads: 4 });
  unused[Symbol.dispose]();
});
