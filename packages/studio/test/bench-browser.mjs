// GPU check of @margoengine/studio/bench on WebGPU and on the WebGL2 compatibility layer: the default bench opens,
// marks data-ready with its renderer, lights and shadows a box on its cyclorama, runs frame callbacks, follows a
// resize and releases the engine on dispose. node packages/studio/test/bench-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const compat = process.argv.includes('--compat');
const context = await openBrowser({
  startPath: '/packages/studio/test/bench-browser.html',
  port: 'free',
  ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
});
const { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const opened = await page.evaluate((c) => window.check.open(c), compat);
  assert.equal(opened.ready, true);
  assert.equal(opened.renderer, compat ? 'compatibility' : 'webgpu');
  assert.equal(opened.data.ready, 'true');
  assert.equal(opened.data.renderer, opened.renderer);
  assert.equal(opened.data.error, undefined);
  assert.deepEqual(opened.size, [240, 160], 'backbuffer follows the layout box at pixelRatio 1');
  assert.deepEqual(opened.parts, { shadows: true, contact: true, backdrop: true, lighting: true });
  const snap = async (visible) => {
    await page.evaluate((v) => window.check.show(v), visible);
    return decodePNG(await page.locator('canvas').screenshot());
  };
  const off = await snap(false),
    on = await snap(true);
  // Floor in front of and beside the box, where its shadow and contact shadow fall.
  const mean = (image, x0, y0, x1, y1) => {
    let sum = 0,
      n = 0;
    for (let y = Math.round(y0 * image.height); y < Math.round(y1 * image.height); y++)
      for (let x = Math.round(x0 * image.width); x < Math.round(x1 * image.width); x++) {
        const k = (y * image.width + x) * 4;
        sum += (image.data[k] + image.data[k + 1] + image.data[k + 2]) / 3;
        n++;
      }
    return sum / n;
  };
  if (process.argv.includes('--save'))
    (await import('node:fs')).writeFileSync(
      `test-results/bench-${compat ? 'webgl2' : 'webgpu'}.png`,
      await page.locator('canvas').screenshot(),
    );
  const reds = on.data.filter((_, i) => i % 4 === 0);
  const ground = {
    with: mean(on, 0.15, 0.6, 0.45, 0.85),
    without: mean(off, 0.15, 0.6, 0.45, 0.85),
    spread: Math.max(...reds) - Math.min(...reds),
  };
  assert(ground.spread > 60, `a lit, shaded studio, not a flat fill: red spread ${ground.spread}`);
  assert(
    ground.with < ground.without - 4,
    `the box darkens the floor beside it (shadow map and contact shadow): ${ground.with} against ${ground.without}`,
  );
  const frames = await page.evaluate(() => window.check.frames());
  assert(frames.calls >= 5 && frames.stopped && frames.time, JSON.stringify(frames));
  assert.equal(await page.evaluate(() => window.check.resize()), 300);
  const closed = await page.evaluate(() => window.check.dispose());
  assert.deepEqual(closed, { disposed: true, aborted: true, errors: [] });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ backend: compat ? 'WebGL2 compatibility' : 'WebGPU', ground, frames }));
  console.log('studio bench passed');
} finally {
  await context.close();
}
