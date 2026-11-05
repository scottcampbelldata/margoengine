# @margoengine/biomes: Drawing a world as terrain

BiomeView: the clipmap terrain, ground materials, the sea and river water, trees and grass on the terrain, the forest floor and far hills. One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## Drawing a world as terrain

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 140, 420], target: [0, 60, 0] } });
const world = await BiomeWorld.create();
const view = await BiomeView.attach(engine, world); // loads @margoengine/terrain on first use
await view.ready; // the tiles around the camera are in at full detail
engine.start();
// Painting a biome redraws only the tiles it touches:
world.writeLayer('paint/boreal', 8, 8, new Uint8Array(256 * 256).fill(255));
await view.whenIdle();
```

`BiomeView.attach(engine, world, options)` builds a clipmap `Terrain` (`view.terrain`, so `shadows.add(view.terrain)`
works) from the world: the region overview first, then 1 m tiles within `radius` of the camera, nearest first, written
into the heightmap and into 2 to 4 ground-weight textures (the terrain's optional `weights`, one channel per material),
and again for every rectangle `world.onChange` reports. Each biome shares its weight among its ground layers by their
slope, height, moisture, curvature and temperature rules (`temperature`, `coldest`, `warmest`: tundra snow lies where
the mean annual temperature is -6 C or less); `groundWeights(world, tile, materials)` is the same computation on the
CPU (16 bytes per cell summing to 255). The overview runs the same rules on the 16 m region grid, bilinear between its
corners (`overviewWeights(world, materials)`, from `sampleRegion`, so it does not depend on the tiles made before), so
hills beyond `radius` keep their rock and snow. With workers, `attach` makes it there, one band of texel rows per worker
(`overviewRows`, the same bytes), instead of blocking the page (about 650 ms of the zero-config attach on an RTX A6000 PC, now about 200). The terrain draws
nothing outside the world's rectangle: past an edge the sky shows. Materials are generated textures from `MATERIALS` (16 built-in looks, such as
`grass`, `sand`, `rock`, `snow`; `materials` overrides or adds them; `materialPixels(key, look)` gives the texture and
its mips): three octaves of value noise around the colour, with relief (`bump`, the terrain's `TerrainLayer.bump`) and
a large-scale light and dark (`macro`, a second sample at 96 m) so far rock and snow are not one flat grey. Rock has the
most of both, plant cover a little. Up to 16 materials per world, the terrain's limit (the 8 presets use 15); more is a
RangeError from `attach` that names the count.
`terrainColorsFor(world)` gives `TerrainColors` sand, meadow and stone colours for small scenes drawn as one mesh.

| `BiomeView.attach` option | Default | Meaning |
| --- | --- | --- |
| `textureResolution` | 2 | metres per heightmap and weights texel, a multiple of the world resolution; raised to fit the device |
| `radius` | 1,000 | tiles within this many metres of the camera are drawn at full detail |
| `materials` | none | `{ key: { color: [r, g, b] (sRGB 0..1), detail?, bump?, macro? } }` over `MATERIALS`; `detail` 0..1 (default 0.25), `bump` and `macro` 0..1 (default 0, a RangeError outside) |
| `clipmap` | cell 1 m, 64 cells, rings by world size | `cellSize`, `resolution` and `levels` of the terrain. With no `levels` the view takes the fewest rings (`clipmapLevels`, 1 to 12) that reach the far corner of the world and `radius`: 9 for a 4 km world, 12 for 65 km. A `levels` that reaches less than `radius` is a RangeError |
| `lookahead` | 3 | seconds ahead along the camera's velocity that tiles are fetched early |
| `budget` | 0.25 | milliseconds per frame the page spends copying arrived tiles in (one step always goes in) |
| `detailBudget` | 128 MiB | most bytes of detail density maps (one byte per texel per detail species, on this thread and the GPU); detail maps coarsen by halves to fit it and the device's largest texture |
| `signal` | none | rejects `attach` and stops streaming |
| `water` | `'auto'` | the sea: a `@margoengine/water` surface at `climate.seaLevel` over the world and out to the horizon (`view.water`), loaded on first use; `'auto'` draws it when the world reaches below sea level, `true` always, `false` never; Water settings (`{ depth: () => bloom.depthTexture }`) draw it with those over `SEA` |
| `sky` | none | a `Sky` (`@margoengine/sky`): the sea reflects its sky (`reflectionTexture`) and its sun glints on the waves (`lights`); without one the sea reflects a plain gradient |

WebGPU only. The view streams before every frame: tiles within `radius` of the camera, and of where the camera will be
`lookahead` seconds on, are fetched nearest first; tiles that fall out of range on their way are cancelled, and objects
of tiles left behind leave the GPU. On a world with workers (the default in browsers) the tiles, their ground weights
and their objects are made there, and the page only copies finished arrays in, a species or a detail map at a time
within `budget`. `view.prefetch(rect)` makes the tiles of a rectangle ahead of time (a planned flight, a loading
screen). Measured (goal G3, `packages/biomes/tests/flythrough-check.mjs`, RTX A6000, 4 workers): a 300 km/h flight
over the zero-config world adds nothing measurable to the slowest 1 percent of frames or to the worst frame against the
same flight with every tile made first (medians of three flights each, within the timer's 0.1 ms); copying one arrived
tile in takes 0.1 ms at the median and 0.3 ms at the 99th percentile on the page's thread.

The sea comes with the world: a world whose relief runs below `climate.seaLevel` (the wetland preset's west coast,
`coast` on `createRelief`) gets a water surface there with no option. The terrain hides it under land, so the shore
follows the coastline, with the water's shoreline foam. Rivers stay dry valleys unless you ask for water in them (below). The sea
is not `Water`'s pond default: `SEA` gives it a 512-cell grid (8 m cells on a 4 km world), two swell trains of 48 m and
27 m (0.9 m and 0.44 m high, their crests break into foam), 6 m of shoreline foam and a sea-blue body. Pass the scene's
`Sky` as `sky` and the sea reflects it: from the wetland shore at noon the sea's mean sRGB luma goes from 0.27 (a dark
teal plane) to 0.74, with waves (water-check.mjs).

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { presetWorlds } from '@margoengine/biomes/presets';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const { climate, relief } = presetWorlds.wetland;
const world = await BiomeWorld.create({ climate, height: { relief } });
const view = await BiomeView.attach(engine, world); // water: 'auto' finds the sea on the west side
console.log(view.water !== undefined); // true
```

