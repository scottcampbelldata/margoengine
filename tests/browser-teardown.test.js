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
import { launchBrowser, withBoundedClose } from '../scripts/lib/browser.mjs';
import { closeAll, endTree, taskkillPids } from '../scripts/support/shutdown.mjs';

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
  assert.match(launcher, /withBoundedClose\(await launchers\[browser\.engine\]\.launch/);
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

test('a Chromium browser has its processes ended before the close, whose own shutdown a busy machine starves', async () => {
  // Headless Edge shuts down on low-priority threads: its graceful close took 68 to 146 s beside CPU hogs and failed the
  // 30 s budget. Here the close only finishes once the process tree has been ended, so a graceful wait cannot pass.
  const steps = [];
  let ended;
  const treeEnded = new Promise((resolve) => (ended = resolve));
  const fake = {
    browserType: () => ({ name: () => 'chromium' }),
    isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: async (method) => {
        steps.push(method);
        return {
          processInfo: [
            { type: 'renderer', id: 2 },
            { type: 'browser', id: 1 },
          ],
        };
      },
    }),
    close: async () => {
      await treeEnded;
      steps.push('close');
    },
  };
  await withBoundedClose(fake, {
    end: async (pid) => {
      steps.push(`end ${pid}`);
      ended();
      return [];
    },
  }).close();
  assert.deepEqual(steps, ['SystemInfo.getProcessInfo', 'end 1', 'close']);
});

test('Firefox and a browser already gone close the ordinary way', async () => {
  for (const fake of [
    { browserType: () => ({ name: () => 'firefox' }), isConnected: () => true },
    { browserType: () => ({ name: () => 'chromium' }), isConnected: () => false },
  ]) {
    let closed = false;
    fake.close = async () => (closed = true);
    await withBoundedClose(fake, { end: () => assert.fail('nothing to end') }).close();
    assert.equal(closed, true);
  }
});

test('a real browser: close ends its main process and everything under it', { timeout: 5 * 60_000 }, async () => {
  const browser = await launchBrowser({ headless: true, needs: 'none' });
  const session = await browser.newBrowserCDPSession();
  const pids = (await session.send('SystemInfo.getProcessInfo')).processInfo.map((process) => process.id);
  assert.ok(pids.length > 1);
  await browser.close();
  const alive = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(alive, []);
});

test('endTree waits for every process taskkill named, and returns the ones past the limit', async () => {
  let polls = 0;
  const gone = await endTree(1, {
    kill: async () => [11, 12],
    alive: (pid) => pid === 12 && ++polls < 3,
  });
  assert.deepEqual(gone, []);
  assert.equal(polls, 3, 'it kept asking until the last process was gone');
  const left = await endTree(1, { kill: async () => [13], alive: () => true, waitMs: 20 });
  assert.deepEqual(left, [13]);
});

test('the pids come from taskkill lines, never the parent it names', () => {
  assert.deepEqual(
    taskkillPids(
      'SUCCESS: The process with PID 95380 (child process of PID 55468) has been terminated.\r\nSUCCESS: The process with PID 55468 (child process of PID 102216) has been terminated.\r\n',
    ),
    [95380, 55468],
  );
  assert.deepEqual(taskkillPids(''), []);
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
