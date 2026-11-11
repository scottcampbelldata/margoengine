# @margoengine/points

Import `margoengine/points` from the `margoengine` package, or `@margoengine/points` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Large point clouds and instanced sprites for Margo Engine, WebGPU, built for big scans: the browser test culls and draws a 2,000,000-point cloud under a 500,000-point budget.

Build from source with `npm run build` in `packages/points`.

```ts
import {Engine} from 'margoengine/core';
import {PointsPlugin, PointCloud, SpriteBatch, atlasRect} from 'margoengine/points';
import {createMesh} from 'margoengine/materials';
import {box} from 'margoengine/core';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const mesh = engine.createMesh().setGeometry(box());
const points = PointsPlugin.attach(engine, {pointBudget: 2_000_000});

// Any {positions, colors?, normals?} works, including the point-cloud output of @margoengine/loaders.
const positions = new Float32Array(30_000).map(() => Math.random() * 10), colors = new Float32Array(30_000).fill(1);
const cloud = points.add(new PointCloud({
  positions,                       // Float32Array, xyz per point (used in place)
  colors,                          // RGB or RGBA, floats 0..1 or a Uint8Array 0..255
  material: {size: 2, shape: 'round', edl: true},
}));
cloud.attach(mesh);                // follow a core mesh's world matrix

// Change 100 points: only those 1200 bytes are written to the GPU.
const newXyz = new Float32Array(300).map(() => Math.random() * 10);
cloud.updatePositions(5000, newXyz);

// Thousands of camera-facing sprites in one draw call.
const atlas = new OffscreenCanvas(64, 64);
const ctx = atlas.getContext('2d')!;
ctx.fillStyle = 'white';
ctx.fillRect(0, 0, 64, 64);
const labels = points.add(new SpriteBatch({material: {map: atlas}}));
labels.add({position: [0, 2, 0], size: 0.5, uv: atlasRect(3, 4, 4)});
engine.render();

// CPU picking of the nearest drawn point.
canvas.addEventListener('click', event => {
  const hit = points.pick(event.offsetX, event.offsetY, {radius: 8});
  if (hit) console.log(hit.index, hit.position);
});
```

## How it works

