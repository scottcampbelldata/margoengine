# @margoengine/biomes

A biome map turns a heightmap and a few climate settings into tiled layers: climate fields, biome weights and masks
that terrain, scatter and a terrain editor read. Forests, meadows, snow and sand land where the climate puts them, and
the same seed gives the same bytes on every machine. This package is optional and tree-shakable and adds 0 bytes to
core and the stage. This release has the integer foundation, climate fields, biome classification with presets, a
terrain view, editor hooks and the placement of trees, shrubs, rocks and props, drawn through scatter by the view.

## Install

Import `margoengine/biomes` from the `margoengine` package, or `@margoengine/biomes` from this package alone; the two
are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that
work today (run in a clone, or install local tarballs).

## Hello world

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const camera = { position: [-1700, 1500, 1300], target: [0, 300, 0], far: 20000 } as const;
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu', camera });
const world = await BiomeWorld.create(); // seed 1, a 4 km landscape centred on the origin, latitude 45
const view = await BiomeView.attach(engine, world); // terrain, ground materials, trees, grass and the sea
await view.ready; // the tiles around the camera are in at full detail
engine.start();
console.log(world.sample(0, 0).biomes, world.heightAt(0, 0)); // the biomes and the ground height at the origin
```

The [Biomes demo](../../examples/biomes/index.html) (`npm run dev:examples`, then open `/examples/biomes/`) shows the
same world with every control below: climate sliders, presets, a map of each layer, painting and the file exports. Classification is exact integer maths, so `sample`, `sampleRegion` and tiles answer within about 137,000 km of the
origin and throw a `RangeError` past it.

## The layer gallery

Every tile holds these layers, 256 x 256 cells at 1 m by default; `tile.layer(name)` returns one and `LAYERS` lists
their formats and units. What each one looks like as a map:

| Layer | As a map |
| --- | --- |
| `height`, `slope`, `aspect`, `curvature`, `tpi` | the land itself: ridges, valley floors, sunny and shaded sides, crests and hollows |
| `temperature`, `coldest`, `warmest` | cold on the peaks and in night-time cold-air pools, warm on low sunny slopes |
| `gdd5`, `season`, `treeline` | where the growing season is long enough for trees; the treeline margin crosses 0 at the tree limit |
| `rainfall` | wet on the windward side of mountains, a rain shadow behind them |
| `alpha`, `moisture`, `exposure` | dry ridges, damp hollows and stream sides, wind-blasted crests |
| `waterDistance`, `soil` | distance to the sea or a river; soil deep in hollows, thin on convex crests and steep slopes |
| `biome`, `biomeWeight` | the four strongest biomes of every cell and their shares, blended across wandering borders |

`koppen(tile)` (entry `/koppen`) adds Koppen-Geiger climate labels, and painted `paint/<biome>` and `mask/<name>`
layers sit on top of the climate. The demo draws the biome, Koppen, temperature, rainfall and soil maps side by side
with the terrain.

## Guides

| Guide | What it covers |
| --- | --- |
| [Worlds, tiles and climate](docs/worlds-and-climate.md) | `BiomeWorld.create` options, tiles and tile parts, every layer, how the climate is made, the G1 speed numbers, region fields, the reference world R16 |
| [Biomes, presets, painting and editing](docs/biomes-and-painting.md) | `defineBiome`, envelopes, Whittaker and Holdridge, multi-noise maps, the presets, painting, clearings, Koppen labels, `BiomeEditor` with undo |
| [Drawing a world as terrain](docs/terrain-view.md) | `BiomeView` options, materials, the sea and river water, trees and grass, shadows, the forest floor and far trees |
| [Trees, shrubs, rocks and props](docs/placement.md) | `BiomePlacement`: clusters, stands, the hard core, shade, sizes, exclusions, the record layout, `/stats`; `/graph`: rule graphs that shape where each species grows |
| [Workers](docs/workers.md) | tiles and objects on Web Workers, caching, what a placement reads from its neighbours |
| [Same seed, same bytes, everywhere](docs/determinism.md) | the integer toolkit (`/toolkit`) behind byte-identical output |
| [Files in and out](docs/files.md) | `/io`: heightmaps, weight maps, biome masks, layer dumps, `saveWorld` and `loadWorld` |
| [Procedural relief, hydrology and erosion](docs/relief-and-hydrology.md) | `createRelief` (coasts, islands, ria bays, river valleys, northern Rockies mountain valleys cut by stream power), `/hydrology` (flow, wetness, lakes, channels, on the CPU or a GPU world's device) and `/erosion` (integer thermal and hydraulic erosion) |
| [Seasons](docs/seasons.md) | `/seasons`: green-up, autumn, snow and wet ground for any day of the year |
| [Disturbance and ecosystem growth](docs/disturbance.md) | `/disturbance`: fire history, flood return periods and succession stages, and `BiomeView`'s `disturbance` option that shows them as burnt and flooded plants; `/ecosystem`: plants that grow, compete for light, seed and age over years |
| [Roads and paths](docs/roads-and-paths.md) | `/splines`: polylines and smooth curves that keep objects off, paint a road surface and flatten or cut the ground; `/settlements`: villages, roads that follow the terrain, lanes or a street grid with a main street to the quay, house lots, pads and driveways |
| [Fuel, the northern Rockies conifers and southern California chaparral](docs/fuel.md) | `/fuel`: `fuelMap(world)`, a fuel model name for every corner (species and open ground name their fuel, roads clear it, slash sets it) that `FireFront` takes as its `fuel`; the `rockies` conifer presets, `rockiesWorld` and the mountain valley `rockiesValleyWorld`; the Sanriku ria bay `riaWorld` is in the relief page |

## Entries

Each is loaded only when used: the root (`BiomeWorld`, fields, classification), `/presets` (eight biomes, their worlds,
the northern Rockies conifer presets and the reference world `R16`), `/relief` (the procedural landscape; `BiomeWorld.create` loads it only for a relief
height, the default), `/digest` (canonical bytes and SHA-256, loaded by `world.digest`), `/zones` (Whittaker and
Holdridge classifiers), `/multinoise` (nearest-point classifier over axes you choose), `/koppen` (Koppen-Geiger labels), `/toolkit` (the integer helpers), `/placement` (stored
objects), `/stats` (point-pattern statistics), `/erosion` (thermal and hydraulic erosion; `BiomeWorld.create` loads it only for a relief
with `erosion`), `/valley` (northern Rockies mountain valleys cut by stream power; `BiomeWorld.create` loads it only for a relief with `mountainValley`), `/disturbance` (fire, flood and succession), `/settlements` (village sites, a road network that follows the terrain, lanes or a street grid, house lots, pads and driveways), `/fuel` (surface fuel models by place, for fire fronts), `/graph` (placement rule graphs), `/ecosystem` (forest growth over years), `/splines` (roads and paths; `BiomeWorld.create` loads it only for a carved
height), `/gpu` (the device kernels; loaded only for a world that
may compute on a device), `/io` (heightmap, weight and mask files, layer dumps), `/view`,
`/objects` (stored objects and detail drawn through scatter) and `/editor`. The lazily loaded ones come through the
package name, so an app holds one copy of each module.

## Sources

Repository checks separate correctness and speed. During the build phase,
`test:gpu:flythrough` and `test:gpu:objects-frame` run for
correctness; their `:speed` counterparts retain the original measured scenes
and budgets and report deferral. CPU timing tests follow the same phase. From
the repository root, inspect the named release suite without running measurements:

```sh
npm run test:speed -- --list
```

After the build phase ends, run the full suite with `MARGO_SPEED_PHASE=active`
on a quiet machine. The retained scenes and budgets stay unchanged until then.

Written clean room from public papers: Volder 1959 (CORDIC), Jarzynski and Olano 2020 (PCG hashes for GPUs), Perlin
2002 (quintic fade), Wendland 1995 (compactly supported kernels). Details in `docs/clean-room.md`.
## Sliders for erosion: `@margoengine/biomes/settings`

The entry also exports the ground-material look families of `@margoengine/biomes/view` (`BIOME_LOOKS`, `MATERIALS`,
`biomeMaterials`), so a page or `@margoengine/scenes/look-family` picks one without loading the view.

`erode` is a one-shot over a height grid, so its options are a table of rows that all rebuild: `EROSION_SETTINGS` lists `erosion.iterations`, `erosion.talus`, `erosion.thermal`, `erosion.capacity`, `erosion.incision`, `erosion.deposition`, `erosion.sea` (metres, null is no sea) and `relief.step` (a relief's grid spacing in metres) with `name`, `group`, `kind`, `default`, `min`, `max`, `step`, `unit`, `about` and `live` (false for every row: a change runs erosion again over the first heights). `erodeWithSettings(grid, values)` runs `erode` with a set of values (a name left out takes its default), `erodeReliefWithSettings(relief, values)` runs `erodeRelief`, and `erosionOptions(values)` gives the checked options. `DISTURBANCE_SETTINGS` is the same kind of table for the burnt and flooded plants of `BiomeView`'s `disturbance` option (eight rows, all `live: false`; see [disturbance](docs/disturbance.md#burnt-and-flooded-plants-in-the-view)). `EROSION_LOOKS` names five looks made only of row values: `youngHills`, `oldWornHills`, `badlands`, `riverValley` and `desertWadi`. The defaults give the bytes of a plain `erode`. An unknown name throws `TypeError`, a value outside its range (or iterations that are not a whole number) `RangeError`. The model has no rainfall or evaporation rows: every cell sheds the same water and the drainage carries it out, so `capacity`, `incision` and `deposition` are its dials.

```ts
import {erode} from '@margoengine/biomes/erosion';
import {EROSION_LOOKS, erodeWithSettings} from '@margoengine/biomes/settings';

