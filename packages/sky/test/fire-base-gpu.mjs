// snowNight's flames stand on the fuel, not in a haze over the logs (docs/known-bugs.md, "Cabin Hearth flames soft and
// smeary at the base"). Run from the repository root after building packages, natively and with MARGO_COMPAT=1:
// node packages/sky/test/fire-base-gpu.mjs
// fire-base-check.html draws the kit's flames over the Cabin Hearth's two logs from its close-up at 1080p and measures
// the flame layer's 10 to 90% rise on five lines up across the upper log's top. Births under the log tops and in front
// of the logs (the kit before the fix: a 0.2 by 0.02 by 0.08 m box and a 0.16 m cone disc) laid the young, still
// fading-in flames over the log faces. On an RTX A6000 (2026-11-16) the rise was 46.4 px on average natively and 46.0
// on the WebGL2 layer at the fuel's top (44.6 and 44.4 at the old placement 0.16 m lower), and is 17.8 and 18.2 with
// the births on the fuel's top. The frames are the same on every run (fixed 1/60 s steps; births seeded by slot and
// frame). The bound, 24 px, is the fixed rise plus a third for other GPUs' rasterisation, about half the haze's rise.
// The other suspects changed the fixed rise little: softness 0 gave 24.0, 0.02 gave 20.8 (the page's 0.08 is kept),
// and the alpha curve's first key at 0.85 gave 16.8.
// It also measures the flames' shape on the last frame, below.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';

const MAX_RISE = 24;
const ctx = await openBrowser({ startPath: '/packages/sky/test/fire-base-check.html', port: 'free' });
const errors = [];
ctx.page.on('pageerror', (e) => errors.push(e.message));
try {
  await ctx.page.setViewportSize({ width: 1920, height: 1080 });
  await ctx.page.reload();
  await ctx.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await ctx.page.evaluate(() => window.check.run());
  // The last frame, to look at when the rise fails.
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    `test-results/fire-base-${process.env.MARGO_COMPAT === '1' ? 'compat' : 'native'}.png`,
    Buffer.from(r.image, 'base64'),
  );
  const mean = r.lines.reduce((s, l) => s + l.rise, 0) / r.lines.length;
  console.log(
    JSON.stringify({
      mean,
      lines: r.lines.map((l) => [l.rise, +l.gradient.toFixed(1), +l.peak.toFixed(1)]),
      shape: r.shape,
    }),
  );
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  // Every line crosses flames: a line over a fire that drew nothing there would pass the rise for no reason.
  for (const l of r.lines) assert.ok(l.peak >= 15, `the line at x ${l.x} sees flames (peak ${l.peak.toFixed(1)})`);
  assert.ok(mean <= MAX_RISE, `the flames rise off the logs within ${MAX_RISE} px (mean ${mean.toFixed(1)} px)`);
  // The flames burn as tongues, not one overexposed blob (Scott, 2026-11-16 03:39, replacing the kit test's cap on
  // intensity x colour, which kept them at 3.5 while their light was 17 times brighter). Above the logs: the
  // silhouette stays orange (hue 10 to 45 degrees, saturation 0.4 or more; the flames' colour keys are 26, 15 and 8
  // degrees) on at least 9 in 10 of its pixels, clipped white stays in the cores, never within 2 px of the
  // silhouette, and some row crosses at least 4 separate flames. On an RTX A6000 (2026-11-16), natively and on the
  // WebGL2 layer: the kit's 58.5 gives 1.00 orange, white 4 px in at the nearest and 19 flames on a row; the old 3.5
  // gave 1.00, no white and 18; ten times the kit's (585) gives 0.85 orange and white 1 px from the edge, and fails.
  const { shape } = r;
  assert.ok(shape.edges >= 1000, `the flames have a silhouette above the logs (${shape.edges} px)`);
  assert.ok(
    shape.orange >= 0.9,
    `the flames' edges stay orange (${(shape.orange * 100).toFixed(1)}% of ${shape.edges} px)`,
  );
  assert.ok(
    shape.whiteFromEdge === null || shape.whiteFromEdge >= 3,
    `white only in the cores (${shape.whiteFromEdge} px from the edge)`,
  );
  assert.ok(shape.runs >= 4, `separate tongues (${shape.runs} on the fullest row)`);
} finally {
  await ctx.close();
}
