import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { parseNRRD } from '../../loaders/dist/nrrd.js';

const assets = new URL('../../../examples/assets/sciviz/', import.meta.url);
const read = (name) => readFileSync(new URL(name, assets));
const metadata = (name) => JSON.parse(read(`${name}.json`));

test('real-data demo assets match their provenance hashes', () => {
  for (const [name, file] of [
    ['head', 'head.nrrd'],
    ['wind', 'wind.bin'],
    ['stars', 'stars.bin'],
  ]) {
    assert.equal(createHash('sha256').update(read(file)).digest('hex'), metadata(name).sha256, file);
  }
});

test('head MRI has interior tissue structure in all three slice directions', async () => {
  const volume = await parseNRRD(read('head.nrrd'));
  assert.deepEqual(volume.dims, [88, 128, 128]);
  const [nx, ny, nz] = volume.dims;
  for (const axis of [0, 1, 2]) {
    const bins = new Set();
    let tissue = 0;
    for (let z = 32; z < nz - 32; z++)
      for (let y = 32; y < ny - 32; y++)
        for (let x = 22; x < nx - 22; x++) {
          if ([x, y, z][axis] !== Math.floor(volume.dims[axis] / 2)) continue;
          const value = volume.data[(z * ny + y) * nx + x];
          if (value > 100) {
            tissue++;
            bins.add(Math.floor(value / 10));
          }
        }
    assert.ok(tissue > 500, `${axis}: interior tissue`);
    assert.ok(bins.size > 15, `${axis}: actual interior variation, rather than a uniform filled box or shell`);
  }
});

test('2MASS sample has one million finite observed sky positions and colours', () => {
  const buffer = gunzipSync(read('stars.bin'));
  const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const n = metadata('stars').count;
  assert.equal(n, 1_000_000);
  assert.equal(data.length, n * 4);
  assert.ok(data.every(Number.isFinite));
  for (let col = 0; col < 4; col++) {
    const values = data.subarray(col * n, (col + 1) * n);
    let lo = Infinity,
      hi = -Infinity;
    for (const value of values) {
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
    assert.deepEqual([lo, hi], metadata('stars').ranges[col]);
  }
});

test('NOAA native daily fields vary in time and have both signs in both components', () => {
  const buffer = gunzipSync(read('wind.bin'));
  const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  assert.equal(data.length, 8 * 2 * 49 * 19);
  assert.ok(data.every(Number.isFinite));
  for (let day = 0; day < 8; day++)
    for (let component = 0; component < 2; component++) {
      const values = data.subarray((day * 2 + component) * 931, (day * 2 + component + 1) * 931);
      assert.ok(values.some((v) => v > 1) && values.some((v) => v < -1));
      if (day) assert.notDeepEqual(values, data.subarray(component * 931, (component + 1) * 931));
    }
});

test('retained browser test pages type-check against the package APIs', { timeout: 180_000 }, () => {
  execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'packages/sciviz/tests/pages/tsconfig.json'],
    {
      cwd: new URL('../../../', import.meta.url),
      timeout: 170_000,
      stdio: 'pipe',
    },
  );
});
