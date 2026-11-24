# @margoengine/biomes: Farmland

An English lowland farm landscape as plain data (`@margoengine/biomes/farmland`): a quilt of hedged fields, hedgerows on
the field lines with oaks, ashes and hollies standing in them, lanes along the field lines that end only at a junction,
the world's edge or a field gate, and a gate into every field. One of the package guides; the [README](../README.md) has
the quickstart and the list of guides.

```js
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';
import '@margoengine/biomes/splines';
import { FARMLAND_PAINT, farmlandEdits, layoutFarmland, lowlandFarmWorld } from '@margoengine/biomes/farmland';

const world = await BiomeWorld.create({
  size: [2048, 2048],
  climate: lowlandFarmWorld.climate,
  height: { relief: lowlandFarmWorld.relief },
  biomes: lowlandFarmWorld.biomes,
  paint: FARMLAND_PAINT,
});
const farm = layoutFarmland(world, { connect: [[-1024, 0], [0, 40], [1024, -300]] });
const editor = BiomeEditor.attach(world);
for (const edit of farmlandEdits(farm)) editor.apply(edit); // fields and lanes painted as their biomes
console.log(farm.fields.length, farm.hedges.length, farm.trees.length, farm.lanes.length, farm.gates.length);
world.dispose();
```

Draw it with `BiomeView` and `materials: FARMLAND_MATERIALS` (winter pasture, ploughed red-brown clay, stubble, rough
meadow, lane gravel); pass `farm.exclusions` as the view's `exclusions` so no stored tree stands in a lane. `farmlandEdits`
paints every hedge as a strip of the `hedgerow` biome (its gates left open), whose plants are hawthorn and blackthorn
about 1.2 m apart, hedgerow oaks and ashes (about 12 and 6 a kilometre) and holly, the one evergreen: give the view's
`meshes` the keys `library:hawthorn`, `library:blackthorn`, `library:oak`, `library:ash` and `library:holly`, and the
hedges draw with the rest of the plants, LOD rings and far impostors included, at any distance the view draws plants.
`farm.trees` still lists hedge tree spots for a scene that places its own field trees.

## How it is laid out

1. Seeds on a grid of the mean field size, jittered by `jitter`, cut the rect into Voronoi cells by clipping it with
   the bisector of each neighbour (Sutherland and Hodgman 1974). Cells whose seed lies in a `keep` polygon (a village,
   a wood, a yard, a crater) have use `none`.
2. Each field line wanders sideways by `wander` of the field width (two hashed sine terms, zero at its ends), one line
   both fields share: the sinuous hedges of piecemeal enclosure (Rackham 1986).
3. Lanes are least-cost paths over the graph of field lines (Dijkstra 1959) from each `connect` point to the lanes
   made so far, a step costing its length times 1 + grade times `gradeCost` (Galin et al. 2010), so lanes follow the
   field lines and the contours and share their way. A lane's end is a `junction` (three or more lanes meet), the
   `edge`, or a `gate` into the field it reaches; there is no other kind of end.
4. Each field gets a gate: onto its longest lane side if it has one, otherwise from a neighbour already reached, breadth
   first, so every field can be reached from a lane.
5. Hedges stand on the field lines by `hedgeShare` (always round kept ground), on both sides of every lane, cut back
   clear of a lane they meet, with a gap at each gate.
6. Hedge trees stand along each hedge as a Poisson process of mean spacing `treeSpacing` (at least 8 m apart), off the
   gates, by species share (hedgerow oaks first: Staffordshire SPG vol. 3, 2001).
7. Uses are drawn by share per field; furrows run along a field's longest side (Vanegas et al. 2012 keep a parcel's
   long axis).

| Setting | Default | What it does |
| --- | --- | --- |
| `seed` | 1 | seed of the fields, hedges, trees and uses |
| `rect` | the world's bounds | `[x0, z0, x1, z1]` to lay fields in |
| `fieldSize` | 40,000 | mean field area, m2 (2,500 to 400,000) |
| `jitter` | 0.8 | how far seeds stray from the grid, 0 to 1 |
| `wander` | 0.06 | sideways wander of a field line, share of the field width, 0 to 0.2 |
| `uses` | pasture 0.55, plough 0.2, stubble 0.15, meadow 0.1 | weights of the uses |
| `hedgeShare` | 0.92 | share of field lines with a hedge |
| `hedge` | height 2.2, width 2 | hedge size, metres (Defra 2007) |
| `treeSpacing` | 45 | mean metres between hedge trees |
| `trees` | oak 0.62, ash 0.28, holly 0.1 | weights of the hedge tree species |
| `connect` | none | `[x, z]` places the lanes join (two or more make lanes) |
| `laneWidth` | 4 | lane width, metres |
| `gradeCost` | 12 | how much lanes avoid climbing |
| `gateWidth` | 3.6 | field gate width, metres |
| `keep` | none | polygons that are not farmland |

`BiomeEditor` `polygon(layer, points, value)` (an edit of kind `polygon`) sets a layer inside a closed outline: every
cell whose corner is inside (even-odd, in integer millimetres, no division), nothing outside. `farmlandEdits` uses it for
the fields and `path` edits for the lanes.

## Sources

- "Farm Size Matters: A Spatially Explicit Ecological-Economic Framework for Biodiversity and Pest Management", arXiv
  2505.17687, 2025, https://arxiv.org/pdf/2505.17687 (discrete Voronoi field pattern; hedgerows on field margins by a share).
- Zamberletti, Papaix, Gabriel and Opitz, "Markov random field models for vector-based representations of landscapes",
  Annals of Applied Statistics 15(4), 2021, https://doi.org/10.1214/21-AOAS1447 (fields as patches, hedges as 1D
  elements on their margins).
- Vanegas, Kelly, Weber, Halatsch, Aliaga and Muller, "Procedural Generation of Parcels in Urban Modeling", Computer
  Graphics Forum 31(2), 2012.
- Galin, Peytavie, Marechal and Guerin, "Procedural Generation of Roads", Computer Graphics Forum 29(2), 2010.
- Dijkstra, "A note on two problems in connexion with graphs", Numerische Mathematik 1, 1959.
- Sutherland and Hodgman, "Reentrant polygon clipping", Communications of the ACM 17(1), 1974.
- Rackham, "The History of the Countryside", Dent, 1986 (ancient countryside: irregular fields, sinuous hedges, hedgerow
  trees).
- Staffordshire County Council, "Planning for Landscape Change", Supplementary Planning Guidance vol. 3, 2001.
- Defra, "Hedgerow Survey Handbook", 2nd edition, 2007.
