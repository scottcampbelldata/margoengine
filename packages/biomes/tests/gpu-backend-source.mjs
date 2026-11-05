import { BiomeWorld } from '../src/world.ts';
import { LAYERS } from '../src/layers.ts';
import { presetWorlds, R16 } from '../src/presets.ts';
import { defineBiome } from '../src/define.ts';
import { carvePaths } from '../src/splines.ts';

export const BACKEND_CASE_COUNT = 17;

/**
 * Paths carved into a 1024 m world (tiles of 256 m, minimum corner -512): a flatten road and a cut track that cross the
 * tile borders at x = 0 and z = 0, and a closed Catmull-Rom loop that reaches all four centre tiles.
 */
export const CARVED_PATHS = Object.freeze([
  {
    points: [
      [-240, -150],
      [-60, -20],
      [40, 30],
      [230, -90],
    ],
    curve: 'catmull-rom',
    width: 8,
    edge: 6,
    carve: { mode: 'flatten', grade: 40 },
  },
  {
    points: [
      [-30, -230],
      [20, 0],
      [-10, 230],
    ],
    width: 3,
    edge: 2,
    falloff: 'linear',
    carve: { mode: 'cut', depth: 1.5 },
  },
  {
    points: [
      [120, 0],
      [0, 120],
      [-120, 0],
      [0, -120],
    ],
    curve: 'catmull-rom',
    closed: true,
    width: 5,
    edge: 3,
    carve: { mode: 'flatten', depth: 0.5 },
  },
]);

function equalTile(cpu, gpu, label) {
  for (const name of Object.keys(LAYERS)) {
    const a = cpu.layer(name),
      b = gpu.layer(name);
    if (
      !a ||
      !b ||
      a.format !== b.format ||
      a.width !== b.width ||
      a.depth !== b.depth ||
      a.scale !== b.scale ||
      a.unit !== b.unit
    )
      throw Error(`${label}: ${name} metadata differs`);
    const x = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    const y = new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    if (x.length !== y.length) throw Error(`${label}: ${name} byte length differs`);
    for (let k = 0; k < x.length; k++)
      if (x[k] !== y[k]) throw Error(`${label}: ${name} byte ${k}: GPU ${y[k]}, CPU ${x[k]}`);
  }
}

