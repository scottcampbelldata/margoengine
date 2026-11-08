# @margoengine/biomes: Roads and paths

Roads, tracks and paths as polylines or smooth curves (`/splines`): they keep stored objects off, paint a road surface
and flatten or cut the ground. One of the package guides; the [README](../README.md) has the quickstart and the list of
guides.

## A path

A path is plain data: points `[x, z]` in world metres, a `curve` (`'polyline'`, `'catmull-rom'` through every point, or
`'b-spline'` smoothed past the inner points), a `width` and an `edge` it fades across. `definePath` checks one, fills
the defaults and returns its sampled centre line in millimetres.

| Setting | Default | What it does |
| --- | --- | --- |
| `points` | (required) | 2 to 65,536 `[x, z]` pairs in metres within 1,100 km of the origin; repeated points are dropped |
| `curve` | `'polyline'` | how the path runs between points |
| `closed` | `false` | joins the last point back to the first (a ring road, a loop trail) |
| `step` | 2 | metres between curve samples, 0.25 to 64 (curves only) |
| `width` | 4 | full width in metres, 0.1 to 2,000 |
| `edge` | 2 | metres beyond the width over which the path fades out, 0 to 1,000 |
| `falloff` | `'smooth'` | the fade across the edge: `'smooth'` (quintic), `'linear'` or `'constant'` |
| `biome` | none | a biome id the path paints, `paint/<biome>` |
| `mask` | none | a mask the path writes, `mask/<name>` |
| `strength` | 1 | paint and mask value under the width, 0 to 1 |
| `carve` | `{ mode: 'flatten', depth: 0, grade: 24 }` | how a carved height shapes the ground |

