import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/mesh.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const pageErrors = [];
  context.page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((compat) => window.run(compat), compat);
    console.log(JSON.stringify({ compat, hardware: context.hardware, result }));
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    for (const row of result.coverage) {
      assert.equal(row.finite, true, row.name);
      // Analytic constant paths incur only f32 arithmetic and camera projection;
      // the conservative glass furnace includes sub-ulp discarded tail paths.
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(row.actual[c] - row.expected[c]) < 1e-5,
          `${row.name} channel ${c}: ${row.actual[c]} vs ${row.expected[c]}`,
        );
      if (row.maximumError !== undefined) assert.ok(row.maximumError < 1e-5, 'no shared-edge cracks');
      if (row.differing !== undefined) assert.equal(row.differing, 0);
      if (row.ids) assert.deepEqual(row.ids, [-4, -5]);
    }
    assert.equal(result.lifecycle.newDevice, true);
    assert.ok(result.lifecycle.traced > 1000);
    assert.equal(result.lifecycle.disabled, 0);
    assert.equal(result.lifecycle.restored, 0);
    assert.equal(result.lifecycle.disposed, 0);
    assert.equal(result.refusal.code, 'unsupported');
    assert.match(result.refusal.message, /https:\/\/margoengine.com\/errors#voxel-pathtracer/);
    results.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-mesh.json', JSON.stringify(results, null, 2));
console.log('mesh: native, compatibility, analytic transport, mixed secondary paths and lifecycle passed');
