// Mip chains of every non-MASK texture (packages/shared/mipmaps.js, Rust engine port R13). Odd sizes used one bilinear
// fetch at the centre of a 2.5-texel footprint, which skips a texel: a 5-wide image whose last column is red kept a
// quarter of that column at level 1 instead of two fifths, so the level's red share fell from 1/5 to 1/8. Blended base
// colour maps averaged transparent-black texels into the colour of opaque ones, so their edges darkened down the chain.
// Each level is read back and compared with a float64 CPU area filter of the level above (as uploaded, so rounding
// does not compound): a plain chain within one code everywhere, a weighted chain (colour weighted by alpha) for a
// blended gltf-pro material and for the helper's `alpha: 'weighted'`.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

const decode = (b) => (b / 255 <= 0.04045 ? b / 255 / 12.92 : ((b / 255 + 0.055) / 1.055) ** 2.4),
  encode = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** One level from the level above, both RGBA bytes: area weights, colour weighted by alpha when asked. */
function down(bytes, w, h, weighted, srgb) {
  const nw = Math.max(1, w >> 1),
    nh = Math.max(1, h >> 1),
    out = new Float64Array(nw * nh * 4),
    lin = (b, k) => (srgb && k < 3 ? decode(b) : b / 255);
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++) {
      const x0 = (x * w) / nw,
        x1 = ((x + 1) * w) / nw,
        y0 = (y * h) / nh,
        y1 = ((y + 1) * h) / nh;
      const sum = [0, 0, 0, 0],
        sc = [0, 0, 0];
      for (let sy = Math.floor(y0); sy < Math.min(h, Math.ceil(y1)); sy++)
        for (let sx = Math.floor(x0); sx < Math.min(w, Math.ceil(x1)); sx++) {
          const wt = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy)),
            t = (sy * w + sx) * 4,
            a = bytes[t + 3] / 255;
          for (let k = 0; k < 4; k++) sum[k] += wt * lin(bytes[t + k], k);
          for (let k = 0; k < 3; k++) sc[k] += wt * a * lin(bytes[t + k], k);
        }
      const area = (x1 - x0) * (y1 - y0),
        o = (y * nw + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = weighted && sum[3] > 0 ? sc[k] / sum[3] : sum[k] / area;
      out[o + 3] = sum[3] / area;
    }
  return Array.from(out, (v, i) => (srgb && i % 4 < 3 ? encode(v) : 255 * v));
}

function pixels(width, height, kind) {
  let seed = 777;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32,
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (kind === 'red-column') data.set(x === width - 1 ? [255, 0, 0, 255] : [0, 0, 0, 255], i);
      else if (kind === 'checker') data.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 0], i);
      else
        data.set(
          [0, 0, 0, 0].map(() => Math.floor(random() * 256)),
          i,
        );
    }
  return [...data];
}

const cases = [
  { name: '5 x 5 red last column', width: 5, height: 5, kind: 'red-column', format: 'rgba8unorm' },
  { name: '37 x 23 random', width: 37, height: 23, kind: 'random', format: 'rgba8unorm' },
  { name: '64 x 32 random (even)', width: 64, height: 32, kind: 'random', format: 'rgba8unorm' },
  { name: '37 x 23 random sRGB', width: 37, height: 23, kind: 'random', format: 'rgba8unorm-srgb' },
  { name: '8 x 8 checker plain', width: 8, height: 8, kind: 'checker', format: 'rgba8unorm-srgb' },
  { name: '8 x 8 checker weighted', width: 8, height: 8, kind: 'checker', format: 'rgba8unorm-srgb', weighted: true },
  { name: '37 x 23 random weighted', width: 37, height: 23, kind: 'random', format: 'rgba8unorm', weighted: true },
  {
    name: 'gltf-pro BLEND checker',
    width: 16,
    height: 16,
    kind: 'checker',
    format: 'rgba8unorm-srgb',
    weighted: true,
    model: 'BLEND',
  },
  {
    name: 'gltf-pro OPAQUE checker',
    width: 16,
    height: 16,
    kind: 'checker',
    format: 'rgba8unorm-srgb',
    model: 'OPAQUE',
  },
].map((c) => ({ ...c, data: pixels(c.width, c.height, c.kind) }));

