# @margoengine/biomes: Worlds, tiles and climate

Creating a world, its options, the layers of a tile, how the climate is made, region fields on your own grid and the reference world R16. One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## A world in three lines

```ts
import { BiomeWorld } from '@margoengine/biomes';

// Seed 1, a 4 km seeded landscape centred on the origin, latitude 45, westerly wind.
const world = await BiomeWorld.create();
const tile = await world.tile(8, 8); // tile indices: 256 m tiles from the world's minimum corner
const temperature = tile.layer('temperature')!; // i16 in 0.01 C, 256 x 256 cells at 1 m
console.log(temperature.data[0] * temperature.scale, world.sample(0, 0).rainfall, await world.digest(8, 8));
world.dispose(); // or `using world = await BiomeWorld.create()` inside a block
```

`world.sample(x, z)` answers point queries for gameplay (synchronous: exact from a finished tile, otherwise from
the region fields; `world.sampleRegion(x, z)` always from the region fields, whatever tiles were made).
`world.heightAt(x, z)` is the quick one for placing a character or a camera: the ground height in metres, blended
between the four height cells around the point (the values the tiles hold), without tiles, with no allocation once
warm, and the edge's height outside the world. A `BiomeView` draws the same surface to within its `textureResolution`.
`world.tiles(rect, { focus })` yields the tiles of a rectangle nearest first. `world.digest(x, z)`
is the SHA-256 of a tile's canonical bytes: the same options give the same digest on every machine, and the package
tests lock several of them. `world.update({ climate, height })` recomputes and calls `onChange` listeners with the
dirty rectangle. `tile`, `tiles`, `create` and `digest` take an `AbortSignal`.

`world.tilePart(x, z, [i0, j0, i1, j1])` makes only some cells of a tile (`i1` and `j1` exclusive), with the same bytes
as those cells of the whole tile. Placement uses it to make only the edge of each neighbour it reads. A part is never
cached and is made on the calling thread, also on a world with workers; when the world already holds the whole tile,
it answers with that (`window` is then `[0, 0, cells, cells]`). The envelopes, `whittaker` and `holdridge` classify
only the cells asked for. A `ZoneClassifier` of your own does too when it sets `perCell: true`; without it, `tilePart`
makes the whole tile and answers with that, so a part always has the whole tile's bytes.

```ts
import { BiomeWorld } from '@margoengine/biomes';

const world = await BiomeWorld.create({ tileSize: 512 });
// The 64 m strip of tile (1, 0) along its edge with tile (0, 0): 64 x 512 cells at 1 m.
const strip = await world.tilePart(1, 0, [0, 0, 64, 512]);
console.log(strip.window, strip.layer('height')!.width); // [0, 0, 64, 512] 64
world.dispose();
```

