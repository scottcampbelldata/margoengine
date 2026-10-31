// GPU suites share the GPU (scripts/gpu-lock.mjs), so two of them can want the same fixed port at once: the second
// one's server waits for the port (listenWhenFree in scripts/browser.js) instead of failing with "Port N is already in
// use", which the first real two-suite run under shared slots hit (sky and shader both on 5211).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { freePort, listenWhenFree, startDevServer } from '../scripts/browser.js';

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
    const said = new RegExp(`port ${port} is in use`);
    for (const end = Date.now() + 30_000; !said.test(messages.join('\n')); await new Promise((r) => setTimeout(r, 10)))
      assert.ok(Date.now() < end, 'it says the port is in use');
    // fixed-wait: several polls of 50 ms pass with the port held and nothing may listen
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(server.httpServer.listening, false, 'it waits while the port is held');
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

// Bug 38 (2026-10-27): voxel-pathtracer's 5-second spec-math check sat 265 s in listenWhenFree behind another helper's
// 7-minute run of the same suite on its fixed port 5223, and the harness killed it as hung at its 10 minute limit.
test("port: 'free' starts at once while another suite holds a fixed port, on a port of its own", async () => {
  const blocker = await occupy(),
    held = blocker.address().port;
  const first = await startDevServer({ port: 'free' }),
    second = await startDevServer({ port: 'free' });
  try {
    const ports = [first, second].map((s) => s.server.httpServer.address().port);
    assert.notEqual(ports[0], ports[1]);
    assert.ok(!ports.includes(held), 'a port someone else holds is never picked');
    assert.equal(first.server.config.server.port, ports[0], 'the page opens the port the server listens on');
    assert.ok((await freePort()) > 0);
  } finally {
    await first.close();
    await second.close();
    blocker.close();
  }
});

test('the voxel-pathtracer browser suite, whose three scripts share one file, takes a free port', () => {
  const source = readFileSync(new URL('../packages/voxel-pathtracer/tests/browser-check.mjs', import.meta.url), 'utf8');
  assert.match(source, /port = 'free'/);
  assert.doesNotMatch(source, /port = 5\d{3}/);
});
