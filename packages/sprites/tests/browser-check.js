// The page of browser-check.mjs: every frame is read back and compared byte for byte with an image composed on the CPU.
import { EngineKernel } from '/packages/core/dist/index.js';
import { Camera, engineRuntime } from '/packages/core/dist/extension.js';
import { SpriteLayer } from '/packages/sprites/dist/index.js';

const WIDTH = 64,
  HEIGHT = 32,
  BACKGROUND = [16, 32, 48];
// 8 x 8 atlas: 4 x 4 cells, every texel its own opaque colour, plus one transparent texel at (3, 3).
const atlasData = new Uint8Array(8 * 8 * 4);
for (let y = 0; y < 8; y++)
  for (let x = 0; x < 8; x++) atlasData.set([40 + x * 25, 40 + y * 25, 200 - x * 10 - y * 10, 255], (y * 8 + x) * 4);
atlasData[(3 * 8 + 3) * 4 + 3] = 0;
const atlas = { width: 8, height: 8, data: atlasData };

const texel = (x, y) => [...atlasData.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
const blank = (color = [...BACKGROUND, 255]) => {
  const image = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < image.length; i += 4) image.set(color, i);
  return image;
};
// The CPU reference: writes one source texel over the image with the same straight-alpha blend as the pipeline.
const over = (image, x, y, source, tint = [255, 255, 255, 255], width = WIDTH) => {
  const rgba = source.map((v, i) => Math.round((v * tint[i]) / 255));
  if (rgba[3] === 0) return;
  const at = (y * width + x) * 4,
    a = rgba[3] / 255;
  for (let i = 0; i < 3; i++) image[at + i] = Math.round(rgba[i] * a + image[at + i] * (1 - a));
  image[at + 3] = Math.round(rgba[3] + image[at + 3] * (1 - a));
};
/** Draws cell (cx, cy, size 4) at (px, py), the same way the shader reads texels. */
const cell = (image, px, py, { cx = 0, cy = 0, flipX, flipY, tint, scale = 1 } = {}) => {
  for (let y = 0; y < 4 * scale; y++)
    for (let x = 0; x < 4 * scale; x++) {
      const u = Math.floor(x / scale),
        v = Math.floor(y / scale);
      over(image, px + x, py + y, texel(cx + (flipX ? 3 - u : u), cy + (flipY ? 3 - v : v)), tint);
    }
};

const difference = (actual, expected, channels = 3) => {
  let wrong = 0,
    first = null;
  for (let i = 0; i < expected.length; i += 4)
    for (let c = 0; c < channels; c++)
      if (actual[i + c] !== expected[i + c]) {
        wrong++;
        first ??= {
          x: (i / 4) % WIDTH,
          y: Math.floor(i / 4 / WIDTH),
          channel: c,
          actual: actual[i + c],
          expected: expected[i + c],
        };
        break;
      }
  return { wrong, first };
};

const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:128px;image-rendering:pixelated';
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH, HEIGHT] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#102030';
const device0 = engine.gpu;
device0.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

/** The canvas back as RGBA bytes, read in the frame's own task. */
const readCanvas = () => {
  const copy = document.createElement('canvas');
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
};
// Resetting the width gives the frame a new drawing buffer. WebKit answers every read of one buffer in a task from the
// first read, so a second frame in this task would read as the first. Chrome reads the newest frame either way.
const frame = (delta = 1 / 60) => {
  canvas.width = WIDTH;
  instance.render({ delta });
  return readCanvas();
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
const makeTarget = (format = 'rgba8unorm', width = WIDTH, height = HEIGHT) =>
  engine.gpu.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  });
