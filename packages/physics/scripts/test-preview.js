// The physics render check on the WebGL2 preview backend: `node scripts/test-preview.js` (build the packages first).
// MARGO_COMPAT not applicable: the page creates its engine with backend 'webgl2' and the preview renderer
// (tests/preview-browser.js), never navigator.gpu, so the WebGL2 layer's shim would switch nothing (KB-PHYS-PREVIEWCOMPAT1).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0, hmr: false },
});
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/preview.html`);
  await page.waitForFunction(() => typeof window.runPhysicsPreviewTests === 'function', null, { timeout: 60000 });
  const report = await page.evaluate(() => window.runPhysicsPreviewTests());
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'physics-preview.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${report.checks.length} preview browser checks passed`);
} finally {
  await closeAll({ browser, servers: [server] });
}
