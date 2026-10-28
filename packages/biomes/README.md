# @margoengine/biomes

Import `margoengine/biomes` from the `margoengine` package, or `@margoengine/biomes` from this package alone; the two
are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that
work today (run in a clone, or install local tarballs).

A biome map turns a heightmap and a few climate settings into tiled layers: climate fields, biome weights and masks
that terrain, scatter and a terrain editor read. This package is optional and tree-shakable and adds 0 bytes to core
and the stage. It is built in milestones: this release has the integer foundation, climate fields, biome classification with
presets, a terrain view and editor hooks; placement of trees, rocks and props comes next.

Entries, each loaded only when used: the root (`BiomeWorld`, fields, classification), `/presets` (eight biomes, their
worlds and the reference world `R16`), `/relief` (the procedural landscape; `BiomeWorld.create` loads it only for a
relief height, the default), `/digest` (canonical bytes and SHA-256, loaded by `world.digest`), `/zones` (Whittaker and
Holdridge classifiers), `/koppen` (Koppen-Geiger labels), `/toolkit` (the integer helpers), `/view` and `/editor`. The
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
the region fields). `world.tiles(rect, { focus })` yields the tiles of a rectangle nearest first. `world.digest(x, z)`
is the SHA-256 of a tile's canonical bytes: the same options give the same digest on every machine, and the package
tests lock several of them. `world.update({ climate, height })` recomputes and calls `onChange` listeners with the
dirty rectangle. `tile`, `tiles`, `create` and `digest` take an `AbortSignal`.

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
| `backend` | `'auto'` | `'auto'` or `'cpu'`; `'gpu'` is not available yet and throws `unsupported` |
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
- Tile cost on one thread of the reference PC (R16 mountain tiles, `bench/biomes/placement.mjs`): about 25 ms per
  256 m tile at 1 m for the 17 climate layers and about 42 ms with classification (650 ms per km2; it was 1,350 before
  the kernels were rewritten over typed planes with identical bytes), checked in the package test against a 400 ms
  budget.

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
- **Ecotones that wander**: the climate inputs are warped by smooth integer noise (700 m, up to +-1.6 K and +-8 % of
  rainfall) before classification, so borders do not follow contour lines, and a 3x3 blur removes speckle from noisy
  slopes.
- **Nothing is ever empty**: a cell outside every envelope gets the nearest one by normalised distance (ties: higher
  `priority`, then id).
- **Whittaker and Holdridge** (entry `/zones`): `classifier: whittaker` weights each biome by the Whittaker classes in
  its `zones` (`WHITTAKER`, our rectangles over mean temperature and rainfall from the published diagram); `holdridge`
  by Holdridge life zones (`holdridgeZone(biotemperature, rainfall)`, nearest hexagon in log biotemperature, rainfall
  and PET ratio, such as `'cool-temperate-perhumid'`). `import { whittaker } from '@margoengine/biomes/zones'`, then
  `BiomeWorld.create({ classifier: whittaker })`.

`presets` holds `temperate`, `boreal`, `alpine`, `wetland`, `tundra`, `desert`, `savanna` and `tropical`, written as
plant functional type limits over the coldest month, growing degree days and the moisture index, with Korner's
treeline for forests, so belts move with latitude, aspect and cold air instead of fixed heights. They are plain frozen
data (the package tests check each one with `defineBiome`), so the entry is small. `presetWorlds` holds
a climate and relief where each one is common, used by the golden digests. The default world uses `temperate` with
its neighbours `alpine`, `wetland` and `boreal`. Every definition is plain JSON: `defineBiome` validates it and returns
a frozen copy.

### Painting

