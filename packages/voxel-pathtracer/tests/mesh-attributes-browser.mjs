import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const rows = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/mesh-attributes.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((c) => window.run(c), compat);
    console.log(JSON.stringify({ compat, hardware: context.hardware, result }));
    assert.deepEqual(errors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    assert.equal(result.rows.length, 4);
    for (const row of result.rows) {
      assert.equal(row.finite, true, row.name);
      assert.ok(row.maximumError < 1e-5, `${row.name}: ${row.maximumError}`);
    }
    rows.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-mesh-attributes.json', JSON.stringify(rows, null, 2));
