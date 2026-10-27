# @margoengine/tiles

Import `margoengine/tiles` from the `margoengine` package, or `@margoengine/tiles` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Streaming [OGC 3D Tiles 1.1](https://docs.ogc.org/cs/22-025r4/22-025r4.html) for engineering, GIS and digital-twin scenes: city models, photogrammetry, BIM and scanned sites far bigger than memory. Tiles load by screen-space error as the camera moves, coarse first, from a priority queue with a concurrency limit, and are evicted least recently used past a memory budget. glTF and b3dm tiles are drawn by [`@margoengine/gltf-pro`](../gltf-pro/README.md), pnts tiles by [`@margoengine/points`](../points/README.md); both are optional peers loaded with `import()` on the first tile that needs them. Core is not changed, and an app that does not import this package ships none of it.

## Quick start

```ts
import { Engine } from 'margoengine/core';
import { TilesRenderer } from 'margoengine/tiles';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { camera: { position: [0, 400, 600], target: [0, 0, 0], far: 50_000 } });

// The tileset's centre lands at the world origin, x east, y up, -z north (the default 'enu' frame).
const tiles = await TilesRenderer.load(engine, 'https://example.com/city/tileset.json', {
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
| Bounding volumes | `box`, `region` (always in EPSG:4979, ignores transforms), `sphere`; S2 is not supported |
| Refinement | `REPLACE` (children drawn only once every visible child is ready, so no holes and no overlap) and `ADD` |
| Implicit tiling | `QUADTREE` and `OCTREE`, `subtreeLevels`, `availableLevels` (or the 1.0 extension's `maximumLevel`), binary and JSON subtree files, constant and bitstream availability, child subtrees, `{level}` `{x}` `{y}` `{z}` templates |
| External tilesets | content that is tileset JSON becomes the tile's child; its transforms continue from the tile |
| Content | glTF and GLB, b3dm (with `RTC_CENTER` and the batch table), pnts (`POSITION`, `POSITION_QUANTIZED`, `RGBA`, `RGB`, `RGB565`, `NORMAL`, `NORMAL_OCT16P`, `BATCH_ID`, `CONSTANT_RGBA`), cmpt (nested); i3dm is parsed (one matrix per instance) but not drawn yet |
| Metadata | `schema` / `schemaUri`, `metadata` on the tileset, tiles and contents, `groups`; `tileset.properties(entity)` fills in schema defaults |

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
| `fetch` | `globalThis.fetch` | Your own fetch: auth headers, an offline cache, tests. |
| `signal` | none | `AbortSignal` for the load and every later request. |
| `frame` (renderer) | `'enu'` | `'enu'`, `'local'` or a 4x4 matrix; see below. |
| `origin` (renderer) | none | A floating origin (`FloatingOrigin` from `margoengine/cameras/origin`). |
| `loadModel` (renderer) | gltf-pro's `parseGLTFAsync` | Your own glTF loader. |
| `pointBudget` (renderer) | 2,000,000 | Budget of the points plugin made for pnts tiles. |

## Coordinates and precision

3D Tiles positions are ECEF metres (EPSG:4978): millions of metres from the earth's centre, where float32 keeps only about half a metre. Everything here stays float64 until the last step. The renderer's `frame` maps tileset coordinates to the engine's world: by default the east-north-up frame at the centre of the root volume becomes the world origin, with x east, y up and -z north (glTF's y-up), and glTF tile content gets the specification's y-up to z-up turn first. Each tile model's root mesh gets one float64 matrix, `frame x tile transform x RTC_CENTER x (y-up to z-up)`, split into translation, rotation and scale. A city 50 km across then sits within 25 km of the origin, where float32 still resolves 2 mm.

For a continent or the whole globe, add a floating origin: the renderer places every tile root through it, and it rebases the camera and all placed roots together when the camera wanders, so float32 values stay small wherever you are.

```ts
import { Engine } from 'margoengine/core';
import { FloatingOrigin } from 'margoengine/cameras/origin';
import { TilesRenderer } from 'margoengine/tiles';

const engine = await Engine.create(document.querySelector('canvas')!);
const origin = FloatingOrigin.attach(engine);
const tiles = await TilesRenderer.load(engine, 'https://example.com/globe/tileset.json', { origin });
origin.lookAt(tiles.cartographicToWorld(2.35, 48.85, 600), tiles.cartographicToWorld(2.35, 48.86, 0));
```

`toWorld(ecef)`, `toTileset(world)` and `cartographicToWorld(lon, lat, height)` convert points; the WGS84 helpers (`cartographicToEcef`, `ecefToCartographic`, `eastNorthUpToEcef`) are exported too.

## Without the engine

`Tileset` is engine-free: give it a view each frame and a content factory, and it does the rest. This is how the tests drive it, and how to stream tiles into your own renderer or a server-side job.

```ts
import { Tileset, type TileRenderable } from 'margoengine/tiles';

const tileset = await Tileset.load('https://example.com/city/tileset.json', {
  content: (content, tile, signal): TileRenderable => ({ bytes: content.byteLength, visible: false, dispose() {} }),
});
const frame = tileset.update({ position: [1_215_000, -4_736_000, 4_081_000], screenHeight: 1080, fov: 60 });
for (const tile of frame.selected) console.log(tile.id, tile.screenSpaceError.toFixed(1));
```

`update(view)` returns the tiles drawn this update. Events: `tileload`, `tileunload`, `error`, `progress` (queued, loading, ready, failed, selected, bytes) and `idle` (the view is complete). `tileset.retry()` forgets failed loads after the network or the file is fixed; failed tiles never stop the rest of the tileset, and a REPLACE parent keeps covering a failed child.

The content parsers (`parseB3dm`, `parsePnts`, `parseI3dm`, `parseCmpt`, `parseContent`, `parseSubtree`) are exported for tools. Truncated or corrupt input throws a `TypeError` or `RangeError` naming the problem; it never reads out of bounds.

## Limits

- i3dm content is parsed but not drawn; convert it to glTF with `EXT_mesh_gpu_instancing`.
- S2 bounding volumes, Draco-compressed pnts and binary metadata property tables are not read.
- Memory is counted as the bytes of each tile's content file, not the GPU memory its model takes.
- Orthographic cameras need `Tileset.update` with `orthographicHeight`; the renderer reads a perspective camera.
