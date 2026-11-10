// Real worker decode, half-float texture upload and GPU readback on each backend.
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
        const { KTX2HDR6Decoder } = await import('/packages/decoders/dist/ktx2-hdr6.js');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter');
        const device = await adapter.requestDevice();
        const errors = [];
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const decoder = new KTX2HDR6Decoder({ device, workerLimit: 1 });
        let checked = 0;
        try {
          for (const name of ['astc-real', 'intermediate-real', 'intermediate-legacy-real']) {
            const bytes = await (await fetch(`/packages/decoders/tests/fixtures/ktx2-hdr6/${name}.ktx2`)).arrayBuffer();
            const image = await decoder.decode(bytes);
            const { width, height } = image;
            const data = image.mipmaps[0].data;
            const stride = Math.ceil((width * 8) / 256) * 256;
            const texture = await decoder.createTexture(bytes, {
              usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
            });
            const output = device.createBuffer({
              size: stride * height,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            try {
              const command = device.createCommandEncoder();
              command.copyTextureToBuffer({ texture }, { buffer: output, bytesPerRow: stride }, [width, height]);
              device.queue.submit([command.finish()]);
              await output.mapAsync(GPUMapMode.READ);
              const pixels = new Uint8Array(output.getMappedRange());
              for (let y = 0; y < height; y++)
                for (let x = 0; x < width * 8; x++) {
                  if (pixels[y * stride + x] !== data[y * width * 8 + x])
                    throw new Error(`${name}: half-float GPU readback differs at byte ${x}, row ${y}`);
                  checked++;
                }
              output.unmap();
            } finally {
              output.destroy();
              texture.destroy();
            }
          }
          await device.queue.onSubmittedWorkDone();
          return { checked, errors };
        } finally {
          decoder.dispose();
          device.destroy();
        }
      });
      assert.equal(result.checked, 3 * 128 * 128 * 8);
      assert.deepEqual(result.errors, []);
      console.log(`${backend}: HDR6 worker and ${result.checked} half-float bytes verified`);
    } finally {
      await page.close();
    }
  }
} finally {
  await closeAll({ browser, servers: [server] });
}
