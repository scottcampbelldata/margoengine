import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Fft3 } from '@margoengine/math/fft';
import { MannBox } from '../dist/turbulence.js';

function bytes(field) {
  return new Uint8Array(field.buffer, field.byteOffset, field.byteLength);
}

test('native mixed-radix complex transforms match both K17 directions bit for bit', async () => {
  const module = await WebAssembly.compile(await readFile(new URL('../src/mann-fft.wasm', import.meta.url)));
  for (const [cells, count] of [
    [[1, 1, 1], 0],
    [[30, 9, 5], 36_450],
    [[45, 20, 9], 275_400],
  ]) {
    const { exports } = new WebAssembly.Instance(module);
    assert.equal(exports.mann_fft_init(...cells), 0);
    const reference = new Fft3(...cells);
    const n = cells[0] * cells[1] * cells[2];
    const input = Float64Array.from({ length: 2 * n }, (_, index) => (index % 7 === 0 ? -0 : (index % 23) - 11));
    const buffer = new Float64Array(exports.memory.buffer, exports.mann_fft_buffer(), 2 * n);
    buffer.set(input);
    for (const inverse of [false, true, false, true]) {
      assert.equal(exports.mann_fft_transform(Number(inverse)), count);
      reference.transform(input, inverse);
      assert.deepEqual(bytes(buffer), bytes(input));
    }
  }
});

function expectWork(box, threads, points, products) {
  const transforms = threads === 1 ? [6] : threads === 2 ? [4, 2] : [2, 2, 2];
  assert.deepEqual(box.fftWork, {
    transforms: 6,
    complexValues: points * 6,
    simdTwiddleProducts: products * 6,
    threads,
    workers: threads - 1,
    participants: transforms.map((transforms) => ({
      transforms,
      complexValues: transforms * points,
      simdTwiddleProducts: transforms * products,
    })),
  });
}

function equalBox(actual, expected) {
  for (const field of ['u', 'v', 'w']) assert.deepEqual(bytes(actual[field]), bytes(expected[field]), field);
  for (const xyz of [
    [-12.125, 31.75, -88.375],
    [2.5, -4.25, 9.625],
    [0, 0, 0],
  ])
    assert.deepEqual(actual.sample(...xyz), expected.sample(...xyz));
}

test('the real Node helpers build the same sheared and isotropic wind boxes as the synchronous constructor', async () => {
  for (const [options, points, products] of [
    [{ cells: [30, 9, 5], size: [768, 384, 256], shear: 0, sigma: 1.7, seed: 17 }, 1_350, 36_450],
    [{ cells: [45, 20, 9], size: [1024, 256, 128], shear: 3.9, sigma: 0.7, seed: 420 }, 8_100, 275_400],
  ]) {
    const expected = new MannBox(options);
    assert.equal(expected.fftWork, undefined);
    for (const threads of [1, 2, 3]) {
      const actual = await MannBox.create({ ...options, threads });
      equalBox(actual, expected);
      expectWork(actual, threads, points, products);
    }
    equalBox(await MannBox.create({ ...options, threads: 3 }), expected);
  }
});

test('the default-scale Mann grid executes six exact SIMD component transforms over three real participants', async () => {
  const box = await MannBox.create({ threads: 3 });
  expectWork(box, 3, 524_288, 29_884_416);
  assert.equal(box.u.length, 524_288);
  assert.equal(box.v.length, box.u.length);
  assert.equal(box.w.length, box.u.length);
  assert.ok(box.sample(-384.5, 71.25, -20).every(Number.isFinite));
});

test('native construction rejects invalid participant counts and exact caller cancellation', async () => {
  const options = { cells: [12, 5, 9] };
  await assert.rejects(MannBox.create({ ...options, threads: 4 }), (error) => {
    assert.ok(error.code && /1, 2 or 3/.test(error.message));
    return true;
  });
  const controller = new AbortController();
  const reason = new Error('Stop the Mann box build.');
  const pending = MannBox.create({ ...options, threads: 3, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});
