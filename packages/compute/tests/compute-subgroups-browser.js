// Real-GPU checks of @margoengine/compute/subgroups: every swapped kernel against the default kernels on the same data,
// at sizes on both sides of each subgroup, block and level boundary. Integers, orders and sorts must match exactly;
// float sums round in another order. window.subgroupCost times both routes for the benchmark
// examples/package-benchmarks/compute-subgroups.mjs.
import { createCompute } from '@margoengine/compute';
import { useSubgroups } from '@margoengine/compute/subgroups';

const checks = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  checks.push(name);
};
const rng = (seed) => {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
};
const fill = (Type, n, seed, value) => {
  const r = rng(seed),
    a = new Type(n);
  for (let i = 0; i < n; i++) a[i] = value(r());
  return a;
};
const floats = (n, seed = 1) => fill(Float32Array, n, seed, (v) => v * 2 - 1);
const words = (n, seed = 2) => fill(Uint32Array, n, seed, (v) => v * 4294967296);
const ints = (n, seed = 3) => fill(Int32Array, n, seed, (v) => (v - 0.5) * 4294967296);
const same = (a, b, label) => {
  assert(a.length === b.length, `${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i])))
      throw new Error(`${label}: element ${i} is ${a[i]}, the default kernels gave ${b[i]}`);
};
// Both orders of an f32 sum are within a few roundings of the exact value of the running magnitude.
const close = (a, b, scale, label) => {
  assert(a.length === b.length, `${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++)
    if (!(Math.abs(a[i] - b[i]) <= scale)) throw new Error(`${label}: element ${i} is ${a[i]} against ${b[i]}`);
};

const SIZES = [1, 3, 31, 32, 33, 64, 127, 128, 129, 255, 256, 257, 1023, 1024, 1025, 4097, 65537, (1 << 20) + 3];
// The leftmost value that is not the identity: associative and not commutative, so any reordering shows.
const LEFTMOST = { combine: 'select(a, b, a == 0xffffffffu)', identity: '0xffffffffu' };

window.runSubgroupTests = async () => {
  const plain = await createCompute({ backend: 'webgpu' }),
    fast = await createCompute({ backend: 'webgpu' }),
    info = fast.device.adapterInfo;
  const both = async (work) => [await work(plain).read(), await work(fast).read()];
  try {
    if (!useSubgroups(fast)) {
      assert(!fast.subgroups, 'useSubgroups refused a device with the feature');
      return { checks: ['subgroups: this adapter has none, nothing changed'], subgroups: null };
    }
    await check('a device without the feature is left as it was', async () => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const shared = await createCompute({ device });
      assert(shared.subgroups === false && useSubgroups(shared) === false, 'expected false');
      assert(shared.kernelRoute === undefined, 'a route was installed');
      same(await shared.sort(shared.array(new Uint32Array([3, 1, 2]))).read(), [1, 2, 3], 'sort');
      shared.dispose();
      device.destroy();
    });
    await check('integer reductions match the default kernels at every size', async () => {
      for (const n of SIZES) {
        const u = words(n, n),
          s = ints(n, n);
        for (const op of ['sum', 'product', 'min', 'max']) {
          const [a, b] = await both((gpu) => gpu.reduce(gpu.array(u), op));
          same(a, b, `u32 ${op} n=${n}`);
          const [c, d] = await both((gpu) => gpu.reduce(gpu.array(s), op));
          same(c, d, `i32 ${op} n=${n}`);
        }
      }
    });
    await check('float reductions agree at every size, min and max exactly', async () => {
      for (const n of SIZES) {
        const x = floats(n, n);
        const [a, b] = await both((gpu) => gpu.array(x).sum());
        close(a, b, 1e-6 * n + 1e-5, `sum n=${n}`);
        for (const op of ['min', 'max']) {
          const [c, d] = await both((gpu) => gpu.reduce(gpu.array(x), op));
          same(c, d, `${op} n=${n}`);
        }
      }
    });
    await check('a float sum is the same on every run', async () => {
      const x = fast.array(floats((1 << 20) + 3, 9));
      const first = await x.sum().item();
      for (let k = 0; k < 20; k++) assert((await x.sum().item()) === first, `run ${k} differs`);
    });
    await check('a fused expression feeds the reduction', async () => {
      const x = floats(100_000, 4);
      const [a, b] = await both((gpu) => gpu.array(x).mul(2).add(1).square().sum());
      close(a, b, 1, 'fused sum');
    });
    await check('a custom operator keeps left-to-right order', async () => {
      for (const n of SIZES) {
        const u = words(n, n + 1);
        const [a] = await both((gpu) => gpu.reduce(gpu.array(u), LEFTMOST));
        same(a, [u[0]], `leftmost n=${n}`);
      }
    });
    await check('axis reductions match, on long and strided lines', async () => {
      for (const shape of [
        [3, 5000],
        [5000, 3],
        [2, 65, 7],
        [4, 257],
      ]) {
        const size = shape.reduce((p, q) => p * q, 1),
          u = words(size, size);
        for (let axis = 0; axis < shape.length; axis++)
          for (const op of ['sum', 'min', 'max']) {
            const [a, b] = await both((gpu) => gpu.reduce(gpu.array(u, { shape }), op, { axis }));
            same(a, b, `${op} axis ${axis} of [${shape}]`);
          }
      }
      const u = words(4 * 1000, 8);
      const [left] = await both((gpu) => gpu.reduce(gpu.array(u, { shape: [4, 1000] }), LEFTMOST, { axis: 1 }));
      same(left, [u[0], u[1000], u[2000], u[3000]], 'leftmost along an axis');
    });
    await check('scans match at every size, inclusive and exclusive', async () => {
      for (const n of SIZES) {
        const u = words(n, n + 2);
        for (const exclusive of [false, true])
          for (const op of ['sum', 'min', 'max']) {
            const [a, b] = await both((gpu) => gpu.scan(gpu.array(u), { op, exclusive }));
            same(a, b, `${op} exclusive=${exclusive} n=${n}`);
          }
        const x = floats(n, n + 3);
        const [c, d] = await both((gpu) => gpu.cumsum(gpu.array(x)));
        close(c, d, 1e-6 * Math.sqrt(n) * 64 + 1e-5, `cumsum n=${n}`);
      }
    });
    await check('a scan with a custom operator keeps left-to-right order', async () => {
      for (const n of SIZES) {
        const u = words(n, n + 4);
        const [a] = await both((gpu) => gpu.scan(gpu.array(u), { op: LEFTMOST }));
        same(a, new Uint32Array(n).fill(u[0]), `leftmost scan n=${n}`);
      }
    });
    await check('sorts match at every size, all types, both directions', async () => {
      for (const n of SIZES) {
        for (const data of [floats(n, n + 5), words(n, n + 6), ints(n, n + 7)])
          for (const descending of [false, true]) {
            const [a, b] = await both((gpu) => gpu.sort(gpu.array(data), { descending }));
            same(a, b, `${data.constructor.name} descending=${descending} n=${n}`);
          }
      }
    });
    await check('argsort is stable on repeated keys', async () => {
      for (const n of SIZES) {
        const keys = fill(Uint32Array, n, n + 8, (v) => Math.floor(v * 7));
        const [a, b] = await both((gpu) => gpu.argsort(gpu.array(keys)));
        same(a, b, `argsort n=${n}`);
        for (let i = 1; i < n; i++)
          assert(
            keys[a[i - 1]] < keys[a[i]] || (keys[a[i - 1]] === keys[a[i]] && a[i - 1] < a[i]),
            `not stable at ${i} of ${n}`,
          );
      }
    });
    await check('keys at the padding value, narrow bits and sortByKey match', async () => {
      const n = 1000,
        keys = words(n, 11);
      for (let i = 0; i < n; i += 3) keys[i] = 0xffffffff;
      const [a, b] = await both((gpu) => gpu.argsort(gpu.array(keys)));
      same(a, b, 'all-ones keys');
      const small = fill(Uint32Array, 5000, 12, (v) => Math.floor(v * 256));
      const [c, d] = await both((gpu) => gpu.sort(gpu.array(small), { bits: 8 }));
      same(c, d, 'bits: 8');
      const values = floats(5000, 13);
      const pair = async (gpu) => {
        const out = gpu.sortByKey(gpu.array(small), gpu.array(values));
        return [await out.keys.read(), await out.values.read()];
      };
      const [[k1, v1], [k2, v2]] = [await pair(plain), await pair(fast)];
      same(k1, k2, 'sortByKey keys');
      same(v1, v2, 'sortByKey values');
    });
    await check('what is built on scan and sort gives the same answers', async () => {
      const x = fill(Uint32Array, 70_000, 14, (v) => Math.floor(v * 1000));
      const run = async (gpu) => {
        const a = gpu.array(x);
        const distinct = await gpu.unique(a, { counts: true }),
          kept = await gpu.filter(a, a.gt(500)),
          top = gpu.topk(a, 10);
        return [
          await distinct.values.read(),
          await distinct.counts.read(),
          await kept.read(),
          await top.indices.read(),
        ];
      };
      const [p, q] = [await run(plain), await run(fast)];
      p.forEach((part, k) => same(part, q[k], `part ${k}`));
    });
    await check('f16 arrays keep the default kernels and still work', async () => {
      if (!fast.f16) return;
      const a = await fast.array(new Float32Array([1, 2, 3, 4]), 'f16').sum().item();
      assert(a === 10, `f16 sum is ${a}`);
    });
    return { checks, subgroups: { min: info?.subgroupMinSize, max: info?.subgroupMaxSize } };
  } finally {
    plain.dispose();
    fast.dispose();
  }
};

