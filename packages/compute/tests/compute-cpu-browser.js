import { speedEnabled } from './speed-phase.mjs';
// The CPU backend against the WebGPU backend on a real GPU: the same operations on the same inputs in both contexts,
// compared element by element. Integer results, orders, counts and the Philox streams must match exactly; float
// results to f32 rounding (WGSL lets GPU division and transcendental functions be off by a few ULP, and the GPU may
// fuse a multiply and an add; reduction order differs too).
import { createCompute } from '@margoengine/compute';
import { matmul } from '@margoengine/compute/linalg';
import { fft } from '@margoengine/compute/fft';
import { convolve, convolve2d } from '@margoengine/compute/signal';
import { Random } from '@margoengine/compute/random';
import { bicgstab, cg, coo, diags } from '@margoengine/compute/sparse';
import { grad } from '@margoengine/compute/autodiff';

const checks = [];
const timings = {};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const floats = (n, seed) => {
  let s = seed >>> 0 || 1;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = s / 2 ** 32 - 0.5;
  }
  return a;
};
// |cpu - gpu| <= tolerance * max(1, |gpu|), elementwise; exact when tolerance is 0 (NaN equals NaN).
const same = (cpu, gpu, tolerance, label) => {
  assert(cpu.length === gpu.length, `${label}: length ${cpu.length} != ${gpu.length}`);
  for (let i = 0; i < gpu.length; i++) {
    const a = cpu[i],
      b = gpu[i];
    if (Number.isNaN(b) && Number.isNaN(a)) continue;
    const ok = tolerance === 0 ? Object.is(a, b) || a === b : Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
    assert(ok, `${label}[${i}]: cpu ${a}, gpu ${b}`);
  }
};

