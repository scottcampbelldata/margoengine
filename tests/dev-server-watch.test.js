// check:owners failed once on a loaded machine with "Execution context was destroyed, most likely because of a
// navigation" in the middle of the sky fixture. startDevServer asks Vite for no file watcher (`watch: null`), but
// Vite's mergeConfig skips null values, so the root vite.config.mjs's `watch: { ignored }` won and every suite's dev
// server watched the files it had served. A build in the same checkout (a package's `npm test` rebuilds its dist)
// rewrote a module the page had loaded, Vite sent the page a full reload, and the page's next evaluate failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser, startDevServer } from '../scripts/browser.js';

test('a suite dev server watches no files, whatever the root Vite config says', async () => {
  const dev = await startDevServer({ startPath: '/LICENSE', port: 0 });
  try {
    assert.equal(dev.server.config.server.watch, null);
    assert.notEqual(dev.server.watcher.constructor.name, 'FSWatcher', 'no chokidar watcher is started');
  } finally {
    await dev.close();
  }
});

test('a page keeps its execution context when a module it loaded is rewritten on disk', { timeout: 5 * 60_000 }, async () => {
  // Not under test-results/, which Vite never watches: a package's dist is where a rebuild lands.
  const dir = `tests/.dev-server-watch-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.html'), '<!doctype html><script type="module" src="./mod.js"></script>');
  writeFileSync(join(dir, 'mod.js'), 'window.loads = (window.loads ?? 0) + 1;\n');
  // Plain HTML, no GPU work: a runner's software adapter is fine here.
  const browser = await openBrowser({ startPath: `/${dir}/page.html`, port: 'free', softwareAdapterOk: true });
  try {
    const { page } = browser;
    await page.waitForFunction(() => window.loads === 1);
    let navigations = 0;
    page.on('framenavigated', (frame) => frame === page.mainFrame() && navigations++);
    // A rebuild of a served file, as `npm run build` of a package writes its dist while a suite's page has it loaded.
    writeFileSync(join(dir, 'mod.js'), 'window.loads = (window.loads ?? 0) + 1; // rebuilt\n');
    // wall-clock: chokidar reports a change within about 100 ms here; 3 s is far past any reload it would cause.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(navigations, 0, 'the page was reloaded');
    assert.equal(await page.evaluate(() => window.loads), 1);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Found while chasing KB-L4-W1 (2026-11-11): startDevServer asks Vite to scan only the suite's start page for
// dependencies, but Vite's mergeConfig concatenates arrays, so the root vite.config.mjs's '**/*.html' came along and
// every suite server scanned every HTML page in the checkout before its first page load. One unresolvable import in
// any other page (an untracked local page, a rival comparison page) made the scan fail with "Failed to run dependency
// scan" and pre-bundling was skipped for the suite's own page.
test('a suite dev server scans only its start page for dependencies', async () => {
  const dev = await startDevServer({ startPath: '/LICENSE', port: 0 });
  try {
    assert.deepEqual(dev.server.config.optimizeDeps.entries, ['LICENSE']);
  } finally {
    await dev.close();
  }
});
