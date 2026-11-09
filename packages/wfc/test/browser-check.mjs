import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
const server = await createServer({
  configFile: false,
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
await server.listen();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0] + 'c69');
  const result = await page.evaluate(async () => {
    const { OverlappingModel } = await import('/packages/wfc/dist/overlapping.js');
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
      outputs.push({ route, image: [...image] });
    }
    return outputs;
  });
  assert.deepEqual(result[0].image, Array(64).fill(0));
  assert.deepEqual(result[1].image, result[0].image);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ routes: result.map((r) => r.route), pixels: 64, errors: 0 }));
} finally {
  await browser.close();
  await server.close();
}
