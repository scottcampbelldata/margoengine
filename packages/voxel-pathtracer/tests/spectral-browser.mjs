import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/spectral.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const pageErrors = [];
  context.page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((compat) => window.run(compat), compat);
    result.alpha = await context.page.evaluate(() => window.alpha());
    console.log(JSON.stringify({ compat, hardware: context.hardware, result }));
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    for (const row of result.alpha) {
      assert.equal(row.finite, true);
      assert.deepEqual(row.alpha, [1], `chromatic coverage ${row.wavelength}`);
    }
    for (const row of result.coverage) {
      assert.equal(row.finite, true, row.name);
      if (row.bounded !== undefined) assert.equal(row.bounded, true, row.name);
      if (!row.expected) continue;
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(row.actual[c] - row.expected[c]) <= row.tolerance,
          `${row.name} channel ${c}: ${row.actual[c]} vs ${row.expected[c]}`,
        );
    }
    for (const row of result.profiles) {
      assert.equal(row.finite, true);
      assert.ok(row.maximumError < 0.02, `analytic disk edge ${row.wavelength}: ${row.maximumError}`);
    }
    assert.equal(result.profiles[1].transition, 0);
    assert.ok(result.profiles[0].transition > result.profiles[2].transition);
    assert.ok(result.profiles[2].transition > 0);
    assert.equal(result.refusal.code, 'unsupported');
    assert.match(result.refusal.message, /https:\/\/margoengine.com\/errors#voxel-pathtracer/);
    results.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/browser-check.html?spectral=1',
    port: 'free',
    compat,
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const pageErrors = [];
  context.page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const lifecycle = await context.page.evaluate(() => window.check.viewport());
    console.log(JSON.stringify({ compat, lifecycle }));
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(lifecycle.errors, []);
    assert.deepEqual(lifecycle.messages, []);
    assert.equal(lifecycle.newDevice, true);
    assert.equal(lifecycle.statsAfter.converged, true);
    assert.ok(lifecycle.traced.differing > 1000);
    for (const mode of ['disabled', 'restored', 'afterDispose']) assert.equal(lifecycle[mode].differing, 0, mode);
    results.push({ compat, hardware: context.hardware, lifecycle });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-spectral.json', JSON.stringify(results, null, 2));
console.log('spectral: native and compatibility analytic transport and lens passed');
