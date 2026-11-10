import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseNIfTI } from '../dist/formats.js';
import { fitDiffusionTensor, tensorEigen } from '../dist/tensor.js';
const root = new URL('./fixtures/tensor/', import.meta.url),
  file = (n) => readFile(new URL(n, root));
const floats = async (n) => {
  const b = gunzipSync(await file(n));
  return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
};
test('native OpenNeuro diffusion crop matches independent NumPy linear least squares and spectral analysis', async () => {
  const metadata = JSON.parse(await file('source.json'));
  assert.equal(metadata.license, 'CC0');
  for (const [name, hash] of Object.entries(metadata.files))
    assert.equal(
      createHash('sha256')
        .update(await file(name))
        .digest('hex'),
      hash,
      name,
    );
  const image = await parseNIfTI(await file('dwi-crop.nii.gz')),
    bValues = (await file('dwi.bval')).toString().trim().split(/\s+/).map(Number),
    rows = (await file('dwi.bvec'))
      .toString()
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim().split(/\s+/).map(Number)),
    gradients = bValues.flatMap((_, i) => rows.map((row) => row[i])),
    fit = await fitDiffusionTensor({ signals: image.all, voxels: image.data.length, bValues, gradients }),
    reference = await floats('tensors.f64.gz'),
    baseline = await floats('baseline.f64.gz'),
    residual = await floats('residual.f64.gz'),
    eigen = await floats('eigenvalues.f64.gz'),
    fa = await floats('fa.f64.gz');
  assert.deepEqual(image.dims, [32, 32, 8]);
  assert.equal(image.frames, 65);
  let coefficientError = 0;
  for (let i = 0; i < reference.length; i++)
    coefficientError = Math.max(coefficientError, Math.abs(fit.tensors[i] - reference[i]));
  assert.ok(
    coefficientError <= 2e-13,
    `ordinary linear least squares differs from independent SVD solve: ${coefficientError}`,
  );
  for (let i = 0; i < image.data.length; i++) {
    assert.ok(Math.abs(fit.baseline[i] - baseline[i]) <= 1e-8);
    assert.ok(Math.abs(fit.residual[i] - residual[i]) <= 2e-12);
    const e = tensorEigen(fit.tensors.subarray(i * 6, i * 6 + 6));
    assert.ok(Math.abs(e.fa - fa[i]) <= 1e-10);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(e.values[k] - eigen[i * 3 + k]) <= 2e-13);
  }
});
