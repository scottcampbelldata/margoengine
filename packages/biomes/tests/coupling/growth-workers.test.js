import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PlantGrowth } from '@margoengine/biomes/growth';
import { worldMemory } from '@margoengine/physics/world';
import { DYNAMIC_BASE, PAGE } from '../../../../scripts/physics-modules.mjs';
import { followGrowth, growthCell, orderedObstacles, referenceShadows } from '../fixtures/growth-workers.mjs';

for (const dimensions of [
  [15, 13, 11],
  [19, 13, 13],
]) {
  test('BIO-02 shadow workers preserve exact signed seasonal growth on ' + dimensions.join('×'), async () => {
    const baseline = await followGrowth(dimensions, 1);
    assert.deepEqual(baseline.replay, baseline.accepted);
    const { state } = baseline.accepted;
    assert.deepEqual(state.cell, growthCell);
    assert.equal(state.seasonAtStart, 2);
    assert.equal(state.season, 5);
    assert.ok(state.branches.radii.length > 10);
    assert.ok(state.branches.parents.some((parent) => parent >= 0));
    assert.ok(baseline.accepted.work[0].receipt.sources > orderedObstacles(dimensions).length);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const actual = shared ? await followGrowth(dimensions, threads, shared) : baseline;
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      for (const { receipt, expected } of actual.accepted.work) {
        assert.deepEqual(receipt, expected);
        assert.ok(receipt.workers.every((part) => part.additions > 0));
        assert.ok(receipt.pairedAdditions > 0 && receipt.pairedAdditions < receipt.additions);
      }
    }
  });
}

test('BIO-02 native shadow grids retain exact ordered additions at clipped edges and singleton Z', async () => {
  const memory = worldMemory(false);
  memory.grow(2);
  const module = await WebAssembly.compile(await readFile(new URL('../../dist/growth-kernel.wasm', import.meta.url)));
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  exports.__stack_pointer.value = DYNAMIC_BASE + 2 * PAGE;
  const base = DYNAMIC_BASE;
  const bank = base + 64;
  const receiptBank = base + 2048;
  const target = base + 4096;
  const raw = base + 32768;

  for (const dimensions of [
    [9, 7, 5],
    [11, 9, 1],
    [1, 3, 1],
  ]) {
    const [nx, ny, nz] = dimensions;
    const depth = ny - 1;
    const transmission = 0.6379;
    const count = nx * ny * nz;
    const sources = [
      { x: 0, y: ny - 1, z: 0, amount: 1 },
      { x: 0, y: ny - 1, z: 0, amount: 2 ** -53 },
      { x: 0, y: ny - 1, z: 0, amount: 2 ** -53 },
      ...orderedObstacles(dimensions),
      { x: nx - 1, y: ny - 1, z: nz - 1, amount: 0.321 },
      { x: nx - 1, y: 0, z: 0, amount: 0.127 },
    ];
    new Uint32Array(memory.buffer, base, 8).set([target, bank, nx, ny, nz, sources.length, depth, receiptBank]);
    new Float64Array(memory.buffer, base + 32, 1)[0] = transmission;
    const packed = new DataView(memory.buffer, bank, sources.length * 24);
    const direct = new Float64Array(memory.buffer, raw, count);
    direct.fill(0);
    for (const [i, { x, y, z, amount }] of sources.entries()) {
      const offset = 24 * i;
      packed.setInt32(offset, x, true);
      packed.setInt32(offset + 4, y, true);
      packed.setInt32(offset + 8, z, true);
      packed.setFloat64(offset + 16, amount, true);
      exports.deposit_shadow(raw, nx, ny, nz, x, y, z, depth, amount, transmission);
    }
    const staged = new Float64Array(memory.buffer, target, count);
    for (const threads of [1, 2, 4]) {
      staged.fill(99);
      for (let part = threads - 1; part >= 0; part--) assert.equal(exports.growth_shadow_phase(base, part, threads), 0);
      const { values, receipt } = referenceShadows(dimensions, depth, transmission, sources, threads);
      assert.deepEqual(staged, values);
      assert.deepEqual(staged, direct);
      for (const [i, work] of receipt.workers.entries()) {
        assert.deepEqual(Array.from(new Float64Array(memory.buffer, receiptBank + i * 32, 4)), [
          work.sources,
          work.rows,
          work.additions,
          work.pairedAdditions,
        ]);
      }
    }
    assert.ok(
      staged[(ny - 1) * nx] !==
        referenceShadows(dimensions, depth, transmission, [...sources].reverse()).values[(ny - 1) * nx],
    );
  }
});

test('BIO-02 native loader rejects invalid worker configuration and preserves abort reason', async () => {
  await assert.rejects(PlantGrowth.load({ threads: 3 }), /Choose 1, 2 or 4.*#plant-growth/);
  const stop = new Error('Cancel plant growth before loading.');
  await assert.rejects(PlantGrowth.load({ threads: 4, signal: AbortSignal.abort(stop) }), (cause) => cause === stop);
});
