import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { ObjectTileMap, buildMapQuads } from '/packages/tilemap/dist/objects.js';
import { parseTiled } from '/packages/tilemap/dist/tiled.js';
import { createTileLayer, FLIP_D, FLIP_H, FLIP_V } from '/packages/tilemap/dist/index.js';

const W = 64,
  H = 48,
  canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [W, H] }),
  engine = engineRuntime(instance);
engine.scene.background = '#000000';
const errors = [];
engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const pixels = (w, h, n) => ({
  width: w,
  height: h,
  data: Uint8Array.from({ length: w * h * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : (n + Math.floor(i / 4) * 7 + (i % 4) * 19) % 240,
  ),
});
const images = { red: pixels(4, 8, 20), blue: pixels(6, 4, 60), mist: pixels(3, 2, 90) };
const atlases = { sheet: pixels(8, 4, 110) };
const collection = {
  name: 'props',
  firstGid: 1,
  tileWidth: 4,
  tileHeight: 8,
  tileCount: 3,
  columns: 0,
  tiles: [
    { id: 0, image: { source: 'red', width: 4, height: 8 } },
    { id: 1, image: { source: 'blue', width: 6, height: 4 } },
    {
      id: 2,
      animation: [
        { tileId: 0, duration: 10 },
        { tileId: 1, duration: 10 },
      ],
    },
  ],
};
const sheet = { name: 'sheet', firstGid: 4, tileWidth: 4, tileHeight: 4, tileCount: 2, columns: 2 };
const reference = (map, camera, time) => {
  const result = new Uint8Array(W * H * 4);
  for (let i = 3; i < result.length; i += 4) result[i] = 255;
  const quads = buildMapQuads(map, {
    camera,
    time,
    view: [0, 0, W / camera.zoom, H / camera.zoom],
    imageSize: (s) => [images[s].width, images[s].height],
  });
  for (const q of quads) {
    const source = (q.image ? images : atlases)[q.source];
    const ox = Math.round(q.origin[0] * camera.zoom),
      oy = Math.round(q.origin[1] * camera.zoom),
      ax = q.axisX.map((v) => v * camera.zoom),
      ay = q.axisY.map((v) => v * camera.zoom),
      det = ax[0] * ay[1] - ax[1] * ay[0];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - ox,
          dy = y + 0.5 - oy;
        let u = (dx * ay[1] - dy * ay[0]) / det,
          v = (dy * ax[0] - dx * ax[1]) / det;
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
        if (q.flags & 1) u = 1 - u;
        if (q.flags & 2) v = 1 - v;
        if (q.flags & 4) [u, v] = [v, u];
        const at = (Math.floor(q.texel[1] + v * q.size[1]) * source.width + Math.floor(q.texel[0] + u * q.size[0])) * 4;
        result.set(source.data.subarray(at, at + 4), (y * W + x) * 4);
      }
  }
  return result;
};
const frame = () => {
  canvas.width = W;
  instance.render({ delta: 0 });
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  const ctx = copy.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
};
window.check = {
  async run() {
    engine.gpu.pushErrorScope('validation');
    const results = [];
    const imported = await parseTiled(
      {
        width: 1,
        height: 1,
        tilewidth: 4,
        tileheight: 4,
        tilesets: [
          {
            firstgid: 1,
            name: 'collection',
            tilewidth: 4,
            tileheight: 8,
            columns: 0,
            tilecount: 1,
            tiles: [{ id: 0, image: 'red', imagewidth: 4, imageheight: 8 }],
          },
        ],
        layers: [
          { type: 'imagelayer', name: 'image', image: 'mist', imagewidth: 3, imageheight: 2, repeatx: true },
          { type: 'objectgroup', name: 'template', objects: [{ id: 1, x: 4, y: 8, template: 'tile.tx' }] },
        ],
      },
      { resolve: async () => '<template><object gid="1" width="8" height="16" rotation="90"/></template>' },
    );
    const importedTiles = ObjectTileMap.attach(instance, { map: imported, atlases: {}, images });
    const importedFrame = frame(),
      importedExpected = reference(imported, { x: 0, y: 0, zoom: 1 }, 0);
    let importedWrong = 0;
    for (let i = 0; i < importedFrame.length; i++) if (importedFrame[i] !== importedExpected[i]) importedWrong++;
    results.push({ wrong: importedWrong, imported: true });
    importedTiles.dispose();
    for (const renderOrder of ['right-down', 'left-up']) {
      const map = {
        width: 8,
        height: 4,
        tileWidth: 4,
        tileHeight: 4,
        renderOrder,
        tilesets: [collection, sheet],
        layers: [
          createTileLayer(
            'ground',
            8,
            4,
            Uint32Array.from({ length: 32 }, (_, i) => 1 + (i % 5)),
          ),
          { type: 'image', name: 'repeat', offset: [-1, 2], image: { source: 'mist' }, repeatX: true },
          {
            type: 'object',
            name: 'actors',
            objects: Array.from({ length: 8 }, (_, i) => ({
              id: i,
              x: 4 + i * 6,
              y: 12 + (i % 2) * 8,
              gid: (1 | (i & 1 ? FLIP_H : 0) | (i & 2 ? FLIP_V : 0) | (i & 4 ? FLIP_D : 0)) >>> 0,
              rotation: (i % 2) * 90,
            })),
          },
          { type: 'tile', name: 'above', width: 1, height: 1, offset: [12, 8], data: Uint32Array.of(4) },
        ],
      };
      const camera = { x: -2, y: -8, zoom: 1 };
      const tiles = ObjectTileMap.attach(instance, { map, atlases, images, camera });
      tiles.time = 15;
      const actual = frame(),
        expected = reference(map, camera, 15);
      let wrong = 0,
        first;
      for (let i = 0; i < actual.length; i++)
        if (actual[i] !== expected[i]) {
          wrong++;
          first ??= { i, got: actual[i], want: expected[i] };
        }
      results.push({ renderOrder, wrong, first, draws: tiles.stats.draws });
      tiles.setMap({ ...map, layers: [] });
      frame();
      results.push({ emptyDraws: tiles.stats.draws });
      tiles.dispose();
    }
    await engine.gpu.queue.onSubmittedWorkDone();
    return { results, validation: (await engine.gpu.popErrorScope())?.message ?? null, errors };
  },
};
window.ready = true;
