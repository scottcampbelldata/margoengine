# @margoengine/biomes

Import `margoengine/biomes` from the `margoengine` package, or `@margoengine/biomes` from this package alone; the two
are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that
work today (run in a clone, or install local tarballs).

A biome map turns a heightmap and a few climate settings into tiled layers: climate fields, biome weights and masks
that terrain, scatter and a terrain editor read. This package is optional and tree-shakable and adds 0 bytes to core
and the stage. It is built in milestones: this release has the integer foundation, climate fields, biome classification with
presets, a terrain view, editor hooks and the placement of trees, shrubs, rocks and props; drawn through scatter
by the view.

Entries, each loaded only when used: the root (`BiomeWorld`, fields, classification), `/presets` (eight biomes, their
worlds and the reference world `R16`), `/relief` (the procedural landscape; `BiomeWorld.create` loads it only for a
relief height, the default), `/digest` (canonical bytes and SHA-256, loaded by `world.digest`), `/zones` (Whittaker and
Holdridge classifiers), `/koppen` (Koppen-Geiger labels), `/toolkit` (the integer helpers), `/placement` (stored objects), `/stats`
(point-pattern statistics), `/view`, `/objects` (stored objects and detail drawn through scatter) and `/editor`. The
lazily loaded ones come through the package name, so an app holds one copy of each module.

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
| `backend` | `'auto'` | `'auto'` and `'cpu'` compute on the CPU. `'gpu'` needs `device` and `workers: 0` (also the GPU default); `tile` and `tilePart` field layers and classification use that device. GPU region axes allow at most 32768 corners (`size / regionResolution + 1`), and the packed region (`5 * nx * nz * 4` bytes) must fit both `device.limits.maxStorageBufferBindingSize` and `maxBufferSize`; use a larger `regionResolution` or smaller `size`. Tile work uses row bands with one-cell classification margins to fit device limits. At least a three-row wide grid must fit; use fewer biomes or classifier inputs, smaller `tileSize`, larger `resolution`, or `'cpu'` otherwise. A zone scorer without `perCell` needs its full tile to fit, preserving its whole-grid reads. These bounds are checked at creation and before updates change world state. Heights and classification source values must be within +/-1073741824 (heights in mm); rescale the source or use `'cpu'` for larger values. Within this domain, output is byte-identical to `'cpu'`. Input-domain errors throw `RangeError`. Paint, zone scoring, fallback and selection run on the CPU. |
| `device` | none | `GPUDevice` required by `'gpu'`, owned by the caller and never destroyed by the world; ignored by `'auto'` and `'cpu'` |
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

## Biomes, presets and blends

A world classifies every cell into weighted biomes: the `biome` layer holds the four strongest per cell (indices into
`world.biomes`) and `biomeWeight` their weights, which always sum to exactly 255.

```ts
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { presets } from '@margoengine/biomes/presets';

const heath = defineBiome({
  id: 'heath',
  climate: { moistureIndex: [0.45, 0.75], gdd5: [600, 1600], treeline: [0, null] },
  ground: [{ material: 'heather' }, { material: 'rock', slope: [30, null] }],
});
const world = await BiomeWorld.create({ biomes: [presets.temperate, presets.boreal, heath] });
const tile = await world.tile(4, 4);
const first = tile.layer('biome')!.data[0]; // strongest biome of cell (0, 0)
console.log(world.biomes[first].id, tile.layer('biomeWeight')!.data[0] / 255, world.sample(0, 0).biomes);
```

- **Envelopes** (`classifier: 'envelopes'`, the default): each biome lists ranges on any fields: `temperature`,
  `coldest`, `warmest`, `gdd5`, `season`, `treeline`, `rainfall`, `moistureIndex`, `moisture`, `height`, `slope`
  (degrees), `exposure`, `soil`, `waterDistance`, or `custom` ranges on any layer or on a user mask `mask/<name>`. A
  range is `[min, max]` in plain units; `null` leaves a side open. Membership is the product of Wendland kernels: 1
  well inside, a smooth band centred on each bound (`blend`, default 0.15 of the range; open ranges use a per-field
  width such as 1.5 K or 100 mm), exactly 0 beyond.
- **Ground layers** take ranges on `slope`, `height`, `moisture`, `curvature`, `temperature`, `coldest` and `warmest`
  (plus `weight`); every range given must hold, and `defineBiome` rejects any other field. The tundra preset lays snow
  where the mean annual temperature is -6 C or less, the alpine preset above 2,800 m where it is -3 C or less.
- **Ecotones that wander**: the climate inputs are warped by smooth integer noise (700 m, up to +-1.6 K and +-8 % of
  rainfall) before classification, so borders do not follow contour lines, and a 3x3 blur removes speckle from noisy
  slopes.
- **Nothing is ever empty**: a cell outside every envelope gets the nearest one by normalised distance (ties: higher
  `priority`, then id).
- **Weight**: `weight` (0.1 to 10, default 1) on a biome multiplies its membership of every cell before the top 4 are
  chosen, so on a cell two biomes cover equally, a weight 3 biome stores three times the share of a weight 1 biome
  (`priority` only breaks exact ties). A biome that is a member of a cell stays a member at any weight.
- **Whittaker and Holdridge** (entry `/zones`): `classifier: whittaker` weights each biome by the Whittaker classes in
  its `zones` (`WHITTAKER`, our rectangles over mean temperature and rainfall from the published diagram); `holdridge`
  by Holdridge life zones (`holdridgeZone(biotemperature, rainfall)`, nearest hexagon in log biotemperature, rainfall
  and PET ratio, such as `'cool-temperate-perhumid'`). `import { whittaker } from '@margoengine/biomes/zones'`, then
  `BiomeWorld.create({ classifier: whittaker })`. A classifier of your own implements `ZoneClassifier`. Set
  `perCell: true` when its scorer weights cell k from cell k of the warped inputs alone (not from the grid size or
  other cells), so `tilePart` can classify just the cells it makes; unset by default, `tilePart` makes whole tiles.

`presets` holds `temperate`, `boreal`, `alpine`, `wetland`, `tundra`, `desert`, `savanna` and `tropical`, written as
plant functional type limits over the coldest month, growing degree days and the moisture index, with Korner's
treeline for forests, so belts move with latitude, aspect and cold air instead of fixed heights. They are plain frozen
data (the package tests check each one with `defineBiome`), so the entry is small. `presetWorlds` holds
a climate and relief where each one is common, used by the golden digests. `presets.beach` is sand on low, gentle
ground by the sea (below 5 m, under 12 degrees) in any climate, and `presetWorlds.island` is a tropical island world
with its biomes ready to pass (see Procedural relief). The default world uses `temperate` with
its neighbours `alpine`, `wetland` and `boreal`. Every definition is plain JSON: `defineBiome` validates it and returns
a frozen copy.

