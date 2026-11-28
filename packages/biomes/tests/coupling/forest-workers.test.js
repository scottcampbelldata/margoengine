import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ForestEcosystemSolver } from '@margoengine/biomes/forest';
import { worldMemory } from '@margoengine/physics/world';
import { DYNAMIC_BASE, PAGE } from '../../../../scripts/physics-modules.mjs';
import { followForest, forestCell, referenceShade } from '../fixtures/forest-workers.mjs';

for (const plants of [31, 47]) {
  test('BIO-03 native tree shade preserves exact yearly growth in signed ' + plants + '-founder stands', async () => {
    const baseline = await followForest(plants, 1);
    const { state } = baseline.accepted;
    assert.deepEqual(baseline.replay, baseline.accepted);
    assert.equal(state.year.year, 5);
    assert.ok(state.year.alive > 0);
    const radii = new Map(state.first.map(({ id, radius }) => [id, radius]));
    assert.ok(state.trees.some(({ id, radius }) => radius > radii.get(id)));
    assert.ok(
      state.trees.some(({ id }) => !radii.has(id)),
      'new trees establish after shade-dependent growth',
    );
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, forestCell);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const actual = shared ? await followForest(plants, threads, shared) : baseline;
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      for (const { receipt, expected } of actual.accepted.work) {
        assert.deepEqual(receipt, expected);
        assert.ok(receipt.workers.every((part) => part.candidateVisits > 0));
        assert.ok(receipt.pairedOverlaps > 0 && receipt.overlaps >= receipt.pairedOverlaps);
      }
    }
  });
}

test('BIO-03 overlapping maximum-size crowns saturate Q16 before adding the two lanes', async () => {
  const memory = worldMemory(false);
  memory.grow(1);
  const asset = await readFile(new URL('../../dist/forest-kernel.wasm', import.meta.url));
  const module = await WebAssembly.compile(asset);
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  exports.__stack_pointer.value = DYNAMIC_BASE + PAGE;
  const capacity = 7;
  const count = 6;
  const tableSize = 16;
  const cell = 8001;
  const base = DYNAMIC_BASE;
  const pop = base + 128;
  const shade = base + 384;
  const scratch = base + 512;
  const work = base + 800;
  const oldResult = base + 1024;
  const packed = new Int32Array(memory.buffer, pop, 7 * capacity);
  packed.set([0, 0, 0, -9, -11, 700], 0);
  packed.set([0, 0, 0, -21, -29, 930], capacity);
  packed.set([1, 40000, 40000, 486, 488, 720], 2 * capacity);
  packed.set([-1, -1, -1, -1, -1, 5], 4 * capacity);
  packed.set([0, 1, 2, 3, 4, 5], 6 * capacity);
  new Uint32Array(memory.buffer, base, 8).set([pop, shade, scratch, capacity, count, tableSize, cell, work]);
  const actual = new Int32Array(memory.buffer, shade, count);
  exports.forest_shade(pop, oldResult, scratch, capacity, count, tableSize, cell);
  for (const threads of [1, 2, 4]) {
    actual.fill(-123);
    assert.equal(exports.forest_prepare(base), 0);
    for (let part = threads - 1; part >= 0; part--) assert.equal(exports.forest_shade_phase(base, part, threads), 0);
    const expected = referenceShade(packed, capacity, count, cell, threads);
    assert.deepEqual(actual, expected.shade);
    assert.deepEqual(actual, new Int32Array(memory.buffer, oldResult, count));
    assert.equal(actual[0], 65536);
    assert.equal(actual[5], 0);
    for (const [i, worker] of expected.receipt.workers.entries()) {
      const words = new Float64Array(memory.buffer, work + i * 40, 5);
      assert.deepEqual(Array.from(words), Object.values(worker));
    }
  }
});

test('BIO-03 loader rejects invalid worker counts and preserves the caller’s abort reason', async () => {
  await assert.rejects(ForestEcosystemSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#forest/);
  const stop = new Error('Cancel forest simulation before loading.');
  await assert.rejects(
    ForestEcosystemSolver.load({ threads: 4, signal: AbortSignal.abort(stop) }),
    (cause) => cause === stop,
  );
});
