# @margoengine/splats

Import `margoengine/splats` from the `margoengine` package, or `@margoengine/splats` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Use `@margoengine/splats/data` for `parseSplat`, `validateSplats` and the
`SplatData` type without loading GPU rendering or radix-sort shaders. Root
exports retain the same functions for applications that also render splats.

Optional WebGPU Gaussian rendering that accepts 1-3,000,000 world-space splats (an input cap, not a frame-rate promise: adapter storage/memory limits may allow fewer, and frame time at the cap depends on the GPU). Compute projects each positive-definite 3D covariance through the camera Jacobian into a 2D ellipse with a 0.3-pixel variance floor. Instanced quads cover three standard deviations; the fragment shader evaluates Gaussian opacity and blends far to near against read-only reversed scene depth.

```ts
import {EngineKernel} from 'margoengine/core';
import {Splats,parseSplat} from 'margoengine/splats';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const response = await fetch('/capture.splat');
if (!response.ok) throw new Error('Failed to load splats: '+response.status);
const cloud = Splats.attach(engine, parseSplat(await response.arrayBuffer()));
engine.start();
// cloud.dispose() when unloading; engine.dispose() releases attached plugins.
```

For generated data, supply `SplatData`: `positions` has three Float32 values per splat; `covariances` has six (xx, xy, xz, yy, yz, zz); `colors` has four (linear RGB and opacity, each 0..1). Construction validates lengths, finite values and positive-definite covariance, then copies the data for ownership/device recovery. Colors are converted to sRGB for ordinary display targets and remain linear in HDR targets.

Optional `sphericalHarmonics` contains 4, 9 or 16 coefficients per splat, with RGB interleaved for each coefficient. Evaluation uses the real SH basis through degree 3, the camera-to-splat direction, and the usual 0.5 offset. SH replaces RGB; `colors` still supplies opacity. Large SH buffers can exceed an adapter's storage binding limit even when the base cloud fits; attachment rejects before allocating. `parseSplat()` decodes the common 32-byte binary layout (xyz, positive xyz scales, byte RGBA, byte quaternion in wxyz order), converts byte sRGB to linear, normalizes quaternions and derives covariance. `parsePly()` reads Gaussian-splat PLY files (below); `parseSpz()` and `parseSog()` read compressed captures (below); training is outside this package.

Orthographic cameras (any `camera.matrix` with a constant clip w, such as `CameraProjection` from `@margoengine/cameras`) use the affine Jacobian: a splat's pixel size depends only on the zoom, not its depth. The depth range is the projection's own near/far, which may lie behind the eye, sort keys are measured from the near plane, and spherical harmonics use the fixed viewing direction. The package reads only the clip matrix and does not depend on the cameras package.

Each frame creates sortable unsigned depth keys on the GPU. Eight stable 4-bit LSD radix passes run per-workgroup histograms, hierarchical exclusive prefix scans, a scan of block totals, and scatter. Workgroup bit masks and population counts preserve input order within equal digits; equal-depth splats retain source order. Off-frustum, transparent and out-of-range centers sort to the end and render no fragments. The runtime performs no CPU sorting, per-splat frame allocation or GPU readback.

Base GPU allocations are approximately 128 bytes per splat (384 MB at three million), plus small histograms/uniforms and optional SH. CPU copies for recovery are additional. Center-depth sorting approximates intersecting ellipsoids; near-plane-crossing centers are culled. Multiple clouds sort independently: combine overlapping clouds into one data set when global order matters. Splats do not write depth unless `./depth` is attached (below), cast directional shadows or receive PBR lighting. They can render alongside shadows, clustered meshes, animation, VFX and TAA; temporal history uses underlying opaque depth. Frame rate and sorting time depend on hardware and fill rate, with no 1-2 ms or locked-60-FPS guarantee.

`cloud.setFog(fog)` fogs the cloud with `@margoengine/environment`'s `Fog` or any object with its fields (`color`, `near`, `far`, `density`, `heightFalloff`, `height`, `enabled`), read every frame with Fog's maths. Each splat's colour fades toward the fog colour by the fog at its centre, in the projection pass and in linear before the display encoding; opacity is unchanged. The package does not import environment. `fog.enabled = false` clears it without recompiling; `cloud.setFog(null)` (the default) draws exactly as before.

