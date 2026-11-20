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

### A ria coast

`ria` cuts a drowned river valley into a straight coast, the shape of a Sanriku fishing bay: a bay that runs inland from the
coast edge along a slightly swaying axis, narrowing from `width` (half width, default 500 m) at the mouth to `headWidth`
(140 m) at its head over `length` (2,800 m), shallowing from `depth` (25 m) to the waterline, with steep hills on both sides
(the ground rises `slope` metres per metre from the water, default 0.55, up to relief over `run` metres) and `flat` metres
(420) of level ground at `flatHeight` (4.5 m) just inland of the head, the only room for a town. `headDepth` (default 0)
keeps water at the head: the floor falls from it to `depth`, so a harbour there has water to moor in. A river runs 4 km inland from
the head (`river: false` for none; `valley` shapes it). The rest of the coast is steep from the waterline, with no beach and
no shelf. Without the option every height is what it was. The bay is ground only: a sea wall, a quay and breakwater mounds
are paths carved with `carve: { mode: 'level', top }` (`/splines`), and the walls a flood holds are the flood's own.

`riaWorld` (`@margoengine/biomes/presets`) is a ready Sanriku bay on a 4,096 m world: the sea east, a bay 2.4 km long and
900 m across at the mouth, 30 m deep there and 8 m at the head, hills of up to about 440 m, level ground 3.5 m up within 450 m of the head
(the town's room, round x = -600, z = 0 on a world centred on the origin), latitude 38.7, 1,300 mm of rain and `temperate`
forest. `tests/ria-world.test.js` holds those numbers.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { riaWorld } from '@margoengine/biomes/presets';

const bay = await BiomeWorld.create({ size: [4096, 4096], origin: [-2048, -2048], climate: riaWorld.climate, height: { relief: riaWorld.relief }, biomes: riaWorld.biomes });
console.log(bay.heightAt(-600, 0)); // about 3.5: the level ground at the head of the bay
```

```ts
import { createRelief } from '@margoengine/biomes/relief';

const relief = createRelief({ coast: 'east', base: 14, relief: 220, ria: {}, valley: { width: 40, mouth: 40 } });
console.log(relief.height(2_040_000, 0)); // -40000: the open sea is 40 m deep; the bay runs west from there
```

### Mountain valleys

`mountainValley` makes the country of the northern Rockies round Wallace, Idaho (the Coeur d'Alene and St. Joe
mountains of the 1910 fires) in place of the open landscape: a main valley whose level floor falls to an outlet on one
edge of the world, a creek and a rail grade on that floor, and steep walls cut into side gulches and ridges by
stream-power drainage. `base` is the floor's height where it leaves the world and `relief` caps the ridges above it
(softly: heights in the top quarter are squeezed toward the cap). It needs `coast: 'none'` and no `ria`, `islands`,
`erosion` or `rivers`; the creek is the relief's one river, so a world takes it as water. Its code is the
`@margoengine/biomes/valley` entry, loaded only by a relief that uses it: `BiomeWorld.create` loads it for such a relief;
calling `createRelief` yourself, import it first.

| Option | Default | What it sets |
|---|---|---|
| `outlet` | `'west'` | Edge the valley drains out of (`west`, `east`, `north`, `south`) |
| `center` | 0.5 | Where it leaves that edge, 0.1 to 0.9 of the way along |
| `floor` | 110 | Half width of the level floor in metres, measured along the outlet edge (it varies from 0.75 to 1.25 of this along the valley), 5 to 1,000 |
| `fall` | 0.012 | Fall of the floor per metre toward the outlet (about the South Fork through Wallace), 0.0005 to 0.1 |
| `wall` | 33 | Critical hillslope angle in degrees, varied by up to 4 degrees over the world; no wall is steeper, 15 to 50 |
| `steepness` | 120 | Channel steepness `ks` in metres: a gulch draining A m2 falls `ks / sqrt(A)` per metre, 1 to 2,000 |
| `ridges` | `'rounded'` | Crests rounded by creep, or `'sharp'` |
| `gulches` | 520 | Spacing of the side gulches in metres (the wavelength of the surface they form on), 100 to 4,000 |
| `creek` | `{ width: 8, depth: 1.5 }` | The creek's width and the depth of its level bed under the floor, banks of 1 in 2 |
| `rail` | `{ grade: 0.017, width: 6 }` | A level rail bed at half the floor's width on the side away from the creek, or `false`; `fall` must not pass `grade` |
| `step` | 16 | Spacing of the drainage grid in metres, doubled until the world is at most 512 cells across |

How it is cut. A grid over the world drains to the floor, a fixed base level, and to nothing else: the rest of the
border is closed, so every drop leaves through the outlet. The network forms on a seeded starting surface (a ramp up from
the floor over a distance warped by noise at the gulch spacing); Priority-Flood with a 1 mm rise fills its depressions
and each cell drains by the rho8 rule, so flow does not lock onto the grid's eight directions. On that network,
detachment-limited stream power E = K A^m S^n with n = 1 and m / n = 0.5, in its steady state E = U, sets each channel
cell `ks / sqrt(A)` per metre above the cell it drains to, solved base level first in one pass (the stack order and the
long-step limit of Braun and Willett's implicit scheme). Where that would be steeper than the critical slope the water no
longer cuts a channel; those cells are hillslope, raised from the channels by a lowest-first pass to the critical angle
over 16 neighbours (threshold hillslopes). Rounded ridges lower each convex cell to the mean of its 3 x 3 block a few
times and leave the hollows and channels alone. The steepness and the critical angle vary over the world (rock varies),
so neither the channels nor the walls are one plane. Every cell then stands at least 1 mm over the cell it drains to, and
beside each diagonal step the cells are lowered until a bilinear sample does not dam it, so the ground has no closed
basin. Between grid corners the height is bilinear, with rock and soil detail of up to 1.5 m on the walls (none on the
floor or in the channels). The floor is exact: level across, rising by `fall` per metre in from the outlet; the creek's
bed is `depth` under it; the rail bed lies on the floor, so its grade is at most `fall`.

What it gives (proved by `packages/biomes/tests/mountain-valley.test.js` on several seeds and all four outlets): the
floor, the creek bed and the rail fall all the way to the outlet; every cell of the drainage grid drains down to the
floor and the ground has no depression of 1 m or more; the median wall slope is 25 to 40 degrees (about 30 by default:
slopes of 50 to 65 percent, 27 to 33 degrees, are common on the Coeur d'Alene National Forest), and rounded ridges leave
more of the wall gentle than sharp ones; at least three gulches of a quarter square kilometre reach the floor from each
wall; the rail grade is at most 1.7 percent (the Milwaukee Road's grade over St. Paul Pass from Haugan to Avery, built
1906 to 1908 through the country the 1910 fires burned), level across its bed and at least 10 m clear of the creek's
banks; the same settings give the same bytes. `relief.mountainValley` holds the centre line, the creek and rail lines
(mm, outlet first), `frame(x, z)` (distance in from the outlet edge and offset from the centre line), `floorHeight`,
`floorWidth` and the drainage grid (heights, flow and directions). Building the default 4 km world's valley takes about
0.2 s on one core.

```ts
import { createRelief } from '@margoengine/biomes/relief';
import '@margoengine/biomes/valley';

const relief = createRelief({ base: 870, relief: 1000, mountainValley: {} });
const { rail, creek } = relief.mountainValley!;
console.log(relief.height(rail![0], rail![1]) / 1000); // 870: the floor where the valley leaves the west edge
console.log(creek.length / 2); // 257 points, one per 16 m up the valley
```

`rockiesValleyWorld` in `@margoengine/biomes/presets` is this valley with the climate and conifer presets of
`rockiesWorld` (`BiomeWorld.create({ climate, height: { relief }, biomes })`).

Sources (papers and reports read for their descriptions; no code read): A. D. Howard, "A detachment-limited model of
drainage basin evolution", Water Resources Research 30(7), 1994, https://doi.org/10.1029/94WR00757; K. X. Whipple and
G. E. Tucker, "Dynamics of the stream-power river incision model", Journal of Geophysical Research 104(B8), 1999,
https://doi.org/10.1029/1999JB900120; J. Braun and S. D. Willett, "A very efficient O(n), implicit and parallel method to
solve the stream power equation governing fluvial incision and landscape evolution", Geomorphology 180-181, 2013,
https://doi.org/10.1016/j.geomorph.2012.10.008; G. Cordonnier, J. Braun, M.-P. Cani, B. Benes, E. Galin, A. Peytavie and
E. Guerin, "Large Scale Terrain Generation from Tectonic Uplift and Fluvial Erosion", Computer Graphics Forum 35(2), 2016,
https://doi.org/10.1111/cgf.12820; J.-D. Genevaux, E. Galin, E. Guerin, A. Peytavie and B. Benes, "Terrain generation using
procedural models based on hydrology", ACM Transactions on Graphics 32(4), 2013, https://doi.org/10.1145/2461912.2461996;
E. Kirby and K. X. Whipple, "Expression of active tectonics in erosional landscapes", Journal of Structural Geology 44,
2012, https://doi.org/10.1016/j.jsg.2012.07.009 (the steepness index); D. W. Burbank et al., "Bedrock incision, rock uplift
and threshold hillslopes in the northwestern Himalayas", Nature 379, 1996, https://doi.org/10.1038/379505a0, and
D. R. Montgomery and M. T. Brandon, "Topographic controls on erosion rates in tectonically active mountain ranges", Earth
and Planetary Science Letters 201, 2002, https://doi.org/10.1016/S0012-821X(02)00725-2 (threshold hillslopes);
G. K. Gilbert, "The convexity of hilltops", Journal of Geology 17(4), 1909, https://doi.org/10.1086/621620, and
J. J. Roering, J. W. Kirchner and W. E. Dietrich, "Evidence for nonlinear, diffusive sediment transport on hillslopes and
implications for landscape morphology", Water Resources Research 35(3), 1999, https://doi.org/10.1029/1998WR900090 (rounded
crests); R. Barnes, C. Lehman and D. Mulla, "Priority-flood: An optimal depression-filling and watershed-labeling algorithm
for digital elevation models", Computers and Geosciences 62, 2014, https://doi.org/10.1016/j.cageo.2013.04.024 (with its
epsilon variant); J. Fairfield and P. Leymarie, "Drainage networks from grid digital elevation models", Water Resources
Research 27(5), 1991, https://doi.org/10.1029/90WR02658 (rho8); G. H. Deitschman, "Mapping of habitat types throughout a
national forest", USDA Forest Service General Technical Report INT-11, 1973, page 1 (the Coeur d'Alene's slopes),
https://archive.org/details/CAT74419254; D. Welsh, "Northern Transcontinental Railroad Mountain Passes", Trains (Kalmbach),
as cited for the St. Paul Pass grade of 1.7 percent, https://en.wikipedia.org/wiki/St._Paul_Pass_Tunnel; Wallace's
elevation of 870 m, https://en.wikipedia.org/wiki/Wallace,_Idaho. Chosen here, not from the papers: every default but the
wall angle, the rail grade and the floor's height, the 0.35 starting ramp, the noise wavelengths, the creek and rail
placement on the floor, the soft cap and the 1.5 m wall detail.

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
