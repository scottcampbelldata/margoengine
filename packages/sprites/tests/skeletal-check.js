// The page of skeletal-check.mjs: skinned meshes read back against images composed on the CPU.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { gridMesh, SkeletalLayer, Skeleton2D, SkinnedMesh } from '/packages/sprites/dist/skeletal.js';

const WIDTH = 64,
  HEIGHT = 32,
  BACKGROUND = [16, 32, 48];
// 4 x 8 atlas, every texel its own opaque colour.
const data = new Uint8Array(4 * 8 * 4);
for (let y = 0; y < 8; y++)
  for (let x = 0; x < 4; x++) data.set([40 + x * 50, 30 + y * 25, 200 - y * 20, 255], (y * 4 + x) * 4);
const texel = (x, y) => [...data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 3)];

const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:128px;image-rendering:pixelated';
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH, HEIGHT] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#102030';
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
const blank = () => {
  const image = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < image.length; i += 4) image.set([...BACKGROUND, 255], i);
  return image;
};
const wrong = (actual, expected) => {
  let count = 0,
    first = null;
  for (let i = 0; i < expected.length; i += 4)
    for (let c = 0; c < 3; c++)
      if (actual[i + c] !== expected[i + c]) {
        count++;
        first ??= {
          x: (i / 4) % WIDTH,
          y: Math.floor(i / 4 / WIDTH),
          actual: actual[i + c],
          expected: expected[i + c],
        };
        break;
      }
  return { count, first };
};
const put = (image, x, y, color) => image.set(color, (y * WIDTH + x) * 4);
// A 4 x 8 strip in two rows of quads: the top two rows of vertices follow the root, the bottom row the tip at (0, 4).
const strip = () => {
  const skeleton = new Skeleton2D([{ name: 'root' }, { name: 'tip', parent: 'root', y: 4 }]),
    grid = gridMesh([0, 0, 4, 8], 1, 2),
    joints = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    weights = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  return { skeleton, mesh: new SkinnedMesh({ skeleton, ...grid, joints, weights }) };
};

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = {};
    engine.gpu.pushErrorScope('validation');
    const layer = SkeletalLayer.attach(instance, { atlas: { width: 4, height: 8, data } });
    const bind = strip(),
      turned = strip(),
      bent = strip();
    layer.add(bind.mesh).x = 10;
    bind.mesh.y = 2;
    // The whole strip turned a clockwise quarter about the root: texel (i, j) lands on pixel (30 - j - 1, 2 + i).
    turned.skeleton.bone('root').rotation = Math.PI / 2;
    turned.skeleton.update();
    layer.add(turned.mesh).x = 30;
    turned.mesh.y = 2;
    const expected = blank();
    for (let j = 0; j < 8; j++)
      for (let i = 0; i < 4; i++) {
        put(expected, 10 + i, 2 + j, texel(i, j));
        put(expected, 30 - j - 1, 2 + i, texel(i, j));
      }
    out.rigid = wrong(frame(), expected);
    // Bent at the tip: the top half stays, the bottom half swings left of the strip.
    layer.add(bent.mesh).x = 50;
    bent.mesh.y = 2;
    const straight = frame();
    bent.skeleton.bone('tip').rotation = Math.PI / 2;
    bent.skeleton.update();
    const image = frame(),
      at = (x, y) => [...image.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)];
    out.bent = {
      topKept: [0, 1, 2, 3].every((y) => [0, 1, 2, 3].every((x) => at(50 + x, 2 + y).join() === texel(x, y).join())),
      swung: at(47, 7),
      swungBefore: [...straight.subarray((7 * WIDTH + 47) * 4, (7 * WIDTH + 47) * 4 + 3)],
      bottomGone: at(52, 9),
    };
    // Tint and alpha: a red tint at half alpha over the background on the bind-pose texel (0, 0).
    bind.mesh.tint = '#ff0000';
    bind.mesh.alpha = 0.5;
    out.tinted = [...frame().subarray((2 * WIDTH + 10) * 4, (2 * WIDTH + 10) * 4 + 3)];
    layer.dispose();
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    out.background = BACKGROUND;
    out.texel0 = texel(0, 0);
    out.texel27 = texel(2, 7);
    out.errors = errors;
    return out;
  },
};
window.ready = true;
