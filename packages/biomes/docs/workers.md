# @margoengine/biomes: Workers

Making tiles and objects on Web Workers, and what a placement reads from its neighbours. One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## Workers

A world makes its tiles and stored objects on Web Workers when they exist (browsers): by default hardware threads less
one, at most 4; `workers: 0` or `false` keeps everything on the page's thread, and in Node there are none unless you
pass `createWorker`. Each worker holds a replica of the world made from the same options and changed by the same calls
in the same order (paint and mask writes, `update`, placements and their updates), so a tile made in a worker is byte
for byte the page's tile: the package test compares digests of fields, placements and view tiles made both ways,
after writes and updates too. Height `samples` are copied to each worker; a `field` function cannot be sent, so a world
with one works on the page's thread. Jobs queue per worker by priority (a view passes the tile's distance), never
across a change, and go to the worker that made the neighbouring tiles when it is not much busier. A queued job
leaves the queue when its signal aborts; a worker that crashes or runs a job past 60 s is replaced by a fresh replica
and its job rejects with MargoError `'failed'`. The worker script is `dist/workers/biomes.js` (lazy: a world without
workers never loads it or the `/workers` entry); bundlers copy it as an asset, or pass your own `createWorker`.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { BiomePlacement } from '@margoengine/biomes/placement';

const world = await BiomeWorld.create({ workers: 3, cache: 32 }); // at most 32 tiles kept on this thread
const placement = BiomePlacement.attach(world); // places on the workers too
const tile = await world.tile(4, 4); // made on a worker, its arrays moved here without a copy
const objects = await placement.tile(4, 4, { priority: 1 });
console.log(tile.layers.length, objects.count, objects.groups?.length);
world.dispose(); // terminates the workers
```

| `BiomeWorld.create` option | Default | Meaning |
| --- | --- | --- |
| `workers` | threads less one, at most 4, where Web Workers exist; else 0 | worker replicas that make tiles and objects |
| `createWorker` | the package's worker script | makes one worker (custom bundlers, tests) |
| `cache` | 64 | tiles kept on this thread, least recently used first out (a default tile is about 2.6 MB) |

A placement makes its own tile whole and, of each neighbour, only the band its first Luby round reads (through
`world.tilePart`): 128 cells on R16, where the reach of all 6 rounds is wider than the 256 m tile. A neighbour that
will be placed too is made whole instead, since placing it needs it whole: one named in the `ahead` option of
`placement.tile`, or, without `ahead`, every neighbour of a tile next to one this placement placed or is placing (an area
placed tile by tile). On a world with workers, each placement job names the tiles queued after it on the same worker.
A neighbour the world already holds whole is read whole. A read past the band makes that neighbour whole and runs
again, so the objects are the same bytes.

Exploratory runs on the reference PC (`bench/biomes/placement.mjs --runs=20`, R16, an 8 x 8 block of tiles, Node
worker threads running the same script, 2026-11-01, without the benchmark lock, which this session could not take;
the bench times the block once per run, so these are single runs): fields and stored objects take 1,070 and 1,076 ms
per km2 of wall time on one worker (two runs), 484 on four and 281 on eight at 7e3fa7060, against 1,138 and 1,135,
554 and 382 at 14e4d813d. Goal G1 asks for 70 on eight workers; it is not met. A placement reads its neighbours'
fields and each worker makes the ones it needs itself, so tiles at the edges of what a worker places are still made
by more than one worker.
