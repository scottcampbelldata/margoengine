import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SurfSolver } from '../../dist/surf.js';
import { followSurfForce, rebasedCell } from '../fixtures/surf-force-workers.mjs';

const data = ({ accepted, forcing, waves, water, cell, waveCell }) => ({
  accepted,
  forcing,
  waves,
  water,
  cell,
  waveCell,
});

for (const oneDimensional of [false, true]) {
  test(`surf radiation moments and divergence preserve signed replay in ${oneDimensional ? 'a one-row beach' : 'a periodic 2D beach'}`, async () => {
    const scalar = await followSurfForce(oneDimensional);
    assert.deepEqual(data(scalar), data(scalar.replay));
    assert.deepEqual(scalar.cell, rebasedCell);
    assert.deepEqual(scalar.waveCell, rebasedCell);
    assert.ok(scalar.forcing.some((value, i) => i % 5 === 0 && Math.abs(value) > 0));
    assert.ok(scalar.forcing.some((value, i) => i % 5 === 4 && value > 0));
    assert.ok(
      scalar.waves.some((value, i) => i % 3 === 2 && value > 0),
      'The breaker has a live roller.',
    );
    let serial;
    for (const threads of [1, 2, 4]) {
      const native = await followSurfForce(oneDimensional, threads);
      assert.deepEqual(data(native), data(scalar));
      assert.deepEqual(data(native), data(native.replay));
      assert.deepEqual(native.work, native.replay.work);
      const totals = native.work.map(({ threads: participants, workers, ...work }) => {
        assert.equal(participants, threads);
        assert.equal(work.directionalBins, work.momentCells * native.directions);
        assert.ok(work.pairedMoments > 0 && work.pairedMoments <= work.momentCells && work.momentCells < native.cells);
        assert.ok(work.pairedDivergence > 0 && work.pairedDivergence <= work.divergenceCells);
        assert.equal((work.pairedMoments % 2) + (work.pairedDivergence % 2), 0);
        for (const worker of workers) {
          assert.ok(worker.pairedMoments > 0 && worker.pairedDivergence > 0);
          assert.equal(worker.directionalBins, worker.momentCells * native.directions);
        }
        return work;
      });
      serial ??= totals;
      assert.deepEqual(totals, serial);
    }
  });
}

test('the native surf loader rejects unsupported participant counts with a fix', async () => {
  await assert.rejects(SurfSolver.load('surf', { threads: 3 }), {
    name: 'MargoError',
    message: /Choose 1, 2 or 4 surf force participants.*#nearshore-surf/,
  });
});

test('the native phases reject unrepresentable stress or divergence from finite inputs', async () => {
  const wasm = await readFile(new URL('../../dist/surf-force-kernel.wasm', import.meta.url));
  const memory = new WebAssembly.Memory({ initial: 3, maximum: 65_536 });
  const { instance } = await WebAssembly.instantiate(wasm, { env: { memory } });
  const { __stack_pointer: stack, surf_force_thread_phase: run } = instance.exports;
  stack.value = 2 * 65_536;
  const [job, energy, roller, properties, cx, cz, stress, output, work] = [16, 512, 544, 576, 704, 712, 720, 800, 928];
  const words = (offset, n) => new Float64Array(memory.buffer, offset, n);
  const axes = words(job + 56, 6);
  new Uint32Array(memory.buffer, job, 14).set([
    energy,
    roller,
    properties,
    cx,
    cz,
    stress,
    output,
    work,
    3,
    1,
    1,
    0,
    0,
  ]);
  axes.set([1, 1, 1, 1, 0.01, 1]);
  words(properties, 15).set([0.75, 0.75, 0.75, 1, 1, 1, 2, 2, 2, 0.5, 0.5, 0.5, 1, 1, 1]);
  words(cx, 1)[0] = 1;
  words(roller, 3).set([1, 2, 3]);
  words(energy, 3).set([1e308, 4, 6]);
  assert.equal(run(job, 0, 0, 1), 2);
  words(energy, 3)[0] = 2;
  assert.equal(run(job, 0, 0, 1), 0);
  axes[0] = Number.MIN_VALUE;
  assert.equal(run(job, 1, 0, 1), 2);
  axes[0] = 1;
  assert.equal(run(job, 0, 0, 1), 0);
  assert.equal(run(job, 1, 0, 1), 0);
  assert.deepEqual(
    Array.from(words(output, 15)).filter((_, i) => i % 5 === 0),
    [-2, -4, -2],
  );
});
