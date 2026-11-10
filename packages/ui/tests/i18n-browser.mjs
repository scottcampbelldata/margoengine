import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/packages/ui/tests/i18n.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60000);
try {
  await page.waitForFunction(() => window.localeTest?.renderer.stats.drawCalls > 0);
  const before = await page.evaluate(() => window.localeTest.label.rect.width);
  const state = await page.evaluate(() => {
    const t = window.localeTest;
    t.locale.locale = 'ar';
    t.frame();
    return {
      text: t.label.text,
      direction: t.ui.direction,
      width: t.label.rect.width,
      glyphs: t.renderer.stats.glyphs,
    };
  });
  assert.equal(state.text, 'المريخ');
  assert.equal(state.direction, 'rtl');
  assert.notEqual(state.width, before);
  assert.ok(state.glyphs > 0);
  await page.evaluate(() => {
    const t = window.localeTest;
    t.locale.locale = 'es';
    t.frame();
  });
  assert.equal(await page.evaluate(() => window.localeTest.label.text), 'Marte');
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.localeTest.close());
  console.log('Locale swapping, Arabic glyph rendering, RTL and live relayout checks passed');
} finally {
  await browser.close();
}
