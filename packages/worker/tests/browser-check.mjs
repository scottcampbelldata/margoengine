// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/worker/tests/browser-check.mjs
// A real Worker runs core on a transferred canvas: it sizes to the page's canvas, draws pixels the page shows, picks in
// CSS pixels, follows forwarded input through a control package, and neither thread stops the other.
// Results: test-results/worker-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/worker/tests/browser-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const ask = (command, value) => page.evaluate(([c, v]) => window.check.ask(c, v), [command, value]);
const until = async (test, what) => {
  for (let i = 0; i < 300; i++) {
    const state = await ask('state');
    if (test(state)) return state;
    await page.waitForTimeout(20);
  }
  throw new Error(`worker never reached: ${what}: ${JSON.stringify(await ask('state'))}`);
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const result = { supported: await page.evaluate(() => window.check.supported) };
  assert.equal(result.supported, true);

  const ratio = await page.evaluate(() => devicePixelRatio);
  result.first = await until((s) => s.frames > 3, 'three frames');
  assert.equal(result.first.backend, 'webgpu', 'the worker has WebGPU');
  assert.equal(result.first.hasDocument, false, 'this really is a worker');
  assert.equal(result.first.ratio, ratio);
  assert.equal(result.first.stage, true, 'the stage facade wraps an engine in a worker');
  assert.equal(result.first.clientWidth, 320);
  assert.equal(result.first.width, Math.round(320 * Math.min(ratio, 1)), 'core sized the drawing buffer from CSS size');

  result.pixels = await ask('pixels');
  assert.ok(result.pixels.centre[0] > 60 && result.pixels.centre[0] > result.pixels.centre[2] * 2, 'the red box drew');
  assert.notDeepEqual(result.pixels.centre, result.pixels.corner);

  // What the worker drew reaches the page's canvas.
  const shot = (await page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 200 } })).toString('base64');
  result.shown = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const flat = new OffscreenCanvas(image.width, image.height).getContext('2d');
    flat.drawImage(image, 0, 0);
    return [...flat.getImageData(image.width >> 1, image.height >> 1, 1, 1).data];
  }, shot);
  assert.ok(result.shown[0] > 60 && result.shown[0] > result.shown[2] * 2, 'the page shows the box');

  result.pickCentre = await ask('pick', [160, 100]);
  result.pickCorner = await ask('pick', [2, 2]);
  assert.equal(result.pickCentre, 0, 'pick takes CSS pixels at the centre');
  assert.equal(result.pickCorner, null);

  await page.evaluate(() => window.check.resize(400, 300));
  result.resized = await until((s) => s.clientWidth === 400, 'the new size');
  await until((s) => s.width === Math.round(400 * Math.min(ratio, 1)), 'a drawing buffer of the new size');

  // A drag on the page moves the camera in the worker, and goes on outside the canvas (the page captures the pointer).
  const before = (await ask('state')).camera;
  assert.equal((await ask('state')).touchAction, 'none', 'the control package set touch-action');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('gpu')).touchAction), 'none');
  await page.mouse.move(200, 150);
  await page.mouse.down();
  await page.mouse.move(260, 150, { steps: 4 });
  await page.mouse.move(600, 150, { steps: 4 });
  await page.mouse.up();
  result.dragged = await until((s) => s.camera[0] !== before[0], 'the camera to orbit');

  // The wheel zooms and the page does not scroll, because a worker listener wants it.
  const distance = (camera) => Math.hypot(...camera),
    orbit = (await until((s) => s.frames > 0, 'a frame')).camera;
  await page.mouse.move(200, 150);
  await page.mouse.wheel(0, 400);
  result.zoomed = await until((s) => Math.abs(distance(s.camera) - distance(orbit)) > 1e-3, 'the wheel to zoom');
  assert.equal(await page.evaluate(() => scrollY), 0, 'the page stayed put');

  result.pageTicks = await page.evaluate(() => window.check.pageWhileWorkerBlocks(400));
  result.workerFrames = await page.evaluate(() => window.check.workerWhilePageBlocks(400));
  assert.ok(result.pageTicks >= 10, `the page ran while the worker was stuck: ${result.pageTicks} ticks`);
  assert.ok(result.workerFrames >= 5, `the worker drew while the page was stuck: ${result.workerFrames} frames`);

  result.webgl2 = await page.evaluate(() => window.check.webgl2());
  assert.equal(result.webgl2.backend, 'webgl2', 'the fallback runs in a worker too');

  result.closed = await page.evaluate(() => window.check.close());
  assert.equal(result.closed, true, 'page dispose reached the engine');
  assert.equal(result.first.error, undefined);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/worker-browser.json', JSON.stringify({ hardware, result }, null, 1));
  console.log('ok worker:', result.pageTicks, 'page ticks,', result.workerFrames, 'worker frames while the other blocked');
} finally {
  await context.close();
}