### Painting

User layers sit on top of the climate: `world.writeLayer('paint/<biome>', x, z, data)` (u8 per cell of tile x, z)
paints a biome, `mask/<name>` writes a mask that envelopes and paint layers can read. Paint layers compose in the
world's `paint` order with a mode: `'replace'` (the default: the painted share replaces the rest), `'add'`,
`'multiply'` (0 removes a biome; the next nearest envelope takes over if nothing is left) or `'max'`, optionally
through a mask: `world.update({ paint: [{ biome: 'desert', mode: 'replace', mask: 'mask/dunes' }] })`. Writing a layer
recomputes that tile and its neighbours and calls the `onChange` listeners. Painted edges blend over the world's
`ecotone` (default 24 m): each cell reads the paint at the cell the climate warp moves it to, through a box that wide,
so a constant dab ramps from full strength to nothing across about 24 m and its border wanders by several metres like
the generated ecotones (`BiomeWorld.create({ ecotone: 0 })` keeps the old one-cell step). Stored plants follow the
blended weights, so a forest thins across the band. `readLayer` returns a copy. Stored plants
thin with the painted share: none of a replaced biome stand where its paint reaches 255, and where half is painted a
dense stand keeps somewhat more than half, because fewer seedlings meet fewer neighbours (a temperate forest keeps 75
percent at a 49 percent desert share; `tests/placement.test.js`).

### Clearings

A clearing is a biome no climate picks, with a ground and no plants, painted where stored objects and detail should
stay out (a cabin yard, a path, a beach): `custom: { 'mask/clearing': [0.5, null] }` never matches until something
writes that mask, so only paint chooses it. Where its paint reaches 255 nothing of the other biomes stands (the
`ecotone` feather ramps the edge, so the bare core is the painted radius less about 25 m). For a hard footprint
without any ground change, use `BiomePlacement` `exclusions` (lines and polygons in metres).

```ts
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';
import { BiomePlacement } from '@margoengine/biomes/placement';
import { presetWorlds } from '@margoengine/biomes/presets';

const { climate, relief, biomes } = presetWorlds.island;
const clearing = defineBiome({
  id: 'clearing',
  climate: { custom: { 'mask/clearing': [0.5, null] } },
  ground: [{ material: 'grass' }],
});
const world = await BiomeWorld.create({ size: [1024, 1024], climate, height: { relief }, biomes: [...biomes, clearing] });
const placement = BiomePlacement.attach(world);
BiomeEditor.attach(world).paint('clearing', { center: [100, 80], radius: 40, falloff: 'constant' });
const tile = await placement.tile(2, 2); // objects stay out of the painted yard; undo brings them back
console.log(tile.count, world.heightAt(100, 80)); // where to stand the cabin, in metres
```

### Koppen labels

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { KOPPEN, koppen, koppenClass } from '@margoengine/biomes/koppen';

const world = await BiomeWorld.create();
const codes = koppen(await world.tile(8, 8), world.climate.rainSeason); // one class index per cell
console.log(KOPPEN[codes[0]]); // 'Cfb' for the default world
console.log(KOPPEN[koppenClass({ temperature: 2700, coldest: 2600, warmest: 2800, rainfall: 2600, rainSeason: 'uniform' })]); // 'Af'
```

An optional view over the seasonal climate layers (Beck et al. 2018 rules, 30 classes), not a classifier: nothing
depends on it and the root entry does not include it. Monthly rainfall follows the climate's `rainSeason`.

## Drawing a world as terrain

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 140, 420], target: [0, 60, 0] } });
const world = await BiomeWorld.create();
const view = await BiomeView.attach(engine, world); // loads @margoengine/terrain on first use
await view.ready; // the tiles around the camera are in at full detail
engine.start();
// Painting a biome redraws only the tiles it touches:
world.writeLayer('paint/boreal', 8, 8, new Uint8Array(256 * 256).fill(255));
await view.whenIdle();
```

