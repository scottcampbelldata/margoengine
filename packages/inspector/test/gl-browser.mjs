import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/inspector/test/gl.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  assert.equal(await page.evaluate(() => window.setup()), 'webgl2');
  const original = await page.evaluate(() => window.pixel());
  for (const mode of ['wireframe', 'normals', 'bounds', 'lights']) {
    await page.getByRole('checkbox', { name: mode, exact: true }).check();
    const pixels = await page.evaluate(() => window.pixel());
    assert.notDeepEqual(pixels, original, mode);
    const report = await page.evaluate(() => window.panel.capture());
    assert.ok(report.passes[0].draws.length > 0);
    assert.ok(report.passes.some((p) => p.name.startsWith('inspector:gl:') && p.draws.length));
    assert.ok(report.passes[0].draws[0].shaders.some((s) => s.includes('#version 300 es')));
    assert.ok(report.passes.every((p) => p.cpuMilliseconds >= 0));
    if (report.gpuTiming) assert.ok(report.passes.every((p) => p.gpuMilliseconds >= 0));
    await page.getByRole('checkbox', { name: mode, exact: true }).uncheck();
    assert.deepEqual(await page.evaluate(() => window.pixel()), original, 'GL state and drawing restored');
  }
  await page.evaluate(() => {
    window.panel.setDebug('wireframe', true);
    window.mesh.visible = false;
  });
  const hidden = await page.evaluate(() => window.panel.capture());
  assert.equal(hidden.drawCalls, 0);
  assert.deepEqual(errors, []);
  console.log(
    'CC0 BoxVertexColors native WebGL2 preview: all four overlays, restored pixels, shader/draw capture, pass timing and visibility passed',
  );
} finally {
  await page.evaluate(() => {
    window.panel?.dispose();
    window.engine?.dispose();
  });
  await context.close();
}
