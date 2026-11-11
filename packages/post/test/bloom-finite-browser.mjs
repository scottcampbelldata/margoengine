// Real-GPU check (Rust engine port R3): one Inf, one -Inf and one NaN texel in a linear rgba16float image must not
// spread through Bloom. Bloom.encodeImage runs on a 64 x 64 image (grey 0.5, a 4 x 4 block at 8 above the threshold)
// with the bad texels, and again on the clean image (+Inf as 65504, NaN and -Inf as 0, what Bloom reads them as).
// Every output texel must be finite, and every texel at least 8 pixels from a bad one must equal the clean output.
// Before the fix the NaN spread to most of the image through the bilinear taps and the chain.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-bloom-finite',
  5397,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Bloom } = await import('/packages/post/dist/bloom.js');
      const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
      engine.stop();
      const device = engine.gpu,
        size = 64,
        errors = [];
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const half = (v) => {
        if (Number.isNaN(v)) return 0x7e00;
        if (v === Infinity) return 0x7c00;
        if (v === -Infinity) return 0xfc00;
        if (v === 0) return 0;
        const e = Math.floor(Math.log2(v));
        return ((e + 15) << 10) | Math.round((v / 2 ** e - 1) * 1024);
      };
      const toFloat = (h) => {
        const e = (h >> 10) & 31,
          m = h & 1023,
          s = h & 0x8000 ? -1 : 1;
        if (e === 31) return m ? NaN : s * Infinity;
        return s * (e ? 2 ** (e - 15) * (1 + m / 1024) : 2 ** -14 * (m / 1024));
      };
      const bad = [
        [12, 12, Infinity, 65504],
        [20, 44, NaN, 0],
        [48, 16, -Infinity, 0],
      ];
      const image = (dirty) => {
        const data = new Uint16Array(size * size * 4);
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const v = x >= 40 && x < 44 && y >= 40 && y < 44 ? 8 : 0.5,
              o = (y * size + x) * 4;
            data.set([half(v), half(v), half(v), half(1)], o);
          }
        for (const [x, y, value, clean] of bad) {
          const o = (y * size + x) * 4;
          data.set([half(dirty ? value : clean), half(dirty ? value : clean), half(dirty ? value : clean)], o);
        }
        return data;
      };
      const run = async (data) => {
        const input = device.createTexture({
            size: [size, size],
            format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          }),
          output = device.createTexture({
            size: [size, size],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          }),
          read = device.createBuffer({ size: size * size * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        device.queue.writeTexture({ texture: input }, data, { bytesPerRow: size * 8 }, [size, size]);
        const bloom = new Bloom({ threshold: 1, strength: 0.8 }),
          encoder = device.createCommandEncoder();
        bloom.encodeImage({ device, encoder, width: size, height: size }, input.createView(), output.createView());
        encoder.copyTextureToBuffer({ texture: output }, { buffer: read, bytesPerRow: size * 8 }, [size, size]);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Uint16Array(read.getMappedRange().slice(0)), toFloat);
        read.unmap();
        bloom.dispose();
        for (const resource of [input, output, read]) resource.destroy();
        return values;
      };
      const dirty = await run(image(true)),
        clean = await run(image(false));
      let nonFinite = 0,
        far = 0,
        farDiff = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const near = bad.some(([bx, by]) => Math.max(Math.abs(bx - x), Math.abs(by - y)) < 8);
          for (let c = 0; c < 3; c++) {
            const i = (y * size + x) * 4 + c;
            if (!Number.isFinite(dirty[i])) nonFinite++;
            else if (!near) farDiff = Math.max(farDiff, Math.abs(dirty[i] - clean[i]));
          }
          if (!near) far++;
        }
      engine.dispose();
      return { nonFinite, far, farDiff, errors };
    });
    console.log(JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    assert.equal(result.nonFinite, 0, `every bloom output texel is finite (${result.nonFinite} were not)`);
    assert.ok(result.far > 2000, 'most of the image is far from a bad texel');
    assert.equal(result.farDiff, 0, `texels 8 px from a bad one equal the clean image's (${result.farDiff})`);
  },
);
