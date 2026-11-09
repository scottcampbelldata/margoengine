import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pictureError, assertBudget } from '../scripts/reference-rendering/compare.mjs';
import { lookMatrix } from '../scripts/reference-rendering/scene.mjs';
import { saveReference } from '../scripts/reference-rendering/reference.mjs';

test('changed outside deployment cannot overwrite the frozen reference', () => {
  const folder = mkdtempSync(join(tmpdir(), 'margo-reference-160-'));
  const path = join(folder, 'reference.png');
  try {
    const original = Buffer.from('frozen PNG bytes');
    const hash = saveReference(path, original);
    assert.throws(() => saveReference(path, Buffer.from('changed deployment'), hash), /frozen picture preserved/);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(saveReference(path, original, hash), hash);
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test('outside picture comparison counts every RGB pixel and silhouette without alpha or fitted exposure', () => {
  const picture = (data) => ({ width: 2, height: 1, data });
  const actual = picture([10, 20, 30, 0, 0, 0, 0, 255]);
  const reference = picture([0, 20, 40, 255, 30, 0, 0, 0]);
  const result = pictureError(actual, reference);
  assert.deepEqual(result, {
    pixels: 2,
    absolute: 50,
    square: 1100,
    max: 30,
    mae: 50 / 6,
    rmse: Math.sqrt(1100 / 6),
    foreground: 2,
    foregroundAbsolute: 50,
    foregroundMae: 50 / 6,
    changed: 2,
  });
  assertBudget(result, result);
  assert.throws(() => assertBudget({ ...result, absolute: 51 }, result));
  assert.throws(() => assertBudget({ ...result, square: 1101 }, result));
  assert.throws(() => assertBudget({ ...result, max: 31 }, result));
  assert.throws(() => assertBudget({ ...result, foreground: 1 }, result));
  assert.throws(() => pictureError(picture([0, 0, 0, 0, 0, 0, 0, 0]), picture([0, 0, 0, 0, 0, 0, 0, 0])));
  assert.throws(() => pictureError({ ...actual, width: 1 }, reference));
});

test('camera node looks down negative Z with the same world translation as Margo', () => {
  assert.deepEqual(lookMatrix([0, 0, 5], [0, 0, 0]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
  const m = lookMatrix([12, 9, 18], [3, 3, -1.5]);
  for (const c of [0, 4, 8]) assert.ok(Math.abs(Math.hypot(...m.slice(c, c + 3)) - 1) < 1e-15);
  const forward = m.slice(8, 11).map((v) => -v);
  const to = [3 - 12, 3 - 9, -1.5 - 18];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(forward[i] - to[i] / Math.hypot(...to)) < 1e-15);
});

test('metallic-roughness budget is the measured unrounded result, with real WebGL2 evidence', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('../docs/whitepaper/results/batch-160-metallic-roughness.json', import.meta.url), 'utf8'),
  );
  for (const row of [baseline, baseline.compat]) {
    assert.equal(row.metrics.mae, row.metrics.absolute / (512 * 512 * 3));
    assert.equal(row.metrics.foregroundMae, row.metrics.absolute / (row.metrics.foreground * 3));
    assert.equal(row.nativeWebGL2.code, 'unsupported');
    assert.equal(row.margo.primitives, 123);
  }
  assert.equal(baseline.compat.hardware.webgpu.vendor, 'margo-webgl2');
  assert.equal(baseline.referenceSha256, baseline.compat.referenceSha256);
});
