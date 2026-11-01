// Biomes goal G1 (spec 1.1): time per km2 of each CPU stage on the reference world R16, median of N warm runs.
// Run from the repository root after `npm run build:packages`, on a quiet machine (benchmarks take the GPU lock
// exclusively): node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node bench/biomes/placement.mjs [--runs=20]
// Also the `biomes` suite of `npm run bench -- biomes`. Prints one JSON object: ms per km2 per stage, and the spread.
// Stages: relief heights (B0), climate fields with classification (B1, B2), stored-object placement (B5). G1 is
// fields plus placement per km2; `workers` times the same work for a block of tiles on 1 and on 8 worker threads
// (B7, `--workers=<n>`).
// The fields stage builds R16's region fields once in its setup (several seconds, not timed).
import { pathToFileURL } from 'node:url';
import { median } from '../lib/node.mjs';

const dist = (entry) => new URL(`../../packages/biomes/dist/${entry}.js`, import.meta.url).href;

/** One 256 m tile of R16 near its centre, so mountains, lowland and a river valley are all in the sample. */
export const TILE = Object.freeze({ x: 2, z: -3, size: 256 });

/** World tiles the placement stage makes in its setup. */
export const PLACEMENT_SETUP = Object.freeze({ x: [39, 48], z: [29, 37] });
/**
 * The bench world's tile cache: it holds every setup tile. Past the default 64, a timed placement run remade evicted
 * fields and read about twice its real time.
 */
export const WORLD_CACHE = 256;

/** The measured stages: `{id, title, run()}`, each run() doing one tile's work at 1 m. */
export async function stages() {
  const biomes = await import(dist('index')),
    { R16 } = await import(dist('presets')),
    { createRelief } = await import(dist('relief')),
    { BiomePlacement } = await import(dist('placement'));
  const relief = createRelief(R16.relief),
    x0 = TILE.x * TILE.size * 1000,
    z0 = TILE.z * TILE.size * 1000,
    heights = new Int32Array(TILE.size * TILE.size);
  let world,
    placement,
    next = 0,
    nextPlaced = 0;
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
          seed: R16.seed,
          origin: R16.origin,
          size: R16.size,
          height: { relief: R16.relief },
          climate: R16.climate,
          cache: WORLD_CACHE,
        });
      },
      async run() {
        // A new tile each run (the world caches finished tiles), all near the centre of R16.
        await world.tile(32 + (next % 8), 30 + (next++ >> 3));
      },
    },
    {
      id: 'placement',
      title: 'Stored objects of one R16 tile (trees, shrubs, rocks; its world tiles made in the setup, not timed)',
      async setup() {
        world ??= await biomes.BiomeWorld.create({
          seed: R16.seed,
          origin: R16.origin,
          size: R16.size,
          height: { relief: R16.relief },
          climate: R16.climate,
          cache: WORLD_CACHE,
        });
        placement = BiomePlacement.attach(world);
        for (let z = PLACEMENT_SETUP.z[0]; z <= PLACEMENT_SETUP.z[1]; z++)
          for (let x = PLACEMENT_SETUP.x[0]; x <= PLACEMENT_SETUP.x[1]; x++) await world.tile(x, z);
      },
      async run() {
        await placement.tile(40 + (nextPlaced % 8), 30 + (nextPlaced++ >> 3));
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

/**
 * G1 on workers: wall time per km2 to make fields, classification and stored objects for a block of `side` x `side`
 * R16 tiles near the centre on `workers` worker threads running the built worker script, after each worker made its
 * replica (the replicas' region fields are not timed). Every placement job makes the world tiles it reads in its own
 * worker, so the neighbours a block shares across workers are made more than once and that cost is in the number.
 */
export async function measureWorkers({ workers = 8, side = 8 } = {}) {
  const biomes = await import(dist('index')),
    { R16 } = await import(dist('presets')),
    { BiomePlacement } = await import(dist('placement')),
    { ThreadWebWorker } = await import(new URL('../../packages/biomes/tests/thread-worker.js', import.meta.url).href);
  const world = await biomes.BiomeWorld.create({
      seed: R16.seed,
      origin: R16.origin,
      size: R16.size,
      height: { relief: R16.relief },
      climate: R16.climate,
      workers,
      createWorker: () => new ThreadWebWorker(),
    }),
    placement = BiomePlacement.attach(world);
  try {
    // Warm every worker: enough jobs far from the block that each worker takes some.
    await Promise.all(Array.from({ length: 2 * workers }, (_, k) => placement.tile(4 + 4 * (k % 8), 4 + 8 * (k >> 3))));
    const start = performance.now(),
      jobs = [];
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) jobs.push(placement.tile(40 + x, 40 + z));
    await Promise.all(jobs);
    const km2 = (side * side * TILE.size * TILE.size) / 1e6;
    return { workers, tiles: side * side, msPerKm2: (performance.now() - start) / km2 };
  } finally {
    world.dispose();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 20),
    workers = Number(process.argv.find((a) => a.startsWith('--workers='))?.slice(10) ?? 8);
  console.log(
    JSON.stringify(
      {
        suite: 'biomes',
        world: 'R16',
        tile: TILE,
        runs,
        stages: await measure({ runs }),
        workers: [await measureWorkers({ workers: 1 }), await measureWorkers({ workers })],
      },
      null,
      1,
    ),
  );
}
