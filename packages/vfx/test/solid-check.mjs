// Real-GPU proof of @margoengine/vfx/solid (run from the repository root after building packages; MARGO_COMPAT=1 or
// --compat for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs --max 8 -- node packages/vfx/test/solid-check.mjs
// See solid-check.html for what it measures.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5412/packages/vfx/test/solid-check.html',
  context = await openBrowser({ startPath: '/packages/vfx/test/solid-check.html', port: 5412 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.goto(url);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.draw, ['red', 'green', 'blue', 'background'], `each box shows its own colour: ${JSON.stringify(r)}`);
  assert.deepEqual(r.pick, [0, 1, 2, null], `a ray through each centre picks the box drawn there: ${JSON.stringify(r)}`);
  assert.deepEqual(r.range, { start: 0, count: 32 }, 'one ranged upload of all four boxes');
  assert.deepEqual(r.after, ['red', 'background', 'yellow'], `the moved box and the shown box redraw: ${JSON.stringify(r)}`);
  assert.deepEqual(r.pickAfter, [0, null, 3], `picking follows the update: ${JSON.stringify(r)}`);
  console.log(`ok solid: draw ${r.draw}, pick ${r.pick}, after the update ${r.after}`);
  assert.deepEqual(pageErrors, []);
  console.log('solid check passed');
} finally {
  await context.close();
}
