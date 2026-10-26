// Real-GPU checks of @margoengine/ui (one GPU job at a time; from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/ui/tests/ui-browser.mjs
// The page (ui-browser.js) draws a card with a button, a health bar, labels and a clipped scrolling list through the
// real UiRenderer, reads the canvas back, and checks colours, rounded corners, shadows, text, clipping, dialogs
// dimming the screen, resolution scaling, themes, and that an unchanged frame uploads nothing. Results go to
// test-results/ui-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

// The dev server serves the repository root, whichever folder `npm run test:browser` starts in.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/ui/tests/ui.html', port: 5251 });
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(120_000);
try {
  await page.waitForFunction(() => typeof window.runUiTests === 'function');
  const report = await page.evaluate(() => window.runUiTests());
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/ui-browser.json', JSON.stringify({ hardware, ...report }, null, 2));
  await page.screenshot({ path: 'test-results/ui-browser.png' });
  for (const name of report.checks) console.log(`ok - ${name}`);
  console.log(`${report.checks.length} ui browser checks passed`);
} finally {
  await context.close();
}
