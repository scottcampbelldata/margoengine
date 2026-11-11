// `vite` started at the repository root (`npm run modern:dev:extensions`, `npm run dev:examples`) printed "Failed to run
// dependency scan. Skipping dependency pre-bundling" because the scan read every HTML file in the checkout, the rival
// comparison pages included: they import engines that are deliberately not installed here and are served by their own
// scripts, never by Vite. The root vite.config.mjs keeps them out of the scan. This starts the root dev server with a
// fresh dependency cache and fails on any warning or error line (scripts/check-dev-servers.mjs, which verify runs for
// every dev server in the repository).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('the root dev server starts without a dependency scan failure', { timeout: 150_000 }, () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/check-dev-servers.mjs'), '--only=package.json modern:dev:extensions'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 140_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ok\s+package\.json modern:dev:extensions/);
});

test('the root Vite config leaves the rival comparison pages out of the dependency scan', () => {
  const config = readFileSync(join(root, 'vite.config.mjs'), 'utf8');
  for (const page of ['scripts/rival-*.html', 'scripts/sciviz-compare/**', 'packages/*/scripts/rival-page.html']) {
    assert.ok(config.includes(`'!${page}'`), `${page} is excluded`);
  }
});

// The scan also skips every top-level folder git ignores (test output, lane scratch and local-only folders). The names
// come from git at load time, so the tracked config names none of the local-only ones (tests/no-private-paths.test.js).
test('the root Vite config leaves every top-level git-ignored folder out of the dependency scan', async () => {
  const { default: config, ignoredRootFolders } = await import('../vite.config.mjs'),
    folders = ignoredRootFolders(),
    { entries } = config.optimizeDeps;
  assert.ok(folders.includes('node_modules/'), `git lists the ignored folders: ${folders}`);
  for (const folder of folders) assert.ok(entries.includes(`!${folder}**`), `${folder} is excluded`);
});

