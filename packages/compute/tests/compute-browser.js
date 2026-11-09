import { speedEnabled } from './speed-phase.mjs';
// Real-GPU checks of @margoengine/compute: every operation against a CPU reference written here, at sizes on both
// sides of each block boundary (255/256/257, 1023/1024/1025, multi-level), plus views, broadcasting, kernels, errors,
// abort, disposal, profiling and device sharing. Each check is named; the runner prints them.
import { Engine } from '@margoengine/core';
import { createCompute } from '@margoengine/compute';

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
// Deterministic data: xorshift, so a failure reproduces.
const rng = (seed) => {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
};
const floats = (n, seed = 1, scale = 1000) => {
  const r = rng(seed),
    a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (r() - 0.5) * scale;
  return a;
};
const equal = (a, b, label) => {
  assert(a.length === b.length, `${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++)
    if (!Object.is(a[i], b[i]) && !(a[i] === 0 && b[i] === 0) && !(Number.isNaN(a[i]) && Number.isNaN(b[i])))
      throw new Error(`${label}: element ${i} is ${a[i]}, expected ${b[i]}`);
};
const near = (a, b, tolerance, label) => {
  assert(a.length === b.length, `${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++)
    if (!(Math.abs(a[i] - b[i]) <= tolerance * Math.max(1, Math.abs(b[i]))))
      throw new Error(`${label}: element ${i} is ${a[i]}, expected ${b[i]} (tolerance ${tolerance})`);
};
const f = Math.fround;
const SIZES = [1, 255, 256, 257, 1023, 1024, 1025, 4097, 1 << 20, (1 << 21) + 5];

window.runComputeTests = async () => {
  const timings = {};
  const gpu = await createCompute();

  await check('arrays round-trip f32, i32 and u32 data with shapes, and read sub-ranges', async () => {
    const x = floats(1000),
      i = Int32Array.from(x, (v) => Math.round(v) * 1000),
      u = Uint32Array.from(x, (_, k) => (k * 2654435761) >>> 0);
    equal(await gpu.array(x).read(), x, 'f32');
    equal(await gpu.array(i).read(), i, 'i32');
    equal(await gpu.array(u).read(), u, 'u32');
    equal(await gpu.array(u).read({ offset: 3, length: 5 }), u.subarray(3, 8), 'sub-range');
    const m = gpu.array(x.subarray(0, 6), { shape: [2, 3] });
    assert(m.shape.join() === '2,3' && m.size === 6 && m.ndim === 2, 'shape');
    equal(await gpu.zeros([0]).read(), new Float32Array(0), 'empty');
    equal(
      await gpu.zeros(8, 'u32').write([7, 8], 6).read(),
      new Uint32Array([0, 0, 0, 0, 0, 0, 7, 8]),
      'write at offset',
    );
  });

  await check('creation: arange, linspace, full, ones, eye', async () => {
    equal(await gpu.arange(5).read(), new Uint32Array([0, 1, 2, 3, 4]), 'arange(5)');
    equal(await gpu.arange(-3, 3, 2).read(), new Int32Array([-3, -1, 1]), 'arange(-3, 3, 2)');
    equal(await gpu.arange(0, 1, 0.25).read(), new Float32Array([0, 0.25, 0.5, 0.75]), 'float arange');
    equal(await gpu.linspace(0, 1, 5).read(), new Float32Array([0, 0.25, 0.5, 0.75, 1]), 'linspace');
    equal(await gpu.full([2, 2], 7, 'i32').read(), new Int32Array([7, 7, 7, 7]), 'full');
    equal(await gpu.eye(3).read(), new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 'eye');
  });

  await check(
    'fused expressions: arithmetic, math functions, comparisons, where, casts, NumPy mod and floor division',
    async () => {
      const x = floats(5000, 2, 20),
        y = floats(5000, 3, 20);
      const gx = gpu.array(x),
        gy = gpu.array(y);
      equal(
        await gx.mul(2).add(gy).read(),
        Float32Array.from(x, (v, k) => f(f(v * 2) + y[k])),
        'x*2 + y',
      );
      near(
        await gx.abs().sqrt().exp().log().read(),
        Float32Array.from(x, (v) => Math.sqrt(Math.abs(v))),
        1e-5,
        'log(exp(sqrt|x|))',
      );
      equal(
        await gx.gt(gy).read(),
        Uint32Array.from(x, (v, k) => (v > y[k] ? 1 : 0)),
        'x > y',
      );
      equal(
        await gpu.where(gx.gt(0), gx, 0).read(),
        Float32Array.from(x, (v) => (v > 0 ? v : 0)),
        'where (ReLU)',
      );
      equal(
        await gx.astype('i32').read(),
        Int32Array.from(x, (v) => Math.trunc(v)),
        'astype i32 truncates',
      );
      const a = gpu.array([-7, 7, -7, 7], 'i32'),
        b = gpu.array([2, -2, -2, 2], 'i32');
      equal(await a.mod(b).read(), new Int32Array([1, -1, -1, 1]), 'mod takes the sign of the divisor');
      equal(await a.floorDiv(b).read(), new Int32Array([-4, -4, 3, 3]), 'floor division');
      equal(await a.div(b).read(), new Float32Array([-3.5, -3.5, 3.5, 3.5]), 'true division of integers is f32');
      const nan = gpu.array([NaN, Infinity, -Infinity, 1]);
      equal(await nan.isnan().read(), new Uint32Array([1, 0, 0, 0]), 'isnan');
      equal(await nan.isinf().read(), new Uint32Array([0, 1, 1, 0]), 'isinf');
      equal(await nan.isfinite().read(), new Uint32Array([0, 0, 0, 1]), 'isfinite');
      near(await gpu.array([1e-8, 0.5]).log1p().read(), [1e-8, Math.log1p(0.5)], 1e-6, 'log1p keeps small values');
      near(await gpu.array([1e-8, 0.5, -100]).expm1().read(), [1e-8, Math.expm1(0.5), -1], 1e-6, 'expm1');
      equal(await gpu.array([2.5, 3.5, -2.5]).round().read(), new Float32Array([2, 4, -2]), 'round half to even');
      equal(await gpu.array([5, 3], 'u32').bitAnd(6).shiftLeft(1).read(), new Uint32Array([8, 4]), 'bit ops');
    },
  );

  await check(
    'broadcasting and views: row + column, transpose, slices (with negative steps), broadcastTo, squeeze',
    async () => {
      const m = gpu.array(
        Float32Array.from({ length: 12 }, (_, k) => k),
        { shape: [3, 4] },
      );
      const col = gpu.array([100, 200, 300], { shape: [3, 1] }),
        row = gpu.array([1, 2, 3, 4]);
      const want = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) want.push(r * 4 + c + (r + 1) * 100 + c + 1);
      equal(await m.add(col).add(row).read(), Float32Array.from(want), 'matrix + column + row');
      const t = m.T;
      assert(t.shape.join() === '4,3' && !t.contiguous, 'transpose is a view');
      equal(await t.read(), Float32Array.from([0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11]), 'transpose read');
      equal(await m.slice(1).read(), new Float32Array([4, 5, 6, 7]), 'row 1');
      equal(await m.slice(null, [1, 3]).read(), new Float32Array([1, 2, 5, 6, 9, 10]), 'columns 1..2');
      equal(
        await m.slice([null, null, -1], [null, null, -2]).read(),
        new Float32Array([11, 9, 7, 5, 3, 1]),
        'reversed rows, every other column backwards',
      );
      equal(await row.broadcastTo([2, 4]).read(), new Float32Array([1, 2, 3, 4, 1, 2, 3, 4]), 'broadcastTo');
      assert(col.squeeze().shape.join() === '3' && row.expandDims(0).shape.join() === '1,4', 'squeeze, expandDims');
      equal(await m.reshape(2, -1).slice(1).read(), new Float32Array([6, 7, 8, 9, 10, 11]), 'reshape(2, -1)');
      let error;
      try {
        m.add(gpu.array([1, 2, 3]));
      } catch (e) {
        error = e;
      }
      assert(error instanceof RangeError && /do not broadcast/.test(error.message), 'shape mismatch is a RangeError');
    },
  );

  await check(
    'reduce: sum, prod, min, max and a custom operator at every block boundary; integer sums exact',
    async () => {
      for (const n of SIZES) {
        const x = floats(n, n),
          g = gpu.array(x);
        let sum = 0,
          magnitude = 0,
          min = Infinity,
          max = -Infinity;
        for (const v of x) {
          sum += v;
          magnitude += Math.abs(v);
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        // f32 tree sums round about log2(n) times per element; 1e-6 of the summed magnitudes is far above that error and
        // far below the effect of a missing or doubled element.
        const s = await g.sum().item();
        assert(Math.abs(s - sum) <= 1e-6 * magnitude * Math.log2(n + 2), `sum of ${n}: ${s} vs ${sum}`);
        assert((await g.min().item()) === min, `min of ${n}`);
        assert((await g.max().item()) === max, `max of ${n}`);
        const ints = Int32Array.from(x, (v) => Math.round(v));
        let isum = 0,
          imax = -Infinity;
        for (const v of ints) {
          isum = (isum + v) | 0;
          imax = Math.max(imax, v);
        }
        const gi = gpu.array(ints);
        assert((await gi.sum().item()) === isum, `i32 sum of ${n}`);
        assert(
          (await gpu.reduce(gi, { combine: 'max(a, b)', identity: '(-2147483647i - 1i)' }).item()) === imax,
          `custom max of ${n}`,
        );
      }
      assert((await gpu.array([1.5, 2, -4, 0.25]).prod().item()) === -3, 'product');
      assert((await gpu.zeros(0).min().item()) === Infinity, 'empty min is +Infinity');
      assert((await gpu.zeros(0).max().item()) === -Infinity, 'empty max is -Infinity');
      assert((await gpu.zeros(0, 'u32').sum().item()) === 0, 'empty sum is 0');
      assert((await gpu.array([5, 0xffffffff, 3], 'u32').max().item()) === 0xffffffff, 'u32 max');
      // combine(a, b) = b when b is set keeps the last set element only if every combine keeps left before right.
      const data = new Uint32Array(300000);
      data[123] = 5;
      data[250000] = 9;
      assert(
        (await gpu.reduce(gpu.array(data), { combine: 'select(a, b, b != 0u)', identity: '0u' }).item()) === 9,
        'operand order',
      );
    },
  );

  await check('reductions along axes (thread and workgroup paths), keepdims, several axes, fused input', async () => {
    for (const [rows, cols] of [
      [3, 5],
      [5000, 7],
      [7, 5000],
      [1, 1],
      [64, 300],
    ]) {
      const x = floats(rows * cols, rows + cols, 10),
        g = gpu.array(x, { shape: [rows, cols] });
      const colSums = new Float64Array(cols),
        rowMax = new Float32Array(rows).fill(-Infinity);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          colSums[c] += x[r * cols + c];
          rowMax[r] = Math.max(rowMax[r], x[r * cols + c]);
        }
      near(await g.sum({ axis: 0 }).read(), colSums, 1e-4, `sum axis 0 of ${rows}x${cols}`);
      equal(await g.max({ axis: -1 }).read(), rowMax, `max axis -1 of ${rows}x${cols}`);
      assert(g.sum({ axis: 1, keepdims: true }).shape.join() === `${rows},1`, 'keepdims');
    }
    const cube = gpu.arange(24, undefined, 1, 'f32').reshape(2, 3, 4);
    equal(await cube.sum({ axis: [0, 2] }).read(), new Float32Array([60, 92, 124]), 'sum over axes 0 and 2');
    equal(
      await cube.square().sum({ axis: 2 }).read(),
      Float32Array.from([0, 1, 2, 3, 4, 5], (r) => [0, 1, 2, 3].reduce((s, c) => s + (r * 4 + c) ** 2, 0)),
      'fused square then sum',
    );
    // cube.T has shape [4, 3, 2]; its element (d, c, r) is cube[r][c][d] = r * 12 + c * 4 + d.
    equal(
      await cube.T.sum({ axis: 0 }).read(),
      Float32Array.from({ length: 6 }, (_, k) => 4 * ((k % 2) * 12 + Math.floor(k / 2) * 4) + 6),
      'reduce over a transposed view',
    );
  });

  await check(
    'statistics: mean, var and std (ddof), argmin/argmax (first on ties, flat and per axis), nan-aware reductions',
    async () => {
      const x = floats(100000, 7, 50),
        g = gpu.array(x);
      let mean = 0;
      for (const v of x) mean += v;
      mean /= x.length;
      let m2 = 0;
      for (const v of x) m2 += (v - mean) ** 2;
      near([await g.mean().item()], [mean], 1e-4, 'mean');
      near([await g.var().item()], [m2 / x.length], 1e-4, 'var');
      near([await g.std({ ddof: 1 }).item()], [Math.sqrt(m2 / (x.length - 1))], 1e-4, 'std ddof 1');
      let arg = 0;
      for (let k = 1; k < x.length; k++) if (x[k] > x[arg]) arg = k;
      assert((await g.argmax().item()) === arg, 'argmax');
      const ties = gpu.array([3, 1, 3, 1, 3], { shape: [5] });
      assert((await ties.argmax().item()) === 0 && (await ties.argmin().item()) === 1, 'first index on ties');
      const m = gpu.array([1, 9, 3, 7, 2, 8], { shape: [2, 3] });
      equal(await m.argmax({ axis: 1 }).read(), new Uint32Array([1, 2]), 'argmax per row');
      equal(await m.argmin({ axis: 0 }).read(), new Uint32Array([0, 1, 0]), 'argmin per column');
      const withNan = gpu.array([1, NaN, 3, NaN]);
      assert((await gpu.nansum(withNan).item()) === 4 && (await gpu.nanmean(withNan).item()) === 2, 'nansum, nanmean');
      assert((await gpu.nanmax(withNan).item()) === 3 && (await gpu.nanmin(withNan).item()) === 1, 'nanmax, nanmin');
      assert((await gpu.countNonzero(gpu.array([0, 2, 0, -1])).item()) === 2, 'countNonzero');
      assert((await gpu.all(gpu.array([1, 2])).item()) === 1 && (await gpu.any(gpu.zeros(3)).item()) === 0, 'all, any');
    },
  );

  await check('scan: inclusive and exclusive (exact on integers), float sums, custom max, along an axis', async () => {
    for (const n of SIZES) {
      const u = Uint32Array.from({ length: n }, (_, k) => (k * 7 + 3) % 11),
        g = gpu.array(u),
        inclusive = new Uint32Array(n),
        exclusive = new Uint32Array(n);
      let acc = 0;
      for (let k = 0; k < n; k++) {
        exclusive[k] = acc;
        acc = (acc + u[k]) >>> 0;
        inclusive[k] = acc;
      }
      equal(await gpu.cumsum(g).read(), inclusive, `inclusive scan of ${n}`);
      equal(await gpu.scan(g, { exclusive: true }).read(), exclusive, `exclusive scan of ${n}`);
    }
    const x = floats(70000, 9, 2);
    const scanned = await gpu.cumsum(gpu.array(x)).read();
    let acc = 0;
    for (let k = 0; k < x.length; k++) {
      acc += x[k];
      near([scanned[k]], [acc], 1e-3, `float scan element ${k}`);
    }
    const r = floats(5000, 4),
      running = await gpu.scan(gpu.array(r), { op: 'max' }).read();
    let m = -Infinity;
    for (let k = 0; k < r.length; k++) {
      m = Math.max(m, r[k]);
      assert(running[k] === m, `running max ${k}`);
    }
    for (const [rows, cols] of [
      [3, 4],
      [700, 1500],
      [2000, 3],
    ]) {
      const u = Uint32Array.from({ length: rows * cols }, (_, k) => k % 5),
        g = gpu.array(u, { shape: [rows, cols] }),
        alongRows = new Uint32Array(rows * cols),
        alongCols = new Uint32Array(rows * cols),
        exclusiveRows = new Uint32Array(rows * cols);
      for (let i = 0; i < rows; i++) {
        let s = 0;
        for (let j = 0; j < cols; j++) {
          exclusiveRows[i * cols + j] = s;
          s += u[i * cols + j];
          alongRows[i * cols + j] = s;
        }
      }
      for (let j = 0; j < cols; j++) {
        let s = 0;
        for (let i = 0; i < rows; i++) alongCols[i * cols + j] = s += u[i * cols + j];
      }
      equal(await gpu.cumsum(g, { axis: 1 }).read(), alongRows, `cumsum axis 1 of ${rows}x${cols}`);
      equal(await gpu.cumsum(g, { axis: 0 }).read(), alongCols, `cumsum axis 0 of ${rows}x${cols}`);
      equal(
        await gpu.scan(g, { axis: 1, exclusive: true }).read(),
        exclusiveRows,
        `exclusive along axis 1 of ${rows}x${cols}`,
      );
    }
  });

  await check('segmented scan and reduceByKey (group-by) across block boundaries', async () => {
    const n = 300001,
      values = Uint32Array.from({ length: n }, (_, k) => (k % 13) + 1),
      flags = Uint32Array.from({ length: n }, (_, k) => (k % 1777 === 0 || k % 3001 === 5 ? 1 : 0));
    const want = new Uint32Array(n),
      wantExclusive = new Uint32Array(n);
    let s = 0;
    for (let k = 0; k < n; k++) {
      if (flags[k]) s = 0;
      wantExclusive[k] = s;
      s += values[k];
      want[k] = s;
    }
    equal(await gpu.segmentedScan(gpu.array(values), gpu.array(flags)).read(), want, 'inclusive segmented');
    equal(
      await gpu.segmentedScan(gpu.array(values), gpu.array(flags), { exclusive: true }).read(),
      wantExclusive,
      'exclusive segmented',
    );
    const keys = Uint32Array.from({ length: n }, (_, k) => Math.floor(k / 37) * 3);
    const grouped = await gpu.reduceByKey(gpu.array(keys), gpu.array(values));
    const groupKeys = [],
      groupSums = [];
    for (let k = 0; k < n; k++) {
      if (k === 0 || keys[k] !== keys[k - 1]) {
        groupKeys.push(keys[k]);
        groupSums.push(0);
      }
      groupSums[groupSums.length - 1] += values[k];
    }
    equal(await grouped.keys.read(), Uint32Array.from(groupKeys), 'group keys');
    equal(await grouped.values.read(), Uint32Array.from(groupSums), 'group sums');
  });

  await check('sort: f32 with negatives, -0 and infinities; i32; u32 with 0xffffffff; descending; bits', async () => {
    for (const n of [0, 1, 2, 255, 256, 257, 1000, 65537, 1 << 20]) {
      const x = floats(n, n + 11, 1e6);
      if (n > 4) x.set([-0, 0, Infinity, -Infinity], 0);
      const want = Float32Array.from(x).sort();
      equal(await gpu.sort(gpu.array(x)).read(), want, `f32 sort of ${n}`);
      equal(
        await gpu.sort(gpu.array(x), { descending: true }).read(),
        want.slice().reverse(),
        `f32 descending of ${n}`,
      );
      const i = Int32Array.from(x, (v) => (Number.isFinite(v) ? Math.round(v) : 0));
      equal(await gpu.sort(gpu.array(i)).read(), Int32Array.from(i).sort(), `i32 sort of ${n}`);
      const u = Uint32Array.from(x, (v, k) => (k % 97 === 0 ? 0xffffffff : (v * 4096) >>> 0));
      equal(await gpu.sort(gpu.array(u)).read(), Uint32Array.from(u).sort(), `u32 sort of ${n}`);
    }
    const small = Uint32Array.from({ length: 100000 }, (_, k) => (k * 40503) & 0xffff);
    equal(await gpu.sort(gpu.array(small), { bits: 16 }).read(), Uint32Array.from(small).sort(), 'bits: 16');
    const m = gpu.array(Float32Array.from([5, 1, 4, 2, 3, 0]), { shape: [2, 3] });
    equal(await gpu.sort(m.T).read(), new Float32Array([0, 1, 2, 3, 4, 5]), 'sorts the flat elements of a view');
  });

  await check('argsort and sortByKey are stable; topk, quantile, median, unique with counts', async () => {
    const n = 200003,
      keys = Uint32Array.from({ length: n }, (_, k) => ((k * 2654435761) >>> 0) % 1000);
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => keys[a] - keys[b] || a - b);
    equal(await gpu.argsort(gpu.array(keys)).read(), Uint32Array.from(order), 'argsort');
    const values = Float32Array.from({ length: n }, (_, k) => k * 0.5);
    const sorted = gpu.sortByKey(gpu.array(keys), gpu.array(values));
    equal(
      await sorted.values.read(),
      Float32Array.from(order, (k) => values[k]),
      'sortByKey values',
    );
    equal(
      await sorted.keys.read(),
      Uint32Array.from(order, (k) => keys[k]),
      'sortByKey keys',
    );
    const desc = Array.from({ length: n }, (_, k) => k).sort((a, b) => keys[b] - keys[a] || a - b);
    equal(
      await gpu.argsort(gpu.array(keys), { descending: true }).read(),
      Uint32Array.from(desc),
      'descending argsort',
    );
    const x = floats(10001, 21);
    const top = gpu.topk(gpu.array(x), 5);
    const best = Array.from(x.keys())
      .sort((a, b) => x[b] - x[a] || a - b)
      .slice(0, 5);
    equal(await top.indices.read(), Uint32Array.from(best), 'topk indices');
    equal(
      await top.values.read(),
      Float32Array.from(best, (k) => x[k]),
      'topk values',
    );
    const s = Float64Array.from(x).sort();
    const q = (p) => {
      const pos = p * (s.length - 1),
        lo = Math.floor(pos);
      return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
    };
    near(
      await gpu.quantile(gpu.array(x), [0, 0.1, 0.5, 0.99, 1]).read(),
      [0, 0.1, 0.5, 0.99, 1].map(q),
      1e-5,
      'quantiles',
    );
    near([await gpu.median(gpu.array([5, 1, 3, 2])).item()], [2.5], 0, 'median of an even count');
    const u = await gpu.unique(gpu.array([3, 1, 3, 2, 1, 3], 'u32'), { counts: true });
    equal(await u.values.read(), new Uint32Array([1, 2, 3]), 'unique values');
    equal(await u.counts.read(), new Uint32Array([2, 1, 3]), 'unique counts');
  });

  await check('take along axes with clip and wrap; scatter set/add/min/max (atomic f32 add); bincount', async () => {
    const m = gpu.array(
      Float32Array.from({ length: 12 }, (_, k) => k),
      { shape: [3, 4] },
    );
    equal(
      await gpu.take(m, gpu.array([2, 0], 'i32'), { axis: 0 }).read(),
      new Float32Array([8, 9, 10, 11, 0, 1, 2, 3]),
      'rows 2 and 0',
    );
    equal(
      await gpu.take(m, gpu.array([-1, 1], 'i32'), { axis: 1 }).read(),
      new Float32Array([3, 1, 7, 5, 11, 9]),
      'columns -1 and 1',
    );
    equal(await gpu.take(m, gpu.array([0, 20, -20], 'i32')).read(), new Float32Array([0, 11, 0]), 'flat take clips');
    equal(
      await gpu.take(m, gpu.array([13, -13], 'i32'), { mode: 'wrap' }).read(),
      new Float32Array([1, 11]),
      'flat take wraps',
    );
    const n = 100000,
      idx = Int32Array.from({ length: n }, (_, k) => (k * 7919) % 97),
      w = floats(n, 5, 4);
    const sums = new Float64Array(97);
    for (let k = 0; k < n; k++) sums[idx[k]] += w[k];
    near(
      await gpu.scatter(gpu.zeros(97), gpu.array(idx), gpu.array(w), { op: 'add' }).read(),
      sums,
      1e-3,
      'atomic f32 add',
    );
    const counts = new Uint32Array(97);
    for (const k of idx) counts[k]++;
    equal(await gpu.bincount(gpu.array(idx), { length: 97 }).read(), counts, 'bincount');
    const maxes = new Float32Array(97).fill(-Infinity);
    for (let k = 0; k < n; k++) maxes[idx[k]] = Math.max(maxes[idx[k]], w[k]);
    equal(
      await gpu.scatter(gpu.full(97, -Infinity), gpu.array(idx), gpu.array(w), { op: 'max' }).read(),
      maxes,
      'atomic f32 max',
    );
    const self = gpu.array([1, 2, 3, 4]);
    equal(
      await gpu.scatter(self, gpu.array([0, 1, 2, 3], 'i32'), self.mul(10)).read(),
      new Float32Array([10, 20, 30, 40]),
      'values that read the target',
    );
    equal(
      await gpu.scatter(gpu.zeros(4, 'i32'), gpu.array([1, 3, 9], 'i32'), 5).read(),
      new Int32Array([0, 5, 0, 5]),
      'set skips out-of-range',
    );
  });

  await check('compaction: compact (count on the GPU), filter, nonzero', async () => {
    for (const n of [1, 1000, 300001]) {
      const x = floats(n, n);
      const keep = Array.from(x).filter((v) => v > 100);
      const g = gpu.array(x);
      const packed = gpu.compact(g, g.gt(100));
      const count = (await packed.count.read())[0];
      assert(count === keep.length, `count ${count} vs ${keep.length}`);
      equal((await packed.values.read()).subarray(0, count), Float32Array.from(keep), `compact ${n}`);
      equal(await (await gpu.filter(g, g.gt(100))).read(), Float32Array.from(keep), `filter ${n}`);
      const where = [];
      x.forEach((v, k) => v > 100 && where.push(k));
      equal(await (await gpu.nonzero(g.gt(100))).read(), Uint32Array.from(where), `nonzero ${n}`);
    }
  });

  await check(
    'histogram: NumPy bins (last bin closed), given and GPU-found ranges, NaN and outliers skipped, >4096 bins',
    async () => {
      const reference = (data, bins, lo, hi) => {
        const counts = new Uint32Array(bins);
        for (const v of data)
          if (v >= lo && v <= hi) counts[Math.min(Math.floor(((v - lo) * bins) / (hi - lo)), bins - 1)]++;
        return counts;
      };
      const r = rng(5),
        data = Float32Array.from({ length: 300001 }, () => Math.floor(r() * 640) / 64);
      data[0] = NaN;
      data[1] = -1;
      data[2] = 11;
      const g = gpu.array(data);
      const h = gpu.histogram(g, { bins: 20, range: [0, 10] });
      equal(await h.counts.read(), reference(data, 20, 0, 10), '20 bins over [0, 10]');
      equal(
        await h.edges.read(),
        Float32Array.from({ length: 21 }, (_, k) => k / 2),
        'edges',
      );
      const clean = data.subarray(3);
      const auto = gpu.histogram(gpu.array(clean), { bins: 640 });
      const edges = await auto.edges.read();
      equal(await auto.counts.read(), reference(clean, 640, edges[0], edges[640]), 'range found on the GPU');
      equal(
        await gpu.histogram(g, { bins: 5000, range: [0, 10] }).counts.read(),
        reference(data, 5000, 0, 10),
        '5000 bins',
      );
      const same = await gpu.histogram(gpu.array([3, 3, 3]), { bins: 2 }).edges.read();
      assert(same[0] === 2.5 && same[2] === 3.5, 'constant data widens the range by 0.5 each side');
    },
  );

  await check(
    'kernel: bindings by name, a uniform struct from a plain object, entry points, chained runs',
    async () => {
      const code = /* wgsl */ `
      struct Params { scale: f32, offset: vec2f, count: u32 }
      @group(0) @binding(0) var<storage, read> src: array<f32>;
      @group(0) @binding(1) var<storage, read_write> dst: array<f32>;
      @group(0) @binding(2) var<uniform> params: Params;
      @compute @workgroup_size(64) fn scale(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < params.count) { dst[id.x] = src[id.x] * params.scale + params.offset.y; }
      }
      @compute @workgroup_size(64) fn twice(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < params.count) { dst[id.x] = dst[id.x] * 2.0; }
      }`;
      const input = floats(1000, 6),
        src = gpu.array(input),
        dst = gpu.zeros(1000);
      const scale = gpu.kernel(code, { entryPoint: 'scale' });
      assert(scale.workgroupSize[0] === 64 && scale.bindings.length === 3, 'reflected');
      const params = { scale: 3, offset: [0, 0.5], count: 1000 };
      scale.run({ src, dst, params }, { count: 1000 });
      gpu
        .kernel(code, { entryPoint: 'twice' })
        .run({ src, dst, params }, { count: 1000 })
        .run({ src, dst, params }, { count: 1000 });
      equal(
        await dst.read(),
        Float32Array.from(input, (v) => f(f(f(v * 3) + 0.5) * 4)),
        'scale then twice twice',
      );
      const fail = (run, pattern, label) => {
        let error;
        try {
          run();
        } catch (e) {
          error = e;
        }
        assert(error instanceof TypeError && pattern.test(error.message), label);
      };
      fail(() => gpu.kernel(code), /scale, twice/, 'two entry points need entryPoint');
      fail(() => scale.run({ src, dst }, { count: 10 }), /params is missing/, 'missing binding');
      fail(
        () => scale.run({ src, dst, params, extra: src }, { count: 10 }),
        /no binding named extra/,
        'unknown binding',
      );
    },
  );

  await check(
    'bound kernels: set() rewrites a uniform in place; indirect dispatch sized by a GPU compaction',
    async () => {
      const code = /* wgsl */ `
      struct P { add: f32 }
      @group(0) @binding(0) var<storage, read_write> data: array<f32>;
      @group(0) @binding(1) var<uniform> p: P;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < arrayLength(&data)) { data[id.x] += p.add; }
      }`;
      const data = gpu.zeros(256);
      const bound = gpu.kernel(code).bind({ data, p: { add: 1 } });
      bound.run({ count: 256 });
      bound.set('p', { add: 10 }).run({ count: 256 });
      equal(await data.read(), new Float32Array(256).fill(11), 'two runs with a changed uniform');
      // Count survivors on the GPU, turn the count into workgroups on the GPU, dispatch exactly that many.
      const x = floats(10000, 8),
        g = gpu.array(x),
        packed = gpu.compact(g, g.gt(0));
      const args = gpu.indirectArgs();
      gpu
        .kernel(/* wgsl */ `
      @group(0) @binding(0) var<storage, read> count: array<u32>;
      @group(0) @binding(1) var<storage, read_write> args: array<u32>;
      @compute @workgroup_size(1) fn main() { args[0] = (count[0] + 63u) / 64u; args[1] = 1u; args[2] = 1u; }`)
        .run({ count: packed.count, args }, { workgroups: 1 });
      const marks = gpu.zeros(10000, 'u32');
      gpu
        .kernel(/* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> marks: array<u32>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { marks[id.x] = 1u; }`)
        .run({ marks }, { indirect: args });
      const ran = (await marks.read()).reduce((s, v) => s + v, 0);
      const survivors = Array.from(x).filter((v) => v > 0).length;
      assert(ran === Math.ceil(survivors / 64) * 64, `indirect dispatch ran ${ran} threads for ${survivors} survivors`);
    },
  );

  await check('a WGSL error in a kernel or expression rejects the next wait with a coded failed error', async () => {
    gpu
      .kernel(
        '@group(0) @binding(0) var<storage, read_write> d: array<f32>; @compute @workgroup_size(1) fn main() { d[0] = undefined_name; }',
        { label: 'expect-error:bad kernel' },
      )
      .run({ d: gpu.zeros(1) }, { count: 1 });
    let error;
    try {
      await gpu.done();
    } catch (e) {
      error = e;
    }
    assert(error?.name === 'MargoError' && error.code === 'failed', `expected failed, got ${error}`);
    gpu.map(gpu.zeros(4), 'x + nope', { label: 'expect-error:bad map' });
    error = undefined;
    try {
      await gpu.zeros(1).read();
    } catch (e) {
      error = e;
    }
    assert(error?.code === 'failed' && /errors#compute/.test(error.message), 'map error');
    equal(
      await gpu.map(gpu.array([1, 2]), 'x + 1.0').read(),
      new Float32Array([2, 3]),
      'the context works after an error',
    );
  });

  await check(
    'AbortSignal rejects reads and waits with the reason; disposal rejects pending reads as disposed',
    async () => {
      const big = gpu.array(floats(1 << 20, 12));
      const controller = new AbortController(),
        reason = new Error('user cancelled');
      const pending = big.read({ signal: controller.signal });
      controller.abort(reason);
      let error;
      try {
        await pending;
      } catch (e) {
        error = e;
      }
      assert(error === reason, `abort reason, got ${error}`);
      error = undefined;
      try {
        await gpu.done({ signal: AbortSignal.abort(reason) });
      } catch (e) {
        error = e;
      }
      assert(error === reason, 'done() abort');
      const other = await createCompute();
      const read = other.array(floats(1 << 20, 13)).read();
      other.dispose();
      error = undefined;
      try {
        await read;
      } catch (e) {
        error = e;
      }
      assert(error?.code === 'disposed', `pending read after dispose: ${error}`);
      assert((await other.lost).reason === 'destroyed', 'an owned device is destroyed on dispose');
    },
  );

  await check('a 2D grid covers arrays past 65,535 workgroups (16,777,472 elements)', async () => {
    const n = 65536 * 256 + 256;
    const idx = gpu.arange(n);
    equal(await idx.read({ offset: n - 3 }), new Uint32Array([n - 3, n - 2, n - 1]), 'last elements');
    equal(
      await idx.read({ offset: 65535 * 256 - 1, length: 3 }),
      new Uint32Array([65535 * 256 - 1, 65535 * 256, 65535 * 256 + 1]),
      'across the fold',
    );
    assert((await idx.max().item()) === n - 1, 'reduce over the grid');
    idx.dispose();
  });

  if (gpu.f16)
    await check('f16 arrays (shader-f16): write, fused math, sum, sort', async () => {
      const h = gpu.array([1, 2.5, -3, 0.5], 'f16');
      equal(await h.mul(2).astype('f32').read(), new Float32Array([2, 5, -6, 1]), 'f16 math');
      assert((await h.sum().astype('f32').item()) === 1, 'f16 sum');
      equal(await gpu.sort(h).astype('f32').read(), new Float32Array([-3, 0.5, 1, 2.5]), 'f16 sort');
    });

  await check('profile() reports GPU time per pass', async () => {
    const x = gpu.array(floats(1 << 18, 3));
    const timings = await gpu.profile(() => gpu.sort(x));
    if (gpu.device.features.has('timestamp-query')) {
      assert(timings.length > 10 && timings.every((t) => t.ms >= 0), `timings ${JSON.stringify(timings.slice(0, 3))}`);
      assert(
        timings.some((t) => t.label === 'sort.local'),
        'labelled passes',
      );
    } else assert(timings.length === 0, 'no timestamps without the feature');
  });

  await check("createCompute({ engine }) shares the engine's device and leaves it alive on dispose", async () => {
    const canvas = document.querySelector('canvas');
    const engine = await Engine.create(canvas, { backend: 'webgpu' });
    {
      using shared = await createCompute({ engine });
      assert(shared.device === engine.gpu && !shared.ownsDevice, 'same device');
      assert((await shared.array([1, 2, 3]).sum().item()) === 6, 'computes on the engine device');
    }
    engine.render();
    let lost = false;
    engine.gpu.lost.then(() => (lost = true));
    await new Promise((r) => setTimeout(r, 50));
    assert(!lost, 'engine device survives');
    engine.dispose();
  });

  if (speedEnabled()) {
    // Timings at one million elements, after a warm-up; GPU pass times when timestamps are available.
    const million = gpu.array(floats(1 << 20, 99, 1e6));
    const time = async (label, run) => {
      await run();
      await gpu.done();
      const t0 = performance.now();
      for (let k = 0; k < 5; k++) {
        await run();
        await gpu.done();
      }
      timings[label] = +((performance.now() - t0) / 5).toFixed(2);
    };
    await time('sum 1M f32, ms incl. readback', () => million.sum().item());
    await time('fused (x-1)^2 mean 1M f32, ms incl. readback', () => million.sub(1).square().mean().item());
    await time('cumsum 1M f32, ms', () => gpu.cumsum(million).dispose());
    await time('sort 1M f32, ms', () => gpu.sort(million).dispose());
    await time('argsort 1M f32, ms', () => gpu.argsort(million).dispose());
    await time('histogram 1M f32 256 bins, ms', () => {
      const h = gpu.histogram(million, { bins: 256 });
      h.counts.dispose();
      h.edges.dispose();
    });
  }
  const info = gpu.device.adapterInfo ?? {};
  gpu.dispose();
  return { checks, timings, adapter: { vendor: info.vendor, architecture: info.architecture } };
};