- **Blocks.** `new PointCloud()` splits the points into spatially compact blocks of at most `blockSize` points (median splits along the longest axis, like a kd-tree) and records each block's bounds. Each frame the plugin transforms every block's bounds by the model matrix and frustum-culls it on the CPU against `camera.planes`.
- **Point budget and level of detail.** The points inside each block are shuffled once with a seeded PRNG, so the first `k` slots of a block are an even random sample of it. Visible blocks share `pointBudget` in proportion to their projected screen area, and blocks that need less than their share give the rest to the others. Each block then draws a prefix of its slots: one `draw(4, k, 0, firstSlot)` call per visible block. This is the progressive subsampling Potree uses, without its octree files.
- **GPU data.** Positions (f32 xyz), packed RGBA8 colors, optional f32 sizes and the shuffled slot order live in storage buffers; the vertex shader expands each point into a quad (a 4-vertex triangle strip per instance). The arrays stay in your order, so `updatePositions`, `updateColors` and `updateSizes` call `writeBuffer` on exactly the changed byte range. Position updates also grow the affected blocks' bounds.
- **Frame uploads.** Points and sprites share a 144-byte camera uniform. Consecutive views with identical uniform bytes reuse the last upload; camera, viewport, format or projection changes upload again. Device restoration always uploads to the new buffer. This removes one queue write per unchanged view; timing is pending the quiet rerun.
- **Shapes and shading.** Square points cover exactly `size x size` pixels. Round points are an antialiased disc with an extra pixel of quad. A `map` (any `GPUTexture`, or an `ImageBitmap`, canvas, image, video or `ImageData` that the plugin uploads as `rgba8unorm-srgb`) is sampled across the point, with `alphaTest` or blending. `shading: 'sphere'` lights each point as a sphere impostor and writes its curved depth with `frag_depth`. `edl: true` adds eye-dome lighting: points also write their view depth into an `r32float` target and a full-screen pass multiplies the color by `exp(-32 * strength * mean(max(0, log2 d - log2 d_neighbor)))` over 8 neighbors `edlRadius` pixels away (Boucheny's eye-dome lighting; background neighbors count as 0).
- **Depth.** Points test against the scene with reversed-Z `greater-equal` and opaque points write depth, so they hide behind meshes and occlude each other. Transparent materials blend without writing depth.
- **Engine views.** Point sizes and level of detail follow the view being drawn. `pick(x, y)` picks through the canvas view under the point with that view's camera; `pick(x, y, {view: id})` through a named one (`RenderView.id`). A view not drawn for a frame is forgotten.
- **Orthographic cameras.** Everything is read from `camera.matrix`, so any projection whose clip w is constant (such as `CameraProjection` from `@margoengine/cameras`) works without a dependency on it: world-unit sizes use the matrix's pixels per world unit and stay the same at every depth, sphere impostors write linear depth, eye-dome lighting shades linear depth steps (scaled like the log steps a perspective camera with the same zoom would give), block budgets ignore distance, and picking breaks ties by distance from the near plane (`depth` is then measured from the near plane).
- **Sprites.** A `SpriteBatch` keeps 16 floats per sprite (position, rotation, size, pivot, atlas UV rectangle, color) in one storage buffer and draws every sprite with one instanced call. Quads face the camera using the camera's right and up vectors; with `sizeUnits: 'pixels'` (`sizeAttenuation: false`) they are expanded in screen space instead.
- **Colors.** Material and sprite colors take `'#rrggbb'` (sRGB) or linear `[r, g, b]`, like `PbrMaterial`. Per-point colors are sRGB by default, which matches the loaders package and 8-bit scanner data; set `colorSpace: 'linear'` otherwise. Output is sRGB-encoded in the shader on non `-srgb` canvas formats, the same way core does it.
- **Device loss.** `onDeviceRestored` rebuilds every buffer, pipeline and uploaded texture from the CPU copies. `dispose` (and `engine.removePlugin`) destroys them all. Clouds and batches stay registered, so a plugin can be reused.
- **SSR.** Nothing touches `window`, `navigator` or GPU globals at import or construction time.

## HDR colors

By default per-point colors are bytes, clamped to 0..1. With `colorFormat: 'float'` a cloud stores each color as four float32, so emissive and HDR points keep their energy for bloom and tone mapping. On a plain 8-bit canvas values above 1 still clip at the end; they count when the engine draws to an HDR target or a material `color` scales them down.

```ts
import {Engine} from 'margoengine/core';
import {PointsPlugin, PointCloud} from 'margoengine/points';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
const sparks = points.add(new PointCloud({
  positions: new Float32Array([0, 0, 0, 1, 0, 0]),
  colors: new Float32Array([8, 3, 0.5, 0.2, 4, 12]), // linear, may pass 1
  colorFormat: 'float',
  material: {size: 6, shape: 'round'},
}));
sparks.updateColors(1, [0, 0, 20]);
console.log(sparks.floatColors?.[6]); // 20
```

Float colors default to `colorSpace: 'linear'`. Byte arrays are still read as 0..255. `cloud.floatColors` is a live view; after writing into it call `markDirty('colors')`. `OctreeCloud` takes it as `cloud: {colorFormat: 'float'}`, and `SurfelPlugin` reads it too.

## Loader interop

`PointCloud` accepts the object `@margoengine/loaders` returns for PLY, PCD, XYZ and other point clouds without importing that package: `{kind: 'points', positions: Float32Array, colors?: Float32Array (sRGB rgb 0..1), normals?: Float32Array}`. Pass it straight in: `new PointCloud({...loaded, material: {size: 2}})`. Normals are kept on `cloud.normals` but not used for shading.

## Options

`PointsPlugin`

| Option | Default | |
| --- | --- | --- |
| `pointBudget` | 1,000,000 | Most points drawn per frame across all clouds |
| `edlStrength`, `edlRadius` | 1, 1.4 px | Eye-dome lighting |
| `order` | 10 | Frame graph order: after the scene, before fat lines (20) and post (30) |
| `name` | `'points'` | Unique per engine |

`PointCloud`

| Option | Default | |
| --- | --- | --- |
| `positions` | required | xyz per point |
| `colors`, `colorComponents` | none, inferred | RGB or RGBA, float 0..1 or Uint8 0..255 |
| `sizes` | none | Per-point multiplier of `material.size` |
| `blockSize` | 16384 | Points per culling block |
| `colorFormat` | `'rgba8'` | `'float'` keeps HDR colors above 1, at 16 bytes a point instead of 4 |
| `colorSpace` | `'srgb'`, `'linear'` with `colorFormat: 'float'` | Of per-point colors |
| `reorder` | false | Permute the arrays into block order for sequential GPU reads; `sourceIndex` maps back |
| `cullMargin` | 0 | World units added to the frustum test |
| `seed` | 1 | Shuffle seed |

`PointsMaterial` (`SpriteMaterial` shares the first block)

| Option | Default | |
| --- | --- | --- |
| `color`, `opacity` | white, 1 | |
| `map`, `mapFilter` | null, `'linear'` | GPUTexture or image source |
| `mipmaps` | true (sprites: false) | Generate mips of an uploaded map |
| `alphaTest` | 0 | |
| `transparent`, `blending` | false (sprites: true), `'normal'` | `'additive'` also available |
| `depthTest`, `depthWrite` | true, `!transparent` | |
| `size` | 4 | Diameter in pixels, or world units with `sizeUnits: 'world'` |
| `sizeUnits` / `sizeAttenuation` | `'pixels'` / false | Sprites default to `'world'` |
| `minPixelSize`, `maxPixelSize` | 1, 256 | |
| `shape` | `'square'` | or `'round'` |
| `vertexColors` | true | |
| `shading` | `'flat'` | or `'sphere'` |
| `edl` | false | On the WebGPU compatibility level it costs a second pass of the same draws and a draw per sample; the frame is the same. |
| `fog` | true | Fogged by the plugin's `setFog` (sprites too); false keeps the material clear |

Sprites: `add({position, size, rotation, center, color, opacity, uv})`, `set(index, ...)`, `remove(index)` (moves the last sprite into the slot), `clear()`. `SpriteMaterial.rotation` adds to every sprite.

## Mipmaps

A map drawn on a small point shimmers, as each pixel lands on one texel of a large image. Points generate a full mip chain of an uploaded map by default and pick the level from their size on screen, so a 256 px map on a 4 px point reads as its average. `mapFilter: 'nearest'` still blends nothing between levels. Sprites keep `mipmaps: false` by default, as mips bleed between the cells of an atlas; set it to true for a batch that draws one image per sprite, or leave a gutter around atlas cells.

```ts
import {Engine} from 'margoengine/core';
import {PointsPlugin, PointCloud, SpriteBatch} from 'margoengine/points';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
const map = await createImageBitmap(new ImageData(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64));
points.add(new PointCloud({positions: new Float32Array([0, 0, 0]), material: {map, size: 6}}));
points.add(new SpriteBatch({material: {map, mipmaps: true}})).add({position: [1, 0, 0], size: 0.1});
```

A `GPUTexture` you pass keeps the mips it has, and they are used. A map with `alphaTest` tests the filtered alpha, so holes in a map soften as a point shrinks. Every upload, including `needsUpdate()` on a video or canvas, makes the chain again.

## Fog

`points.setFog(fog)` fogs every cloud and sprite batch whose material has `fog: true` (the default) with
`@margoengine/environment`'s `Fog` or any object with its fields (`color`, `near`, `far`, `density`, `heightFalloff`,
`height`, `enabled`), read every frame with Fog's maths. A point takes the fog at its centre, a sprite at each pixel.
`'normal'` blending fades toward the fog colour; `'additive'` fades toward adding nothing, so fog hides a glow instead of
painting it in the fog colour. Points does not import environment. `fog.enabled = false` clears it without recompiling;
`points.setFog(null)` (the default) draws exactly as before.

