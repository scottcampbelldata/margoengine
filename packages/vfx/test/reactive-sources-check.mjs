// Real-GPU check that VFX ribbons, mesh particles and the Flame volume write TAA's reactive mask with no scene code,
// and that billboards in an order-independent pass still write theirs (KB-TAA-PARTICLEMASK2). Run from the repository
// root after building packages, on WebGPU and on the WebGL2 compatibility layer:
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/reactive-sources-check.mjs
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/reactive-sources-check.mjs --compat
// TAA keeps the mask it read in its resolved frame's alpha (1 everywhere when no mask reached it): each source's default
// must cover its own pixels there and leave the dark background at 0, and its `reactive: false` twin must give TAA no
// mask at all. Before the fix ribbons, mesh particles and Flame wrote no mask, so their defaults read as the twins.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/reactive-sources-check.html', port: 5428 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check.run(30));
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  const seen = JSON.stringify(r);
  for (const source of ['oit', 'ribbons', 'mesh', 'flame']) {
    const on = r[source];
    assert.ok(on.covered >= 20 && on.max > 0.5 && on.mean < 0.25, `${source} writes TAA's reactive mask (${seen})`);
    assert.equal(r[source + 'Off'].mean, 1, `${source} with reactive: false gives TAA no mask (${seen})`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`vfx reactive sources check passed: ${seen}`);
} finally {
  await context.close();
}