const cleanly = async (run) => {
  const layers = [];
  try {
    return await run((options) => {
      const layer = SpriteLayer.attach(instance, { atlas, ...options });
      layers.push(layer);
      return layer;
    });
  } finally {
    for (const layer of layers) layer.dispose();
  }
};

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = { checks: {} },
      record = (name, result) => {
        out.checks[name] = result;
      },
      rect = (cx, cy) => [cx, cy, 4, 4];
    engine.gpu.pushErrorScope('validation');

    const background = frame();
    record('background', difference(background, blank()));

    await cleanly(async (attach) => {
      const layer = attach();
      layer.add({ x: 10, y: 7, rect: rect(0, 0) });
      const expected = blank();
      cell(expected, 10, 7);
      record('4x4 at (10, 7)', difference(frame(), expected));
    });

    await cleanly(async (attach) => {
      const layer = attach();
      layer.add({ x: 2, y: 2, rect: rect(0, 0), flipX: true });
      layer.add({ x: 8, y: 2, rect: rect(4, 0), flipY: true });
      layer.add({ x: 14, y: 2, rect: rect(0, 4), flipX: true, flipY: true });
      layer.add({ x: 20, y: 2, rect: rect(4, 4), tint: 0x80ff40 });
      layer.add({ x: 26, y: 2, rect: rect(0, 0), tint: '#ff0000', alpha: 128 / 255 });
      const expected = blank();
      cell(expected, 2, 2, { flipX: true });
      cell(expected, 8, 2, { cx: 4, flipY: true });
      cell(expected, 14, 2, { cy: 4, flipX: true, flipY: true });
      cell(expected, 20, 2, { cx: 4, cy: 4, tint: [0x80, 0xff, 0x40, 255] });
      cell(expected, 26, 2, { tint: [255, 0, 0, 128] });
      record('flips and tint', difference(frame(), expected));
    });

    await cleanly(async (attach) => {
      // Overlaps resolved by z, then y, then add order. The transparent texel at (3, 3) shows what lies below.
      const layer = attach({ ySort: true });
      layer.add({ x: 20, y: 14, rect: rect(0, 0) });
      layer.add({ x: 22, y: 12, rect: rect(4, 0) });
      layer.add({ x: 24, y: 10, rect: rect(4, 4), z: 1 });
      layer.add({ x: 18, y: 16, rect: rect(0, 4), z: -1 });
      const expected = blank();
      cell(expected, 18, 16, { cy: 4 });
      cell(expected, 22, 12, { cx: 4 });
      cell(expected, 20, 14);
      cell(expected, 24, 10, { cx: 4, cy: 4 });
      const sorted = frame();
      record('y-sort order', difference(sorted, expected));
      // Same sprites, y-sort off: add order decides among equal z.
      layer.ySort = false;
      const added = blank();
      cell(added, 18, 16, { cy: 4 });
      cell(added, 20, 14);
      cell(added, 22, 12, { cx: 4 });
      cell(added, 24, 10, { cx: 4, cy: 4 });
      record('add order without y-sort', difference(frame(), added));
    });

    await cleanly(async (attach) => {
      const layer = attach();
      const sprite = layer.add({ x: 5.4, y: 6.6, rect: rect(0, 0), scaleX: 2, scaleY: 2 });
      let expected = blank();
      cell(expected, 5, 7, { scale: 2 });
      record('snap and integer scale', difference(frame(), expected));
      // Moved by a change to one field: only its bytes go up, and the frame follows.
      sprite.x = 40;
      expected = blank();
      cell(expected, 40, 7, { scale: 2 });
      record('moved sprite', difference(frame(), expected));
      layer.camera = { x: 1.25, y: 1.25, zoom: 2 };
      sprite.scaleX = sprite.scaleY = 1;
      sprite.x = 11;
      sprite.y = 3;
      expected = blank();
      // (11 - 1.25) * 2 = 19.5 rounds to 20; (3 - 1.25) * 2 = 3.5 rounds to 4; zoom 2 doubles the size.
      cell(expected, 20, 4, { scale: 2 });
      record('camera', difference(frame(), expected));
      sprite.visible = false;
      record('hidden', difference(frame(), blank()));
    });

    await cleanly(async (attach) => {
      // Half-pixel pivot: a 4 x 4 image pivoted at (0.5, 0.5) keeps its pixels whole; 5 wide lands on the rounded corner.
      const layer = attach();
      layer.add({ x: 12, y: 12, rect: rect(0, 0), pivotX: 0.5, pivotY: 0.5 });
      layer.add({ x: 30, y: 12, rect: [0, 0, 5, 4], pivotX: 0.5, pivotY: 0 });
      const expected = blank();
      cell(expected, 10, 10);
      // 30 - 2.5 = 27.5 rounds to 28.
      for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) over(expected, 28 + x, 12 + y, texel(x, y));
      record('half-pixel pivots', difference(frame(), expected));
    });

    await cleanly(async (attach) => {
      // Quarter turns about a pixel corner map pixels to pixels exactly; clockwise on screen, y down.
      const layer = attach();
      layer.add({ x: 20, y: 10, rect: rect(0, 0), rotation: Math.PI / 2 });
      layer.add({ x: 40, y: 10, rect: rect(0, 0), rotation: Math.PI });
      const expected = blank();
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          over(expected, 20 - 1 - y, 10 + x, texel(x, y));
          over(expected, 40 - 1 - x, 10 - 1 - y, texel(x, y));
        }
      record('quarter turns', difference(frame(), expected));
    });

    await cleanly(async (attach) => {
      // Any other angle stays nearest: every drawn pixel is one source colour, never a blend.
      const layer = attach();
      layer.add({ x: 30, y: 16, rect: [0, 0, 8, 8], pivotX: 0.5, pivotY: 0.5, rotation: (30 * Math.PI) / 180 });
      const image = frame(),
        colours = new Set([`${BACKGROUND}`]);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) colours.add(`${texel(x, y).slice(0, 3)}`);
      let foreign = 0,
        drawn = 0;
      for (let i = 0; i < image.length; i += 4) {
        const colour = `${image[i]},${image[i + 1]},${image[i + 2]}`;
        if (!colours.has(colour)) foreign++;
        if (colour !== `${BACKGROUND}`) drawn++;
      }
      record('30 degrees: only source colours', { wrong: foreign, drawn });
    });

    await cleanly(async (attach) => {
      // Past the first capacity the buffer grows and every sprite still draws.
      const layer = attach({ capacity: 2 });
      const expected = blank();
      for (let i = 0; i < 40; i++) {
        const x = (i % 10) * 6,
          y = Math.floor(i / 10) * 7;
        layer.add({ x, y, rect: rect(0, 0) });
        cell(expected, x, y);
      }
      record('buffer growth', difference(frame(), expected));
      layer.clearSprites();
      record('no sprites', difference(frame(), blank()));
    });

    await cleanly(async (attach) => {
      // Two layers keep their order, and a higher one loads what the lower drew.
      const low = attach({ order: 11 }),
        high = attach({ order: 12 });
      high.add({ x: 12, y: 12, rect: rect(4, 0) });
      low.add({ x: 10, y: 10, rect: rect(0, 0) });
      const expected = blank();
      cell(expected, 10, 10);
      cell(expected, 12, 12, { cx: 4 });
      record('two layers', difference(frame(), expected));
    });

    // A caller target: the exact bytes, alpha included, cleared first to transparent.
    const target = makeTarget();
    await cleanly(async (attach) => {
      const layer = attach({ target });
      layer.add({ x: 10, y: 7, rect: rect(0, 0), alpha: 128 / 255 });
      const shown = frame();
      const expected = blank([0, 0, 0, 0]);
      cell(expected, 10, 7, { tint: [255, 255, 255, 128] });
      record('target: alpha exact', difference(await readTexture(target), expected, 4));
      record('target: canvas untouched', difference(shown, blank()));
    });
    // A target reached through a function, and clear: false keeps what is there.
    await cleanly(async (attach) => {
      const layer = attach({ target: () => target, clear: false });
      layer.add({ x: 30, y: 7, rect: rect(0, 0) });
      frame();
      const expected = blank([0, 0, 0, 0]);
      cell(expected, 10, 7, { tint: [255, 255, 255, 128] });
      cell(expected, 30, 7);
      record('target: clear false', difference(await readTexture(target), expected, 4));
    });
    target.destroy();

    // Normals: a second target gets each sprite's normal, turned and flipped with it.
    const normalData = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) normalData.set([100 + x, 60 + y, 200, 255], (y * 8 + x) * 4);
    const normalTarget = makeTarget();
    await cleanly(async (attach) => {
      const layer = attach({ normals: { atlas: { width: 8, height: 8, data: normalData }, target: normalTarget } });
      layer.add({ x: 2, y: 2, rect: rect(0, 0) });
      layer.add({ x: 10, y: 2, rect: rect(0, 0), flipX: true });
      layer.add({ x: 18, y: 2, rect: rect(0, 0), flipY: true });
      layer.add({ x: 30, y: 2, rect: rect(0, 0), rotation: Math.PI / 2 });
      const image = frame();
      const colour = blank();
      cell(colour, 2, 2);
      cell(colour, 10, 2, { flipX: true });
      cell(colour, 18, 2, { flipY: true });
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) over(colour, 30 - 1 - y, 2 + x, texel(x, y));
      record('normals: colour unchanged', difference(image, colour));
      const expected = blank([128, 128, 255, 0]);
      const put = (x, y, r, g, u, v) => {
        // The texel (3, 3) of the cell is transparent, so it writes no normal.
        if (u === 3 && v === 3) return;
        expected.set([r, g, 200, 255], (y * WIDTH + x) * 4);
      };
      for (let v = 0; v < 4; v++)
        for (let u = 0; u < 4; u++) {
          const r = 100 + u,
            g = 60 + v;
          put(2 + u, 2 + v, r, g, u, v);
          // flipX: x negates, 255 - r in bytes.
          put(10 + 3 - u, 2 + v, 255 - r, g, u, v);
          put(18 + u, 2 + 3 - v, r, 255 - g, u, v);
          // A clockwise quarter turn sends (x, y) to (-y, x).
          put(30 - 1 - v, 2 + u, 255 - g, r, u, v);
        }
      const actual = await readTexture(normalTarget);
      record('normals: turned and flipped', difference(actual, expected, 4));
    });
    normalTarget.destroy();

    // Views: the layer draws inside each view rectangle with that view's size; layers leave one out.
    await cleanly(async (attach) => {
      const layer = attach();
      layer.add({ x: 1, y: 1, rect: rect(0, 0) });
      const camera = new Camera({ position: [0, 0, 6], target: [0, 0, 0] });
      const views = [
        { id: 'a', camera, pixels: true, viewport: [0, 0, 32, 32] },
        { id: 'b', camera, pixels: true, viewport: [32, 8, 16, 16] },
        { id: 'c', camera, pixels: true, viewport: [48, 0, 16, 16], layers: 2 },
      ];
      instance.render({ delta: 1 / 60, views });
      const image = readCanvas(),
        expected = blank([0, 0, 0, 255]);
      for (const {
        viewport: [left, top, wide, tall],
      } of views)
        for (let y = top; y < top + tall; y++)
          for (let x = left; x < left + wide; x++) expected.set([...BACKGROUND, 255], (y * WIDTH + x) * 4);
      cell(expected, 1, 1);
      cell(expected, 33, 9);
      record('views', difference(image, expected));
    });

    // An engine with MSAA draws the same pipeline at its sample count, with no validation error.
    {
      const other = document.createElement('canvas');
      other.style.cssText = 'width:64px;height:32px';
      document.body.append(other);
      const multi = await EngineKernel.create(other, { backend: 'webgpu' });
      const layer = SpriteLayer.attach(multi, { atlas });
      layer.add({ x: 4, y: 4, rect: rect(0, 0) });
      const runtime = engineRuntime(multi),
        scope = runtime.gpu;
      scope.pushErrorScope('validation');
      let samples;
      const removeProbe = runtime.frameGraph.add({
        name: 'probe',
        order: 20,
        execute: (c) => {
          samples = c.descriptor.multisample?.count;
        },
      });
      multi.render({ delta: 1 / 60 });
      await scope.queue.onSubmittedWorkDone();
      const validation = await scope.popErrorScope();
      removeProbe();
      out.msaa = { samples, validation: validation?.message ?? null };
      layer.dispose();
      // Normals cannot share a target with several samples per pixel: a coded error says so.
      const normalTarget = runtime.gpu.createTexture({
        size: [other.width, other.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const bumped = SpriteLayer.attach(multi, { atlas, normals: { atlas, target: normalTarget } });
      try {
        multi.render({ delta: 1 / 60 });
      } catch (error) {
        out.msaa.normals = error.code;
      }
      bumped.dispose();
      normalTarget.destroy();
      multi.dispose();
      other.remove();
    }

    const validation = await engine.gpu.popErrorScope();
    out.validation = validation?.message ?? null;

    // A lost device: pixels and functions come back by themselves, a plain GPUTexture asks for setAtlas.
    {
      const layer = SpriteLayer.attach(instance, { atlas });
      layer.add({ x: 10, y: 7, rect: rect(0, 0) });
      frame();
      const previous = engine.gpu,
        plainTexture = previous.createTexture({
          size: [8, 8],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
      previous.queue.writeTexture({ texture: plainTexture }, atlasData, { bytesPerRow: 32 }, [8, 8]);
      const plain = SpriteLayer.attach(instance, { atlas: plainTexture, order: 15 });
      plain.add({ x: 30, y: 7, rect: rect(0, 0) });
      const both = blank();
      cell(both, 10, 7);
      cell(both, 30, 7);
      record('plain GPUTexture atlas', difference(frame(), both));
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      plain.onPreUpdate(0);
      let code = null;
      try {
        instance.render({ delta: 1 / 60 });
      } catch (error) {
        code = error.code;
      }
      out.lostPlainAtlas = code;
      plain.setAtlas(atlas);
      const expected = blank();
      cell(expected, 10, 7);
      cell(expected, 30, 7);
      record('after device loss', difference(frame(), expected));
      plain.dispose();
      layer.dispose();
      record('after dispose', difference(frame(), blank()));
    }

    out.errors = errors.splice(0);
    return out;
  },
};
window.ready = true;
