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
same world with every control below: climate sliders, presets, a map of each layer, painting and the file exports.

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
| [Procedural relief, hydrology and erosion](docs/relief-and-hydrology.md) | `createRelief` (coasts, islands, river valleys), `/hydrology` (flow, wetness, lakes, channels, on the CPU or a GPU world's device) and `/erosion` (integer thermal and hydraulic erosion) |
| [Seasons](docs/seasons.md) | `/seasons`: green-up, autumn, snow and wet ground for any day of the year |
| [Disturbance](docs/disturbance.md) | `/disturbance`: fire history, flood return periods and succession stages |
| [Roads and paths](docs/roads-and-paths.md) | `/splines`: polylines and smooth curves that keep objects off, paint a road surface and flatten or cut the ground; `/settlements`: villages, roads that follow the terrain, lanes and houses |

## Entries

Each is loaded only when used: the root (`BiomeWorld`, fields, classification), `/presets` (eight biomes, their worlds
and the reference world `R16`), `/relief` (the procedural landscape; `BiomeWorld.create` loads it only for a relief
height, the default), `/digest` (canonical bytes and SHA-256, loaded by `world.digest`), `/zones` (Whittaker and
Holdridge classifiers), `/multinoise` (nearest-point classifier over axes you choose), `/koppen` (Koppen-Geiger labels), `/toolkit` (the integer helpers), `/placement` (stored
objects), `/stats` (point-pattern statistics), `/erosion` (thermal and hydraulic erosion; `BiomeWorld.create` loads it only for a relief
with `erosion`), `/disturbance` (fire, flood and succession), `/settlements` (village sites, a road network that follows the terrain, lanes and house lots), `/graph` (placement rule graphs), `/splines` (roads and paths; `BiomeWorld.create` loads it only for a carved
height), `/gpu` (the device kernels; loaded only for a world that
may compute on a device), `/io` (heightmap, weight and mask files, layer dumps), `/view`,
`/objects` (stored objects and detail drawn through scatter) and `/editor`. The lazily loaded ones come through the
package name, so an app holds one copy of each module.

## Sources

Written clean room from public papers: Volder 1959 (CORDIC), Jarzynski and Olano 2020 (PCG hashes for GPUs), Perlin
2002 (quintic fade), Wendland 1995 (compactly supported kernels). Details in `docs/clean-room.md`.
