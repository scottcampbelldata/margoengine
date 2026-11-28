// Real-GPU check (run from the repository root after building packages; MARGO_COMPAT=1 runs it on the WebGL2 layer):
//   node packages/terrain/test/teeth.browser.mjs
// The clipmap's cell diagonals on a crest (teeth.html). Every cell used to be split along the same diagonal, so a
// crest running along the other one was drawn as a row of triangular teeth: the cells across it dropped to the flank
// between each pair of crest corners (Above the Treeline look round 9, the near ridge of the alpine shot;
// KB-TERRAIN-CRESTTEETH1). Each cell now splits along the diagonal whose mean height is nearer the Catmull-Rom height
// at its centre, so the crest is a straight line again. Here the total variation of the ridge's silhouette over the
// middle half of the frame stays under 120 pixels; with the old fixed split patched back in it is over 600, so the scene
// still draws the teeth.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/terrain/test/teeth.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const chosen = await page.evaluate(() => window.check.show(false));
    if (process.env.TEETH_PNG) (await import('node:fs')).writeFileSync(process.env.TEETH_PNG + '-chosen.png', Buffer.from((await page.evaluate(() => window.lastPng)).split(',')[1], 'base64'));
    const fixed = await page.evaluate(() => window.check.show(true));
    if (process.env.TEETH_PNG) (await import('node:fs')).writeFileSync(process.env.TEETH_PNG + '-fixed.png', Buffer.from((await page.evaluate(() => window.lastPng)).split(',')[1], 'base64'));
    console.log(JSON.stringify({ chosen, fixed }));
    assert.deepEqual(chosen.errors, []);
    assert.deepEqual(fixed.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(fixed.patched, 'the fixed split replaced the diagonal choice');
    for (const r of [chosen, fixed]) assert.equal(r.columns, 640, 'the crest spans the middle half of the frame');
    assert.ok(fixed.variation > 600, `the old fixed split draws teeth (silhouette variation ${fixed.variation} px)`);
    assert.ok(chosen.variation < 120, `the crest has no teeth (silhouette variation ${chosen.variation} px, under 120)`);
    console.log(`ok terrain crest teeth: silhouette variation ${chosen.variation} px, fixed split ${fixed.variation} px`);
  },
  () => context.close(),
);
watchExit();
