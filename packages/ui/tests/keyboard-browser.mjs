import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/packages/ui/tests/keyboard.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60000);
try {
  await page.waitForFunction(() => window.keyboardTest?.renderer.stats.drawCalls > 0);
  const click = async (i) => {
    const r = await page.evaluate((i) => window.keyboardTest.rect(i), i);
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  };
  await click(2);
  await click(0);
  await click(1);
  assert.equal(await page.evaluate(() => window.keyboardTest.field.value), 'Ab');
  await page.evaluate(() => {
    const t = window.keyboardTest;
    t.ui.focus(t.keyboard.children[0].children[3], 'gamepad');
    t.ui.execute('accept', 'gamepad');
  });
  assert.equal(await page.evaluate(() => window.keyboardTest.field.value), 'A');
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.keyboardTest.close());
  console.log('Virtual keyboard pixels, pointer text entry and gamepad checks passed');
} finally {
  await browser.close();
}
