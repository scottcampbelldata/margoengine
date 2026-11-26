// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/sand-footprint.browser.mjs   (MARGO_COMPAT=1 for the WebGL2 compatibility layer)
// KB-TERRAIN-SAND3: the sandSurface ripple clamp took its pixel footprint as distance / 1000 (one pixel of a 1080-line
// frame at 50 degrees), whatever the frame's real size. At 540 lines a pixel is 1.7 times wider than that and at 270
// lines 3.5 times, so 0.1 m ripples 20 to 30 m away stayed on where a pixel no longer resolves them and aliased into
// moire. sand-footprint.html renders flat sand from 20 m up at 960 x 540 and 480 x 270 and once at 3840 x 2160,
// filtered down to each as the reference. Mean sRGB luma error against it stays under 1.4 steps with ripples (on an
// RTX A6000: 1.10 at 540 lines and 0.66 at 270; the distance clamp gave 1.90 and 2.76) and under 0.3 without (0.07
// and 0.12). The clamp now takes the footprint from the position's screen-space derivatives (colors.ts).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/terrain/test/sand-footprint.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const sizes = [
      [960, 540],
      [480, 270],
      [3840, 2160],
    ];
    for (const [w, h] of sizes)
      for (const [suffix, options] of [
        ['', {}],
        ['Off', { sandSurface: false }],
      ]) {
        const name = `${h}${suffix}`;
        assert.deepEqual(await page.evaluate((a) => window.check.show(...a), [name, w, h, options]), [], name);
      }
    const error = (a, b) => page.evaluate((x) => window.check.error(...x), [a, b]),
      result = {};
    for (const h of [540, 270]) result[h] = { on: await error(`${h}`, '2160'), off: await error(`${h}Off`, '2160Off') };
    await mkdir('test-results/terrain-sand-footprint', { recursive: true });
    await writeFile('test-results/terrain-sand-footprint/result.json', JSON.stringify({ hardware, result }, null, 1));
    for (const [name, k] of [
      ['540', 1],
      ['270', 1],
      ['2160', 4],
      ['2160', 8],
    ]) {
      const bin = await page.evaluate((a) => window.check.png(...a), [name, k]);
      await writeFile(`test-results/terrain-sand-footprint/${name}-${k}.png`, Buffer.from(bin, 'latin1'));
    }
    console.log(JSON.stringify(result));
    assert.deepEqual(pageErrors, []);
    for (const h of [540, 270]) {
      const { on, off } = result[h];
      assert.ok(off < 0.3, `${h} lines, plain sand: error ${off.toFixed(2)} against the reference (under 0.3)`);
      assert.ok(on < 1.4, `${h} lines: error ${on.toFixed(2)} against the reference (under 1.4)`);
    }
    console.log(
      `ok terrain sand footprint: 540 lines ${result[540].on.toFixed(2)} (off ${result[540].off.toFixed(2)}), 270 lines ${result[270].on.toFixed(2)} (off ${result[270].off.toFixed(2)})`,
    );
  },
  () => context.close(),
);
watchExit();
