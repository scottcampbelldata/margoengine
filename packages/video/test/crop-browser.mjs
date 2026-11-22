// KB-VIDEO-CROP1 on a GPU: a 64 x 8 picture, left half red and right half blue, drawn over a 64 x 32 canvas. With
// `source: [0, 0, 0.5, 1]` the whole canvas reads red (the old Video squeezed both halves in); after setRect and
// setSource to the right halves, the right half of the canvas reads blue and the left half keeps the background.
// Columns within one texel of the crop's edge blend by linear filtering and are not counted.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
const colour = (png, x, y) => [...png.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
const is = (c, want) => c.every((v, i) => Math.abs(v - want[i]) <= 3);
try {
  await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Video } = await import('/packages/video/dist/index.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    document.body.replaceChildren();
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [64, 32] });
    engine.stop();
    const pixels = new OffscreenCanvas(64, 8),
      drawing = pixels.getContext('2d');
    drawing.fillStyle = '#ff0000';
    drawing.fillRect(0, 0, 32, 8);
    drawing.fillStyle = '#0000ff';
    drawing.fillRect(32, 0, 32, 8);
    const frame = new VideoFrame(pixels, { timestamp: 0 });
    const video = Video.attach(engine, frame, { source: [0, 0, 0.5, 1] });
    engine.gpu.pushErrorScope('validation');
    await waitForPipelines(async () => {
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
    });
    window.crop = { engine, video, frame };
  });
  const left = await shot();
  let red = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 62; x++) red += is(colour(left, x, y), [255, 0, 0]);
  assert.equal(red, 62 * 32, `the left half of the picture fills the canvas (${red} red of ${62 * 32})`);
  const background = colour(left, 0, 0);
  await page.evaluate(async () => {
    const { engine, video } = window.crop;
    const plain = engine.scene.background;
    video.setRect([0.5, 0, 0.5, 1]);
    video.setSource([0.5, 0, 0.5, 1]);
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    window.crop.plain = plain;
  });
  const right = await shot();
  let blue = 0,
    untouched = 0;
  for (let y = 0; y < 32; y++) {
    for (let x = 34; x < 64; x++) blue += is(colour(right, x, y), [0, 0, 255]);
    for (let x = 0; x < 32; x++)
      untouched += !is(colour(right, x, y), [255, 0, 0]) && !is(colour(right, x, y), [0, 0, 255]);
  }
  assert.equal(blue, 30 * 32, `the right half of the picture fills the right half (${blue} of ${30 * 32})`);
  assert.equal(untouched, 32 * 32, 'the left half keeps the background');
  const error = await page.evaluate(async () => {
    const e = await window.crop.engine.gpu.popErrorScope();
    window.crop.video.dispose();
    window.crop.frame.close();
    return e?.message ?? null;
  });
  assert.equal(error, null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ hardware: browser.hardware, red, blue, untouched, background }));
} finally {
  await browser.close();
}
