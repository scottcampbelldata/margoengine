// Renders the IK reach sheet (ik-reach-sheet.html) and checks what it drew: on the fitted body no elbow or knee is past
// straight in any reach, and the same reaches with `limits: false` show the reversed hinges this guards against.
// Writes test-results/rigging/ik-reach-sheet-<backend>[-t-pose].png for a person to look at.
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/rigging/tests/ik-reach-sheet.browser.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close, hardware } = await openBrowser({
  startPath: '/packages/rigging/tests/ik-reach-sheet.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.renderSheet === 'function', null, { timeout: 30_000 });
  const backend = hardware.compat ? 'webgl2' : 'webgpu';
  mkdirSync('test-results/rigging', { recursive: true });
  for (const [arms, suffix] of [
    [0, ''],
    [90, '-t-pose'],
  ]) {
    const sheet = await page.evaluate((options) => window.renderSheet(options), { arms });
    assert.deepEqual(sheet.errors, []);
    assert.deepEqual(errors, []);
    const file = `test-results/rigging/ik-reach-sheet-${backend}${suffix}.png`,
      png = Buffer.from(sheet.png, 'base64');
    writeFileSync(file, png);
    let reversed = 0;
    for (const { reach, limits, hinges, results } of sheet.report) {
      const least = Math.min(...Object.values(hinges));
      if (limits) {
        assert.ok(least >= -1e-6, `${reach}: a hinge is ${-least} degrees past straight on the fitted body`);
        for (const result of results)
          assert.ok(
            result.reached || result.held,
            `${reach}: ${result.limb} missed by ${result.distance} with nothing held`,
          );
      } else if (least < -5) reversed++;
    }
    assert.ok(reversed >= 2, `only ${reversed} free reaches reversed a hinge: the sheet no longer shows the fault`);
    console.log(
      `${backend} reach sheet, arms ${arms}: ${sheet.reaches.length} reaches x ${sheet.views.length} rows, ${png.length} bytes, ${reversed} reaches reverse a hinge with limits off. ${file}`,
    );
    for (const { reach, limits, hinges, results } of sheet.report)
      if (limits)
        console.log(
          `  ${reach}: elbows ${hinges.l_elbow.toFixed(0)}/${hinges.r_elbow.toFixed(0)}, knees ${hinges.l_knee.toFixed(0)}/${hinges.r_knee.toFixed(0)}${results.some((r) => !r.reached) ? `, held short: ${results.filter((r) => !r.reached).map((r) => `${r.limb} ${r.distance.toFixed(3)} m`)}` : ''}`,
        );
  }
} finally {
  await close();
}
