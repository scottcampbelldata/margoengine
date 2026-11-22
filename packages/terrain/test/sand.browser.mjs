// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/sand.browser.mjs   (MARGO_COMPAT=1 for the WebGL2 compatibility layer)
// KB-TERRAIN-SAND2: sand under TerrainColors was smooth mottled colour, so a dune coast read as one flat beige sheet.
// sandSurface (on by default) adds wind ripples, streaks, grainflow and lee/stoss sorting (sand.html: a 10/30 degree
// transverse dune across a +x wind). Checked against sandSurface: false on the same frames: the near ground's luma
// spreads at least 1.5 times as wide (ripples; 1.77 on an RTX A6000); in sRGB luma the lee slip face is at least 3%
// brighter and the windward face at least 2.5% darker (sorting: 10% and 7% in linear albedo; 1.047 and 0.963
// measured); ground 60 to 400 m away shimmers no more than 1.25 times as much pixel to pixel (the
// ripples are clamped out before they alias). On main sandSurface did not exist, so the first two failed there.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/terrain/test/sand.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.setViewportSize({ width: 960, height: 540 });
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const shots = [];
    for (const view of ['near', 'stoss', 'lee', 'far'])
      for (const [suffix, options] of [
        ['', {}],
        ['Off', { sandSurface: false }],
      ])
        shots.push([view + suffix, options, view]);
    for (const shot of shots) assert.deepEqual(await page.evaluate((a) => window.check.show(...a), shot), [], shot[0]);
    // The settings table: the defaults written draw exactly what the plain TerrainColors draws, and writing every live
    // row each frame for 60 frames creates no pipeline, buffer or texture and ends on the frame writing it once draws.
    assert.deepEqual(await page.evaluate((a) => window.check.show(...a), ['written', null, 'near', {}]), [], 'written');
    assert.deepEqual(await page.evaluate((a) => window.check.show(...a), ['plain', null, 'near']), [], 'plain');
    const exact = await page.evaluate(() => window.check.diff('plain', 'written'));
    assert.equal(exact.max, 0, `the defaults written leave the frame exact: ${JSON.stringify(exact)}`);
    const [swept, counts] = await page.evaluate((a) => window.check.show(...a), ['swept', null, 'near', 'sweep']);
    assert.deepEqual(swept, [], 'swept');
    assert.deepEqual(
      counts.after,
      counts.before,
      `60 frames of every live row made GPU objects: ${JSON.stringify(counts)}`,
    );
    const values = await page.evaluate(() => window.check.sweepValues());
    assert.deepEqual(await page.evaluate((a) => window.check.show(...a), ['once', null, 'near', values]), [], 'once');
    const once = await page.evaluate(() => window.check.diff('swept', 'once'));
    assert.equal(once.max, 0, `the sweep's last frame is what writing its values once draws: ${JSON.stringify(once)}`);
    const stats = (name, rect) => page.evaluate((a) => window.check.stats(...a), [name, rect]);
    const near = [0.1, 0.6, 0.9, 1],
      // Where the windward face and the slip face fill their views (below the skyline, above the flat).
      stossFace = [0.3, 0.52, 0.7, 0.66],
      leeFace = [0.3, 0.42, 0.7, 0.68],
      far = [0.1, 0.52, 0.9, 0.62],
      result = {
        near: [await stats('near', near), await stats('nearOff', near)],
        stoss: [await stats('stoss', stossFace), await stats('stossOff', stossFace)],
        lee: [await stats('lee', leeFace), await stats('leeOff', leeFace)],
        far: [await stats('far', far), await stats('farOff', far)],
      };
    result.ripples = result.near[0].deviation / result.near[1].deviation;
    result.leeRatio = result.lee[0].mean / result.lee[1].mean;
    result.stossRatio = result.stoss[0].mean / result.stoss[1].mean;
    result.shimmer = result.far[0].step / result.far[1].step;
    await mkdir('test-results/terrain-sand', { recursive: true });
    for (const [name] of shots) {
      const url = await page.evaluate((n) => window.check.png(n), name);
      await writeFile(`test-results/terrain-sand/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
    await writeFile('test-results/terrain-sand/result.json', JSON.stringify({ hardware, result }, null, 1));
    console.log(JSON.stringify(result));
    assert.deepEqual(pageErrors, []);
    assert.ok(result.near[1].mean > 60, `the sand is lit (${result.near[1].mean})`);
    assert.ok(result.ripples > 1.5, `ripples spread the near luma ${result.ripples.toFixed(2)} times (over 1.5)`);
    assert.ok(result.leeRatio > 1.03, `the lee slip face is paler: x${result.leeRatio.toFixed(3)} (over 1.03)`);
    assert.ok(result.stossRatio < 0.975, `the windward face is darker: x${result.stossRatio.toFixed(3)} (under 0.975)`);
    assert.ok(result.shimmer < 1.25, `far ground shimmer x${result.shimmer.toFixed(2)} (under 1.25)`);
    console.log(
      `ok terrain settings: defaults exact, 60 frames of live rows made no GPU object (${JSON.stringify(counts.after)}).`,
    );
    console.log(
      `ok terrain sand: ripples x${result.ripples.toFixed(2)}, lee x${result.leeRatio.toFixed(3)}, stoss x${result.stossRatio.toFixed(3)}, far shimmer x${result.shimmer.toFixed(2)}`,
    );
  },
  () => context.close(),
);
watchExit();
