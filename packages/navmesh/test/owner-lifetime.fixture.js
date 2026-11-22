// Owner/lifetime fixture for @margoengine/navmesh. The builders, queries, crowd, tiles and obstacles are arithmetic on
// typed arrays and plain objects, and the worker build (`@margoengine/navmesh/wasm`) needs a browser Worker host that
// refuses without one and releases its worker, timer and signal listener in its own `finally` (covered by
// test/wasm.test.js). The entry that holds something on an engine is `@margoengine/navmesh/debug`: NavDebug adds three
// lines to a Lines plugin and must take them away on dispose. Both a plain mesh and a tiled one are drawn, with a crowd
// whose agents are redrawn on update and a route shown, so every line has data when it is released.
import { Lines } from '../../lines/dist/index.js';

const floor = [0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20];
const faces = [0, 2, 1, 0, 3, 2];
const options = { cs: 0.25, ch: 0.1, walkableRadius: 2, walkableHeight: 10 };

export async function fixtures(load = (entry) => import(entry)) {
  const { Crowd } = await load('../dist/index.js');
  const { buildNavMesh } = await load('../dist/build.js');
  const { NavDebug } = await load('../dist/debug.js');
  const { TiledNavMesh } = await load('../dist/tiles.js');
  return ['NavMesh', 'TiledNavMesh'].map((kind) => ({
    name: `NavDebug.${kind}`,
    create({ engine }) {
      const mesh =
        kind === 'NavMesh'
          ? buildNavMesh(floor, faces, options)
          : new TiledNavMesh(floor, faces, { ...options, tileSize: 32 });
      const lines = Lines.attach(engine);
      const crowd = new Crowd(mesh);
      crowd.addAgent({ position: [5, 0, 5], radius: 0.5 });
      const debug = new NavDebug(lines, mesh, { crowd });
      debug.showRoute(mesh.route([1, 0, 1], [19, 0, 2]));
      debug.update();
      return {
        plugin: lines,
        dispose: () => {
          debug.dispose();
          crowd.dispose();
          lines.dispose();
        },
      };
    },
  }));
}