Curves are the uniform cubic Catmull-Rom and B-spline bases evaluated in integers at a fixed number of samples per span
(the span's length over `step`, at most 1,024), so the same points give the same line on every machine. Pieces longer
than 256 m are split, and a path whose points all coincide is a disc of its width.

## The three things a path does

```ts
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';
import { BiomePlacement } from '@margoengine/biomes/placement';
import { presets } from '@margoengine/biomes/presets';
import { carvePaths, paintPaths, pathExclusions, type PathOptions } from '@margoengine/biomes/splines';

// A road biome no climate picks: a gravel ground and no plants.
const road = defineBiome({ id: 'road', climate: { custom: { 'mask/road-only': [0.5, null] } }, ground: [{ material: 'gravel' }] });
const paths: PathOptions[] = [
  { points: [[-400, -80], [-100, 40], [150, -20], [420, 60]], curve: 'catmull-rom', width: 6, edge: 4, biome: 'road', mask: 'roads', carve: { grade: 40 } },
  { points: [[-50, 300], [20, -300]], curve: 'b-spline', width: 2, edge: 1, mask: 'roads', carve: { mode: 'cut', depth: 0.4 } },
];
const world = await BiomeWorld.create({
  biomes: [presets.temperate, presets.alpine, presets.wetland, presets.boreal, road],
  height: carvePaths(paths), // 1: the ground flattened under the road, the track cut 0.4 m in
  ecotone: 4, // painted edges blend over 4 m, so a 6 m road keeps its line
});
const editor = BiomeEditor.attach(world);
paintPaths(editor, paths); // 2: the road surface and the roads mask, one undo step
const placement = BiomePlacement.attach(world, { exclusions: pathExclusions(paths) }); // 3: nothing stands on them
```

- **Placement.** `pathExclusions(paths)` gives `BiomePlacement` line exclusions: each path's sampled centre line, its
  width and its edge as the verge, where edge-loving shrubs gather. Placement keeps exclusion segments in 64 m squares,
  so a cell reads only the segments that can reach it, and thousands of segments cost about what a few do.
- **Ground paint.** `paintPaths(editor, paths)` paints `paint/<biome>` for a path with `biome` and writes `mask/<name>`
  for one with `mask`, as one undo step; `pathEdits(paths)` returns the same edits as plain data for `editor.apply`, so
  they replay in another world, sync between users and undo to the exact previous bytes like every other edit. The
  edits use mode `'max'`, so overlapping paths give the same bytes in any order. A road biome with `ground` materials is
  what the view draws on the road; the world's `ecotone` blurs painted edges, so keep it below the road width. Saved
  worlds (`saveWorld` of `/io`) keep the painted rasters.
- **Carved ground.** `carvePaths(paths, base)` wraps a height source (default the procedural relief) in `{ carve, base }`.
  Under the width the ground goes to the bed, and across the edge it blends back with the path's `falloff`. Mode
  `'flatten'` sets the bed to the ground along the path averaged over `grade` metres of the line, then `depth` lower,
  so a road crosses a slope level and climbs a hill at an even grade; mode `'cut'` lowers the ground by `depth` (a
  sunken lane, a ditch). Where paths overlap, the strongest weight wins and then the lowest bed. `BiomeWorld.create`
  loads this entry for a carved height; `heightAt`, the region fields, hydrology and the worker replicas all read the
  carved ground, and `saveWorld` writes the paths into the saved heights (still format version 1; a saved world without
  paths loads as before).

## Villages and the roads between them

`layoutSettlements(world, options)` (entry `@margoengine/biomes/settlements`) lays out the paths for you: villages on
good sites, roads between them that follow the terrain, lanes inside each village and the houses along them. The result
is plain data: `paths` (roads, then lanes) go to `carvePaths` and `paintPaths` above, `exclusions` (the paths with
their edges as verges, and each house with its yard) clear the trees and shrubs off them, and `villages` hold each
house's corners and floor height for your own building meshes.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { BiomePlacement } from '@margoengine/biomes/placement';
import { layoutSettlements } from '@margoengine/biomes/settlements';
import { carvePaths } from '@margoengine/biomes/splines';

const probe = await BiomeWorld.create(); // the land the layout reads
const town = layoutSettlements(probe, { villages: 3, houses: 16 });
const world = await BiomeWorld.create({ height: carvePaths(town.paths) }); // the same land, roads flattened in
const placement = BiomePlacement.attach(world, { exclusions: town.exclusions }); // no tree on a road or a house
console.log(town.villages.length, town.roads.length, town.villages[0]?.houses.length); // 3 2 8 on the default world
```

| Setting | Default | What it does |
| --- | --- | --- |
| `villages` | 3 | most villages, 0 to 64; fewer when the land has no more sites |
| `sites` | none | your own village centres `[x, z]` in metres (up to 64), used instead of the site search |
| `spacing` | 800 | least distance between village centres in metres, 50 to 100,000 |
| `houses` | 16 | most houses a village, 0 to 256 |
| `cell` | 16 | side of the grid the sites and roads are found on, metres, 2 to 256 (at most 4,194,304 cells) |
| `maxGrade` | 0.12 | steepest road grade, rise over run, before a step costs 20 times more (a switchback) |
| `siteGrade` | 0.08 | steepest ground under a village site or a house lot |
| `bridge` | 8 | cost of a road cell over a river, a multiple of a dry one |
| `detour` | 1.6 | a link beyond the spanning tree joins two villages whose tree way is longer than this times the direct one |
| `road`, `lane` | width 5, edge 3, Catmull-Rom; width 3, edge 1.5, polyline | path settings (`biome`, `mask`, `carve` and the rest), mask `'roads'` |
| `yard` | 4 | metres kept clear around each house |
| `seed` | 1 | the jitter of the site scores and the house sizes |

- **Sites.** Grid points on dry land, above sea level and off the rivers, whose ground and eight neighbours stay under
  `siteGrade`. They score by flatness, by nearness to water (best 30 to 400 m from a river or the coast; closer floods)
  and by lowness, plus a small seeded jitter, and the best ones at least `spacing` apart become villages.
- **Roads.** A minimum spanning tree over the villages (Prim), plus the shortest links whose way through the tree is
  longer than `detour` times the direct one. Each link is an A* least-cost path over the grid: a step costs its length
  times 1 + (grade / `maxGrade`)^2, 20 times that past `maxGrade`, `bridge` times over a river and half on a road
  already built, so later roads join earlier ones; the sea is never crossed, so two islands get no road. The cells are
  thinned by Douglas-Peucker to within 0.75 of a cell and drawn as a Catmull-Rom curve. A road goes round a ridge
  through its pass and crosses a river once, on a short bridge.
- **Houses.** Lanes leave each village along its roads and, up to six, between them; houses take lots on both sides
  every 13 m out to 14 + 7 sqrt(`houses`) metres, 7 to 10 m wide and 6 to 9 m deep, facing the lane. A lot is kept when
  its corners stand on dry land, its ground varies by less than `siteGrade` over its size, and it keeps clear of the
  roads and their edges, of the other lanes and of every other house. A lane along a road is the road itself.
- **Same layout everywhere.** The decisions use only + - * / and square roots, which IEEE 754 rounds the same way on
  every engine, integer hashes for the jitter, integer CORDIC for the lane angles and a heap that breaks ties by cell, so
  the same world and options give the same JSON on every machine.
- **Cost.** About 1.4 s on the busy Beelink for the default 4 km world at the 16 m cell (66,049 height reads, three
  villages; diagnostic, not a timed result). The work grows with the cells and with the links: each link is one search.

`tests/settlements.test.js` checks the site choice, the pass, the bridge, the sea, the network, the lots, the placement
exclusions on a real world and the same bytes.

## Same bytes everywhere

Every value is integer millimetres or Q16 with floors: quantised points, the integer curve bases, distances from a
segment to a sample with the nearest point's parameter in Q16, the falloff and the bed. A sample's value depends only on
its own position, so a path crossing a tile border gives the same bytes whichever tile is made first, a tile equals any
grid of the same cells, and 1 or 4 workers make the page's bytes. Segments sit in a bucket grid sized to the widest
reach, so a tile reads only the segments near it and each cell only those whose reach covers it. `tests/splines.test.js` checks seams, order, workers, save and load, undo, and holds the
golden digests.

## Errors

Settings out of range throw a `RangeError` naming the setting and its range (`A path width is a number of metres,
0.1..2,000`). A carved height or a path edit without this entry loaded says what to import; `BiomeWorld.create` and
`loadWorld` load it for you.
