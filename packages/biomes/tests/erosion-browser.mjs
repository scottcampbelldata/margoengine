import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { preview } from 'vite';
import { consumerRoot } from './erosion-consumer.mjs';
import { closeAll, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { openBrowser } from '../../../scripts/browser.js';
import { erode } from '../dist/erosion.js';
const root = consumerRoot;
const built = await preview({ root, configFile: false, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0 } });
let browser;
const errors = [],
  wasm = [];
await runSuite(
  async () => {
    browser = await openBrowser({ port: 'free', compat: false });
    browser.page.on('pageerror', (e) => errors.push(e.message));
    browser.page.on('response', (r) => {
      if (new URL(r.url()).pathname.endsWith('.wasm')) wasm.push(r);
    });
    const port = built.httpServer.address().port;
    await browser.page.goto(`http://127.0.0.1:${port}`);
    await browser.page.waitForFunction(() => window.runErosion);
    assert.equal(wasm.length, 0, 'Wasm must load lazily');
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/erosion-dem-crop.json', import.meta.url)));
    const grid = { height: fixture.height, nx: 16, nz: 16, step: 13000 };
    const expected = erode({ ...grid, height: Int32Array.from(grid.height) });
    const rows = [];
    for (const backend of ['webgpu', 'webgl2']) {
      const result = await browser.page.evaluate(
        async ({ backend, grid }) => {
          const canvas = document.querySelector('canvas');
          canvas.width = canvas.height = 16;
          let device, gl;
          // A new canvas permits a different rendering backend on the same page.
          const surface = document.createElement('canvas');
          surface.width = surface.height = 16;
          document.body.append(surface);
          if (backend === 'webgpu') {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error('WebGPU unavailable');
            device = await adapter.requestDevice();
            const context = surface.getContext('webgpu');
            context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: context.getCurrentTexture().createView(),
                  clearValue: [0.2, 0.4, 0.6, 1],
                  loadOp: 'clear',
                  storeOp: 'store',
                },
              ],
            });
            pass.end();
            device.queue.submit([encoder.finish()]);
            await device.queue.onSubmittedWorkDone();
          } else {
            gl = surface.getContext('webgl2');
            if (!gl) throw new Error('WebGL2 unavailable');
            gl.clearColor(0.2, 0.4, 0.6, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.finish();
            if (gl.getError()) throw new Error('WebGL2 clear failed');
          }
          try {
            return await window.runErosion(grid);
          } finally {
            device?.destroy();
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
            surface.remove();
          }
        },
        { backend, grid },
      );
      for (const field of ['height', 'flow', 'direction', 'wear', 'deposit'])
        assert.deepEqual(result[field], [...expected[field]], `${backend}/${field}`);
      assert.equal(result.outflow, expected.outflow);
      assert.equal(result.blocks, 64);
      rows.push({ backend, cells: 256, allFieldsExact: true });
    }
    assert.equal(wasm.length, 2, 'each factory fetches its feature asset');
    const asset = readdirSync(join(root, 'dist/assets')).find((f) => f.endsWith('.wasm'));
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(
      hash(readFileSync(join(root, 'dist/assets', asset))),
      hash(readFileSync(new URL('../dist/erosion.wasm', import.meta.url))),
    );
    for (const response of wasm) {
      assert.equal(response.status(), 200);
      assert.equal(hash(await response.body()), hash(readFileSync(new URL('../dist/erosion.wasm', import.meta.url))));
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ productionAsset: asset, rows }));
  },
  async () => {
    try {
      await closeAll({ browser, servers: [built] });
    } finally {
      watchExit();
    }
  },
);