```ts
import {Fog} from 'margoengine/environment';
import {PointsPlugin, SpriteBatch} from 'margoengine/points';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
const atlas = await createImageBitmap(await (await fetch('/labels.png')).blob());
const labels = points.add(new SpriteBatch({material: {map: atlas}}));
points.setFog(Fog.attach(engine, {color: '#8090a0', density: 0.03}));
labels.material.fog = false; // keep this batch clear
```

## With glass

Transparent clouds and sprites blend over the scene at order 10. `addEffect` from
[`margoengine/oit/vfx`](../oit/README.md#particles-splats-and-points-addeffect) draws those that test depth and write none
in the same pass as glass; the rest keep their draw:

```ts
import {Engine} from 'margoengine/core';
import {OIT} from 'margoengine/oit';
import {addEffect} from 'margoengine/oit/vfx';
import {PointsPlugin, PointCloud} from 'margoengine/points';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
points.add(new PointCloud({positions: new Float32Array([0, 0, 0]), material: {size: 8, transparent: true, opacity: 0.5}}));
addEffect(OIT.attach(engine, {blending: true}), points);
```

Culling and the point budget run before anything draws, so the pass, at order 8, finds this frame's points. Additive
materials join only `blending`. Surfels stay out.

## Clipping planes

`PointsMaterial.clippingPlanes` and `SpriteMaterial.clippingPlanes` take up to 6 world-space planes `[a, b, c, d]`;
fragments where `a x + b y + c z + d < 0` are cut away (the `@margoengine/materials` convention). A point tests each
fragment's world position on its camera-facing disc (on the sphere for `shading: 'sphere'`), so a plane can cut a large
point in half; world-sized sprites test each fragment on the quad, pixel-sized sprites (`sizeUnits: 'pixels'`) their
centre. Planes are normalised on assignment and reading returns copies; assign a new list to change them (live, next
frame, no recompile). More than 6 planes throw a RangeError, a malformed plane or a zero normal a TypeError.
`clipIntersection: true` cuts only fragments behind every plane (their intersection) instead of any.

```ts
import {Engine} from 'margoengine/core';
import {PointsPlugin, PointCloud} from 'margoengine/points';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const points = PointsPlugin.attach(engine);
// Section a scan: keep x <= 2 and z >= 0.
const cloud = points.add(new PointCloud({
  positions: new Float32Array([0, 0, 0, 3, 0, 1, 1, 1, -1]),
  material: {size: 3, clippingPlanes: [[-1, 0, 0, 2], [0, 0, 1, 0]]},
}));
cloud.material.clippingPlanes = [[-1, 0, 0, 2]]; // live: drop the z cut
```

## LAS and LAZ scans (`margoengine/points/las`)

`parseLAS(bytes)` reads ASPRS LAS 1.0 to 1.5: point formats 0 to 10, extra bytes (scaled, with no-data as NaN), every
VLR and EVLR, and the CRS (OGC WKT record 2112 and the GeoTIFF keys 34735 to 34737, with the EPSG code). Positions come
back as float32 relative to `origin` (the bounding box centre by default, float64), so a survey 500 km from the CRS
origin keeps millimetres. LAS is z-up; the engine is y-up, so swap axes when you place it. Where a non-zero legacy
32-bit count disagrees with its 64-bit twin, the legacy value is used, as LAS 1.4 R16 and 1.5 say. A LAS 1.5 header
also gives `header.timeOffset` and `header.gpsTimeRange`: with global encoding bits 0 and 6 set, a point's standard GPS
time is `gpsTime + 1e6 * timeOffset`.

```ts
import { Engine } from 'margoengine/core';
import { PointCloud, PointsPlugin, classificationColors } from 'margoengine/points';
import { loadLAS } from 'margoengine/points/las';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
const las = await loadLAS('/scans/site.las', { stride: 1 });
const positions = new Float32Array(las.count * 3);
for (let i = 0; i < las.count; i++) // z-up survey to y-up world
  positions.set([las.positions[i * 3], las.positions[i * 3 + 2], -las.positions[i * 3 + 1]], i * 3);
points.add(new PointCloud({ positions, colors: classificationColors(las.classification), colorComponents: 4 }));
console.log(las.crs?.epsg, las.header.pointFormat, Object.keys(las.extra));
```

| Option | Default | Meaning |
| --- | --- | --- |
| `origin` | box centre | World point positions are stored relative to, or `'min'` for the box's minimum corner. When the first point lies outside the header's box, a fault of some writers, the first point is the origin instead; `las.origin` says which. |
| `maxPoints` / `stride` | all / 1 | Read fewer points (a preview). |
| `partial` | `false` | Read what a cut-short file holds instead of throwing a `RangeError`. |
| `laz` | built-in decoder | A LAZ decompressor of your own (see below). |
| `signal` | none | `AbortSignal`. |

LAZ files (compressed LAS) are recognised by the header's compression bit and open as they are: the decoder below loads
the first time a compressed file arrives, so a plain LAS file never pays for it. `options.laz` replaces it with a
function of your own that returns the uncompressed point records (`LazDecoder`). `writeLAS` writes uncompressed LAS
1.0 to 1.5 (extra bytes, WKT or EPSG, points by return always filled in) for tools and tests. An EPSG code alone is
GeoTIFF, which LAS allows only for formats 0 to 5 before 1.5; formats 6 to 10 and LAS 1.5 take the CRS as `wkt`.

```ts
import { parseLAS, writeLAS } from 'margoengine/points/las';

const bytes = writeLAS({ positions: [0, 0, 0, 1, 2, 3], versionMinor: 5, wkt: 'GEOGCS["WGS 84"]' });
const copy = await parseLAS(bytes);
console.log(copy.header.versionMinor, copy.header.pointsByReturn[0], copy.crs?.wkt);
```

Formats 4, 5, 9 and 10 carry wave packets: `las.wavePackets` holds the descriptor, offset, size, location and direction
of each point. `lasWaveDescriptors(records)` reads the descriptors, and `lasWaveform(las, index, source)` reads one
point's samples, from the file itself or from the `.wdp` file beside it, as `raw`, `volts` and `spacing` in picoseconds.
It returns `undefined` for a point with no wave.

```ts
import { lasWaveDescriptors, lasWaveform, loadLAS } from 'margoengine/points/las';

const scan = await loadLAS('/scans/fullwave.laz');
const samples = new Uint8Array(await (await fetch('/scans/fullwave.wdp')).arrayBuffer());
const wave = lasWaveform(scan, 0, samples);
console.log(lasWaveDescriptors(scan.records).size, wave?.raw.length, wave?.volts[0], wave?.spacing);
```

## LAZ decoder (`margoengine/points/laz`)

`parseLAS` and `loadLAS` use `createLazDecoder()` by default. It decodes one chunk at a time straight into the point
arrays, so the uncompressed file is never held in memory, and `signal` stops it between chunks.
`lazChunks(bytes, header, records, {signal})` is the same decoder as an async iterator of uncompressed record blocks, one
per chunk, for streaming tools; `lazInfo(records)` reads the LASzip record (compressor, chunk size, items).

```ts
import { loadLAS } from 'margoengine/points/las';

const controller = new AbortController();
const scan = await loadLAS('/scans/site.laz', { stride: 4, signal: controller.signal });
console.log(scan.count, scan.header.pointFormat, scan.gpsTime?.[0], scan.rgb?.length);
```

| Point formats | LASzip items read |
| --- | --- |
| 0 to 3 | POINT10, GPSTIME11, RGB12 and extra bytes (BYTE), version 2, pointwise chunks |
| 4, 5 | The same, with WAVEPACKET13 version 1 |
| 6 to 8 | POINT14, RGB14, RGBNIR14 and extra bytes (BYTE14), version 3, layered chunks with per-scanner-channel contexts |
| 9, 10 | The same, with WAVEPACKET14 version 3 |

Compressors 0 (plain records), 1 (one stream, no chunk table), 2 and 3 are read, in fixed and variable chunks, with a
chunk table whose offset was written at the end of the file. Anything else throws a `MargoError` with code `unsupported`
that names it: item version 1, the coding of LASzip 1.0, which neither the LAZ specification 1.4 nor the LASzip paper
describes; coders other than arithmetic; compressors above 3; chunk table versions other than 0. Corrupt data throws a
`RangeError` or `TypeError` that names the chunk; every read stays inside its chunk. The chunk table sits after the
points, so a cut-short LAZ file cannot be read, even with `partial`. A LAS 1.4 compatibility mode file reads as stored.

Verification: the decoder was written clean room from the LASzip paper and the LAZ specification. `tests/laz-real.test.js`
holds what LASzip and lazrs decode from real files, as digests, and every record and field matches in every point
format: public files of formats 0 to 3, 7, 8 and 10 (`tests/fixtures/NOTICE.md`), the real USGS 3DEP tile of format 6
(`tests/laz-usgs.test.js`), and real points LASzip compressed for formats 4, 5 and 9 and for channels that switch. The
reference decoders are not part of the repository. Compressor 0, compressor 1 with version 2 items and chunk size 0 are
checked only against the test encoder, a stand-in, because no tool here writes them.

## E57 scans (`margoengine/points/e57`)

`parseE57(bytes)` reads ASTM E57 files from terrestrial scanners: the 1024-byte pages (each CRC-32C checked), the XML
section, and every `data3D` scan's compressed vector (bitPack codec: Float, ScaledInteger and Integer fields packed into
bytestreams across data packets). Cartesian or spherical coordinates, each scan's pose (quaternion and translation),
`cartesianInvalidState` / `sphericalInvalidState` (invalid points dropped unless `keepInvalid`), intensity normalised by
`intensityLimits`, colour by `colorLimits`, and any other field (return index, time stamp, row and column) by name.
All scans land in one world frame, float32 relative to `origin`.