`BiomeView.attach(engine, world, options)` builds a clipmap `Terrain` (`view.terrain`, so `shadows.add(view.terrain)`
works) from the world: the region overview first, then 1 m tiles within `radius` of the camera, nearest first, written
into the heightmap and into 2 to 4 ground-weight textures (the terrain's optional `weights`, one channel per material),
and again for every rectangle `world.onChange` reports. Each biome shares its weight among its ground layers by their
slope, height, moisture, curvature and temperature rules (`temperature`, `coldest`, `warmest`: tundra snow lies where
the mean annual temperature is -6 C or less); `groundWeights(world, tile, materials)` is the same computation on the
CPU (16 bytes per cell summing to 255). The overview runs the same rules on the 16 m region grid, bilinear between its
corners (`overviewWeights(world, materials)`, from `sampleRegion`, so it does not depend on the tiles made before), so
hills beyond `radius` keep their rock and snow. With workers, `attach` makes it there, one band of texel rows per worker
(`overviewRows`, the same bytes), instead of blocking the page (about 650 ms of the zero-config attach on an RTX A6000 PC, now about 200). The terrain draws
nothing outside the world's rectangle: past an edge the sky shows. Materials are generated textures from `MATERIALS` (16 built-in looks, such as
`grass`, `sand`, `rock`, `snow`; `materials` overrides or adds them; `materialPixels(key, look)` gives the texture and
its mips): three octaves of value noise around the colour, with relief (`bump`, the terrain's `TerrainLayer.bump`) and
a large-scale light and dark (`macro`, a second sample at 96 m) so far rock and snow are not one flat grey. Rock has the
most of both, plant cover a little. Up to 16 materials per world, the terrain's limit (the 8 presets use 15); more is a
RangeError from `attach` that names the count.
`terrainColorsFor(world)` gives `TerrainColors` sand, meadow and stone colours for small scenes drawn as one mesh.

| `BiomeView.attach` option | Default | Meaning |
| --- | --- | --- |
| `textureResolution` | 2 | metres per heightmap and weights texel, a multiple of the world resolution; raised to fit the device |
| `radius` | 1,000 | tiles within this many metres of the camera are drawn at full detail |
| `materials` | none | `{ key: { color: [r, g, b] (sRGB 0..1), detail?, bump?, macro? } }` over `MATERIALS`; `detail` 0..1 (default 0.25), `bump` and `macro` 0..1 (default 0, a RangeError outside) |
| `clipmap` | cell 1 m, 64 cells, rings by world size | `cellSize`, `resolution` and `levels` of the terrain. With no `levels` the view takes the fewest rings (`clipmapLevels`, 1 to 12) that reach the far corner of the world and `radius`: 9 for a 4 km world, 12 for 65 km. A `levels` that reaches less than `radius` is a RangeError |
| `lookahead` | 3 | seconds ahead along the camera's velocity that tiles are fetched early |
| `budget` | 0.25 | milliseconds per frame the page spends copying arrived tiles in (one step always goes in) |
| `detailBudget` | 128 MiB | most bytes of detail density maps (one byte per texel per detail species, on this thread and the GPU); detail maps coarsen by halves to fit it and the device's largest texture |
| `signal` | none | rejects `attach` and stops streaming |
| `water` | `'auto'` | the sea: a `@margoengine/water` surface at `climate.seaLevel` over the world and out to the horizon (`view.water`), loaded on first use; `'auto'` draws it when the world reaches below sea level, `true` always, `false` never; Water settings (`{ depth: () => bloom.depthTexture }`) draw it with those over `SEA` |
| `sky` | none | a `Sky` (`@margoengine/sky`): the sea reflects its sky (`reflectionTexture`) and its sun glints on the waves (`lights`); without one the sea reflects a plain gradient |

WebGPU only. The view streams before every frame: tiles within `radius` of the camera, and of where the camera will be
`lookahead` seconds on, are fetched nearest first; tiles that fall out of range on their way are cancelled, and objects
of tiles left behind leave the GPU. On a world with workers (the default in browsers) the tiles, their ground weights
and their objects are made there, and the page only copies finished arrays in, a species or a detail map at a time
within `budget`. `view.prefetch(rect)` makes the tiles of a rectangle ahead of time (a planned flight, a loading
screen). Measured (goal G3, `packages/biomes/tests/flythrough-check.mjs`, RTX A6000, 4 workers): a 300 km/h flight
over the zero-config world adds nothing measurable to the slowest 1 percent of frames or to the worst frame against the
same flight with every tile made first (medians of three flights each, within the timer's 0.1 ms); copying one arrived
tile in takes 0.1 ms at the median and 0.3 ms at the 99th percentile on the page's thread.

The sea comes with the world: a world whose relief runs below `climate.seaLevel` (the wetland preset's west coast,
`coast` on `createRelief`) gets a water surface there with no option. The terrain hides it under land, so the shore
follows the coastline, with the water's shoreline foam. Rivers stay dry valleys unless you ask for water in them (below). The sea
is not `Water`'s pond default: `SEA` gives it a 512-cell grid (8 m cells on a 4 km world), two swell trains of 48 m and
27 m (0.9 m and 0.44 m high, their crests break into foam), 6 m of shoreline foam and a sea-blue body. Pass the scene's
`Sky` as `sky` and the sea reflects it: from the wetland shore at noon the sea's mean sRGB luma goes from 0.27 (a dark
teal plane) to 0.74, with waves (water-check.mjs).

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { presetWorlds } from '@margoengine/biomes/presets';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const { climate, relief } = presetWorlds.wetland;
const world = await BiomeWorld.create({ climate, height: { relief } });
const view = await BiomeView.attach(engine, world); // water: 'auto' finds the sea on the west side
console.log(view.water !== undefined); // true
```

`water: { rivers: 'auto' }` puts still water in the world's rivers, 1.5 m over the bed and falling with it toward the sea
(`@margoengine/biomes/rivers`, loaded only when asked for). The terrain hides it where the ground stands higher, so the
banks draw its edge. A world from `samples` has no lines of its own: pass yours, `rivers: [line]`, each an Int32Array of
`[x, z, ...]` millimetres. It stands still in v1.0.0 (docs/limits.md); the coupled grid has at most 512 cells a side.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create({ height: { relief: { coast: 'south', rivers: 2 } } });
const view = await BiomeView.attach(engine, world, { water: { rivers: 'auto' } });
console.log(world.rivers.length, view.water !== undefined); // 2 true
```

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { presetWorlds } from '@margoengine/biomes/presets';
import { BiomeView } from '@margoengine/biomes/view';
import { Sky } from '@margoengine/sky';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const sky = Sky.attach(engine, { hours: 12, environment: true });
const { climate, relief } = presetWorlds.wetland;
const world = await BiomeWorld.create({ climate, height: { relief } });
// The sea reflects the sky and the sun glints on its swell.
const view = await BiomeView.attach(engine, world, { sky });
await view.ready;
engine.start();
```

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create({ workers: 3 });
const view = await BiomeView.attach(engine, world, { lookahead: 4, budget: 0.5 });
await view.prefetch([-1500, -1500, 1500, 1500]); // the tiles of a planned flight, made before it starts
console.log(view.streaming); // { pending, arrived }: tiles on their way and waiting to go in
```

### Trees, rocks and grass on the terrain

By default a `BiomeView` also draws the world's stored objects and detail: it attaches a `BiomePlacement` and a
`BiomeObjects` (entry `@margoengine/biomes/objects`), which streams each tile's records into one
`@margoengine/scatter/tiles` per species mesh (dead trees as snags) and draws every detail species (grass, ferns,
reeds) with a camera-following scatter whose density map is the placement's. Meshes are the `procedural:<name>` keys
of the presets, from `@margoengine/procedural`. Pass `objects: false` for terrain alone. `view.objects` is that
`BiomeObjects` (`count` objects on the GPU, `gpuBytes`, `dropped`). Its detail density maps cover the world at
`detailResolution` metres per texel, one byte per texel per detail species; `detailBudget` (default 128 MiB) caps their
total and the device's largest texture caps each side, checked before anything is allocated:
`BiomeObjects.attach` rejects with MargoError `'unsupported'` past either (`detailFits` tells ahead), and `BiomeView`
coarsens its detail maps until they fit. GPU memory follows what is held: the zero-config
world's 172,640 streamed objects take 6.6 MB (records 8 bytes each, LOD rings 32 bytes per instance they can draw, both
sized from the held tiles with headroom, and a tree's canopy sharing its trunk's), down from 117.6 MB when every tile
slot and ring was sized for the densest case (`packages/biomes/tests/objects-check.mjs`, RTX A6000).

| `BiomeView.attach` option | Default | Meaning |
| --- | --- | --- |
| `objects` | true | draw stored objects and detail |
| `detailRadius` | 120 | metres around the camera with grass and ferns |
| `shadows` | none | a `Shadows` (`@margoengine/shadows`): the view adds its terrain and every stored-object mesh to it and removes them on dispose |

