import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';

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
  browser = await launchBrowser({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/sculpt.html`);
  await page.waitForFunction(() => typeof window.runSculptTests === 'function');
  const report = await page.evaluate(() => window.runSculptTests());
  assert.deepEqual(
    errors.filter((error) => !/^Failed to load resource/.test(error)),
    [],
  );
  await writeFile(resolve(results, 'sculpt-browser.json'), JSON.stringify(report, null, 2));
  for (const check of report.checks) console.log('ok', check);
} finally {
  await closeAll({ browser, servers: [server] });
}