```ts
import { Engine } from 'margoengine/core';
import { PointCloud, PointsPlugin } from 'margoengine/points';
import { loadE57 } from 'margoengine/points/e57';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
const e57 = await loadE57('/scans/plant-room.e57');
for (const scan of e57.scans) {
  const positions = new Float32Array(scan.count * 3);
  for (let i = 0; i < scan.count; i++) // z-up scan to y-up world
    positions.set([scan.positions[i * 3], scan.positions[i * 3 + 2], -scan.positions[i * 3 + 1]], i * 3);
  points.add(new PointCloud({ positions, colors: scan.colors, colorComponents: 4 }));
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `origin` | centre of all scans | World point positions are stored relative to. |
| `verifyChecksums` | `true` | Check every page's CRC-32C (a failure is a `RangeError` naming the page). |
| `keepInvalid` | `false` | Keep points flagged invalid. |
| `signal` | none | `AbortSignal`. |

Codecs other than bitPack, String and Blob prototype fields, and `images2D` are not read (codes `unsupported` or
skipped). `writeE57` writes double, scaled-integer or spherical scans with intensity, colour, pose and invalid flags,
for tools and round-trip tests.

## Large clouds: octree level of detail (`margoengine/points/octree`)

`buildOctree(cloud)` splits a cloud into a nested-sample octree: each node keeps one point per cell of a 128-cell grid
over its cube (in a seeded shuffle, so the sample is even), and its eight children hold the rest; every point lands in
exactly one node. `OctreeCloud` draws the nodes the camera needs, largest on screen first, under `pointBudget`, loads
them from any `OctreeSource` (the built octree, or your own that fetches nodes from a server) and frees the least
recently used past `maxLoadedPoints`. Refinement is additive, so a parent's points stay drawn under its children and
nothing ever leaves a hole.

```ts
import { Engine } from 'margoengine/core';
import { PointsPlugin } from 'margoengine/points';
import { OctreeCloud, buildOctree } from 'margoengine/points/octree';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine, { pointBudget: 3_000_000 });
const positions = new Float32Array(3_000_000).map(() => Math.random() * 100);
const octree = buildOctree({ positions }, { maxPointsPerNode: 20_000 });
OctreeCloud.attach(engine, points, octree, { pointBudget: 1_000_000, material: { size: 2, edl: true } });
```

| `OctreeCloud` option | Default | Meaning |
| --- | --- | --- |
| `pointBudget` | 2,000,000 | Most points drawn per frame. |
| `minNodePixels` | 150 | Refine a node while it spans more than this many pixels. |
| `maxLoadedPoints` | 3 x `pointBudget` | Points kept loaded before eviction. |
| `maxConcurrentLoads` | 4 | Nodes loading at once (the rest wait; unwanted loads are aborted). |
| `material` | defaults | `PointsMaterial` or its options, shared by every node (`octreeCloud.material`). |
| `cloud` | defaults | `PointCloud` options of every node. |
| `adaptiveSize` | `false` | Grow points to fill the gaps left by subsampled nodes; `true` or `{scale}`. |

### Placing an octree in a scene

An `OctreeCloud` has a `matrix`, or follows a mesh with `attach(mesh)`, including the mesh's visibility. Culling, level of detail and point sizes all work through the transform, and `points.pick` answers in world positions, so a scan can be placed, rotated and animated like any object.

```ts
import { Engine } from 'margoengine/core';
import { PointsPlugin } from 'margoengine/points';
import { OctreeCloud, buildOctree } from 'margoengine/points/octree';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine);
const positions = new Float32Array(300_000).map(() => Math.random() * 10);
const scan = OctreeCloud.attach(engine, points, buildOctree({ positions }));
scan.matrix[12] = 20; // move it 20 units along x; takes effect next frame