Objects are lit like the terrain: each part draws with a core `PbrMaterial` of its colour (roughness 0.85), so the sun's
direction and colour and the engine's ambient light reach them, and an attached `Shadows` shadows them. Pass `shadows` to make
the trees, shrubs, rocks and the terrain cast too; `view.objects.casters` lists the object meshes it adds (each
species' parts and the snags; grass and ferns receive shadows but do not cast).

```ts
import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const shadows = Shadows.attach(engine);
const view = await BiomeView.attach(engine, await BiomeWorld.create(), { shadows });
await view.ready;
console.log(view.objects?.casters.length); // trunks, canopies, shrubs, rocks and snags: one mesh each
engine.start();
```

Each tree, palm, birch, acacia and shrub part draws `@margoengine/procedural`'s `detail` 2, 1 and 0 meshes in its
three LOD rings (150, 400 and 1,000 m for canopy trees, 45, 120 and 300 m for the rest; a broadleaf canopy goes from
6,240 to 3,180 to 400 triangles), switched hard: a dithered fade between them cost 1.2 to 5.6 ms a frame with shadows.
Rocks, cacti and snags have one mesh. Every part takes scatter's `variation` from a hash of its position, so no two
trees share a colour: leaves `{ hue: 0.06, value: 0.15 }` with `clusters: 0.6` (canopies shade as clumps about 0.6 m
across), bark and stone `{ hue: 0.02, value: 0.1 }`. Broadleaf, birch, palm and conifer each have their own green. At the
zero-config world's wide view, 1440x900 on an RTX A6000, a frame went from 53 to 9.0 ms with shadows (20 to 4.1 ms
without; `packages/biomes/tests/objects-frame-check.mjs`), and `objects-check.mjs` checks the leaf texture and the
spread of tints. To draw a species of your own the same way:

```ts
import { Engine, Geometry, PbrMaterial } from '@margoengine/core';
import { generateTreeMesh } from '@margoengine/procedural';
import { ScatterTiles } from '@margoengine/scatter/tiles';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const levels = ([2, 1, 0] as const).map((detail) => generateTreeMesh('broadleaf', { detail })); // near, middle, far
const rings = (part: 'trunk' | 'canopy') =>
  levels.map((t) => new Geometry(t[part].positions, t[part].normals, t[part].indices)) as [Geometry, Geometry, Geometry];
const look = { bounds: [-2048, -2048, 2048, 2048], lod: [150, 400, 1000], lodFade: 0 } as const;
const trunks = ScatterTiles.attach(engine, rings('trunk'), {
  ...look,
  material: new PbrMaterial({ color: [0.22, 0.14, 0.08], roughness: 0.85 }),
  variation: { hue: 0.02, value: 0.1 },
});
ScatterTiles.attach(engine, rings('canopy'), {
  ...look,
  material: new PbrMaterial({ color: [0.14, 0.3, 0.05], roughness: 0.85 }),
  variation: { hue: 0.06, value: 0.15 },
  clusters: 0.6,
  share: trunks, // the same trees: one set of records, culling and rings
});
engine.start();
```

Shadows cost GPU time in proportion to the objects in view: every cascade draws every stored object the camera sees,
with its ring's mesh, so on a forest the shadow passes can cost more than the rest of the frame; fewer `Shadows`
`cascades` cost less and reach less far. Objects outside the view cast no shadow onto ground in it (scatter casts the
instances it culled for the camera). `packages/biomes/tests/shadows-check.mjs` checks the look.

### Forest floor and far hills

Tree crowns darken the ground: a material `'canopy'` (its look in `MATERIALS`) takes `canopy` (default 0.6 with
objects, 0 without) of the ground weight times the crown cover, on far hills and under the trees alike, and
`view.materials` lists it last. Nothing is added for a world without trees or with 16 ground materials already. The
`@margoengine/biomes/cover` entry, loaded only when `canopy` is above 0, computes the cover from the region fields
without placing a tree: density x crown area x mean crown size squared of each biome's trees, by biome weight, with
stands and suitability.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { canopyCover } from '@margoengine/biomes/cover';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create();
const view = await BiomeView.attach(engine, world, { canopy: 0.8 });
await view.ready;
const cover = canopyCover(world); // 0..255 every 16 m over the world, in all and by tree kind
console.log(cover.width, cover.depth, cover.data[0], cover.kinds.length);
engine.start();
```

Far trees follow the same cover. Beyond the view's `radius`, out to `far.radius` (default 2,500 m, count 300,000; `far:
false` turns them off, and they stay off when `radius` already reaches that far) one camera-following `Scatter` per
tree kind draws `generateTreeStandIn` (`@margoengine/procedural/standin`), a 12-triangle tree. They take over from the
stored trees over the last tile of `radius`, are lit by the engine light and cast no shadow. Their positions are
hashed, so a far tree does not grow into the stored tree that replaces it; at that distance a tree is about 5 pixels.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const view = await BiomeView.attach(engine, await BiomeWorld.create(), { far: { radius: 4000, count: 500000 } });
await view.ready;
console.log(view.objects?.farCount); // stand-ins drawn at most
engine.start();
```

## Trees, shrubs, rocks and props

`@margoengine/biomes/placement` places every species rule of the world's biomes (`plants`, `rocks`, `props`) as stored
objects: 8 bytes each, per tile, the same bytes in any tile order, tile size or machine.

On a GPU world, placement uses the world's device and produces byte-identical records, stats and density maps.
Neighbour bands and `ahead` keep the same loading rules. Device loss, GPU execution errors or emission storage
exceeding device limits after count readback reject with `MargoError` code `failed`; an aborted request rejects
with the signal's reason.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { BiomePlacement } from '@margoengine/biomes/placement';

