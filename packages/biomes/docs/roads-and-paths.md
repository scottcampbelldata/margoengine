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
