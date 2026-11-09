// Bug 30: `modern:test:browser:slow-compile` passed every assertion and then never exited. The suite closed its Vite
// preview server (`httpServer.close(callback)`) while the browser still held connections to it; that callback waits
// for every connection, so the browser, closed after it, was never closed. scripts/support/shutdown.mjs closes the
// browser first, drops the server's connections, kills the child trees, and throws a coded error past its budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { closeAll, waitSignaled } from '../scripts/support/shutdown.mjs';

// A server that answers with headers and never ends the body (an event stream, an HMR socket): a non-idle connection.
async function streamingServer() {
  const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).write(':\n\n'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
// The "browser": a client that stays connected until told to stop.
function connect(server) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port }, (res) => {
      res.on('data', () => {});
      res.on('error', () => {});
      resolve({ stop: () => req.destroy() });
    });
    req.on('error', () => {});
    req.on('error', reject);
    req.end();
  });
}

test('the old order (server closed while a client is connected) does not finish', async () => {
  const server = await streamingServer(),
    client = await connect(server);
  try {
    const closed = await Promise.race([
      new Promise((resolve) => server.close(() => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(closed, false, 'server.close called back with a client still connected');
  } finally {
    client.stop();
    server.closeAllConnections();
  }
});

test('closeAll finishes in under 2 s with a client still connected to the server', async () => {
  const server = await streamingServer(),
    client = await connect(server),
    begun = Date.now();
  try {
    await closeAll({ servers: [server], budgetMs: 1900 });
    // wall-clock: closeAll holds the 1900 ms budget itself and fails past it; this tells that from a hang.
    assert.ok(Date.now() - begun < 15_000);
    assert.equal(server.listening, false);
  } finally {
    client.stop();
  }
});

test('closeAll closes the context, then the browser, then the servers', async () => {
  const calls = [],
    server = await streamingServer(),
    context = { close: async () => calls.push('context') },
    browser = { close: async () => calls.push('browser') };
  const close = server.close.bind(server);
  server.close = (callback) => (calls.push('server'), close(callback));
  await closeAll({ context, browser, servers: [server] });
  assert.deepEqual(calls, ['context', 'browser', 'server']);
});

test('closeAll kills a child process and releases its pipes', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }),
    exited = new Promise((resolve) => child.once('exit', resolve));
  await closeAll({ children: [child] });
  await exited;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(child.stdout.destroyed, true);
});

test('closeAll runs every step when one fails, then throws that failure', async () => {
  const calls = [],
    failure = new Error('context failed');
  await assert.rejects(
    closeAll({
      context: {
        close: async () => {
          throw failure;
        },
      },
      browser: { close: async () => calls.push('browser') },
    }),
    failure,
  );
  assert.deepEqual(calls, ['browser']);
});

test('past its budget closeAll throws SHUTDOWN_TIMEOUT naming what is still open', async () => {
  const stuck = { close: () => new Promise(() => {}) };
  const error = await closeAll({ browser: stuck, budgetMs: 200 }).then(
    () => assert.fail('closeAll resolved with a browser that never closes'),
    (thrown) => thrown,
  );
  assert.equal(error.code, 'SHUTDOWN_TIMEOUT');
  assert.deepEqual(error.open, ['browser']);
  assert.match(error.message, /still open: browser/);
});

test('a Vite-style server (httpServer plus its own close) is closed once, with a client connected', async () => {
  const http = await streamingServer(),
    client = await connect(http);
  let closes = 0;
  const wrapper = {
    httpServer: http,
    close: () =>
      new Promise((resolve, reject) => (closes++, http.close((error) => (error ? reject(error) : resolve())))),
  };
  try {
    await closeAll({ servers: [wrapper], budgetMs: 1900 });
    assert.equal(closes, 1);
    assert.equal(http.listening, false);
  } finally {
    client.stop();
  }
});

// A suite script that has finished its last step: `leak` keeps a server listening, as a handle a teardown missed would.
const finished = (leak) => {
  const shutdown = new URL('../scripts/support/shutdown.mjs', import.meta.url).href;
  return `import { watchExit } from ${JSON.stringify(shutdown)}; import { createServer } from 'node:http';
${leak ? "createServer().listen(0, '127.0.0.1');" : ''} console.log('ok suite'); watchExit(300);`;
};
const runScript = (source) =>
  new Promise((resolve) => {
    const begun = Date.now(),
      child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const limit = setTimeout(() => child.kill(), 10_000);
    child.on('close', (code) => (clearTimeout(limit), resolve({ code, err, ms: Date.now() - begun })));
  });

// Regression: biomes test:gpu on an Intel Arc laptop printed every check OK and then sat until the runner killed it after
// 600 s, with nothing to say what was still open. A suite that does not exit after its last step now names it.
test('watchExit ends a finished suite that something holds open, naming what', async () => {
  const { code, err, ms } = await runScript(finished(true));
  assert.equal(code, 1, err);
  assert.match(err, /did not exit within 300 ms; still open: .*TCPServerWrap/);
  // wall-clock: the child is killed at 10 s if nothing ends it.
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test('watchExit never holds a suite that ends cleanly', async () => {
  const { code, err, ms } = await runScript(finished(false));
  assert.equal(code, 0, err);
  assert.equal(err, '');
  // wall-clock: the child is killed at 10 s if the watch holds it.
  assert.ok(ms < 5000, `took ${ms} ms`);
});


test('a native process waiter that cannot start or fails proves no process has exited', async () => {
  for (const error of [{ code: 'ENOENT' }, { code: 1 }, { killed: true }]) {
    const result = await waitSignaled([11, 12], 50, Date.now(), (_file, _args, options, callback) => {
      assert.equal(options.windowsHide, true);
      callback(error, '');
    });
    assert.deepEqual(result, [11, 12], 'an empty failed response must not mean all processes exited');
  }
  assert.deepEqual(await waitSignaled([11, 12], 50, Date.now(), (_f, _a, _o, callback) => callback(null, '12\r\n')), [12]);
});


test('a native waiter reports an already absent process as successful completion', { timeout: 10000 }, async () => {
  if (process.platform !== 'win32') return;
  // Windows process IDs are multiples of four; this positive ID cannot name a process.
  assert.deepEqual(await waitSignaled([2147483647], 2000, Date.now()), []);
});
