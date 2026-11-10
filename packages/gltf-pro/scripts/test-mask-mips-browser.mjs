// MASK base colour maps keep their cut-out coverage down the mip chain (Castano, "Computing Alpha Mipmaps", 2010).
// A plain box or bilinear chain averages a sparse cut-out's alpha below the cutoff, so distant foliage thins out and
// vanishes; transparent texels also bleed their colour into leaf edges. Each level of the uploaded texture is read
// back and compared with an independent float64 CPU reference of the method: the share of texels passing the cutoff,
// the alpha bytes and, where alpha is above 0, the colour bytes. Images go in as an ImageBitmap (the browser path)
// and as pixels (the Node decode path), in a square cut-out and an odd-sized texture with fractional alpha, through
// gltf-pro and through the light loader's `textured` extension (@margoengine/gltf/textured, a PNG in the file).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { maskKeepByte } from '../../shared/alpha-mips.js';

const decode = (b) => (b / 255 <= 0.04045 ? b / 255 / 12.92 : ((b / 255 + 0.055) / 1.055) ** 2.4);
const encode = (v) => {
  v = Math.min(1, Math.max(0, v));
  return Math.floor(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) + 0.5);
};

/** The reference chain, levels 1 and down, in float64 with exact shares; and every level's passing texel count. */
function reference(rgba, width, height, keep) {
  let w = width,
    h = height,
    alpha = Float64Array.from({ length: w * h }, (_, i) => rgba[i * 4 + 3] / 255),
    color = Float64Array.from({ length: w * h * 3 }, (_, i) => decode(rgba[((i / 3) | 0) * 4 + (i % 3)]));
  const passing = (codes) => codes.reduce((n, c) => n + (c >= keep ? 1 : 0), 0),
    first = Array.from({ length: w * h }, (_, i) => rgba[i * 4 + 3]),
    target = passing(first) / (w * h),
    flat = first.every((c) => c === first[0]),
    levels = [];
  const code = (a, s) => Math.floor(255 * Math.min(1, Math.max(0, a * s)) + 0.5);
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1),
      nh = Math.max(1, h >> 1),
      a = new Float64Array(nw * nh),
      c = new Float64Array(nw * nh * 3);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const x0 = (x * w) / nw,
          x1 = ((x + 1) * w) / nw,
          y0 = (y * h) / nh,
          y1 = ((y + 1) * h) / nh;
        let sa = 0;
        const sc = [0, 0, 0],
          pc = [0, 0, 0];
        for (let sy = Math.floor(y0); sy < Math.min(h, Math.ceil(y1)); sy++)
          for (let sx = Math.floor(x0); sx < Math.min(w, Math.ceil(x1)); sx++) {
            const weight = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy)),
              t = sy * w + sx;
            sa += weight * alpha[t];
            for (let k = 0; k < 3; k++) {
              sc[k] += weight * alpha[t] * color[t * 3 + k];
              pc[k] += weight * color[t * 3 + k];
            }
          }
        const area = (x1 - x0) * (y1 - y0),
          o = y * nw + x;
        a[o] = sa / area;
        for (let k = 0; k < 3; k++) c[o * 3 + k] = sa > 0 ? sc[k] / sa : pc[k] / area;
      }
    // Coverage only grows with the scale: bisection on 0 to 4096, then the nearer of the two ends (the upper on a tie).
    const covered = (s) => {
      let n = 0;
      for (const v of a) if (code(v, s) >= keep) n++;
      return n / a.length;
    };
    let lo = 0,
      hi = 4096;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (covered(mid) < target) lo = mid;
      else hi = mid;
    }
    const scale = flat ? 1 : Math.abs(covered(lo) - target) < Math.abs(covered(hi) - target) ? lo : hi,
      bytes = new Uint8Array(nw * nh * 4);
    for (let i = 0; i < nw * nh; i++) {
      for (let k = 0; k < 3; k++) bytes[i * 4 + k] = encode(c[i * 3 + k]);
      bytes[i * 4 + 3] = code(a[i], scale);
    }
    levels.push({ width: nw, height: nh, bytes, passing: passing(Array.from({ length: nw * nh }, (_, i) => bytes[i * 4 + 3])) });
    w = nw;
    h = nh;
    alpha = a;
    color = c;
  }
  return { target, levels };
}

/** Deterministic test pixels: a sparse binary cut-out (green leaves on magenta holes) or random fractional alpha. */
function pixels(width, height, kind) {
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++)
    if (kind === 'cutout') data.set(random() < 0.25 ? [40, 200, 60, 255] : [255, 0, 255, 0], i * 4);
    // A PNG made through a canvas stores no colour under alpha 0.
    else if (kind === 'canvas') data.set(random() < 0.25 ? [40, 200, 60, 255] : [0, 0, 0, 0], i * 4);
    else data.set([random() * 256, random() * 256, random() * 256, random() * 256].map(Math.floor), i * 4);
  return data;
}

function quad(cutoff, factor) {
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
      images: [{ uri: 'leaf.png' }],
      textures: [{ source: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, factor], baseColorTexture: { index: 0 } },
          alphaMode: 'MASK',
          alphaCutoff: cutoff,
        },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    },
    buffers: buffers.map((b) => [...new Uint8Array(b.buffer)]),
  };
}