`water: { rivers: 'auto' }` puts still water in the world's rivers, 1.5 m over the bed and falling with it toward the sea
(`@margoengine/biomes/rivers`, loaded only when asked for). The terrain hides it where the ground stands higher, so the
banks draw its edge. A world from `samples` has no lines of its own: pass yours, `rivers: [line]`, each an Int32Array of
`[x, z, ...]` millimetres. It stands still in v1.0.0 (docs/limits.md); the coupled grid has at most 512 cells a side.

The world's hydrology can fill the water in too. `water: { lakes: 'auto' }` puts a still lake in every pit whose fill
passes `lakeDepth` (1 m), at the fill's level, with the shallow edge of the same fill joined to it; `rivers: 'hydrology'`
draws the channels of the hydrology (`riversOf`) instead of the relief's lines, so a world from `samples` or with no relief
rivers gets them too. The hydrology entry loads with import() only for these two. `lakeLevels(h)` and `viewWater` in
`@margoengine/biomes/rivers` give the same water for a `Water` of your own. A lake's surface wins over a river's where it
is higher; below the sea both are the sea's.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create();
const view = await BiomeView.attach(engine, world, { water: { lakes: 'auto', rivers: 'hydrology' } });
```

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create({ height: { relief: { coast: 'south', rivers: 2 } } });
const view = await BiomeView.attach(engine, world, { water: { rivers: 'auto' } });
console.log(world.rivers.length, view.water !== undefined); // 2 true
```

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { presetWorlds } from '@margoengine/biomes/presets';
import { BiomeView } from '@margoengine/biomes/view';
import { Sky } from '@margoengine/sky';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const sky = Sky.attach(engine, { hours: 12, environment: true });
const { climate, relief } = presetWorlds.wetland;
const world = await BiomeWorld.create({ climate, height: { relief } });
// The sea reflects the sky and the sun glints on its swell.
const view = await BiomeView.attach(engine, world, { sky });
await view.ready;
engine.start();
```

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create({ workers: 3 });
const view = await BiomeView.attach(engine, world, { lookahead: 4, budget: 0.5 });
await view.prefetch([-1500, -1500, 1500, 1500]); // the tiles of a planned flight, made before it starts
console.log(view.streaming); // { pending, arrived }: tiles on their way and waiting to go in
```