```ts
import {Fog} from 'margoengine/environment';
import {Splats, parseSplat} from 'margoengine/splats';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const cloud = Splats.attach(engine, parseSplat(await (await fetch('/capture.splat')).arrayBuffer()));
cloud.setFog(Fog.attach(engine, {color: '#8090a0', density: 0.02}));
```

## With glass

The cloud sorts against itself and blends over the scene, so glass in front of it comes out wrong. `addEffect` from
[`margoengine/oit/vfx`](../oit/README.md#particles-splats-and-points-addeffect) draws it in the same pass as the glass:

```ts
import {Engine} from 'margoengine/core';
import {ExactOIT} from 'margoengine/oit/exact';
import {addEffect} from 'margoengine/oit/vfx';
import {Splats} from 'margoengine/splats';
const engine = await Engine.create(document.querySelector('canvas')!);
const cloud = Splats.attach(engine, {
  positions: new Float32Array([0, 0, -1]),
  covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1]),
  colors: new Float32Array([0.2, 0.6, 1, 0.8]),
});
addEffect(ExactOIT.attach(engine, {layers: 32}), cloud);
```

The depth sort stops while it is in the pass, and `ExactOIT` keeps only the nearest `layers` per pixel, so a dense capture
looks thinner than its own draw. Leave a capture on its own draw unless glass must cut through it.

## PLY captures, editing and level of detail (`./data`)

```ts
import {EngineKernel} from 'margoengine/core';
import {Splats} from 'margoengine/splats';
import {cropSplats, decimateSplats, encodeSplat, mergeSplats, parsePly, transformSplats} from 'margoengine/splats/data';

const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const response = await fetch('/capture.ply'); // a trained Gaussian-splat PLY
if (!response.ok) throw new Error('Failed to load splats: ' + response.status);
let cloud = parsePly(await response.arrayBuffer());
// Training frames are often Y-down: turn 180 degrees about X to stand the capture up in Margo's Y-up world.
cloud = transformSplats(cloud, [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
cloud = cropSplats(cloud, {sphere: {center: [0, 0, 0], radius: 5}}); // drop floaters far from the subject
const preview = decimateSplats(cloud, {cellSize: 0.05}); // a coarser cloud for a distant view
const both = mergeSplats(cloud, transformSplats(cloud, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1]));
const saved = new Blob([encodeSplat(cloud)]); // back to .splat, for parseSplat or other viewers
Splats.attach(engine, preview);
engine.start();
console.log(both.positions.length / 3, saved.size);
```

- **`parsePly(bytes)`** reads the PLY layout Gaussian-splat training writes (`binary_little_endian` or `ascii`, one `vertex` element with `x y z`, `f_dc_0..2`, optional `f_rest_*` for SH degrees 1-3, `opacity` as a logit, `scale_0..2` as logs and `rot_0..3` as w x y z). Opacity goes through the sigmoid, scales through exp, rotation and scale become the covariance. These files store display (sRGB) colour; the base colour is converted to linear exactly and the view-dependent terms to first order around it, since the renderer works in linear. Coordinates are kept as stored. Big-endian and packed (chunked) PLY files throw a `MargoError` with code `unsupported`; files without the splat properties throw a `RangeError` naming what is missing.
- **`splatsFromAttributes(raw, {linear})`** turns attributes as training stores them (`GaussianAttributes`: positions, log scales, w x y z rotations, band-0 and higher SH, opacity) into `SplatData`, for readers of other containers (`@margoengine/gltf-pro/splats` uses it). `linear: true` is for colour stored linear, in place of display colour. Every reader goes through it, so a splat flatter than Float32 can store keeps an axis at 1/1024 of its longest, or a whole file of real captures would be refused; projection adds 0.3 px^2 to each ellipse, so the lift never shows.
- **`encodeSplat(data)`** writes the 32-byte `.splat` layout `parseSplat` reads, splitting each covariance into axis scales and a rotation (`decomposeCovariance`, Jacobi). `.splat` has no SH, so the base colour is kept; a round trip is exact to byte precision.
- **`cropSplats(data, {box: {min, max}} | {sphere: {center, radius}}, {invert})`** keeps the splats whose centres are inside (or outside) the region; **`filterSplats(data, keep)`** keeps those `keep(index)` accepts. SH travels with the kept splats.
- **`transformSplats(data, matrix)`** applies a column-major 4x4 affine matrix: centres by the matrix, covariances by its linear part (scale and shear stretch the splats), and SH by the matrix's rotation (from its polar decomposition, by an exact least-squares fit per SH band), so view-dependent colour turns with the cloud.
- **`mergeSplats(...clouds)`** concatenates clouds with the same SH degree. **`decimateSplats(data, {cellSize})`** merges the splats of each grid cell into one Gaussian with the same weighted mean and second moment (weights: opacity times volume); colour, opacity and SH are the weighted means. It is a moment-matched preview level, not a trained one.
- **`parseSpz(bytes, {signal})`** reads SPZ versions 2, 3 and 4 (24-bit fixed-point positions, byte log-scales, byte colours, 3-byte or smallest-three rotations, SH degrees 0-3). Versions 2 and 3 are one gzip stream and need `DecompressionStream` (current browsers, Node 18+). Version 4, the default of current exporters such as PlayCanvas splat-transform, is a plain header, a table of contents and one Zstandard stream per attribute; it is read by a built-in Zstandard decoder (RFC 8878: Huffman and FSE, repeat offsets, content checksums, several and skippable frames), which loads only when a version 4 file arrives. Each stream is limited to the size the table of contents declares. Damaged, truncated or checksum-failing files throw a `RangeError` saying to check the file; a stream that needs a Zstandard dictionary throws a `MargoError` with code `unsupported`.
- **`parseSog(bytes | files, {signal})`** reads SOG version 2, bundled (`.sog` ZIP) or as loose files (`meta.json` plus its lossless WebP textures; `@margoengine/decoders/webp-lossless` bundled in, no image API needed). It needs `DecompressionStream` for deflated ZIP entries; lossy SOG textures throw a `MargoError` with code `unsupported`.
- Both return a promise and honour an `AbortSignal`. They are tested against real captures (`test/fixtures/NOTICE.md`): SPZ version 2 and SOG bit for bit against the PlayCanvas splat-transform decode, SPZ version 4 bit for bit against version 3 of the same scene.

```ts
import {parseSog, parseSpz} from 'margoengine/splats/data';

const abort = new AbortController();
// Any SPZ version: 2 and 3 (gzip) or 4 (Zstandard), detected from the file.
const spz = await parseSpz(await (await fetch('/capture.spz')).arrayBuffer(), {signal: abort.signal});
const sog = await parseSog(await (await fetch('/capture.sog')).arrayBuffer());
console.log(spz.positions.length / 3, sog.positions.length / 3);
```

## Compressed export (`./data`)

`encodeSpz` and `encodeSog` write a cloud as SPZ (version 3) or a bundled SOG (version 2), so an edited capture ships
small; `encodeSplat` writes the 32-byte `.splat` layout:

```ts
import {encodeSog, encodeSpz, parsePly, parseSpz} from 'margoengine/splats/data';

const cloud = parsePly(await (await fetch('/raccoon-v2.ply')).arrayBuffer());
const spz = await encodeSpz(cloud); // gzip, about a tenth of the PLY
const sog = await encodeSog(cloud); // ZIP of meta.json and lossless WebP textures
const back = await parseSpz(spz); // the cloud up to SPZ's quantisation
console.log(spz.length, sog.length, back.positions.length / 3);
```

- Both start from the stored attributes: axis scales and rotation from each covariance (eigen-decomposition), display
  (sRGB) colour from linear, exactly for the base band and to first order for the view-dependent terms.
- SPZ: positions are 24-bit fixed point with the most fractional bits that fit the largest coordinate (up to 16;
  `fractionalBits` to choose), opacity, colour and log scale one byte each, rotations the smallest-three 10-bit
  packing, spherical harmonics one byte per coefficient. Version 3 is written (gzip), which version 3 and 4 readers
  read.
- SOG: positions are 16-bit after a log transform within the cloud's bounds, log scales and base colours 256-entry
  codebooks (1D k-means), rotations three bytes, opacity a byte. Spherical-harmonic bands use a palette of up to
  65,536 entries: each splat's own when the cloud has at most 65,536 splats, else the means of equal groups along the
  bands' principal axis, which blurs view-dependent colour on large clouds. The WebP textures are lossless, written by
  a built-in encoder whose images Margo's decoder and the browser's (`createImageBitmap`) read back exactly.
- From a `Splats` cloud edited on the GPU, export `await cloud.read()` (or `await brush.commit()`).

`gpuState` exposes sorted key/index pairs, projected ellipses and evaluated colors (fogged while a fog is set) for diagnostics. Ellipse records are eight floats: normalized center xyz and opacity, then two normalized-screen ellipse axes. `dispose()`/`destroy()` releases all owned GPU resources. Device restoration reuploads the copied input and recreates sorting/rendering passes. The package stays outside core/stage and has no dependencies on other optional renderers; parser-only imports discard GPU code. It follows the workspace's `@margoengine/*` naming convention.

## Depth with meshes (`./depth`)

Meshes drawn before a cloud (every `@margoengine/materials` mesh) already hide the splats behind them: the cloud depth
tests against the scene. What draws after the cloud (later passes, other clouds, points, particles, post effects that
read depth) cannot see it, because splats blend and write no depth. `SplatDepth` writes it:

```ts
import {Engine} from 'margoengine/core';
import {Splats} from 'margoengine/splats';
import {SplatDepth} from 'margoengine/splats/depth';
const engine = await Engine.create(document.querySelector('canvas')!);
const cloud = Splats.attach(engine, {
  positions: new Float32Array([0, 0, 0]),
  covariances: new Float32Array([0.25, 0, 0, 0.25, 0, 0.01]),
  colors: new Float32Array([1, 0, 0, 0.95]),
});
const depth = SplatDepth.attach(engine, cloud, {threshold: 0.5});
depth.threshold = 0.3; // live: lower writes more of a thin capture
```

- Right after the cloud draws (frame-graph order 3.5, option `order`), each splat writes the scene depth where its own
  Gaussian opacity at the pixel reaches `threshold` (default 0.5; the colour pass caps opacity at 0.99, so 1 writes
  nothing). The nearest such splat wins (reversed Z). No colour is written, and the cloud draws exactly as before.
- It is alpha-tested depth, not accumulated: a pixel where many faint splats add up to a solid look, each under the
  threshold, gets no depth. On the real raccoon capture (test fixture) threshold 0.5 gave depth to 1,514 of the 4,463
  pixels the capture covers; lower it for thin captures.
- Depth is the splat's centre depth over its whole ellipse, as the colour pass places it.
- `dispose()` stops the writes; a cloud that is not attached, or is disposed, writes nothing.

## Streamed level of detail (`./lod`)

For captures larger than one cloud takes (3,000,000 splats) or than a GPU should draw at once, `./lod` draws a cut of a
splat hierarchy chosen by the view, loading only the nodes the cut needs:

```ts
import {Engine} from 'margoengine/core';
import {parsePly} from 'margoengine/splats/data';
import {SplatLod, buildSplatLod} from 'margoengine/splats/lod';
const engine = await Engine.create(document.querySelector('canvas')!);
const capture = parsePly(await (await fetch('/raccoon-v2.ply')).arrayBuffer());
const lod = SplatLod.attach(engine, buildSplatLod(capture, {leafSize: 1024}), {budget: 1_000_000, maxError: 2});
engine.start();
await lod.settled(); // the current view is fully streamed in
console.log(lod.selected.length, lod.drawn);
```

- `buildSplatLod(data, {leafSize})` splits the capture into an octree until a cell holds at most `leafSize` splats
  (default 65,536); leaves keep the trained splats untouched, and each inner cell gets a moment-matched merge of its
  splats (`decimateSplats`) on the coarsest grid that still fits `leafSize`, with that grid cell as its `error`.
- A streamed capture is any `SplatLodSource`: `{nodes, coefficients, load(index, signal)}`, each node a bounding sphere,
  an `error` in world units (0 for a leaf), its `count` and `children`. `load` may fetch the node (for instance a
  `.splat` from `encodeSplat`, one file per node) and must return `count` splats with `coefficients` SH.
- Each frame, before the splats project, `chooseSplatNodes` replaces the node of largest projected error
  (`error x focal / distance`, pixels) by its children while that error exceeds `maxError` (default 2), all its children
  are loaded and the cut fits `budget` (default 1,000,000). Children it lacks are loaded, at most `concurrency` (4) at
  a time; until they arrive the parent stays, so streaming never leaves a hole.
- Drawn nodes live in fixed slots of one `Splats` (`lod.cloud`, `budget` rounded down to whole slots of the largest
  node, and to no more slots than the source has leaves), written with `Splats.write` and hidden with `Splats.clear`, so every drawn node sorts together. Loaded nodes
  stay on the CPU up to `cache` splats (twice the budget), oldest dropped first.
- `Splats.reserve(count, coefficients)` makes such a pool of hidden splats; `write(first, data)` and
  `clear(first, count)` work on any cloud.
- `lod.placement` maps each drawn node to the pool index of its first splat, for picking or editing.
- On the real raccoon fixture (41 nodes of at most 1,024 splats) `maxError: 0` streams in all 8,385
  leaf splats and draws exactly what one plain cloud of the pool's splats draws; against the capture in its own order
  188 of 262,144 channels differ (exact depth ties blend in another order); 400 units away the root alone. A procedural stand-in of 16,777,216 splats (256 leaves of 65,536) streams within a
  2,097,152 budget (1,110,016 drawn, 16 leaves near the camera).

## One sort for many clouds (`./set`)

Separate `Splats` clouds sort and draw one after the other, so where two captures overlap the one drawn last covers the
other whole. A `SplatSet` puts every cloud added to it into ranges of one pooled `Splats`, so all their splats sort and
blend far to near together, as one merged cloud would, while each stays movable and removable on its own:

```ts
import {Engine} from 'margoengine/core';
import {parsePly} from 'margoengine/splats/data';
import {SplatSet} from 'margoengine/splats/set';
const engine = await Engine.create(document.querySelector('canvas')!);
const capture = parsePly(await (await fetch('/raccoon-v2.ply')).arrayBuffer());
// Every member has the set's SH count: this capture's coefficients per channel (0 when it has none).
const coefficients = (capture.sphericalHarmonics?.length ?? 0) / capture.positions.length;
const set = SplatSet.attach(engine, {capacity: 500_000, coefficients});
const first = set.add(capture);
const second = set.add(capture, {matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]});
engine.start();
second.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]); // move it
first.remove(); // its range is free again
```

- `capacity` (1 to 3,000,000, default 1,000,000) is the pool; `coefficients` (0, 4, 9 or 16) the SH count every
  member must have. `add` takes the first free range that holds the cloud and throws a RangeError when none does.
- A member's `setMatrix(matrix)` rewrites its splats from its own data moved by the matrix (`transformSplats`);
  `remove()` hides them and frees the range, merged with free neighbours.
- Every pool splat is projected and sorted each frame, free ranges too (hidden, culled before drawing), so size
  `capacity` to what you add.

## Scene light and shadows (`./lighting`)

`SplatLighting` relights a cloud with the engine's directional light and ambient every frame, and is a
`@margoengine/shadows` source, so the capture casts shadows on meshes:

```ts
import {Engine, box} from 'margoengine/core';
import {Splats} from 'margoengine/splats';
import {parsePly} from 'margoengine/splats/data';
import {SplatLighting} from 'margoengine/splats/lighting';
import {Shadows} from 'margoengine/shadows';
const engine = await Engine.create(document.querySelector('canvas')!);
const ground = engine.createMesh().setGeometry(box()).setScale([20, 0.1, 20]).setPosition([0, -2, 0]);
const cloud = Splats.attach(engine, parsePly(await (await fetch('/raccoon-v2.ply')).arrayBuffer()));
const lit = SplatLighting.attach(engine, cloud);
const shadows = Shadows.attach(engine);
shadows.add(ground, {static: true});
shadows.add(lit); // the splats cast on the ground
engine.lighting.direction.set([0.6, 1, 0.2, 3]); // toward the sun, w intensity
engine.start();
```

- Relighting scales each splat's colour by core's diffuse terms: `nl * radiance * intensity / pi + radiance.w *
  ambient`, with `nl` from the splat's flat axis (the axis of its smallest covariance eigenvalue, turned to the
  camera; the view direction for a round splat). `relight: false` (live) keeps the captured colours and still casts.