const turntable = engine.createMesh();
scan.attach(turntable); // or follow a mesh
turntable.setPosition([0, 1, 0]);
```

All nodes share the matrix, so moving a scan writes nothing but 16 floats. Node choice runs before the frame's update, so it lags a moving transform by one frame while the points themselves do not. `select` takes the camera in world coordinates.

A failing node is reported to `onError(listener)` (or `engine.onError`) and skipped until `retry()`.

### Adaptive point size

Far parts of a scan draw only coarse nodes, so fixed-size points leave holes. With `adaptiveSize`, each point gets a
world-unit diameter of `scale` (default 1.5) times the spacing around it. The spacing comes from the density of every
drawn node at that spot: the node and its parents, and the drawn children the point falls in. A node's density is its
sample grid, or its point count over its cube's face when it holds fewer points than the grid. So a point shrinks as
children load around it and stays large in the octants that have none, and a change of level never leaves a hole.

```ts
import { Engine } from 'margoengine/core';
import { PointsPlugin } from 'margoengine/points';
import { OctreeCloud, buildOctree } from 'margoengine/points/octree';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine, { pointBudget: 500_000 });
const positions = new Float32Array(3_000_000).map(() => Math.random() * 100);
OctreeCloud.attach(engine, points, buildOctree({ positions }), {
  pointBudget: 500_000,
  adaptiveSize: { scale: 1.5 },
  material: { size: 2, shape: 'round' }, // 2 px stays the smallest a point draws
});
```

The material is changed to world units with `size` 1 and each point carries its own size. A pixel `size` becomes the
`minPixelSize`, a world `size` the smallest world diameter, and `maxPixelSize` (default 256) still caps the growth.
Sizes are rewritten on the CPU only for nodes whose drawn children changed, at most 500,000 points a selection.

## COPC files (`margoengine/points/copc`)

A Cloud Optimized Point Cloud is a LAZ 1.4 file that a viewer reads in pieces. `CopcSource.open` reads the header and every hierarchy page by HTTP range requests, then `OctreeCloud` fetches each node's chunk when it is shown:

```ts
import { EngineKernel } from 'margoengine/core';
import { PointsPlugin } from 'margoengine/points';
import { OctreeCloud } from 'margoengine/points/octree';
import { CopcSource } from 'margoengine/points/copc';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, { backend: 'webgpu' });
const source = await CopcSource.open('/scan.copc.laz'); // options: fetch, signal
OctreeCloud.attach(engine, PointsPlugin.attach(engine, { pointBudget: 2_000_000 }), source, { pointBudget: 2_000_000 });
```

Positions and bounds are relative to `source.origin`, the cube's centre, which keeps float32 positions exact for a scan far from zero. Reads only: there is no COPC writer. It reads point formats 6 to 8, as the specification requires. Tested against files written here from the public specification with the package's own test encoder, not yet against files from another tool.

## GPU picking (`margoengine/points/pick`)

`points.pick` runs on the CPU, so meshes do not block it and clipping planes do not cut it. `PointPicking` adds a `PointsPlugin` to `Picking` from `margoengine/selection`: one `picking.pick` or `engine.pick` then answers whichever of points and meshes is nearest at the pixel. A point behind a mesh is not hit, a part cut by a clipping plane is not hit, and `pickMany` works too.

```ts
import { Engine, box } from 'margoengine/core';
import { PointCloud, PointsPlugin } from 'margoengine/points';
import { PointPicking } from 'margoengine/points/pick';
import { Picking } from 'margoengine/selection';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const points = PointsPlugin.attach(engine);
const scan = points.add(new PointCloud({ positions: [0, 0, 0, 1, 0, 0], material: { size: 8 } }));
engine.createMesh().setGeometry(box());

