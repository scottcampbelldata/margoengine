import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { worldMemory } from '../../dist/world.js';
import { foamTransportRun, foamTransportWorld } from '../fixtures/foam-transport-workers.mjs';

function rows(total, part, threads) {
  return Math.floor(((part + 1) * total) / threads) - Math.floor((part * total) / threads);
}

for (const cells of [
  [39, 31],
  [71, 37],
]) {
  test(`native two-field foam sweeps match scalar byte for byte on ${cells.join('×')} cells`, async () => {
    const [nx, nz] = cells;
    const scalar = await foamTransportRun(cells, 0);
    assert.ok(scalar.accepted.mean > 0 && scalar.accepted.mean < scalar.before);
    assert.ok(scalar.accepted.centre > 0.95, 'converging currents pack the central foam');
    for (const threads of [1, 2, 4]) {
      const { start, accepted, replay, restoredCell, initialCell } = await foamTransportRun(cells, threads);
      assert.deepEqual(start.bytes, scalar.start.bytes);
      assert.deepEqual(accepted.snapshot.bytes, scalar.accepted.snapshot.bytes);
      assert.deepEqual(accepted.field, scalar.accepted.field);
      assert.deepEqual(replay, accepted);
      assert.deepEqual(restoredCell, initialCell);
      assert.equal(accepted.field.cell[1], initialCell[1] - 1);
      const work = accepted.work;
      assert.equal(work.threads, threads);
      assert.equal(work.substeps, 3);
      const expected = (xLines, zLines) => ({
        xLines,
        zLines,
        xFacePairs: xLines * (nx - 1),
        zFacePairs: zLines * (nz - 1),
        cellPairs: xLines * nx + zLines * nz,
        clampPairs: zLines * nz,
      });
      const { workers, threads: seen, substeps, ...total } = work;
      assert.deepEqual(total, expected(nz * substeps, nx * substeps));
      assert.equal(workers.length, seen);
      for (const [part, worker] of workers.entries()) {
        assert.deepEqual(worker, expected(rows(nz, part, threads) * substeps, rows(nx, part, threads) * substeps));
      }
    }
  });
}

test('a late invalid current sample leaves the accepted foam and native receipt unchanged', async () => {
  const { world, solver, fail, recover } = await foamTransportWorld([39, 31], 4);
  try {
    world.advance(1);
    const previous = world.takeSnapshot();
    const mean = solver.meanCoverage();
    const work = solver.workCounts();
    fail();
    assert.throws(() => world.advance(2), /finite/);
    assert.equal(solver.meanCoverage(), mean);
    assert.deepEqual(solver.workCounts(), work);
    recover();
    world.restoreSnapshot(previous.bytes);
    world.advance(2);
    assert.notEqual(solver.meanCoverage(), mean);
  } finally {
    solver.dispose();
  }
});

test('native foam transports the two limited slopes exactly and applies one coverage scale to the mixture', async () => {
  const bytes = await readFile(new URL('../../dist/foam-transport-kernel.wasm', import.meta.url));
  const memory = worldMemory(false);
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  instance.exports.__stack_pointer.value = memory.buffer.byteLength;
  function solve(pairs, faces, dt) {
    const nx = pairs.length / 2;
    const [foam, temp, fx, fz, receipts] = [64, 160, 256, 320, 432];
    new Uint32Array(memory.buffer, 0, 8).set([foam, temp, fx, fz, receipts, nx, 1, 0]);
    new Float64Array(memory.buffer, 32, 2).set([1, dt]);
    const input = new Float64Array(memory.buffer, foam, pairs.length);
    input.set(pairs);
    new Float64Array(memory.buffer, fx, faces.length).set(faces);
    new Float64Array(memory.buffer, fz, 2 * nx).fill(0);
    const work = new Float64Array(memory.buffer, receipts, 6);
    work.fill(0);
    assert.equal(instance.exports.foam_transport_apply(0, 1), 0);
    return { output: [...input], work: [...work] };
  }
  const linear = solve([0, 0, 0.125, 0.5, 0.25, 0.625, 0.375, 0.75, 0, 0], [1, 1, 1, 1, 1, 1], 0.25);
  assert.deepEqual(linear.output.slice(2, 6), [0.08203125, 0.3515625, 0.21875, 0.60546875]);
  const mass = (lane) => linear.output.filter((_, i) => i % 2 === lane).reduce((sum, value) => sum + value, 0);
  assert.deepEqual([mass(0), mass(1)], [0.75, 1.875]);
  assert.deepEqual(linear.work, [1, 5, 5, 5, 10, 5]);
  const compressed = solve([1, 1.25, 1, 0.5, 1, 1.75], [0, 1, -1, 0], 0.5);
  assert.deepEqual(compressed.output, [0.5, 0.625, 1, 1, 0.5, 0.875]);
});
