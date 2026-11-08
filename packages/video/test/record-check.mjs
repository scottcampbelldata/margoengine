import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/video/test/record-check.html', port: 'free' });
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const results = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, results }, null, 2));
  assert.equal(results.length, 4);
  for (const r of results) {
    if (r.unsupported) {
      assert.equal(r.unsupported, 'unsupported');
      continue;
    }
    assert.ok(r.bytes > 0);
    assert.match(r.type, new RegExp('^video/' + r.format));
    assert.equal(r.width, 64);
    assert.equal(r.height, 64);
    assert.ok(r.audioSeconds > 0.5);
    assert.ok(r.rms > 0.1, 'recorded tone is audible');
    assert.ok(Math.abs(r.hz - 440) < 5, 'recorded audio retains tone pitch');
    assert.equal(r.callerAudio, 'live');
    for (const [i, value] of [51, 102, 153].entries()) assert.ok(Math.abs(r.pixel[i] - value) <= 4, JSON.stringify(r));
  }
  for (const backend of ['webgpu', 'webgl2']) assert.ok(results.some((r) => r.backend === backend && !r.unsupported));
} finally {
  await browser.close();
}
