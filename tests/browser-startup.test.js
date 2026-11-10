import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let current;
mock.module('vite', { namedExports: { createServer: async () => current.server } });
mock.module('@playwright/test', {
  namedExports: {
    chromium: { launch: async () => current.browser },
    firefox: {},
    webkit: { launch: async () => current.browser },
  },
});
// The event log lookup of scripts/support/driver-resets.mjs, replaced: these runs must not read this PC's real log.
const resets = await import('../scripts/support/driver-resets.mjs');
mock.module('../scripts/support/driver-resets.mjs', {
  namedExports: { ...resets, driverResets: () => current.resets ?? [] },
});
const { openBrowser } = await import('../scripts/browser.js');

function fixture(failures) {
  const result = { probes: 0, waits: 0, browserCloses: 0, serverCloses: 0, reload: null, initScripts: [] };
  const hardware = {
    webglRenderer: process.env.GPU_VENDOR ?? 'test',
    webgpu: { vendor: process.env.GPU_VENDOR?.toLowerCase() ?? 'test', fallback: false },
  };
  const socket = {
    on(event, callback) {
      if (event === 'framereceived') result.reload = callback;
    },
  };
  result.console = [];
  result.page = {
    on(event, callback) {
      if (event === 'websocket') callback(socket);
      if (event === 'console') result.console.push(callback);
    },
    // A ready flag that never comes: only the timeout (or a device loss) ends the wait.
    waitForFunction(_fn, _arg, { timeout = 30000 } = {}) {
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout ${timeout}ms exceeded.`)), timeout).unref(),
      );
    },
    setDefaultTimeout() {},
    async addInitScript(script) {
      result.initScripts.push(script);
    },
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
  // The WGSL compile guard, the device-loss guard (scripts/support/device-loss.js) and the pipeline counter
  // (scripts/support/gpu-ready.js) are installed before the first navigation.
  assert.deepEqual(
    state.initScripts.map((f) => f.name),
    ['wgslGuard', 'deviceLossGuard', 'trackPipelines'],
  );
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

// Bug 25 (2026-10-27): a GPU reset took a page's WebGPU device and the check waited out its whole ready timeout (30 s,
// 120 s for a site view) with no word about the GPU. Now the page's report of the loss ends the wait at once.
test('a WebGPU device the driver takes away fails the page wait at once, naming the loss', async () => {
  const state = fixture([]);
  // What the Windows event log holds two seconds later: the NVIDIA driver's reset.
  state.resets = [
    { at: '2026-10-27T13:53:31.000Z', source: 'nvlddmkm', id: '153', detail: 'Error occurred on GPUID: 100' },
  ];
  const session = await openBrowser();
  const t0 = performance.now(),
    waiting = session.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const message = {
    text: () =>
      `[gpu] lost ${JSON.stringify({ reason: 'unknown', message: 'D3D12 device removed (DXGI_ERROR_DEVICE_HUNG)', at: '2026-10-27T13:53:29.000Z' })}`,
  };
  for (const listener of state.console) listener(message);
  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, 'gpu-device-lost');
    assert.match(
      error.message,
      /WebGPU device was lost at .* \(reason "unknown": D3D12 device removed \(DXGI_ERROR_DEVICE_HUNG\)\)/,
    );
    // Windows: the reset itself is named, from the event log. Elsewhere there is no such log to read.
    if (process.platform === 'win32')
      assert.match(error.message, /the GPU driver reset the GPU \(.*nvlddmkm event 153 at \d\d:\d\d:31\)/);
    else assert.match(error.message, /a GPU reset/);
    return true;
  });
  // wall-clock: the bound tells a failure at once from the 30 s timeout.
  assert.ok(performance.now() - t0 < 15_000, 'failed at once, not at the 30 s timeout');
  assert.equal(session.deviceLoss.losses.length, 1);
  // A later wait fails the same way: the run is not trusted once its device has gone.
  await assert.rejects(
    session.page.waitForFunction(() => true, null, { timeout: 30000 }),
    { code: 'gpu-device-lost' },
  );
  await session.close();
});

test('a MARGO_BROWSER=webkit run names webkit as its browser, not chromium', async () => {
  const previous = process.env.MARGO_BROWSER;
  process.env.MARGO_BROWSER = 'webkit';
  try {
    fixture([]);
    const session = await openBrowser();
    assert.equal(session.hardware.browserName, 'webkit');
    await session.close();
  } finally {
    if (previous === undefined) delete process.env.MARGO_BROWSER;
    else process.env.MARGO_BROWSER = previous;
  }
});
