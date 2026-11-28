import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { aeolianWorkerRun, aeolianWork } from '../fixtures/aeolian-workers.mjs';

test('native aeolian participants preserve conservative sand and snow transport through a signed origin shift and replay', async () => {
  for (const [nx, nz, material] of [
    [33, 27, 'sand'],
    [77, 45, 'snow'],
  ]) {
    const count = nx * nz;
    const reference = await aeolianWorkerRun(nx, nz, material, 1, false);
    const sample = [8 - (nx - 1) / 64, 0.125, 16 - (nz - 1) / 32];
    assert.deepEqual(reference.firstWind, sample);
    const massOf = (budget) => budget.mobileBed + budget.moving + budget.outflow + budget.dust;
    const initial = massOf(reference.initialBudget);
    const mass = massOf(reference.accepted.budget);
    assert.ok(Math.abs(mass - initial) <= 256 * count * Number.EPSILON * initial, `${mass} against ${initial}`);
    assert.ok(reference.accepted.budget.outflow > 0);
    assert.equal(reference.accepted.budget.dust > 0, material === 'sand');
    const substeps = reference.accepted.work.substeps;
    assert.ok(substeps > 1);
    for (const [shared, threads] of [
      [false, 1],
      [true, 1],
      [true, 2],
      [true, 4],
    ]) {
      const run = !shared ? reference : await aeolianWorkerRun(nx, nz, material, threads, shared);
      assert.equal(run.coldWork, undefined);
      assert.deepEqual(run.firstWind, sample);
      assert.deepEqual(run.start.bytes, reference.start.bytes);
      assert.deepEqual(run.accepted.snapshot.bytes, reference.accepted.snapshot.bytes);
      assert.deepEqual(run.replay.snapshot.bytes, run.accepted.snapshot.bytes);
      assert.deepEqual(run.accepted.fields, reference.accepted.fields);
      assert.deepEqual(run.replay.fields, run.accepted.fields);
      assert.deepEqual(run.accepted.budget, reference.accepted.budget);
      assert.deepEqual(run.replay.budget, run.accepted.budget);
      assert.deepEqual(run.accepted.bed, reference.accepted.bed);
      assert.deepEqual(run.replay.bed, run.accepted.bed);
      assert.deepEqual(run.restoredCells, [run.far, run.far, run.far, run.far]);
      assert.deepEqual(
        run.accepted.fields.map(({ cell }) => cell),
        Array.from({ length: 4 }, () => [0, 0, 0]),
      );
      assert.deepEqual(run.accepted.work, aeolianWork(count, substeps, threads));
      assert.deepEqual(run.replay.work, run.accepted.work);
    }
    console.log('EARTH-07 native aeolian grid', material, nx, nz, substeps, reference.accepted.snapshot.hash);
  }
});

test('terrain stress stops tracing a ray once both sides leave an anisotropic grid', async () => {
  const kernel = await readFile(new URL('../../dist/aeolian-kernel.wasm', import.meta.url));
  const memory = new WebAssembly.Memory({ initial: 18, maximum: 65536 });
  const { instance } = await WebAssembly.instantiate(kernel, { env: { memory } });
  const { __stack_pointer: stack, aeolian_thread_phase: phase, aeolian_thread_plan: plan } = instance.exports;
  stack.value = 8192;
  const n = 9;
  const dx = 1e-12;
  let start = 16384;
  const allocate = (words) => {
    const offset = start;
    start += words * 8;
    return offset;
  };
  const wind = allocate(4 * n),
    controls = allocate(2 * n),
    height = allocate(n),
    settings = allocate(19);
  const change = allocate(n),
    scratch = allocate(9 * n),
    dust = allocate(n),
    receipts = allocate(7),
    job = allocate(14);
  const f64 = (at, words) => new Float64Array(memory.buffer, at, words);
  f64(wind, n).fill(0.4);
  f64(wind + 16 * n, n).fill(1.225);
  f64(controls, 2 * n).fill(1);
  f64(settings, 19).set([
    9.81, 2650, 1590, 0.00025, 0.35, 0.2, 1.5, 0.2, 1.25, 0.15, 0.001, 0.58, 0.12, 3.2, 0.25, 2, 0, 0, 0,
  ]);
  const header = new Uint32Array(memory.buffer, job, 18);
  header.set([wind, controls, height, settings, 0, 0, change, 0, dust, 0, 0, scratch, receipts, 3, 3, 0, 0, 0]);
  f64(job + 72, 5).set([dx, 1, 1e-15, 1e-15, 0]);
  // The diagonal corresponds to 2e12 nominal samples, but the X rays have at most two in-bound positions per vertex.
  assert.equal(phase(job, 0, 0, 1), 0);
  assert.equal(phase(job, 1, 0, 1), 0);
  assert.equal(plan(job, 1), 0);
  assert.equal(header[16], 1);
  assert.deepEqual(f64(scratch + 8 * 4 * n, n), new Float64Array(n).fill(1.225 * 0.4 * 0.4));
  // Along Z, the first unrepresentable sample still intersects this same bed. Reject before scanning that fetch.
  f64(wind, n).fill(0);
  f64(wind + 8 * n, n).fill(0.4);
  assert.equal(phase(job, 0, 0, 1), 0);
  assert.equal(phase(job, 1, 0, 1), 2);
});
