# @margoengine/tiles

Import `margoengine/tiles` from the `margoengine` package, or `@margoengine/tiles` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Streaming [OGC 3D Tiles 1.1](https://docs.ogc.org/cs/22-025r4/22-025r4.html) for engineering, GIS and digital-twin scenes: city models, photogrammetry, BIM and scanned sites far bigger than memory. Tiles load by screen-space error as the camera moves, coarse first, from a priority queue with a concurrency limit, and are evicted least recently used past a memory budget. glTF and b3dm tiles are drawn by [`@margoengine/gltf-pro`](../gltf-pro/README.md), pnts tiles by [`@margoengine/points`](../points/README.md); both are optional peers loaded with `import()` on the first tile that needs them. Core is not changed, and an app that does not import this package ships none of it.

## Quick start

```ts
import { Engine } from 'margoengine/core';
import { TilesRenderer } from 'margoengine/tiles';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { camera: { position: [0, 400, 600], target: [0, 0, 0], far: 50_000 } });

// A real sample city (examples/assets/3d-tiles in this repository); give your own tileset's URL.
// The tileset's centre lands at the world origin, x east, y up, -z north (the default 'enu' frame).
const tiles = await TilesRenderer.load(engine, '3d-tiles/TilesetWithRequestVolume/city/tileset.json', {
  maximumScreenSpaceError: 16, // pixels; lower is sharper and loads more
  memoryBudget: 256 * 1024 * 1024, // bytes of tile content kept
});
tiles.tileset.on('progress', ({ queued, loading, ready }) => console.log(`${ready} ready, ${loading + queued} to go`));
tiles.tileset.on('error', ({ error }) => console.warn(error.message)); // MargoError, code 'failed', names the fix

// Place a marker by longitude, latitude (degrees) and height (metres).
console.log(tiles.cartographicToWorld(-75.6, 40.04, 120));
engine.start();
```

The renderer updates selection every frame from `engine.camera`. `tiles.dispose()` (or `using tiles = ...`) aborts every request and frees every tile.

## What it reads

| Part of the specification | Support |
| --- | --- |
| Tileset JSON | `asset`, `geometricError`, `root`, `children`, `transform` (composed in float64), `refine` (inherited), `content` / `contents` (several per tile), `viewerRequestVolume`, `content.boundingVolume`, `properties`, `extensionsRequired` (unknown required extensions fail with code `unsupported`) |
| Bounding volumes | `box`, `region` (always in EPSG:4979, ignores transforms), `sphere`; S2 cells (`3DTILES_bounding_volume_S2`, explicit and implicit) with `s2` from `margoengine/tiles/s2` |
| Refinement | `REPLACE` (children drawn only once every visible child is ready, so no holes and no overlap) and `ADD` |
| Implicit tiling | `QUADTREE` and `OCTREE`, `subtreeLevels`, `availableLevels` (or the 1.0 extension's `maximumLevel`), binary and JSON subtree files, constant and bitstream availability, child subtrees, `{level}` `{x}` `{y}` `{z}` templates |
| External tilesets | content that is tileset JSON becomes the tile's child; its transforms continue from the tile |
| Content | glTF and GLB, b3dm (with `RTC_CENTER` and the batch table), pnts (`POSITION`, `POSITION_QUANTIZED`, `RGBA`, `RGB`, `RGB565`, `NORMAL`, `NORMAL_OCT16P`, `BATCH_ID`, `CONSTANT_RGBA`, Draco-compressed with `dracoPoints` from `margoengine/tiles/metadata`), cmpt (nested), i3dm (`POSITION`, `POSITION_QUANTIZED`, `NORMAL_UP` / `NORMAL_RIGHT` and their oct-encoded forms, `SCALE`, `SCALE_NON_UNIFORM`, `EAST_NORTH_UP`, `RTC_CENTER`, embedded or external glTF; drawn with `i3dm` from `margoengine/tiles/i3dm`), glTF with Gaussian splats (`KHR_gaussian_splatting`, SPZ-compressed or not; drawn with `splats` from `margoengine/tiles/splats`) |
| Metadata | `schema` / `schemaUri`, `metadata` on the tileset, tiles and contents, `groups`; `tileset.properties(entity)` fills in schema defaults; glTF `EXT_structural_metadata` property tables and `EXT_mesh_features` feature IDs with `readStructuralMetadata` from `margoengine/tiles/metadata` |

## Selection

Each update measures every visible tile's screen-space error, `geometricError x screenHeight / (2 x distance x tan(fov / 2))` (perspective) or `geometricError x screenHeight / orthographicHeight`, and refines while it is above `maximumScreenSpaceError`. Tiles outside the camera frustum (or a `viewerRequestVolume` the camera is outside) are skipped. An empty tile always refines. Requests are prioritised in two groups: tiles that fill holes (REPLACE parents still standing in for children, ADD parents) first, coarsest first, then the final tiles nearest first. Requests no longer wanted are dropped from the queue or aborted in flight. With `skipLevelOfDetail`, parents whose error is more than `skipScreenSpaceErrorFactor` times the target are not loaded at all, so a close view fills in at full detail sooner.

## Options

`TilesRenderer.load(engine, url, options)` and `Tileset.load(url, options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `maximumScreenSpaceError` | `16` | Pixels of error allowed before refining. |
| `maxConcurrentRequests` | `6` | Requests in flight at once. |
| `memoryBudget` | 512 MiB | Bytes of ready content kept. Past it, the least recently used tiles outside the view are evicted; if the view alone needs more, only hole-filling loads start (`tileset.overBudget` is then true). |
| `skipLevelOfDetail` | `false` | Skip loading far-too-coarse parents (see Selection). |
| `skipScreenSpaceErrorFactor` | `16` | How coarse a parent may be before it is skipped. |
| `boundingVolumes` | none | Bounding volume extensions to read: `[s2]` from `margoengine/tiles/s2`. A tileset that requires S2 without it fails with code `unsupported`. |
| `fetch` | `globalThis.fetch` | Your own fetch: auth headers, an offline cache, tests. |
| `signal` | none | `AbortSignal` for the load and every later request. |
| `frame` (renderer) | `'enu'` | `'enu'`, `'local'` or a 4x4 matrix; see below. |
| `origin` (renderer) | none | A floating origin (`FloatingOrigin` from `margoengine/cameras/origin`). |
| `loadModel` (renderer) | gltf-pro's `parseGLTFAsync` | Your own glTF loader. |
| `pointBudget` (renderer) | 2,000,000 | Budget of the points plugin made for pnts tiles. |
| `i3dm` (renderer) | none | The i3dm drawer from `margoengine/tiles/i3dm`; without it an i3dm tile fails with code `unsupported`. |
| `dracoPoints` (renderer) | none | The Draco pnts decoder from `margoengine/tiles/metadata`; without it a Draco pnts tile fails with code `unsupported`. |
| `splats` (renderer) | none | The Gaussian splat drawer from `margoengine/tiles/splats`; without it a glTF tile holding `KHR_gaussian_splatting` fails with code `unsupported`. |

## Coordinates and precision

3D Tiles positions are ECEF metres (EPSG:4978): millions of metres from the earth's centre, where float32 keeps only about half a metre. Everything here stays float64 until the last step. The renderer's `frame` maps tileset coordinates to the engine's world: by default the east-north-up frame at the centre of the root volume becomes the world origin, with x east, y up and -z north (glTF's y-up), and glTF tile content gets the specification's y-up to z-up turn first. Each tile model's root mesh gets one float64 matrix, `frame x tile transform x RTC_CENTER x (y-up to z-up)`, split into translation, rotation and scale. A city 50 km across then sits within 25 km of the origin, where float32 still resolves 2 mm.

For a continent or the whole globe, add a floating origin: the renderer places every tile root through it, and it rebases the camera and all placed roots together when the camera wanders, so float32 values stay small wherever you are.

```ts
import { Engine } from 'margoengine/core';
import { FloatingOrigin } from 'margoengine/cameras/origin';
import { TilesRenderer } from 'margoengine/tiles';

const engine = await Engine.create(document.querySelector('canvas')!);
const origin = FloatingOrigin.attach(engine);
const tiles = await TilesRenderer.load(engine, '3d-tiles/TilesetWithRequestVolume/city/tileset.json', { origin });
origin.lookAt(tiles.cartographicToWorld(-75.613, 40.038, 300), tiles.cartographicToWorld(-75.613, 40.042, 0));
```

`toWorld(ecef)`, `toTileset(world)` and `cartographicToWorld(lon, lat, height)` convert points; the WGS84 helpers (`cartographicToEcef`, `ecefToCartographic`, `eastNorthUpToEcef`) are exported too.

## Instanced content (i3dm)

Trees, poles and street furniture often come as i3dm: one glTF and a transform per instance. Pass the drawer from `margoengine/tiles/i3dm` and each glTF primitive draws every instance of its tile in one instanced draw (gltf-pro's `PBRInstances`). Tilesets without i3dm never load this module.

```ts
import { Engine } from 'margoengine/core';
import { TilesRenderer } from 'margoengine/tiles';
import { i3dm } from 'margoengine/tiles/i3dm';

const engine = await Engine.create(document.querySelector('canvas')!);
// 25 trees as i3dm, a real sample (examples/assets/3d-tiles in this repository).
const tiles = await TilesRenderer.load(engine, '3d-tiles/TilesetWithTreeBillboards/tileset.json', { i3dm });
engine.start();
```

Each instance is placed as the specification says: tile transform x `RTC_CENTER` x instance (position, `NORMAL_RIGHT` and `NORMAL_UP` as the x and y axes, or the east-north-up frame at the instance with `EAST_NORTH_UP`, then the scale) x the glTF's y-up to z-up turn. All of it is float64; the model root sits at the mean instance position, so the float32 instance rows stay within the tile's own size. An external glTF (`gltfFormat` 0) is fetched with the tileset's `fetch`, relative to the tile's content URL. `instanceMatrices` and `instanceCenter` are exported for your own renderer.

## Metadata and Draco points

`margoengine/tiles/metadata` reads the binary metadata of 3D Tiles 1.1 content and decodes Draco-compressed point clouds. Tilesets without them never load it.

```ts
import { Engine } from 'margoengine/core';
import { TilesRenderer } from 'margoengine/tiles';
import { dracoPoints, readStructuralMetadata } from 'margoengine/tiles/metadata';

const engine = await Engine.create(document.querySelector('canvas')!);
// Draco-compressed pnts (3DTILES_draco_point_compression) decode in workers, with Draco's own decoder, on first use.
const tiles = await TilesRenderer.load(engine, '3d-tiles/TilesetWithRequestVolume/city/tileset.json', { dracoPoints });
engine.start();

// Feature properties of a glTF tile (EXT_structural_metadata and EXT_mesh_features); here a real Cesium sample.
const gltf = await (await fetch('3d-tiles/EXT_structural_metadata/ComplexTypes/ComplexTypes.gltf')).arrayBuffer();
const metadata = readStructuralMetadata(new Uint8Array(gltf));
// A picked vertex (mesh 0, primitive 0, vertex 5, say from a raycast hit) leads to its feature and its properties.
const feature = metadata.feature(0, 0, 5);
console.log(feature?.id, feature?.properties);
console.log(metadata.propertyTables[0].get(1, 'example_variable_length_ARRAY_STRING')); // ['One', 'Two']
```

`readStructuralMetadata(bytes)` takes a GLB, glTF JSON (data URIs, or `buffer: (index, uri) => bytes` for external buffers) or a tile's `content.gltf`. Property tables read every type of the 3D Tiles Metadata binary table format: `SCALAR`, `VECn`, `MATn` (column-major), `STRING`, `BOOLEAN` (bits) and `ENUM` (as the value's name), fixed and variable-length arrays with any offset type, `normalized` integers, then `offset` and `scale` (the table's override first), and `noData` read as the `default`. `table.get(row, name)` and `table.row(row)` read one feature; a row out of range reads as `undefined`. Feature ID sets come per mesh primitive, with their IDs per vertex for attribute and implicit sets. A malformed table throws a `TypeError` or `RangeError` naming it; nothing reads out of bounds.

`dracoPoints(content)` turns Draco pnts into ordinary point content: `POSITION`, `RGBA` or `RGB`, `NORMAL` and `BATCH_ID` from the Draco buffer, and the batch table properties the extension names. For your own renderer, call it from the `Tileset` content factory; a third argument takes any decoder with `decode(bytes)`.

## Gaussian splat tiles

Photoreal captures are now published as 3D Tiles whose glTF content holds Gaussian splats (`KHR_gaussian_splatting`, often with the SPZ payload of the draft `KHR_gaussian_splatting_compression_spz_2`, declared through `3DTILES_content_gltf`). Pass the drawer from `margoengine/tiles/splats`: gltf-pro reads each tile's splats and meshes, and [`@margoengine/splats`](../splats/README.md) draws them. Tilesets without splats never load this module.

```ts
import { Engine } from 'margoengine/core';
import { TilesRenderer } from 'margoengine/tiles';
import { splats } from 'margoengine/tiles/splats';

const engine = await Engine.create(document.querySelector('canvas')!, { camera: { position: [170, 40, 250], target: [50, -50, 50] } });
// CesiumJS's real sh_unit_cube: 27 splats with SH degree 3 in an SPZ payload (examples/assets/3d-tiles in this repository).
const tiles = await TilesRenderer.load(engine, '3d-tiles/GaussianSplats/sh_unit_cube/tileset.json', { splats });
engine.start();
```

Every visible tile's splats go into one cloud, so splats of neighbouring and overlapping tiles sort together rather than tile by tile; the cloud is rebuilt after an update that changed which tiles show (one rebuild for a whole REPLACE swap, so no frame shows both levels or neither) and when a floating origin moves. Each primitive is placed by `frame x tile transform x RTC x y-up to z-up x node` in float64: shapes and harmonics are turned by the linear part, and the translation is added in float64 when the cloud is built, so splats keep float32 precision at the tile's own size even at ECEF distances. Tiles with different harmonic degrees merge at the highest one. Past 3,000,000 visible splats a second cloud starts (`SPLATS_PER_CLOUD`), and those two sort apart. `placeSplats`, `mergePlaced` and `TileSplats` are exported for your own renderer.

## S2 cells

Global datasets often bound their tiles with S2 cells (`3DTILES_bounding_volume_S2`): a cell of S2's cube-face hierarchy, by its token, extruded along the ellipsoid normals between two heights. Pass `s2` from `margoengine/tiles/s2`; tilesets without S2 never load it.

```ts
import { Tileset } from 'margoengine/tiles';
import { parseS2Token, s2, s2Bounds } from 'margoengine/tiles/s2';

// The extension's own example: the S2 cell "89c6c7" over Philadelphia's Center City, from the ground to 1 km.
const volume = { token: '89c6c7', minimumHeight: 0, maximumHeight: 1000 };
console.log(parseS2Token(volume.token)); // { face: 4, level: 10, i: ..., j: ... }
console.log(s2Bounds(volume).radius.toFixed(0), 'm bounding radius');

const json = { asset: { version: '1.1' }, geometricError: 100, extensionsRequired: ['3DTILES_bounding_volume_S2'],
  root: { geometricError: 0, boundingVolume: { extensions: { '3DTILES_bounding_volume_S2': volume } } } };
const tileset = await Tileset.load(URL.createObjectURL(new Blob([JSON.stringify(json)])), { boundingVolumes: [s2] });
console.log(tileset.root.bounds.center);
```

Each cell becomes an oriented box in ECEF (east, north and up at the cell's centre) around a 17 x 17 grid of points on its bottom and top surfaces, grown by the curvature between those points, so it holds the whole volume; the tile transform is ignored, as the extension says. Tokens, the Hilbert order on each face (odd faces mirrored) and the quadratic projection follow the extension and the S2 cell hierarchy guide. With implicit tiling a quadtree tile (level, x, y) is the S2 cell at (x, y) on its parent's (i, j) grid, and an octree tile also takes its slab of the heights. `parseS2Token`, `s2Token`, `s2LonLat` and `s2CellBounds` are exported.

## Without the engine

`Tileset` is engine-free: give it a view each frame and a content factory, and it does the rest. This is how the tests drive it, and how to stream tiles into your own renderer or a server-side job.

```ts
import { Tileset, type TileRenderable } from 'margoengine/tiles';

const tileset = await Tileset.load('3d-tiles/TilesetWithRequestVolume/city/tileset.json', {
  content: (content, tile, signal): TileRenderable => ({ bytes: content.byteLength, visible: false, dispose() {} }),
});
const frame = tileset.update({ position: [1_215_000, -4_736_000, 4_081_000], screenHeight: 1080, fov: 60 });
for (const tile of frame.selected) console.log(tile.id, tile.screenSpaceError.toFixed(1));
```

`update(view)` returns the tiles drawn this update. Events: `tileload`, `tileunload`, `error`, `progress` (queued, loading, ready, failed, selected, bytes) and `idle` (the view is complete). `tileset.retry()` forgets failed loads after the network or the file is fixed; failed tiles never stop the rest of the tileset, and a REPLACE parent keeps covering a failed child.

The content parsers (`parseB3dm`, `parsePnts`, `parseI3dm`, `parseCmpt`, `parseContent`, `parseSubtree`) are exported for tools. Truncated or corrupt input throws a `TypeError` or `RangeError` naming the problem; it never reads out of bounds.

## Limits

- i3dm batch tables are read (`content.batchTable`) but per-instance picking and per-instance colours are not wired to them; an i3dm external glTF resolves against the tile's first content URL.
- S2 boxes are boxes: near a face cell's corners a box holds more than the cell (selection may load a tile slightly early); no real S2 dataset was found to test on, so the proof uses the extension's own examples and figures.
- Splat tiles: the visible cloud is rebuilt on the CPU and uploaded again when the visible tiles change, which costs time in proportion to the visible splats (not measured); splats do not write depth or receive lighting (see `@margoengine/splats`); the renderer's `loadModel` is not used for splat tiles; a glTF tile with external buffers is not read.
- Metadata: feature ID textures are named, not read (sample the texture yourself); property textures, property attributes and a `schemaUri` schema in glTF are not read; 64-bit integers become doubles (exact to 2^53); feature IDs of a Draco-compressed glTF primitive are not read; picking a vertex is yours (a raycast hit), the tables then give its feature.
- Draco pnts decode in Web Workers (`@margoengine/decoders/draco-points`), so not in Node without a decoder of your own.
- A tile whose glTF requires KHR_techniques_webgl (archived GLSL shaders, such as the billboard level of Cesium's TilesetWithTreeBillboards) fails with code `unsupported`, as glTF says a loader must; the rest of the tileset draws.
- Memory is counted as the bytes of each tile's content file, not the GPU memory its model takes.
- Orthographic cameras need `Tileset.update` with `orthographicHeight`; the renderer reads a perspective camera.