export async function runBackendCases(device) {
  const r16 = {
    seed: R16.seed,
    origin: R16.origin,
    size: R16.size,
    height: { relief: R16.relief },
    climate: R16.climate,
  };
  const island = presetWorlds.island;
  const eroded = { relief: { coast: 'west', rivers: 1, erosion: { iterations: 8 } } };
  const cases = [
    {
      name: 'default',
      options: {},
      tiles: [
        [8, 8],
        [0, 15],
      ],
    },
    {
      name: 'banded-envelopes',
      options: {
        resolution: 0.5,
        biomes: Array.from({ length: 80 }, (_, i) =>
          defineBiome({
            id: `band-${i}`,
            climate: { temperature: [(i % 8) * 5 - 20, (i % 8) * 5 + 10], height: [-500, 3000] },
            ground: [{ material: 'rock' }],
          }),
        ),
      },
      tiles: [[8, 8]],
    },
    {
      name: 'R16',
      options: r16,
      tiles: [
        [51, 1],
        [52, 1],
      ],
      part: [51, 1, [3, 5, 30, 23]],
    },
    {
      name: 'island',
      options: { climate: island.climate, height: { relief: island.relief }, biomes: island.biomes },
      tiles: [[8, 8]],
    },
    ...[0, 24].map((ecotone) => ({
      name: `paint-${ecotone}`,
      options: { ecotone },
      tiles: [[8, 8]],
      paint: true,
      ...(ecotone === 24 ? { part: [8, 8, [0, 9, 39, 31]] } : {}),
    })),
    {
      name: 'carved-paths',
      options: { seed: 5, size: [1024, 1024], height: carvePaths(CARVED_PATHS) },
      uncarved: { seed: 5, size: [1024, 1024] },
      tiles: [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ],
      part: [2, 1, [0, 192, 96, 256]],
    },
    {
      name: 'carved-erosion',
      options: { seed: 3, size: [1024, 1024], height: carvePaths(CARVED_PATHS, eroded) },
      uncarved: { seed: 3, size: [1024, 1024], height: eroded },
      tiles: [
        [1, 1],
        [2, 2],
      ],
    },
  ];
  // Every case must reach the device: a backend 'gpu' world whose tiles came from the CPU would match trivially.
  let submits = 0;
  const queue = device.queue,
    submit = queue.submit.bind(queue);
  queue.submit = (buffers) => {
    submits++;
    return submit(buffers);
  };
  let gpuCases = 0;
  for (const spec of cases) {
    if (
      spec.name === 'banded-envelopes' &&
      8 * (9 + 80) * 514 * 514 <= Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)
    )
      throw Error(
        'Banded case requires a default-limits device so full classification planes exceed its buffer limits',
      );
    const cpu = await BiomeWorld.create({ ...spec.options, backend: 'cpu', workers: 0 });
    let gpu, plain;
    const before = submits;
    try {
      if (spec.uncarved) plain = await BiomeWorld.create({ ...spec.uncarved, backend: 'cpu', workers: 0 });
      gpu = await BiomeWorld.create({ ...spec.options, backend: 'gpu', device, workers: 0 });
      let unpainted;
      if (spec.paint) {
        const [x, z] = spec.tiles[0];
        unpainted = await cpu.digest(x, z);
        const cells = cpu.tileSize / cpu.resolution,
          data = new Uint8Array(cells * cells);
        for (let j = 0; j < cells; j++)
          for (let i = 0; i < cells; i++) data[j * cells + i] = i < cells / 2 && j % 48 < 32 ? 255 : 0;
        const name = `paint/${cpu.biomes[1].id}`;
        cpu.writeLayer(name, x, z, data);
        gpu.writeLayer(name, x, z, data);
      }
      // Parts run before full tiles so a cached whole tile cannot hide the GPU window path.
      if (spec.part) {
        const [x, z, window] = spec.part;
        const a = await cpu.tilePart(x, z, window, { layers: Object.keys(LAYERS) });
        const b = await gpu.tilePart(x, z, window, { layers: Object.keys(LAYERS) });
        if (String(a.window) !== String(window) || String(b.window) !== String(window))
          throw Error(`${spec.name}: tilePart returned a whole cached tile`);
        if (spec.name === 'R16' && !a.layer('height').data.some((height) => height > 900000))
          throw Error(`R16 part ${x},${z} must include mountain cells above 900 m`);
        equalTile(a, b, `${spec.name} part`);
        gpuCases++;
      }
      // Concurrent tile requests must not keep shared field scratch across a GPU await.
      const gpuTiles = await Promise.all(spec.tiles.map(([x, z]) => gpu.tile(x, z, { layers: Object.keys(LAYERS) })));
      for (let i = 0; i < spec.tiles.length; i++) {
        const [x, z] = spec.tiles[i];
        const a = await cpu.tile(x, z, { layers: Object.keys(LAYERS) });
        const b = gpuTiles[i];
        if (spec.name === 'R16' && !a.layer('height').data.some((height) => height > 900000))
          throw Error(`R16 tile ${x},${z} must include mountain cells above 900 m`);
        equalTile(a, b, `${spec.name} tile ${x},${z}`);
        const expected = await cpu.digest(x, z),
          actual = await gpu.digest(x, z);
        if (expected !== actual) throw Error(`${spec.name}: world.digest differs`);
        if (plain && (await plain.digest(x, z)) === expected)
          throw Error(`${spec.name}: tile ${x},${z} is not carved (same digest as the uncarved world)`);
        if (spec.paint) {
          if (expected === unpainted) throw Error(`${spec.name}: paint did not change the digest`);
          const ids = new Set(b.layer('biome').data.filter((id) => id !== 255));
          if (ids.size < 2) throw Error(`${spec.name}: painted case needs more than one biome id`);
        }
        gpuCases++;
      }
      if (submits === before)
        throw Error(`${spec.name}: backend 'gpu' submitted no device work (tiles ran on the CPU)`);
    } finally {
      gpu?.dispose();
      plain?.dispose();
      cpu.dispose();
    }
  }
  if (gpuCases !== BACKEND_CASE_COUNT) throw Error(`Expected ${BACKEND_CASE_COUNT} GPU cases, got ${gpuCases}`);
  return gpuCases;
}
