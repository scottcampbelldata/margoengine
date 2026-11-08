// Real-GPU check of `Sharpen` (@margoengine/taa/sharpen), built packages, on the test/stripes-fixture.js 'sine' scene.
// Takes the GPU lock itself around the browser. Two engines draw the same jittered frames, one with TAA alone and one
// with TAA and `present: new Sharpen({ amount: 1 })`. TAA's history is never sharpened, so both resolve the same frame
// and the plain one is the sharpened one's input: every sharpened pixel must lie inside the range of that pixel and its
// four neighbours in the plain frame (no halo, no clipping), the stripes must gain contrast (their spread about the row
// mean grows, as values move toward the stripe's own extremes) and a row's mean must stay.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'taa-sharpen' });
const timer = setTimeout(() => {
  console.error('sharpen-browser: timed out after 150 s');
  process.exit(1);
}, 150_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-sharpen/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5376, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5376 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 300 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5376/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { rig } = await import('/packages/taa/test/stripes-fixture.js');
    const { Sharpen } = await import('/packages/taa/dist/sharpen.js');
    document.querySelector('canvas').remove();
    const rigs = {
      plain: await rig('plain', { pattern: 'sine' }),
      sharp: await rig('sharp', { pattern: 'sine', taa: { present: new Sharpen({ amount: 1 }) } }),
    };
    window.t = {
      gpuErrors: () => Object.values(rigs).flatMap((r) => r.gpuErrors),
      frames: (n) => Promise.all(Object.values(rigs).map((r) => r.frames(n))),
    };
  });
  await page.evaluate(() => window.t.frames(24));
  const plain = await decodePNG(await page.locator('#plain').screenshot()),
    sharp = await decodePNG(await page.locator('#sharp').screenshot());
  const at = (image, x, y) => image.data[(y * image.width + x) * 4];
  let outside = 0,
    worst = 0;
  const rows = { plain: { spread: 0, mean: 0 }, sharp: { spread: 0, mean: 0 } };
  for (let y = 40; y < 200; y++) {
    for (let x = 1; x < plain.width - 1; x++) {
      const near = [at(plain, x, y), at(plain, x - 1, y), at(plain, x + 1, y), at(plain, x, y - 1), at(plain, x, y + 1)],
        v = at(sharp, x, y),
        over = Math.max(Math.min(...near) - v, v - Math.max(...near), 0);
      worst = Math.max(worst, over);
      // One sRGB level of rounding between the two canvases' 8-bit writes.
      if (over > 1) outside++;
    }
    for (const [name, image] of [
      ['plain', plain],
      ['sharp', sharp],
    ]) {
      let sum = 0,
        squares = 0;
      for (let x = 40; x < 280; x++) {
        const v = at(image, x, y);
        sum += v;
        squares += v * v;
      }
      const mean = sum / 240;
      rows[name].spread += Math.sqrt(squares / 240 - mean * mean) / 160;
      rows[name].mean += mean / 160;
    }
  }
  // The same sharpen on the CPU over the plain frame (./src/cas.ts in linear light), against what the GPU showed.
  const linear = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
    srgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  let miss = 0,
    moved = 0;
  for (let y = 40; y < 200; y++)
    for (let x = 1; x < plain.width - 1; x++) {
      const c = linear(at(plain, x, y)),
        near = [at(plain, x - 1, y), at(plain, x + 1, y), at(plain, x, y - 1), at(plain, x, y + 1)].map(linear),
        lo = Math.min(c, ...near),
        hi = Math.max(c, ...near),
        k = -0.2 * Math.min(Math.max(Math.min(lo, 1 - hi) / Math.max(hi, 0.0001), 0), 1),
        expected = srgb(Math.min(Math.max((c + k * near.reduce((a, b) => a + b)) / (1 + 4 * k), lo), hi));
      miss = Math.max(miss, Math.abs(expected - at(sharp, x, y)));
      if (at(sharp, x, y) !== at(plain, x, y)) moved++;
    }
  console.log('stripes in sRGB levels', rows, { outside, worst, miss, moved });
  // Bounds from the maths: the result is clamped to the 5-tap min/max of the resolved frame, which the plain canvas
  // shows (same jitter, unsharpened history), so the darkest and brightest stripe values cannot grow, only the values
  // between them move outward; a symmetric unsharp mask on a sine keeps its mean but for the clamp, a level or two.
  assert.equal(outside, 0, `every sharpened pixel stays inside its 4-neighbour range (worst ${worst} levels)`);
  assert.ok(
    rows.sharp.spread > rows.plain.spread,
    `the stripes gain contrast (spread ${rows.plain.spread.toFixed(1)} -> ${rows.sharp.spread.toFixed(1)} levels)`,
  );
  assert.ok(Math.abs(rows.sharp.mean - rows.plain.mean) < 2, 'a row keeps its mean');
  // The CPU reference reads the plain frame rounded to 8 bits (half a level per tap) and the GPU's output is rounded too.
  // On these stripes room <= 0.334 (worst of 0.4 + 0.38 sin over 3 taps a pixel apart), so |k| <= 0.067 and the input
  // error grows by at most (1 + 4|k|) / (1 + 4k) = 1.73: 0.87 + 0.5 = 1.37 levels. M6 Mac mini, Metal: 0.90.
  assert.ok(miss <= 1.4, `the GPU matches the CPU sharpen within 1.4 levels (${miss.toFixed(2)})`);
  assert.ok(moved > 1000, `the sharpen changes the frame (${moved} pixels)`);
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors()), []);
  assert.deepEqual(errors, []);
  console.log('sharpen check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
