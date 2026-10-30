// Real-GPU proof of B6 (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/objects-check.mjs
// The zero-configuration biome world draws trees, shrubs, rocks and grass over its terrain, lit and varied.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/objects-check.html', port: 'free' }),
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
    await writeFile('test-results/biomes-objects-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(r.objects > 10000, `objects streamed: ${r.objects}`);
    assert.equal(r.held.error, null, `holding ${r.held.far} tiles of trees and ${r.held.near} of small plants`);
    // The places that meet the most tiles (more than the 100 and 25 slots the objects had).
    assert.ok(r.held.far > 98 && r.held.near > 25, `tiles held: ${JSON.stringify(r.held)}`);
    // Objects cover a good share of the frame and add contrast (lit crowns, shadowed sides, trunks).
    assert.ok(r.changed > 0.1, `share of pixels the objects change: ${r.changed}`);
    assert.ok(r.full.sd > 0.015 && r.full.mean > 0.01, `lit and varied: ${JSON.stringify(r.full)}`);
    assert.ok(Math.abs(r.afterDispose.mean - r.full.mean) > 1e-3, 'a disposed view draws nothing');
    console.log(
      'ok biomes objects:',
      r.objects,
      'objects,',
      (r.bytes / 1048576).toFixed(1),
      'MB on the GPU, changed',
      r.changed.toFixed(3),
      'luma',
      r.full.mean.toFixed(3),
      r.full.sd.toFixed(3),
    );
    // Biome look round 2 (landing D): leaves shade as clusters and every tree has its own tint. Before it each canopy
    // was one smooth mesh in one colour (objects-look.html). Measured on the RTX A6000 (about 100 green trees, with the
    // round 1 palette): median tree luma texture 0.056 before and 0.069 after, hue spread over the trees 0.0044 before
    // and 0.027 after (about 6 times). A whole tree's luma standard deviation was 0.10 before already (lit and shaded
    // sides), so the texture takes out each pixel's 7x7 local mean. Limits: texture above 0.062 (between the two),
    // spread above three times 0.0044.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(new URL('/packages/biomes/tests/objects-look.html', page.url()).href);
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const look = await page.evaluate(() => window.check.run()),
      green = look.trees.filter((t) => t.hue > 0.15 && t.hue < 0.5),
      middle = (list) => [...list].sort((a, b) => a - b)[list.length >> 1],
      texture = middle(green.map((t) => t.texture)),
      mean = green.reduce((a, t) => a + t.hue, 0) / green.length,
      spread = Math.sqrt(green.reduce((a, t) => a + (t.hue - mean) ** 2, 0) / green.length);
    await writeFile('test-results/biomes-objects-look.json', JSON.stringify({ hardware, look }, null, 1));
    assert.equal(look.validation, null);
    assert.deepEqual(look.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(green.length >= 40, `green trees measured: ${green.length} of ${look.trees.length}`);
    assert.ok(texture > 0.062, `median tree luma texture ${texture.toFixed(4)}: the canopy shades as one smooth blob`);
    assert.ok(spread > 3 * 0.0044, `hue spread over the trees ${spread.toFixed(4)}: the trees share one colour`);
    console.log(
      'ok biomes objects look:',
      green.length,
      'trees, luma texture',
      texture.toFixed(4),
      'hue spread',
      spread.toFixed(4),
    );
  },
  () => context.close(),
);
// A suite still alive after its last step names what it left open (biomes test:gpu once sat until killed at 600 s).
watchExit();