const cases = [
  { name: 'cutout bitmap', width: 64, height: 64, kind: 'cutout', cutoff: 0.5, factor: 1, bitmap: true },
  { name: 'cutout pixels', width: 64, height: 64, kind: 'cutout', cutoff: 0.5, factor: 1, bitmap: false },
  { name: 'odd fractional', width: 37, height: 23, kind: 'fractional', cutoff: 0.3, factor: 0.8, bitmap: true },
  { name: 'light loader', width: 64, height: 32, kind: 'canvas', cutoff: 0.5, factor: 0.9, light: true },
].map((c) => ({ ...c, data: [...pixels(c.width, c.height, c.kind)], ...quad(c.cutoff, c.factor) }));

const compat = process.argv.includes('--compat');
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const read = await browser.page.evaluate(async (cases) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        light = await import('/packages/gltf/dist/index.js'),
        { textured } = await import('/packages/gltf/dist/textured.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, { backend: 'webgpu', capacity: 16 }),
        device = engineRuntime(instance).gpu,
        validation = [];
      device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      // Test instrumentation only: every texture can be copied out, so the uploaded levels can be read back.
      const create = device.createTexture.bind(device),
        made = [];
      device.createTexture = (d) => {
        const texture = create({ ...d, usage: d.usage | GPUTextureUsage.COPY_SRC });
        made.push(texture);
        return texture;
      };
      const out = [];
      for (const c of cases) {
        const data = new Uint8ClampedArray(c.data);
        made.length = 0;
        if (c.light) {
          const canvas = new OffscreenCanvas(c.width, c.height);
          canvas.getContext('2d').putImageData(new ImageData(data, c.width, c.height), 0, 0);
          const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
          let text = '';
          for (const b of png) text += String.fromCharCode(b);
          c.doc.images = [{ uri: 'data:image/png;base64,' + btoa(text) }];
          const bytes = c.buffers.map((b) => new Uint8Array(b)),
            all = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
          let at = 0;
          c.doc.buffers = [{ byteLength: all.length }];
          c.doc.bufferViews = bytes.map((b) => ({ buffer: 0, byteOffset: (at += b.length) - b.length, byteLength: b.length }));
          bytes.forEach((b, i) => all.set(b, c.doc.bufferViews[i].byteOffset));
          const model = await light.parseGLTFAsync(instance, c.doc, [all], { extensions: [textured] });
          instance.render?.();
          await device.queue.onSubmittedWorkDone();
          const texture = made.find((t) => t.width === c.width && t.height === c.height && t.mipLevelCount > 1);
          out.push({ name: c.name, format: texture.format, levels: await levelsOf(texture, c) });
          model.dispose?.();
          continue;
        }
        const image = c.bitmap
            ? await createImageBitmap(new ImageData(data, c.width, c.height), {
                premultiplyAlpha: 'none',
                colorSpaceConversion: 'none',
              })
            : { width: c.width, height: c.height, data: new Uint8Array(c.data) };
        const model = parseGLTF(
            instance,
            c.doc,
            c.buffers.map((b) => new Uint8Array(b)),
            [image],
          ),
          texture = made.find((t) => t.width === c.width && t.height === c.height && t.mipLevelCount > 1);
        out.push({ name: c.name, format: texture.format, levels: await levelsOf(texture, c) });
        model.dispose();
      }
      instance.dispose?.();
      return { validation, out };
      async function levelsOf(texture, c) {
        const levels = [];
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
          levels.push(bytes);
        }
        return levels;
      }
    }, cases);
    assert.deepEqual(read.validation, []);
    const report = [];
    for (const [i, c] of cases.entries()) {
      const keep = maskKeepByte(c.cutoff, c.factor),
        ref = reference(c.data, c.width, c.height, keep),
        got = read.out[i];
      assert.equal(got.format, 'rgba8unorm-srgb');
      assert.deepEqual(got.levels[0], c.data, `${c.name}: level 0 is the image`);
      for (const [k, level] of ref.levels.entries()) {
        const bytes = got.levels[k + 1];
        let passing = 0,
          alphaGap = 0,
          colorGap = 0;
        for (let t = 0; t < bytes.length; t += 4) {
          if (bytes[t + 3] >= keep) passing++;
          alphaGap = Math.max(alphaGap, Math.abs(bytes[t + 3] - level.bytes[t + 3]));
          if (level.bytes[t + 3] > 0)
            for (let j = 0; j < 3; j++) colorGap = Math.max(colorGap, Math.abs(bytes[t + j] - level.bytes[t + j]));
        }
        const texels = level.width * level.height;
        report.push({
          case: c.name,
          level: k + 1,
          texels,
          target: +(ref.target * texels).toFixed(2),
          reference: level.passing,
          gpu: passing,
          alphaGap,
          colorGap,
        });
      }
    }
    console.table(report);
    for (const r of report) {
      // The texel share passing the cutoff: exactly the reference's nearest achievable share.
      assert.equal(r.gpu, r.reference, `${r.case} level ${r.level}: ${r.gpu} texels pass, reference ${r.reference}`);
      // Float32 against float64 filtering, and the GPU's sRGB decode: one byte of alpha, two of colour.
      assert.ok(r.alphaGap <= 1, `${r.case} level ${r.level}: alpha off by ${r.alphaGap}`);
      assert.ok(r.colorGap <= 2, `${r.case} level ${r.level}: colour off by ${r.colorGap}`);
    }
    writeFileSync(
      `test-results/gltf-pro-mask-mips${compat ? '-compat' : ''}.json`,
      JSON.stringify({ hardware: browser.hardware, report }, null, 2),
    );
  },
  () => browser.close(),
);
