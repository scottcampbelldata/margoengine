// Real-GPU checks of @margoengine/ui/world (one GPU job at a time; from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/ui/tests/world-browser.mjs
// The page (world-browser.js) draws a UI on a panel in a 3D scene and reads the canvas back; this driver then clicks the
// panel's button with the real mouse. Results go to test-results/ui-world-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/ui/tests/world.html', port: 5252 });
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(120_000);
try {
  await page.waitForFunction(() => typeof window.runWorldTests === 'function');
  const report = await page.evaluate(() => window.runWorldTests());
  assert.deepEqual(errors, []);
  const box = await page.locator('canvas').boundingBox();
  // The button is at the centre of the panel, which is at the centre of the view.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 10);
  await page.mouse.down();
  await page.mouse.up();
  let state = await page.evaluate(() => window.readWorld());
  assert.equal(state.clicks, 1, 'a real click through the canvas presses the button on the panel');
  await page.mouse.click(box.x + 10, box.y + 10);
  state = await page.evaluate(() => window.readWorld());
  assert.equal(state.clicks, 1, 'a click on the scene beside the panel presses nothing');
  report.checks.push(
    'a real mouse click on the canvas reaches the panel button by camera ray; a click beside it does not',
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/ui-world-browser.png' });
  await page.evaluate(() => window.finishWorld());
  assert.deepEqual(errors, []);
  await writeFile('test-results/ui-world-browser.json', JSON.stringify({ hardware, ...report }, null, 2));
  for (const name of report.checks) console.log(`ok - ${name}`);
  console.log(`${report.checks.length} world panel browser checks passed`);
} finally {
  await context.close();
}
