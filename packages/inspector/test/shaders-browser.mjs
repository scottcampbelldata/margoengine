// Live shader editing on a real WebGPU device (Metal on the Mac, D3D12 or Vulkan elsewhere): a good edit compiles and
// is drawn, a broken one is rejected by the device's own WGSL compiler, placed at its line in the edited text, and the
// mesh keeps drawing its last good shader with no uncaptured device error; the panel applies typed text.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/inspector/test/shaders.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  assert.equal(await page.evaluate(() => window.setup()), 'webgpu');
  const red =
    'fn shade(i: Out, s: Surface) -> Surface {\n  var o = s;\n  o.base = vec4f(1.0, 0.0, 0.0, 1.0);\n  return o;\n}';
  const good = await page.evaluate((wgsl) => window.edit(wgsl), red);
  assert.equal(good.ok, true, JSON.stringify(good.diagnostics));
  assert.ok(good.modules >= 1, 'the device built the edited shader');
  assert.equal(good.drawn, red);
  // An undeclared name on line 3, column 12: the device's compiler rejects it.
  const broken = 'fn shade(i: Out, s: Surface) -> Surface {\n  var o = s;\n  o.base = not_declared;\n  return o;\n}';
  const bad = await page.evaluate((wgsl) => window.edit(wgsl), broken);
  assert.equal(bad.ok, false);
  assert.equal(bad.drawn, red, 'the mesh keeps its last good shader');
  const placed = bad.diagnostics.find((d) => d.type === 'error' && d.line === 3);
  assert.ok(placed, `an error on line 3 of the edit: ${JSON.stringify(bad.diagnostics)}`);
  assert.equal(placed.column, 12);
  assert.match(placed.message, /not_declared/);
  // The panel: type, apply, see the status; undo puts the previous WGSL back.
  const textarea = page.getByRole('textbox', { name: 'WGSL', exact: true });
  await textarea.fill(await page.evaluate(() => window.good));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Compiled' }).waitFor();
  assert.equal(await page.evaluate(() => window.mesh.material.wgsl === window.good), true);
  await page.evaluate(() => window.panel.history.undo());
  assert.equal(await page.evaluate(() => window.mesh.material.wgsl), red);
  assert.equal(await textarea.inputValue(), red);
  await page.evaluate(async () => {
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    await waitForPipelines(async () => {
      window.engine.render();
      await window.engine.gpu.queue.onSubmittedWorkDone();
    });
    await new Promise(requestAnimationFrame);
  });
  assert.deepEqual(await page.evaluate(() => window.errors), [], 'no uncaptured device error');
  assert.deepEqual(errors, []);
  console.log(
    'webgpu: edited WGSL compiled and drawn, a compile error placed at 3:12 and rolled back, panel apply and undo passed',
  );
} finally {
  await page.evaluate(() => window.engine?.dispose());
  await context.close();
}
