// Decode JPEG in a module worker, then upload and read back its pixels on both GPU backends.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, logLevel: 'error', server: { port: 0 } });
await server.listen();
let browser;
try {
  browser = await launchBrowser({ headless: true });
  for (const backend of ['webgpu', 'webgl2']) {
    const page = await browser.newPage();
    try {
      if (backend === 'webgl2') await page.addInitScript(compatShim, compatUrl());
      await page.goto(`${server.resolvedUrls.local[0]}package.json`);
      const result = await page.evaluate(async () => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter; run on a GPU-enabled browser');
        const device = await adapter.requestDevice();
        const errors = [];
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const source = `import {decodeImage} from ${JSON.stringify(new URL('/packages/decoders/dist/image.js', location.href).href)};
          self.onmessage = async ({data}) => {
            try { const image = await decodeImage(data); self.postMessage(image, [image.data.buffer]); }
            catch (error) { self.postMessage({error: error.message}); }
          };`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url, { type: 'module' });
        let checked = 0;
        try {
          for (const name of ['baseline-420', 'progressive-420']) {
            const bytes = await (await fetch(`/packages/exporters/tests/fixtures/jpeg/${name}.jpg`)).arrayBuffer();
            const image = await new Promise((resolve, reject) => {
              worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
              worker.onerror = reject;
              worker.postMessage(new Uint8Array(bytes), [bytes]);
            });
            const { width, height, data } = image;
            const stride = Math.ceil((width * 4) / 256) * 256;
            const texture = device.createTexture({
              size: [width, height],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
            });
            const output = device.createBuffer({
              size: stride * height,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            try {
              device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 4 }, [width, height]);
              const encoder = device.createCommandEncoder();
              encoder.copyTextureToBuffer({ texture }, { buffer: output, bytesPerRow: stride }, [width, height]);
              device.queue.submit([encoder.finish()]);
              await output.mapAsync(GPUMapMode.READ);
              const pixels = new Uint8Array(output.getMappedRange());
              for (let y = 0; y < height; y++)
                for (let x = 0; x < width * 4; x++) {
                  if (pixels[y * stride + x] !== data[y * width * 4 + x])
                    throw new Error(`${name}: GPU pixel differs at ${x},${y}`);
                  checked++;
                }
              output.unmap();
            } finally {
              texture.destroy();
              output.destroy();
            }
          }
          await device.queue.onSubmittedWorkDone();
          return { checked, errors };
        } finally {
          worker.terminate();
          URL.revokeObjectURL(url);
          device.destroy();
        }
      });
      assert.deepEqual(result.errors, []);
      assert.ok(result.checked > 0);
      console.log(`JPEG worker pixels: ${backend}, ${result.checked} channels exact`);
    } finally {
      await page.close();
    }
  }
} finally {
  await closeAll({ browser, servers: [server] });
}
