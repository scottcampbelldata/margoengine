import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/fsm/test/inspect-browser.html', port: 'free' });
const { page } = context;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.waitForFunction(() => Boolean(window.fsmCheck), null, { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => window.fsmCheck.scxml), { version: 1, initial: 'a', states: { a: {}, b: {} }, transitions: [{ from: 'a', to: 'b', after: 1 }] });
  const view = page.locator('[data-margo-machine-view]');
  await view.waitFor({ state: 'visible', timeout: 30000 });
  await page.evaluate(() => { window.fsmCheck.machine.send('enemy'); window.fsmCheck.machine.send('pause'); });
  await page.waitForFunction(() => window.fsmCheck.view.element.shadowRoot.querySelector('[data-history]').textContent === 'play: combat', null, { timeout: 30000 });
  assert.equal(await view.locator('[data-state=pause]').getAttribute('aria-current'), 'true');
  assert.match(await view.locator('[data-trace]').textContent(), /enemy.*pause/);
  const box = await view.boundingBox(), viewport = page.viewportSize();
  assert.ok(box.width > 200 && box.height > 150 && box.x >= 0 && box.y >= 0 && box.y + box.height <= viewport.height, JSON.stringify(box));
  await mkdir('test-results/batch250', { recursive: true });
  await page.screenshot({ path: `test-results/batch250/inspect${process.argv.includes('--compat') ? '-compat' : ''}.png` });
  await page.evaluate(() => { window.fsmCheck.view.dispose(); window.fsmCheck.inspector.dispose(); });
  assert.equal(await view.count(), 0);
  assert.deepEqual(errors, []);
  console.log('FSM overlay rendered, updated and disposed successfully');
} finally { await context.close(); }
