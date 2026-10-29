import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';
import { createServer } from 'vite';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({
    headless: true,
    args,
  });
  for (const samples of [1, 4]) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 700 },
      deviceScaleFactor: 1,
      ...(samples === 1 ? { userAgent: 'iPhone Mobile' } : {}),
    });
    // --compat: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
    if (compatRun()) await page.addInitScript(compatShim, compatUrl());
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${server.resolvedUrls.local[0]}tests/text.html`);
    await page.waitForFunction(() => typeof window.runTextTests === 'function');
    const report = await page.evaluate(() => window.runTextTests());
    assert.equal(report.samples, samples);
    report.gallery = await page.evaluate(() => window.runGallery());
    assert.deepEqual(report.gallery.errors, []);
    report.checks.push(
      'Gallery renders headings, outlines, shadows, multilingual text, emoji, a justified paragraph and labels without errors',
    );
    await page
      .locator('#gallery')
      .screenshot({ path: resolve(results, samples === 4 ? 'text-gallery.png' : 'text-gallery-mobile.png') });
    report.browser = browser.version();
    assert.deepEqual(errors, []);
    await writeFile(
      resolve(results, samples === 4 ? 'text-browser.json' : 'text-browser-mobile.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    console.log(`${report.checks.length} browser checks passed`);
    await page.close();
  }
} finally {
  await closeAll({ browser, servers: [server] });
}