| `BiomeWorld.create` option | Default | Meaning |
| --- | --- | --- |
| `seed` | 1 | u32 seed |
| `size` | [4096, 4096] | world extent in metres, 256..65,536, multiples of `regionResolution` |
| `origin` | `-size / 2` | minimum corner in metres |
| `height` | `{ relief: {} }` | `{ samples, width, depth, unit? }` (Int32Array mm or Float32Array m, corners on the world's corners), `{ field: (x, z) => metres }` or `{ relief: ReliefOptions }` (loads `/relief`; `update` to a relief height needs it loaded, by a relief world or `import('@margoengine/biomes/relief')`) |
| `climate` | see below | climate settings |
| `tileSize` | 256 | 128, 256 or 512 m |
| `resolution` | 1 | tile cell size: 0.5, 1, 2 or 4 m |
| `regionResolution` | 16 | region cell size in metres (power of two, 4 x `resolution` up to `tileSize`) |
| `ecotone` | 24 | metres, 0..128, over which a painted edge blends into its neighbour: paint and paint masks are read at the warped cell through a box that wide, so painted borders ramp and wander like the climate ones; 0 composes paint cell by cell (a one-cell step) |
| `backend` | `'auto'` | `'cpu'` computes on the CPU. `'auto'` computes on `device` when one is given with no `workers` and the world fits it (the bounds below), and on the CPU otherwise; a tile the device fails on (a WebGPU error or a lost device) is made on the CPU with the same bytes, and after a loss every tile is. Cancellation, disposal and errors from your own callbacks still reject. `'gpu'` needs `device` and `workers: 0` (also the GPU default); `tile` and `tilePart` field layers and classification use that device. GPU region axes allow at most 32768 corners (`size / regionResolution + 1`), and the packed region (`5 * nx * nz * 4` bytes) must fit both `device.limits.maxStorageBufferBindingSize` and `maxBufferSize`; use a larger `regionResolution` or smaller `size`. Tile work uses row bands with one-cell classification margins to fit device limits. At least a three-row wide grid must fit; use fewer biomes or classifier inputs, smaller `tileSize`, larger `resolution`, or `'cpu'` otherwise. A zone scorer without `perCell` needs its full tile to fit, preserving its whole-grid reads. These bounds are checked at creation and before updates change world state. Heights and classification source values must be within +/-1073741824 (heights in mm); rescale the source or use `'cpu'` for larger values. Within this domain, output is byte-identical to `'cpu'`. Input-domain errors throw `RangeError`. Paint, zone scoring, fallback and selection run on the CPU. |
| `device` | none | `GPUDevice` required by `'gpu'` and used by `'auto'`, owned by the caller and never destroyed by the world; ignored by `'cpu'` |
| `signal` | none | rejects `create` with its reason |

| `climate` option | Default | Meaning |
| --- | --- | --- |
| `latitude` | 45 | degrees, -89..89 |
| `seaLevel` | 0 | metres |
| `lapseRate` | 5.0 | mean surface lapse rate, K per km (observed surface rates; 6.5 is the free atmosphere) |
| `lapseSplit` | 3.0 | day minus night lapse rate: 6.5 by day, 3.5 by night |
| `equatorTemperature`, `poleTemperature` | 27, -20 | mean annual sea-level C at the equator and the poles |
| `rainfall` | 900 | mm per year before orography |
| `wind` | from latitude | `[x, z]` the air moves toward; trade easterlies below 30 degrees, westerlies to 60, polar easterlies beyond |
| `rainShadow` | 0.6 | 0..1, the share of moisture a 1,500 m rise wrings out |
| `inland` | 500 | km of land between the sea and the upwind edge when no sea is upwind (continentality) |
| `coldAir` | 3 | largest night cooling of cold-air pools in K; 0 turns pooling off |
| `rainSeason` | `'auto'` | when the rain falls, for the Koppen label view: `'uniform'`, `'summer'` or `'winter'` |

### The layers of a tile

| Layer | Format | Unit | What it holds |
| --- | --- | --- | --- |
| `height` | i32 | mm | terrain height |
| `slope`, `aspect` | i16 | tan / 256, degrees x 360 / 65536 | Horn 3x3 gradient; aspect is the downslope direction clockwise from north (-Z) |
| `curvature`, `tpi` | i16 | 1e-4 / m, 0.1 m | general curvature (positive on convex ground), height minus the 49 m box mean |
| `temperature`, `coldest`, `warmest` | i16 | 0.01 C | mean annual, coldest-month and warmest-month air temperature |
| `gdd5`, `season` | u16 | C day, days | growing degree days above 5 C; days with a mean above 0.9 C |
| `treeline` | i16 | 0.01 K | Korner's thermal treeline margin: trees grow where it is 0 or more |
| `rainfall` | u16 | mm per year | rain with orography, downwind drift and rain shadow |
| `alpha`, `moisture` | u8 | 1/255 | moisture index AET / PET; soil moisture (that index, topographic wetness, nearness to water) |
| `exposure` | u8 | 1/255 | wind exposure (Winstral's Sx), 0.5 on flat ground |
| `waterDistance` | u16 | 0.1 m | distance to the sea or a river |
| `soil` | u8 | cm | soil depth proxy, 0 to 2.55 m |
| `profile`, `plan` | i16 | 1e-4 / m | profile and plan curvature, only when a request names them |

`LAYERS` lists every layer with its format, scale and unit; `value = data[z * width + x] * scale`. `LAYER_ABOUT` from
`@margoengine/biomes/editor` describes each one in a short phrase, for layer pickers and tooltips.

### How the climate is made

- Region fields on a 16 m grid over the whole world: Priority-Flood depression filling (fill depth for cold-air
  pools), rain marched along the wind (uplift condenses moisture, the condensate drifts downwind before it falls,
  descent evaporates it, a lee floor of a quarter of the base rain, recovery over 50 km), Winstral's Sx wind exposure
  over 300 m upwind, an exact Euclidean distance transform to the sea and rivers, and continentality from the
  over-land distance the air has travelled. Tiles read them by bilinear upsampling, so tiles stay independent.
- Per 1 m cell: mean annual sea-level temperature `T_eq - (T_eq - T_pole) sin^2(lat) + 28 K sin^2 cos^2` (the textbook
  `sin^2` form alone runs 5 to 7 K too cold from 30 to 60 degrees against observed zonal means), separate day and night lapse rates, a heat-load
  term on sunny slopes (south-west in the north), cold-air pooling at night in hollows, a seasonal cycle whose swing
  grows with latitude and continentality, closed-form growing degree days and season length, Korner's treeline
  margin, Hargreaves potential evapotranspiration with FAO-56 radiation, and the moisture index from Fu's form of the
  Budyko curve. Formulas, constants and sources are in `docs/clean-room.md`.
- Tile cost on one thread of the reference PC (R16 mountain tiles, `bench/biomes/placement.mjs`, best of three runs of
  20): about 28 ms per 256 m tile at 1 m for the 17 climate layers with classification (430 ms per km2) and about
  16 ms for the stored objects (250 ms per km2): 680 ms per km2 in all, against 1,340 at the start of this round and
  goal G1's 400. The same bytes as before: the gains came from an integer hash table for placement cells, shifts for
  power-of-two cells, classification that finds the nearest envelope only where it is needed and skips the blend
  steps for one-biome cells, a cache of the moisture curve and of the relief lattice. The package tests check a
  400 ms budget per tile. Exploratory runs on the same PC (2026-11-01, `--runs=20`, without the benchmark lock, which
  this session could not take): fields 396 ms per km2 (353 to 1,382) and stored objects 209 (165 to 553), 605 in
  all, at 7e3fa7060, against 404 (354 to 1,260) and 204 (163 to 554), 608, at 14e4d813d. One slow run per stage puts
  the spread of both rows far over the 10 % validity limit of `docs/benchmarking.md`, so neither row is valid; the
  medians differ by less than the run to run noise. G1's 400 is not met.
- A valid G1 measurement: `node packages/biomes/bench/placement-valid.mjs --runs=20` from the repository root. It
  builds the committed revision and the last commit before band loading (14e4d813d) from git objects, takes the GPU
  lock exclusively, waits for AC power and an idle CPU and GPU, and settles the machine between cases. Each case runs
  in its own Node process: 20 samples of relief, fields and stored objects on one thread (a fresh world per sample,
  whole neighbours made before objects are timed), of a cold placement (each tile placed once on a fresh world that
  made nothing first, so the time includes the bands it reads), and of an 8 x 8 block of tiles on 1 and on 8 worker
  threads (every worker started, warmed on another block, garbage collected and idle before the timer). It checks that
  every sample, both one-thread object cases and both revisions place the same objects, byte for byte. Each sample also
  records the process CPU time and how much of the CPU other processes used meanwhile, and `slowSamples` names why each
  slow sample was slow. It exits 1 when the lock, the gate, the sample count, a spread (max minus min, over the median)
  above 10 %, other processes over the quiet limit during a sample or that check fails; a valid run that misses G1
  prints `targetMet: false`. The full result is saved under `test-results/biomes-placement-valid/`.

## Region fields on your own grid

`@margoengine/biomes/region` holds height sampling and the region fields of a world: `BiomeWorld.create` loads it with
`import()`, so a program that only calls `defineBiome` or reads the root's climate functions never does. Its Priority-Flood and
distance transform work on any integer grid.

```ts
import { distanceTransform, priorityFlood } from '@margoengine/biomes/region';

const heights = Int32Array.of(5000, 5000, 5000, 5000, 1000, 5000, 5000, 5000, 5000); // 3 x 3 cells, millimetres
const fill = priorityFlood(heights, 3, 3, new Uint8Array(9)); // the middle cell fills 4,000 mm to its rim
const water = new Uint8Array(9);
water[4] = 1;
console.log(fill[4], distanceTransform(water, 3, 3)[0]); // 4000 2, squared cells from the corner to the middle
```

## The reference world R16

`R16` (in `/presets`) is the fixed scene of every biomes benchmark and quality report: 16 km by 16 km at 1 m, a western coast, two
river valleys, the temperate, alpine, wetland and boreal presets, about 25 million stored objects at full density. It
is plain frozen data, so the same world can be rebuilt anywhere, `createRelief(R16.relief)` included. The package test
locks its heights with a committed SHA-256 digest.