- The captured colours already hold the light they were filmed in, so a relit capture is lit twice; it reads best
  under soft capture light. Splats do not receive shadows, and the light has no specular term.
- Shadows: each splat draws its ellipse in the light's view (with the colour pass's 0.3 px^2 dilation in shadow-map
  texels). By default a splat blocks each texel with the probability of its opacity there (stochastic transparency),
  so overlapping splats shade as their combined opacity, noisy per texel and smoothed by the shadow filter;
  `threshold` (0 to 1, live) instead blocks where one splat's opacity reaches it, without noise.

## Animated splats (`./animate`)

`SplatSequence` plays a 4D capture (a list of frames of the same splats); `SplatSkin` poses a cloud with a skeleton
by linear blend skinning, for captured performances:

```ts
import {Engine} from 'margoengine/core';
import {Splats} from 'margoengine/splats';
import {parsePly, transformSplats} from 'margoengine/splats/data';
import {SplatSequence, SplatSkin} from 'margoengine/splats/animate';
const engine = await Engine.create(document.querySelector('canvas')!);
const first = parsePly(await (await fetch('/raccoon-v2.ply')).arrayBuffer());
const frames = [0, 1, 2, 3].map((k) => transformSplats(first, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, k * 0.1, 0, 1]));
const performer = Splats.attach(engine, first);
const sequence = SplatSequence.attach(engine, performer, frames, {fps: 12});
sequence.speed = 0.5; // live: time, speed, playing, loop
const n = first.positions.length / 3;
const second = Splats.attach(engine, first);
const skin = SplatSkin.attach(engine, second, {
  joints: 2,
  indices: Array.from({length: n * 4}, (_, i) => (i % 4 === 0 ? (first.positions[(i / 4) * 3 + 1] > 0 ? 1 : 0) : 0)),
  weights: Array.from({length: n * 4}, (_, i) => (i % 4 === 0 ? 1 : 0)),
});
skin.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1], 16); // joint 1: move the top half 0.5 along x
engine.start();
console.log(sequence.duration, (await second.read()).positions.length);
```

