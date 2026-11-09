import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { erode } from '../dist/erosion.js';
import { createErosionKernel } from '../dist/erosion-wasm.js';

const fields = ['height', 'flow', 'direction', 'wear', 'deposit', 'outflow'];
test('SIMD erosion matches every CPU byte over options, boundaries and repeated memory growth', {
  timeout: 120000,
}, async () => {
  using kernel = await createErosionKernel();
  for (let seed = 1; seed <= 36; seed++) {
    const nx = 2 + (seed % 17),
      nz = 2 + (seed % 23);
    const height = Int32Array.from(
      { length: nx * nz },
      (_, i) => (Math.imul((i ^ seed) + 1, 2654435761) >>> 13) - 262144,
    );
    const grid = { height, nx, nz, step: [1, 1000, 16000, 1048576][seed % 4] };
    const before = height.slice();
    for (const options of [
      { iterations: 0 },
      { iterations: 1 },
      { iterations: 4 },
      { iterations: 3, thermal: 0 },
      { iterations: 3, capacity: 0 },
      { iterations: 3, talus: 0, thermal: 0.5, capacity: 1, incision: 1, deposition: 1, sea: 0 },
      { iterations: 3, talus: 89, deposition: 0, sea: 1000000 },
    ]) {
      const actual = kernel.erode(grid, options),
        expected = erode(grid, options);
      for (const key of fields) assert.deepEqual(actual[key], expected[key], `${key}, seed ${seed}`);
      assert.equal(actual.vectorBlocks, Math.floor(height.length / 4));
      assert.deepEqual(height, before);
    }
  }
  for (const step of [1, 1048576])
    for (const options of [
      { iterations: 1, thermal: 0.5, talus: 0, capacity: 1, incision: 1, deposition: 1 },
      { iterations: 2, thermal: 0, capacity: 1, incision: 1, deposition: 0 },
      { iterations: 1, sea: -33554432 },
    ]) {
      const grid = {
        height: Int32Array.from({ length: 35 }, (_, i) => (i % 3 ? 33554432 : -33554432)),
        nx: 7,
        nz: 5,
        step,
      };
      const actual = kernel.erode(grid, options),
        expected = erode(grid, options);
      for (const key of fields) assert.deepEqual(actual[key], expected[key], key);
    }
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/erosion-dem-crop.json', import.meta.url)));
  const grid = { height: Int32Array.from(fixture.height), nx: 16, nz: 16, step: 13000 };
  const result = kernel.erode(grid),
    expected = erode(grid);
  for (const key of fields) assert.deepEqual(result[key], expected[key], `real DEM ${key}`);
  // A later allocation may grow memory; earlier outputs are independently owned.
  kernel.erode({ height: new Int32Array(65536), nx: 256, nz: 256, step: 1 }, { iterations: 0 });
  for (const key of fields) assert.deepEqual(result[key], expected[key], `retained ${key}`);
});

test('SIMD erosion validates before allocation, supports abort and explicit disposal', { timeout: 30000 }, async () => {
  const controller = new AbortController(),
    reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(createErosionKernel({ signal: controller.signal }), (e) => e === reason);
  const kernel = await createErosionKernel();
  const grid = { height: new Int32Array(4), nx: 2, nz: 2, step: 1 };
  for (const options of [
    null,
    { iterations: -1 },
    { iterations: 1025 },
    { thermal: NaN },
    { capacity: 2 },
    { deposition: -1 },
    { incision: Infinity },
    { sea: NaN },
    { talus: 90 },
  ]) {
    assert.throws(
      () => kernel.erode(grid, options),
      (e) => !!e.code,
    );
  }
  for (const changes of [
    { nx: 1 },
    { nz: 0 },
    { nx: 2049, nz: 2048 },
    { step: 0 },
    { height: new Float32Array(4) },
    { height: Int32Array.of(33554433, 0, 0, 0) },
  ]) {
    assert.throws(
      () => kernel.erode({ ...grid, ...changes }),
      (e) => !!e.code,
    );
  }
  assert.throws(
    () => kernel.erode(grid, { signal: controller.signal }),
    (e) => e === reason,
  );
  const result = kernel.erode(grid, { iterations: 0 });
  kernel.dispose();
  kernel[Symbol.dispose]();
  assert.deepEqual(result.height, grid.height);
  assert.throws(
    () => kernel.erode(grid),
    (e) => !!e.code && /disposed/.test(e.message),
  );
});

test('SIMD erosion ships one lazy feature module and no core dependency', { timeout: 30000 }, () => {
  const source = readFileSync(new URL('../src/erosion-wasm.ts', import.meta.url), 'utf8');
  assert.match(source, /new URL\(\/\* @vite-ignore \*\/ '\.\/erosion\.wasm\?no-inline', import\.meta\.url\)/);
  const built = readFileSync(new URL('../dist/erosion-wasm.js', import.meta.url), 'utf8');
  assert.doesNotMatch(built, /data:application\/wasm/);
  assert.ok(WebAssembly.validate(readFileSync(new URL('../dist/erosion.wasm', import.meta.url))));
  assert.doesNotMatch(source, /from ['"]@margoengine\/core/);
});