const world = await BiomeWorld.create();
const placement = BiomePlacement.attach(world, {
  exclusions: [{ kind: 'line', points: [[-500, 0], [500, 40]], width: 6, verge: 8 }], // a road
});
const tile = await placement.tile(8, 8);
tile.forEachInstance((i) => console.log(i.key, i.x, i.z, i.scale, i.yaw, i.age)); // world metres
console.log(tile.count, tile.stats.unresolved, tile.canopy.data.length, tile.density.map((d) => d.id));
```

How it works, per tile and each layer in turn (rocks, canopy trees, understory, shrubs, props):

- **Candidates** on world-anchored cells, Poisson counts and positions from integer hashes of (seed, species, cell),
  kept with probability density x biome weight x suitability (Wendland bands on the species' ranges, as envelopes).
  **Land only**: no species is aquatic, so nothing (stored object or detail cover) grows on a cell below
  `climate.seaLevel`, whatever its biome; a coast's plants stop at the shore line under the view's sea.
- **Clusters** (`cluster`): `parents * offspring` plants per hectare cluster around hashed parents, by a Thomas
  (Gaussian), Matern (disc) or Clark 2Dt (fat-tailed: clusters with scattered outliers) kernel; the rest of the
  density is random. This is a shot-noise Cox process, the Neyman-Scott process with Poisson offspring.
- **The presets' plants**: forest trees stand in clumps (`stands: { scale: 300, cover: 0.7 }`) and grow to 2.4 times their
  mesh; every tree and shrub keeps above 3 m and 50 m from the sea or a river (`suitability`). Savanna's acacia stays open
  woodland, no stands and 1.6.
- **Stands** (`stands: { scale, cover }`, default none): a species gathers at a larger scale than its clusters, so a
  forest has stands and clearings. `cover` (0.1..1) of the ground, in patches about `scale` metres across (50..2000),
  holds the species' whole density and the rest holds none, with a soft edge, so the mean over a large area stays
  `density` and inside a stand it is `density / cover` (crowns shrink if that is more than they have room for). Species
  with the same `scale` share their clearings; give a species another `scale` to mix independent stands.
- **Hard core**: no two objects closer than a species-pair spacing (`conflicts`, default 0.85 of the summed crowns
  within a layer, 0.3 across layers, so a shrub grows under a crown but not at its trunk). Luby's rounds with hashed
  priorities settle the candidates exactly as sequential random adsorption would; after `rounds` (6) the few still
  undecided are rejected and counted (`stats.unresolved`, `stats.rounds` per round).
- **Shade**: lower layers under an earlier crown keep only their `shade` tolerance share. **Edges**: near a biome
  border or an exclusion verge, shrubs grow denser and taller and canopy trees smaller.
- **Sizes**: stem sizes from `size` (reverse-J, uneven-aged, or Weibull, even-aged), crowns as size^0.75, heights by
  Chapman-Richards. **Canopy layers** per 32 m cell by the perfect plasticity approximation: trees above the height
  where crowns fill the ground are canopy, the rest understory, which gets a size-asymmetric light share; badly
  suppressed trees die, standing or as logs (`age` 2 and 3).
- **Rasters** per tile: `canopy` (crown cover), `exclusion`, and a `density` map per detail species (grass, flowers,
  pebbles) that scatter draws per frame.

| Option | Default | Meaning |
| --- | --- | --- |
| `rounds` | 6 | Luby rounds of the hard core, 1..16 |
| `conflicts` | 0.85 / 0.3 | `{ 'oak|hazel': 0.2 }`: spacing factor on the two crown radii for a species pair |
| `exclusions` | none | `{ kind: 'line', points, width, verge? }` or `{ kind: 'polygon', points, verge? }` in metres |

`placement.inspect(rect)` lists every candidate with its fate and round (for debugging and editors); `digest(x, z)` is
the SHA-256 of a tile's palette and records; `update({ exclusions, conflicts })` and the world's edits drop the tiles
they reach (`placement.reach` metres around a change), and `onChange` reports those rectangles.

Record layout (little endian): u16 x and u16 z inside the tile (65,536 steps over the side: 3.9 mm at 256 m), u8
palette index (`tile.species`), u8 log scale (128 + 32 log2 scale), u8 yaw (256 steps a turn), u8 variant (low 4 bits)
and age (high 4 bits: 0 canopy or open grown, 1 understory, 2 dead standing, 3 fallen log). Heights are not stored;
renderers sample the terrain.

The statistics behind the quality gates are the `/stats` entry: K, L, pair correlation, G, F and J with edge
corrections, global envelope tests (studentised maximum deviation and extreme rank length), Kolmogorov-Smirnov and
Anderson-Darling tests and quantile regression.

## Editing: paint, undo and dirty rectangles

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';

const world = await BiomeWorld.create();
const editor = BiomeEditor.attach(world); // or `using editor = ...` inside a block
editor.stroke(() => {
  editor.paint('wetland', { center: [120, -40], radius: 50 }); // a biome id paints paint/<id>
  editor.paint('wetland', { center: [150, -30], radius: 50, strength: 0.5, falloff: 'linear' });
});
editor.erase('wetland', { center: [130, -35], radius: 10 });
editor.fill('mask/clearing', { rect: [0, 0, 200, 200], value: 1 });
console.log(editor.dirty, editor.edits.length); // the rectangles the last step can change, and the edits as data
editor.undo(); // the exact bytes from before the erase
```

- `paint(layer, { center, radius = 10, strength = 1, mode = 'add', falloff = 'smooth' })`: modes `'add'`,
  `'subtract'`, `'set'` (move toward the strength), `'max'` and `'min'`; falloffs `'smooth'` (quintic), `'linear'`,
  `'constant'`. `erase` moves toward 0; `fill(layer, { rect, value, mask })` sets a rectangle, scaled by a mask.
- `stroke(work)` or `using s = editor.stroke()` groups edits into one undo step; `undo()` and `redo()` restore the exact
  bytes of every raster a step touched.
- Edits are plain data (`editor.edits`, `editor.history()` as an async iterator of every edit as it is made), and
  `apply(edit)` replays one exactly: a stroke replayed in another world gives the same digests, so edits can be saved or
  synced.
- `editor.dirty` covers every cell the last step can change, grown by `editor.margin()`: what classification reads
  across (one cell for the blur, or twice the half width of the `ecotone` feather, 24 m by default) plus the placement reach (`BiomePlacement.reach` with the default spacing: two spacings per
  Luby round in every layer, the earlier layers each one reads, and the 32 m canopy cells), so tiles outside it are
  guaranteed unchanged. The world reports the same rectangles through `onChange`, and
  `BiomeView` redraws them. Heights edited with `world.update({ height })` dirty the whole world, since rain shadow
  and continentality reach far downwind.
- Brush maths is integer, so the same edit gives the same bytes everywhere. A dab or an undo costs well under a frame;
  the touched tiles are remade on their next request (on this thread until the worker pool of a later milestone).

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

## Same seed, same bytes, everywhere

Everything that decides the output is integer arithmetic: fixed-point values, integer square roots, CORDIC
trigonometry, table logarithms and PCG hashes. No `Math.sin`, `Math.exp` or float rounding decides anything, so a world
gives byte-identical layers in every browser, in Node, on the main thread or in a worker. The helpers are public, so
your own rules can follow the same contract (entry `/toolkit`).

