import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/instances-browser.html' });
const { page } = browser,
  errors = [],
  rows = [];
page.setDefaultTimeout(30_000);
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => window.instancesProof);
  for (const mode of ['default', 'range', 'scene']) {
    await page.evaluate((mode) => window.instancesProof.mount(mode), mode);
    await page.waitForFunction(
      () => window.instancesProof.state.frames.every((n) => n > 15) && window.instancesProof.state.refs.length === 2,
    );
    const stats = await page.evaluate(() => window.instancesProof.snapshot());
    assert.deepEqual(stats, [
      { visible: mode === 'range' ? 1 : 2, drawCalls: 1 },
      { visible: mode === 'range' ? 1 : 2, drawCalls: 1 },
    ]);
    const pictures = [];
    for (const side of [0, 1])
      pictures.push(await decodePNG(await page.locator(`section[data-side="${side}"] canvas`).screenshot()));
    assert.deepEqual(pictures[1].data, pictures[0].data, mode + ' native/wrapper pixels');
    assert.ok(
      pictures[1].data.some((v, i) => i % 4 === 0 && v > 100),
      mode + ' visible red geometry',
    );
    if (mode === 'default') {
      const bounds = await page.locator('section[data-side="1"] canvas').boundingBox();
      await page.mouse.click(bounds.x + 92, bounds.y + 128);
      await page.waitForFunction(() => window.instancesProof.state.clicks.length > 0);
      const ids = await page.evaluate(() => ({
        clicks: window.instancesProof.state.clicks,
        refs: window.instancesProof.state.refs,
      }));
      assert.deepEqual(ids.clicks, [ids.refs[0]], 'GPU picking reaches the exact native instance');
    }
    assert.deepEqual(await page.evaluate(() => window.instancesProof.state.errors), []);
    rows.push({ mode, stats, pixelsExact: true });
  }
  await page.evaluate(() => window.instancesProof.unmount());
  await page.waitForFunction(() => window.instancesProof.state.engines.every((engine) => engine.disposed));
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/react-instances${compatRun() ? '-compat' : ''}.json`,
    JSON.stringify({ hardware: browser.hardware, rows }, null, 2) + '\n',
  );
  console.log(JSON.stringify(rows));
} finally {
  await browser.close();
}
