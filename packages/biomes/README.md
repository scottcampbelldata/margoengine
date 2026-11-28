# @margoengine/biomes

## Runoff into rivers

Flowing rivers can consume the current catchment discharge. Give `BiomeView.attach` the option
`water: { rivers: 'hydrology', flow: { runoff } }` after adding a `RainfallRunoff` solver to the world,
or use `riverSources` to query that source independently. With `flow: true`, the view estimates annual
mean flow from contributing area and the local precipitation and moisture index.

```ts
import { riverSources } from '@margoengine/biomes/rivers';
import { RainfallRunoff } from '@margoengine/physics/runoff';
import { PhysicsWorld } from '@margoengine/physics/world';

const runoff = await RainfallRunoff.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(runoff, { nx: 2, nz: 1, dx: 10, downstream: [1, -1], rainRate: 0.0001 });
world.advance(120);
const line = Int32Array.of(5000, 5000, 15000, 5000);
const inflows = riverSources([line], x => 20 - x, (x, z) => runoff.dischargeAt(x, z), 5);
console.log(inflows);
```

For disturbance history, `flood.water.sample(period, x, z)` can read depth and velocity from the
hydraulically resolved run for that return period. Use the grid origin and metre coordinates of the flood bed.

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
| [Farmland](docs/farmland.md) | `/farmland`: an English lowland farm quilt of hedged fields (pasture, plough, stubble, meadow), hedge trees, lanes that end at a junction, the edge or a gate, a gate into every field, and its world, biomes and ground looks |
| [Roads and paths](docs/roads-and-paths.md) | `/splines`: polylines and smooth curves that keep objects off, paint a road surface and flatten or cut the ground; `/settlements`: villages, roads that follow the terrain, lanes or a street grid with a main street to the quay, house lots, pads and driveways |
| [Fuel, the northern Rockies conifers and southern California chaparral](docs/fuel.md) | `/fuel`: `fuelMap(world)`, a fuel model name for every corner (species and open ground name their fuel, roads clear it, slash sets it) that `FireFront` takes as its `fuel`; the `rockies` conifer presets, `rockiesWorld` and the mountain valley `rockiesValleyWorld`; the Sanriku ria bay `riaWorld` is in the relief page |

## Entries

