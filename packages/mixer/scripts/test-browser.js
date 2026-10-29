// Renders the mixer's effects and buses on a real OfflineAudioContext in headless Chrome and compares the samples with
// the reference maths. Writes test-results/mixer-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
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
  if (!args.includes('--autoplay-policy=no-user-gesture-required'))
    args.push('--autoplay-policy=no-user-gesture-required');
  browser = await launchBrowser({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/browser.html`);
  await page.waitForFunction(() => typeof window.runChecks === 'function');
  const report = await page.evaluate(() => window.runChecks());
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'mixer-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeAll({ browser, servers: [server] });
}
