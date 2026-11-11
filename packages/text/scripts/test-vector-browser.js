// GPU checks of @margoengine/text/vector (tests/vector.html): coverage against a supersampled outline, thin stems,
// dilation, shadows, steady-frame work counts and a 100,000-glyph scale case. MARGO_COMPAT=1 (or --compat) runs the
// same page on the WebGL2 compatibility layer.
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
const server = await createServer({ configFile: resolve(root, 'vite.config.js'), logLevel: 'error', server: { port: 0 } });
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/vector.html`);
  await page.waitForFunction(() => typeof window.runVectorTests === 'function');
  const report = await page.evaluate(() => window.runVectorTests());
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  assert.equal(report.compat, compatRun());
  const name = compatRun() ? 'vector-browser-compat.json' : 'vector-browser.json';
  await writeFile(resolve(results, name), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(report.failures, []);
  console.log(`${report.checks.length} vector browser checks passed`);
  await page.close();
} finally {
  await closeAll({ browser, servers: [server] });
}
