// Real-GPU proof (run from the repository root after building packages; --compat or MARGO_COMPAT=1 for the WebGL2
// compatibility layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/procedural/test/forbs-browser.mjs
// Plants round 1 (2026-11-28, "Above the Treeline"): the alpine meadow had no wildflowers. Each forb draws as one
// Scatter per part with one seed, placement, reach and sway height:
// 1. Every part of every species compiles and draws with no validation error, and the parts keep the same instances
//    (equal ring counts), also inside clumps and around a clearing.
// 2. The measured colours show: a field of arnica has yellow pixels, gentian blue ones and campion pink ones.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/procedural/test/forbs.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const share = (image, test) => {
  let n = 0;
  for (let p = 0; p < image.data.length; p += 4) if (test(image.data[p], image.data[p + 1], image.data[p + 2])) n++;
  return n / (image.width * image.height);
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    await mkdir('test-results', { recursive: true });
    const results = {};
    for (const species of ['arnica', 'gentian', 'aster', 'bistort', 'campion']) {
      for (const options of [
        undefined,
        { clumps: { size: 0.8, cover: 0.45 }, clearings: [{ center: [0, 0], radius: 0.3, falloff: 0.3 }] },
      ]) {
        const { parts, counts, errors } = await page.evaluate(([s, o]) => window.check.make(s, o), [species, options]);
        assert.deepEqual(errors, [], species);
        assert.ok(parts.length >= 2, `${species}: ${parts}`);
        for (const c of counts) assert.deepEqual(c, counts[0], `${species} parts keep the same instances: ${JSON.stringify(counts)}`);
        assert.ok(counts[0].reduce((a, b) => a + b) > 20, `${species}: ${counts[0]} instances`);
        if (options) continue;
        const png = await page.locator('canvas').screenshot();
        await writeFile(`test-results/forbs-${species}${hardware.compat ? '-compat' : ''}.png`, png);
        const image = await decodePNG(png);
        results[species] = {
          instances: counts[0],
          yellow: share(image, (r, g, b) => r > 150 && g > 70 && b < 0.45 * g && r > 1.4 * g),
          blue: share(image, (r, g, b) => b > 1.3 * r && b > 1.15 * g && b > 40),
          pink: share(image, (r, g, b) => r > 1.25 * g && b > 1.1 * g && r > 90),
        };
      }
    }
    assert.ok(results.arnica.yellow > 0.002, `arnica yellow ${JSON.stringify(results.arnica)}`);
    assert.ok(results.gentian.blue > 0.002, `gentian blue ${JSON.stringify(results.gentian)}`);
    assert.ok(results.campion.pink > 0.002, `campion pink ${JSON.stringify(results.campion)}`);
    assert.ok(results.bistort.yellow < 0.001, 'bistort has no yellow');
    assert.deepEqual(pageErrors, []);
    console.log('ok procedural forbs', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