// The root server's file watcher used to crawl the whole checkout at start (chokidar opens one native watch per file:
// about 30,000 here, built packages, examples and tests). Requests waited on that crawl, so the first sciviz demo after
// `npm run dev:examples` took 38.5 to 55.6 s on the dev PC, and every tab already open at the start waited with it.
// vite.config.mjs now watches only what the server serves. Work counts, not times: at ready the watcher holds a few
// paths, after three demo tabs load at once it holds exactly the files they were served, and a served file still
// reports its edit (which is what reloads the page).
const SCIVIZ_TABS = ['/examples/sciviz-volume.html', '/examples/sciviz-surface.html', '/examples/sciviz-points.html'];
const IMPORTS = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]*\s*from\s*)["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Load a page like a browser tab: its html, its module scripts and every static and dynamic import they make. */
async function loadTab(base, page, seen) {
  const html = await fetch(new URL(page, base));
  assert.equal(html.status, 200, page);
  const text = await html.text(),
    queue = [...text.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => new URL(m[1], new URL(page, base)).href);
  while (queue.length) {
    const batch = queue.splice(0).filter((url) => !seen.has(url));
    for (const url of batch) seen.add(url);
    await Promise.all(
      batch.map(async (url) => {
        const response = await fetch(url);
        assert.equal(response.status, 200, url);
        if (!/javascript/.test(response.headers.get('content-type') ?? '')) return;
        for (const m of (await response.text()).matchAll(IMPORTS)) {
          const spec = m[1] ?? m[2];
          if (spec && !spec.startsWith('data:') && !/^https?:/.test(spec)) queue.push(new URL(spec, url).href);
        }
      }),
    );
  }
}

const watchedCount = (watcher) => Object.values(watcher.getWatched()).reduce((n, names) => n + names.length, 0);
const key = (path) => (process.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path);

test('the root dev server watches only what it serves, so three demo tabs open at the start load at once', { timeout: 300_000 }, async () => {
  const { createServer } = await import('vite'),
    cacheDir = mkdtempSync(join(tmpdir(), 'margo-watch-'));
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.mjs'),
    cacheDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  try {
    const { watcher } = server;
    // chokidar emits 'ready' once, after its first crawl; createServer may return after it already did.
    if (!watcher._readyEmitted) await new Promise((resolve) => watcher.once('ready', resolve));
    const atReady = watchedCount(watcher);
    assert.ok(atReady <= 50, `${atReady} paths watched at start (the old whole-root watch held about 30,000)`);

    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`,
      seen = new Set();
    await Promise.all(SCIVIZ_TABS.map((page) => loadTab(base, page, seen)));

    const graph = server.environments.client.moduleGraph,
      inRoot = (file) => key(file).startsWith(key(root).replace(/\/?$/, '/')),
      // Vite never watches node_modules (its own default ignore), the pre-bundled dependencies and its own client.
      served = new Set([...graph.fileToModulesMap.keys()].filter((file) => inRoot(file) && !file.includes('/node_modules/')).map(key));
    for (const page of SCIVIZ_TABS) served.add(key(join(root, page)));
    const watched = new Set(Object.entries(watcher.getWatched()).flatMap(([dir, names]) => names.map((name) => key(join(dir, name)))));
    assert.ok(served.size > 100, `${served.size} files served to the three tabs`);
    const missing = [...served].filter((file) => !watched.has(file));
    assert.deepEqual(missing, [], 'every served file is watched, so editing it reloads the page');
    const total = watchedCount(watcher);
    assert.ok(total <= served.size + atReady, `${total} paths watched for ${served.size} served files`);

    // An edit of a served file still reaches the watcher (Vite turns it into the page reload).
    const page = join(root, 'examples/sciviz-volume.ts'),
      before = statSync(page);
    try {
      const changed = new Promise((resolve) => watcher.on('change', (path) => key(path) === key(page) && resolve(path)));
      utimesSync(page, before.atime, new Date(before.mtimeMs + 2000));
      await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('no change event for a served file in 30 s')), 30_000))]);
    } finally {
      utimesSync(page, before.atime, before.mtime);
    }
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// The probe behind check:dev-servers and the template check: a clean server passes; a warning line, a missing module
// and a server that never answers each fail it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { probe } from '../scripts/support/dev-server-probe.mjs';

function fixture(source) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-probe-'));
  writeFileSync(join(dir, 'server.mjs'), source);
  return dir;
}
const serverSource = (body, main = 'import "/dep.js";') => `
import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((request, response) => {
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<script type="module" src="/main.js"></script>'); }
  else if (request.url === '/main.js') { response.setHeader('content-type', 'text/javascript'); response.end(${JSON.stringify(main)}); }
  else if (request.url === '/dep.js') { response.setHeader('content-type', 'text/javascript'); response.end('export {};'); }
  else { response.statusCode = 404; response.end(); }
}).listen(port, '127.0.0.1', () => { ${body} });
`;
async function run(source, port) {
  const dir = fixture(source);
  try {
    return await probe({ command: process.execPath, args: ['server.mjs', String(port)], cwd: dir, page: `http://127.0.0.1:${port}/`, settleMs: 200, listenLimitMs: 10_000, limitMs: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the probe passes a clean server and follows the modules a page loads', async () => {
  const { problems } = await run(serverSource("console.log('Local: ready');"), 5701);
  assert.deepEqual(problems, []);
});

test('the probe fails on a warning line in the server output', async () => {
  const { problems } = await run(serverSource("console.warn('(!) Failed to run dependency scan.');"), 5702);
  assert.ok(problems.some((p) => p.startsWith('output:')), problems.join('\n'));
});

test('the probe fails on a module the page loads that does not exist', async () => {
  const source = serverSource('', 'import "/missing.js";');
  const { problems } = await run(source, 5703);
  assert.ok(problems.some((p) => /missing\.js answered 404/.test(p)), problems.join('\n'));
});

test('the probe fails on a server that exits before it answers', async () => {
  const { problems } = await run('process.exit(3);', 5704);
  assert.ok(problems.some((p) => /exited 3/.test(p)), problems.join('\n'));
});

test('every start command in the documentation maps to a checked server', { timeout: 60_000 }, () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts/check-dev-servers.mjs'), '--docs-only'], { cwd: root, encoding: 'utf8', timeout: 50_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
