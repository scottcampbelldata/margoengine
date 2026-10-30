// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/browser-check.mjs
// A biome world draws as terrain with its ground layer (temperate grass), painting the desert biome turns the painted
// ground to the desert's sand, clearing the paint brings the grass back, a disposed view leaves no terrain, and with all
// 8 presets (15 ground materials) painted desert is still sand.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/browser-check.html', port: 'free' }),
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
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.materials.slice(0, 3), ['grass', 'leaf-litter', 'rock']);
    const [br, bg, bb] = r.before,
      [ar, ag, ab] = r.after;
    // Grass is green-dominant; the desert's sand is red over blue and much brighter.
    assert.ok(bg > br && bg > bb, `grass before painting: ${r.before}`);
    assert.ok(ar > ag * 0.95 && ar > ab * 1.3, `sand after painting: ${r.after}`);
    assert.ok(ar + ag + ab > (br + bg + bb) * 1.5, `sand is brighter than grass: ${r.after} vs ${r.before}`);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(r.cleared[c] - r.before[c]) < 1e-3, `cleared paint: ${r.cleared} vs ${r.before}`);
    assert.ok(
      r.afterDispose.every((v, c) => Math.abs(v - r.before[c]) > 1e-3),
      'a disposed view draws no terrain',
    );
    // All 8 presets (15 materials, 4 weight textures): painted desert ground is sand, red over green (main: grass).
    assert.equal(r.allMaterials.length, 15);
    const [dr, dg, db] = r.allDesert;
    assert.ok(dr > dg && dr > db * 1.3, `desert ground with all 8 presets is sand: ${r.allDesert}`);
    assert.deepEqual(pageErrors, []);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-browser-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    console.log(
      'ok biomes view: grass',
      r.before.map((v) => v.toFixed(3)),
      'painted sand',
      r.after.map((v) => v.toFixed(3)),
      'all presets desert',
      r.allDesert.map((v) => v.toFixed(3)),
    );
  },
  () => context.close(),
);
// A suite still alive after its last step names what it left open (biomes test:gpu once sat until killed at 600 s).
watchExit();
