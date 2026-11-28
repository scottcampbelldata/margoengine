import assert from 'node:assert/strict';
import test from 'node:test';
import { NonlinearSea } from '../../dist/rogue.js';
import { sampleRoguePairs, seaOptions, signedCell } from '../fixtures/rogue-pair-workers.mjs';

const cluster = 262_144;

function expectedWork(components, threads) {
  const pairs = (components * (components + 1)) / 2;
  const tiles = Math.ceil(pairs / cluster);
  const workers = Array.from({ length: threads }, () => ({ tiles: 0, pairs: 0, pairedPairs: 0 }));
  for (let start = 0; start < pairs; start += cluster) {
    const count = Math.min(cluster, pairs - start);
    const complete = Math.floor(count / 2);
    for (const [part, work] of workers.entries()) {
      const pairRows = 2 * (Math.floor((complete * (part + 1)) / threads) - Math.floor((complete * part) / threads));
      const rows = pairRows + (part === threads - 1 ? count % 2 : 0);
      work.tiles += Number(rows > 0);
      work.pairs += rows;
      work.pairedPairs += pairRows;
    }
  }
  return { threads, tiles, pairs, pairedPairs: pairs - (pairs % 2), workers };
}

for (const [components, withRogue] of [
  [193, false],
  [725, true],
]) {
  test(`wave pair SIMD and real participants exactly match ordered scalar queries at ${components} components`, async () => {
    const scalar = await sampleRoguePairs(components, withRogue);
    assert.deepEqual(scalar.first, scalar.replay);
    for (const threads of [1, 2, 4]) {
      const native = await sampleRoguePairs(components, withRogue, threads);
      assert.deepEqual(native.local, native.points);
      assert.deepEqual(native.cell, signedCell);
      assert.deepEqual(native.waterCell, signedCell);
      assert.deepEqual(native.first, native.replay);
      assert.deepEqual(
        native.first.map(({ work: _work, ...values }) => values),
        scalar.first.map(({ work: _work, ...values }) => values),
      );
      const work = expectedWork(components, threads);
      for (const query of native.first) assert.deepEqual(query.work, work);
    }
  });
}

test('single-component wave queries run the scalar native tail with a four-participant pool and support disposal', async () => {
  const options = seaOptions(1, false);
  using sea = await NonlinearSea.load(options, { threads: 4 });
  assert.equal(sea.readNativeWork(), undefined);
  assert.deepEqual(sea.sample(0, 1, 2), new NonlinearSea(options).sample(0, 1, 2));
  assert.deepEqual(sea.readNativeWork(), expectedWork(1, 4));
  assert.throws(() => sea.sample(0, 1, Infinity), { name: 'MargoError' });
  assert.deepEqual(sea.readNativeWork(), expectedWork(1, 4));
  sea[Symbol.dispose]();
  assert.throws(() => sea.elevation(0, 1, 2), {
    name: 'MargoError',
    message: /load a new sea.*#nonlinear-sea/,
  });
  await assert.rejects(NonlinearSea.load(options, { threads: 3 }), {
    name: 'MargoError',
    message: /Choose 1, 2 or 4 wave-pair participants.*#nonlinear-sea/,
  });
});