```ts
import { ONE, atan2, hash3, qexp2, qlog2, qmul, sincos } from '@margoengine/biomes/toolkit';

const half = ONE / 2; // 0.5 in Q16.16
const quarter = qmul(half, half); // 16384, exactly 0.25
const log = qlog2(8 * ONE); // 3.0 in Q16.16 (196608)
const grown = qexp2(log); // 8.0 again (524288)
const angle = atan2(1, 1); // a 32-bit binary angle: 2^29, an eighth of a turn
const [cos, sin] = sincos(angle, [0, 0]); // both about 0.7071 in Q16.16
const roll = hash3(7, 12, -4); // a u32 from (seed, x, z): the same number on every machine
console.log(quarter, log, grown, cos, sin, roll);
```

| Helper | What it computes | Accuracy |
| --- | --- | --- |
| `qmul(a, b)`, `mulShift(a, b, s)`, `mul64(a, b)` + `mulHigh()` | Q16.16 product, `floor(a b / 2^s)`, the full signed 64-bit product | exact |
| `idiv(a, b)`, `imod(a, b)`, `udiv`, `umod` | i32 and u32 division and remainder with WGSL's rules: `x / 0` is `x`, `x % 0` is 0, `-2^31 / -1` is `-2^31` | exact |
| `divWide(n, d)`, `divFloor(n, d)`, `qdiv(a, b)` | truncated and floor division of integers up to 2^53; Q16.16 quotient (same zero rule) | exact |
| `isqrt(n)`, `qsqrt(x)` | `floor(sqrt(n))` for n up to 2^52; Q16.16 square root | exact; 1 unit |
| `qlog2(x)`, `qexp2(x)`, `qpow(x, y)` | binary logarithm by repeated squaring; table plus series exponent | 6 units; 1 unit relative |
| `atan2(y, x)`, `sincos(angle, out)` | CORDIC, angles as 32-bit binary angles (2^32 is a full turn) | about 1e-7 rad; 2 units |
| `degreesToAngle(deg)` | degrees to a binary angle, by plain arithmetic | exact |
| `wendland(r)`, `fade(t)` | Wendland C2 kernel, Perlin's quintic fade, on Q16.16 | 8 units; 2 units |
| `pcg(v)`, `hash2` to `hash5` | PCG output hash and nested multi-input hashes | exact |
| `valueNoise(seed, x, z)`, `fbm(...)`, `ridged(...)` | smooth 2D value noise, its fractal sum, and ridged simplex noise (crests in every direction) in Q16.16 | exact |

Q16.16 means an i32 where 65,536 (`ONE`) is 1.0. Division follows WGSL's integer rules even for a zero divisor, where
JavaScript's `(x / 0) | 0` would give 0, so the CPU and a GPU kernel can never disagree; the package test bans any other
integer division in its sources. Every helper's result is checked against a BigInt model of the same
algorithm and against float references in the package tests.

## Procedural relief

`createRelief(options)` (entry `/relief`) is a seeded landscape in integer millimetres: fractal lowlands, ridged
mountains under a mountain mask, an optional coast or islands and river valleys. It is the default height of a biome world. The
mask has a wavelength of 6 km, or half the longest side of a smaller world, so a 4 km world has mountains somewhere on
every seed; worlds of 12 km and more, R16 included, keep 6 km.

```ts
import { createRelief } from '@margoengine/biomes/relief';

const relief = createRelief({ seed: 7, coast: 'west', rivers: 2 });
const metres = relief.height(120_000, -340_000) / 1000; // world x 120 m, z -340 m
console.log(metres, relief.rivers.length);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `seed` | 1 | u32 seed |
| `size` | [4096, 4096] | extent in metres, each 64..65,536 |
| `origin` | `-size / 2` | minimum corner in metres |
| `base` | 120 | mean lowland height in metres |
| `relief` | 900 | ridge height above the lowland in metres, 0..8,000 |
| `coast` | `'none'` | `'west'`, `'east'`, `'north'` or `'south'`: that side runs into the sea over the shelf; `'island'`: islands with sea on every side |
| `rivers` | 0 | 0..8 river valleys toward the coast (on islands, out from the peak to the sea) |
| `seaDepth` | 40 | sea floor depth in metres |
| `shelf` | 1500 | width of a straight coast's shelf from the sea floor up to the land in metres, 1..16,000 |
| `valley.width` | 250 | valley half width in metres, 1..4,000 (islands: a sixth of the radius when that is less) |
| `valley.floor` | 0 | half width of a flat floor at the bed in metres, below `width` and `mouth` |
| `valley.mouth` | `valley.width` | half width at the mouth in metres; the valley widens (an estuary) or narrows over its last kilometre |
| `islands.count` | 1 | 1..8 islands, each centred from the seed |
| `islands.radius` | a third of the shorter side | outer shelf edge on the long axis in metres, 100 m to 0.39 of the shorter side (a sixth for 2 to 4 islands, a ninth for 5 to 8) |
| `islands.shelf` | `shelf`, else 0.3 of the radius | shelf width from the sea floor up to the beach in metres |

Each island is an ellipse (a hashed turn and stretch) warped by noise into bays and headlands, a shelf from the sea
floor up to a beach ring 1 to 4 m above the sea and 60 to 120 m wide, then land that climbs to a peak with ridge spurs
(ridged noise at a third of the radius). `relief.islands` lists their centres and radius in millimetres. The
island preset world puts one in a tropical climate with its own biomes: `tropical` and `temperate` kept above 4 m and
`beach` on the shore.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { presetWorlds } from '@margoengine/biomes/presets';

const { climate, relief, biomes } = presetWorlds.island;
const world = await BiomeWorld.create({ climate, height: { relief }, biomes });
console.log(world.sample(0, 0).height); // the peak is near the middle; every edge is 40 m under the sea
```

`quantizeHeights(floats, unit?)` (in `/toolkit`) turns float heights (metres times `unit`) into integer millimetres once, so a
heightmap from any source enters the integer world the same way everywhere.

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

## Hydrology

