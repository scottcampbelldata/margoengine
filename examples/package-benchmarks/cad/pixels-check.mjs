// Real-GPU check that incremental frames (unchanged entities skipped by the kernel, reused instances, patched matrices,
// partial instance uploads) produce exactly the pixels of a from-scratch render of the same scene, over static parts mixed
// with moving parts and edits. Run from the repository root after building packages, holding test-results/gpu.lock:
//   node examples/package-benchmarks/cad/pixels-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/examples/package-benchmarks/cad/pixels-check.html', port: 5219 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
const compare = async (label) => {
  await page.evaluate(() => window.check.reference());
  const [a, b] = [await shot('a'), await shot('b')];
  let differing = 0,
    lit = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differing++;
    if (a.data[i] + a.data[i + 1] + a.data[i + 2] > 120) lit++;
  }
  await page.evaluate(() => window.check.release());
  assert.equal(differing, 0, `${label}: ${differing} pixels differ from a from-scratch render`);
  assert.ok(lit > 2000, `${label}: scene not visible (${lit} lit pixels)`);
  return lit;
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  console.log('setup', JSON.stringify(await page.evaluate(() => window.check.setup())));
  console.log('ok initial', await compare('initial'));
  for (let i = 0; i < 24; i++) {
    const r = await page.evaluate(() => window.check.advance());
    console.log('ok step', r.step, 'capacity', r.capacity, await compare(`step ${r.step}`));
    if (i % 6 === 5) {
      await page.evaluate(() => window.check.redraw());
      console.log('ok unchanged redraw', await compare(`redraw after step ${r.step}`));
    }
  }
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
  console.log('incremental frame pixel check passed');
} finally {
  await context.close();
}
