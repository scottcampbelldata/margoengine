import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/video/test/frames-check.html', port: 'free' });
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const result = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }));
  assert.deepEqual(result.errors, []);
  const colours = [
    [128, 64, 32],
    [20, 200, 50],
    [240, 240, 10],
  ];
  const near = (actual, expected, what) =>
    expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) <= 2, `${what}: ${actual}, expected ${expected}`));
  assert.equal(result.frames.length, 4);
  for (const { k, top, bottom } of result.frames) {
    near(top, colours[k], `frame ${k} top`);
    near(bottom, [0, 0, 0], `frame ${k} bottom`);
  }
  near(result.unflipped.top, [0, 0, 0], 'unflipped top');
  near(result.unflipped.bottom, colours[0], 'unflipped bottom');
  assert.equal(result.shaders.length, 8);
  near(result.glow, colours[1], 'emissive screen');
} finally {
  await browser.close();
}
