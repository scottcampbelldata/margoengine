import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/guiding.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (error) => errors.push(error.message));
  context.page.on('console', (message) => {
    if (message.text().startsWith('guiding render:')) console.log(message.text());
  });
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((compat) => window.run(compat), compat);
    console.log(JSON.stringify({ compat, hardware: context.hardware, result }));
    assert.deepEqual(errors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    assert.equal(result.zeroDelta, 0);
    assert.equal(result.noGuideDelta, 0);
    assert.equal(result.emptyBlack, true);
    assert.equal(result.refusal?.code, 'unsupported');
    assert.match(result.refusal.message, /https:\/\/margoengine.com\/errors#voxel-pathtracer/);
    assert.ok(
      result.guidedError < result.baseError / 2,
      `guided squared error ${result.guidedError} must beat baseline ${result.baseError} by 2x`,
    );
    for (const scene of result.coverage) {
      assert.equal(scene.finite, true, scene.name);
      if (scene.reference)
        for (let c = 0; c < 3; c++)
          assert.ok(
            Math.abs(scene.actual[c] - scene.reference[c]) < 0.02,
            `${scene.name} channel ${c}: ${scene.actual[c]} vs ${scene.reference[c]}`,
          );
      if (scene.expected !== undefined)
        for (const v of [...scene.reference, ...scene.actual])
          assert.ok(Math.abs(v - scene.expected) < 0.02, `${scene.name}: ${v} vs ${scene.expected}`);
    }
    results.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
const lifecycle = await openBrowser({
  startPath: '/packages/voxel-pathtracer/tests/browser-check.html?guiding=1',
  port: 'free',
});
try {
  await lifecycle.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const result = await lifecycle.page.evaluate(() => window.check.viewport());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.messages, []);
  assert.equal(result.disabled.differing, 0);
  assert.equal(result.afterDispose.differing, 0);
  assert.equal(result.restored.differing, 0);
  assert.equal(result.newDevice, true);
  assert.ok(result.traced.differing > 1000);
  assert.equal(result.statsAfter.converged, true);
  results.push({ lifecycle: result });
} finally {
  await lifecycle.close();
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-guiding.json', JSON.stringify(results, null, 2));
console.log('guiding: native, compatibility, values, device restoration and disposal passed');
