import { solve, inv, det, cholesky, qr, svd, eigh, eigvalsh } from '@margoengine/compute/decomp';
function near(a, b, label = 'values', tol = 3e-5) {
  if (a.length !== b.length) throw Error(`${label}: length ${a.length} != ${b.length}`);
  const scale = Math.max(1, ...b.map(Math.abs));
  for (let i = 0; i < a.length; i++)
    if (!Number.isFinite(a[i]) || Math.abs(a[i] - b[i]) > tol * scale)
      throw Error(`${label}[${i}]: ${a[i]} != ${b[i]}`);
}
const eye = (n) => Array.from({ length: n * n }, (_, i) => Number(Math.floor(i / n) === i % n));
const tr = (a, m, n) => Array.from({ length: m * n }, (_, i) => a[(i % m) * n + Math.floor(i / m)]);
function mul(a, b, m, k, n) {
  return Array.from({ length: m * n }, (_, i) => {
    let s = 0;
    for (let j = 0; j < k; j++) s += a[Math.floor(i / n) * k + j] * b[j * n + (i % n)];
    return s;
  });
}
async function data(x) {
  try {
    return Array.from(await x.read());
  } finally {
    x.dispose();
  }
}
/** Shared exact/reference and residual cases, run on CPU and both device backends. */
export async function decompCases(ctx) {
  const array = (a, shape) => ctx.array(a, { shape });
  let count = 0;
  near(await data(await solve(array([0, 2, 1, 3], [2, 2]), array([4, 7], [2]))), [1, 2], 'pivot solve');
  count++;
  near(await data(await inv(array([4, 7, 2, 6], [2, 2]))), [0.6, -0.7, -0.2, 0.4], 'inverse');
  count++;
  near(await data(await det(array([0, 2, 1, 3, 1, 2, 2, 4], [2, 2, 2]))), [-2, 0], 'batched determinants');
  count++;
  near(await data(await cholesky(array([4, 2, 2, 5], [2, 2]))), [2, 0, 1, 2], 'Cholesky');
  count++;
  near(
    await data(await solve(array([2, 0, 0, 4, 4, 0, 0, 8], [2, 1, 2, 2]), array([2, 4, 4, 8, 6, 12], [3, 2, 1]))),
    [1, 1, 2, 2, 3, 3, 0.5, 0.5, 1, 1, 1.5, 1.5],
    'broadcast solve',
  );
  count++;
  near(await data(await solve(array([0, 1, 2, 3], [2, 2]).T, array([4, 7], [2]).add(0))), [1, 2], 'strided solve');
  count++;
  near(await data(await det(array([], [0, 0]))), [1], 'empty det');
  count++;
  near(
    await data(await solve(array([2, 0, 0, 4, 4, 0, 0, 8], [2, 2, 2]), array([4, 8], [2]))),
    [2, 2, 1, 1],
    'broadcast vector RHS',
  );
  count++;
  const matrices = [
    [[1, 2, 3, 4, 5, 7], 3, 2],
    [[1, 2, 3, 4, 5, 7], 2, 3],
    [[1, 2, 2, 4, 3, 6], 3, 2],
    [[1, 2, 3, 2, 4, 6], 2, 3],
    [[0, 0, 0, 0, 0, 0], 3, 2],
    [[0, 0, 0, 0, 0, 0], 2, 3],
    [[1e-20, 0, 0, 2e-20, 0, 0], 3, 2],
    [[1e20, 0, 0, 2e20, 0, 0], 3, 2],
    [[1, 0, 0, 1e-10], 2, 2],
    [[3], 1, 1],
    [[], 0, 3],
    [[], 3, 0],
    [Array.from({ length: 35 }, (_, i) => Math.sin(i * 17 + 3)), 7, 5],
  ];
  for (const [a, m, n] of matrices)
    for (const fullMatrices of [false, true]) {
      const x = array(a, [m, n]),
        k = Math.min(m, n),
        qcols = fullMatrices ? m : k;
      const { q, r } = await qr(x, { fullMatrices });
      const qv = await data(q),
        rv = await data(r);
      near(mul(qv, rv, m, qcols, n), a, `QR ${m}x${n}`);
      near(mul(tr(qv, m, qcols), qv, qcols, m, qcols), eye(qcols), 'Q orthogonality');
      for (let row = 0; row < qcols; row++)
        for (let col = 0; col < Math.min(row, n); col++)
          if (rv[row * n + col] !== 0) throw Error('R must be upper trapezoidal');
      const { u, s, vh } = await svd(x, { fullMatrices });
      const uv = await data(u),
        sv = await data(s),
        vv = await data(vh),
        uc = fullMatrices ? m : k,
        vr = fullMatrices ? n : k;
      const us = Array.from({ length: m * k }, (_, i) => uv[Math.floor(i / k) * uc + (i % k)] * sv[i % k]);
      const vthin = vv.slice(0, k * n);
      near(mul(us, vthin, m, k, n), a, `SVD ${m}x${n}`);
      near(mul(tr(uv, m, uc), uv, uc, m, uc), eye(uc), 'U orthogonality');
      near(mul(vv, tr(vv, vr, n), vr, n, vr), eye(vr), 'Vh orthogonality');
      if (sv.some((v, i) => v < 0 || (i && v > sv[i - 1]))) throw Error('singular ordering');
      x.dispose();
      count += 2;
    }
  // Analytic tiny singular value survives: A^T A would lose it in f32.
  const tiny = await svd(array([1, 1, 0, 1e-10], [2, 2]));
  const singular = await data(tiny.s);
  tiny.u.dispose();
  tiny.vh.dispose();
  near([singular[1] / 1e-10], [1 / Math.sqrt(2)], 'tiny singular value');
  count++;
  for (const a of [
    [2, 1, 1, 2],
    [0, 1, 1, 0],
    [1, 0, 0, 1],
    [0, 0, 0, 0],
  ]) {
    const { values, vectors } = await eigh(array(a, [2, 2]));
    const w = await data(values),
      v = await data(vectors);
    near(
      mul(a, v, 2, 2, 2),
      v.map((x, i) => x * w[i % 2]),
      'eigen residual',
    );
    near(mul(tr(v, 2, 2), v, 2, 2, 2), eye(2), 'eigen orthogonality');
    near(await data(await eigvalsh(array(a, [2, 2]))), w, 'eigvalsh');
    count++;
  }
  // Two batched decompositions, independently known spectra.
  near(await data((await svd(array([3, 0, 0, 2, 4, 0, 0, 1], [2, 2, 2]))).s), [3, 2, 4, 1], 'batched SVD');
  count++;
  near(await data(await eigvalsh(array([2, 1, 1, 2, 0, 1, 1, 0], [2, 2, 2]))), [1, 3, -1, 1], 'batched eigenvalues');
  count++;
  return count;
}