const picking = Picking.attach(engine);
PointPicking.attach(picking, points);

canvas.addEventListener('pointerdown', async (event) => {
  const hit = await picking.pick(event.offsetX, event.offsetY);
  if (hit?.cloud === scan) console.log('point', hit.point, 'at', hit.position);
  else if (hit) console.log('mesh', hit.mesh);
});
```

- `hit.cloud`, `hit.point` and `hit.position` name the point. `hit.mesh` is the mesh the cloud follows, or else an empty mesh made for that cloud, which draws nothing and which `cloudOf` maps back; stand-ins go with their cloud or with `dispose()`. Attach `PointsPlugin` to the engine first.
- A point hits where it shows: its shape, map, `alphaTest` and clipping planes apply, and fully transparent points such as a hidden class do not hit. A sphere impostor hits at its curved depth. Like every pick, the 3 x 3 tile also finds a neighbouring pixel when the exact one is empty.
- Only points drawn in the view's latest frame pick, at their level of detail and transform, so an `OctreeCloud` picks through its nodes on screen. It answers the nearest thing only. Sprites and `SurfelPlugin` clouds do not pick.
- Clouds at most 268,435,456 points in all per pick. While an overlay is registered, each pick draws every drawn point of that view again, with no culling to the pixel.

## Potree folders (`margoengine/points/potree`)

Potree is the most common format for scans published on the web. `PotreeSource.open` reads a folder's metadata and whole hierarchy, then `OctreeCloud` fetches each node when it is shown. Pass the folder, or its `metadata.json` or `cloud.js`.

```ts
import { Engine } from 'margoengine/core';
import { PointsPlugin } from 'margoengine/points';
import { OctreeCloud } from 'margoengine/points/octree';
import { PotreeSource } from 'margoengine/points/potree';
const engine = await Engine.create(document.querySelector('canvas')!);
const points = PointsPlugin.attach(engine, { pointBudget: 2_000_000 });
const source = await PotreeSource.open('/scans/site/'); // options below
OctreeCloud.attach(engine, points, source, { pointBudget: 2_000_000, adaptiveSize: true });
engine.camera.position = [0, 50, 200]; // positions are relative to source.origin, the centre of the box
console.log(source.version, source.points, source.origin);
```

| Version | Files | Read |
| --- | --- | --- |
| 2.0 | `metadata.json`, `hierarchy.bin`, `octree.bin` | Range requests. Encodings `DEFAULT` and `BROTLI`. |
| 1.5 to 1.8 | `cloud.js`, `.hrc`, one `.bin`, `.las` or `.laz` per node | Whole files per node. |
| 1.4 | `cloud.js` with the hierarchy inside, one `.bin`, `.las` or `.laz` per node in one folder | Whole files per node. |

Everything a folder needs loads by itself, only when a folder needs it: `parseLAS` for LAS and LAZ nodes, and `decodeBrotli` of `@margoengine/decoders/brotli` for `BROTLI` folders. A folder of binary nodes pays for neither.

| Option | Default | What it does |
| --- | --- | --- |
| `fetch`, `signal` | `globalThis.fetch`, none | The fetch used for every request; cancels the reads of `open`. |
| `hierarchy` | `'lazy'` | `'lazy'` reads the first hierarchy page at open and each further page when `load` reaches its node, so a very deep folder opens with one request. `'eager'` reads every page at open. `source.expand(node)` reads one page by hand. |
| `attributes` | `['intensity', 'classification']` | Which attributes `load` gives back in `attributes`, or `'all'`. Names are lower case joined by `_`, so `return_number`, `gps_time`. |
| `colorBy` | `'rgb'` | `'classification'` colours through `classificationColors`, `'intensity'` through `rampColors` over the range the folder states. |
| `parseLAS`, `laz`, `brotli` | loaded when met | Replace the LAS reader, LAZ decoder or Brotli decoder. |

```ts
import { PotreeSource } from 'margoengine/points/potree';

