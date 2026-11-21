import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
// Physics.load() in the page fetches dist/rapier3d.wasm through the dev server, the way an app's bundler serves it.
await mkdir(results, { recursive: true });
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({
    headless: true,
    args,
  });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  const errors = [];
  // MARGO_COMPAT=1: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/physics.html`);
  await page.waitForFunction(() => typeof window.runPhysicsTests === 'function', null, { timeout: 60000 });
  const report = await page.evaluate(() => window.runPhysicsTests());
  await writeFile(resolve(results, 'physics-stack.png'), Buffer.from(report.image.split(',')[1], 'base64'));
  delete report.image;
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'physics-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${report.checks.length} browser checks passed`);
} finally {
  await closeAll({ browser, servers: [server] });
}