const compat = process.argv.includes('--compat');
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const read = await browser.page.evaluate(async (cases) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { generateMipmaps } = await import('/packages/shared/mipmaps.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, { backend: 'webgpu', capacity: 16 }),
        device = engineRuntime(instance).gpu,
        validation = [];
      device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      const create = device.createTexture.bind(device),
        made = [];
      device.createTexture = (d) => {
        const texture = create({ ...d, usage: d.usage | GPUTextureUsage.COPY_SRC });
        made.push(texture);
        return texture;
      };
      const quad = (alphaMode) => {
        const pos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
          idx = new Uint32Array([0, 1, 2, 0, 2, 3]),
          buffers = [pos, uv, idx];
        return {
          doc: {
            asset: { version: '2.0' },
            buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
            bufferViews: buffers.map((b, i) => ({ buffer: i, byteLength: b.byteLength })),
            accessors: [
              { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
              { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
              { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' },
            ],
            images: [{ uri: 'checker.png' }],
            textures: [{ source: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, alphaMode }],
            nodes: [{ mesh: 0 }],
            scenes: [{ nodes: [0] }],
          },
          buffers: buffers.map((b) => new Uint8Array(b.buffer)),
        };
      };
      const out = [],
        cache = new Map();
      for (const c of cases) {
        made.length = 0;
        let texture, model;
        const levels = Math.floor(Math.log2(Math.max(c.width, c.height))) + 1;
        if (c.model) {
          const q = quad(c.model);
          model = parseGLTF(instance, q.doc, q.buffers, [
            { width: c.width, height: c.height, data: new Uint8Array(c.data) },
          ]);
          await device.queue.onSubmittedWorkDone();
          texture = made.find((t) => t.width === c.width && t.height === c.height && t.mipLevelCount > 1);
        } else {
          texture = device.createTexture({
            size: [c.width, c.height],
            format: c.format,
            mipLevelCount: levels,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture({ texture }, new Uint8Array(c.data), { bytesPerRow: c.width * 4 }, [
            c.width,
            c.height,
          ]);
          generateMipmaps(device, texture, levels, cache, 1, c.weighted ? 'weighted' : 'plain');
        }
        const read = [];
        for (let k = 0; k < texture.mipLevelCount; k++) {
          const w = Math.max(1, c.width >> k),
            h = Math.max(1, c.height >> k),
            row = Math.ceil((w * 4) / 256) * 256,
            buffer = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
            encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture, mipLevel: k }, { buffer, bytesPerRow: row }, [w, h]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const all = new Uint8Array(buffer.getMappedRange()),
            bytes = [];
          for (let y = 0; y < h; y++) bytes.push(...all.subarray(y * row, y * row + w * 4));
          buffer.unmap();
          buffer.destroy();
          read.push(bytes);
        }
        out.push({ format: texture.format, levels: read });
        if (model) model.dispose();
        else texture.destroy();
      }
      instance.dispose?.();
      return { validation, out };
    }, cases);
    assert.deepEqual(read.validation, []);
    const report = [];
    for (const [i, c] of cases.entries()) {
      const got = read.out[i];
      assert.equal(got.format, c.format, c.name);
      assert.deepEqual(got.levels[0], c.data, `${c.name}: level 0 is the image`);
      let w = c.width,
        h = c.height;
      for (let k = 1; k < got.levels.length; k++) {
        const expected = down(got.levels[k - 1], w, h, c.weighted, c.format.endsWith('srgb'));
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        let colour = 0,
          alpha = 0;
        for (let t = 0; t < expected.length; t += 4) {
          alpha = Math.max(alpha, Math.abs(got.levels[k][t + 3] - expected[t + 3]));
          for (let j = 0; j < 3; j++) colour = Math.max(colour, Math.abs(got.levels[k][t + j] - expected[t + j]));
        }
        report.push({
          case: c.name,
          level: k,
          size: `${w} x ${h}`,
          colour: +colour.toFixed(2),
          alpha: +alpha.toFixed(2),
        });
      }
    }
    console.table(report);
    for (const r of report) {
      // Float32 against float64 filtering and the hardware's unorm (and sRGB) rounding: within one code.
      assert.ok(
        r.colour <= 1 && r.alpha <= 1,
        `${r.case} level ${r.level}: colour ${r.colour}, alpha ${r.alpha} codes off`,
      );
    }
    // The red column keeps its two fifths at level 1, and a blended checker stays white (the plain one greys).
    const red = read.out[0].levels[1];
    assert.deepEqual([red[0], red[4], red[8], red[12]], [0, 102, 0, 102], 'level 1 of the red column');
    for (const [index, white] of [
      [4, false],
      [5, true],
      [7, true],
      [8, false],
    ])
      assert.equal(
        read.out[index].levels[1][0] === 255,
        white,
        `${cases[index].name}: level 1 colour ${read.out[index].levels[1][0]}`,
      );
    console.log(compat ? 'compat' : 'native', 'mip chains match the area filter');
  },
  () => browser.close(),
);
