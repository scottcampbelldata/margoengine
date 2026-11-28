import { AssetCache } from '@margoengine/cache';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { instancing } from '@margoengine/gltf/pbr-instancing';
import { createMesh, loadTexture, UnlitMaterial } from '@margoengine/materials';
import { Sky } from '@margoengine/sky';
import { TilesRenderer } from '@margoengine/tiles';
import { buildBalboDrive } from './balbo-drive.js';
import { shotAt } from './film.js';
import { asset as libraryAsset } from './assets.js';

const input = (name) => libraryAsset('four-demos-inputs/chicago/tiles/' + name);

async function loadFronts(engine) {
  const fronts = [
    ['blackstone', -87.55, -87.81, -176.1, -204.3, 8.4, 91.2],
    ['blackstone-annex', -88.05, -88.52, -204.3, -229.55, 8.15, 72.8],
    ['spertus', -88.0, -88.34, -229.55, -256.9, 7.85, 54.6],
  ];
  return Promise.all(
    fronts.map(async ([name, x1, x2, z1, z2, base, top]) => {
      const map = await loadTexture(input(`${name}.jpg`), { colorSpace: 'srgb', signal: AbortSignal.timeout(30_000) });
      const model = createMesh(
        engine,
        {
          positions: new Float32Array([x1, top, z1, x2, top, z2, x2, base, z2, x1, base, z1]),
          normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
          uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
          indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
        },
        new UnlitMaterial({ map, color: '#f5f2eb' }),
      );
      return { model, map };
    }),
  );
}

export async function buildCity(engine, shop) {
  const cache = new AssetCache({ name: 'margo-grant-park', maxBytes: 192 * 1024 ** 2, timeout: 30_000 });
  const response = await cache.fetch(input('tileset.json'), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error('Prepare the Grant Park photograph textures before opening this film.');
  const map = await loadTexture(libraryAsset('four-demos-inputs/chicago/grant-park-naip.jpg'), {
    colorSpace: 'srgb',
    signal: AbortSignal.timeout(30_000),
  });
  // Register the orthophoto using Balbo Drive and the north-south road grid.
  // X grows east and Z grows south in the local reconstruction.
  const east = (longitude) => -83 + (longitude + 87.62446) * 82844;
  const south = (latitude) => -172 + (41.87326 - latitude) * 111120;
  const left = east(-87.638),
    right = east(-87.609);
  const near = south(41.884),
    far = south(41.863);
  // The park survey ends at Michigan Avenue. Any imagery west of it
  // would put rooftops on the ground behind the buildings.
  const parkEdge = east(-87.62434);
  const u = (parkEdge - left) / (right - left);
  const y = -4.58;
  const aerial = createMesh(
    engine,
    {
      positions: new Float32Array([parkEdge, y, near, right, y, near, right, y, far, parkEdge, y, far]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([u, 0, 1, 0, 1, 1, u, 1]),
      indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
    },
    new UnlitMaterial({ map, color: '#dfe3de' }),
  );
  const [oaks, bridge, tiles, fronts] = await Promise.all([
    loadGLTF(engine, input('park-oaks.glb'), { decoders: { instancing } }),
    buildBalboDrive(engine, shop),
    TilesRenderer.load(engine, input('tileset.json'), {
      frame: 'local',
      maximumScreenSpaceError: 13,
      maxConcurrentRequests: 6,
      memoryBudget: 512 * 1024 ** 2,
      fetch: cache.fetch,
    }),
    loadFronts(engine),
  ]);
  Sky.attach(engine, {
    model: 'bruneton',
    timeScale: 0,
    sunDirection: [0.65, 0.58, -0.49],
    clouds: { coverage: 0.27, height: 1350, speed: 0.018 },
  });
  let error;
  tiles.tileset.on('error', (detail) => {
    error = detail.error;
  });
  function select() {
    const { width, height } = engine.canvas;
    engine.camera.update(width / Math.max(height, 1), true);
    return tiles.update();
  }
  async function settle(pending) {
    const signal = AbortSignal.timeout(25_000);
    while (pending) {
      if (error) throw error;
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 12));
      pending = select().pending;
    }
    if (error) throw error;
  }
  function prepareFrame() {
    const { pending } = select();
    if (error) throw error;
    if (pending) return settle(pending);
  }

  const shots = [
    [4.8, [-30, 63, -86], [-44, 69, -71], [-106, 67, -89], [-110, 79, -82], 26],
    [12.3, [184, 56, -138], [167, 49, -143], [-108, 49, -130], [-108, 48, -134], 30],
    [23.1, [11, 15.7, -162.4], [15.5, 15.8, -163.1], [25.5, 15.6, -155.2], [26, 15.7, -155.7], 35],
    [33.4, [77.5, 14.2, -174], [74.6, 15.1, -171.5], [71, 16.13, -174.3], [71, 16.28, -174.3], 20],
    [44.1, [86, 13.9, -155.8], [65, 13.0, -154.8], [67, 4.25, -139], [61, 4.3, -135], 29],
    [55.2, [-35, 25, -226], [-45, 32.2, -209], [-87.6, 29, -199], [-88.2, 40, -199], 24],
    [69.1, [67, 12.8, -158.54], [38, 12.4, -158.51], [27, 13.7, -157.2], [24, 14.5, -149.2], 37],
    [81.8, [33, 17.4, -130], [18, 18.8, -124], [-90, 33, -102], [-93, 30, -103], 31],
    [90, [47, 13.15, -165], [40, 13.0, -163.35], [27.3, 15.7, -156.04], [27.3, 15.6, -156.04], 32],
  ];
  const cues = [
    [0.2, 4.42, 'Chicago • South Michigan Avenue'],
    [5.4, 11.5, 'Balbo Drive links Michigan Avenue to Grant Park.'],
    [13.7, 20.6, 'Ornamental concrete marks the bridge entrance.'],
    [25.2, 31.3, 'Globe lanterns line the crossing.'],
    [35.2, 42.7, 'The railway runs below grade through the park.'],
    [45.6, 53.5, 'The Blackstone Hotel • South Michigan Avenue'],
    [57.0, 65.7, 'The crossing from a pedestrian’s eye level.'],
    [71.0, 79.6, 'Grant Park • Chicago'],
  ];
  return {
    apply(time) {
      return shotAt(shots, time);
    },
    prepareFrame,
    cues,
    credit: 'Chicago / Grant Park, Matthew Guertin, 2020 • CC BY 4.0',
    models: [...bridge.models, oaks],
    dispose() {
      bridge.dispose();
      oaks.dispose();
      tiles.dispose();
      for (const { model, map } of fronts) {
        model.dispose();
        map.dispose();
      }
      aerial.dispose();
      map.dispose();
      cache.dispose();
    },
    inspection: { progress: () => tiles.tileset.progress },
  };
}