window.runCpuParityTests = async () => {
  const gpu = await createCompute({ backend: 'webgpu' }),
    cpu = await createCompute({ backend: 'cpu' });
  assert(gpu.backend === 'webgpu' && cpu.backend === 'cpu', 'backends');
  const n = 100_003,
    raw = floats(n, 11),
    rawB = floats(n, 12),
    both = (make) => [make(cpu), make(gpu)];
  // Runs `op` in both contexts on the same inputs and compares what `pick` reads.
  const parity = async (label, op, tolerance, pick = (r) => r.read()) => {
    const [a, b] = both((ctx) => op(ctx, ctx.array(raw), ctx.array(rawB)));
    same(Array.from(await pick(a)), Array.from(await pick(b)), tolerance, label);
    checks.push(`cpu = gpu: ${label}`);
  };
  await parity(
    'fused arithmetic (x - mean) / std * 3 + y',
    (c, x, y) => x.sub(x.mean()).div(x.std()).mul(3).add(y),
    1e-5,
  );
  await parity('integer wrap and floor division', (c, x) => x.mul(1e9).astype('i32').mul(3).floorDiv(7), 0);
  await parity('comparisons and where', (c, x, y) => c.where(x.gt(y), x, y.neg()), 0);
  await parity('exp, log1p, sqrt of |x|', (c, x) => x.exp().add(x.abs().log1p()).add(x.abs().sqrt()), 2e-6);
  // The precise functions are within 2 ulp of the exact value on every GPU, the CPU within half an ulp: 1e-6 is
  // about 8 ulp of the sum's scale. (The builtins failed this on an Intel Arc 140V: sin and cos 1.1e-5 off.)
  await parity('sin, cos, atan2', (c, x, y) => x.mul(3).sin().add(y.mul(3).cos()).add(x.atan2(y)), 1e-6);
  // Each precise function alone, in ulp of the CPU's value: its bound (packages/shared/precise-math.js) plus the
  // CPU's half ulp and the input's f32 rounding of x * k.
  const sameUlp = (cpuValues, gpuValues, ulps, label) => {
    assert(cpuValues.length === gpuValues.length, `${label}: length`);
    for (let i = 0; i < gpuValues.length; i++) {
      const a = cpuValues[i],
        b = gpuValues[i];
      if (Number.isNaN(a) && Number.isNaN(b)) continue;
      if (Object.is(a, b) || a === b) continue;
      const scale = Math.max(Math.abs(a), 2 ** -126),
        ulp = 2 ** (Math.floor(Math.log2(scale)) - 23);
      assert(Math.abs(a - b) <= ulps * ulp, `${label}[${i}]: cpu ${a}, gpu ${b} (${Math.abs(a - b) / ulp} ulp)`);
    }
  };
  for (const [label, op, ulps] of [
    ['sin(100 x)', (c, x) => x.mul(100).sin(), 1.5],
    ['cos(100 x)', (c, x) => x.mul(100).cos(), 1.5],
    ['tan(3 x)', (c, x) => x.mul(3).tan(), 3],
    ['asin(1.99 x)', (c, x) => x.mul(1.99).asin(), 2],
    ['acos(1.99 x)', (c, x) => x.mul(1.99).acos(), 1.5],
    ['atan(20 x)', (c, x) => x.mul(20).atan(), 2.5],
    ['atan2(x, y)', (c, x, y) => x.atan2(y), 2.5],
    ['exp(100 x)', (c, x) => x.mul(100).exp(), 1.5],
    ['exp2(100 x)', (c, x) => x.mul(100).exp2(), 1.5],
    ['expm1(10 x)', (c, x) => x.mul(10).expm1(), 2],
    ['log(|x|)', (c, x) => x.abs().log(), 1.5],
    ['log2(|x|)', (c, x) => x.abs().log2(), 2],
    ['log1p(1.99 x)', (c, x) => x.mul(1.99).log1p(), 2],
    ['sinh(20 x)', (c, x) => x.mul(20).sinh(), 2.5],
    ['cosh(20 x)', (c, x) => x.mul(20).cosh(), 2.5],
    ['tanh(20 x)', (c, x) => x.mul(20).tanh(), 2.5],
    ['pow(10 |x|, 10 y)', (c, x, y) => x.abs().mul(10).pow(y.mul(10)), 2.5],
    ['pow(-4 x, round(6 y))', (c, x, y) => x.mul(-4).pow(y.mul(6).round()), 2.5],
    ['sqrt(|x|)', (c, x) => x.abs().sqrt(), 1],
  ]) {
    const [a, b] = both((ctx) => op(ctx, ctx.array(raw), ctx.array(rawB)));
    sameUlp(await a.read(), await b.read(), ulps, label);
    checks.push(`cpu = gpu within ${ulps} ulp: ${label}`);
  }
  // fastMath: the WGSL builtins, which only promise WGSL's bounds. For |3x|, |3y| <= 1.5 < pi: sin and cos 2^-11
  // absolute each, atan2 4096 ulp of at most pi (2^-10); with the sum's own rounding, 2e-3.
  {
    const fast = await createCompute({ backend: 'webgpu', device: gpu.device, fastMath: true });
    assert(fast.fastMath === true && gpu.fastMath === false, 'fastMath flag');
    const op = (c) =>
      c
        .array(raw)
        .mul(3)
        .sin()
        .add(c.array(rawB).mul(3).cos())
        .add(c.array(raw).atan2(c.array(rawB)));
    const want = Array.from(await op(cpu).read()),
      got = Array.from(await op(fast).read());
    same(want, got, 2e-3, 'fastMath sin, cos, atan2');
    checks.push('cpu = gpu with fastMath: sin, cos, atan2 within the WGSL bounds');
    // Under the spec-math stand-in (every builtin as far off as WGSL allows) the builtins miss the strict tolerance
    // the precise functions passed above, as they did on an Intel Arc 140V: the stand-in is live and the check would
    // have caught it.
    if (globalThis.__margoSpecMathError >= 1) {
      const off = Math.max(...want.map((v, i) => Math.abs(v - got[i]) / Math.max(1, Math.abs(got[i]))));
      assert(off > 1e-5, `spec-math stand-in: the builtins are only ${off} off`);
      checks.push(
        `spec-math stand-in: the builtins are ${off.toExponential(2)} off, past the 1e-6 the precise path keeps`,
      );
    }
  }
  await parity('sum along an axis', (c, x) => x.slice([0, 100_000]).reshape(400, 250).sum({ axis: 0 }), 1e-4);
  for (const [name, reduce] of [
    ['mean', (x) => x.mean()],
    ['var', (x) => x.var()],
    ['std ddof 1', (x) => x.std({ ddof: 1 })],
    ['min', (x) => x.min()],
    ['max', (x) => x.max()],
  ])
    await parity(`full reduction: ${name}`, (c, x) => reduce(x), 1e-5);
  await parity('argmax along an axis', (c, x) => x.slice([0, 100_000]).reshape(1000, 100).argmax({ axis: 1 }), 0);
  await parity('cumsum', (c, x) => c.cumsum(x), 1e-4);
  await parity(
    'exclusive max scan along an axis',
    (c, x) => c.scan(x.slice([0, 100_000]).reshape(100, 1000), { op: 'max', exclusive: true, axis: 1 }),
    0,
  );
  await parity('sort', (c, x) => c.sort(x), 0);
  await parity('argsort descending (stable)', (c, x) => c.argsort(x.mul(16).floor(), { descending: true }), 0);
  await parity('sort u32 on 16 bits', (c, x) => c.sort(x.add(0.5).mul(1e6).astype('u32'), { bits: 16 }), 0);
  await parity('quantiles', (c, x) => c.quantile(x, [0, 0.1, 0.5, 0.99, 1]), 1e-6);
  await parity('topk', (c, x) => c.topk(x, 50).indices, 0);
  await parity(
    'unique with counts',
    async (c, x) => (await c.unique(x.mul(100).round().astype('i32'), { counts: true })).counts,
    0,
    async (r) => (await r).read(),
  );
  await parity(
    'take (wrap) along an axis',
    (c, x) =>
      c.take(x.slice([0, 100_000]).reshape(100, 1000), c.array([-1, 5, 2001], 'i32'), { axis: 1, mode: 'wrap' }),
    0,
  );
  await parity('bincount', (c, x) => c.bincount(x.add(0.5).mul(64).astype('u32'), { length: 64 }), 0);
  await parity('compact', (c, x) => c.compact(x, x.gt(0.25)).values, 0);
  await parity('histogram over the data range', (c, x) => c.histogram(x, { bins: 100 }).counts, 0);
  await parity('histogram edges', (c, x) => c.histogram(x, { bins: 7, range: [-0.3, 0.4] }).edges, 1e-6);
  await parity(
    'matmul 97 x 131 by 131 x 61',
    (c, x, y) => matmul(x.slice([0, 97 * 131]).reshape(97, 131), y.slice([0, 131 * 61]).reshape(131, 61)),
    1e-5,
  );
  await parity('fft 4096 (Stockham) re', (c, x) => fft(x.slice([0, 4096])).re, 1e-4);
  await parity('fft 1000 (Bluestein) im', (c, x) => fft(x.slice([0, 1000])).im, 1e-4);
  await parity(
    'convolve 1-D (direct)',
    (c, x, y) => convolve(x.slice([0, 5000]), y.slice([0, 31]), { mode: 'same' }),
    1e-5,
  );
  await parity(
    'convolve 2-D (direct)',
    (c, x, y) => convolve2d(x.slice([0, 10_000]).reshape(100, 100), y.slice([0, 25]).reshape(5, 5)),
    1e-5,
  );
  await parity('random bits', (c) => new Random(c, { seed: 77 }).bits(10_001), 0);
  await parity('random uniform', (c) => new Random(c, { seed: 78 }).uniform(10_001, { low: -2, high: 3 }), 0);
  await parity('random integers', (c) => new Random(c, { seed: 79 }).integers(-50, 1000, 10_001), 0);
  await parity('random normal', (c) => new Random(c, { seed: 80 }).normal(10_001), 1e-5);

  // Gradients: the same fused gradient kernels on both backends.
  await parity(
    'grad of a smooth expression with broadcasting',
    (c, x, y) => {
      const w = c.array([0.5, -1.5, 2], { shape: [3, 1] }),
        xs = x.slice([0, 3000]).reshape(3, 1000);
      return grad(xs.mul(w).sin().add(xs.square().mul(w).exp().log1p()), [w])[0];
    },
    1e-4,
  );
  await parity(
    'grad through a transpose and a where',
    (c, x) => {
      const m = x.slice([0, 600]).reshape(20, 30).ascontiguous();
      return grad(c.where(m.T.gt(0), m.T.tanh(), m.T.mul(0.1)), [m])[0];
    },
    1e-5,
  );

  // Sparse: the 2-D Laplacian of an m x m grid (5-point stencil), symmetric positive definite.
  const laplacian = (ctx, m) => {
    const rows = [],
      cols = [],
      values = [];
    for (let i = 0; i < m; i++)
      for (let j = 0; j < m; j++) {
        const at = i * m + j;
        rows.push(at);
        cols.push(at);
        values.push(4);
        if (i > 0) rows.push(at), cols.push(at - m), values.push(-1);
        if (i < m - 1) rows.push(at), cols.push(at + m), values.push(-1);
        if (j > 0) rows.push(at), cols.push(at - 1), values.push(-1);
        if (j < m - 1) rows.push(at), cols.push(at + 1), values.push(-1);
      }
    return coo(ctx, { rows, cols, values, shape: [m * m, m * m] });
  };
  const sparseWant = floats(64 * 64, 21);
  await parity(
    'sparse spmv, transpose and diagonal',
    (c) => {
      const A = laplacian(c, 64),
        T = A.transpose(),
        x = c.array(sparseWant);
      return A.matvec(x).add(T.matvec(x)).add(A.diagonal());
    },
    1e-6,
  );
  for (const [name, solve, A] of [
    ['cg', cg, (c) => laplacian(c, 64)],
    ['bicgstab', bicgstab, (c) => diags(c, [-1.3, 2.5, -0.7], [-1, 0, 1], [4096, 4096])],
  ]) {
    const results = await Promise.all(
      both((c) => {
        const M = A(c);
        return solve(M, M.matvec(c.array(sparseWant)), { tol: 1e-6 });
      }),
    );
    assert(
      results.every((r) => r.converged),
      `${name}: both backends converge (${results.map((r) => r.residual)})`,
    );
    const [xc, xg] = await Promise.all(results.map((r) => r.x.read()));
    same(Array.from(xg), Array.from(sparseWant), 2e-3, `${name} solution (gpu)`);
    same(Array.from(xc), Array.from(sparseWant), 2e-3, `${name} solution (cpu)`);
    checks.push(
      `sparse ${name} converges on both backends: ${results.map((r) => r.iterations).join(' and ')} iterations`,
    );
  }
  if (speedEnabled()) {
    {
      const A = laplacian(gpu, 256),
        b = gpu.ones(256 * 256);
      await cg(A, b, { maxIterations: 32 });
      const t0 = performance.now(),
        r = await cg(A, b, { tol: 1e-5 });
      timings['cg 256^2 Poisson on webgpu, ms'] = +(performance.now() - t0).toFixed(1);
      timings['cg 256^2 Poisson on webgpu, iterations'] = r.iterations;
    }

    // The same jobs timed on both backends (wall clock, inputs already in place, GPU results waited for).
    const time = async (label, ctx, run) => {
      await run();
      await ctx.done();
      const t0 = performance.now();
      for (let k = 0; k < 3; k++) {
        await run();
        await ctx.done();
      }
      timings[label] = +((performance.now() - t0) / 3).toFixed(2);
    };
    for (const ctx of [gpu, cpu]) {
      const x = ctx.array(floats(1 << 20, 3));
      await time(`sort 1M f32 on ${ctx.backend}, ms`, ctx, () => ctx.sort(x).dispose());
      await time(`sum 1M f32 on ${ctx.backend}, ms`, ctx, () => x.sum().dispose());
      const a = ctx.array(floats(256 * 256, 4), { shape: [256, 256] });
      await time(`matmul 256^3 on ${ctx.backend}, ms`, ctx, () => matmul(a, a).dispose());
    }
  }
  gpu.dispose();
  cpu.dispose();
  return { checks, timings };
};
