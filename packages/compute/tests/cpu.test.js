import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { dot, matmul, norm, outer } from '@margoengine/compute/linalg';
import { fft, fft2, fftfreq, ifft } from '@margoengine/compute/fft';
import { convolve, convolve2d, correlate } from '@margoengine/compute/signal';
import { Random, philox4x32 } from '@margoengine/compute/random';
import { chunks, histogramStream, reduceStream, statsStream } from '@margoengine/compute/stream';

// The CPU backend in Node (no WebGPU, no WebGPU globals): every operation against a plain JavaScript reference.
// tests/compute-browser.mjs runs the same operations on both backends of a real GPU and compares them.

const f32 = (values) => Array.from(Float32Array.from(values));
const close = (actual, expected, tolerance = 1e-5, what = '') => {
  assert.equal(actual.length, expected.length, `${what} length`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i],
      e = expected[i];
    if (Number.isNaN(e)) assert.ok(Number.isNaN(a), `${what}[${i}] = ${a}, expected NaN`);
    else assert.ok(Math.abs(a - e) <= tolerance * Math.max(1, Math.abs(e)), `${what}[${i}] = ${a}, expected ${e}`);
  }
};
const read = async (x) => Array.from(await x.read());
const lcg = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

test('createCompute falls back to the CPU without WebGPU; backend webgpu still rejects', async () => {
  assert.equal(globalThis.navigator?.gpu, undefined);
  using gpu = await createCompute();
  assert.equal(gpu.backend, 'cpu');
  assert.equal(gpu.f16, false);
  await assert.rejects(
    () => createCompute({ backend: 'webgpu' }),
    (e) => e.name === 'MargoError' && e.code === 'unsupported' && /errors#compute/.test(e.message),
  );
  await assert.rejects(() => createCompute({ backend: 'gpu' }), TypeError);
  using cpu = await createCompute({ backend: 'cpu' });
  assert.equal(cpu.backend, 'cpu');
});

test('cpu: arrays, views and fused expressions follow the GPU rules (f32 rounding, integer wrap, promotion)', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const m = gpu.array(
    Float32Array.from({ length: 12 }, (_, k) => k),
    { shape: [3, 4] },
  );
  assert.deepEqual(await read(m.T), [0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11]);
  assert.deepEqual(await read(m.slice(null, [1, 3])), [1, 2, 5, 6, 9, 10]);
  assert.deepEqual(await read(m.slice([null, null, -1], 0)), [8, 4, 0]);
  assert.deepEqual(
    await read(
      gpu
        .arange(1, 4, 1, 'f32')
        .reshape(3, 1)
        .mul(gpu.arange(1, 4, 1, 'f32')),
    ),
    [1, 2, 3, 2, 4, 6, 3, 6, 9],
  );
  const x = gpu.array([-2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 0.1]);
  assert.deepEqual(await read(x.round()), [-2, -2, -0, 0, 2, 2, 0]);
  assert.deepEqual(await read(x.mul(3)), f32([-7.5, -4.5, -1.5, 1.5, 4.5, 7.5, Math.fround(0.1) * 3]));
  assert.deepEqual(await read(gpu.where(x.gt(0), x, 0)), f32([0, 0, 0, 0.5, 1.5, 2.5, 0.1]));
  const big = gpu.array([2147483647, -2147483648, 7, -7], 'i32');
  assert.deepEqual(await read(big.add(1)), [-2147483648, -2147483647, 8, -6]);
  assert.deepEqual(await read(big.floorDiv(2)), [1073741823, -1073741824, 3, -4]);
  assert.deepEqual(await read(big.mod(3)), [1, 1, 1, 2]);
  assert.deepEqual(await read(gpu.array([1, 2], 'u32').sub(3)), [4294967294, 4294967295], 'a fitting int stays u32');
  assert.deepEqual(await read(gpu.array([1, 2], 'u32').sub(gpu.array([3, 3], 'u32'))), [4294967294, 4294967295]);
  assert.deepEqual(await read(gpu.array([1.9, -1.9, 3e9, Number.NaN]).astype('i32')), [1, -1, 2147483647, 0]);
  assert.deepEqual(await read(gpu.array([1], 'f32').bitcast('u32')), [0x3f800000]);
  assert.deepEqual(await read(gpu.array([0b1011, 255], 'u32').popcount()), [3, 8]);
  assert.deepEqual(await read(gpu.array([-8], 'i32').shiftRight(1)), [-4]);
  assert.deepEqual(await read(gpu.array([1, Number.NaN, Infinity]).isnan()), [0, 1, 0]);
  assert.deepEqual(await read(gpu.linspace(0, 1, 5)), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(await read(gpu.eye(2)), [1, 0, 0, 1]);
  assert.deepEqual(await read(gpu.full([2], 7, 'i32')), [7, 7]);
  close(await read(x.exp()), f32([-2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 0.1].map(Math.exp)), 1e-7);
  const z = x.sub(x.mean()).div(x.std());
  assert.equal((await z.read()).length, 7);
  assert.equal(await gpu.array([4]).item(), 4);
});

