# @margoengine/biomes: Procedural relief and hydrology

The seeded landscape (`/relief`) and water routing over the region grid (`/hydrology`). One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

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
| `erosion` | none | thermal and hydraulic erosion on a grid over the world, see [Erosion](#erosion); needs the `/erosion` entry loaded (a world loads it) |

On a straight coast each river's mouth lies on the shelf's outer edge, under the sea, so its valley is carved across
the whole shelf and the river always reaches the sea (or the world's edge where the warped shore lies beyond it).

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

## Erosion

`@margoengine/biomes/erosion` wears a height grid down in integers: each round, material slides down slopes steeper than
the angle of repose (thermal erosion), then the water of every cell runs to an outlet over the filled surface, cutting its
bed where it can carry more than it holds and dropping the rest, and lakes fill with sediment (hydraulic erosion). A fixed
number of rounds in a fixed order, Q16 rates and integer heights: the same grid gives the same bytes on every machine and
in every worker. No sediment is lost to rounding: the heights' sum falls by exactly `outflow`, what the flow carried out
through the border and the sea.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { erode } from '@margoengine/biomes/erosion';

// A world whose relief is eroded: BiomeWorld.create loads the entry, tiles, region and workers all see the result.
const world = await BiomeWorld.create({ height: { relief: { coast: 'west', rivers: 1, erosion: { iterations: 48 } } } });

// Any grid of millimetres, here the region grid of a world: height, flow, direction, wear and deposit come back.
const e = erode(world.region, { sea: world.climate.sea });
console.log(e.wear[0], e.deposit[0], e.flow[0], e.outflow);
```

`erodeRelief(relief, options)` does the same to a relief from `createRelief` (a relief made with the `erosion` option is
already that), with its grid on the relief's corner: `relief.erosion` holds the grids, and `relief.height(x, z)` adds the
change, bilinear between grid corners, to the relief's own heights, so the detail between corners stays. A world's region
grid at the default 16 m is the erosion grid itself. For rivers drawn on the eroded ground, run
`riversOf(world, hydrologyOf(world))` from `/hydrology`: it reads the eroded region.

| Option | Default | Meaning |
| --- | --- | --- |
| `iterations` | 32 | rounds of thermal then hydraulic erosion, 0..1,024 |
| `talus` | 35 | angle of repose in degrees, 0..89 |
| `thermal` | 0.25 | share of a cell's steepest excess over the talus slope that slides per round, 0..0.5; 0 turns it off |
| `capacity` | 0.01 | sediment a flow carries per cell drained, per mm of cell side, per unit of slope, 0..1; 0 turns hydraulic erosion off |
| `incision` | 0.25 | share of the spare capacity a flow cuts from its bed per round, 0..1 |
| `deposition` | 0.5 | share of the load over capacity a flow drops per round, 0..1 |
| `sea` | none (`erode`), 0 m (relief) | mm; cells below it are outlets like the border |
| `step` | 16 m, doubled until the world is at most 512 cells across | relief only: grid spacing in metres, 1..1,024 |

| Output | Type | Meaning |
| --- | --- | --- |
| `height` | Int32Array, mm | the eroded heights |
| `flow` | Int32Array, cells | cells draining through each cell, itself included |
| `direction` | Int8Array | D8 direction (0 is +x, then clockwise) to the cell it drains to, -1 at an outlet; the filled surface never rises along it |
| `wear`, `deposit` | Int32Array, mm | how far each cell was lowered or raised; masks for ground layers, scree and river beds |
| `outflow` | number, mm of a cell | sediment carried out of the grid |

Limits: at most 2,097,152 cells, heights within +-33,554,432 mm, cells of 1 mm to 1,048,576 mm. A relief world's erosion
runs once on each thread that holds the world (the page and every worker replica), on a 4 km world about 257 x 257 cells.