`@margoengine/biomes/hydrology` runs water over a world's region grid in integers, so the same world gives the same bytes
everywhere: the filled surface (Priority-Flood), drainage over flats, D8 directions and flow (`multiple: true` adds shares over
every lower neighbour, Freeman 1991), wetness, height above drainage (HAND), lakes, channels and the distance to water. The
world's own layers do not change; `hydrologyTile` gives the same fields as rasters of a tile. `riversOf` turns channels into
lines for `water: { rivers }`, falling to the mouth (the default rivers stay the relief's lines).

`await hydrologyOfAsync(world, options, { signal })` uses the world's device on a GPU world and the CPU otherwise,
with byte-identical typed arrays. It rejects with the signal's reason on abort, or `MargoError` code `failed` on
device loss or GPU execution errors. The synchronous `hydrologyOf(world, options)` always runs on the CPU.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { hydrologyOfAsync, hydrologyTile, riversOf } from '@margoengine/biomes/hydrology';

const world = await BiomeWorld.create({ size: [2048, 2048], height: { relief: { coast: 'south', relief: 600 } } });
const h = await hydrologyOfAsync(world, { channelCells: 400 });
const { lines } = riversOf(world, h); // pass these to BiomeView's water: { rivers: lines }
const [flow, twi, hand, lake, channel] = hydrologyTile(world, h, 3, 3);
console.log(lines.length, flow.data[0], twi.data[0], hand.data[0], lake.data[0], channel.data[0]);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `sea` | the world's sea level with `hydrologyOf` or `hydrologyOfAsync`, none with `hydrology` | mm; cells below it are outlets |
| `channelCells` | the cells of 1 km2, at least 8 | flow that makes a cell a channel |
| `lakeDepth` | 1,000 | fill depth in mm that makes a cell a lake |
| `multiple` | false | route `shares` over every lower neighbour; wetness reads them |

## Seasons

`@margoengine/biomes/seasons` gives each cell a state for one day of the year, 4 bytes in integers (the same bytes
everywhere): R green-up, G senescence, B snow and A wetness, each 0 to 255. It reads the temperature, warmest-month,
rainfall and moisture layers the world already makes and adds none, so tiles, placement and their digests do not change.

- **Green-up** counts degree days above 5 C from the spring crossing (the partial-year integral of the sinusoidal year,
  McMaster and Wilhelm 1997); 200 C day is full green. A cell above 5 C all year stays green.
- **Senescence** grows from the warmest day to the autumn crossing of 5 C, as the share of the cooling between them,
  and stays full through the dormant season.
- **Snow** is the precipitation of the days below 0 C since the autumn crossing, melted at 3 mm per thaw degree day (Hock
  2003) from the spring crossing; 50 mm of snow water covers the ground fully, less covers it in proportion. What the
  summer cannot melt lies all year, and below 0 C all year the year's precipitation lies, so a cold, dry cell stays
  thinly covered.
- **Wetness** is the soil moisture, raised toward 255 by `weather.rain`.

The counts start at the season crossings, not at 1 January, so 31 December runs into 1 January without a step. South
of the equator the year is half a year on. `seasonalColor(base, state)` turns a colour with the state: autumn orange,
bare straw in winter, darker on wet ground and white under snow. Species with `color: { seasonal: true }` and biomes
with `tint: { seasonal: true }` follow it when `BiomeView` or `BiomeObjects` gets the seasons. `seasonalMix(state)`
is the same curve as one mix, `[r, g, b, amount]`, for a shader: `base + (rgb - base) * amount`. Both work in linear
RGB, so mix in linear light. `seasons.tintAt(x, z)` gives that mix at a place as 4 bytes for an `rgba8unorm-srgb`
texture: the linear colour sRGB encoded, then the linear amount, scaled by the share of seasonal biomes there.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeSeasons, seasonalColor } from '@margoengine/biomes/seasons';

const world = await BiomeWorld.create({ size: [1024, 1024], climate: { latitude: 50 } });
using seasons = BiomeSeasons.attach(world, { dayOfYear: 300, weather: { rain: 0.4 } });
const state = await seasons.tile(1, 1); // rgba8, one texel per cell
const [green, autumn, snow, wet] = seasons.at(0, 0);
const leaf = seasonalColor([0.14, 0.3, 0.05], state.data, 0);
seasons.set({ dayOfYear: 20 }); // midwinter; views and objects that hold these seasons repaint
console.log(green, autumn, snow, wet, leaf);
```

With a view, pass the seasons as an option. The plant cover ground of seasonal biomes is drawn through a tint texture
of `tintAt` over the world (the terrain's `tint`, a texel every `regionResolution` metres, 16 m by default, or every
`textureResolution` when that is coarser), so each place shows its own snow, wet ground and green-up, and ground of
other biomes keeps its look. The foliage of seasonal species takes the state at the centre of the objects' bounds, one
colour per species. Each `seasons.set` and each world change repaints the tint and the foliage colours. Without
`seasons` the view draws exactly what it drew before.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { presets } from '@margoengine/biomes/presets';
import { BiomeSeasons } from '@margoengine/biomes/seasons';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const temperate = defineBiome({ ...presets.temperate, tint: { seasonal: true } });
const world = await BiomeWorld.create({ biomes: [temperate, presets.alpine] });
const seasons = BiomeSeasons.attach(world, { dayOfYear: 290 });
const view = await BiomeView.attach(engine, world, { seasons });
seasons.set({ dayOfYear: 120 }); // spring green-up
console.log(view.materials);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `dayOfYear` | required | integer 1 to 365, 1 is 1 January |
| `weather.snowfall` | 1 | share of the cold season's precipitation that lies as snow, 0 to 1 |
| `weather.rain` | 0 | rain now, 0 to 1: wetness rises from the soil moisture toward 255 |

## Disturbance

`@margoengine/biomes/disturbance` computes independent region data. `age` is a u16 count of years since the last
burn at the end of the history, with 65535 meaning never burned. `flood` is the smallest listed return period in
years whose water stage reaches the cell: 1 on water, 0 if no listed flood reaches it. `stage` is a u8 succession
index: 0 burnt, 1 grass, 2 shrub, 3 young stand, 4 mature with the default thresholds. Frequently flooded cells
stop at stage 1. Flood is derived from hydrology, independently of the seed. Without hydrology, flood is 0;
explicit water masks still block fire.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { hydrologyOf } from '@margoengine/biomes/hydrology';
import { disturbanceOf, disturbanceTile } from '@margoengine/biomes/disturbance';

const world = await BiomeWorld.create({ size: [256, 256], resolution: 4, height: { relief: { coast: 'west' } } });
const h = hydrologyOf(world);
const d = disturbanceOf(world, h, { seed: 7, years: 20 });
const layers = disturbanceTile(world, d, 0, 0);
console.log(layers.map((layer) => layer.name)); // age, flood, stage
```

Compute the region once, then sample its nearest corners in any tile order. Rerun after changing the region or
hydrology. No result changes `BiomeWorld`, its tile digests, placement, or rendering. Setting both `fire: false`
and `flood: false` produces age 65535, flood 0, and the oldest succession stage everywhere. Importing the root entry
does not load disturbance. All work here is synchronous and CPU only: nothing loads or waits, so these functions
take no AbortSignal. For large worlds, the existing `/workers` entry can prepare world fields off the main thread;
it does not dispatch disturbance. Run this synchronous calculation in an application worker if needed.