test('cpu: reductions and statistics along axes, NaN-aware forms, argmin and argmax', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const data = gpu.array(new Float32Array([1, 9, 3, 7, 2, 8]), { shape: [2, 3] });
  assert.deepEqual(await read(data.sum({ axis: 0 })), [8, 11, 11]);
  assert.deepEqual(await read(data.sum({ axis: 1, keepdims: true })), [13, 17]);
  assert.deepEqual(data.sum({ axis: 1, keepdims: true }).shape, [2, 1]);
  assert.equal(await data.sum().item(), 30);
  assert.equal(await data.prod().item(), 3024);
  assert.equal(await data.min().item(), 1);
  assert.deepEqual(await read(data.max({ axis: -1 })), [9, 8]);
  assert.deepEqual(await read(data.argmax({ axis: 1 })), [1, 2]);
  assert.equal(await data.argmin().item(), 0);
  assert.equal(await gpu.argmax(gpu.array([5, 5, 1])).item(), 0, 'first on ties');
  assert.equal(await data.mean().item(), 5);
  close([await data.var().item()], [58 / 6]);
  close([await data.std({ ddof: 1 }).item()], [Math.sqrt(58 / 5)]);
  assert.equal(await gpu.nanmean(gpu.array([1, Number.NaN, 3])).item(), 2);
  assert.equal(await gpu.nansum(gpu.array([1, Number.NaN, 3])).item(), 4);
  assert.equal(await gpu.nanmax(gpu.array([Number.NaN, -2])).item(), -2);
  assert.deepEqual(await read(gpu.all(gpu.array([1, 0, 2, 3], { shape: [2, 2] }), { axis: 1 })), [0, 1]);
  assert.equal(await gpu.countNonzero(gpu.array([0, 1, 2, 0])).item(), 2);
  assert.equal(await gpu.array([2147483647, 1], 'i32').sum().item(), -2147483648, 'integer sums wrap');
  assert.equal(await gpu.zeros([0]).sum().item(), 0);
  assert.equal(await gpu.zeros([0]).max().item(), -Infinity);
  // A long float sum accumulates in double precision, then rounds once.
  const ones = gpu.full([1 << 20], 0.1);
  close([await ones.sum().item()], [Math.fround(Math.fround(0.1) * (1 << 20))], 1e-7);
  assert.throws(
    () => gpu.reduce(data, { combine: 'a + b', identity: '0.0' }),
    (e) => e.code === 'unsupported' && /custom WGSL/.test(e.message),
  );
});

test('cpu: scans (flat, along an axis, exclusive), segmented scans and reduceByKey', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const m = gpu.array([1, 2, 3, 4, 5, 6], { shape: [2, 3] });
  assert.deepEqual(await read(gpu.cumsum(m)), [1, 3, 6, 10, 15, 21]);
  assert.deepEqual(gpu.cumsum(m).shape, [6]);
  assert.deepEqual(await read(gpu.cumsum(m, { axis: 0 })), [1, 2, 3, 5, 7, 9]);
  assert.deepEqual(await read(gpu.scan(m, { axis: 1, exclusive: true })), [0, 1, 3, 0, 4, 9]);
  assert.deepEqual(await read(gpu.cumprod(gpu.array([1, 2, 3, 4]))), [1, 2, 6, 24]);
  assert.deepEqual(await read(gpu.scan(gpu.array([3, 1, 4, 1, 5]), { op: 'max' })), [3, 3, 4, 4, 5]);
  const flags = gpu.array([1, 0, 0, 1, 0], 'u32');
  assert.deepEqual(await read(gpu.segmentedScan(gpu.array([1, 2, 3, 4, 5]), flags)), [1, 3, 6, 4, 9]);
  assert.deepEqual(
    await read(gpu.segmentedScan(gpu.array([1, 2, 3, 4, 5]), flags, { exclusive: true })),
    [0, 1, 3, 0, 4],
  );
  const grouped = await gpu.reduceByKey(gpu.array([1, 1, 2, 3, 3, 3], 'u32'), gpu.array([1, 2, 3, 4, 5, 6]));
  assert.deepEqual(await read(grouped.keys), [1, 2, 3]);
  assert.deepEqual(await read(grouped.values), [3, 3, 15]);
});

