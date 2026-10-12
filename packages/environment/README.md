# @margoengine/environment

HDR and EXR loading, GPU image-based lighting (prefiltered specular, spherical-harmonic irradiance, BRDF LUT) and environment backgrounds for Margo Engine on WebGPU.

Build from source with `npm run build` in `packages/environment`.

Replaces Three.js `RGBELoader`, `EXRLoader`, `PMREMGenerator`, `scene.environment` and `scene.background` (with `backgroundIntensity`, `backgroundRotation` and `backgroundBlurriness`).

```ts
import {Engine} from '@margoengine/core';
import {Environment, EnvironmentBackground, loadEnvironmentImage} from '@margoengine/environment';

const canvas = document.createElement('canvas');
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const image = await loadEnvironmentImage('/studio.hdr'); // .hdr or .exr, picked by signature
const environment = await Environment.create(engine, image, {rotation: 0.5});
engine.use(environment);                                       // rebuilds itself after a device loss
engine.use(new EnvironmentBackground(environment, {exposure: 1, blur: 0}));
engine.start();

// A PBR package binds environment.specularView, sampler, brdfLutView, shBuffer and paramsBuffer (see below).
// On teardown: engine.dispose() disposes both plugins.
```

The parsers also work on their own, in the browser or Node:

```ts
import {parseHDR, parseEXR} from '@margoengine/environment';
const bytes = await (await fetch('/studio.exr')).arrayBuffer();
const {width, height, data} = parseEXR(bytes); // data: Float32Array RGBA, row 0 at the top
```

## How it works