const source = await PotreeSource.open('/scans/site/', { attributes: 'all', colorBy: 'classification' });
const { positions, attributes } = await source.load(source.root, new AbortController().signal);
console.log(positions.length / 3, attributes?.classification, attributes?.gps_time);
```

A 1.7 hierarchy file lists leaves with 0 points in real folders, so a leaf's `count` comes from its file once `load` has read it. Other encodings and versions before 1.4 throw a `MargoError` with code `unsupported`. The reader is checked on real PotreeConverter output: see `tests/potree-check.mjs`.

The runnable README uses the complete published `lion_takanawa_normals` Potree 1.7
folder (BSD-2-Clause; provenance in `tests/fixtures/NOTICE.md`), served as `/scans/site/`.
From a clone, run `node scripts/fetch-readme-assets.mjs` to acquire its 80 pinned files
in the shared external cache. Serve that folder intact, including `cloud.js` and all
relative `data/` files. The package test requires it and checks every coordinate and
RGB value of all 341,989 points across 77 nodes against their raw records. This
establishes complete-file reading, not surveyed accuracy or production rendering quality.

## Surfels (`margoengine/points/surfels`)

`SurfelPlugin` draws clouds as small blended discs, so a scan reads as one continuous surface instead of overlapping dots. It runs three passes: every disc writes depth pushed back a little, discs within that push of the front add colour and weight into a float target, and a full-screen pass divides one by the other and draws it over the scene. The weight is Gaussian across the disc and falls with depth behind the front surface, so a wall does not bleed through the floor in front of it. Discs share the scene's depth, so meshes and surfels hide each other.

```ts
import { Engine } from 'margoengine/core';
import { PointCloud } from 'margoengine/points';
import { SurfelPlugin } from 'margoengine/points/surfels';
const engine = await Engine.create(document.querySelector('canvas')!);
const surfels = SurfelPlugin.attach(engine, { pointBudget: 2_000_000, overlap: 2 });
const positions = new Float32Array(300_000).map(() => Math.random() * 10);
surfels.add(new PointCloud({ positions, material: { size: 0.1, sizeUnits: 'world', color: '#c0a080' } }));
```

| `SurfelPlugin` option | Default | Meaning |
| --- | --- | --- |
| `pointBudget` | 1,000,000 | Most points drawn per frame, shared as in `PointsPlugin`. |
| `overlap` | 1.5 | Disc diameter as a multiple of the point's size. Discs must overlap to blend. |
| `blendDepth` | 1 | Depth behind the front surface that still blends, as a multiple of the disc's radius. |
| `order`, `name` | 10, `'surfels'` | As `PointsPlugin`. |

Pass `normals` on the cloud and each disc lies flat on its surface; without them discs face the camera. For large scans give `OctreeCloud` this plugin in place of `PointsPlugin`, with `adaptiveSize` so each disc fits the spacing around it: `OctreeCloud.attach(engine, surfels, source, {adaptiveSize: {scale: 2}})`.

`setFog` works as on `PointsPlugin`, a disc taking the fog at its centre. A cloud belongs to one plugin. From `PointsMaterial` a surfel reads `color`, `size`, `sizeUnits`, `minPixelSize`, `maxPixelSize`, `vertexColors`, `alphaTest` (a point's alpha also weighs it, so alpha 0 hides it), `fog`, `clippingPlanes` and `clipIntersection`. Surfels are opaque and always test and write depth: `opacity`, `transparent`, `blending`, `map`, `shape`, `shading`, `edl`, `depthTest` and `depthWrite` have no effect. `PointsPlugin.pick` does not see them. It costs two draws of every point plus a full-screen pass, and its extra targets take about 100 MB at 1920 x 1080 with 4x MSAA.

## Colours and measures

`classificationColors(classes, {palette, hidden})` colours by ASPRS class (`ASPRS_CLASSES` names them; hidden classes
get alpha 0). `rampColors(values, {min, max, gamma, stops})` maps intensity, height or any attribute through a ramp
(1st to 99th percentile by default; `ELEVATION_STOPS` is a blue-to-red ramp). `rgb16ToRgba8` turns 16-bit scanner RGB
into bytes (and keeps 8-bit values stored in 16-bit fields). With `points.pick` hits, `measurePointDistance`, `measurePath`,
`measureArea` (planar polygon), `measureHeight` (along +y) and `measureAngle` (degrees) give the usual survey measures.

## Limits

- Requires native WebGPU or the full WebGL2 compatibility layer. The small preview throws linked `unsupported` during setup.
- Each per-point buffer of a cloud must fit one storage binding, so the widest bounds it: 12-byte positions (and surfel normals) give `maxStorageBufferBindingSize / 12` points (11,184,810 at the default 128 MiB limit); `colorFormat: 'float'` colours take 16 bytes, so 8,388,608. A bigger cloud throws a `RangeError` naming its ceiling before any buffer is made. Split bigger clouds into several `PointCloud`s, or keep RGBA8 colours.
- `points.pick` is CPU-side over the points drawn in the latest frame; meshes do not occlude it, and clipping planes do not apply to it. `PointPicking` does both on the GPU, but answers later, through a promise.
- Block bounds only grow on updates; call `rebuild()` to tighten them or to include points that turned finite. Non-finite points are never drawn. A `reorder`ed cloud cannot be rebuilt.
- Per-point colors are stored as RGBA8 by default, so HDR vertex colors are clamped to 0..1; `colorFormat: 'float'` keeps them, at four times the color memory. A float color must be finite and 0 or more.
- A `GPUTexture` you pass is created on a device the plugin does not own: after a device loss the material draws untextured (with a one-time warning) until you assign a new texture. Uploaded image sources are rebuilt automatically.
- Transparent points and sprites are not sorted per point. Use `alphaTest` or additive blending for order-independent results. Round antialiased edges of opaque points write depth.
- A plain `PointCloud` does not grow its points when the budget subsamples its blocks; `OctreeCloud` does with `adaptiveSize`. `OctreeCloud` streams nodes from any `OctreeSource`, but the package has no on-disk octree format of its own; it reads COPC and Potree.

## Tests

`npm test` in `packages/points` runs Node checks: chunking (coverage, block sizes, bounds, determinism, non-finite points) on random data and the real PCL `bunny.pcd` scan, even subsampling of shuffled prefixes, bounds growth, frustum culling against core `Camera.planes` with a randomized no-false-negative check, screen area, budget water-filling invariants, projection and picking against brute force, orthographic screen area and picking, color packing, ranges, atlas cells, `PointCloud` and `SpriteBatch` bookkeeping, materials, SSR safety and the linked WebGL2 preview refusal.

The LAZ tests (`tests/laz.test.js`) compress random, survey-like and mixed points of formats 0 to 10 with
the test-only encoder (`tests/laz-encoder.js`) in fixed and variable chunks, check that decoding returns every record
byte for byte (`tests/laz-usgs.test.js` runs the real USGS tile through the same decoder and checks it against the file's header) and that `parseLAS` with the decoder matches the uncompressed file, and fuzz truncated and corrupt
files (only coded errors, no hang). `tests/laz-real.test.js` reads the real files in `tests/fixtures/laz` against LASzip and lazrs.

`npm run test:browser` (a real-GPU script, not in CI) renders with a real engine in Chromium (or Edge via `BROWSER_CHANNEL`): exact square coverage at 2 to 16 px, round coverage within 4% of the disc area with empty corners, per-point byte and float colors, depth against a core mesh and between points, attachment to a mesh, size attenuation, a 2,000,000 point cloud culled and drawn within a 500,000 point budget, subrange updates that issue exactly one `writeBuffer` per changed range, sprites that stay square after an orbit with the right atlas cell, rotation, pivot and pixel size, 5000 sprites in one draw call, textured points with alpha test, sphere shading, eye-dome lighting, CPU picking, an orthographic camera (world sizes equal at two depths, sphere impostor depth against a box, EDL at a depth step, nearer-point picking), zero WebGPU validation errors, device restore and dispose. It saves `test-results/points-gallery.png` and `test-results/points-browser.json`.

Apache-2.0 licensed.

## Preview tier contract

The small `@margoengine/webgl2-compat/preview` renderer reports `backend: 'webgl2'` and has no GPU device. GPU-only attachments throw a linked `MargoError` with code `unsupported` before allocating resources. Native WebGPU and the full WebGL2 compatibility layer both report `backend: 'webgpu'`. Use [`autoEngine` with `loadCompat`](../webgl2-compat/README.md#automatic-escalation) during scene setup to select a complete tier automatically.

The renderer now refuses the preview during setup, allowing automatic escalation instead of accepting an attachment that cannot draw.

### Shared CPU projection

`projectToPixels` delegates to `@margoengine/math/mat4` `projectPoint` with
WebGPU reversed-Z depth. Width and height are device pixels. It returns false
for a point behind the camera or outside normalized depth 0..1 (including NaN)
and leaves `out` unchanged. Offscreen x/y still project for radius picking.
The third output is clip w in perspective and normalized near-to-far depth for
orthographic matrices. The call is synchronous and reuses internal scratch.

```js
import { projectToPixels } from '@margoengine/points';
const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const screen = new Float64Array(3);
if (projectToPixels(matrix, 0, 0, 0.5, 640, 480, screen)) {
  console.log(screen); // Float64Array [320, 240, 0.5]
}
```
