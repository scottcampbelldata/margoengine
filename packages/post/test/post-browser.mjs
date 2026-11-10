import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';
// Shared harness for the post effects' real-GPU checks, built packages: takes the GPU lock, serves the repository with
// Vite on `port`, starts the browser the test file opens with `open` (each test names its own browser), loads the
// 320 x 240 canvas of post-browser.html and hands `run` the page and a canvas screenshot decoder. Any page error or
// console error fails the check.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

export async function postBrowser(owner, port, open, run, { seconds = 120 } = {}) {
  const release = await acquire({ owner });
  const timer = setTimeout(() => {
    console.error(`${owner}: timed out after ${seconds} s`);
    process.exit(1);
  }, seconds * 1000);
  const server = await createServer({
    configFile: false,
    cacheDir: `test-results/${owner}/vite-cache`,
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port, strictPort: true, watch: null },
    logLevel: 'error',
  });
  await listenWhenFree(() => server.listen(), { port });
  const browser = await open();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 }),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    if (compatRun()) await page.addInitScript(compatShim);
    await page.goto(`http://127.0.0.1:${port}/packages/post/test/post-browser.html`);
    const shot = async () => decodePNG(await page.locator('canvas').screenshot());
    await run(page, shot);
    assert.deepEqual(errors, []);
  } finally {
    clearTimeout(timer);
    await closeAll({ browser, servers: [server] });
    await release();
  }
}