const nx = 65, nz = 65, step = 16000;
const height = new Int32Array(nx * nz).map((_, i) => 20000 + 1800 * Math.floor(i / nx) + ((i * 2654435761) >>> 24) * 40);
const grid = {height, nx, nz, step};
const young = erodeWithSettings(grid, EROSION_LOOKS.youngHills);
const worn = erodeWithSettings(grid, {...EROSION_LOOKS.oldWornHills, 'erosion.iterations': 128});
const plain = erode(grid);
console.log(young.outflow, worn.outflow, plain.outflow);
```

## Anchored terrain and horizon

`BiomeView` anchors both terrain and horizon rings at the starting camera's world XZ. The surface keeps its
triangulation as the camera pulls back, while plant and material streaming still follow the camera. Give
`clipmap.anchor` an explicit `[x, z]` when the shot needs another centre. Use `clipmap.anchor: 'camera'` when
the camera must travel beyond the fixed outer ring and `clipmap.levels` limits its size.

## Alpine treelines

The optional `@margoengine/biomes/treeline` entry builds a placement graph with mature, young and wind-stunted
cohorts. Trees thin on exposed ground and extend higher in some sheltered hollows. The seeded patches stay in
world coordinates across tile boundaries. Set the elevation for the local mountain and give each cohort a biome and
species range wide enough to include the transition. Supply the graph as `BiomeView`'s `graph` or directly to
`BiomePlacement`.

```ts
import { alpineTreelineGraph } from '@margoengine/biomes/treeline';

