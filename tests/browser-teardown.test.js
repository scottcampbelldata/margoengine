// Bug 70: `check:depth` and `check:no-webgpu` passed every assertion and then never exited; the audit had to kill them.
// Bug 30 had fixed the same hang for one suite (scripts/support/shutdown.mjs: browser first, then the servers'
// connections, one bounded budget). This applies it to every script that opens a browser, and fails the build for a
// script that does not: a script that starts a browser and a server of its own must tear both down with `closeAll`, and
// the shared launchers (`launchBrowser`, `openBrowser`, `startDevServer`) bound their own closes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { withBoundedClose } from '../scripts/lib/browser.mjs';
import { closeAll } from '../scripts/support/shutdown.mjs';

const root = new URL('..', import.meta.url);

// A script that starts a browser itself.
const LAUNCH = /\blaunchBrowser\s*\(|\b(?:chromium|firefox|webkit)\.launch\(|launchPersistentContext\(/;
// A script that also starts an HTTP server of its own (openBrowser starts and closes its own, so it is not counted).
const OWN_SERVER = /\bcreateServer\s*\(|\bpreview\s*\(|\.listen\(/;

/** Scripts that start a browser and are not yet on the shared teardown, each with the reason. Only ever shrinks. */
const NOT_YET = new Map([
  [
    'packages/webgl2-compat/scripts/capabilities.mjs',
    'owned by the webgl2-compat work, which has not landed yet; it starts no server of its own',
  ],
  ['python/tests/jupyter-browser.mjs', 'being reworked for bug 68 (the venv interpreter); moves onto closeAll there'],
]);

/** The tracked scripts, tests and tools that start a browser but do not use the shared bounded teardown. */
export function unboundedBrowserScripts(read = (file) => readFileSync(new URL(file, root), 'utf8')) {
  const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs', '*.ts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean);
  const offenders = [];
  for (const file of files) {
    if (/\.test\.js$|(^|\/)node_modules\/|(^|\/)dist\/|^scripts\/lib\/browser\.mjs$|^scripts\/browser\.js$/.test(file))
      continue;
    const source = read(file);
    if (!LAUNCH.test(source) || /shutdown\.mjs/.test(source)) continue;
    const direct = /\b(?:chromium|firefox|webkit)\.launch\(|launchPersistentContext\(/.test(source);
    if (direct || OWN_SERVER.test(source)) offenders.push(file);
  }
  return offenders;
}

test('every script that starts a browser and a server tears both down with closeAll', () => {
  const found = unboundedBrowserScripts().filter((file) => !NOT_YET.has(file));
  assert.deepEqual(
    found,
    [],
    `these scripts start a browser without the bounded teardown; end them with \`await closeAll({ browser, servers: [server] })\` from scripts/support/shutdown.mjs (bug 70):\n  ${found.join('\n  ')}`,
  );
});

test('a script moved onto closeAll leaves the not-yet list', () => {
  const still = new Set(unboundedBrowserScripts());
  const done = [...NOT_YET.keys()].filter((file) => !still.has(file));
  assert.deepEqual(done, [], `${done.join(', ')} now use closeAll: remove them from NOT_YET`);
});

test('the checker finds a script that closes its server while the browser is open', () => {
  const sources = {
    'a.mjs':
      'const browser = await launchBrowser({}); const server = await createServer({}); await browser.close(); await server.close();',
    'b.mjs':
      "import { closeAll } from './scripts/support/shutdown.mjs'; const browser = await launchBrowser({}); const server = createServer(); await closeAll({ browser, servers: [server] });",
    'c.mjs': 'const browser = await chromium.launch({});',
    'd.mjs': "const page = await openBrowser({ startPath: '/x.html' });",
  };
  const hit = Object.entries(sources)
    .filter(([, source]) => LAUNCH.test(source) && !/shutdown\.mjs/.test(source))
    .filter(([, source]) => /\b(?:chromium|firefox|webkit)\.launch\(/.test(source) || OWN_SERVER.test(source))
    .map(([file]) => file);
  assert.deepEqual(hit, ['a.mjs', 'c.mjs']);
});

test('launchBrowser and openBrowser close through the bounded teardown', () => {
  const launcher = readFileSync(new URL('scripts/lib/browser.mjs', root), 'utf8'),
    opener = readFileSync(new URL('scripts/browser.js', root), 'utf8');
  assert.match(launcher, /withBoundedClose\(await launch\(browser\.channel\)\)/);
  assert.match(launcher, /withBoundedClose\(await launchers\.firefox\.launch/);
  assert.match(
    opener,
    /await closeAll\(\{ servers: \[server\] \}\)/,
    'startDevServer drops connections and is bounded',
  );
  assert.match(opener, /await closeAll\(\{ browser \}\)/, 'openBrowser closes the browser bounded');
  assert.doesNotMatch(opener, /^\s*await browser\??\.close\(\);/m, 'no bare browser.close() in openBrowser');
});

test('a browser whose close never finishes makes close() throw SHUTDOWN_TIMEOUT instead of hanging', async () => {
  const hung = withBoundedClose({ close: () => new Promise(() => {}) });
  // The shared budget is 30 s; shorten it for the test by closing through closeAll with the same wrapper.
  const outcome = await Promise.race([
    closeAll({ browser: hung, budgetMs: 200 }).then(
      () => 'finished',
      (error) => error.code,
    ),
    new Promise((resolve) => setTimeout(() => resolve('test timer'), 5000)),
  ]);
  assert.equal(outcome, 'SHUTDOWN_TIMEOUT');
});

test('a browser that closes normally still resolves, and arguments pass through', async () => {
  const calls = [];
  const browser = withBoundedClose({ close: async (...args) => calls.push(args) });
  await browser.close({ reason: 'done' });
  assert.deepEqual(calls, [[{ reason: 'done' }]]);
  assert.equal(withBoundedClose(undefined), undefined);
  assert.deepEqual(withBoundedClose({}), {});
});

test('a server with a connected client is dropped and closed (the case that hung check:depth and check:no-webgpu)', async () => {
  const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).write(':\n\n'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: server.address().port }, (res) => {
      res.on('data', () => {});
      resolve(req);
    });
    req.on('error', () => {});
    req.end();
  });
  await closeAll({ browser: { close: async () => {} }, servers: [server], budgetMs: 5000 });
  assert.equal(server.listening, false);
  client.destroy();
});
