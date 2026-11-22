// check:owners failed once on a loaded machine with "Execution context was destroyed, most likely because of a
// navigation" in the middle of the sky fixture. startDevServer asks Vite for no file watcher (`watch: null`), but
// Vite's mergeConfig skips null values, so the root vite.config.mjs's `watch: { ignored }` won and every suite's dev
// server watched the files it had served. A build in the same checkout (a package's `npm test` rebuilds its dist)
// rewrote a module the page had loaded, Vite sent the page a full reload, and the page's next evaluate failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { noFileWatcher, openBrowser, startDevServer } from '../scripts/browser.js';

test('a suite dev server watches no files, whatever the root Vite config says', async () => {
  const dev = await startDevServer({ startPath: '/LICENSE', port: 0 });
  try {
    assert.equal(dev.server.config.server.watch, null);
    assert.notEqual(dev.server.watcher.constructor.name, 'FSWatcher', 'no chokidar watcher is started');
  } finally {
    await dev.close();
  }
});

test('a page keeps its execution context when a module it loaded is rewritten on disk', {
  timeout: 5 * 60_000,
}, async () => {
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
    // fixed-wait: proves an absence (no reload); chokidar reports a change within about 100 ms, 3 s is far past it.
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

// The text package's browser suites build their own server from packages/text/vite.config.js. Under MARGO_COMPAT=1 the
// text suite failed once with "Execution context was destroyed" while packages/loaders was rebuilt in the same
// checkout: the server watched the loaders dist the page had imported and reloaded the page mid-evaluate.
test('noFileWatcher turns the watcher off for a server built from a package Vite config', async () => {
  const server = await createServer({
    configFile: 'packages/text/vite.config.js',
    logLevel: 'error',
    server: { port: 0 },
    plugins: [noFileWatcher()],
  });
  try {
    assert.equal(server.config.server.watch, null);
    assert.notEqual(server.watcher.constructor.name, 'FSWatcher', 'no chokidar watcher is started');
  } finally {
    await server.close();
  }
});

// KB-DEVWATCH-ALL1: the same watcher was in every suite and harness that called Vite's createServer itself.
test('every Vite createServer call in the repository passes noFileWatcher()', () => {
  const roots = [
      'scripts',
      'tests',
      'examples',
      ...readdirSync('packages').flatMap((p) => ['scripts', 'tests', 'test'].map((d) => join('packages', p, d))),
    ],
    files = [],
    walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'test-results') walk(path);
        } else if (/\.(m?js|m?ts)$/.test(entry.name)) files.push(path);
      }
    };
  roots.forEach(walk);
  const missing = [];
  let calls = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8'),
      imported = /import\s*\{([^}]*)\}\s*from\s*['"]vite['"]/.exec(source);
    const name = imported && /\bcreateServer(?:\s+as\s+(\w+))?\b/.exec(imported[1]);
    if (!name) continue;
    const call = new RegExp(`\\b${name[1] ?? 'createServer'}\\(\\s*\\{`, 'g');
    for (const match of source.matchAll(call)) {
      calls++;
      const options = source.slice(match.index, source.indexOf('});', match.index));
      if (!options.includes('noFileWatcher()'))
        missing.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.ok(calls > 40, `found ${calls} createServer calls; the scan lost its files`);
  assert.deepEqual(missing, [], 'createServer calls that keep a file watcher');
});