- Both run one compute pass before the cloud projects and write its GPU inputs, so sorting, `./depth`,
  `./lighting` and `./edit` see the pose; `cloud.read()` returns the posed cloud.
- A sequence mixes centres, covariances, colours and opacity of the two frames around `time` linearly (a mix of
  positive-definite covariances stays positive definite); SH stays the cloud's. Every frame lives on the GPU, 64 bytes
  per splat, so a long capture at 3,000,000 splats does not fit: stream frames into a few sequences instead.
- A skin moves each centre by the weighted sum of up to four joint matrices and each covariance by the blend's linear
  part, A S A^T; weights are normalised, all zero keeps a splat at rest. The rest pose is the cloud as it is when first
  posed, or after `rebind()` (call it after `Splats.write`). Like any linear blend skin, a blend of two far-turned
  joints shrinks the splats between them. Colours and SH are not turned with the joints.

## Picking and brush editing (`./edit`)

`SplatBrush` picks, selects, erases and paints splats on the GPU, for clean-up tools. Regions are in pixels of the
frame the cloud last drew (`brush.frame`), from the top-left corner:

```ts
import {Engine} from 'margoengine/core';
import {Splats} from 'margoengine/splats';
import {parsePly} from 'margoengine/splats/data';
import {SplatBrush} from 'margoengine/splats/edit';
const engine = await Engine.create(document.querySelector('canvas')!);
const cloud = Splats.attach(engine, parsePly(await (await fetch('/raccoon-v2.ply')).arrayBuffer()));
const brush = SplatBrush.attach(engine, cloud);
engine.render({delta: 0}); // the brush works on a drawn frame
const [width, height] = brush.frame;
const hit = await brush.pick(width / 2, height / 2); // the nearest splat at the pixel, or -1
brush.select({x: width / 2, y: height / 2, radius: 30}); // replace the selection
brush.select({x: 0, y: 0, width: 40, height: 40}, 'add'); // or 'subtract'
brush.erase('selection'); // opacity 0, as Splats.clear
brush.paint({x: width / 4, y: height / 2, radius: 20}, [0.8, 0.1, 0.1], 0.5); // linear RGB, strength
const edited = await brush.commit(); // the edited cloud as SplatData, for export
console.log(hit, (await brush.selection()).length, edited.colors.length);
engine.start();
```

- One compute dispatch per operation over every splat, against the ellipses the cloud projected for the last
  frame: a splat is in a region when its projected centre is and it was drawn. Picking takes the nearest splat whose
  own opacity at the pixel (its Gaussian falloff times its opacity) reaches `threshold` (default 0.1).
- Edits change the cloud's GPU buffers at once and show from the next frame. `commit()` (`cloud.read()`) copies them
  into the cloud's data, which `Splats.write`, export and device restoration use: a device loss before a commit
  drops the edits since the last one.
- Painting blends the colour by `strength` and keeps opacity; on a cloud with spherical harmonics it sets the DC term
  to the blended colour and fades the higher bands by the same strength.
- The selection lives on the GPU (4 bytes per splat); `selection()` reads it back as indices. A restored device
  starts with an empty selection.
