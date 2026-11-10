import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = process.argv[2];
if (!/^[a-z-]+$/.test(entry ?? '')) throw new Error('Pass one optional controls entry name');
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}tests/optional.html?entry=${entry}`);
  await page.waitForFunction(() => typeof window.runOptionalCheck === 'function');
  const result = await page.evaluate(() => window.runOptionalCheck());
  assert.deepEqual(
    result.rows.map((row) => row.backend),
    ['webgpu', 'webgl2'],
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(resolve(root, 'test-results', `${entry}-browser.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeAll({ browser, servers: [server] });
}
