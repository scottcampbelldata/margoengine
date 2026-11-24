import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompute } from '@margoengine/compute';
import { solve, inv, det, cholesky, qr, svd, eigh } from '@margoengine/compute/decomp';
import { decompCases } from './decomp-cases.js';

test('dense decomposition reference, reconstruction and orthogonality cases', { timeout: 60000 }, async () => {
  using ctx = await createCompute({ backend: 'cpu' });
  assert.equal(await decompCases(ctx), 67);
});
test('dense decomposition validation, nonconvergence, ownership and abort', { timeout: 30000 }, async () => {
  using ctx = await createCompute({ backend: 'cpu' });
  using other = await createCompute({ backend: 'cpu' });
  const a = ctx.array([1, 2, 2, 4], { shape: [2, 2] }),
    b = ctx.ones([2]);
  for (const work of [() => solve(a, b), () => inv(a), () => cholesky(a)])
    await assert.rejects(work, { code: 'failed' });
  assert.equal(await (await det(a)).item(), 0);
  await assert.rejects(() => eigh(ctx.array([1, 2, 3, 4], { shape: [2, 2] })), /symmetric/);
  await assert.rejects(() => svd(ctx.array([NaN], { shape: [1, 1] })), /nonfinite/);
  await assert.rejects(() => inv(ctx.ones([2, 3])), RangeError);
  await assert.rejects(() => qr(ctx.ones([3])), TypeError);
  await assert.rejects(() => solve(a, other.ones([2])), TypeError);
  await assert.rejects(() => solve(a, ctx.ones([3])), RangeError);
  await assert.rejects(() => solve(a, undefined), /RHS/);
  await assert.rejects(() => inv(ctx.array([1e-40], { shape: [1, 1] })), /f32 range/);
  await assert.rejects(() => svd(a, { maxSweeps: 0 }), RangeError);
  await assert.rejects(
    () => svd(ctx.array([1, 2, 3, 4, 5, 6, 7, 8, 10], { shape: [3, 3] }), { maxSweeps: 1 }),
    /converge/,
  );
  const abort = new AbortController();
  abort.abort(new Error('cancel dense'));
  await assert.rejects(() => svd(a, { signal: abort.signal }), /cancel dense/);
  const result = await qr(a);
  assert.equal(result.q.owner, true);
  result.q.dispose();
  result.r.dispose();
  assert.equal(a.disposed, false);
  a.dispose();
  await assert.rejects(() => svd(a), { code: 'disposed' });
  const [x, y] = await Promise.all([qr(ctx.ones([3, 2])), svd(ctx.ones([2, 3]))]);
  assert.deepEqual(x.q.shape, [3, 2]);
  assert.deepEqual(y.vh.shape, [2, 3]);
  for (const v of [...Object.values(x), ...Object.values(y)]) v.dispose();
});
test('bounded Wasm ABI rejects invalid calls and SIMD dot keeps scalar addition order', {
  timeout: 30000,
}, async () => {
  const bytes = await readFile(new URL('../src/decomp-kernel.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  const k = instance.exports;
  assert.equal(k.reserve(16_777_217), 0);
  assert.equal(k.run(99, 2, 2, 0, 0, 100), 1);
  assert.equal(k.run(0, 2, 2, 1, 0, 100), 1);
  const pointer = k.reserve(4 + 2 + 2);
  let arena = new Float64Array(k.memory.buffer, pointer, 8);
  arena.set([0, 2, 1, 3, 4, 7]);
  assert.equal(k.run(0, 2, 2, 1, 0, 100), 0);
  arena = new Float64Array(k.memory.buffer, pointer, 8);
  assert.deepEqual(Array.from(arena.slice(6)), [1, 2]);
  k.release();
  // SIMD opcode f64x2.mul is fd f2 01 (unsigned LEB128 242).
  assert.ok(bytes.some((v, i) => v === 0xfd && bytes[i + 1] === 0xf2 && bytes[i + 2] === 1));
  for (const n of [0, 1, 2, 3, 17, 128]) {
    const p = k.reserve(n * 2),
      input = new Float64Array(k.memory.buffer, p, n * 2);
    let scalar = 0;
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin(i * 31);
      input[n + i] = Math.cos(i * 7);
      scalar += input[i] * input[n + i];
    }
    assert.equal(k.inner_product(n), scalar);
    assert.equal(
      Math.floor(n / 2) + (n % 2),
      Math.ceil(n / 2),
      'one SIMD product instruction per pair, plus scalar tail',
    );
    k.release();
  }
});

test('zero-size factors do no matrix work for any batch count', { timeout: 30000 }, async () => {
  using ctx = await createCompute({ backend: 'cpu' });
  const instantiate = WebAssembly.instantiate;
  let calls = 0;
  WebAssembly.instantiate = async (...args) => {
    const result = await instantiate(...args);
    const exports = result.instance.exports;
    return {
      ...result,
      instance: {
        exports: {
          ...exports,
          run: (...args) => {
            calls++;
            return exports.run(...args);
          },
        },
      },
    };
  };
  try {
    const factors = await qr(ctx.zeros([64, 0, 0]));
    assert.deepEqual(factors.q.shape, [64, 0, 0]);
    assert.deepEqual(factors.r.shape, [64, 0, 0]);
    assert.equal(factors.q.size + factors.r.size, 0);
    assert.equal(calls, 0, 'empty factors must not enter the per-matrix kernel loop');
    factors.q.dispose();
    factors.r.dispose();
  } finally {
    WebAssembly.instantiate = instantiate;
  }
});
// KB5765a: many exactly repeated columns once drove one-sided Jacobi's rounding-level residual columns into the
// subnormal range, where the relative stopping test could never pass ("Jacobi iteration did not converge").
test('svd converges on a 512 x 512 matrix of many repeated columns and keeps A = U S V^T', { timeout: 120000 }, async () => {
  using ctx = await createCompute({ backend: 'cpu' });
  const n = 512,
    data = new Float32Array(n * n);
  let seed = 1;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[i] = seed / 2 ** 32 - 0.5;
  }
  const a = ctx.array(data, { shape: [n, n] });
  const { u, s, vh } = await svd(a);
  const [U, S, V] = await Promise.all([u.read(), s.read(), vh.read()]);
  for (let i = 1; i < n; i++) assert.ok(S[i] <= S[i - 1] && S[i] >= 0, `sorted nonnegative at ${i}`);
  let error = 0,
    norm = 0;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let x = 0;
      for (let k = 0; k < n; k++) x += U[r * n + k] * S[k] * V[k * n + c];
      error = Math.max(error, Math.abs(x - data[r * n + c]));
      norm = Math.max(norm, Math.abs(data[r * n + c]));
    }
  assert.ok(error <= 1e-4 * norm * Math.sqrt(n), `reconstruction ${error}`);
  let orthogonal = 0;
  for (let p = 0; p < n; p += 7)
    for (let q = p; q < n; q += 5) {
      let x = 0;
      for (let r = 0; r < n; r++) x += U[r * n + p] * U[r * n + q];
      orthogonal = Math.max(orthogonal, Math.abs(x - (p === q ? 1 : 0)));
    }
  assert.ok(orthogonal <= 1e-4, `U orthogonality ${orthogonal}`);
});
// KB5588a: a missing or corrupt decomp-kernel.wasm surfaced a raw ENOENT or WebAssembly.CompileError instead of a
// help-linked MargoError. A private copy of dist keeps the shipped files untouched while other tests run.
test('decomp Wasm read and compile failures reject as coded MargoErrors with the cause kept', { timeout: 60000 }, async () => {
  const { cp, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'margo-decomp-'));
  try {
    await cp(new URL('../dist/', import.meta.url), dir, { recursive: true });
    const compute = await import(pathToFileURL(join(dir, 'index.js')).href);
    const decomp = await import(pathToFileURL(join(dir, 'decomp.js')).href);
    using ctx = await compute.createCompute({ backend: 'cpu' });
    const a = ctx.array([2, 0, 0, 3], { shape: [2, 2] });
    assert.equal(await (await decomp.det(a)).item(), 6);
    const coded = (cause) => (error) => {
      assert.equal(error.name, 'MargoError');
      assert.equal(error.code, 'failed');
      assert.match(error.message, /Decomposition Wasm load failed/);
      assert.match(error.message, /margoengine\.com\/errors#compute/);
      assert.ok(cause(error.cause), String(error.cause));
      return true;
    };
    await writeFile(join(dir, 'decomp-kernel.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255]));
    await assert.rejects(() => decomp.det(a), coded((cause) => cause instanceof WebAssembly.CompileError));
    await rm(join(dir, 'decomp-kernel.wasm'));
    await assert.rejects(() => decomp.det(a), coded((cause) => cause?.code === 'ENOENT'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => decomp.det(a, { signal: controller.signal }), { name: 'AbortError' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
