// The page of masks-check.mjs: SpriteLayer masks read back against images worked out from the mask rules.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { SpriteLayer } from '/packages/sprites/dist/index.js';
import { flashShader } from '/packages/sprites/dist/shader.js';

const WIDTH = 64,
  HEIGHT = 32,
  BACKGROUND = [0, 0, 0],
  GREEN = [0, 200, 0],
  RED = [220, 0, 0];
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
const solid = (color) => ({ width: 1, height: 1, data: new Uint8Array([...color, 255]) });
/** Pixels that differ from what `expect(x, y)` gives, with the first one. */
const wrong = (image, expect) => {
  let count = 0,
    first = null;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const want = expect(x, y),
        at = (y * WIDTH + x) * 4,
        got = [image[at], image[at + 1], image[at + 2]];
      if (got.join() !== want.join()) {
        count++;
        first ??= { x, y, got, want };
      }
    }
  return { count, first };
};
// The rules, on pixel centres (x + 0.5, y + 0.5) in layer pixels.
const inRect = (x, y, [x0, y0, x1, y1]) => x + 0.5 >= x0 && x + 0.5 < x1 && y + 0.5 >= y0 && y + 0.5 < y1;
const inCircle = (x, y, [cx, cy, r]) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = {};
    engine.gpu.pushErrorScope('validation');
    // Green covers the left half through a camera at (1, 0), zoom 2: world rect [3, 2, 4, 3] is pixels [4, 4] to [12, 10].
    const green = SpriteLayer.attach(instance, {
      atlas: solid(GREEN),
      camera: { x: 1, y: 0, zoom: 2 },
      mask: { rect: [3, 2, 4, 3] },
    });
    green.add({ x: 1, y: 0, scaleX: 16, scaleY: 16 });
    // Red covers the right half at zoom 1, everywhere outside the circle at (48, 16) of radius 6.
    const red = SpriteLayer.attach(instance, { atlas: solid(RED), mask: { circle: [48, 16, 6], outside: true } });
    red.add({ x: 32, y: 0, scaleX: 32, scaleY: 32 });
    const left = (x, y) => x < 32 && inRect(x, y, [4, 4, 12, 10]),
      right = (x, y, circle = [48, 16, 6]) => x >= 32 && !inCircle(x, y, circle);
    out.shapes = wrong(frame(), (x, y) => (left(x, y) ? GREEN : right(x, y) ? RED : BACKGROUND));
    // Masks are read each frame: the circle moves to (40, 10) radius 4.5, the rect turns outside, then none.
    red.mask = { circle: [40, 10, 4.5], outside: true };
    green.mask = { rect: [3, 2, 4, 3], outside: true };
    out.moved = wrong(frame(), (x, y) =>
      x < 32 && !inRect(x, y, [4, 4, 12, 10]) ? GREEN : right(x, y, [40, 10, 4.5]) ? RED : BACKGROUND,
    );
    green.mask = undefined;
    red.mask = { circle: [48, 16, 6] };
    out.none = wrong(frame(), (x, y) => (x < 32 ? GREEN : inCircle(x, y, [48, 16, 6]) ? RED : BACKGROUND));
    // A camera move carries the mask with the world: camera x 2 shifts the rect 2 pixels left of [4, 12).
    green.mask = { rect: [3, 2, 4, 3] };
    green.camera = { x: 2, y: 0, zoom: 2 };
    green.sprites[0].x = 2;
    red.dispose();
    out.camera = wrong(frame(), (x, y) => (x < 32 && inRect(x, y, [2, 4, 10, 10]) ? GREEN : BACKGROUND));
    // A shaded layer masks too: flash 1 turns the masked texels white.
    green.dispose();
    const shaded = SpriteLayer.attach(instance, {
      atlas: solid(GREEN),
      shader: flashShader(),
      mask: { circle: [16, 16, 8] },
    });
    shaded.add({ x: 0, y: 0, scaleX: 32, scaleY: 32, params: [1, 0, 0, 0] });
    out.shaded = wrong(frame(), (x, y) => (inCircle(x, y, [16, 16, 8]) ? [255, 255, 255] : BACKGROUND));
    shaded.dispose();
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    out.errors = errors;
    return out;
  },
};
window.ready = true;
