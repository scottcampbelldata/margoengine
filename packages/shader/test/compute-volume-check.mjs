import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/shader/test/compute-volume-check.html', port: 'free' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const { results, pairs, sampled, errors: gpuErrors } = await context.page.evaluate(() => window.check());
  assert.deepEqual(errors, []);
  assert.deepEqual(gpuErrors, []);
  for (const { dimension, format, data, error } of results) {
    assert.equal(error, null, dimension + ' ' + format);
    for (let i = 0; i < 24; i++) {
      const integer = /[us]int$/.test(format),
        components = format.startsWith('rgba') ? 4 : format.startsWith('rg') ? 2 : 1;
      const expected = [i % 4, Math.floor(i / 4) % 3, Math.floor(i / 12)].map((x) => (integer ? x : x / 4)).concat(1);
      for (let c = 0; c < 4; c++) {
        const value = c < components ? expected[c] : c === 3 ? 1 : 0;
        const tolerance = format === 'rgba8unorm' ? 1 / 255 : format === 'rgba8snorm' ? 1 / 127 : 0;
        assert.ok(
          Math.abs(data[i * 4 + c] - value) <= tolerance,
          `${dimension} ${format} voxel ${i} component ${c}: ${data[i * 4 + c]} != ${value}`,
        );
      }
    }
  }
  for (const data of pairs) assert.deepEqual(data, Array.from({ length: 24 }, () => [3, 6, 9, 12]).flat());
  assert.deepEqual(sampled, [1, 1, 1, 1]);
  console.log('volume storage: 16 formats x 2 dimensions, every voxel, ping-pong and 3d sampling passed');
} finally {
  await context.close();
}
