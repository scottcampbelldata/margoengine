import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { exportGaussianGLB, exportSplat } from '@margoengine/exporters/splats';
import { parsePly, parseSplat, encodeSplat } from '@margoengine/splats/data';
import { GLTFAsset } from '@margoengine/gltf-pro';
import { readGaussianSplats, gaussianSplats } from '@margoengine/gltf-pro/splats';
import { readAccessor, splitGLB } from '../dist/glb.js';

const cloud = () => ({
  positions: new Float32Array([1, 2, 3, -1, 0, 4]),
  covariances: new Float32Array([1, 0, 0, 4, 0, 9, 4, 0.5, 0.2, 2, 0.3, 3]),
  colors: new Float32Array([0.1, 0.5, 0.9, 0.7, 1, 0, 0.4, 0.2]),
});
const close = (a, b, tolerance) => {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tolerance, `${i}: ${a[i]} vs ${b[i]}`);
};
async function decoded(bytes) {
  const parts = splitGLB(bytes),
    asset = new GLTFAsset(parts.json, [], parts.bin, { splats: gaussianSplats });
  return readGaussianSplats(asset, parts.json.meshes[0].primitives[0]);
}

test('ratified splat GLB round trips covariance, linear color and opacity without mutating input', async () => {
  const source = cloud(),
    copy = structuredClone(source),
    bytes = await exportGaussianGLB(source, { name: 'Cloud', extras: { capture: 'test' } }),
    p = splitGLB(bytes),
    primitive = p.json.meshes[0].primitives[0],
    out = await decoded(bytes);
  assert.equal(primitive.mode, 0);
  assert.deepEqual(primitive.extensions.KHR_gaussian_splatting, {
    kernel: 'ellipse',
    colorSpace: 'lin_rec709_display',
  });
  assert.equal(p.json.extensionsRequired, undefined);
  assert.deepEqual(out.positions, source.positions);
  close(out.covariances, source.covariances, 1e-6);
  close(out.colors, source.colors, 1e-7);
  assert.deepEqual(source, copy);
  assert.deepEqual([...readAccessor(p, primitive.attributes.POSITION).values], [...source.positions]);
  assert.deepEqual(p.json.extras, { capture: 'test' });
});

test('all three SH degrees retain every coefficient with a correctly declared extension and fallback', async () => {
  for (const count of [4, 9, 16]) {
    const source = cloud();
    source.sphericalHarmonics = Float32Array.from({ length: 2 * count * 3 }, (_, i) => Math.sin(i) * 0.1);
    const bytes = await exportGaussianGLB(source, { required: true }),
      out = await decoded(bytes),
      parts = splitGLB(bytes);
    close(out.sphericalHarmonics, source.sphericalHarmonics, 1e-7);
    assert.deepEqual(parts.json.extensionsRequired, ['KHR_gaussian_splatting']);
    assert.equal(Object.keys(parts.json.meshes[0].primitives[0].attributes).length, count + 5);
  }
});

test('real licensed raccoon capture exports through both formats', async () => {
  const full = parsePly(await readFile(new URL('../../splats/test/fixtures/raccoon-v2.ply', import.meta.url))),
    n = 64,
    data = {
      positions: full.positions.slice(0, n * 3),
      covariances: full.covariances.slice(0, n * 6),
      colors: full.colors.slice(0, n * 4),
      sphericalHarmonics: full.sphericalHarmonics.slice(0, n * 48),
    };
  const glb = await exportGaussianGLB(data),
    out = await decoded(glb);
  assert.deepEqual(out.positions, data.positions);
  close(out.covariances, data.covariances, 1e-7);
  close(out.sphericalHarmonics, data.sphericalHarmonics, 1e-7);
  const splat = await exportSplat(data);
  assert.equal(splat.length, n * 32);
  assert.deepEqual(splat, encodeSplat(data));
  assert.deepEqual(parseSplat(splat).positions, data.positions);
});

test('invalid inputs, explicit output limits and aborts fail explicitly', async () => {
  await assert.rejects(exportGaussianGLB(cloud(), { maxBytes: 1 }), /MARGO_EXPORT_SPLAT_SIZE/);
  await assert.rejects(exportSplat(cloud(), { maxBytes: 1 }), /MARGO_EXPORT_SPLAT_SIZE/);
  await assert.rejects(exportGaussianGLB(cloud(), { maxBytes: -1 }), /MARGO_EXPORT_SPLAT_LIMIT/);
  await assert.rejects(exportGaussianGLB(cloud(), { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const bad = cloud();
  bad.covariances[0] = -1;
  await assert.rejects(exportGaussianGLB(bad), /positive definite/);
});
