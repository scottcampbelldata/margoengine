// Bug 26: browser suites waited 30 s for `window.modern` and timed out, about 1 run in 38 under shared GPU slots. Every
// suite's Vite dev server used the default dependency cache, node_modules/.vite: one per checkout, and one for most
// worktrees, whose node_modules/.vite linked to the main checkout's. A server with another root or other aliases
// re-optimizes into that folder and replaces the files a second server's page has not fetched yet; that server then
// answers 504 "Outdated Optimize Dep" for them and its page never finishes loading, with no reload. Unlinking the
// worktrees' caches leaves the same race between two suites of one checkout (other aliases or plugins), so every dev
// server of openBrowser gets its own cache (startDevServer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DEV_CACHE_ROOT, startDevServer } from '../scripts/browser.js';
import { pathToFileURL } from 'node:url';

const until = async (condition, what, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * A page importing `dependency` when it asks for it, under the repository root (Vite serves only what is inside it). A
 * dynamic import, so the server does not transform the optimized file ahead of the page (a transformed file stays in
 * its memory): the page fetches it later, as a page still loading its imports does.
 */
function fixture(dir, name, dependency) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), `<!doctype html><script type="module" src="./${name}.js"></script>`);
  writeFileSync(join(dir, `${name}.js`), `export const load = () => import('${dependency}');\n`);
  return `/${dir.replaceAll('\\', '/')}/${name}.html`;
}

const origin = (server) => `http://127.0.0.1:${server.httpServer.address().port}`;

/** The optimized-dependency URL the server rewrote `dependency`'s import in `<name>.js` to. */
async function optimizedUrl(server, dir, name, file) {
  const code = await (await fetch(`${origin(server)}/${dir.replaceAll('\\', '/')}/${name}.js`)).text(),
    url = new RegExp(`["']([^"']*/deps/${file.replace('.', '\\.')}\\?v=\\w+)["']`).exec(code)?.[1];
  assert.ok(url, `${name}.js imports no optimized ${file}:\n${code}`);
  return url;
}

test('two dev servers with different dependency hashes keep each other’s optimized dependencies', async () => {
  const dir = `test-results/vite-cache-isolation-${process.pid}`,
    pageA = fixture(dir, 'a', 'react'),
    pageB = fixture(dir, 'b', 'react-dom');
  let a, b;
  try {
    a = await startDevServer({ startPath: pageA, port: 0 });
    const reactUrl = await optimizedUrl(a.server, dir, 'a', 'react.js');
    // A has optimized react; its page has not fetched it yet.
    await until(() => existsSync(join(a.server.config.cacheDir, 'deps/react.js')), 'the first optimization');
    // Another suite starts: other aliases change Vite's dependency hash as another root does, so it re-optimizes.
    b = await startDevServer({ startPath: pageB, aliases: { 'another-suite': '/nowhere' }, port: 0 });
    await optimizedUrl(b.server, dir, 'b', 'react-dom.js');
    await until(() => {
      const metadata = join(b.server.config.cacheDir, 'deps/_metadata.json');
      return existsSync(metadata) && 'react-dom' in JSON.parse(readFileSync(metadata, 'utf8')).optimized;
    }, 'the second optimization');
    const response = await fetch(`${origin(a.server)}${reactUrl}`);
    assert.equal(response.status, 200, `the first page's react was lost: ${response.status} ${response.statusText}`);
    assert.match(await response.text(), /react/i);
    assert.notEqual(a.cacheDir, b.cacheDir);
  } finally {
    await a?.close();
    await b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!existsSync(a.cacheDir) && !existsSync(b.cacheDir), 'close() removes the server’s cache');
});

