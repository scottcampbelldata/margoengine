import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/inspector/test/parity.html', port: 'free' });
const { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  for (const backend of ['webgpu', 'webgl2']) {
    assert.equal(await page.evaluate((b) => window.setup(b), backend), backend);
    const number = page.getByRole('spinbutton', { name: 'x', exact: true });
    await number.fill('2');
    await number.press('Tab');
    assert.equal(await page.evaluate(() => window.state.x), 2);
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    assert.equal(await page.evaluate(() => window.state.x), 0);
    await page.getByRole('combobox', { name: 'mode' }).selectOption('1');
    await page.getByRole('button', { name: 'run', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => [window.state.mode, window.state.clicks]), ['b', 1]);
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    assert.equal(await page.evaluate(() => window.state.clicks), 0);
    assert.ok(await page.evaluate(() => window.engine.stats.drawCalls > 0));
    assert.deepEqual(errors, []);
    console.log(`${backend}: native bindings, folder, enum, command undo and rendered mesh passed`);
  }
  await page.evaluate(() => {
    window.panel.dispose();
    window.engine.dispose();
  });
} finally {
  await context.close();
}
