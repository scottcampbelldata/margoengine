// Browser module worker, high precision pixels, and actual GPU upload/readback on both backends.
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
      page.setDefaultTimeout(60000);
      if (backend === 'webgl2') await page.addInitScript(compatShim, compatUrl());
      await page.goto(`${server.resolvedUrls.local[0]}package.json`);
      const result = await page.evaluate(async () => {
        const { AVIFDecoder } = await import('/packages/decoders/dist/avif.js');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter');
        const device = await adapter.requestDevice();
        const errors = [];
        device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        const decoder = new AVIFDecoder({ workerLimit: 1 });
        let checked = 0;
        const digests = [];
        try {
          for (const name of [
            'tools-palette.avif',
            'tools-copy-allintra.avif',
            'tools-grain.avif',
            'tools-superres.avif',
            'fox.profile2.12bpc.yuv420.monochrome.odd-width.odd-height.avif',
          ]) {
            const bytes = await (await fetch(`/packages/decoders/native/avif/tests/fixtures/${name}`)).arrayBuffer();
            const image = await decoder.decode(bytes);
            const { width, height, data } = image;
            const digest = await crypto.subtle.digest('SHA-256', data);
            digests.push(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
            const texture = device.createTexture({
              size: [width, height],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
            });
            const stride = Math.ceil((width * 4) / 256) * 256;
            const output = device.createBuffer({
              size: stride * height,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            try {
              device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 4 }, [width, height]);
              const command = device.createCommandEncoder();
              command.copyTextureToBuffer({ texture }, { buffer: output, bytesPerRow: stride }, [width, height]);
              device.queue.submit([command.finish()]);
              await output.mapAsync(GPUMapMode.READ);
              const pixels = new Uint8Array(output.getMappedRange());
              for (let y = 0; y < height; y++)
                for (let x = 0; x < width * 4; x++) {
                  if (pixels[y * stride + x] !== data[y * width * 4 + x])
                    throw new Error(`${name}: GPU byte ${x}, row ${y} differs`);
                  checked++;
                }
              output.unmap();
            } finally {
              output.destroy();
              texture.destroy();
            }
          }
          const mono = await decoder.decode(
            await (
              await fetch(
                '/packages/decoders/native/avif/tests/fixtures/fox.profile2.12bpc.yuv420.monochrome.odd-width.odd-height.avif',
              )
            ).arrayBuffer(),
            { format: 'rgba16' },
          );
          if (!(mono.data instanceof Uint16Array) || !mono.data.some((v, i) => i % 4 !== 3 && v % 257 !== 0))
            throw new Error('Lost 12-bit source precision');
          await device.queue.onSubmittedWorkDone();
          return { checked, errors, digests };
        } finally {
          decoder.dispose();
          device.destroy();
        }
      });
      assert.equal(result.checked, (128 * 128 * 2 + 1024 * 128 + 256 * 256 + 1203 * 799) * 4);
      assert.deepEqual(result.errors, []);
      // Backends must execute the same worker and produce the same source pixels.
      if (backend === 'webgpu') globalThis.avifDigests = result.digests;
      else assert.deepEqual(result.digests, globalThis.avifDigests);
      console.log(`${backend}: ${result.checked} AVIF worker/GPU bytes verified`);
    } finally {
      await page.close();
    }
  }
} finally {
  await closeAll({ browser, servers: [server] });
}
