// The page of smooth-check.mjs: SpriteLayer with filter 'linear', read back and compared with the filtering formula.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { SpriteLayer } from '/packages/sprites/dist/index.js';

const WIDTH = 64,
  HEIGHT = 32;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:128px';
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH, HEIGHT] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#000000';
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

const frame = () => {
  canvas.width = WIDTH;
  instance.render({ delta: 1 / 60 });
  const copy = document.createElement('canvas');
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
};
const readTexture = async (texture) => {
  const row = Math.ceil((texture.width * 4) / 256) * 256,
    device = engine.gpu,
    buffer = device.createBuffer({
      size: row * texture.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(texture.width * texture.height * 4);
  for (let y = 0; y < texture.height; y++)
    out.set(raw.subarray(y * row, y * row + texture.width * 4), y * texture.width * 4);
  buffer.destroy();
  return out;
};
const row = (image, y, width = WIDTH) => {
  const out = [];
  for (let x = 0; x < width; x++) out.push([...image.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]);
  return out;
};
const using = (options, run) => {
  const layer = SpriteLayer.attach(instance, options);
  return Promise.resolve(run(layer)).finally(() => layer.dispose());
};
// Opaque white, then a transparent texel whose colour is pure red: straight-alpha filtering would bleed the red in.
const edge = { width: 2, height: 1, data: new Uint8Array([255, 255, 255, 255, 255, 0, 0, 0]) };
// 64 x 16 of alternating black and white opaque columns.
const stripes = new Uint8Array(64 * 16 * 4);
for (let i = 0; i < 64 * 16; i++) stripes.set((i % 64) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = {};
    engine.gpu.pushErrorScope('validation');
    out.edge = {};
    for (const filter of ['nearest', 'linear'])
      out.edge[filter] = await using({ atlas: edge, filter }, (layer) => {
        // 2 texels over 32 pixels: texel centres at x = 8 and 24.
        layer.add({ x: 0, y: 4, scaleX: 16, scaleY: 8 });
        return row(frame(), 8).slice(0, 32);
      });
    // The same edge from a caller's GPUTexture: the layer makes its own filtered copy.
    const texture = engine.gpu.createTexture({
      size: [2, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    engine.gpu.queue.writeTexture({ texture }, edge.data, { bytesPerRow: 8 }, [2, 1]);
    out.edge.texture = await using({ atlas: texture, filter: 'linear' }, (layer) => {
      layer.add({ x: 0, y: 4, scaleX: 16, scaleY: 8 });
      return row(frame(), 8).slice(0, 32);
    });
    texture.destroy();
    // A caller's sRGB target stores linear light, so the same edge lands encoded there.
    const target = engine.gpu.createTexture({
      size: [WIDTH, HEIGHT],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    out.edge.srgbTarget = await using({ atlas: edge, filter: 'linear', target }, async (layer) => {
      layer.add({ x: 0, y: 4, scaleX: 16, scaleY: 8 });
      frame();
      return row(await readTexture(target), 8).slice(0, 32);
    });
    target.destroy();
    out.stripes = {};
    for (const [name, options] of Object.entries({
      mipmaps: { filter: 'linear', snap: false },
      none: { filter: 'linear', mipmaps: false, snap: false },
    }))
      out.stripes[name] = await using({ atlas: { width: 64, height: 16, data: stripes }, ...options }, (layer) => {
        // 64 columns drawn 8 pixels wide: 8 texels per pixel, mip level 3. Moved a sixteenth of a pixel left, each pixel
        // centre lands on the centre of an even (black) column, so level 0 alone reads black.
        layer.add({ x: 40 - 1 / 16, y: 8, scaleX: 0.125 });
        return row(frame(), 16).slice(40, 48);
      });
    // Tint and alpha multiply the filtered colour: opaque white at half alpha and a red tint.
    out.tinted = await using({ atlas: edge, filter: 'linear' }, (layer) => {
      layer.add({ x: 0, y: 4, scaleX: 16, scaleY: 8, tint: '#ff0000', alpha: 0.5 });
      return row(frame(), 8)[2];
    });
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    out.errors = errors;
    return out;
  },
};
window.ready = true;
