// The page of browser-check.mjs: every frame is read back and compared byte for byte with an image composed on the CPU.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { createTileLayer, encodeTile, FLIP_D, FLIP_H, FLIP_V, TileMap } from '/packages/tilemap/dist/index.js';

const WIDTH = 64,
  HEIGHT = 32,
  BACKGROUND = [16, 32, 48];
/** An atlas of `columns x rows` tiles of `w x h`, every texel its own opaque colour, with margin and spacing. */
const makeAtlas = (columns, rows, w, h, margin = 0, spacing = 0, seed = 0) => {
  const width = margin * 2 + columns * w + (columns - 1) * spacing,
    height = margin * 2 + rows * h + (rows - 1) * spacing,
    data = new Uint8Array(width * height * 4);
  // Gaps are loud magenta: reading one is a visible failure.
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 255, 255], i);
  const texel = (id, u, v) => [
    (20 + seed * 40 + id * 30 + u * 9) & 255,
    (40 + id * 17 + v * 11) & 255,
    (200 - id * 13 - u * 3 - v * 5) & 255,
    255,
  ];
  for (let id = 0; id < columns * rows; id++)
    for (let v = 0; v < h; v++)
      for (let u = 0; u < w; u++) {
        const x = margin + (id % columns) * (w + spacing) + u,
          y = margin + Math.floor(id / columns) * (h + spacing) + v;
        data.set(texel(id, u, v), (y * width + x) * 4);
      }
  return { image: { width, height, data }, texel };
};
const blank = (color = [...BACKGROUND, 255]) => {
  const image = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < image.length; i += 4) image.set(color, i);
  return image;
};
const put = (image, x, y, rgba) => {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const at = (y * WIDTH + x) * 4,
    a = rgba[3] / 255;
  for (let i = 0; i < 3; i++) image[at + i] = Math.round(rgba[i] * a + image[at + i] * (1 - a));
  image[at + 3] = Math.round(rgba[3] + image[at + 3] * (1 - a));
};
/** The CPU reference of one tile: for each screen pixel, undo the flips and read the texel. */
const tile = (image, texel, id, px, py, w, h, flags = 0, scale = 1, tint = (c) => c) => {
  const d = (flags & FLIP_D) !== 0,
    drawnW = d ? h : w,
    drawnH = d ? w : h;
  for (let y = 0; y < drawnH * scale; y++)
    for (let x = 0; x < drawnW * scale; x++) {
      let u = Math.floor(x / scale),
        v = Math.floor(y / scale);
      if (flags & FLIP_H) u = drawnW - 1 - u;
      if (flags & FLIP_V) v = drawnH - 1 - v;
      if (d) [u, v] = [v, u];
      put(image, px + x, py + y, tint(texel(id, u, v)));
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
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
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
const setOf = (name, firstGid, columns, rows, w, h, extra = {}) => ({
  name,
  firstGid,
  tileWidth: w,
  tileHeight: h,
  tileCount: columns * rows,
  columns,
  ...extra,
});
const mapOf = (width, height, tileWidth, tileHeight, tilesets, layers) => ({
  width,
  height,
  tileWidth,
  tileHeight,
  tilesets,
  layers,
});
const withMap = async (options, run) => {
  const tiles = TileMap.attach(instance, options);
  try {
    await run(tiles);
  } finally {
    tiles.dispose();
  }
};

window.check = {
  async run() {
    const out = { checks: {} },
      record = (name, result) => {
        out.checks[name] = result;
      },
      grid = makeAtlas(4, 4, 2, 2);
    engine.gpu.pushErrorScope('validation');

    // A 4 x 4 map of 2 x 2 tiles, and one tile edit.
    {
      const layer = createTileLayer('a', 4, 4);
      for (let i = 0; i < 16; i++) layer.data[i] = i + 1;
      await withMap(
        {
          map: mapOf(4, 4, 2, 2, [setOf('s', 1, 4, 4, 2, 2)], [layer]),
          atlases: { s: grid.image },
          camera: { x: -3, y: -5, zoom: 1 },
        },
        async (tiles) => {
          const expected = blank();
          for (let i = 0; i < 16; i++) tile(expected, grid.texel, i, 3 + (i % 4) * 2, 5 + Math.floor(i / 4) * 2, 2, 2);
          const before = frame();
          record('4x4 map of 2x2 tiles', difference(before, expected));
          frame();
          out.idleUpload = tiles.stats.uploadedBytes;
          tiles.setTile('a', 2, 1, 16);
          const after = frame();
          out.edit = { uploadedBytes: tiles.stats.uploadedBytes, changed: difference(after, before).wrong };
          tile(expected, grid.texel, 15, 3 + 4, 5 + 2, 2, 2);
          record('edit', difference(after, expected));
          // A write into the data needs invalidate.
          layer.data[0] = 0;
          tiles.invalidate(layer);
          const cleared = frame();
          for (let y = 0; y < 2; y++)
            for (let x = 0; x < 2; x++) expected.set([...BACKGROUND, 255], ((5 + y) * WIDTH + 3 + x) * 4);
          record('invalidate', difference(cleared, expected));
        },
      );
    }

    // All eight flips of a non-symmetric tile, against the flip order Tiled documents.
    {
      const big = makeAtlas(1, 1, 4, 4),
        layer = createTileLayer('a', 8, 1),
        combos = [
          0,
          FLIP_H,
          FLIP_V,
          FLIP_H | FLIP_V,
          FLIP_D,
          FLIP_D | FLIP_H,
          FLIP_D | FLIP_V,
          FLIP_D | FLIP_H | FLIP_V,
        ];
      combos.forEach((flags, i) => {
        layer.data[i] = encodeTile(1, flags);
      });
      await withMap(
        { map: mapOf(8, 1, 4, 4, [setOf('s', 1, 1, 1, 4, 4)], [layer]), atlases: { s: big.image } },
        async () => {
          const expected = blank();
          combos.forEach((flags, i) => tile(expected, big.texel, 0, i * 4, 0, 4, 4, flags));
          const shown = frame();
          record('all eight flips', difference(shown, expected));
          // FLIP_D | FLIP_H (index 5) is a clockwise quarter turn: the tile's top left texel lands top right.
          const corner = big.texel(0, 0, 0),
            at = (5 * 4 + 3) * 4;
          record('flip D + H is 90 degrees clockwise', {
            wrong: corner.slice(0, 3).some((v, i) => v !== shown[at + i]) ? 1 : 0,
          });
        },
      );
    }

    // Margin and spacing read only inside each tile: magenta gaps never show.
    {
      const padded = makeAtlas(3, 2, 3, 3, 2, 1),
        layer = createTileLayer('a', 6, 1, Uint32Array.of(1, 2, 3, 4, 5, 6));
      await withMap(
        {
          map: mapOf(6, 1, 3, 3, [setOf('s', 1, 3, 2, 3, 3, { margin: 2, spacing: 1 })], [layer]),
          atlases: { s: padded.image },
        },
        async () => {
          const expected = blank();
          for (let i = 0; i < 6; i++) tile(expected, padded.texel, i, i * 3, 0, 3, 3);
          record('margin and spacing', difference(frame(), expected));
        },
      );
    }

    // Animation: a clock step swaps the lookup, sending no cells.
    {
      const layer = createTileLayer('a', 2, 1, Uint32Array.of(1, 2)),
        set = setOf('s', 1, 4, 4, 2, 2, {
          tiles: [
            {
              id: 0,
              animation: [
                { tileId: 3, duration: 100 },
                { tileId: 7, duration: 50 },
              ],
            },
          ],
        });
      await withMap({ map: mapOf(2, 1, 2, 2, [set], [layer]), atlases: { s: grid.image } }, async (tiles) => {
        const at = (id) => {
          const expected = blank();
          tile(expected, grid.texel, id, 0, 0, 2, 2);
          tile(expected, grid.texel, 1, 2, 0, 2, 2);
          return expected;
        };
        tiles.time = 0;
        record('animation frame 1', difference(frame(0), at(3)));
        frame(0);
        tiles.time = 100;
        const second = frame(0);
        out.animatedUpload = tiles.stats.uploadedBytes;
        record('animation frame 2', difference(second, at(7)));
        // The clock follows each frame's delta: 100 + 50 ms wraps to the first frame.
        record('animation by delta', difference(frame(0.05), at(3)));
      });
    }

    // Two tilesets, a tile bigger than its cell on the bottom left, tile offset.
    {
      const other = makeAtlas(2, 1, 4, 6, 0, 0, 3),
        layer = createTileLayer('a', 4, 2, Uint32Array.of(0, 0, 0, 0, 1, 18, 2, 19)),
        sets = [setOf('s', 1, 4, 4, 2, 2), setOf('o', 18, 2, 1, 4, 6, { tileOffset: [1, -1] })];
      await withMap(
        {
          map: mapOf(4, 2, 2, 2, sets, [layer]),
          atlases: { s: grid.image, o: other.image },
          camera: { x: -2, y: -8, zoom: 1 },
        },
        async (tiles) => {
          const expected = blank();
          // The renderer draws tileset by tileset, in firstGid order.
          tile(expected, grid.texel, 0, 2 + 0, 8 + 2, 2, 2);
          tile(expected, grid.texel, 1, 2 + 4, 8 + 2, 2, 2);
          tile(expected, other.texel, 0, 2 + 2 + 1, 8 + 2 + 2 - 6 - 1, 4, 6);
          tile(expected, other.texel, 1, 2 + 6 + 1, 8 + 2 + 2 - 6 - 1, 4, 6);
          record('two tilesets, oversize tiles', difference(frame(), expected));
          record('one draw per tileset', { wrong: tiles.stats.draws === 2 ? 0 : 1, draws: tiles.stats.draws });
        },
      );
    }

    // Layer order, offset, opacity, tint, hidden, parallax, a filter of names, integer zoom.
    {
      const low = { ...createTileLayer('low', 2, 1, Uint32Array.of(1, 2)), offset: [4, 4] },
        high = {
          ...createTileLayer('high', 1, 1, Uint32Array.of(3)),
          offset: [6, 4],
          opacity: 128 / 255,
          tint: '#ff0000',
        },
        hidden = { ...createTileLayer('hidden', 1, 1, Uint32Array.of(4)), visible: false },
        far = { ...createTileLayer('far', 1, 1, Uint32Array.of(5)), offset: [20, 4], parallax: [0.5, 0] },
        objects = { type: 'object', name: 'o', objects: [] },
        map = mapOf(2, 1, 2, 2, [setOf('s', 1, 4, 4, 2, 2)], [low, high, hidden, far, objects]);
      await withMap({ map, atlases: { s: grid.image }, camera: { x: 2, y: 0, zoom: 1 } }, async (tiles) => {
        const scene = (farX) => {
          const expected = blank();
          tile(expected, grid.texel, 0, 2, 4, 2, 2);
          tile(expected, grid.texel, 1, 4, 4, 2, 2);
          tile(expected, grid.texel, 2, 4, 4, 2, 2, 0, 1, (c) => [c[0], 0, 0, 128]);
          tile(expected, grid.texel, 4, farX, 4, 2, 2);
          return expected;
        };
        // 20 - 2 * 0.5 = 19.
        record('layer settings', difference(frame(), scene(19)));
        tiles.parallax = false;
        record('parallax off', difference(frame(), scene(18)));
      });
      await withMap(
        { map, atlases: { s: grid.image }, camera: { x: 1.25, y: 1.75, zoom: 4 }, mapLayers: ['low'] },
        async () => {
          const expected = blank();
          // (4 - 1.25) * 4 = 11, (4 - 1.75) * 4 = 9.
          tile(expected, grid.texel, 0, 11, 9, 2, 2, 0, 4);
          tile(expected, grid.texel, 1, 19, 9, 2, 2, 0, 4);
          record('camera zoom and name filter', difference(frame(), expected));
        },
      );
    }

    // Chunks: tiles on either side of each chunk edge, culling by the camera.
    {
      const layer = createTileLayer('a', 128, 128),
        cell = (x, y, id) => {
          layer.data[y * 128 + x] = id;
        };
      cell(0, 0, 1);
      cell(63, 0, 2);
      cell(64, 0, 3);
      cell(63, 63, 7);
      cell(0, 64, 4);
      cell(64, 64, 5);
      cell(127, 127, 6);
      const map = mapOf(128, 128, 2, 2, [setOf('s', 1, 4, 4, 2, 2)], [layer]);
      await withMap({ map, atlases: { s: grid.image }, camera: { x: 100, y: -2, zoom: 1 } }, async (tiles) => {
        const edge = blank();
        tile(edge, grid.texel, 1, 63 * 2 - 100, 2, 2, 2);
        tile(edge, grid.texel, 2, 64 * 2 - 100, 2, 2, 2);
        record('tiles across a chunk edge', difference(frame(), edge));
        tiles.camera = { x: 128 * 2 - WIDTH, y: 128 * 2 - HEIGHT, zoom: 1 };
        const corner = blank();
        tile(corner, grid.texel, 5, WIDTH - 2, HEIGHT - 2, 2, 2);
        record('last cell', difference(frame(), corner));
        out.culling = { draws: tiles.stats.draws };
        tiles.camera = { x: 128 - WIDTH / 2, y: 128 - HEIGHT / 2, zoom: 1 };
        const middle = blank();
        tile(middle, grid.texel, 6, WIDTH / 2 - 2, HEIGHT / 2 - 2, 2, 2);
        tile(middle, grid.texel, 4, WIDTH / 2, HEIGHT / 2, 2, 2);
        record('chunk corner', difference(frame(), middle));
        out.culling.allDraws = tiles.stats.draws;
      });
    }

    // A caller target: exact bytes with alpha, the map's background, clear false.
    {
      const target = engine.gpu.createTexture({
          size: [WIDTH, HEIGHT],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
        }),
        layer = createTileLayer('a', 1, 1, Uint32Array.of(1)),
        map = mapOf(1, 1, 2, 2, [setOf('s', 1, 4, 4, 2, 2)], [layer]);
      await withMap({ map, atlases: { s: grid.image }, target }, async () => {
        const shown = frame(),
          expected = blank([0, 0, 0, 0]);
        tile(expected, grid.texel, 0, 0, 0, 2, 2);
        record('target: exact bytes', difference(await readTexture(target), expected, 4));
        record('target: canvas untouched', difference(shown, blank()));
      });
      await withMap(
        { map: { ...map, backgroundColor: '#80ff0000' }, atlases: { s: grid.image }, target: () => target },
        async () => {
          frame();
          const expected = blank([128, 0, 0, 128]);
          tile(expected, grid.texel, 0, 0, 0, 2, 2);
          record('target: map background, premultiplied', difference(await readTexture(target), expected, 4));
        },
      );
      await withMap(
        { map, atlases: { s: grid.image }, target, clear: false, camera: { x: -10, y: 0, zoom: 1 } },
        async () => {
          frame();
          const expected = blank([128, 0, 0, 128]);
          tile(expected, grid.texel, 0, 0, 0, 2, 2);
          tile(expected, grid.texel, 0, 10, 0, 2, 2);
          record('target: clear false', difference(await readTexture(target), expected, 4));
        },
      );
      target.destroy();
    }

    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;

    // Tilesets drawn with no atlas, too small an atlas or one image per tile say so, before a pass opens.
    {
      const layer = createTileLayer('a', 1, 1, Uint32Array.of(1)),
        code = async (set, atlases) => {
          const tiles = TileMap.attach(instance, { map: mapOf(1, 1, 2, 2, [set], [layer]), atlases });
          try {
            instance.render({ delta: 1 / 60 });
            return null;
          } catch (error) {
            return error.code ?? error.message;
          } finally {
            tiles.dispose();
          }
        };
      out.collection = await code(setOf('s', 1, 0, 1, 2, 2, { tileCount: 1 }), {});
      const missing = await code(setOf('s', 1, 1, 1, 2, 2), {}),
        small = await code(setOf('s', 1, 8, 8, 2, 2), { s: grid.image });
      record('no atlas', { wrong: /no atlas/.test(missing) ? 0 : 1, missing });
      record('atlas too small', { wrong: /larger than its atlas/.test(small) ? 0 : 1, small });
      record('after those errors the canvas still draws', difference(frame(), blank()));
    }

    // A lost device: pixels and functions come back by themselves, a plain GPUTexture asks for setAtlas.
    {
      const layer = createTileLayer('a', 2, 1, Uint32Array.of(1, 2)),
        tiles = TileMap.attach(instance, {
          map: mapOf(2, 1, 2, 2, [setOf('s', 1, 4, 4, 2, 2)], [layer]),
          atlases: { s: grid.image },
        }),
        previous = engine.gpu,
        plainTexture = previous.createTexture({
          size: [grid.image.width, grid.image.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
      previous.queue.writeTexture({ texture: plainTexture }, grid.image.data, { bytesPerRow: grid.image.width * 4 }, [
        grid.image.width,
        grid.image.height,
      ]);
      const plainLayer = createTileLayer('a', 2, 1, Uint32Array.of(1, 2)),
        plain = TileMap.attach(instance, {
          map: mapOf(2, 1, 2, 2, [setOf('s', 1, 4, 4, 2, 2)], [plainLayer]),
          atlases: { s: plainTexture },
          camera: { x: -10, y: 0, zoom: 1 },
          order: 15,
        });
      const both = blank();
      tile(both, grid.texel, 0, 0, 0, 2, 2);
      tile(both, grid.texel, 1, 2, 0, 2, 2);
      tile(both, grid.texel, 0, 10, 0, 2, 2);
      tile(both, grid.texel, 1, 12, 0, 2, 2);
      record('plain GPUTexture atlas', difference(frame(), both));
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      let code = null;
      try {
        instance.render({ delta: 1 / 60 });
      } catch (error) {
        code = error.code;
      }
      out.lostPlainAtlas = code;
      plain.setAtlas('s', grid.image);
      record('after device loss', difference(frame(), both));
      plain.dispose();
      tiles.dispose();
      record('after dispose', difference(frame(), blank()));
    }

    out.errors = errors.splice(0);
    return out;
  },
};
window.ready = true;
