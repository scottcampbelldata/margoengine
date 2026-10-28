// Biomes goal G1 (spec 1.1): time per km2 of each CPU stage on the reference world R16, median of N warm runs.
// Run from the repository root after `npm run build:packages`, on a quiet machine (benchmarks take the GPU lock
// exclusively): node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node bench/biomes/placement.mjs [--runs=20]
// Also the `biomes` suite of `npm run bench -- biomes`. Prints one JSON object: ms per km2 per stage, and the spread.
// Stages arrive with the milestones: relief heights (B0), climate fields (B1), classification (B2), placement (B5).
// The fields stage builds R16's region fields once in its setup (several seconds, not timed).
import { pathToFileURL } from 'node:url';
import { median } from '../lib/node.mjs';

const dist = new URL('../../packages/biomes/dist/index.js', import.meta.url).href;

/** One 256 m tile of R16 near its centre, so mountains, lowland and a river valley are all in the sample. */
export const TILE = Object.freeze({ x: 2, z: -3, size: 256 });

/** The measured stages: `{id, title, run()}`, each run() doing one tile's work at 1 m. */
export async function stages() {
  const biomes = await import(dist);
  const relief = biomes.createRelief(biomes.R16.relief),
    x0 = TILE.x * TILE.size * 1000,
    z0 = TILE.z * TILE.size * 1000,
    heights = new Int32Array(TILE.size * TILE.size);
  let world,
    next = 0;
  const list = [
    {
      id: 'relief',
      title: 'R16 relief heights at 1 m (procedural input, not a placement stage)',
      run() {
        for (let z = 0, k = 0; z < TILE.size; z++)
          for (let x = 0; x < TILE.size; x++) heights[k++] = relief.height(x0 + x * 1000, z0 + z * 1000);
      },
    },
    {
      id: 'fields',
      title: 'Climate fields of one R16 tile at 1 m (17 layers, heights from the procedural relief)',
      async setup() {
        world ??= await biomes.BiomeWorld.create({
          seed: biomes.R16.seed,
          origin: biomes.R16.origin,
          size: biomes.R16.size,
          height: { relief: biomes.R16.relief },
          climate: biomes.R16.climate,
        });
      },
      async run() {
        // A new tile each run (the world caches finished tiles), all near the centre of R16.
        await world.tile(32 + (next % 8), 30 + (next++ >> 3));
      },
    },
  ];
  return list;
}

/** ms per km2 for each stage: median and spread (min, max) over `runs` timed runs after 2 warm ones. */
export async function measure({ runs = 20 } = {}) {
  const perKm2 = 1e6 / (TILE.size * TILE.size),
    result = {};
  for (const stage of await stages()) {
    await stage.setup?.();
    await stage.run();
    await stage.run();
    const times = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await stage.run();
      times.push((performance.now() - start) * perKm2);
    }
    result[stage.id] = {
      title: stage.title,
      msPerKm2: median(times),
      min: Math.min(...times),
      max: Math.max(...times),
    };
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 20);
  console.log(
    JSON.stringify({ suite: 'biomes', world: 'R16', tile: TILE, runs, stages: await measure({ runs }) }, null, 1),
  );
}
