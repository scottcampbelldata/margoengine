import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/packages/ui/tests/forms.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60000);
async function click(id) {
  const r = await page.evaluate((id) => window.formsTest.rect(id), id);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
}
try {
  await page.waitForFunction(() => window.formsTest);
  await page.locator('canvas').focus();
  await page.evaluate(() => window.formsTest.ui.focus(window.formsTest.select, 'keyboard'));
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => window.formsTest.select.value), 'earth');
  await page.evaluate(() => window.formsTest.ui.execute('up', 'gamepad'));
  assert.equal(await page.evaluate(() => window.formsTest.select.value), 'mercury');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.formsTest.select.expanded);
  await page.waitForFunction(() => document.querySelector('[role=combobox]')?.getAttribute('aria-expanded') === 'true');
  assert.equal(await page.locator('[role=combobox]').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.formsTest.select.expanded);
  assert.equal(await page.evaluate(() => window.formsTest.select.value), 'earth');
  await page.evaluate(() => window.formsTest.ui.focus(window.formsTest.radio.buttons[0], 'gamepad'));
  await page.evaluate(() => window.formsTest.ui.execute('right', 'gamepad'));
  assert.equal(await page.evaluate(() => window.formsTest.radio.value), 'earth');
  await page.waitForFunction(
    () => document.querySelector('[role=radio][aria-checked=true]')?.getAttribute('aria-label') === 'Earth',
  );
  await click('tabs-choice-1');
  assert.equal(await page.evaluate(() => window.formsTest.tabs.value), 'details');
  await page.waitForFunction(
    () => document.getElementById('margo-ui-tabs-choice-1')?.getAttribute('aria-selected') === 'true',
  );
  assert.equal(
    await page.locator('[role=tab][aria-selected=true]').getAttribute('aria-controls'),
    'margo-ui-tabs-panel-1',
  );
  await click('checkbox');
  assert.equal(await page.evaluate(() => window.formsTest.checkbox.checked), true);
  await page.waitForFunction(() => document.querySelector('[role=checkbox]')?.getAttribute('aria-checked') === 'true');
  assert.equal(await page.locator('[role=checkbox]').getAttribute('aria-checked'), 'true');
  const square = await page.evaluate(() => ({ ...window.formsTest.color.children[0].rect }));
  await page.mouse.click(square.x + square.width * 0.75, square.y + square.height * 0.25);
  const pointer = await page.evaluate(() => window.formsTest.color.value);
  assert.notEqual(pointer, '#ffffffff');
  await page.evaluate(() => window.formsTest.ui.focus(window.formsTest.color.hexInput, 'keyboard'));
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('#33669980');
  assert.equal(await page.evaluate(() => window.formsTest.color.value), '#33669980');
  const channels = await page.getByRole('slider').count();
  assert.equal(channels, 7);
  const stats = await page.evaluate(() => ({ ...window.formsTest.renderer.stats }));
  assert.ok(stats.rects >= 4096, 'HSV square rendered as colour cells');
  assert.ok(stats.glyphs > 30, 'form captions rendered');
  assert.deepEqual(await page.evaluate(() => window.formsTest.errors), []);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.formsTest.close());
  console.log('Forms pointer, keyboard, gamepad, select popup, ARIA relationships and HSV/hex/alpha checks passed');
} finally {
  await browser.close();
}
