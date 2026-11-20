// Owner/lifetime fixture for @margoengine/tiles: what an app attaches to an engine from a 3D Tiles tileset. A
// TilesRenderer (the plugin) whose root tile is a GLB box at the origin, streamed in before the first frame (each
// tile's model is a plugin of the renderer's engine, so a tile arriving mid-check would read as a registration change
// on the peer engine) and drawn in the renderer's scene; the same with a points tile, which adds a points plugin of its own; a
// TileFeatures controller fed to the renderer as its decorator. The tilesets are made in memory by the package's own
// test generator (tests/generator.js), so no file is read and nothing is downloaded. Not entries: the format parsers,
// bounds, implicit-tiling, imagery URL and WGS84 helpers are pure functions of their input; TilesFade owns no
// registration (it listens to a renderer's tileset, and goes with the renderer here); ionAsset and hostedTileset need a
// network service.
const render = 'render';
// The app's frame loop runs the renderer; content loads after fetches, so the check lets them settle and draws again.
const streamed = (made) => {
  let done = false;
  return async ({ phase, host, views }) => {
    if (phase !== render || done) return;
    done = true;
    for (let i = 0; i < 40 && !made(); i++) {
      await host.render(views);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!made()) throw new Error('OWNER_FIXTURE: the root tile did not stream in');
  };
};

export async function fixtures(load = (entry) => import(entry)) {
  const { TilesRenderer } = await load('../dist/index.js');
  const { TileFeatures } = await load('../dist/features.js');
  const { boxGLB, pnts, memoryFetch } = await load('./generator.js');
  const encoder = new TextEncoder();
  // One root tile around the origin, where the harness camera looks, with no refinement below it.
  const tileset = (uri, bytes) =>
    memoryFetch(
      new Map([
        [
          'tileset.json',
          encoder.encode(
            JSON.stringify({
              asset: { version: '1.1' },
              geometricError: 1000,
              root: {
                boundingVolume: { box: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2] },
                geometricError: 0,
                refine: 'ADD',
                content: { uri },
              },
            }),
          ),
        ],
        [uri, bytes],
      ]),
    );
  const renderer = (name, uri, bytes, extra = () => ({})) => ({
    name,
    async create({ engine, scene }) {
      const memory = tileset(uri, bytes),
        more = extra(engine),
        tiles = await TilesRenderer.load(engine, memory.url, { fetch: memory.fetch, ...more.options });
      const loaded = () => memory.requests.includes(uri) && scene.meshes.size > 0;
      // The app streams the root in before its first frame, so both engines hold their tile before anything is drawn.
      for (let i = 0; i < 40 && !loaded(); i++) {
        tiles.tileset.update({ position: [0, 0, 10], screenHeight: 64, fov: 60 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!loaded()) throw new Error(`OWNER_FIXTURE: the root tile of ${name} did not stream in`);
      return {
        plugin: tiles,
        dispose: () => {
          tiles.dispose();
          more.dispose?.();
        },
        check: streamed(loaded),
      };
    },
  });
  const box = boxGLB({ size: [2, 2, 2] }),
    points = pnts(new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]), new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]));
  return [
    renderer('TilesRenderer.glb', 'root.glb', box),
    renderer('TilesRenderer.pnts', 'root.pnts', points),
    renderer('TilesRenderer.features', 'root.glb', box, (engine) => {
      const features = TileFeatures.attach(engine);
      return { options: { decorate: features.decorate }, dispose: () => features.dispose() };
    }),
    {
      name: 'TileFeatures',
      // The controller is itself the plugin.
      create({ engine }) {
        const features = TileFeatures.attach(engine);
        return { plugin: features, dispose: () => features.dispose() };
      },
    },
  ];
}
