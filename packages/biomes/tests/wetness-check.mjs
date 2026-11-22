// Real-GPU proof of BiomeView `wetness` (run from the repository root after building packages):
//   node packages/biomes/tests/wetness-check.mjs        (WebGPU)
//   MARGO_COMPAT=1 node packages/biomes/tests/wetness-check.mjs        (the WebGL2 compatibility layer)
// A wetting record with the west half of the world flooded 2 m deep just now draws the west ground darker and the west
// plants mud coated by itself; the east half, never wet, is drawn as the same view without a record draws it.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/wetness-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-wetness-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    console.log('biomes wetness:', JSON.stringify({ plain: r.plain, wet: r.wet, ground: r.ground }));
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(r.plainWet, true, 'a view without a record makes no wet ground and no plant map');
    assert.equal(r.hasWet, true, 'a view with a record makes its wet ground and its plant state map');
    assert.ok(r.objects > 1000, `objects streamed: ${r.objects}`);
    // The never-wet east half draws as before, with and without the plants' flood.
    for (const k of ['wet', 'ground'])
      assert.ok(
        Math.abs(r[k].east.luma / r.plain.east.luma - 1) < 0.03,
        `east luma ${k} ${JSON.stringify([r.plain.east, r[k].east])}`,
      );
    // The flooded west half: the ground alone darkens it, and the mud-coated plants darken it further.
    assert.ok(
      r.ground.west.luma < r.plain.west.luma * 0.95,
      `west ground ${JSON.stringify([r.plain.west, r.ground.west])}`,
    );
    assert.ok(
      r.wet.west.luma < r.ground.west.luma * 0.99,
      `west plants ${JSON.stringify([r.ground.west, r.wet.west])}`,
    );
    console.log('ok biomes wetness');
  },
  () => context.close(),
);
watchExit();
