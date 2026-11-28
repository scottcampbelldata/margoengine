// GPU check of @margoengine/studio/bench on WebGPU and on the WebGL2 compatibility layer: the default bench opens,
// marks data-ready with its renderer, lights and shadows a box and a thin gnomon on its cyclorama with a readable key
// to fill balance and no view past its edge, frames its subject when no camera is passed, runs frame callbacks, follows a
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
    return decodePNG(await page.locator('#view').screenshot());
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
      await page.locator('#view').screenshot(),
    );
  const reds = on.data.filter((_, i) => i % 4 === 0);
  const ground = {
    with: mean(on, 0.15, 0.6, 0.45, 0.85),
    without: mean(off, 0.15, 0.6, 0.45, 0.85),
    spread: Math.max(...reds) - Math.min(...reds),
  };
  assert(ground.spread > 60, `a lit, shaded studio, not a flat fill: red spread ${ground.spread}`);
  // The cyclorama runs past the view: no pixel shows the clear colour (#77736d) past its side edge, as the grey quarter
  // disc did in the top-left corner when it was 40 wide. Read on the empty set, where no shadow can match it.
  let clear = 0;
  for (let k = 0; k < off.data.length; k += 4)
    if (Math.abs(off.data[k] - 0x77) <= 3 && Math.abs(off.data[k + 1] - 0x73) <= 3 && Math.abs(off.data[k + 2] - 0x6d) <= 3) clear++;
  assert.equal(clear, 0, `pixels of the clear colour past the cyclorama edge: ${clear}`);
  // A key, not a flat fill: the box's shadow core sits well under the lit floor (it was 0.86 of it with the softbox fill
  // at 0.55 and the key at 2.6).
  const shade = mean(on, 0.68, 0.62, 0.76, 0.7) / mean(off, 0.68, 0.62, 0.76, 0.7);
  assert(shade < 0.78, `the shadow core against the lit floor: ${shade}`);
  // The gnomon's shadow, right of its foot, darkens the floor clearly along its length (a penumbra of 0.02 per unit
  // washed it out).
  let gnomon = 0;
  for (let y = Math.round(0.84 * on.height); y < Math.round(0.97 * on.height); y++)
    for (let x = Math.round(0.86 * on.width); x < on.width; x++) {
      const k = (y * on.width + x) * 4;
      gnomon = Math.max(gnomon, (off.data[k] + off.data[k + 1] + off.data[k + 2] - on.data[k] - on.data[k + 1] - on.data[k + 2]) / 3);
    }
  assert(gnomon > 35, `the gnomon shadow darkens the floor by ${gnomon} levels`);
  Object.assign(ground, { clear, shade, gnomon });
  assert(
    ground.with < ground.without - 4,
    `the box darkens the floor beside it (shadow map and contact shadow): ${ground.with} against ${ground.without}`,
  );
  const frames = await page.evaluate(() => window.check.frames());
  assert(frames.calls >= 5 && frames.stopped && frames.time, JSON.stringify(frames));
  assert.equal(await page.evaluate(() => window.check.resize()), 300);
  // With no camera passed, ready() frames the registered subject: the 1 m box fills most of the view's height.
  await page.evaluate((c) => window.check.fit(c).then((r) => (window.framed = r)), compat);
  const framed = await decodePNG(await page.locator('#fit').screenshot());
  let top = framed.height,
    bottom = -1;
  for (let y = 0; y < framed.height; y++)
    for (let x = 0; x < framed.width; x++) {
      const k = (y * framed.width + x) * 4;
      if (framed.data[k] > framed.data[k + 1] + 60) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  const span = (bottom - top + 1) / framed.height;
  assert(span > 0.6 && top > 0 && bottom < framed.height - 1, `the framed box spans ${span} of the height, rows ${top}..${bottom}`);
  await page.evaluate(() => window.framed.dispose());
  Object.assign(ground, { span });
  const closed = await page.evaluate(() => window.check.dispose());
  assert.deepEqual(closed, { disposed: true, aborted: true, errors: [] });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ backend: compat ? 'WebGL2 compatibility' : 'WebGPU', ground, frames }));
  console.log('studio bench passed');
} finally {
  await context.close();
}