test('cpu: radix sort order (NaN by sign bit, -0 before 0), stability, bits, descending and order statistics', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const x = gpu.array([3, -0, Number.NaN, -Infinity, 0, 1, -2, Infinity]);
  const sorted = await read(gpu.sort(x));
  assert.deepEqual(sorted.slice(0, 7), [-Infinity, -2, -0, 0, 1, 3, Infinity]);
  assert.ok(Object.is(sorted[2], -0) && Number.isNaN(sorted[7]));
  assert.deepEqual(await read(gpu.argsort(gpu.array([2, 1, 2, 1]))), [1, 3, 0, 2], 'stable');
  assert.deepEqual(await read(gpu.argsort(gpu.array([2, 1, 2, 1]), { descending: true })), [0, 2, 1, 3]);
  assert.deepEqual(await read(gpu.sort(gpu.array([5, -3, 0, -2147483648], 'i32'))), [-2147483648, -3, 0, 5]);
  // bits: 16 sorts on the low 16 bits only, so 0x10001 and 1 tie and keep their order.
  assert.deepEqual(await read(gpu.sort(gpu.array([0x10001, 2, 1], 'u32'), { bits: 16 })), [0x10001, 1, 2]);
  assert.throws(() => gpu.sort(x, { bits: 8 }), RangeError);
  const pairs = gpu.sortByKey(gpu.array([3, 1, 2], 'u32'), gpu.array([30, 10, 20]));
  assert.deepEqual(
    [await read(pairs.keys), await read(pairs.values)],
    [
      [1, 2, 3],
      [10, 20, 30],
    ],
  );
  const scores = gpu.array(new Float32Array([0.2, 0.9, 0.4, 0.7]));
  const best = gpu.topk(scores, 2);
  assert.deepEqual([await read(best.values), await read(best.indices)], [f32([0.9, 0.7]), [1, 3]]);
  assert.deepEqual(await read(gpu.topk(scores, 1, { largest: false }).indices), [0]);
  assert.equal(await gpu.median(gpu.array([5, 1, 3, 2])).item(), 2.5);
  close(await read(gpu.quantile(gpu.arange(0, 11, 1, 'f32'), [0, 0.25, 0.9])), [0, 2.5, 9]);
  const u = await gpu.unique(gpu.array([3, 1, 3, 2, 1, 3], 'i32'), { counts: true });
  assert.deepEqual(
    [await read(u.values), await read(u.counts)],
    [
      [1, 2, 3],
      [2, 1, 3],
    ],
  );
  // A large random sort agrees with Array.prototype.sort.
  const rand = lcg(7),
    many = Float32Array.from({ length: 50_000 }, () => rand() * 2 - 1);
  assert.deepEqual(
    await read(gpu.sort(gpu.array(many))),
    Array.from(many).sort((a, b) => a - b),
  );
});

