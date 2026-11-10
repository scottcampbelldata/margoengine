import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
const server = await createServer({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  configFile: false,
  plugins: [
    {
      name: 'wfc-assembly-page',
      configureServer(s) {
        s.middlewares.use('/assembly', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><title>WFC assembly</title>');
        });
      },
    },
  ],
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0] + 'assembly');
  const results = await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { assembleWFC } = await import('/packages/wfc/dist/assemble.js');
    const { buildSocketTiles } = await import('/packages/wfc/dist/sockets.js');
    const { install, uninstall } = await import('/packages/webgl2-compat/dist/index.js');
    const out = [];
    for (const route of ['webgpu', 'webgl2-compat']) {
      if (route === 'webgl2-compat') await install({ force: true });
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const e = await Engine.create(canvas);
      const root = e.createMesh(),
        m = e.createMesh(root).setGeometry(box());
      root.visible = false;
      const variants = buildSocketTiles([{ sockets: Array(6).fill('a'), rotations: 'cube' }]);
      const a = assembleWFC(e, [4, 1, 1], [0, 1, 2, 3], variants, [{ root, meshes: [m] }], { origin: [-2, 0, -6] });
      // Templates may be hidden without hiding the placed instances.
      for (const copy of a.meshes) copy.visible = true;
      e.render({ culling: false });
      await new Promise((r) => requestAnimationFrame(r));
      if (e.stats.visible !== 4 || e.stats.drawCalls !== 1)
        throw new Error(`instancing ${route}: ${JSON.stringify(e.stats)}`);
      out.push({ route, visible: e.stats.visible, drawCalls: e.stats.drawCalls });
      a.dispose();
      e.dispose();
      if (route === 'webgl2-compat') uninstall();
    }
    return out;
  });
  assert.equal(results.length, 2);
  console.log(JSON.stringify(results));
} finally {
  await closeAll({ browser, servers: [server] });
}