const graph = alpineTreelineGraph({
  elevation: 3450,
  mature: ['fir'],
  young: ['young-fir'],
  stunted: ['krummholz'],
});
console.log(graph.outputs.krummholz); // stunted
```

The vertical transition defaults to 140 m, the shelter patch size to 160 m, and the seed to 0. The graph uses terrain
curvature and exposure as artistic proxies for shelter. The pattern draws on George P. Malanson and colleagues,
[Alpine Treeline of Western North America](https://www.fs.usda.gov/pnw/pubs/journals/pnw_2007_malanson001.pdf) (2007),
and the National Park Service's observations of krummholz at [Rocky Mountain National Park](https://www.nps.gov/romo/learn/nature/subalpine_ecosystem2.htm).

Distant trees use the same placement graph, sampled over the regional canopy cover. Set a custom tree's `canopyKind`
to `conifer`, `broadleaf`, or `palm` to select its distant silhouette. `BiomeView` gives the distant forest its drawn
terrain heights, so its roots follow the coarse triangles visible on screen. The distant materials use the average
colour of the lit foliage and shaded crown. The terrain height image uses the format and precision supported by the
device. Placement on drawn terrain triangles follows Dimitris Papavasiliou,
[Real-Time Grass (and Other Procedural Objects) on Terrain](https://jcgt.org/published/0004/01/02/) (2015).

## Look families for the ground: `@margoengine/biomes/view`

`BIOME_LOOKS` holds the ground-material look families: `natural` keeps every material, `animatedFeature` draws the ground as broad
soft colour fields. The roadmap gives no biome values, so they come from its aims for the animated look (larger colour masses, lower
fine-detail contrast, more macro variation, saturation up 10 to 15 percent): saturation 1.12 about each colour's Rec. 709 luma, the
generated fine detail at 0.6 and its relief at 0.8 of each material's, and the large-scale light and dark at 1.4 times (each kept in 0 to
1). `biomeMaterials(look)` returns the whole `MATERIALS` table with the family applied, for `BiomeView.attach(engine, world, {materials})`;
pass your own table as the second argument, or your own multipliers as the first.

```js
import { biomeMaterials } from '@margoengine/biomes/view';