- **Parsers.** `parseHDR` reads Radiance `32-bit_rle_rgbe` files with adaptive run-length, flat and old-style run scanlines, in `-Y h +X w` or `+Y h +X w` orientation. `parseEXR` reads single-part scanline OpenEXR with NONE, RLE, ZIPS, ZIP and PIZ compression and HALF, FLOAT or UINT channels, using R, G, B and A, or Y for luminance-only files. ZIP uses a built-in synchronous inflate; PIZ is the full Huffman, wavelet and LUT pipeline. Both return linear float RGBA (alpha 1 when absent) and bounds-check every read: truncated or corrupt files throw an `Error`, never read out of range. Images are capped at 2^26 pixels.
- **Source cube.** The equirect is uploaded as rgba16float (values clamped to 65504, NaN and negatives to 0), or as rgba32float when the device has `float32-filterable` enabled, since only then can float32 be filtered. A compute pass resamples it into an rgba16float cube (with up to 4x4 supersampling when the equirect is much larger than the cube), followed by a box-filtered mip chain down to 1x1. Six `CubeFaces` can be passed instead.
- **Specular prefilter.** Mip `m` of the specular cube is the GGX-prefiltered source for roughness `m / (specularMips - 1)`, with N = V = R (Karis split sum). Each importance sample reads the source mip whose texel solid angle matches the sample's solid angle (filtered importance sampling), so small bright sources do not produce fireflies at 256 samples. Mip 0 is the unblurred source. This runs as a fragment pass per face and mip.
- **Irradiance.** A single 64-thread compute workgroup projects the cube (the mip of at most `shSize` texels) onto the nine real L2 spherical harmonics with exact per-texel solid angles. The result is read back once, so `environment.sh` is also available on the CPU.
- **BRDF LUT.** A compute pass integrates the split-sum scale and bias with the same GGX distribution and separable Smith-GGX visibility as core's direct lighting.
- **Background.** A full-screen triangle at reversed-Z depth 0 with a read-only `greater-equal` depth test runs after core's main pass (order 1), so it only touches pixels whose depth still holds the cleared 0 and never covers geometry. It samples the equirect (sharpest), the source cube, or a prefiltered mip when `blur > 0`. Output matches core's shader: `c / (1 + c)` Reinhard then the exact sRGB encode into the canvas format; when the pass target is rgba16float (for example creative's `PostProcessing` HDR capture) it writes linear radiance instead. Steady frames allocate nothing.
- **Device loss.** The CPU source is kept by default. As a plugin (or through the background plugin) the environment rebuilds on the new device in `onDeviceRestored`; `version` increments and `onChange` listeners fire, so consumers can rebuild bind groups. Nothing touches `window`, `document`, `navigator` or GPU globals at import time.

## What an IBL shader needs

Five bindings, any group and binding numbers. `iblLayoutEntries(firstBinding)` and `iblBindGroupEntries(environment, firstBinding)` build them, and `IBL_WGSL` provides the functions below.

| Binding | WGSL type | Resource | Format |
| --- | --- | --- | --- |
| specular | `texture_cube<f32>` | `environment.specularView` | rgba16float, `specularMips` mips (filterable float) |
| sampler | `sampler` (filtering) | `environment.sampler` | trilinear, clamp-to-edge |
| BRDF LUT | `texture_2d<f32>` | `environment.brdfLutView` | rgba16float, r = scale, g = bias |
| SH | `var<uniform> array<vec4f, 9>` | `environment.shBuffer`, offset 0, size 144 | 9 x vec4f, rgb used |
| params | `var<uniform> vec4f` | `environment.paramsBuffer` | (cos rotation, sin rotation, specularMips - 1, intensity) |

- **Rotation.** The environment is rotated by `rotation` radians about +Y. Rotate every world lookup vector `d` with `iblRotate(d, params)`: `(c * d.x - s * d.z, d.y, s * d.x + c * d.z)` with `c, s = params.x, params.y`.
- **Roughness to mip.** `lod = clamp(perceptualRoughness, 0, 1) * (specularMips - 1)`, that is `roughness * params.z`, sampled with `textureSampleLevel(specular, sampler, iblRotate(reflect(-v, n), params), lod)`. Roughness is perceptual; GGX alpha is roughness squared, as in core.
- **BRDF LUT.** Sample at `uv = (NdotV, perceptualRoughness)` (texel centers hold `(i + 0.5) / size`). Split-sum specular is `prefiltered * (F0 * lut.r + lut.g)`.
- **SH irradiance.** The uniform holds diffuse-ready coefficients `c_k` (irradiance divided by PI), so for a unit rotated normal `n`:

  `diffuse = albedo * max(0, sum_k c_k * Y_k(n))`

  with `Y_0 = 0.282094792`, `Y_1 = 0.488602512 n.y`, `Y_2 = 0.488602512 n.z`, `Y_3 = 0.488602512 n.x`, `Y_4 = 1.092548431 n.x n.y`, `Y_5 = 1.092548431 n.y n.z`, `Y_6 = 0.315391565 (3 n.z^2 - 1)`, `Y_7 = 1.092548431 n.x n.z`, `Y_8 = 0.546274215 (n.x^2 - n.y^2)`. The plain radiance projection `L_k` is at byte offset 256 of the same buffer (and in `environment.sh.radiance`); `c_k = L_k * A_l / PI` with `A_l / PI = 1, 2/3, 1/4` for bands 0, 1, 2.
- **Combined.** `iblShade(specular, sampler, brdf, sh, params, n, v, baseColor, metalness, roughness)` returns `(diffuse * (1 - F) * (1 - metalness) + prefiltered * F) * intensity` with `F = F0 * lut.r + lut.g` and `F0 = mix(0.04, baseColor, metalness)`. It outputs linear radiance; tone map like core.
- **Conventions.** Cube layers are +X, -X, +Y, -Y, +Z, -Z (WebGPU). Equirect `u = 0.5 + atan2(d.x, -d.z) / 2PI` (image center faces -Z), `v = acos(d.y) / PI` (row 0 is +Y).

## Options

`Environment.create(engineOrDevice, source, options)`:

| Option | Default |
| --- | --- |
| `size` | Source cube edge (power of two). Equirect width / 4 rounded down to a power of two, clamped to 16..1024. Cube faces: their size |
| `specularSize` | `min(256, size)` |
| `specularMips` | Down to 8 px, at least 2 (256 gives 6 mips) |
| `samples` | 256 GGX samples per prefiltered texel |
| `brdfSize`, `brdfSamples` | 128, 512 |
| `shSize` | 64 (largest source mip integrated for SH) |
| `float32` | true: upload the equirect as rgba32float when `float32-filterable` is enabled |
| `keepEquirect` | true: keep the equirect texture for the sharp background |
| `keepSource` | true: keep CPU data so device restore can rebuild |
| `rotation`, `intensity` | 0 radians, 1 (also settable later) |
| `name` | `'environment'` (plugin name) |

`new EnvironmentBackground(environment, options)` (also exported as `Skybox`):

| Option | Default |
| --- | --- |
| `exposure` | 1, linear multiplier before tone mapping |
| `blur` | 0; 0..1 picks the prefiltered mip for that roughness |
| `source` | `'auto'`: equirect if kept, else cube. `'equirect'` or `'cube'` force one when `blur` is 0 |
| `rotation` | 0, added to `environment.rotation` |
| `order` | 1, frame graph order (must be above 0) |
| `name` | `'environment:background'` |

`EnvironmentBackground.record(context)` draws into any WebGPU pass context without an engine.

## Limits

WebGPU only: `EnvironmentBackground.setup` throws on the WebGL2 backend and `Environment.create` needs a device. EXR tiled, multi-part, deep and subsampled (chroma) images and PXR24, B44, B44A, DWAA, DWAB and HTJ2K compression are rejected with an error, as are Radiance `xyze` files and mirrored or transposed orientations. Huffman codes longer than 44 bits are rejected (OpenEXR writers do not produce them for normal images). `EXPOSURE` and `GAMMA` headers are reported, not applied. Equirects larger than the device's texture limit are box-downsampled on the CPU. The diffuse term is L2 SH (no ringing suppression), and the split sum ignores multiple scattering. Source and specular sizes must be powers of two.

Two portability measures are deliberate: the specular prefilter samples the cube in a fragment pass (cube sampling with explicit LOD in compute shaders returned wrong seam texels on SwiftShader), and the WGSL avoids `atan2(-0.0, x)` (SwiftShader returns PI).

## Tests

`npm test` in `packages/environment` runs Node checks: every binary16 value round trip; 20 EXR fixtures written by the reference OpenEXR library (NONE, RLE, ZIPS, ZIP and PIZ, each with HALF RGBA, FLOAT RGB, HALF Y and a mixed HALF/FLOAT/UINT layout) decoding bit-exactly; an independent in-test EXR writer (including raw-fallback chunks, decreasing Y and stored, fixed and dynamic deflate blocks); real files `BrightRings.exr` (ZIP) and `AllHalfValues.exr` (PIZ, every half value) from the OpenEXR test images and `spot1Lux.hdr` from the Three.js examples, matched against reference digests; HDR adaptive, flat and old-style runs in both orientations; truncation and random-corruption fuzzing; CPU SH; and SSR safety.

`npm run test:browser` runs Chromium WebGPU checks (set `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS` as in the repository brief): a constant environment gives constant values at every prefiltered mip and L0-only SH; a single bright direction gives SH matching both a CPU projection and the analytic delta projection, with no fireflies in the prefiltered mips; prefiltered mip 0 equals the source; the cube follows the documented face convention; GPU SH matches a CPU projection of the same cube texels; six `CubeFaces` give the same SH as the equirect; the BRDF LUT matches brute-force quadrature, the smooth-surface analytic limit and Karis's published mobile fit; the background renders the expected color in each direction (equirect, cube, rotation, exposure, blur, HDR and tone-mapped targets) and never draws over non-cleared depth; `IBL_WGSL` compiles against `iblLayoutEntries` and passes a white furnace test; a real `.hdr` goes through the whole pipeline; and in a real engine the background leaves every pixel of a core mesh untouched, matches core's tone mapping elsewhere, allocates nothing in steady frames and comes back after `engine.rebootDevice()`. Every check runs under WebGPU error scopes with zero validation errors. `tests/fixtures/generate.py` regenerates the synthetic fixtures (`pip install OpenEXR numpy`).

MIT licensed. Test fixtures: see `tests/fixtures/NOTICE.md`.
