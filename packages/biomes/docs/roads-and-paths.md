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
  sunken lane, a ditch); mode `'level'` sets the bed to the world height `top` (metres, default 0), raising or lowering
  the ground, so a sea wall, a breakwater mound running out into the sea, a quay apron or a levee is a path whose
  sides slope across its edge (`top` is refused on the other modes, and their settings keep their old bytes). Where paths overlap, the strongest weight wins and then the lowest bed. `BiomeWorld.create`
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
| `pattern` | `'lanes'` | `'grid'` lays blocks of lots between straight streets with a main street to the quay |
| `grid` | see below | block, street, lot, setback, toward and above of the grid pattern |
| `pads` | true for `'grid'`, else false | one level-ground carve path under each house; its `floor` is the pad level |
| `drives` | as `pads` | one driveway path a house, from its front to its street |
| `drive` | width 3, edge 1, polyline, mask `'roads'` | path settings of the driveways |
| `avoid` | none | exclusions no house may touch (a rail line, a creek, a yard; `pathExclusions(paths)`): a house whose centre, corners or edge midpoints fall inside one, or within a line's half width and verge, is not built; streets may cross them |

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
- **Cost.** About 1.4 s on the busy AMD mini PC for the default 4 km world at the 16 m cell (66,049 height reads, three
  villages; diagnostic, not a timed result). The work grows with the cells and with the links: each link is one search.

### Grid towns

`pattern: 'grid'` lays a town the way a harbour town is planned: a frame with one axis toward the water (the main street's
way to the quay) and one along the shore, a street every block, and lots in two rows on both sides of each block, each
facing the street beside it. `pads` and `drives` are on by default for it.

```ts
import { layoutSettlements } from '@margoengine/biomes/settlements';

// Flat ground that falls to the sea on the east; any BiomeWorld works the same way.
const world = {
  bounds: [-1000, -1000, 1000, 1000] as [number, number, number, number],
  heightAt: (x: number, z: number) => Math.max(-6, (300 - x) * 0.02 + 0.3 * Math.sin(z / 40)),
  climate: { sea: 0 },
};
const town = layoutSettlements(world, { villages: 1, houses: 60, pattern: 'grid', sites: [[-100, 0]] });
const village = town.villages[0];
const house = village.houses[0];
console.log(village.streets?.length, house.front, house.street, town.pads?.length, town.drives?.length);
// Hand `town.paths` to carvePaths: roads, streets, driveways and pads are all in it.
```

| `grid` setting | Default | What it does |
| --- | --- | --- |
| `block` | `[56, 36]` | a block's size in metres, along the shore and toward the water, each 8 to 400 |
| `street` | 8 | street width in metres, 2 to 40; `lane.width` is the drawn width and follows it |
| `lot` | 14 | lot frontage in metres, 8 to 60; a block holds a whole number of lots, so lots come out near it |
| `setback` | 4 | metres from a house front to the street edge, 0 to 30 |
| `toward` | nearest sea | direction `[x, z]` of the main street; else the nearest sea within 1,200 m, else the nearest river, else a seeded angle |
| `above` | 0 | metres over sea level that lots and streets keep, 0 to 1,000 (the sea wall's flood height, for a tsunami town) |

- **Streets.** Every street runs straight, one every block in both directions, with the village centre at a crossing.
  Each street is cut into stretches wherever the ground is wet, lower than `above`, or steeper than `maxGrade` over two
  metres; a stretch under 8 m is dropped. The main street is the stretch through the centre toward the water and stops at
  the last dry sample: its end is the quay. Only stretches that join the main street through crossings are kept, and
  only those that front a house or lead to one are returned (`Village.streets`, main first; also in `lanes` and `paths`).
- **Lots.** The closest lots to the centre get houses first: a house is 7 to 10 m wide (seeded) and 6 to 9 m deep, set
  back `setback` from its street, with `front` (unit vector toward the street) and `street` (an index into
  `Village.streets`). A lot is kept when its house and corners stand on dry land at least `above`, level within
  `siteGrade`, clear of the roads between villages and of every other house, and its frontage lies on a stretch joined to
  the main street, so every house reaches the main street by streets.
- **Pads and drives.** A pad is a carve path along the house's width axis, `depth + 1` m wide with a 1.5 m edge, whose bed
  is the mean of the ground at its two ends, so the house stands level at `House.floor`. A drive runs from half a metre
  inside the front to half a metre into the street edge, flattened over twice its length, mask `'roads'`. Both also work
  with the `'lanes'` pattern (`pads: true`); the defaults keep that pattern's bytes. `paths` is roads, lanes, drives, then
  pads; the exclusions cover roads, lanes, drives and house yards (a pad's house polygon already clears it).
- **Sources.** Block and lot subdivision with lots facing the street, after Parish and Muller, "Procedural Modeling of
  Cities", SIGGRAPH 2001; the street cut and the connectivity are our own, from that description. No code read.

`tests/settlements.test.js` checks the site choice, the pass, the bridge, the sea, the network, the lots, the placement
exclusions on a real world, the grid streets, lots, pads and drives, and the same bytes.

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
