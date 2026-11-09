import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
const server = await createServer({
  configFile: false,
  // This suite serves only its middleware page, not the repository's unrelated HTML entries.
  optimizeDeps: { entries: [] },
  plugins: [
    {
      name: 'wfc-test-page',
      configureServer(server) {
        server.middlewares.use('/c69', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>WFC backend checks</title>');
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0] + 'c69');
  const result = await page.evaluate(async () => {
    const { OverlappingModel } = await import('/packages/wfc/dist/overlapping.js');
    const { ConstrainedWFC } = await import('/packages/wfc/dist/constraints.js');
    const outputs = [];
    for (const route of ['webgpu', 'webgl2']) {
      const canvas = document.createElement('canvas');
      let device;
      if (route === 'webgpu') {
        device = await (await navigator.gpu.requestAdapter()).requestDevice();
        device.pushErrorScope('validation');
        canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      } else if (!canvas.getContext('webgl2')) throw new Error('Missing WebGL2');
      const m = new OverlappingModel({ data: [0, 0, 0, 0], width: 2, height: 2 }, { N: 2 });
      const image = m.solve(8, 8, { pins: [{ position: [7, 7], value: 0 }], ground: { value: 0, rows: 2 } });
      const ids = [0, 1];
      const global = new ConstrainedWFC(
        [4, 3, 1],
        ids.map(() => ({ neighbors: Array.from({ length: 6 }, () => ids) })),
        {
          connected: [1],
          counts: [{ tiles: [1], min: 8, max: 8 }],
          paths: [{ from: [0, 0, 0], to: [3, 2, 0], tiles: [1] }],
        },
      ).solve({ seed: 7 });
      if (global[0] !== 1 || global[11] !== 1 || [...global].filter((t) => t === 1).length !== 8)
        throw new Error('Global constraints failed');
      let failed = false;
      try {
        m.solve(8, 8, { pins: [{ position: [7, 7], value: 1 }], attempts: 1 });
      } catch (e) {
        failed = e.code === 'failed' && /https:/.test(e.message);
      }
      if (!failed) throw new Error('Unsatisfiable pin accepted');
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        device.destroy();
      }
      outputs.push({ route, image: [...image], global: [...global] });
    }
    return outputs;
  });
  assert.deepEqual(result[0].image, Array(64).fill(0));
  assert.deepEqual(result[1].image, result[0].image);
  assert.deepEqual(result[1].global, result[0].global);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ routes: result.map((r) => r.route), pixels: 64, errors: 0 }));
} finally {
  await closeAll({ browser, servers: [server] });
}