User layers sit on top of the climate: `world.writeLayer('paint/<biome>', x, z, data)` (u8 per cell of tile x, z)
paints a biome, `mask/<name>` writes a mask that envelopes and paint layers can read. Paint layers compose in the
world's `paint` order with a mode: `'replace'` (the default: the painted share replaces the rest), `'add'`,
`'multiply'` (0 removes a biome; the next nearest envelope takes over if nothing is left) or `'max'`, optionally
through a mask: `world.update({ paint: [{ biome: 'desert', mode: 'replace', mask: 'mask/dunes' }] })`. Writing a layer
recomputes that tile and its neighbours and calls the `onChange` listeners. `readLayer` returns a copy.

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
into the heightmap and into two ground-weight textures (the terrain's optional `weights`, one channel per material),
and again for every rectangle `world.onChange` reports. Each biome shares its weight among its ground layers by their
slope, height, moisture and curvature rules; `groundWeights(world, tile, materials)` is the same computation on the CPU
(8 bytes per cell summing to 255). Materials are generated textures from `MATERIALS` (16 built-in looks, such as
`grass`, `sand`, `rock`, `snow`; `materials` overrides or adds them). Up to 8 materials per world, the terrain's limit.
`terrainColorsFor(world)` gives `TerrainColors` sand, meadow and stone colours for small scenes drawn as one mesh.

| `BiomeView.attach` option | Default | Meaning |
| --- | --- | --- |
| `textureResolution` | 2 | metres per heightmap and weights texel, a multiple of the world resolution; raised to fit the device |
| `radius` | 1,000 | tiles within this many metres of the camera are drawn at full detail |
| `materials` | none | `{ key: { color: [r, g, b] (sRGB 0..1), detail? (0..1, default 0.25) } }` over `MATERIALS` |
| `clipmap` | cell 1 m, 64 cells, 6 rings | `cellSize`, `resolution` and `levels` of the terrain |
| `signal` | none | rejects `attach` and stops streaming |

WebGPU only. Tiles are made on the page's thread for now (about 42 ms each; the worker pool is a later milestone),
with a pause between tiles so frames keep drawing.

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
- `editor.dirty` covers every cell the last step can change, grown by `editor.margin()`: one cell for the
  classification blur plus the placement reach (6 rounds of twice the largest species crown and the widest cluster
  spread), so tiles outside it are guaranteed unchanged. The world reports the same rectangles through `onChange`, and
  `BiomeView` redraws them. Heights edited with `world.update({ height })` dirty the whole world, since rain shadow
  and continentality reach far downwind.
- Brush maths is integer, so the same edit gives the same bytes everywhere. A dab or an undo costs well under a frame;
  the touched tiles are remade on their next request (on this thread until the worker pool of a later milestone).

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
| `valueNoise(seed, x, z)`, `fbm(...)`, `ridged(...)` | smooth 2D value noise and fractal sums in Q16.16 | exact |

Q16.16 means an i32 where 65,536 (`ONE`) is 1.0. Division follows WGSL's integer rules even for a zero divisor, where
JavaScript's `(x / 0) | 0` would give 0, so the CPU and a GPU kernel can never disagree; the package test bans any other
integer division in its sources. Every helper's result is checked against a BigInt model of the same
algorithm and against float references in the package tests.

## Procedural relief

`createRelief(options)` (entry `/relief`) is a seeded landscape in integer millimetres: fractal lowlands, ridged
mountains under a mountain mask, an optional coast and river valleys. It is the default height of a biome world.

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
| `coast` | `'none'` | `'west'`, `'east'`, `'north'` or `'south'`: that side runs into the sea over a 1.5 km shelf |
| `rivers` | 0 | 0..8 river valleys (250 m half width) toward the coast |
| `seaDepth` | 40 | sea floor depth in metres |

`quantizeHeights(floats, unit?)` (in `/toolkit`) turns float heights (metres times `unit`) into integer millimetres once, so a
heightmap from any source enters the integer world the same way everywhere.

## The reference world R16

`R16` (in `/presets`) is the fixed scene of every biomes benchmark and quality report: 16 km by 16 km at 1 m, a western coast, two
river valleys, the temperate, alpine, wetland and boreal presets, about 25 million stored objects at full density. It
is plain frozen data, so the same world can be rebuilt anywhere, `createRelief(R16.relief)` included. The package test
locks its heights with a committed SHA-256 digest.

## Sources

Written clean room from public papers: Volder 1959 (CORDIC), Jarzynski and Olano 2020 (PCG hashes for GPUs), Perlin
2002 (quintic fade), Wendland 1995 (compactly supported kernels). Details in `docs/clean-room.md`.