| Option | Default | Meaning |
| --- | --- | --- |
| `seed` | 0 | unsigned 32-bit seed for fire |
| `years` | 100 | integer history length, 1 to 10000; the last year has age 0 |
| `fuel` | 128 everywhere | Uint8Array of nx times nz values; 0 cannot burn, 255 is full fuel |
| `water`, `rock` | no masks | Uint8Array masks of 0 or 1; water combines with `h.water === 0`; neither can burn |
| `fire` | `{}` | settings below, or `false` |
| `fire.ignitionsPerYear` | 1 | seeded attempts per year, integer 0 to 65535 |
| `fire.ignitions` | `[]` | authored cell indices ignited in year 0 before seeded attempts |
| `fire.duration` | 480 | whole minutes per fire, 0 to 2147483646 |
| `fire.wind.speed`, `fire.wind.direction` | 0, 0 | speed 0 to 100 m/s; finite degrees, 0 toward +x, clockwise toward +z |
| `fire.moisture` | 0.2 | fraction of extinction moisture, 0 to 1; 1 stops ignition and spread |
| `fire.recovery` | 5 | integer years before reburning, 0 to 10000; never twice in one year |
| `flood` | `{}` | settings below, or `false` |
| `flood.returnPeriods` | `[2, 10, 100]` | strictly ascending whole years, 2 to 65535; `[]` tests no periods, water remains 1 |
| `flood.wetland` | 2 | periods at or below this whole year, 1 to 65535, cap succession at 1 |
| `succession.stages` | `[1, 5, 20, 80]` | strictly increasing whole ages 1 to 65535, up to 255 thresholds |

`successionStage(age, cap, stages)` counts thresholds at or below age and takes the smaller of that count and cap.
`encodeDisturbance` and `decodeDisturbance` round-trip the independent data, including height. MGDS version 1 stores
four magic bytes, a u32 version, u32 nx, nz, step in mm, seed and years, then each cell's i32 height, u16 age, u16 flood
and u8 stage, all multi-byte values little endian. Decode requires exactly one complete record.

### Sources and limits

The code was written from these descriptions and Margo's integer helpers. No other engine source was read.
Fire uses least-time paths on 16 neighbours with an integer-minute cost and a heap ordered by time then cell index.
Every cell touched by a move must be burnable, including both cells at diagonal corners. A fire's eligibility stays
fixed until that search ends; previous fires and previous years supply the recovery barriers. Seeded chances are
fuel divided by 255 times moisture damping. Never burned means the oldest age, including for custom thresholds.

| Source | URL or DOI | Exact claim used | Assumptions and limits |
| --- | --- | --- | --- |
| Rothermel 1972, INT-115 | [USDA paper](https://research.fs.usda.gov/download/treesearch/32533.pdf) | Moisture damping is `1 - 2.59r + 5.11r² - 3.52r³`; wind and slope multiply spread through `1 + phiW + phiS`; slope uses squared tangent. | Paper equations verified in this run. Full-fuel base rate 1000 mm/min, slope K=5, wind C=0.1 and B=1.5 are assumptions, not fitted fuel models. Uphill tangent is capped at 2. |
| Finney 2002 | [10.1139/x02-068](https://doi.org/10.1139/x02-068) | Least-time paths over a spatial network produce fire perimeters comparable to expanding fronts. | Paper abstract verified through an indexed primary-paper copy; DOI resolver unavailable. Our finite stencil and integer minutes approximate propagation. Cosine-weighted wind is a stand-in for the elliptical law; no spotting or leap across barriers. |
| Connell and Slatyer 1977 | [10.1086/283241](https://doi.org/10.1086/283241) | Conceptual motivation for stage sequences following disturbance. | Publisher abstract and DOI verified in this run. The chosen thresholds are assumptions; there are no fire-adapted species flags or species dynamics. |
| Botkin, Janak and Wallis 1972 | [10.2307/2258570](https://doi.org/10.2307/2258570) | Historical gap-model motivation for forest development over time. | Not re-verified in this run: primary page inaccessible. This is a threshold model, not a reproduction of the gap model. |
| Renno et al. 2008 | [10.1016/j.rse.2008.03.018](https://doi.org/10.1016/j.rse.2008.03.018) | HAND measures elevation relative to drainage along flow paths. | Not re-verified in this run: primary page inaccessible. Margo consumes the existing hydrology HAND and direction arrays. |
| Nobre et al. 2011 | [10.1016/j.jhydrol.2011.03.051](https://doi.org/10.1016/j.jhydrol.2011.03.051) | HAND classes describe soil water environments, not universal flood return periods. | Publisher summary verified in this run; DOI resolver unavailable. Flood depths must be modelled separately, not taken from fixed HAND classes. |
| Leopold and Maddock 1953 | [USGS PP252](https://pubs.usgs.gov/pp/0252/report.pdf), [10.3133/pp252](https://doi.org/10.3133/pp252) | Hydraulic depth varies with discharge as a power, with an illustrative exponent near 0.4. | Not re-verified in this run: primary report and DOI inaccessible. Discharge proportional to catchment area is an assumption. Depth coefficient 10 mm per m² raised to 0.4 is uncalibrated. |
| Chow 1951 | [10.1029/TR032i002p00231](https://doi.org/10.1029/TR032i002p00231) | Frequency-factor framing of a return-period quantile. | Not re-verified in this run: primary page inaccessible. Uses the brief's Gumbel factor `-(sqrt(6)/pi)(0.5772 + ln ln(T/(T-1)))`, tabulated in Q16 for default periods and calculated in fixed point for custom periods. |
| Gumbel 1941 | [10.1214/aoms/1177731747](https://doi.org/10.1214/aoms/1177731747) | Extreme-value return-period framing for flood flows. | Publisher title and DOI verified, full formula not re-verified in this run. No local flood calibration or hydraulic routing is claimed. |

Flood follows each D8 path to the first channel or outlet, with memoised drainage. Catchment area is flow times
step squared; fixed-point logarithms avoid overflowing that product. These synthetic layers support authored worlds,
not forecasts of actual fires or flood risk. No performance or package-size target was measured for this entry.

## The reference world R16

`R16` (in `/presets`) is the fixed scene of every biomes benchmark and quality report: 16 km by 16 km at 1 m, a western coast, two
river valleys, the temperate, alpine, wetland and boreal presets, about 25 million stored objects at full density. It
is plain frozen data, so the same world can be rebuilt anywhere, `createRelief(R16.relief)` included. The package test
locks its heights with a committed SHA-256 digest.

## Sources

Written clean room from public papers: Volder 1959 (CORDIC), Jarzynski and Olano 2020 (PCG hashes for GPUs), Perlin
2002 (quintic fade), Wendland 1995 (compactly supported kernels). Details in `docs/clean-room.md`.
