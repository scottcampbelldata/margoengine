# @margoengine/biomes: Trees, shrubs, rocks and props

Stored objects: candidates, clusters, stands, the hard core, shade, sizes, the record layout and the statistics behind the quality gates. One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

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

## Rule graphs

`@margoengine/biomes/graph` lets an artist shape where each species grows beyond its `suitability` ranges: a graph of
rule nodes, as plain JSON, whose outputs multiply species densities. Load the entry, then pass the graph to
`BiomePlacement.attach` (or `update({ graph })`). Workers load the entry themselves.

```js
import { BiomeWorld } from '@margoengine/biomes';
import { BiomePlacement } from '@margoengine/biomes/placement';
import { definePlacementGraph, evaluateGraph } from '@margoengine/biomes/graph';

const world = await BiomeWorld.create({ seed: 1, size: [1024, 1024] });
const graph = definePlacementGraph({
  nodes: [
    { id: 'valley', op: 'range', field: 'height', range: [null, 120] },
    { id: 'wet', op: 'range', field: 'waterDistance', range: [null, 80] },
    { id: 'patches', op: 'noise', scale: 60, seed: 4 },
    { id: 'clumps', op: 'curve', input: 'patches', points: [[0.4, 0], [0.6, 1]] },
    { id: 'groves', op: 'multiply', inputs: ['valley', 'wet', 'clumps'] },
    { id: 'dry', op: 'invert', input: 'wet' },
  ],
  outputs: { 'temperate/oak': 'groves', hazel: 'dry' },
});
const placement = BiomePlacement.attach(world, { graph });
const tile = await placement.tile(1, 1);
// A node's value over a world tile, 0..255 a cell: a preview, or a mask for envelopes and paint masks.
world.writeLayer('mask/groves', 1, 1, evaluateGraph(graph, 'groves', await world.tile(1, 1)));
```

| Op | Settings | Value |
| --- | --- | --- |
| `constant` | `value` | the value |
| `range` | `field`, `range`, `blend?` | 1 inside `[min, max]` (null for an open side) on a climate or terrain field (`ClimateEnvelope` names and units, plus `curvature`), a Wendland band across each bound |
| `noise` | `scale` (m), `seed?` | world-anchored value noise |
| `multiply`, `min`, `max`, `add` | `inputs` (2 to 16) | product, minimum, maximum, sum capped at 1 |
| `subtract` | `inputs` (2) | first less second, at least 0 |
| `invert` | `input` | 1 less the input |
| `curve` | `input`, `points` | piecewise linear through `[x, y]` points, flat past the ends |
| `blend` | `inputs` (2), `by` | the first where `by` is 0, the second where it is 1 |

Every value is 0..1. An output selector is `'<biome>/<species>'`, a species id or `'#tag'`; a species' density is
multiplied by every output that selects it, read at each candidate before the spacing rounds, on Q16.16 integers, so a
graph gives the same objects on every machine, in workers and on the GPU path. A selector that selects nothing, a cycle,
a missing input or a bad setting throws. A graph only lowers densities and leaves detail species (grass, flowers) alone.