test('each dev server caches under DEV_CACHE_ROOT; a killed run’s folder is removed by the next start', async () => {
  const gone = spawnSync(process.execPath, ['-e', '0']).pid,
    left = join(DEV_CACHE_ROOT, `${gone}-killed`);
  mkdirSync(join(left, 'deps'), { recursive: true });
  const running = join(DEV_CACHE_ROOT, `${process.pid}-running`);
  mkdirSync(running, { recursive: true });
  const dev = await startDevServer({ startPath: '/LICENSE', port: 0 });
  try {
    assert.equal(resolve(dev.server.config.cacheDir), resolve(dev.cacheDir));
    assert.ok(resolve(dev.cacheDir).startsWith(realpathSync.native(DEV_CACHE_ROOT)));
    assert.ok(!existsSync(left), 'the folder of a process that is gone is removed');
    assert.ok(existsSync(running), 'a live process’s folder stays');
  } finally {
    await dev.close();
    rmSync(running, { recursive: true, force: true });
  }
});

test('a failed start removes its cache folder', async () => {
  const broken = {
    name: 'broken',
    configureServer() {
      throw new Error('broken plugin');
    },
  };
  await assert.rejects(startDevServer({ startPath: '/LICENSE', port: 0, plugins: [broken] }), /broken plugin/);
  assert.deepEqual(
    readdirSync(DEV_CACHE_ROOT).filter((name) => name.startsWith(`${process.pid}-`)),
    [],
    'no cache folder of this process is left',
  );
});

// The failed start left Vite's two file system watches open (FSEventWrap): every test of this file passed and then
// the process never exited, until the gate's 1500 s limit killed it. A process that only makes a failed start must
// exit by itself.
test('a failed start leaves nothing open, so its process exits', () => {
  const browser = pathToFileURL(resolve('scripts/browser.js')).href,
    script = `
      const { startDevServer } = await import(${JSON.stringify(browser)});
      const broken = { name: 'broken', configureServer() { throw new Error('broken plugin'); } };
      await startDevServer({ startPath: '/LICENSE', port: 0, plugins: [broken] }).catch(() => {});
      setTimeout(() => {
        console.log('still open: ' + process.getActiveResourcesInfo().join(', '));
        process.exit(3);
      }, 20_000).unref();`;
  // wall-clock: a bound on a hang, far from the about 1 s a clean exit takes.
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `the process did not exit by itself: ${run.stdout}${run.stderr}`);
});

// A checkout prepared by an obsolete shared-dependency setup can still link mutable caches. Refuse it so two Vite
// servers never share cache output.
test('this checkout’s tool caches are its own, not links to another checkout’s', () => {
  for (const name of ['.vite', '.vite-temp', '.cache']) {
    const path = resolve('node_modules', name);
    if (!existsSync(path)) continue;
    assert.ok(
      !lstatSync(path).isSymbolicLink(),
      `node_modules/${name} links to another checkout's cache; replace the shared node_modules with npm ci in this checkout`,
    );
  }
});

// check:fresh-clone clones into os.tmpdir(), a Windows short (8.3) path on this PC (C:\Users\RUNNER~1\...), and Vite
// answered 403 for every file there until startDevServer served the working directory's real path.
test('a checkout reached through a Windows short path serves its pages', () => {
  const dir = `test-results/vite-short-path-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.js'), 'export default 1;\n');
  const cwd =
    process.platform === 'win32'
      ? execFileSync('cmd', ['/d', '/c', 'for %I in (.) do @echo %~sI'], { encoding: 'utf8' }).trim()
      : process.cwd();
  const browser = pathToFileURL(resolve('scripts/browser.js')).href,
    script = `
      const { startDevServer } = await import(${JSON.stringify(browser)});
      const dev = await startDevServer({ startPath: '/LICENSE', port: 0 });
      const port = dev.server.httpServer.address().port;
      const response = await fetch('http://127.0.0.1:' + port + '/${dir}/page.js');
      console.log(String(response.status));
      await dev.close();`;
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' });
    assert.equal(run.stdout.trim(), '200', `served from ${cwd}: ${run.stdout}${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
