// The page of palette-check.mjs: each result is read back and compared byte for byte with the CPU matcher.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { ditherMatrix, nearestPaletteIndex, PaletteQuantize, readPalette } from '/packages/pixel/dist/palette.js';

const WIDTH = 16,
  HEIGHT = 4,
  canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH, HEIGHT] }),
  engine = engineRuntime(instance),
  errors = [];
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

const gradient = (alpha = 255) => {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) data.set([x * 17, 16 + x * 13 + y * 3, 240 - x * 11, alpha], (y * WIDTH + x) * 4);
  return data;
};
const textures = (data) => {
  const device = engine.gpu,
    source = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }),
    target = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  device.queue.writeTexture({ texture: source }, data, { bytesPerRow: WIDTH * 4 }, [WIDTH, HEIGHT]);
  return { source, target };
};
const read = async (texture) => {
  const device = engine.gpu,
    buffer = device.createBuffer({ size: 256 * HEIGHT, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [WIDTH, HEIGHT]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) out.set(raw.subarray(y * 256, y * 256 + WIDTH * 4), y * WIDTH * 4);
  buffer.destroy();
  return out;
};
const reference = (
  data,
  palette,
  shown,
  { distance = 'oklab', dither = 'none', spread = 0.125, premultiplied = true },
) => {
  const rgb = readPalette(palette),
    output = readPalette(shown ?? palette),
    matrix = ditherMatrix(dither),
    out = new Uint8Array(data.length);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 4,
        alpha = data[at + 3] / 255;
      if (!alpha) continue;
      const scale = premultiplied ? alpha : 1,
        threshold = matrix ? matrix.values[(y % matrix.size) * matrix.size + (x % matrix.size)] : undefined,
        index = nearestPaletteIndex(
          data[at] / 255 / scale,
          data[at + 1] / 255 / scale,
          data[at + 2] / 255 / scale,
          rgb,
          distance,
          threshold,
          spread,
        );
      for (let c = 0; c < 3; c++) out[at + c] = Math.round(output[index][c] * 255 * scale);
      out[at + 3] = data[at + 3];
    }
  return out;
};
const wrong = (actual, expected) => {
  let count = 0,
    first = null;
  for (let i = 0; i < expected.length; i += 4)
    for (let c = 0; c < 4; c++)
      if (actual[i + c] !== expected[i + c]) {
        count++;
        first ??= { pixel: i / 4, channel: c, actual: actual[i + c], expected: expected[i + c] };
        break;
      }
  return { wrong: count, first };
};
const PALETTE = ['#101820', '#2f7f5a', '#d9a13b', '#f4e9d8'],
  SWAP = ['#200010', '#004080', '#80ff00', '#ffffff'];

window.check = {
  async run() {
    const out = { checks: {} };
    engine.gpu.pushErrorScope('validation');
    const check = async (name, options, data = gradient()) => {
      const { source, target } = textures(data),
        pass = PaletteQuantize.attach(instance, { palette: PALETTE, source, target, ...options });
      instance.render({ delta: 1 / 60 });
      const actual = await read(target);
      out.checks[name] = wrong(actual, reference(data, PALETTE, options.swap, options));
      pass.dispose();
      source.destroy();
      target.destroy();
      return actual;
    };
    for (const distance of ['oklab', 'srgb'])
      for (const dither of ['none', 'bayer2', 'bayer4', 'bayer8', 'blue-noise']) {
        const actual = await check(`${dither} ${distance}`, { distance, dither });
        if (dither === 'bayer4' && distance === 'oklab') {
          const colours = new Set();
          for (let x = 0; x < WIDTH; x++) colours.add(actual[(x * 4 + 0) | 0]);
          out.distinct = colours.size;
        }
      }
    await check('wide spread', { dither: 'bayer8', spread: 0.5 });
    await check('palette swap', { swap: SWAP, dither: 'bayer2' });
    await check('straight alpha kept', { premultiplied: false }, gradient(128));
    const premultiplied = gradient(255);
    for (let i = 0; i < premultiplied.length; i += 4) {
      premultiplied[i + 3] = i % 8 ? 0 : 255;
      if (i % 8) premultiplied.fill(0, i, i + 3);
    }
    await check('transparent stays clear', {}, premultiplied);

    // The pass re-reads dither and setPalette live.
    {
      const data = gradient(),
        { source, target } = textures(data),
        other = engine.gpu.createTexture({
          size: [WIDTH, HEIGHT],
          format: 'bgra8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      let output = target;
      const pass = PaletteQuantize.attach(instance, { palette: PALETTE, source: () => source, target: () => output });
      instance.render({ delta: 1 / 60 });
      pass.dither = 'bayer4';
      instance.render({ delta: 1 / 60 });
      out.checks['dither changed live'] = wrong(
        await read(target),
        reference(data, PALETTE, null, { dither: 'bayer4' }),
      );
      pass.setPalette(SWAP);
      instance.render({ delta: 1 / 60 });
      out.checks['palette changed live'] = wrong(await read(target), reference(data, SWAP, null, { dither: 'bayer4' }));
      // A target of another format gets its own pipeline and bind group, and back again.
      output = other;
      instance.render({ delta: 1 / 60 });
      const bgra = await read(other);
      for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]];
      out.checks['target format changed live'] = wrong(bgra, reference(data, SWAP, null, { dither: 'bayer4' }));
      output = target;
      pass.setPalette(PALETTE);
      instance.render({ delta: 1 / 60 });
      out.checks['target format changed back'] = wrong(
        await read(target),
        reference(data, PALETTE, null, { dither: 'bayer4' }),
      );
      other.destroy();
      pass.dispose();
      const same = PaletteQuantize.attach(instance, { palette: PALETTE, source: target, target });
      try {
        instance.render({ delta: 1 / 60 });
      } catch (error) {
        out.sameTexture = error.code;
      }
      same.dispose();
      source.destroy();
      target.destroy();
    }
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;

    // A lost device: the pass makes its textures again.
    {
      const data = gradient();
      let pair = textures(data);
      const pass = PaletteQuantize.attach(instance, {
        palette: PALETTE,
        dither: 'bayer2',
        source: () => pair.source,
        target: () => pair.target,
      });
      instance.render({ delta: 1 / 60 });
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      pair = textures(data);
      instance.render({ delta: 1 / 60 });
      out.checks['after device loss'] = wrong(
        await read(pair.target),
        reference(data, PALETTE, null, { dither: 'bayer2' }),
      );
      pass.dispose();
    }
    out.errors = errors.splice(0);
    return out;
  },
};
window.ready = true;
