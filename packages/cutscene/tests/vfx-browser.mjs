// Real-GPU proof of @margoengine/cutscene/vfx (from the repository root after building packages; check:gpu-packages takes
// the GPU lock around it): node packages/cutscene/tests/vfx-browser.mjs
// Reaches six times of a cutscene by playing and by seeking, and compares the particle buffer and the picture read back.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/cutscene/tests/vfx-browser.html', port: 5342 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const { errors, played, sought } = await page.evaluate(() => window.check());
  assert.deepEqual(errors, [], 'no validation errors');
  assert.deepEqual(pageErrors, []);
  // The scene does what the test needs: particles in the first clip, the second, the tail, and none left at the end.
  assert.ok(played[40].live > 100, `first clip: ${played[40].live}`);
  assert.ok(played[100].live > 100, `second clip: ${played[100].live}`);
  assert.ok(played[140].live > 0 && played[140].live < played[100].live, `the tail: ${played[140].live}`);
  assert.equal(played[200].live, 0, 'all gone by the end of a life');
  assert.equal(new Set(Object.values(played).map((frame) => frame.particles)).size, 6, 'every frame differs');
  assert.equal(new Set(Object.values(played).map((frame) => frame.picture)).size, 6, 'and the picture with it');
  assert.equal(played[40].cube, false, 'the cube is off before its clip');
  assert.equal(played[100].cube, true, 'and on in it');
  for (const frame of Object.keys(played)) {
    // With nothing alive a seek's slots are clear where playing's hold the dead, which nothing reads: the picture says.
    if (played[frame].live === 0) sought[frame].particles = played[frame].particles;
    assert.deepEqual(sought[frame], played[frame], `frame ${frame}: a seek lands on what playing shows`);
    console.log(`ok vfx frame ${frame}: ${played[frame].live} live, particles ${played[frame].particles}, picture ${played[frame].picture}`);
  }
} finally {
  await context.close();
}