### Trees, rocks and grass on the terrain

By default a `BiomeView` also draws the world's stored objects and detail: it attaches a `BiomePlacement` and a
`BiomeObjects` (entry `@margoengine/biomes/objects`), which streams each tile's records into one
`@margoengine/scatter/tiles` per species mesh (dead trees as snags) and draws every detail species (grass, ferns,
reeds) with a camera-following scatter whose density map is the placement's. Meshes are the `procedural:<name>` keys
of the presets, from `@margoengine/procedural`. Pass `objects: false` for terrain alone. `view.objects` is that
`BiomeObjects` (`count` objects on the GPU, `gpuBytes`, `dropped`). Its detail density maps cover the world at
`detailResolution` metres per texel, one byte per texel per detail species; `detailBudget` (default 128 MiB) caps their
total and the device's largest texture caps each side, checked before anything is allocated:
`BiomeObjects.attach` rejects with MargoError `'unsupported'` past either (`detailFits` tells ahead), and `BiomeView`
coarsens its detail maps until they fit. GPU memory follows what is held: the zero-config
world's 172,640 streamed objects take 6.6 MB (records 8 bytes each, LOD rings 32 bytes per instance they can draw, both
sized from the held tiles with headroom, and a tree's canopy sharing its trunk's), down from 117.6 MB when every tile
slot and ring was sized for the densest case (`packages/biomes/tests/objects-check.mjs`, RTX A6000).

| `BiomeView.attach` option | Default | Meaning |
| --- | --- | --- |
| `objects` | true | draw stored objects and detail |
| `detailRadius` | 120 | metres around the camera with grass and ferns |
| `shadows` | none | a `Shadows` (`@margoengine/shadows`): the view adds its terrain and every stored-object mesh to it and removes them on dispose |

Objects are lit like the terrain: each part draws with a core `PbrMaterial` of its colour (roughness 0.85), so the sun's
direction and colour and the engine's ambient light reach them, and an attached `Shadows` shadows them. Pass `shadows` to make
the trees, shrubs, rocks and the terrain cast too; `view.objects.casters` lists the object meshes it adds (each
species' parts and the snags; grass and ferns receive shadows but do not cast).

```ts
import { Engine } from '@margoengine/core';
import { Shadows } from '@margoengine/shadows';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const shadows = Shadows.attach(engine);
const view = await BiomeView.attach(engine, await BiomeWorld.create(), { shadows });
await view.ready;
console.log(view.objects?.casters.length); // trunks, canopies, shrubs, rocks and snags: one mesh each
engine.start();
```

Each tree, palm, birch, acacia and shrub part draws `@margoengine/procedural`'s `detail` 2, 1 and 0 meshes in its
three LOD rings (150, 400 and 1,000 m for canopy trees, 45, 120 and 300 m for the rest; a broadleaf canopy goes from
6,240 to 3,180 to 400 triangles), switched hard: a dithered fade between them cost 1.2 to 5.6 ms a frame with shadows.
Rocks, cacti and snags have one mesh. Every part takes scatter's `variation` from a hash of its position, so no two
trees share a colour: leaves `{ hue: 0.06, value: 0.15 }` with `clusters: 0.6` (canopies shade as clumps about 0.6 m
across), bark and stone `{ hue: 0.02, value: 0.1 }`. Broadleaf, birch, palm and conifer each have their own green. At the
zero-config world's wide view, 1440x900 on an RTX A6000, a frame went from 53 to 9.0 ms with shadows (20 to 4.1 ms
without; `packages/biomes/tests/objects-frame-check.mjs`), and `objects-check.mjs` checks the leaf texture and the
spread of tints. To draw a species of your own the same way:

```ts
import { Engine, Geometry, PbrMaterial } from '@margoengine/core';
import { generateTreeMesh } from '@margoengine/procedural';
import { ScatterTiles } from '@margoengine/scatter/tiles';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const levels = ([2, 1, 0] as const).map((detail) => generateTreeMesh('broadleaf', { detail })); // near, middle, far
const rings = (part: 'trunk' | 'canopy') =>
  levels.map((t) => new Geometry(t[part].positions, t[part].normals, t[part].indices)) as [Geometry, Geometry, Geometry];
const look = { bounds: [-2048, -2048, 2048, 2048], lod: [150, 400, 1000], lodFade: 0 } as const;
const trunks = ScatterTiles.attach(engine, rings('trunk'), {
  ...look,
  material: new PbrMaterial({ color: [0.22, 0.14, 0.08], roughness: 0.85 }),
  variation: { hue: 0.02, value: 0.1 },
});
ScatterTiles.attach(engine, rings('canopy'), {
  ...look,
  material: new PbrMaterial({ color: [0.14, 0.3, 0.05], roughness: 0.85 }),
  variation: { hue: 0.06, value: 0.15 },
  clusters: 0.6,
  share: trunks, // the same trees: one set of records, culling and rings
});
engine.start();
```

Shadows cost GPU time in proportion to the objects in view: every cascade draws every stored object the camera sees,
with its ring's mesh, so on a forest the shadow passes can cost more than the rest of the frame; fewer `Shadows`
`cascades` cost less and reach less far. Objects outside the view cast no shadow onto ground in it (scatter casts the
instances it culled for the camera). `packages/biomes/tests/shadows-check.mjs` checks the look.

### Forest floor and far hills

Tree crowns darken the ground: a material `'canopy'` (its look in `MATERIALS`) takes `canopy` (default 0.6 with
objects, 0 without) of the ground weight times the crown cover, on far hills and under the trees alike, and
`view.materials` lists it last. Nothing is added for a world without trees or with 16 ground materials already. The
`@margoengine/biomes/cover` entry, loaded only when `canopy` is above 0, computes the cover from the region fields
without placing a tree: density x crown area x mean crown size squared of each biome's trees, by biome weight, with
stands and suitability.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { canopyCover } from '@margoengine/biomes/cover';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const world = await BiomeWorld.create();
const view = await BiomeView.attach(engine, world, { canopy: 0.8 });
await view.ready;
const cover = canopyCover(world); // 0..255 every 16 m over the world, in all and by tree kind
console.log(cover.width, cover.depth, cover.data[0], cover.kinds.length);
engine.start();
```

Far trees follow the same cover. Beyond the view's `radius`, out to `far.radius` (default 2,500 m, count 300,000; `far:
false` turns them off, and they stay off when `radius` already reaches that far) one camera-following `Scatter` per
tree kind draws `generateTreeStandIn` (`@margoengine/procedural/standin`), a 12-triangle tree. They take over from the
stored trees over the last tile of `radius`, are lit by the engine light and cast no shadow. Their positions are
hashed, so a far tree does not grow into the stored tree that replaces it; at that distance a tree is about 5 pixels.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const view = await BiomeView.attach(engine, await BiomeWorld.create(), { far: { radius: 4000, count: 500000 } });
await view.ready;
console.log(view.objects?.farCount); // stand-ins drawn at most
engine.start();
```
