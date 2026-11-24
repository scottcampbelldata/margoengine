// Real-GPU bound of GAP-FILM-TIME for TAA (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/taa/test/seek-check.mjs
// The jitter phase is a clock (a seek replays it); the history is view history (class C in docs/limits.md): a cut
// starts it empty and the scene's prewarm settles it. A draws n + 1 live frames of moving boxes; B seeks (n - P) / fps
// and draws P + 1 (P = 53, ln 255 / ln(1 / 0.9) rounded up); C draws P + 1 with no seek. A and B must share the jitter
// phase and their resolved LDR frames must differ by at most 1 level of 255 in every channel.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5393/packages/taa/test/seek-check.html',
  context = await openBrowser({ startPath: '/packages/taa/test/seek-check.html', port: 5393 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  for (const n of [600, 1805]) {
    await page.goto(url);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const r = await page.evaluate((steps) => window.check.run(steps), n);
    assert.deepEqual(r.errors, [], `GPU errors at n = ${n}`);
    assert.deepEqual(r.zero, [0, 0, 0], 'warm-up frames move no clock');
    assert.equal(r.steps, n - 53);
    assert.ok(r.clocks.includes(r.name) && !r.unseekable.includes(r.name), `TAA is replayed: ${JSON.stringify(r)}`);
    assert.equal(r.sampleB, r.sampleA, 'the jitter phase after the seek is the continuous run');
    assert.ok(r.peak <= 1, `the fixture stays LDR: peak ${r.peak}`);
    assert.ok(r.gap <= 1 / 255, `after 53 prewarm frames the resolved frames differ by ${(r.gap * 255).toFixed(3)} levels`);
    console.log(
      `ok taa seek n = ${n}: phase ${r.sampleA} equal, gap ${(r.gap * 255).toFixed(3)} levels after 53 frames (no seek: phase ${r.sampleC}, gap ${(r.fresh * 255).toFixed(3)}), peak ${r.peak.toFixed(3)}`,
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('taa seek check passed');
} finally {
  await context.close();
}
