// GPU suites share the GPU (scripts/gpu-lock.mjs), so two of them can want the same fixed port at once: the second
// one's server waits for the port (listenWhenFree in scripts/browser.js) instead of failing with "Port N is already in
// use", which the first real two-suite run under shared slots hit (sky and shader both on 5211).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'vite';
import { listenWhenFree } from '../scripts/browser.js';

const occupy = () =>
  new Promise((resolve) => {
    const blocker = createNetServer();
    blocker.listen(0, '127.0.0.1', () => resolve(blocker));
  });
const quiet = () => {};

test('a Vite server on a port another suite holds starts once that suite lets the port go', async () => {
  const blocker = await occupy(),
    { port } = blocker.address();
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false },
  });
  try {
    const messages = [];
    const started = listenWhenFree(() => server.listen(), { port, poll: 50, log: (m) => messages.push(m) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(server.httpServer.listening, false, 'it waits while the port is held');
    assert.match(messages.join('\n'), new RegExp(`port ${port} is in use`));
    await new Promise((resolve) => blocker.close(resolve));
    await started;
    assert.equal(server.httpServer.listening, true);
    assert.equal(server.httpServer.address().port, port);
  } finally {
    await server.close();
    blocker.close();
  }
});

test('past its wait limit it fails naming the port; other errors are not waited on', async () => {
  const blocker = await occupy(),
    { port } = blocker.address();
  try {
    const inUse = () =>
      Promise.reject(Object.assign(new Error(`listen EADDRINUSE 127.0.0.1:${port}`), { code: 'EADDRINUSE' }));
    await assert.rejects(listenWhenFree(inUse, { port, waitMs: 100, poll: 20, log: quiet }), (error) =>
      error.message.includes(`port ${port} stayed in use`),
    );
    let calls = 0;
    const broken = () => {
      calls++;
      return Promise.reject(new Error('bad config'));
    };
    await assert.rejects(listenWhenFree(broken, { port, poll: 20, log: quiet }), /bad config/);
    assert.equal(calls, 1);
  } finally {
    blocker.close();
  }
});
