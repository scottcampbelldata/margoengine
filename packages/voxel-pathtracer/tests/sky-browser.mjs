import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/sky.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((compat) => window.run(compat), compat);
    console.log(JSON.stringify({ compat, hardware: context.hardware, result }));
    assert.deepEqual(errors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    assert.ok(result.multiple > result.single, 'higher scattering orders must add energy');
    assert.ok(result.noon[2] > result.noon[0] && result.noon[2] > result.noon[1], 'blue noon zenith');
    assert.ok(
      result.ozone[2] / result.ozone[1] > result.noOzone[2] / result.noOzone[1],
      'ozone shifts twilight toward blue',
    );
    assert.ok(result.sunset[0] > result.sunset[1] && result.sunset[1] > result.sunset[2], 'red low sun');
    assert.equal(result.nightOff, 0);
    assert.ok(result.stars > 0);
    assert.equal(result.starsDelta, 0);
    assert.ok(result.moonFull > result.moonNew, 'phase changes moonlight');
    assert.equal(result.vacuum, 0);
    assert.equal(result.tiny, 0);
    assert.ok(Number.isFinite(result.orbit));
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(result.lambert[c] - (20 * [0.3, 0.2, 0.1][c]) / Math.PI) < 1e-4, 'analytic Lambert planet');
    assert.ok(Number.isFinite(result.high) && result.high > 10000);
    const theta = (Math.PI * 0.5) / 1024,
      scale = 434 / (1 + Math.cos(theta));
    const mean = 1.2 * Math.PI * 0.0003 ** 2 * scale ** 2 * 0.01234375 * 1000;
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(result.narrow[c] - [0.8, 0.9, 1][c] * mean) < 1e-6,
        'narrow maps integrate unresolved starlight',
      );
    assert.ok(result.largePlanet[2] > result.largePlanet[0], 'large planet retains sky above its Float32 surface');
    assert.ok(Number.isFinite(result.dense)&&result.dense>0,'conservative scattering at the supported optical depth remains finite');
    assert.equal(result.disposedBeforeRender, true);
    assert.equal(result.disposedAfterAbort, true);
    assert.equal(result.abortExact, true);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(result.constantImage[c] - [0.1, 0.2, 0.3][c]) < 1e-5, `traced constant channel ${c}`);
    assert.ok(
      result.ground.every((v) => Number.isFinite(v) && v > 0),
      'sky and sun illuminate a diffuse receiver',
    );
    assert.equal(result.refusal.code, 'unsupported');
    assert.match(result.refusal.message, /https:\/\/margoengine.com\/errors#sky/);
    results.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
const lifecycle = await openBrowser({
  startPath: '/packages/voxel-pathtracer/tests/browser-check.html?sky=1',
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
await writeFile('test-results/voxel-pathtracer-sky.json', JSON.stringify(results, null, 2));
console.log('sky: native and compatibility values, night, cancellation, real device restoration and disposal passed');
