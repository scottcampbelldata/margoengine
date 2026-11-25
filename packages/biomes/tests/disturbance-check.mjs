// Real-GPU proof of BiomeView `disturbance` (run from the repository root after building packages):
//   node packages/biomes/tests/disturbance-check.mjs        (WebGPU)
//   MARGO_COMPAT=1 node packages/biomes/tests/disturbance-check.mjs        (the WebGL2 compatibility layer)
// A history that burnt the west half of the world in its last year draws the west plants burnt by itself; the east half,
// untouched in the history, is drawn as the same view without a history draws it.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/disturbance-check.html', port: 'free' }),
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
    await writeFile('test-results/biomes-disturbance-check.json', JSON.stringify({ hardware, result: r }, null, 1));
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(r.plainStates, true, 'a view without a history makes no map');
    assert.equal(r.hasStates, true, 'a view with a history makes its plant state map');
    assert.ok(r.objects > 1000, `objects streamed: ${r.objects}`);
    // The untouched east half draws as before; the burnt west half loses its green and its light.
    assert.ok(
      Math.abs(r.eastBurnt.green - r.eastPlain.green) < 0.01,
      `east green ${JSON.stringify([r.eastPlain, r.eastBurnt])}`,
    );
    assert.ok(
      Math.abs(r.eastBurnt.luma / r.eastPlain.luma - 1) < 0.03,
      `east luma ${JSON.stringify([r.eastPlain, r.eastBurnt])}`,
    );
    assert.ok(r.westBurnt.green < r.westPlain.green - 0.01, `west green ${JSON.stringify([r.westPlain, r.westBurnt])}`);
    assert.ok(r.westBurnt.luma < r.westPlain.luma * 0.99, `west luma ${JSON.stringify([r.westPlain, r.westBurnt])}`);
    console.log(
      'ok biomes disturbance:',
      JSON.stringify({ west: [r.westPlain, r.westBurnt], east: [r.eastPlain, r.eastBurnt] }),
    );
  },
  () => context.close(),
);
watchExit();
