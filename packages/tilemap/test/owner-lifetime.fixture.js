// FogOfWar, the parsers and the cell helpers hold no engine, GPU or DOM resource; the four renderers are the entries.
// Two 16 x 16 tiles of RGBA pixels: one opaque, one half transparent.
const atlas = () => {
  const data = new Uint8Array(32 * 16 * 4);
  for (let i = 0; i < 32 * 16; i++) data.set((i % 32) < 16 ? [70, 160, 60, 255] : [150, 150, 160, 128], i * 4);
  return { width: 32, height: 16, data };
};
const tileset = { name: 'grass', firstGid: 1, tileWidth: 16, tileHeight: 16, tileCount: 2, columns: 2 };
// A tile layer, a tile object and an image object, so object maps upload both kinds.
const map = (createTileLayer, orientation = 'orthogonal') => ({
  orientation, width: 4, height: 4, tileWidth: 16, tileHeight: 16, tilesets: [tileset],
  layers: [
    createTileLayer('ground', 4, 4, new Uint32Array(16).map((_, i) => 1 + (i % 2))),
    { type: 'object', name: 'things', objects: [
      { id: 1, gid: 2, x: 16, y: 32, width: 16, height: 16 },
      { id: 2, gid: 1, x: 40, y: 48, width: 16, height: 16, rotation: 45 },
    ] },
  ],
});

export async function fixtures(load = (entry) => import(entry)) {
  const { TileMap, createTileLayer } = await load('../dist/index.js');
  const { GridTileMap } = await load('../dist/iso.js');
  const { ObjectTileMap } = await load('../dist/objects.js');
  const { PlaneTileMap } = await load('../dist/plane.js');
  const camera = { x: 0, y: 0, zoom: 1 };
  const entries = [];
  for (const [name, Kind, orientation] of [['TileMap', TileMap], ['GridTileMap', GridTileMap, 'isometric'],
    ['ObjectTileMap', ObjectTileMap], ['PlaneTileMap', PlaneTileMap]]) for (const factory of [false, true]) {
    entries.push({ name: name + (factory ? '.attach' : ''), create({ engine }) {
      const options = { map: map(createTileLayer, orientation), atlases: { grass: atlas() },
        ...(Kind === PlaneTileMap ? {} : { camera, clear: false }) };
      const plugin = factory ? Kind.attach(engine, options) : new Kind(options);
      return { plugin, dispose: () => plugin.dispose() };
    } });
  }
  // A map drawn into a texture the caller owns.
  entries.push({ name: 'TileMap target', create({ engine, dependency }) {
    const made = new Map();
    const target = () => {
      if (!made.has(engine.gpu)) made.set(engine.gpu, dependency(() => engine.gpu.createTexture({ size: [64, 64],
        format: 'rgba8unorm', usage: 16 | 4 })));
      return made.get(engine.gpu);
    };
    const plugin = new TileMap({ map: map(createTileLayer), atlases: { grass: atlas() }, camera, target });
    return { plugin, dispose: () => plugin.dispose(), cleanup: () => { for (const t of made.values()) t.destroy(); } };
  } });
  return entries;
}