Each is loaded only when used: the root (`BiomeWorld`, fields, classification), `/presets` (eight biomes, their worlds,
the northern Rockies conifer presets and the reference world `R16`), `/relief` (the procedural landscape; `BiomeWorld.create` loads it only for a relief
height, the default), `/digest` (canonical bytes and SHA-256, loaded by `world.digest`), `/zones` (Whittaker and
Holdridge classifiers), `/multinoise` (nearest-point classifier over axes you choose), `/koppen` (Koppen-Geiger labels), `/toolkit` (the integer helpers), `/placement` (stored
objects), `/stats` (point-pattern statistics), `/erosion` (thermal and hydraulic erosion; `BiomeWorld.create` loads it only for a relief
with `erosion`), `/valley` (northern Rockies mountain valleys cut by stream power; `BiomeWorld.create` loads it only for a relief with `mountainValley`), `/disturbance` (fire, flood and succession), `/farmland` (hedged fields, hedge trees, lanes and gates of English lowland farmland), `/settlements` (village sites, a road network that follows the terrain, lanes or a street grid, house lots, pads and driveways), `/fuel` (surface fuel models by place, for fire fronts), `/graph` (placement rule graphs), `/ecosystem` (forest growth over years), `/splines` (roads and paths; `BiomeWorld.create` loads it only for a carved
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

## Evolve a relief through physical time

`@margoengine/biomes/landscape` samples an existing relief into the physics TerrainBed. It returns the world
timeline, the landscape solver and a snapshot function. The snapshot is an ordinary `Relief` in millimetres that
can supply the height function of a biome map or terrain build. Outside the simulated rectangle it samples the
original relief.

```js
import { evolveRelief } from '@margoengine/biomes/landscape';
import { createRelief } from '@margoengine/biomes/relief';

const relief = createRelief({ seed: 7, size: [512, 512] });
const mountain = await evolveRelief(relief, {
  step: 32,
  secondsPerSecond: 31_557_600 * 300,
  uplift: 0.0004 / 31_557_600,
  outlets: { maxX: true },
});
mountain.world.advance(60);
const evolved = mountain.snapshotRelief();
console.log(evolved.height(256_000, 256_000), mountain.landscape.budget.exported);
```

`step` defaults to 128 m and `frameRate` to 60/1. All other physical defaults come from
[`LandscapeEvolution`](../physics/README.md#landscape-evolution). The optional `forcing` options supply
registry fields and an abort signal. Take a fresh snapshot when preparing a new geological time slice.
Set `forcing: { threads: 4 }` to opt into native workers and shared world memory in Node or a
cross-origin-isolated browser worker. The default uses one thread. When the relief world is no
longer needed, remove the solver and call `mountain.landscape[Symbol.dispose]()`.
Snapshots use the existing bed triangles and preserve the relief's authored river lines and settings.

## Anchored terrain and horizon

`BiomeView` anchors both terrain and horizon rings at the starting camera's world XZ. The surface keeps its
triangulation as the camera pulls back, while plant and material streaming still follow the camera. Give
`clipmap.anchor` an explicit `[x, z]` when the shot needs another centre. Use `clipmap.anchor: 'camera'` when
the camera must travel beyond the fixed outer ring and `clipmap.levels` limits its size.

Past the world's edge, `horizon` draws far ground out to the horizon (`horizonHeights`). Each far corner continues the
mean of a stretch of the world's edge round its nearest edge texel, an eighth of its distance wide each way
(`HORIZON_SPREAD`): a valley leaving the world keeps going near the edge, and further out the edge's heights and
materials blur together instead of running outward as streaks. Over the same ramp in which the heights give way to
mountains (`far.blend`), the far ground's materials give way to what the world's own ground wears at the far corner's
height (`horizonAltitudeMeans`, the world's mean weights in 64 height bands; a far peak above the world's top takes its
top band), so far summits are rock where the world's summits are rock and far valleys keep the valley floor's ground.
The mountains are massifs carrying eroded ridges (a hybrid multifractal of gradient noise whose fine octaves are damped
by the slope under them), on texels of up to 32 m and a 64th of the world. `horizonEdgeMean` takes the edge's
mean of any per-texel values, such as a material map of your own:

```ts
import { horizonEdgeMean, horizonHeights } from '@margoengine/biomes/view';

const width = 65, depth = 65;
const heights = new Float32Array(width * depth).fill(100);
const far = horizonHeights({ bounds: [0, 0, 512, 512], heights, width, depth, seed: 1 });
const tone = horizonEdgeMean({ width, depth }, far, new Float32Array(width * depth).fill(0.5), 1);
console.log(far.width * far.depth === tone.length); // true
```

```ts
import { horizonAltitudeMeans } from '@margoengine/biomes/view';

const heights = Float32Array.from({ length: 100 }, (_, i) => 3000 + 10 * i);
const rockAbove3500 = Float32Array.from(heights, (h) => (h > 3500 ? 1 : 0));
const out = new Float32Array(1);
horizonAltitudeMeans(heights, rockAbove3500, 1).at(4200, out);
console.log(out[0]); // 1: a far peak higher than the world takes the world's summit ground
```

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

## Older or younger rockies forests: `coniferAge`

The northern Rockies presets grow pole stands, about 40 years old, the regrowth after the 1910 fires.
`coniferAge(biomes, age)` from `@margoengine/biomes/presets` returns the same biomes with every aged conifer key
(`procedural:<species>/<age>`) drawn at `'sapling'` (15 years), `'pole'` (40), `'mature'` (100) or `'old'` (250), the
ages of `coniferForm` in `@margoengine/procedural/conifers`. Placement is unchanged, so older trees close their crowns
into a full canopy. Snag, burnt and unaged keys are kept, and an unknown age throws a `RangeError`.

```js
import { coniferAge, rockiesValleyWorld } from '@margoengine/biomes/presets';

const { climate, relief } = rockiesValleyWorld;
const biomes = coniferAge(rockiesValleyWorld.biomes, 'mature'); // a valley that has not burned for a century
console.log(biomes[0].plants?.[0].mesh, climate.latitude, relief.base); // procedural:western-white-pine/mature 47.3 870
```

The ages and their sizes follow the Forest Vegetation Simulator's Inland Empire variant (Wykoff height-diameter and
Crookston crown width equations), as `@margoengine/procedural/conifers` documents.

## Meadow grass and stones

A detail drawing `procedural:grass` (every preset's grass) takes measured leaf green, linear (0.1617, 0.2024,
0.0917): ripgut brome and wild oat leaves, ECOSTRESS Spectral Library 1.0 samples VH350 and VH352 (Meerdink, Hook,
Roberts and Abbott, Remote Sensing of Environment 230, 2019, https://doi.org/10.1016/j.rse.2019.05.015), integrated
under a 6504 K black body. For bunchgrass up close, draw a `GrassScatter` from `@margoengine/scatter/grass` over the
view's heightmap (tussocks with cured blades).

`procedural:rock` draws `generateRockMesh` at 2,880, 720 and 180 triangles in the near, middle and far rings, in
measured granite, linear (0.2709, 0.224, 0.1869) (ECOSTRESS samples Granite_H2, H3 and H5, the `granite` of
`@margoengine/materials`). Each rock species draws eight seeded stones (seeds 1 to 8: blocks, slabs, wedges, shards
and pebbles of their own proportions), every placed stone the one its record's variant picks, so a talus field holds
no turned copies of one stone; the density is the species' own.

```js
import { defineBiome } from '@margoengine/biomes';
const meadow = defineBiome({
  id: 'upper-meadow',
  climate: { height: [2900, 3500], slope: [null, 32] },
  ground: [{ material: 'grass' }],
  rocks: [{ id: 'talus', mesh: 'procedural:rock', density: 80, radius: 0.3 }],
  details: [{ id: 'bunchgrass', mesh: 'procedural:grass', density: 18, blades: true }],
});
console.log(meadow.details?.[0].mesh, meadow.rocks?.[0].mesh);
```

## Objects meet the ground, and the relief shades itself

On by default in `BiomeView`:

- A species' `sink` (metres at scale 1, more on slopes) and `alignToGround` (0-1) bed its objects into the hill.
- `contact` (default true): stones darken at the foot and, on grass, meadow, moss, needle, leaf, tundra and mud
  grounds, turn mossy there; tree and shrub bark takes soil at the foot; canopy and understory trees keep
  `exp(-0.5 x stand cover)` of the sky's light at the ground line (cover 0.5 without a `stands` rule) and all of it
  from half their height up, and their foliage keeps `exp(-1.2)` of it at the crown's axis and all of it at the outer
  tips. A tree's soil apron spreads with its crown. The terrain draws soil and contact shade around every stored trunk and stone (`view.groundContact`, a
  `TerrainGroundContact` of `@margoengine/terrain/ground-contact`). Your own meshes get an apron only when you add
  their footprints: `view.groundContact?.set('hut', [x, z, radius, 1])`.
- `groundCover` (default on with `contact`, or `{ thin, shorten, reach }`, or false): grass and ferns thin out and
  stand shorter in those soil rings, so the rings show. Live: `view.objects?.groundCover?.set({ thin: 2 })`. Grass you
  scatter yourself joins with `thinning: clearingMap(() => view.groundContact?.mask())`
  (`@margoengine/scatter/clearing-map`).
- A species' `color: { hue, value }` sets the jitter of its leaf and stone parts.
- `relief` (default true, or `TerrainReliefLighting` settings): ridges cast on the ground behind them and gullies keep
  less sky at every distance (`view.relief`), rebaked when the engine's sun turns or the world's heights change.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';
const fell = defineBiome({
  id: 'fell',
  climate: {},
  ground: [{ material: 'grass' }],
  rocks: [{ id: 'talus', mesh: 'procedural:rock', density: 80, radius: 0.4, sink: 0.12, alignToGround: 0.65 }],
});
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create({ size: [512, 512], biomes: [fell] });
const view = await BiomeView.attach(engine, world, { contact: true, relief: { softness: 1 } });
view.groundContact?.set('cairn', [12, -4, 0.7, 1]);
engine.start();
```

## Look families for the ground: `@margoengine/biomes/view`

`BIOME_LOOKS` holds the ground-material look families: `natural` keeps every material, `animatedFeature` draws the ground as broad
soft colour fields. The roadmap gives no biome values, so they come from its aims for the animated look (larger colour masses, lower
fine-detail contrast, more macro variation, saturation up 10 to 15 percent): saturation 1.12 about each colour's Rec. 709 luma, the
generated fine detail at 0.6 and its relief at 0.8 of each material's, and the large-scale light and dark at 1.4 times (each kept in 0 to
1). `biomeMaterials(look)` returns the whole `MATERIALS` table with the family applied, for `BiomeView.attach(engine, world, {materials})`;
pass your own table as the second argument, or your own multipliers as the first.

The snow material's relief (`bump` 0.09) stands 8 to 9 mm root mean square at its 4 m repeat, inside the 0.5 to 9.2 mm
measured on snow surfaces with a laser profiler at wavelengths of 4 to 50 cm (P. Lacroix, B. Legrésy, K. Langley,
S. E. Hamran, J. Kohler, S. Roques, F. Rémy and M. Dechambre, "In situ measurements of snow surface roughness using a
laser profiler", Journal of Glaciology 54(187), 753-762, 2008, https://doi.org/10.3189/002214308786570863). A larger
`bump` in your own table draws rougher snow.

```js
import { biomeMaterials } from '@margoengine/biomes/view';

const materials = biomeMaterials('animatedFeature');
console.log(materials.grass.detail < 0.4, materials.rock.macro > 0.5); // true true
```

A material can draw a photographed ground texture (a CC0 scan such as Poly Haven's `leafy_grass`, decoded to RGBA8)
in place of the generated detail: `image` (square, a power of two from 64 to 4,096 texels) and `repeat` (metres one
repeat covers, default 4). Its pattern is kept and its mean brought to `color`, so one scan gives a summer or a winter
field; the view's layers are drawn at 1,024 texels a side when any material has an image. `materialPixels(key, look, size)`
gives the texture and its mips.

```js
import { materialPixels } from '@margoengine/biomes/view';

const side = 64,
  data = new Uint8Array(side * side * 4).fill(128); // decode a real scan here (createImageBitmap, getImageData)
const levels = materialPixels('winter-pasture', { color: [0.31, 0.37, 0.2], image: { width: side, height: side, data }, repeat: 3 }, 1024);
console.log(levels.length, levels[0][1]); // 11 94
```

`patches` draws ground materials that share a texel as patches with crisp edges rather than their average (the
terrain's `patches`; see `@margoengine/terrain`): with a ground of rock, gravel and turf by slope, a mountainside reads
as outcrops, scree and turf islands from a kilometre off instead of one grey-brown felt. `size` is the patch cell in
metres (default 14), `contrast` 0 to 1 (default 0.6). Left out, the ground blends as painted.

```js
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';
import { Engine } from '@margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const world = await BiomeWorld.create({ seed: 7, size: [1024, 1024], workers: false });
const view = await BiomeView.attach(engine, world, { patches: { size: 18, contrast: 0.7 } });
await view.ready;
```

`rock` draws bare rock with structure at 10 to 100 m (the terrain's `rock`, on the world and the horizon ring): ledges,
jointed blocks and buttresses, and over the world gullies carved along the drainage with talus fans and streams below
the walls. At attach the view routes the world's region grid with multiple flow (`hydrologyOf(world, { multiple: true
})`, about 0.2 s for a 513 x 513 grid) and `drainageStructure` turns it into the terrain's structure texture: R the log
of each cell's catchment between 800 and 60,000 square metres, G the rock that walls steeper than 40 degrees shed down
their D8 paths and that settles under 34 degrees, half of it every 90 m (Statham 1976, "A scree slope rockfall model").
`debris` names the material that benches, gully floors and fans take; `drainage: false` leaves gullies and fans out, or
`drainage` sets `drainageStructure`'s `area`, `wall`, `repose` and `travel`. `patches` takes `warp` and `terraces` too.

```js
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';
import { Engine } from '@margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const world = await BiomeWorld.create({ seed: 7, size: [1024, 1024], workers: false });
const view = await BiomeView.attach(engine, world, {
  patches: { size: 18, contrast: 0.6, warp: 0.6 },
  rock: { strata: 10, facets: 18, gullies: 6 },
});
await view.ready;
```

`drainageStructure(hydrology, options)` (entry `@margoengine/biomes/hydrology`) returns those `rgba8unorm` texels for
any height grid, the same bytes for the same grid:

```js
import { BiomeWorld } from '@margoengine/biomes';
import { drainageStructure, hydrologyOf } from '@margoengine/biomes/hydrology';

const world = await BiomeWorld.create({ seed: 7, size: [1024, 1024], workers: false });
const { width, depth, texels } = drainageStructure(hydrologyOf(world, { multiple: true }), { repose: 33 });
console.log(width, depth, texels.length === width * depth * 4); // 65 65 true
```

The view's water is the sea of `SEA` where an edge of the world stands at or below sea level: two ocean swell trains,
out to the horizon. On a landlocked world, or when `water` gives a `wind`, it raises the waves of a wind instead (a
light air of 2 m/s over 100 m by default) and stops at the world's edge, so `applyWaterSettings(view.water, ...)` and a
water look apply to it.

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
20-minute process limit. Add `--download` the first time: without it nothing is
fetched, and a missing tile fails the check, which names it. It recreates 64 pinned Mapzen Terrarium tiles from
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

## A live forest on the physics clock

Use `@margoengine/biomes/forest` for competition, recruitment, canopy turnover and permanent wind-shaped growth.
The world keeps each tree's birth identity and replayable annual exposure. The older `/ecosystem` entry runs the same
crown model offline.

```ts
import { ForestEcosystemSolver, forestOrientation } from '@margoengine/biomes/forest';
import { PhysicsWorld } from '@margoengine/physics/world';

const forest = await ForestEcosystemSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(forest, {
  bounds: [0, 0, 20, 20],
  cells: [2, 2],
  species: [{ id: 'fir', radius: 3, canopyFuel: 0.8, rootCohesion: 1200 }],
  plants: [{ species: 'fir', x: 5, z: 5, radius: 1.5 }],
  wind: {
    medium: 'air',
    cell: [0, 0, 0],
    sample: () => ({ velocity: [12, 0, 0], density: 1.2, temperature: 278 }),
  },
});
world.advance(60);
const tree = forest.trees()[0];
if (tree) {
  const rotation = forestOrientation(tree);
  console.log(tree.id, tree.radius, rotation);
}
```

Pass the X/Y/Z/W rotation to `mesh.setQuaternion()` for a mesh rooted at local zero with its trunk along +Y.
Use any pure `Wind` source, including a terrain-dependent boundary-layer field. The retained growth axis
adds permanent lean, while `@margoengine/physics/vegetation` handles elastic sway.

Enable `flooding` in `ForestEcosystemSolver.load()` to consume the matching shallow-water grid. Supply
`erosionField: landscape.incisionField` to consume gross soil loss. Give `LandscapeEvolution.load()` the
forest's `rootCohesionField` for feedback. These grids must share dimensions, extent and origin cell. Enable
`exposure` and publish one `[burn severity, fuel moisture]` pair per cell when you have a weather/fire producer.
The forest publishes cell-centred crown cover, root cohesion in Pa, live canopy fuel in kg/m², and moisture in
kg/kg dry fuel. Fuel and root strength require site/species measurements and default to zero.

## Live plant growth and morphogenesis

`@margoengine/biomes/growth` grows woody plants as a sequence of bud productions on the physics clock. Each developmental season distributes available resources among terminal and lateral buds, changes shoot direction toward light and away from shadow, and updates branch radius from the distal stem area. Nearby plants share a shadow grid. Solid voxels block new shoots, and an optional HYDRO-02 soil port averages usable root-zone water over the season.

```ts
import { PlantGrowth } from '@margoengine/biomes/growth';
import { PhysicsWorld } from '@margoengine/physics/world';
import { tubes } from '@margoengine/procedural/lsystem';

const growth = await PlantGrowth.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(growth, {
  ticksPerSeason: 60,
  plants: [{ position: [0.25, 0.25, 0.25], species: {
    productiveSeasons: 3, seasonalExtension: 2, minimumExtension: 0.05,
    internodeLength: 0.4, tipRadius: 0.02,
  } }],
  voxels: { origin: [0, 0, 0], dimensions: [4, 4, 4], size: 1 },
});
world.advance(120);
const branchMesh = tubes(growth.toBranches());
if (!branchMesh.indices.length) throw new Error('Expected the two seasons to produce branches');
```

Use `growth.toBranches()` once shoots exist for a copy of the current Procedural graph, or `growth.internodes()` for stable parent IDs and the original f64 coordinates. The `branchesField` publishes layout-1 f64 data with header `[rowCount, season]`. Each row holds end xyz, unit growth direction xyz, radius in metres, parent and successor indices, plant index, branch order, and birth season. The first rows are the seed positions. A successor index of `-1` is dormant and `-2` is absent. The first `rowCount` rows are in use. Bind `RainfallRunoff.soilWaterField` through `PlantGrowth.load({ soil })` with the same x-fast geometry as its HYDRO-02 source and wilting and full-growth thresholds in water-equivalent metres. The option descriptions give all defaults and units.
