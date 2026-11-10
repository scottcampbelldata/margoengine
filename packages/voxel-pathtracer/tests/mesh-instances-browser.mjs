import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const rows = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/mesh-instances.html',
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
    assert.equal(result.rows.length, 10);
    for (const row of result.rows) {
      if (row.name === 'atomic invalid transform') {
        assert.equal(row.rejected, true);
        assert.equal(row.unchanged, true);
      } else {
        assert.equal(row.finite, true, row.name);
        assert.ok(row.maximumError < 1e-5, `${row.name}: ${row.maximumError}`);
        assert.ok(row.maximumDepthError < 1e-5, `${row.name} depth: ${row.maximumDepthError}`);
        assert.equal(row.aovMismatch, 0, row.name);
        assert.equal(row.triangles, 2);
        assert.equal(row.instances, 2);
      }
    }
    rows.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-mesh-instances.json', JSON.stringify(rows, null, 2));
