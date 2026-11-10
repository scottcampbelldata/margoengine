import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  tensorEigen,
  fitDiffusionTensor,
  sampleTensor,
  trackTensorFibers,
  hyperstreamlines,
  tensorEigenGPU,
  tensorGlyphs,
} from '../dist/tensor.js';
const close = (a, b, e = 1e-12) => assert.ok(Math.abs(a - b) <= e, `${a} differs from ${b}`);
const field = () => ({
  dims: [8, 4, 4],
  bounds: [0, 8, 0, 4, 0, 4],
  tensors: Float64Array.from({ length: 8 * 4 * 4 * 6 }, (_, i) => [3, 2, 1, 0, 0, 0][i % 6]),
});
test('scaled symmetric eigensystems reconstruct rotated, repeated, signed and zero tensors', () => {
  for (const t of [
    [2.5, 2.5, 1, 0.5, 0, 0],
    [1, 1, 1, 0, 0, 0],
    [-2, -3, 1, 0.4, 0.2, 0.1],
    [0, 0, 0, 0, 0, 0],
  ]) {
    const e = tensorEigen(t);
    assert.ok(e.residual < 1e-12);
    const a = [t[0], t[3], t[4], t[3], t[1], t[5], t[4], t[5], t[2]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        close(
          e.vectors[i * 3] * e.vectors[j * 3] +
            e.vectors[i * 3 + 1] * e.vectors[j * 3 + 1] +
            e.vectors[i * 3 + 2] * e.vectors[j * 3 + 2],
          i === j ? 1 : 0,
        );
        close(
          e.values.reduce((s, v, k) => s + v * e.vectors[k * 3 + i] * e.vectors[k * 3 + j], 0),
          a[i * 3 + j],
        );
      }
  }
  assert.deepEqual(Array.from(tensorEigen([2.5, 2.5, 1, 0.5, 0, 0]).values), [3, 2, 1]);
  assert.equal(tensorEigen([1, 1, 1, 0, 0, 0]).fa, 0);
  assert.equal(tensorEigen([0, 0, 0, 0, 0, 0]).fa, 0);
  assert.equal(typeof tensorEigenGPU, 'function');
  assert.equal(typeof tensorGlyphs, 'function');
  assert.throws(() => tensorEigen([1e308, 1e308, 1e308, 1e308, 0, 0]), /rescale tensor units/);
});
test('ordinary linear least squares recovers a full rotated diffusion tensor and baseline', async () => {
  const root = Math.SQRT1_2,
    g = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [root, root, 0],
      [root, 0, root],
      [0, root, root],
      [root, -root, 0],
    ],
    b = g.map((_, i) => (i ? 1000 : 0)),
    t = [0.0017, 0.0007, 0.0004, 0.0002, -0.0001, 0.00008];
  const signals = g.map(
    (v, i) =>
      1200 *
      Math.exp(
        -b[i] *
          (t[0] * v[0] ** 2 +
            t[1] * v[1] ** 2 +
            t[2] * v[2] ** 2 +
            2 * t[3] * v[0] * v[1] +
            2 * t[4] * v[0] * v[2] +
            2 * t[5] * v[1] * v[2]),
      ),
  );
  const fit = await fitDiffusionTensor({ signals, voxels: 1, bValues: b, gradients: g.flat() });
  assert.equal(fit.method, 'ordinary-linear-least-squares');
  fit.tensors.forEach((v, k) => close(v, t[k], 1e-15));
  close(fit.baseline[0], 1200, 1e-9);
  assert.ok(fit.residual[0] < 1e-13);
  assert.equal(fit.nonPositive[0], 0);
  await assert.rejects(
    () => fitDiffusionTensor({ signals: Array(8).fill(100), voxels: 1, bValues: b, gradients: Array(24).fill(0) }),
    /unit length/,
  );
});
test('coefficient interpolation reproduces affine tensors and respects missing voxels', () => {
  const f = field();
  for (let i = 0; i < 128; i++) f.tensors[i * 6] = (i % 8) + 0.5;
  close(sampleTensor(f, [2.3, 1.4, 1.2])[0], 2.3);
  assert.equal(sampleTensor(f, [-1, 0, 0]), null);
  f.mask = new Uint8Array(128).fill(1);
  f.mask[0] = 0;
  assert.equal(sampleTensor(f, [0.5, 0.5, 0.5]), null);
});
test('Euler and FACT are deterministic, follow the principal axis and terminate at masks/angles/budgets', async () => {
  for (const method of ['euler', 'fact']) {
    const a = await trackTensorFibers(field(), [4, 2, 2], { method, stepSize: 0.25 }),
      b = await trackTensorFibers(field(), [4, 2, 2], { method, stepSize: 0.25 });
    assert.deepEqual(a, b);
    assert.equal(a.length, 1);
    for (let i = 0; i < a[0].positions.length; i += 3) {
      close(a[0].positions[i + 1], 2);
      close(a[0].positions[i + 2], 2);
    }
    close(a[0].length, 8);
    close(a[0].positions[0], 0);
    close(a[0].positions.at(-3), 8);
  }
  const masked = field();
  masked.mask = new Uint8Array(128).fill(1);
  for (let i = 0; i < 128; i++) if (i % 8 === 6) masked.mask[i] = 0;
  const a = await trackTensorFibers(masked, [4, 2, 2], { method: 'fact' });
  assert.equal(a[0].positions.at(-3), 6);
  const f = field();
  for (let i = 0; i < 128; i++) if (i % 8 >= 5) f.tensors.set([1, 3, 2, 0, 0, 0], i * 6);
  const curved = await trackTensorFibers(f, [4, 2, 2], { method: 'fact', maxAngle: 30 });
  assert.equal(curved[0].positions.at(-3), 5);
  await assert.rejects(() => trackTensorFibers(field(), [4, 2, 2], { maxPoints: 2 }), /exceeds maxPoints/);
});
test('hyperstreamlines use transverse eigenvalues for ellipse radii and return unit normals', async () => {
  const result = await hyperstreamlines(field(), [4, 2, 2], { method: 'fact', radius: 1, sides: 12 });
  assert.equal(result.fibers.length, 1);
  assert.ok(result.triangles.cells.length > 0);
  close(result.triangles.bounds[2], 2 - 2 / 3, 1e-12);
  close(result.triangles.bounds[3], 2 + 2 / 3, 1e-12);
  close(result.triangles.bounds[4], 2 - 1 / 3, 1e-12);
  close(result.triangles.bounds[5], 2 + 1 / 3, 1e-12);
  const n = result.triangles.normals;
  for (let i = 0; i < n.length; i += 3) close(Math.hypot(n[i], n[i + 1], n[i + 2]), 1, 1e-7);
});
test('GPU eigensystem construction releases every earlier allocation when a later allocation fails', async () => {
  const context = {
    routeReady: Promise.resolve(),
    device: { limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6 } },
  };
  await assert.rejects(() => tensorEigenGPU(context, [1e-35, 1e-35, 1e-35, 0, 0, 0]), /2\^-96/);
  await assert.rejects(
    () =>
      tensorEigenGPU(context, {
        length: 6_000_000,
        get 0() {
          throw new Error('must not read or copy an oversized field');
        },
      }),
    /device limits/,
  );
  for (const failureAt of [2, 3, 4, 5]) {
    let calls = 0;
    const disposed = [],
      fault = { code: 'OWNED_TEST_FAILURE' };
    const resource = () => {
      const id = ++calls;
      if (id === failureAt) throw fault;
      return { dispose: () => disposed.push(id), run: () => resource() };
    };
    const gpu = {
      routeReady: Promise.resolve(),
      device: {
        limits: { maxBufferSize: 1e6, maxStorageBufferBindingSize: 1e6, maxComputeWorkgroupsPerDimension: 65535 },
      },
      zeros: resource,
      array: resource,
      kernel: resource,
    };
    await assert.rejects(
      () => tensorEigenGPU(gpu, [3, 2, 1, 0, 0, 0]),
      (e) => e === fault,
    );
    assert.deepEqual(
      [...new Set(disposed)].sort(),
      Array.from({ length: failureAt - 1 }, (_, i) => i + 1),
    );
  }
});
