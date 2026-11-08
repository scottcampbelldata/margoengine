import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/video/test/material-check.html', port: 'free' });
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const { results, fallback } = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, results, fallback }, null, 2));
  for (const result of results) {
    assert.deepEqual(result.errors, []);
    for (const [actual, expected] of [
      [result.initial, [128, 64, 32]],
      [result.updated, [20, 200, 50]],
      [result.htmlFirst, [128, 64, 32]],
      [result.htmlNext, [20, 200, 50]],
    ])
      actual
        .slice(0, 3)
        .forEach((v, i) =>
          assert.ok(Math.abs(v - expected[i]) <= 2, `sRGB channel ${i}: ${v}, expected ${expected[i]}`),
        );
    assert.ok(result.imports >= 2);
    assert.equal(result.frameCopies, 0, 'no material-path pixel uploads after initialization');
    assert.equal(result.shaders.length, 9);
    assert.deepEqual(result.orientation.top.slice(0, 3), [255, 0, 0]);
    assert.deepEqual(result.orientation.bottom.slice(0, 3), [0, 255, 0]);
    assert.deepEqual(result.orientation.unflippedTop.slice(0, 3), [0, 255, 0]);
  }
  assert.deepEqual(
    results.map((r) => r.samples),
    [1, 4],
  );
  assert.equal(fallback.code, 'unsupported');
  assert.match(fallback.message, /https:\/\/margoengine.com\/errors#/);
} finally {
  await browser.close();
}
