// The page of pages-check.mjs: one SpriteLayer drawing from several atlases through a texture array.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { SpriteLayer } from '/packages/sprites/dist/index.js';
import { flashShader } from '/packages/sprites/dist/shader.js';

const WIDTH = 64,
  HEIGHT = 32;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:128px;image-rendering:pixelated';
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
const pixel = (image, x, y) => [...image.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)];
// 2 x 2 atlases: texel (0, 0) carries the page's colour, the other three a darker shade of it.
const sheet = (r, g, b) => ({
  width: 2,
  height: 2,
  data: new Uint8Array([r, g, b, 255, r / 2, g / 2, b / 2, 255, r / 2, g / 2, b / 2, 255, r / 2, g / 2, b / 2, 255]),
});
const red = sheet(255, 0, 0),
  green = sheet(0, 254, 0),
  blue = sheet(0, 0, 254);
// The third atlas as a caller's GPUTexture without copy usage.
const texture = engine.gpu.createTexture({
  size: [2, 2],
  format: 'rgba8unorm',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
engine.gpu.queue.writeTexture({ texture }, blue.data, { bytesPerRow: 8 }, [2, 2]);
const using = (options, run) => {
  const layer = SpriteLayer.attach(instance, options);
  try {
    return run(layer);
  } finally {
    layer.dispose();
  }
};
/** The 2 x 2 texels of each page's sprite, read at the pixel centres of the scaled sprites at x = 0, 10, 20. */
const read = (image) =>
  [0, 10, 20].map((x) => [pixel(image, x + 1, 1), pixel(image, x + 5, 1), pixel(image, x + 5, 5)]);
const addThree = (layer, extra = {}) => {
  for (const [i, page] of [0, 1, 2].entries()) layer.add({ x: i * 10, y: 0, scaleX: 4, scaleY: 4, page, ...extra });
};

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = {};
    engine.gpu.pushErrorScope('validation');
    out.nearest = using({ atlas: [red, green, texture] }, (layer) => {
      addThree(layer);
      const first = read(frame());
      layer.setAtlas([texture, red, green]);
      return { first, swapped: read(frame()) };
    });
    out.linear = using({ atlas: [red, green, texture], filter: 'linear', mipmaps: false }, (layer) => {
      // Scaled 8: the pixel at the middle of texel (0, 0) reads it alone.
      for (const [i, page] of [0, 1, 2].entries()) layer.add({ x: i * 20, y: 8, scaleX: 8, scaleY: 8, page });
      const image = frame();
      return [0, 20, 40].map((x) => pixel(image, x + 3, 11));
    });
    out.shaded = using({ atlas: [red, green, texture], shader: flashShader() }, (layer) => {
      addThree(layer, { params: [1, 0, 0, 0] });
      return read(frame());
    });
    out.one = using({ atlas: [green] }, (layer) => {
      layer.add({ x: 0, y: 0, scaleX: 4, scaleY: 4 });
      return pixel(frame(), 1, 1);
    });
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    out.badPage = using({ atlas: [red, green] }, (layer) => {
      layer.add({ page: 2 });
      try {
        frame();
        return 'drew';
      } catch (error) {
        return error.name;
      }
    });
    out.badSize = using({ atlas: [red, { width: 4, height: 1, data: new Uint8Array(16) }] }, (layer) => {
      layer.add({});
      try {
        frame();
        return 'drew';
      } catch (error) {
        return error.name;
      }
    });
    texture.destroy();
    out.errors = errors;
    return out;
  },
};
window.ready = true;
