// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/water-check.mjs
// Biome look plan item 5: the wetland preset world runs down to a sea floor 40 m below sea level on its west side, and
// main drew no water there (shot 06: a dark shelf to the horizon). The default view (`water: 'auto'`) now draws the sea:
// looking west from the shore, over 10 percent of the lower third of the frame is water (blue over red). With
// `water: false` the same view shows the bare sea floor, under 10 percent.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/water-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.equal(r.auto.water, true, "water: 'auto' finds the sea below the wetland's west coast");
    assert.equal(r.off.water, false);
    assert.ok(r.auto.share > 0.1, `water in the lower third: ${r.auto.share}`);
    assert.ok(r.off.share < 0.1, `without water the sea floor shows: ${r.off.share}`);
    assert.deepEqual(pageErrors, []);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-water-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    console.log('ok biomes water: lower third water', r.auto.share.toFixed(3), 'without', r.off.share.toFixed(3));
  },
  () => context.close(),
);
watchExit();
