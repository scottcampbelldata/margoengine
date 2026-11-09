import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const movie = readFileSync(requireExternalAssets('video/flower.mp4'));
const browser = await openBrowser({
  startPath: '/packages/video/test/codecs-check.html',
  port: 'free',
  plugins: [
    {
      name: 'outside-flower-fixture',
      configureServer(server) {
        server.middlewares.use('/__margo-flower.mp4', (_request, response) => {
          response.setHeader('Content-Type', 'video/mp4');
          response.end(movie);
        });
      },
    },
  ],
});
try {
  await browser.page.waitForFunction(
    () => typeof window.check === 'function' && typeof window.checkReal === 'function',
  );
  const result = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }, null, 2));
  assert.equal(result.frameCount, 6);
  assert.equal(result.duration, 0.6);
  const colours = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
  ];
  const colour = (got, want) =>
    got.slice(0, 3).forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 3, `${got} != ${want}`));
  // AVC quantization and YUV conversion allow 3/255; frame timestamps must be exact.
  for (const row of result.decoded) {
    assert.equal(row.timestamp, row.i * 100000);
    colour(row.pixel, colours[row.i]);
  }
  assert.deepEqual(result.seek, { index: 2, timestamp: 200000 });
  assert.deepEqual(result.step, { index: 3, timestamp: 300000 });
  for (const row of result.rendered) colour(row.pixel, colours[3]);
  assert.equal(result.cancelled, 'AbortError');
  assert.deepEqual(result.errors, []);
  const real = await browser.page.evaluate(() => window.checkReal());
  console.log(JSON.stringify({ hardware: browser.hardware, real }, null, 2));
  assert.equal(real.frames, 150);
  assert.equal(real.independentFrames, 150);
  assert.deepEqual(real.errors, []);
} finally {
  await browser.close();
}
