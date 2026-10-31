// Real-GPU regression test for bug A3 (the Preetham sky showed visible colour bands), run from the repository root after
// building packages, one GPU job at a time:   node packages/sky/test/dither-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/sky/test/dither-check.html', port: 5211 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  // Banding (bug A3): the sky written straight to the 8-bit canvas used to step one level per channel every 6 to 8 rows,
  // and the three staircases beat into bands. The canvas must now be dithered (few rows equal to the row above, no long
  // flat run) while its band means stay on the exact display gradient read from the HDR scene (no brightness shift).
  {
    const ROWS = 700, // rows above the horizon (the camera looks 20 degrees up), where the gradient keeps changing
      measured = {};
    for (const mode of ['canvas', 'hdr']) {
      await page.goto(`http://127.0.0.1:5211/packages/sky/test/dither-check.html?mode=${mode}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await page.evaluate(() => window.check.run());
      assert.deepEqual(r.errors, [], `dither ${mode}`);
      measured[mode] = r.columns;
    }
    let same = 0,
      pairs = 0,
      longest = 0;
    const bias = [0, 0, 0],
      bandCount = Math.floor(ROWS / 32);
    for (let c = 0; c < measured.canvas.length; c++) {
      const col = measured.canvas[c];
      let run = 1;
      for (let y = 1; y < ROWS; y++) {
        pairs++;
        if (col[y].every((v, k) => v === col[y - 1][k])) {
          same++;
          run++;
          longest = Math.max(longest, run);
        } else run = 1;
      }
      for (let b = 0; b < bandCount; b++)
        for (let k = 0; k < 3; k++) {
          let a = 0,
            t = 0;
          for (let y = b * 32; y < b * 32 + 32; y++) {
            a += col[y][k];
            t += measured.hdr[c][y][k];
          }
          bias[k] = Math.max(bias[k], Math.abs(a - t) / 32);
        }
    }
    const share = same / pairs;
    report.results.dither = { share, longest, bias: bias.map((v) => v * 255) };
    // Measured on main before the dither: share 0.741, longest run 17 rows; dithered 0.286 and 13.
    assert.ok(share < 0.4, `rows equal to the row above ${share.toFixed(3)}, undithered 0.741`);
    assert.ok(longest <= 15, `longest flat run ${longest} rows, undithered 17`);
    // One band of 32 rows averages the triangular noise to well under 0.5 / 255, per column and channel.
    for (let k = 0; k < 3; k++)
      assert.ok(bias[k] * 255 <= 0.5, `band mean off by ${(bias[k] * 255).toFixed(2)} / 255, channel ${k}`);
    console.log(
      'ok sky dither: equal-to-above',
      share.toFixed(3),
      'longest run',
      longest,
      'band bias /255',
      bias.map((v) => (v * 255).toFixed(2)),
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('sky dither check passed');
} finally {
  await context.close();
}
