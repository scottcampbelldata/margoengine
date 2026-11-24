// KB-SHOT-DOUBLELOAD1: tools/shot opened its browser on the shot's page, then renderOnce loaded it again with the shot's
// query, so the first load's fetches were aborted ("TypeError: Failed to fetch" at a page's fetch) and the scene was
// built twice. openShotPage now opens a blank page of the same origin and the dev server still pre-bundles the shot
// page's imports, so renderOnce's navigation is the page's only load. Vite and Playwright are stand-ins here.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const visits = [],
  servers = [];
const page = {
  on() {},
  setDefaultTimeout() {},
  async addInitScript() {},
  async setViewportSize() {},
  async goto(url) {
    visits.push(new URL(url).pathname);
  },
  async waitForLoadState() {},
  async waitForFunction() {},
  async evaluate() {
    return { webglRenderer: 'test', webgpu: { vendor: 'test', fallback: false }, userAgent: 'test agent' };
  },
};
const browser = { newPage: async () => page, version: () => 'test', close: async () => {} };
mock.module('vite', {
  namedExports: {
    createServer: async (config) => {
      const server = {
        config: { server: { port: 5193 } },
        async listen() {},
        async close() {},
        async waitForRequestsIdle() {},
      };
      // Each plugin's configResolved runs as Vite would, so the entry the start-owner plugin settles on is the one read.
      const resolved = { server: {}, optimizeDeps: { ...config.optimizeDeps } };
      for (const plugin of config.plugins) plugin.configResolved?.(resolved);
      for (const plugin of config.plugins) plugin.configureServer?.(server);
      servers.push(resolved.optimizeDeps.entries);
      return server;
    },
  },
});
mock.module('@playwright/test', {
  namedExports: { chromium: { launch: async () => browser }, firefox: {}, webkit: { launch: async () => browser } },
});
for (const name of ['../scripts/support/driver-resets.mjs', '../scripts/support/windows-session.mjs']) {
  const real = await import(name);
  mock.module(name, { namedExports: { ...real, driverResets: () => [], windowsSession: () => null } });
}
const { openShotPage } = await import('../tools/shot/render.mjs');
const { parseShot } = await import('../tools/shot/shot-file.mjs');

test('openShotPage loads no copy of the shot page: renderOnce navigates to it once, its imports still pre-bundled', async () => {
  const file = parseShot({
    format: 'margo-cutscene',
    version: 1,
    duration: 1,
    tracks: [],
    shot: { format: 'margo-shot', version: 1, id: 'one-load', seconds: 1, page: { path: 'tools/shot/test/scene.html', engine: 'shotScene.engine' } },
  });
  const opened = await openShotPage(file);
  try {
    assert.deepEqual(visits, ['/tools/shot/blank.html'], 'the browser opens on the blank page, not the shot page');
    assert.deepEqual(servers, [['tools/shot/test/scene.html']], "the dev server pre-bundles the shot page's imports");
  } finally {
    await opened.close();
  }
});
