import assert from 'node:assert/strict';
import test from 'node:test';
import { cos, ln, pow, sin } from '@margoengine/math/pinned';
import { RandomStream } from '@margoengine/math/random';
import { loadTracerRandomKernel } from '../../dist/tracers.js';
import { equalTracerWords, followTracers } from '../fixtures/tracer-random-workers.mjs';

function scalarNormals(rows, seed, solver, tick) {
  const random = new RandomStream(seed, solver);
  const out = new Float64Array(rows.length * 3);
  const words = new Uint32Array(4);
  for (const [i, slot] of rows.entries()) {
    random.block(tick, slot, 0, words);
    const u = (k) => (words[k] + 0.5) / 4294967296;
    const r1 = pow(-2 * ln(u(0)), 0.5),
      r2 = pow(-2 * ln(u(2)), 0.5);
    const a1 = 6.283185307179586 * u(1),
      a2 = 6.283185307179586 * u(3);
    out.set([r1 * cos(a1), r1 * sin(a1), r2 * cos(a2)], 3 * i);
  }
  return out;
}

test('paired Philox and the pinned Box–Muller match scalar sparse slots and high ticks with 1, 2 and 4 participants', async () => {
  const seed = 0xef6b2101;
  const solver = 0xfa4710bc;
  for (const [length, tick] of [
    [8193, Number.MAX_SAFE_INTEGER - 73],
    [17003, 2 ** 32 + 101],
  ]) {
    const rows = Uint32Array.from({ length }, (_, i) => (Math.imul(i, 0x4e6d41) | 0x80000000) >>> 0);
    const expected = scalarNormals(rows, seed, solver, tick);
    let cumulative;
    for (const threads of [1, 2, 4]) {
      using kernel = await loadTracerRandomKernel({ threads });
      const actual = new Float64Array(3 * length);
      kernel.normals(rows, tick, seed, solver, actual);
      assert.ok(equalTracerWords(actual, expected));
      const { workers, threads: observed, ...totals } = kernel.workCounts();
      assert.equal(observed, threads);
      const pairs = Math.floor(length / 2);
      for (const [i, worker] of workers.entries()) {
        const partPairs = Math.floor(((i + 1) * pairs) / threads) - Math.floor((i * pairs) / threads);
        const partRows = 2 * partPairs + Number(i === threads - 1);
        assert.deepEqual(worker, {
          rows: partRows,
          pairedRows: 2 * partPairs,
          philoxRoundPairs: 10 * partPairs,
          normalValues: 3 * partRows,
        });
      }
      if (cumulative) assert.deepEqual(totals, cumulative);
      cumulative = totals;
    }
  }
});

test('TracerSolver keeps water and bed callback order, accepted mass and signed snapshots over multiple native batches', async () => {
  const reference = await followTracers();
  assert.ok(reference.exact && reference.budget.water > 0 && reference.budget.surface > 0 && reference.budget.bed > 0);
  for (const threads of [1, 2, 4]) {
    const native = await followTracers(threads);
    assert.ok(native.exact);
    assert.deepEqual(native.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
    assert.deepEqual(native.accepted.bytes, reference.accepted.bytes);
    assert.deepEqual(native.fields, reference.fields);
    assert.deepEqual(native.budget, reference.budget);
    assert.deepEqual(native.calls, reference.calls);
    assert.deepEqual(native.counts, native.replay.counts);
    assert.equal(native.counts.rows, native.calls.water);
    assert.equal(native.counts.batches, 10); // five world ticks, two actual moving-slot batches each
    assert.ok(native.counts.rows > native.counts.pairedRows && native.counts.philoxRoundPairs > 0);
  }
});

test('empty and rejected native Brownian inputs leave accepted values and work untouched', async () => {
  using kernel = await loadTracerRandomKernel({ threads: 2 });
  const slots = Uint32Array.of(5, 7);
  const out = Float64Array.of(1, 2, 3, 4, 5, 6);
  kernel.normals(new Uint32Array(0), 0, 0, 0, new Float64Array(0));
  assert.equal(kernel.workCounts().batches, 0);
  assert.throws(() => kernel.normals(slots, 2 ** 53, 0, 0, out), {
    code: 'state',
    message: /non-negative integer tick.+#water-tracers/,
  });
  assert.deepEqual(out, Float64Array.of(1, 2, 3, 4, 5, 6));
  assert.equal(kernel.workCounts().batches, 0);
  kernel.normals(slots, 76, 0, 0, out);
  assert.deepEqual(out, scalarNormals(slots, 0, 0, 76));
});
