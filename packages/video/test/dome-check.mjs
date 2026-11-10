import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/video/test/dome-check.html', port: 'free' });
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const result = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.results.length, 12);
  for (const row of result.results) {
    const front = row.layout !== 'mono' && row.eye === 'right' ? [255, 255, 255] : [255, 0, 0];
    const expected = { front, left: [255, 255, 0], right: [0, 255, 0], up: [255, 0, 255], down: [0, 255, 255] };
    if (row.angle === 180) expected.back = [0, 0, 0];
    for (const [axis, want] of Object.entries(expected))
      row.pixels[axis].forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 2, JSON.stringify({ row, axis, want })));
  }
} finally {
  await browser.close();
}
