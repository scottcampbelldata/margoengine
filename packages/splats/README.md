# @margoengine/splats

Install `npm i margoengine` and import `margoengine/splats` (or this package alone: `npm i @margoengine/splats`, imported as `@margoengine/splats`; the two are the same module).

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

Base GPU allocations are approximately 128 bytes per splat (384 MB at three million), plus small histograms/uniforms and optional SH. CPU copies for recovery are additional. Center-depth sorting approximates intersecting ellipsoids; near-plane-crossing centers are culled. Multiple clouds sort independently: combine overlapping clouds into one data set when global order matters. Splats do not write opaque depth, cast directional shadows or receive PBR lighting. They can render alongside shadows, clustered meshes, animation, VFX and TAA; temporal history uses underlying opaque depth. Frame rate and sorting time depend on hardware and fill rate, with no 1-2 ms or locked-60-FPS guarantee.

`cloud.setFog(fog)` fogs the cloud with `@margoengine/environment`'s `Fog` or any object with its fields (`color`, `near`, `far`, `density`, `heightFalloff`, `height`, `enabled`), read every frame with Fog's maths. Each splat's colour fades toward the fog colour by the fog at its centre, in the projection pass and in linear before the display encoding; opacity is unchanged. The package does not import environment. `fog.enabled = false` clears it without recompiling; `cloud.setFog(null)` (the default) draws exactly as before.

```ts
import type {EngineKernel} from 'margoengine/core';
import {Fog} from 'margoengine/environment';
import type {Splats} from 'margoengine/splats';
declare const engine: EngineKernel, cloud: Splats; // from the first example
cloud.setFog(Fog.attach(engine, {color: '#8090a0', density: 0.02}));
```

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
- **`encodeSplat(data)`** writes the 32-byte `.splat` layout `parseSplat` reads, splitting each covariance into axis scales and a rotation (`decomposeCovariance`, Jacobi). `.splat` has no SH, so the base colour is kept; a round trip is exact to byte precision.
- **`cropSplats(data, {box: {min, max}} | {sphere: {center, radius}}, {invert})`** keeps the splats whose centres are inside (or outside) the region; **`filterSplats(data, keep)`** keeps those `keep(index)` accepts. SH travels with the kept splats.
- **`transformSplats(data, matrix)`** applies a column-major 4x4 affine matrix: centres by the matrix, covariances by its linear part (scale and shear stretch the splats), and SH by the matrix's rotation (from its polar decomposition, by an exact least-squares fit per SH band), so view-dependent colour turns with the cloud.
- **`mergeSplats(...clouds)`** concatenates clouds with the same SH degree. **`decimateSplats(data, {cellSize})`** merges the splats of each grid cell into one Gaussian with the same weighted mean and second moment (weights: opacity times volume); colour, opacity and SH are the weighted means. It is a moment-matched preview level, not a trained one.
- **`parseSpz(bytes, {signal})`** reads SPZ versions 2, 3 and 4 (24-bit fixed-point positions, byte log-scales, byte colours, 3-byte or smallest-three rotations, SH degrees 0-3). Versions 2 and 3 are one gzip stream and need `DecompressionStream` (current browsers, Node 18+). Version 4, the default of current exporters such as PlayCanvas splat-transform, is a plain header, a table of contents and one Zstandard stream per attribute; it is read by a built-in Zstandard decoder (RFC 8878: Huffman and FSE, repeat offsets, content checksums, several and skippable frames), which loads only when a version 4 file arrives. Each stream is limited to the size the table of contents declares. Damaged, truncated or checksum-failing files throw a `RangeError` saying to check the file; a stream that needs a Zstandard dictionary throws a `MargoError` with code `unsupported`.
- **`parseSog(bytes | files, {signal})`** reads SOG version 2, bundled (`.sog` ZIP) or as loose files (`meta.json` plus its lossless WebP textures; a built-in decoder, no image API needed). It needs `DecompressionStream` for deflated ZIP entries; lossy SOG textures throw a `MargoError` with code `unsupported`.
- Both return a promise and honour an `AbortSignal`. They are tested against real captures (`test/fixtures/NOTICE.md`): SPZ version 2 and SOG bit for bit against the PlayCanvas splat-transform decode, SPZ version 4 bit for bit against version 3 of the same scene.

```ts
import {parseSog, parseSpz} from 'margoengine/splats/data';

const abort = new AbortController();
// Any SPZ version: 2 and 3 (gzip) or 4 (Zstandard), detected from the file.
const spz = await parseSpz(await (await fetch('/capture.spz')).arrayBuffer(), {signal: abort.signal});
const sog = await parseSog(await (await fetch('/capture.sog')).arrayBuffer());
console.log(spz.positions.length / 3, sog.positions.length / 3);
```

`gpuState` exposes sorted key/index pairs, projected ellipses and evaluated colors (fogged while a fog is set) for diagnostics. Ellipse records are eight floats: normalized center xyz and opacity, then two normalized-screen ellipse axes. `dispose()`/`destroy()` releases all owned GPU resources. Device restoration reuploads the copied input and recreates sorting/rendering passes. The package stays outside core/stage and has no dependencies on other optional renderers; parser-only imports discard GPU code. It follows the workspace's `@margoengine/*` naming convention.
