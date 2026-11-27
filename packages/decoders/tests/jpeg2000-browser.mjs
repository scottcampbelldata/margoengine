// `@margoengine/decoders/jpeg2000` in a browser: module workers decode the OpenJPEG vectors to their pixels, alone and
// through `decodeImage`, the samples upload to a texture and read back unchanged, the headers that ask for far too much
// come back as coded errors from the worker, and an abort ends a decode in progress. On WebGPU and the WebGL2 layer.
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/decoders/tests/jpeg2000-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { fuzzCases, vectors } from './support/jpeg2000-fuzz.js';

const all = vectors().map(({ file, pixels, lossless }) => ({ file, pixels, lossless }));
const hostile = [...fuzzCases({ mutations: 0 })]
  .filter(({ name }) => !/ cut to /.test(name))
  .map(({ name, bytes }) => ({ name, bytes: [...bytes] }));

const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
let browser;
try {
  browser = await launchBrowser({ headless: true });
  for (const backend of ['webgpu', 'webgl2']) {
    const page = await browser.newPage();
    try {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
      page.setDefaultTimeout(120000);
      if (backend === 'webgl2') await page.addInitScript(compatShim, compatUrl());
      await page.goto(`${server.resolvedUrls.local[0]}package.json`);
      const result = await page.evaluate(
        async ({ all, hostile }) => {
          const { JPEG2000Decoder } = await import('/packages/decoders/dist/jpeg2000.js');
          const { decodeImage, imageFormat } = await import('/packages/decoders/dist/image.js');
          const { decodePNG } = await import('/packages/decoders/dist/png.js');
          const adapter = await navigator.gpu.requestAdapter();
          if (!adapter) throw new Error('No GPU adapter');
          const device = await adapter.requestDevice();
          const gpuErrors = [];
          device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
          const load = async (name) =>
            new Uint8Array(
              await (await fetch(`/packages/decoders/tests/fixtures/jpeg2000/${name}`)).arrayBuffer(),
            );
          const same = (a, b, what) => {
            if (a.length !== b.length) throw new Error(`${what}: ${a.length} samples against ${b.length}`);
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${what}: sample ${i} differs`);
          };
          const decoder = new JPEG2000Decoder({ workerLimit: 4, timeout: 30000 });
          let uploaded = 0;
          try {
            // Every vector at once, four workers.
            await Promise.all(
              all.map(async ({ file, pixels, lossless }) => {
                const bytes = await load(file);
                const expected = decodePNG(await load(pixels));
                const { width, height, data, truncated } = await decoder.decode(bytes.slice(), { transfer: true });
                if (width !== expected.width || height !== expected.height || truncated)
                  throw new Error(`${file}: ${width} x ${height}, truncated ${truncated}`);
                for (let i = 0; i < data.length; i++)
                  if (Math.abs(data[i] - expected.data[i]) > (lossless ? 0 : 1))
                    throw new Error(`${file}: sample ${i} is ${data[i]}, expected ${expected.data[i]}`);
                if (imageFormat(bytes) !== 'jpeg2000') throw new Error(`${file}: not named`);
                same((await decodeImage(bytes)).data, data, `${file} through decodeImage`);
                const wide = await decoder.decode(bytes, { depth: 16 });
                if (!(wide.data instanceof Uint16Array)) throw new Error(`${file}: depth 16 is not 16 bits`);
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
                  const read = new Uint8Array(output.getMappedRange());
                  for (let y = 0; y < height; y++)
                    same(
                      read.subarray(y * stride, y * stride + width * 4),
                      data.subarray(y * width * 4, (y + 1) * width * 4),
                      `${file} texture row ${y}`,
                    );
                  uploaded += width * height * 4;
                  output.unmap();
                } finally {
                  output.destroy();
                  texture.destroy();
                }
              }),
            );
            // Hostile headers in the worker: a picture or a coded error, never a trap or the time limit.
            const outcomes = {};
            let slow;
            for (const { name, bytes } of hostile) {
              const start = performance.now();
              try {
                await decoder.decode(Uint8Array.from(bytes), { maxPixels: 2 ** 20 });
                outcomes.decoded = (outcomes.decoded ?? 0) + 1;
              } catch (error) {
                const kind = error instanceof RangeError ? 'range' : error.code;
                if (!['range', 'failed', 'unsupported'].includes(kind) || /stopped|timed? ?out|time limit/i.test(error.message))
                  throw new Error(`${name}: ${error.name}: ${error.message}`);
                outcomes[kind] = (outcomes[kind] ?? 0) + 1;
              }
              const took = performance.now() - start;
              if (!slow || took > slow.took) slow = { name, took, bytes };
            }
            // An abort ends the slowest of them in its worker at once, and the pool decodes the next file.
            const controller = new AbortController();
            const pending = decoder.decode(Uint8Array.from(slow.bytes), { maxPixels: 2 ** 20, signal: controller.signal });
            setTimeout(() => controller.abort(), 20);
            const aborted = await pending.then(
              () => 'resolved',
              (error) => error.name,
            );
            const after = await decoder.decode(await load('rgb.jp2'));
            await device.queue.onSubmittedWorkDone();
            return {
              uploaded,
              outcomes,
              aborted,
              after: after.width,
              slowest: `${slow.name}: ${Math.round(slow.took)} ms`,
              gpuErrors,
            };
          } finally {
            decoder.dispose();
            device.destroy();
          }
        },
        { all, hostile },
      );
      assert.equal(result.uploaded, 16 * 61 * 47 * 4);
      assert.equal(result.aborted, 'AbortError', result.slowest);
      assert.equal(result.after, 61);
      assert.deepEqual(result.gpuErrors, []);
      assert.deepEqual(errors, []);
      assert.equal(Object.values(result.outcomes).reduce((a, b) => a + b, 0), hostile.length);
      console.log(
        `${backend}: ${all.length} vectors in workers, ${result.uploaded} texture bytes, ${hostile.length} hostile ` +
          `headers ${JSON.stringify(result.outcomes)}, slowest ${result.slowest}, abort ok`,
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await closeAll({ browser, servers: [server] });
}
