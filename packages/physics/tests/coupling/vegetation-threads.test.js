import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PlantSway } from '../../dist/vegetation.js';
import { expectedPlantWork, far, makePlants, plantPorts, runPlants } from '../fixtures/vegetation-threads-worker.mjs';

test('plant sway workers preserve exact signed publication, failure order and replay', async () => {
  const baseline = await runPlants(false, 1);
  for (const [shared, threads] of [
    [false, 1],
    [true, 1],
    [true, 2],
    [true, 4],
  ]) {
    const run = shared ? await runPlants(shared, threads) : baseline;
    const report = run.report;
    assert.deepEqual(run.start, baseline.start);
    assert.deepEqual(run.checkpoint, baseline.checkpoint);
    assert.deepEqual(run.final, baseline.final);
    assert.equal(report.hash, baseline.report.hash);
    assert.deepEqual(report.initialCells, [far, far]);
    assert.deepEqual(report.shiftedCells, [
      [0, 0, 0],
      [0, 0, 0],
    ]);
    assert.deepEqual(report.restoredCells, report.initialCells);
    assert.ok(report.originShiftExact && report.acceptedCellAgrees && report.exactReplay && report.readsAgree);
    assert.ok(report.changed);
    assert.deepEqual(report.status, [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(report.coldWork, expectedPlantWork([], threads));
    assert.deepEqual(report.work, expectedPlantWork(report.standing, threads));
    assert.deepEqual(report.replayWork, report.work);
  }
});

test('two odd vegetation groups execute counted SIMD midpoint work in every worker', async () => {
  for (const count of [1027, 4099]) {
    using serial = await PlantSway.load();
    using parallel = await PlantSway.load({ threads: 4 });
    const { world: plain } = makePlants(serial, false, count);
    const { world: shared } = makePlants(parallel, true, count);
    try {
      plain.advance(1);
      shared.advance(1);
      const work = parallel.workCounts();
      const standing = Array(count).fill(true);
      assert.deepEqual(work, expectedPlantWork(standing, 4));
      assert.deepEqual(serial.workCounts(), expectedPlantWork(standing, 1));
      assert.ok(work.workers.every(({ simdModePairs }) => simdModePairs > 0));
      assert.deepEqual(plantPorts(shared, parallel), plantPorts(plain, serial));
      assert.deepEqual(shared.takeSnapshot().bytes, plain.takeSnapshot().bytes);
      console.log('BIO-01 modal plant work', count, work);
    } finally {
      plain.remove(serial.id);
      shared.remove(parallel.id);
    }
  }
});

test('plant sway workers reject plain memory with a shared-world remedy', async () => {
  using plant = await PlantSway.load({ threads: 2 });
  assert.throws(() => makePlants(plant, false, 1), {
    name: 'MargoError',
    code: 'unsupported',
    message: /worldMemory\(true\)|shared.*threads: 1/i,
  });
});

test('a nonfinite modal discriminant rejects its native partition without writing accepted sway', async () => {
  for (const shared of [false, true]) {
    const asset = new URL('../../dist/vegetation-kernel' + (shared ? '-shared' : '') + '.wasm', import.meta.url);
    const module = await WebAssembly.compile(await readFile(asset));
    const memory = new WebAssembly.Memory({ initial: 23, maximum: 65536, shared });
    const { exports: kernel } = new WebAssembly.Instance(module, { env: { memory } });
    kernel.__stack_pointer.value = 22 * 65536;
    const n = 2;
    let offset = 18 * 65536;
    function floats(length) {
      const result = new Float64Array(memory.buffer, offset, length);
      offset += result.byteLength;
      return result;
    }
    const models = floats(14 * n);
    const stations = floats(54 * n);
    const sections = floats(27 * n);
    const samples = floats(30 * n);
    const accepted = floats(13 * n);
    const candidate = floats(13 * n);
    const receipts = floats(3 * n);
    const job = new DataView(memory.buffer, offset, 64);
    models.set([1, 0, 1, 2, 0, 4]);
    // Both mass and stiffness determinants are finite and positive. Their
    // unscaled products in the frequency discriminant form infinity minus infinity.
    models.set([1e80, 0, 1e80, 1e80, 0, 4e80], 14);
    accepted[0] = 0.125;
    accepted[13] = 0.125;
    receipts.fill(-1);
    const input = [models, stations, sections, samples, accepted, candidate].map((region) => region.byteOffset);
    [...input, 0, n, receipts.byteOffset, 0].forEach((word, i) => job.setUint32(4 * i, word, true));
    job.setFloat64(40, 1 / 60, true);
    const prior = accepted.slice();
    assert.equal(kernel.vegetation_thread_phase(job.byteOffset, 0, 0, 2), 0);
    assert.equal(kernel.vegetation_thread_phase(job.byteOffset, 0, 1, 2), 2);
    assert.notEqual(candidate[0], accepted[0]);
    assert.deepEqual(receipts, new Float64Array([1, 1, 1, -1, -1, -1]));
    assert.deepEqual(accepted, prior);
  }
});
