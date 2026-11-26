// MARGO_COMPAT not applicable: the hello-cube template picks WebGPU or the WebGL2 fallback itself.
// The playground page in a real browser (docs/playground.md): a template runs and draws, an error shows its line and its
// error-help link, the frame is sandboxed, forged messages are ignored, and share links open (and bad ones explain).
// After `npm run build:packages`:
//   node scripts/run-with-timeout.mjs --max=5 -- npm run test:playground:browser
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { launchBrowser } from '../../scripts/lib/browser.mjs';
import { server } from '../../scripts/serve-playground.mjs';
import { closeAll } from '../../scripts/support/shutdown.mjs';
import { templates } from '../../site/playground/templates.js';
import { decodePNG } from '../support/png.js';

const errorTemplate = templates.find((t) => t.id === 'error');

test('the playground runs templates, reports errors with lines and codes, and opens share links', {
  timeout: 240_000,
}, async () => {
  server.keepAliveTimeout = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const page0 = `http://127.0.0.1:${server.address().port}/site/playground/?packages=/node_modules/`;
  const browser = await launchBrowser({ headless: true });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    context.setDefaultTimeout(120_000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(page0);
    await page.waitForFunction(() => !document.getElementById('run').disabled);

    // A template: it runs at once and draws the lit cube on the dark background.
    await page.selectOption('#template', 'hello-cube');
    await page.locator('#console li', { hasText: 'Rendering with' }).waitFor();
    assert.equal(await page.locator('#stage iframe').getAttribute('sandbox'), 'allow-scripts');
    const frame = page.frames().find((f) => f !== page.mainFrame());
    assert.equal(await frame.evaluate(() => origin), 'null', 'the frame has an opaque origin');
    assert.equal(
      await frame.evaluate(() => {
        try {
          return parent.document && 'reached';
        } catch {
          return 'blocked';
        }
      }),
      'blocked',
    );
    await page.waitForTimeout(500);
    const shot = await decodePNG(new Uint8Array(await page.locator('#stage iframe').screenshot()));
    let lit = 0;
    for (let i = 0; i < shot.data.length; i += 4) if (shot.data[i] > 120 && shot.data[i] > shot.data[i + 2] + 40) lit++;
    assert.ok(lit > shot.width * shot.height * 0.005, `the cube is drawn (${lit} warm pixels)`);

    // A message that does not come from the frame is ignored.
    await page.evaluate((channel) => postMessage({ channel, kind: 'error', text: 'forged' }, '*'), 'margo-playground');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#console li', { hasText: 'forged' }).count(), 0);

    // An error: its line in the code, and its MargoError code linked to the error help.
    await page.selectOption('#template', 'error');
    const error = page.locator('#console li.error');
    await error.waitFor();
    assert.match(await error.textContent(), /Mesh disposed.*\(line 9\).*error help: disposed/s);
    assert.match(await error.locator('a').getAttribute('href'), /\/site\/errors\.html#disposed$/);
    assert.match(await page.locator('#status').textContent(), /line 9/);
    await error.getByRole('button', { name: 'line 9' }).click();
    assert.equal(
      await page.evaluate(() => {
        const e = document.getElementById('editor');
        return e.value.slice(e.selectionStart, e.selectionEnd);
      }),
      errorTemplate.code.split('\n')[8],
    );

    // The version history holds both runs and restores the earlier one.
    assert.ok((await page.locator('#versions option').count()) >= 2);
    await page.selectOption('#versions', '1');
    await page.click('#restore');
    assert.equal(await page.inputValue('#editor'), templates[0].code);
    await page.selectOption('#template', 'error');
    await error.waitFor();

    // Share: the link carries the code; a fresh browser with no saved state opens it.
    await page.click('#share');
    await page.waitForFunction(() => location.hash.startsWith('#code='));
    const link = page.url();
    const other = await context.browser().newContext();
    try {
      const shared = await other.newPage();
      await shared.goto(link);
      await shared.waitForFunction(() => !document.getElementById('run').disabled);
      assert.equal(await shared.inputValue('#editor'), errorTemplate.code);
      assert.match(await shared.locator('#status').textContent(), /line 9|Opened the shared code/);
      // A damaged link says so and keeps the editor usable.
      await shared.goto(`${page0}#code=@@not-a-link`);
      await shared.waitForFunction(() => /damaged/.test(document.getElementById('status').textContent));
      assert.match(await shared.locator('#status').textContent(), /damaged/);
      assert.equal(await shared.locator('#status').getAttribute('role'), 'alert');
    } finally {
      await other.close();
    }
    // Page errors include the frame's: the only ones are the error template's own, on purpose.
    assert.deepEqual(
      errors.filter((message) => !/^Mesh disposed/.test(message)),
      [],
    );
  } finally {
    await closeAll({ context, browser, servers: [server] });
  }
});