const TIMED = {
  sum: (gpu, x) => gpu.sum(x),
  'sum axis': (gpu, x) => gpu.sum(x.reshape(16, -1), { axis: 1 }),
  cumsum: (gpu, x) => gpu.cumsum(x),
  sort: (gpu, x) => gpu.sort(x),
  argsort: (gpu, x) => gpu.argsort(x),
};

/** GPU milliseconds of each operation on both routes, in turns: `{ name: { plain: [...], subgroups: [...] } }`. */
window.subgroupCost = async ({ count = 1 << 24, trials = 12 } = {}) => {
  const plain = await createCompute({ backend: 'webgpu' }),
    fast = await createCompute({ backend: 'webgpu' });
  if (!useSubgroups(fast)) throw new Error('This adapter has no subgroups');
  const data = floats(count, 5),
    arms = { plain: [plain, plain.array(data)], subgroups: [fast, fast.array(data)] },
    rows = {};
  for (const [name, work] of Object.entries(TIMED)) {
    const row = (rows[name] = { plain: [], subgroups: [] });
    for (let k = 0; k <= trials; k++)
      for (const [arm, [gpu, x]] of Object.entries(arms)) {
        let result;
        const passes = await gpu.profile(() => (result = work(gpu, x)));
        result.dispose?.();
        // The first trial compiles the kernels.
        if (k > 0) row[arm].push(passes.reduce((sum, p) => sum + p.ms, 0));
      }
  }
  plain.dispose();
  fast.dispose();
  return rows;
};
