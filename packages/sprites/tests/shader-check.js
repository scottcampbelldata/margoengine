// The page of shader-check.mjs: shaded sprite layers read back and compared with images composed on the CPU.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { SpriteLayer } from '/packages/sprites/dist/index.js';
import {
  dissolveShader,
  flashShader,
  outlineShader,
  paletteShader,
  spriteShader,
} from '/packages/sprites/dist/shader.js';

const WIDTH = 64,
  HEIGHT = 32;
// 8 x 8 atlas. Rect O = [0, 0, 6, 6]: a red 2 x 2 at (2, 2), the rest transparent. Rect P = [0, 6, 2, 2]: red, green,
// blue, white.
const data = new Uint8Array(8 * 8 * 4);
for (const [x, y] of [
  [2, 2],
  [3, 2],
  [2, 3],
  [3, 3],
])
  data.set([255, 0, 0, 255], (y * 8 + x) * 4);
const P = [
  [0, 6, [255, 0, 0, 255]],
  [1, 6, [0, 255, 0, 255]],
  [0, 7, [0, 0, 255, 255]],
  [1, 7, [255, 255, 255, 255]],
];
for (const [x, y, color] of P) data.set(color, (y * 8 + x) * 4);
const atlas = { width: 8, height: 8, data };

const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:128px;image-rendering:pixelated';
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH, HEIGHT] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#000000';
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const frame = (delta = 1 / 60) => {
  canvas.width = WIDTH;
  instance.render({ delta });
  const copy = document.createElement('canvas');
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
};
const pixel = (image, x, y) => [...image.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)];
/** The pixels of a w x h block at (x, y), row by row. */
const block = (image, x, y, w, h) => {
  const out = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push(pixel(image, x + i, y + j));
  return out;
};
const using = (options, run) => {
  const layer = SpriteLayer.attach(instance, { atlas, ...options });
  try {
    return run(layer);
  } finally {
    layer.dispose();
  }
};
const centres = (image, x) => [
  pixel(image, x + 1, 1),
  pixel(image, x + 5, 1),
  pixel(image, x + 1, 5),
  pixel(image, x + 5, 5),
];

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = {};
    engine.gpu.pushErrorScope('validation');
    out.flash = using({ shader: flashShader() }, (layer) => {
      const s = layer.add({ x: 0, y: 0, rect: [0, 6, 2, 2], scaleX: 4, scaleY: 4 });
      const seen = {};
      for (const amount of [0, 0.5, 1]) {
        s.params = [amount, 0, 0, 0];
        seen[amount] = centres(frame(), 0);
      }
      return seen;
    });
    out.outline = using({ shader: outlineShader({ color: '#ffff00' }) }, (layer) => {
      const s = layer.add({ x: 20, y: 0, rect: [0, 0, 6, 6], params: [1, 0, 0, 0] });
      const on = block(frame(), 20, 0, 6, 6);
      s.params = [0, 0, 0, 0];
      return { on, off: block(frame(), 20, 0, 6, 6) };
    });
    out.dissolve = using({ shader: dissolveShader() }, (layer) => {
      const s = layer.add({ x: 30, y: 0, rect: [0, 6, 2, 2], scaleX: 4, scaleY: 4 });
      const whole = centres(frame(), 30);
      s.params = [1, 0, 0, 0];
      return { whole, gone: centres(frame(), 30) };
    });
    out.palette = using({ shader: paletteShader(['#ff0000'], ['#0000ff']) }, (layer) => {
      layer.add({ x: 40, y: 0, rect: [0, 6, 2, 2], scaleX: 4, scaleY: 4 });
      return centres(frame(), 40);
    });
    out.time = using(
      { shader: spriteShader('fn effect(c:vec4f,s:SpriteInput)->vec4f{return vec4f(fract(s.time),0,0,1);}') },
      (layer) => {
        layer.add({ x: 50, y: 0, rect: [0, 6, 2, 2], scaleX: 4, scaleY: 4 });
        return pixel(frame(0.25), 51, 1)[0];
      },
    );
    out.smooth = using({ shader: flashShader(), filter: 'linear' }, (layer) => {
      layer.add({ x: 0, y: 8, rect: [0, 6, 2, 2], scaleX: 8, scaleY: 8, params: [1, 0, 0, 0] });
      return [pixel(frame(), 4, 12), pixel(frame(), 12, 20)];
    });
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    out.errors = errors;
    out.P = P.map((p) => p[2].slice(0, 3));
    return out;
  },
};
window.ready = true;