test('cpu: take, scatter, bincount, compaction and histograms', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const m = gpu.array([10, 11, 12, 20, 21, 22], { shape: [2, 3] });
  assert.deepEqual(await read(gpu.take(m, gpu.array([5, -1, 9], 'i32'))), [22, 22, 22]);
  assert.deepEqual(await read(gpu.take(m, gpu.array([-1, 0], 'i32'), { axis: 1 })), [12, 10, 22, 20]);
  assert.deepEqual(await read(gpu.take(m, gpu.array([4], 'i32'), { axis: 1, mode: 'wrap' })), [11, 21]);
  assert.throws(() => gpu.take(m, gpu.array([0.5])), TypeError);
  const target = gpu.zeros(4);
  gpu.scatter(target, gpu.array([0, 1, 1, -1, 7], 'i32'), gpu.array([1, 2, 3, 4, 5]), { op: 'add' });
  assert.deepEqual(await read(target), [1, 5, 0, 4], 'duplicates add; -1 is the last; 7 is skipped');
  gpu.scatter(target, gpu.array([0, 2], 'i32'), 9);
  assert.deepEqual(await read(target), [9, 5, 9, 4]);
  gpu.scatter(target, gpu.array([0, 0], 'i32'), gpu.array([3, 12]), { op: 'max' });
  assert.equal((await target.read())[0], 12);
  assert.deepEqual(await read(gpu.bincount(gpu.array([1, 1, 3], 'u32'), { length: 5 })), [0, 2, 0, 1, 0]);
  assert.deepEqual(
    await read(gpu.bincount(gpu.array([0, 0], 'u32'), { length: 2, weights: gpu.array([0.5, 0.25]) })),
    [0.75, 0],
  );
  const x = gpu.array([5, 6, 7, 8]),
    { values, count } = gpu.compact(x, x.gt(6));
  assert.deepEqual([await read(values), await count.item()], [[7, 8, 0, 0], 2]);
  assert.deepEqual(await read(await gpu.filter(x, x.lt(7))), [5, 6]);
  assert.deepEqual(await read(await gpu.nonzero(gpu.array([0, 3, 0, 1]))), [1, 3]);
  const h = gpu.histogram(gpu.array([0, 0.25, 0.5, 0.75, 1, 1.5]), { bins: 4, range: [0, 1] });
  assert.deepEqual(
    [await read(h.counts), await read(h.edges)],
    [
      [1, 1, 1, 2],
      [0, 0.25, 0.5, 0.75, 1],
    ],
  );
  assert.deepEqual(await read(gpu.histogram(gpu.array([2, 2, 2]), { bins: 2 }).counts), [0, 3], 'lo == hi widens');
});

test('cpu: matmul (batches, broadcasting, transposed views, 1-D operands, integers), dot, outer and norm', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const a = gpu.array([1, 2, 3, 4, 5, 6], { shape: [2, 3] }),
    b = gpu.array([7, 8, 9, 10, 11, 12], { shape: [3, 2] });
  assert.deepEqual(await read(matmul(a, b)), [58, 64, 139, 154]);
  assert.deepEqual(await read(matmul(a, a.T)), [14, 32, 32, 77]);
  assert.deepEqual(await read(matmul(gpu.array([1, 1, 1]), b)), [27, 30]);
  assert.deepEqual(matmul(a, gpu.array([1, 0, 0])).shape, [2]);
  const stack = gpu.array(
    Float32Array.from({ length: 12 }, (_, k) => k),
    { shape: [2, 2, 3] },
  );
  assert.deepEqual(await read(matmul(stack, b)), [31, 34, 112, 124, 193, 214, 274, 304]);
  assert.deepEqual(
    await read(matmul(gpu.array([1, 2, 3, 4], { shape: [2, 2], dtype: 'i32' }), gpu.eye(2, 'i32'))),
    [1, 2, 3, 4],
  );
  assert.equal(await dot(gpu.array([1, 2, 3]), gpu.array([4, 5, 6])).item(), 32);
  assert.deepEqual(await read(outer(gpu.array([1, 2]), gpu.array([3, 4]))), [3, 4, 6, 8]);
  assert.equal(await norm(gpu.array([3, 4])).item(), 5);
});

test('cpu: FFTs of power-of-two and other lengths match a double-precision DFT; inverse, 2-D and fftfreq', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const dft = (x) =>
    x.map((_, k) => {
      let re = 0,
        im = 0;
      x.forEach((v, t) => {
        re += v * Math.cos((-2 * Math.PI * k * t) / x.length);
        im += v * Math.sin((-2 * Math.PI * k * t) / x.length);
      });
      return [re, im];
    });
  for (const n of [8, 64, 12, 100]) {
    const rand = lcg(n),
      x = Array.from({ length: n }, () => rand() - 0.5),
      { re, im } = fft(gpu.array(x)),
      want = dft(x);
    close(
      await read(re),
      want.map((c) => c[0]),
      1e-4,
      `fft ${n} re`,
    );
    close(
      await read(im),
      want.map((c) => c[1]),
      1e-4,
      `fft ${n} im`,
    );
    const back = ifft({ re, im });
    close(await read(back.re), x, 1e-5, `ifft ${n}`);
  }
  const image = gpu.array([1, 2, 3, 4], { shape: [2, 2] }),
    F = fft2(image);
  close(await read(F.re), [10, -2, -4, 0]);
  close(await read(fftfreq(gpu, 4)), [0, 0.25, -0.5, -0.25]);
});

