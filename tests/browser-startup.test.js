import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let current;
mock.module('vite', { namedExports: { createServer: async () => current.server } });
mock.module('@playwright/test', {
  namedExports: {
    chromium: { launch: async () => current.browser },
    firefox: {},
    webkit: {},
  },
});
const { openBrowser } = await import('../scripts/browser.js');

function fixture(failures) {
  const result = { probes: 0, waits: 0, browserCloses: 0, serverCloses: 0, reload: null };
  const hardware = {
    webglRenderer: process.env.GPU_VENDOR ?? 'test',
    webgpu: { vendor: process.env.GPU_VENDOR?.toLowerCase() ?? 'test', fallback: false },
  };
  const socket = {
    on(event, callback) {
      if (event === 'framereceived') result.reload = callback;
    },
  };
  result.page = {
    on(event, callback) {
      if (event === 'websocket') callback(socket);
    },
    setDefaultTimeout() {},
    async goto() {},
    async waitForLoadState(state) {
      assert.equal(state, 'load');
      result.waits++;
    },
    async evaluate() {
      const failure = failures[result.probes++];
      if (failure?.reload) result.reload?.({ payload: JSON.stringify({ type: 'full-reload', path: '*' }) });
      if (failure?.error) throw failure.error;
      return hardware;
    },
  };
  result.server = {
    config: { server: { port: 5193 } },
    async listen() {},
    async close() {
      result.serverCloses++;
    },
    async waitForRequestsIdle() {},
  };
  result.browser = {
    async newPage() {
      return result.page;
    },
    version() {
      return 'test';
    },
    async close() {
      result.browserCloses++;
    },
  };
  current = result;
  return result;
}

const navigation = () =>
  new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
test('startup hardware probing waits through a confirmed Vite dependency reload', async () => {
  const state = fixture([{ reload: true, error: navigation() }]);
  const session = await openBrowser();
  assert.equal(state.probes, 2);
  assert.equal(state.waits, 1);
  assert.equal(session.page, state.page);
  await session.close();
  assert.equal(state.browserCloses, 1);
  assert.equal(state.serverCloses, 1);
});

test('startup never retries unrelated navigation or GPU failures', async () => {
  for (const failure of [
    { error: navigation() },
    { reload: true, error: new Error('Adapter initialization failed') },
  ]) {
    const state = fixture([failure]);
    await assert.rejects(openBrowser(), (error) => error === failure.error);
    assert.equal(state.probes, 1);
    assert.equal(state.waits, 0);
    assert.equal(state.browserCloses, 1);
    assert.equal(state.serverCloses, 1);
  }
});

test('repeated Vite reloads cannot hide a permanently unstable startup', async () => {
  const failure = { reload: true, error: navigation() },
    state = fixture([failure, failure, failure]);
  await assert.rejects(openBrowser(), (error) => error === failure.error);
  assert.equal(state.probes, 3);
  assert.equal(state.waits, 2);
  assert.equal(state.browserCloses, 1);
  assert.equal(state.serverCloses, 1);
});
