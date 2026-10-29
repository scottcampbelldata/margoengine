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
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
  // --compat: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      errors.push(`${response.status()} ${response.url()}`);
  });
  const probeSamples = process.argv.includes('--probe-samples');
  await page.goto(`${server.resolvedUrls.local[0]}tests/${probeSamples ? 'probe-samples' : 'environment'}.html`);
  await page.waitForFunction(
    (sampled) => typeof window[sampled ? 'runProbeSampleTests' : 'runEnvironmentTests'] === 'function',
    probeSamples,
  );
  const report = await page.evaluate(
    (sampled) => window[sampled ? 'runProbeSampleTests' : 'runEnvironmentTests'](),
    probeSamples,
  );
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(results, probeSamples ? 'probe-samples-browser.json' : 'environment-browser.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`${report.checks.length} browser checks passed`);
} finally {
  await closeAll({ browser, servers: [server] });
}
