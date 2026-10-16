import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:512px;height:320px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 16,
      camera: { position: [0, 1.3, 32], target: [0, 0, -20], near: 0.1, far: 120 },
    });
    engine.gpu.pushErrorScope('validation');
    const water = Water.attach(engine, {
      size: [80, 80],
      segments: 64,
      waves: [
        { direction: [0, 1], amplitude: 0.6, wavelength: 12, steepness: 0.05 },
        { direction: [1, 0.2], amplitude: 0.35, wavelength: 8, steepness: 0.05 },
      ],
    });
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
    window.surfaceTest = { engine, water };
  });
  const vendor = hardware.webgpu.vendor;
  const forward = await decodePNG(
    await page.locator('canvas').screenshot({ path: `test-results/water-surface-${vendor}-forward.png` }),
  );
  await page.evaluate(async () => {
    const { engine, water } = window.surfaceTest,
      original = water.triangles,
      reversed = new Uint32Array(original.length);
    for (let i = 0; i < original.length; i += 3) {
      const j = original.length - i - 3;
      reversed[i] = original[j];
      reversed[i + 1] = original[j + 1];
      reversed[i + 2] = original[j + 2];
    }
    engine.gpu.queue.writeBuffer(water.indices, 0, reversed);
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
  });
  const reversed = await decodePNG(
    await page.locator('canvas').screenshot({ path: `test-results/water-surface-${vendor}-reversed.png` }),
  );
  let changed = 0;
  for (let i = 0; i < forward.data.length; i += 4)
    if (
      Math.abs(forward.data[i] - reversed.data[i]) +
        Math.abs(forward.data[i + 1] - reversed.data[i + 1]) +
        Math.abs(forward.data[i + 2] - reversed.data[i + 2]) >
      3
    )
      changed++;
  const validation = await page.evaluate(async () => {
    const { engine } = window.surfaceTest,
      error = await engine.gpu.popErrorScope();
    engine.dispose();
    return error?.message;
  });
  assert.equal(validation, undefined);
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/water-surface-${vendor}.json`,
    JSON.stringify({ hardware, changedPixels: changed, errors }, null, 2),
  );
  console.log(JSON.stringify({ vendor, changedPixels: changed }));
  assert.ok(changed <= 10, 'Overlapping water changed when triangle draw order was reversed');
} finally {
  await browser.close();
}