const materials = biomeMaterials('animatedFeature');
console.log(materials.grass.detail < 0.4, materials.rock.macro > 0.5); // true true
```

## Wet ground and plants after a flood: `BiomeView`'s `wetness`

`BiomeView.attach(engine, world, { wetness: { record, velocity, origin, size } })` draws the biome wet where a flood has
been, from its wetting record (`Flood.wetTexture` of `@margoengine/water/flood`: red the deepest depth, green the seconds
since the cell was last wet, blue 1 once it has been wet). The ground takes `WetGround` of
`@margoengine/terrain/wet-ground` (darker and glossier, `view.wetGround`, its `setLook` live) and the plants a
`PlantStates` map of `@margoengine/scatter/states` over the record (`view.plantStates`, a cell every 2 m, at most 1,024 a
side): below the high-water mark they are mud coated with a stain line above it, and with `velocity`
(`Flood.velocityTexture`) they lie flattened downstream where the current was strong. Ground and plants dry over the same
`dryTime` (default 10,800 s); `darkening` and `gloss` are WetGround's. With `disturbance` too, the history's map over the
world takes the flood. Both entries load with import() only when `wetness` is given.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';
import { TerrainHeightmap } from '@margoengine/terrain';
import { Water } from '@margoengine/water';
import { Flood } from '@margoengine/water/flood';

const engine = await Engine.create(document.querySelector('canvas')!);
const world = await BiomeWorld.create();
// The flood runs over a 512 m square of the world's ground, the sea coming in from its east side.
const origin: [number, number] = [-256, -256],
  size: [number, number] = [512, 512];
const heightmap = TerrainHeightmap.attach(engine, (x, z) => world.heightAt(x, z), { size, origin, resolution: 256 });
const water = Water.attach(engine, { height: 0, terrain: { heightmap: () => heightmap.texture, origin, size } });
const flood = Flood.attach(engine, { surface: water, boundary: { east: 'sea' } });
flood.tsunami({ height: 5, period: 300 });
const view = await BiomeView.attach(engine, world, {
  water: false,
  wetness: { record: () => flood.wetTexture, velocity: () => flood.velocityTexture, origin, size, dryTime: 3600 },
});
await view.ready;
console.log(view.wetGround !== undefined, view.plantStates !== undefined); // true true
engine.start();
```

Measured on WebGPU and the WebGL2 layer (`tests/wetness-check.mjs`): with the west half of the default world 2 m under
water just now, the west half draws at 0.62 of its dry luma with the ground wet and the plants clean, and 2.6% darker
again with the plants mud coated; the never-wet east half is within 0.3% of the view without a record.

## Larger erosion grids in Rust/Wasm

The optional `@margoengine/biomes/erosion-wasm` entry supports up to 4,194,304
cells (2048 x 2048). It preserves the ordered integer thermal, hydraulic, lake
and drainage passes of `biomes/erosion`, with a zero-byte output difference.
It runs on the CPU without a graphics device, including WebGL2 applications.
The existing synchronous JS entry keeps its 2,097,152-cell cap. This is a Wasm
route, not a WebGPU erosion compute pass.

```js
import { createErosionKernel } from '@margoengine/biomes/erosion-wasm';

using kernel = await createErosionKernel();
const height = Int32Array.from({ length: 64 * 64 }, (_, i) => (i % 64) * 1000);
const result = kernel.erode({ height, nx: 64, nz: 64, step: 16000 });
console.log(result.height[0], result.outflow, result.memoryBytes);
```

`createErosionKernel({signal})` loads only `erosion.wasm`, beside the installed
entry. Serve that asset and allow Wasm SIMD in the browser's CSP. The loader
rejects with a coded error and help link if it cannot load. `erode` accepts all
the existing erosion options and defaults (32 rounds), plus `signal`, checked
before synchronous work. Run in your own worker to interrupt a call in flight.
Dispose the kernel to release its memory; every returned array is a fresh owned
copy and stays valid after another call or disposal. Input heights are unchanged.

The full real-DEM correctness command is
`node packages/biomes/tests/erosion-dem.mjs`, after the package build, under a
20-minute process limit. It recreates 64 pinned Mapzen Terrarium tiles from
USGS data without resampling and checks the default 32-round output against
the independent ordered JS reference hashes. Fixture URLs, attribution, hashes
and the small real-data unit-test crop are in `tests/fixtures/erosion-dem*.json`.
Kernel array reuse removes 10 bytes per cell, but Wasm input and output copies
cost 21 extra bytes per cell. `memoryBytes` reports actual linear-memory high
water; it excludes the caller's 4-byte-per-cell input and 17-byte-per-cell output.
`vectorBlocks` counts four-cell SIMD difference blocks. These are work and memory
figures; elapsed speed proof is deferred to the quiet speed phase. Build the
committed module with `npm run build:erosion --workspace @margoengine/biomes`.

Production-browser proof (from the repository root): build the package, then run
`node --test --test-timeout=120000 packages/biomes/tests/erosion-bundle.test.js`
to prepare and validate a real Vite consumer. Run
`node packages/biomes/tests/erosion-browser.mjs` afterward.
The same preparation runs with the package CPU tests. The browser proof checks
lazy asset loading, exact served Wasm bytes and every real-crop field on WebGPU
and WebGL2 pages; it makes no GPU erosion or elapsed-speed claim.
