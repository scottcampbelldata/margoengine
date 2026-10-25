import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { CsrMatrix, bicgstab, cg, coo, csr, diags, spmv } from '@margoengine/compute/sparse';

// Sparse matrices and solvers on the CPU backend (Node); tests/compute-browser.mjs runs them on the GPU too.

const read = async (x) => Array.from(await x.read());
const close = (a, b, tolerance, what) => {
  assert.equal(a.length, b.length, what);
  a.forEach((v, i) =>
    assert.ok(Math.abs(v - b[i]) <= tolerance * Math.max(1, Math.abs(b[i])), `${what}[${i}] ${v} vs ${b[i]}`),
  );
};

/** The 2-D Laplacian of an n x n grid (5-point stencil, Dirichlet boundary): symmetric positive definite. */
function laplacian(gpu, n) {
  const rows = [],
    cols = [],
    values = [];
  const at = (i, j) => i * n + j;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      rows.push(at(i, j));
      cols.push(at(i, j));
      values.push(4);
      for (const [di, dj] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ])
        if (i + di >= 0 && i + di < n && j + dj >= 0 && j + dj < n) {
          rows.push(at(i, j));
          cols.push(at(i + di, j + dj));
          values.push(-1);
        }
    }
  return coo(gpu, { rows, cols, values, shape: [n * n, n * n] });
}

test('coo sorts entries by row and column and sums duplicates; csr and diags build the same matrices', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  using A = coo(gpu, { rows: [1, 0, 1, 1], cols: [1, 2, 0, 1], values: [2, 5, -1, 3], shape: [2, 3] });
  assert.ok(A instanceof CsrMatrix);
  assert.deepEqual([A.shape, A.nnz], [[2, 3], 3]);
  assert.deepEqual(await read(A.rowPtr), [0, 1, 3]);
  assert.deepEqual(await read(A.colIdx), [2, 0, 1]);
  assert.deepEqual(await read(A.values), [5, -1, 5]);
  assert.deepEqual(await read(A.toDense()), [0, 0, 5, -1, 5, 0]);
  using B = csr(gpu, { rowPtr: [0, 1, 3], colIdx: [2, 1, 0], values: [5, 5, -1], shape: [2, 3] });
  assert.deepEqual(await read(B.colIdx), [2, 0, 1]);
  using T = diags(gpu, [-1, 2, -1], [-1, 0, 1], [4, 4]);
  assert.deepEqual(await read(T.toDense()), [2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2]);
  assert.deepEqual(await read(T.diagonal()), [2, 2, 2, 2]);
  assert.throws(() => coo(gpu, { rows: [2], cols: [0], values: [1], shape: [2, 2] }), RangeError);
  assert.throws(() => csr(gpu, { rowPtr: [0, 2, 1], colIdx: [0], values: [1], shape: [2, 2] }), RangeError);
  A.dispose();
  assert.throws(
    () => A.matvec(gpu.zeros(3)),
    (e) => e.code === 'disposed',
  );
});

test('spmv and transpose agree with the dense product', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  using A = coo(gpu, { rows: [0, 0, 1, 2, 2], cols: [0, 3, 1, 0, 2], values: [1, 2, 3, 4, 5], shape: [3, 4] });
  const x = gpu.array([1, 2, 3, 4]);
  assert.deepEqual(await read(spmv(A, x)), [9, 6, 19]);
  using T = A.transpose();
  assert.deepEqual(T.shape, [4, 3]);
  assert.deepEqual(await read(T.toDense()), [1, 0, 4, 0, 3, 0, 0, 0, 5, 2, 0, 0]);
  assert.deepEqual(await read(T.matvec(gpu.array([1, 1, 1]))), [5, 3, 5, 2]);
  assert.throws(() => A.matvec(gpu.zeros(3)), RangeError);
});

test('cg solves the 2-D Poisson problem; with and without the Jacobi preconditioner', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  using A = laplacian(gpu, 16);
  const want = Float32Array.from({ length: 256 }, (_, k) => Math.sin(k / 7)),
    b = A.matvec(gpu.array(want));
  for (const preconditioner of ['jacobi', 'none']) {
    const { x, iterations, residual, converged } = await cg(A, b, { tol: 1e-6, preconditioner });
    assert.ok(converged, `${preconditioner}: residual ${residual}`);
    assert.ok(iterations > 5 && iterations < 256, `${preconditioner}: ${iterations} iterations`);
    close(await read(x), Array.from(want), 1e-3, preconditioner);
  }
  const capped = await cg(A, b, { maxIterations: 3, checkEvery: 1 });
  assert.deepEqual([capped.iterations, capped.converged], [3, false]);
  await assert.rejects(() => cg(A, gpu.zeros(5)), RangeError);
  using R = coo(gpu, { rows: [0], cols: [0], values: [1], shape: [1, 2] });
  await assert.rejects(
    () => cg(R, gpu.zeros(1)),
    (e) => e instanceof RangeError && /square/.test(e.message),
  );
});

test('a breakdown in f32 (an ill-conditioned system run past its attainable accuracy) returns the last finite x', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const n = 1000;
  // The 1-D Laplacian has condition number about 4e5: f32 CG cannot reach 1e-6, and run long enough its inner
  // products underflow to 0 and turn the iterates into NaN.
  using A = diags(gpu, [-1, 2, -1], [-1, 0, 1], [n, n]);
  for (const solve of [cg, bicgstab]) {
    const { x, residual } = await solve(A, gpu.ones(n), { tol: 1e-6 });
    const values = await read(x);
    assert.ok(values.every(Number.isFinite), `${solve.name}: x is finite`);
    assert.ok(Number.isFinite(residual), `${solve.name}: residual ${residual}`);
  }
});

test('bicgstab solves a nonsymmetric convection-diffusion system', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const n = 200;
  using A = diags(gpu, [-1.3, 2.5, -0.7], [-1, 0, 1], [n, n]);
  const want = Float32Array.from({ length: n }, (_, k) => Math.cos(k / 9)),
    b = A.matvec(gpu.array(want));
  const { x, converged, residual } = await bicgstab(A, b, { tol: 1e-6 });
  assert.ok(converged, `residual ${residual}`);
  close(await read(x), Array.from(want), 1e-3, 'bicgstab');
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(() => bicgstab(A, b, { signal: controller.signal }), /stop/);
});
