// Bug 30: `modern:test:browser:slow-compile` passed every assertion and then never exited. The suite closed its Vite
// preview server (`httpServer.close(callback)`) while the browser still held connections to it; that callback waits
// for every connection, so the browser, closed after it, was never closed. scripts/support/shutdown.mjs closes the
// browser first, drops the server's connections, kills the child trees, and throws a coded error past its budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { closeAll } from '../scripts/support/shutdown.mjs';

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
    assert.ok(Date.now() - begun < 2000);
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
