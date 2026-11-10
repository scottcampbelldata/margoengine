import test from 'node:test';
import assert from 'node:assert/strict';
import { createCpuWasm } from '@margoengine/compute/cpu-wasm';
import { createCompute } from '@margoengine/compute';
import { matmul } from '@margoengine/compute/linalg';
import { fft } from '@margoengine/compute/fft';
import { convolve, convolve2d } from '@margoengine/compute/signal';
import { Random } from '@margoengine/compute/random';
import { coo, spmv } from '@margoengine/compute/sparse';
import { cpuCases } from './cpu-cases.js';

cpuCases(createCpuWasm, 'cpu-wasm');

test('cpu-wasm: exact paired arithmetic, SIMD work, isolated instances and growing memory', async () => {
  using js = await createCompute({ backend: 'cpu' });
  using wasm = await createCpuWasm();
  using other = await createCpuWasm();
  async function paired(work) {
    const a = await work(js),
      b = await work(wasm);
    assert.deepEqual(b, a);
  }
  const raw = [-Infinity, -3e9, -7.5, -1, -0, 0, 0.1, 0.5, 2, 3e9, Infinity, NaN];
  const unary = [
    'neg',
    'abs',
    'sign',
    'square',
    'sqrt',
    'exp',
    'exp2',
    'log',
    'log2',
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'sinh',
    'cosh',
    'tanh',
    'degrees',
    'radians',
    'rsqrt',
    'reciprocal',
    'log1p',
    'expm1',
    'floor',
    'ceil',
    'trunc',
    'round',
    'not',
    'isnan',
    'isinf',
    'isfinite',
  ];
  for (const dtype of ['f32', 'i32', 'u32']) {
    for (const method of unary) await paired(async (c) => Array.from(await c.array(raw, dtype)[method]().read()));
    for (const method of [
      'add',
      'sub',
      'mul',
      'div',
      'floorDiv',
      'mod',
      'pow',
      'minimum',
      'maximum',
      'atan2',
      'hypot',
      'lt',
      'le',
      'gt',
      'ge',
      'eq',
      'ne',
      'and',
      'or',
      'xor',
    ])
      await paired(async (c) =>
        Array.from(await c.array(raw, dtype)[method](c.array(raw.slice().reverse(), dtype)).read()),
      );
    for (const out of ['f32', 'i32', 'u32'])
      await paired(async (c) => Array.from(await c.array(raw, dtype).astype(out).read()));
  }
  for (const dtype of ['i32', 'u32'])
    for (const method of ['bitAnd', 'bitOr', 'bitXor', 'shiftLeft', 'shiftRight'])
      await paired(async (c) =>
        Array.from(
          await c
            .array(raw, dtype)
            [method](c.array([0, 1, 31, 32, 33, -1, 2, 7, 11, 63, 4, 8], dtype))
            .read(),
        ),
      );
  for (const dtype of ['f32', 'i32', 'u32'])
    for (const out of ['f32', 'i32', 'u32'])
      await paired(async (c) => Array.from(await c.array(raw, dtype).bitcast(out).read()));
  const data = Float32Array.from({ length: 131075 }, (_, i) => ((i % 101) - 50) / 8);
  await paired(async (c) => Array.from(await c.array(data).mul(2).add(1).sub(0.5).read()));
  assert.ok(wasm.work.simdGroups >= 3 * Math.floor(data.length / 2));
  assert.equal(other.work.calls, 0);
  const retained = wasm.array([3, 4, 5]);
  wasm
    .ones(1 << 20)
    .add(2)
    .eval()
    .dispose();
  assert.deepEqual(Array.from(await retained.read()), [3, 4, 5]);
  await paired(async (c) =>
    Array.from(
      await matmul(
        c.array(data.subarray(0, 35), { shape: [5, 7] }),
        c.array(data.subarray(5, 26), { shape: [7, 3] }),
      ).read(),
    ),
  );
  for (const kind of ['bits', 'uniform', 'normal', 'integers'])
    await paired(async (c) => {
      const r = new Random(c, { seed: 0xffffffff });
      return Array.from(await (kind === 'integers' ? r.integers(-2147483648, 2147483647, 103) : r[kind](103)).read());
    });
  for (const dtype of ['f32', 'i32', 'u32'])
    await paired(async (c) => {
      const x = c.array([1, 4, 2, 4, 3, 2], { shape: [2, 3], dtype }),
        results = [];
      const save = async (x) => {
        results.push(Array.from(await x.read()));
      };
      for (const op of ['sum', 'product', 'min', 'max']) {
        for (const axis of [undefined, 0, 1, []]) await save(c.reduce(x, op, { axis }));
        for (const axis of [undefined, 0, 1])
          for (const exclusive of [false, true]) await save(c.scan(x, { axis, exclusive, op }));
        await save(c.segmentedScan(x, c.array([1, 0, 0, 1, 0, 0], 'u32'), { op }));
        const g = await c.reduceByKey(c.array([1, 1, 2, 3, 3, 3]), x, { op });
        await save(g.keys);
        await save(g.values);
      }
      for (const descending of [false, true]) {
        await save(c.sort(x, { descending }));
        await save(c.argsort(x, { descending }));
      }
      const k = c.sortByKey(x, x);
      await save(k.keys);
      await save(k.values);
      const unique = await c.unique(x, { counts: true });
      await save(unique.values);
      await save(unique.counts);
      await save(c.quantile(x, [0, 0.1, 0.5, 1]));
      await save(c.argmin(x, { axis: 0 }));
      await save(c.argmax(x, { axis: 1 }));
      await save(c.take(x, c.array([-8, -1, 1, 8], 'i32'), { axis: 1, mode: 'wrap' }));
      const target = c.zeros(4, dtype);
      c.scatter(target, c.array([0, 0, -1, 5], 'i32'), c.array([1, 2, 3, 4], dtype), { op: 'add' });
      await save(target);
      const compact = c.compact(x, x.gt(2));
      await save(compact.values);
      await save(compact.count);
      const h = c.histogram(x, { bins: 3 });
      await save(h.counts);
      await save(h.edges);
      return results;
    });
  await paired(async (c) => {
    const a = coo(c, { rows: [0, 0, 1, 1], cols: [0, 1, 0, 1], values: [2, 1, 1, 3], shape: [2, 2] });
    return [Array.from(await spmv(a, c.array([3, 4])).read()), Array.from(await a.diagonal().read())];
  });
  await paired(async (c) => {
    const x = c.array([0.1, -0.7, 3, 0, 1.1, -2, 0.3, 4]),
      z = fft(x),
      conv = convolve(x, c.array([0.3, -0.8, 1.7])),
      image = c.array([0.1, 0.2, 0.3, 0.4], { shape: [2, 2] }),
      conv2 = convolve2d(image, c.array([0.3, -0.8, 1.7, 0.5], { shape: [2, 2] }));
    return Promise.all([z.re, z.im, conv, conv2].map(async (a) => Array.from(await a.read())));
  });
});

test('cpu-wasm: abort reason and context disposal', async () => {
  const controller = new AbortController(),
    reason = new Error('cancel CPU load');
  controller.abort(reason);
  await assert.rejects(createCpuWasm({ signal: controller.signal }), (e) => e === reason);
  const c = await createCpuWasm();
  const x = c.ones(3);
  assert.throws(
    () => c.zeros(8_388_608).add(1).eval(),
    (e) => e instanceof RangeError && /smaller chunks/.test(e.message),
  );
  assert.deepEqual(Array.from(await x.add(1).read()), [2, 2, 2]);
  c.dispose();
  c.dispose();
  assert.throws(
    () => x.add(1).eval(),
    (e) => e.code === 'disposed',
  );
});
