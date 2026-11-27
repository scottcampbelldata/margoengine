// Real-GPU check that VFX's particles reach TAA's reactive mask with no scene code (KB-TAA-PARTICLEMASK1). Run from the
// repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/reactive-check.mjs
// Two plain TAA.attach(engine) rigs and one without TAA, with the same sparse, fast spray: the default effect (mask on
// while TAA reads masks) must keep over 75% of the particles' brightness without TAA, where `reactive: false` keeps
// under 60% (measured on the workstation's RTX: 86% and 48%). Before the fix VFX drew no mask and both were the plain one.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/reactive-check.html', port: 5427 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  await page.evaluate(() => window.check.frames(45));
  // The mean sRGB lift the particles add over the background, from each canvas as presented.
  const r = {};
  for (const id of ['masked', 'plain', 'raw']) {
    const image = await decodePNG(await page.locator(`#${id}`).screenshot());
    const levels = [];
    for (let i = 0; i < image.data.length; i += 4) levels.push((image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3);
    const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.2)];
    let lift = 0;
    for (const level of levels) lift += Math.max(0, level - floor - 2);
    r[id] = lift / levels.length;
  }
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  const seen = JSON.stringify(r);
  assert.ok(r.raw > 0.3, `the spray shows without TAA (${seen})`);
  assert.ok(r.plain < 0.6 * r.raw, `without the mask TAA averages the moving particles away (${seen})`);
  assert.ok(r.masked > 0.75 * r.raw, `TAA reads VFX's mask by itself and keeps the moving particles (${seen})`);
  assert.deepEqual(pageErrors, []);
  console.log(`vfx reactive check passed: particle lift ${seen}`);
} finally {
  await context.close();
}