test('cpu: convolution (direct and FFT, every mode), correlation and 2-D convolution', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const s = gpu.array([1, 2, 3, 4, 5]),
    k = gpu.array([1, 0, -1]);
  assert.deepEqual(await read(convolve(s, k)), [1, 2, 2, 2, 2, -4, -5]);
  assert.deepEqual(await read(convolve(s, k, { mode: 'same' })), [2, 2, 2, 2, -4]);
  assert.deepEqual(await read(convolve(s, k, { mode: 'valid' })), [2, 2, 2]);
  close(await read(convolve(s, k, { method: 'fft' })), [1, 2, 2, 2, 2, -4, -5], 1e-5);
  assert.deepEqual(await read(correlate(s, gpu.array([1, 2]))), [5, 8, 11, 14]);
  const image = gpu.array([1, 2, 3, 4, 5, 6, 7, 8, 9], { shape: [3, 3] }),
    box = gpu.ones([2, 2]);
  assert.deepEqual(await read(convolve2d(image, box, { mode: 'valid' })), [12, 16, 24, 28]);
  close(await read(convolve2d(image, box, { mode: 'valid', method: 'fft' })), [12, 16, 24, 28], 1e-5);
});

test('cpu: random numbers are the same Philox stream as the GPU; distributions and permutations', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const rng = new Random(gpu, { seed: 42 }),
    bits = await read(rng.bits(8));
  const key = [42, 0];
  assert.deepEqual(bits, [...philox4x32([0, 0, 0, 0], key), ...philox4x32([1, 0, 0, 0], key)]);
  const again = new Random(gpu, { seed: 42 });
  again.bits(8);
  const u = await read(again.uniform(100_000)),
    mean = u.reduce((a, b) => a + b, 0) / u.length;
  assert.ok(u.every((v) => v >= 0 && v < 1) && Math.abs(mean - 0.5) < 0.01);
  const z = await read(new Random(gpu, { seed: 3 }).normal(100_000, { mean: 2, std: 0.5 })),
    zm = z.reduce((a, b) => a + b, 0) / z.length,
    zv = z.reduce((a, b) => a + (b - zm) ** 2, 0) / z.length;
  assert.ok(Math.abs(zm - 2) < 0.01 && Math.abs(Math.sqrt(zv) - 0.5) < 0.01, `${zm} ${zv}`);
  const ints = await read(new Random(gpu, { seed: 5 }).integers(-3, 4, 1000));
  assert.ok(ints.every((v) => Number.isInteger(v) && v >= -3 && v < 4));
  const p = await read(new Random(gpu, { seed: 9 }).permutation(100));
  assert.deepEqual(
    [...p].sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, i) => i),
  );
});

test('cpu: streams reduce, summarise and bin chunk by chunk', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const data = Float32Array.from({ length: 10_000 }, (_, k) => (k % 100) / 100);
  close([await reduceStream(gpu, chunks(data, 3000), 'sum')], [49.5 * 100], 1e-6);
  const stats = await statsStream(gpu, chunks(data, 3000));
  assert.equal(stats.count, 10_000);
  close([stats.mean, stats.min, stats.max], [0.495, 0, 0.99], 1e-5);
  const h = await histogramStream(gpu, chunks(data, 4096), { bins: 10, range: [0, 1] });
  assert.deepEqual(await read(h.counts), new Array(10).fill(1000));
});

test('cpu: WGSL needs a GPU (coded errors); waits, profiling, aborts and disposal behave as on the GPU', async () => {
  const gpu = await createCompute({ backend: 'cpu' });
  assert.throws(
    () => gpu.kernel('@compute @workgroup_size(1) fn main() {}'),
    (e) => e.code === 'unsupported' && /needs a GPU/.test(e.message),
  );
  assert.throws(
    () => gpu.map(gpu.zeros(2), 'x + 1.0'),
    (e) => e.code === 'unsupported',
  );
  await gpu.done();
  assert.deepEqual(await gpu.profile(() => gpu.sort(gpu.zeros(4))), []);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(() => gpu.zeros(2).read({ signal: controller.signal }), /stop/);
  const x = gpu.zeros(3);
  x.dispose();
  assert.throws(
    () => x.add(1).eval(),
    (e) => e.code === 'disposed',
  );
  gpu.dispose();
  assert.throws(
    () => gpu.zeros(1),
    (e) => e.code === 'disposed',
  );
});
