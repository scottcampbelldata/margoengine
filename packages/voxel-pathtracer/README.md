# @margoengine/voxel-pathtracer

A progressive WebGPU path tracer for voxel models. Attach it to an engine and, while it is enabled, the frame shows a
path-traced image of your voxel scene through the engine camera, refining every frame until a sample budget. It also
renders off-screen PNGs and float images of any size, and answers ray picks against the same scene.

Optional and tree-shakable: `@margoengine/core` and the `margoengine` stage never import it. It needs the WebGPU backend
(`MargoError` `unsupported` otherwise) and has no runtime dependency besides `@margoengine/math`.

Written clean-room from public rendering literature (see [How it works](#how-it-works)). It reproduces the kinds of
materials, lights and camera effects voxel editors offer; it does not claim to reproduce any other renderer's private
equations or images.

```ts
import { VoxelPathTracer, type VoxelTraceScene } from '@margoengine/voxel-pathtracer';

const scene: VoxelTraceScene = {
  revision: 1,
  models: [{ id: 'house', revision: 1, size: [32, 24, 32], voxels }], // voxels: Uint8Array of palette indices
  instances: [{ id: 'house-1', modelId: 'house', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -16, 0, -16, 1] }],
  materials: [
    { id: 1, color: [0.8, 0.75, 0.7], type: 'diffuse' },
    { id: 2, color: [0.9, 1, 0.95], type: 'glass', ior: 1.5 },
    { id: 3, color: [1, 0.6, 0.3], type: 'emit', emission: 5 },
  ],
  environment: { skyColor: [0.6, 0.75, 1], sunIntensity: 3, sunDirection: [0.4, 0.8, 0.3], groundColor: [0.4, 0.4, 0.4] },
};
const tracer = VoxelPathTracer.attach(engine, { scene, maxSamples: 512, denoise: true });
await tracer.ready; // until then frames show the ordinary raster image
tracer.setScene(nextScene); // validated as a whole; accumulation restarts
const png = await tracer.capture({ width: 3840, height: 2160, samples: 1024, signal });
tracer.enabled = false; // back to the raster frame, bit for bit
tracer.dispose();
```

## Scene data

Everything is in Margo's **Y-up** world. Convert MagicaVoxel's Z-up `.vox` data at your boundary.

- **Models** are dense arrays of palette indices (`Uint8Array`, 0 empty, 1-255 occupied), sizes 1-256 per axis, indexed
  `x + size[0] * (z + size[2] * y)` (x fastest, then z, then y). In model space voxel `(x, y, z)` fills the unit cube
  from `(x, y, z)` to `(x + 1, y + 1, z + 1)`, so the model spans `[0, size]`. Put pivots in the instance matrix.
- **Instances** place a model with a column-major model-to-world `matrix` (16 finite numbers, affine, invertible:
  translation, rotation, non-uniform scale, shear and mirroring all work). Any number of instances share one model's
  data; each keeps its id (`raycast`, AOVs). `visible: false` hides one.
- **Materials** are keyed by palette index. Every index any model uses needs one.
- **Revisions.** `setScene` packs each model into 8^3 bricks and uploads it. A model whose `id`, `revision` and `size`
  equal the previous scene's is reused without reading `voxels` again: bump `revision` whenever voxels change. Only
  changed models are re-uploaded; the others keep their GPU memory.

`setScene` validates the whole scene and builds the new snapshot before anything changes: on any error the current scene,
its uploads and its accumulated image stay. Caller arrays are read, never kept or modified.

| Problem | Error |
| --- | --- |
| Wrong shapes: not an object/array, duplicate model/instance/material/light ids, a `modelId` naming no model, `voxels` not a `Uint8Array` or of the wrong length, a matrix that is not 16 numbers, a palette index without a material | `TypeError` (message names the field and the fix) |
| Out of range: sizes, non-finite or singular or non-affine matrices, material values, environment values, a scene over the device's storage limits (see [Limits](#limits)) | `RangeError` |
| Used after `dispose()` | `MargoError` `disposed` |

## Materials

Every surface type is one physically based model whose lobes are mixed by weight; the type picks defaults. All fields
except `id`, `color` and `type` are optional.

| Type | Lobes | Defaults |
| --- | --- | --- |
| `diffuse` | Lambert | roughness 0.2, specular 0 |
| `plastic` | Lambert under a dielectric GGX coat (Fresnel from `ior`, scaled by `specular`) | roughness 0.2, specular 1, ior 1.5 |
| `metal` | GGX conductor, Schlick Fresnel with F0 = `color`; plastic for the rest when `metalness` < 1 | metalness 1, roughness 0.2 |
| `glass` | Smooth or GGX-rough dielectric with exact Fresnel and refraction | transmission 1, roughness 0, ior 1.5, density 0 |
| `emit` | Lambert plus emitted radiance `color * emission` | emission 1, specular 0 |
| `blend` | metal (`metalness`) + glass (`(1 - metalness) * transmission`) + plastic (the rest) | roughness 0.2, specular 1 |
| `media` | Index-matched homogeneous participating medium (cloud, fog, smoke): extinction `density` per world unit, single-scattering albedo `color`, Henyey-Greenstein `anisotropy` | density 1, anisotropy 0 |

- `color` is linear RGB. Reflectance and albedo use it clamped to 1; emission `color * emission` is not clamped.
- Any surface type may emit (`emission > 0`). Emissive voxels are lights: every exposed emissive face is sampled.
- Roughness below about 0.03 is perfectly specular. Roughness is perceptual: the GGX alpha is `roughness^2`.
- Glass: `color` tints light entering the volume; `density` adds Beer-Lambert absorption toward `color` per world unit
  (`color^(density * distance)`); `scatter` (addition) adds interior scattering per world unit, a random-walk subsurface
  look; `anisotropy` shapes that scattering. Adjacent voxels of the same glass index form one volume (no inner faces).
- Media voxels of one index form one volume; light entering it is attenuated and scattered, and next-event estimation
  works from inside it (shadow rays are attenuated through media, blocked by anything else).

## Lighting

| Light | How | Notes |
| --- | --- | --- |
| Sky | `skyColor * skyIntensity`, constant radiance from every direction | Reached by scattered paths. Default white, intensity 1. |
| Sun | `sunColor * sunIntensity` is the **irradiance** on a surface facing it, whatever its size; `sunAngularSize` (radians) softens shadows and shows a disk | Sampled directly (next-event estimation) and by paths, combined by multiple importance sampling. Default intensity 0 (off), size 0.0093. |
| Ground | `groundColor` adds an infinite diffuse plane at `groundHeight` | Casts and receives like any surface. |
| Environment map (addition) | `environment.map`: equirectangular linear RGB(A) floats, `intensity`, `rotation` about +Y | Replaces the constant sky; importance sampled by luminance x sin(theta). Its centre column faces -Z, three quarters +X. |
| Emissive voxels | Any material with `emission > 0` | Faces sampled by emitted power, instances by power x area. |
| Area lights (addition) | `scene.lights`: rectangles `position + s * edgeU + t * edgeV`, radiance `color * intensity`, `twoSided` | Facing `cross(edgeU, edgeV)`. They are seen and reflected, but do not block shadow rays. At most 256. |

## Camera

The engine camera is used as is: perspective by default, orthographic (or any affine/perspective projection) through
`Camera.project`, which core's Camera already exposes. Rays start on the near plane, as rasterised geometry does.

- **Depth of field:** `aperture` is the thin lens diameter in world units, `focusDistance` the distance to the plane in
  focus (default: camera position to target). Addition: `lensBlades` (0 round, 3-16 polygon bokeh) and `lensRotation`.
- **Motion blur (addition):** give an instance `previousMatrix` (shutter open) and set `shutter` (0-1, the share of the
  move from `previousMatrix` to `matrix` the shutter is open for, ending at `matrix`). Matrices are interpolated
  linearly per sample.

## Options

| Option | Default | Range | Restarts accumulation |
| --- | --- | --- | --- |
| `samplesPerFrame` | 1 | 1-64 | no |
| `maxBounces` | 8 | 1-64 (Russian roulette may end paths after 3) | yes |
| `maxSamples` | 1024 | 1+ or `Infinity` | no (raising it continues) |
| `seed` | 0 | integer 0-4294967295 | yes |
| `resolutionScale` | 1 | 0.1-2 | yes |
| `exposure` (EV) | 0 | -20-20 | no |
| `aperture` | 0 | 0+ | yes |
| `focusDistance` | camera to target | above 0 | yes |
| `denoise` | false | boolean | no |
| `lensBlades`, `lensRotation` | 0, 0 | 0 or 3-16; radians | yes |
| `shutter` | 0 | 0-1 | yes |
| `clamp` (largest luminance a path may add; biased firefly control) | Infinity | above 0 | yes |
| `toneMapping` | `'neutral'` (Khronos PBR Neutral, Margo's display transform) | `'neutral'`, `'linear'` | no |
| `order` (frame-graph order of the pass) | 20 | finite | no |

Accumulation also restarts on any change of the camera (matrix, position, target, up, projection), the drawing-buffer
size, the scene (`setScene`), `reset()`, turning `enabled` back on, and a GPU device change. Equal seed, scene, camera and
options give the same image on the same GPU and driver (measured bit-identical on the RTX A6000); other GPUs may differ
by floating-point rounding, which changes individual paths, not the converged image.

## Viewport, readiness, devices, disposal

- The pass (order 20) traces `samplesPerFrame` samples into float32 accumulation buffers, optionally denoises, and
  draws over the frame with exposure and tone mapping, writing each pixel's first-hit depth (so overlays drawn later
  depth-test against the traced image). On an `rgba16float` target (for example under `@margoengine/post` Bloom) it
  writes linear HDR and leaves tone mapping to that pass.
- `enabled = false` leaves ordinary rendering unchanged (measured bit-identical); the tracer then encodes nothing.
- `ready` resolves when the compute pipelines are compiled (they compile in the background from `attach`), rejects with
  the compile error (`status` `'failed'`, `error`), or with `MargoError` `disposed`. A device restore starts a new
  `ready`. Frames before it show the raster image; they never throw.
- Lost devices: after `engine.rebootDevice()` (or the engine's own recovery) everything is rebuilt on the new device
  from the CPU copy of the scene and accumulation restarts (measured: the same converged image again, bit for bit).
- `dispose()` removes the pass and the plugin, destroys every GPU buffer, rejects pending captures and leaves the engine
  working (measured: the raster frame again, bit for bit). Repeated calls are safe. `engine.removePlugin(tracer.name)`
  and `engine.dispose()` dispose it too.
- `stats`: `samples`, `frameMs` (wall clock between traced frames), `gpuBytes`, `converged`, plus `width`, `height`,
  `sceneRevision`.

## Captures, float images and picks

- `capture({width, height, samples, signal?, denoise?})` renders a PNG (8-bit RGB, exposure and tone mapping applied)
  at exactly that size and sample count, from the engine camera with its aspect set to the image's. It renders in
  1024-pixel tiles on separate GPU buffers and private copies of the scene buffers, so it neither disturbs the viewport
  nor sees later `setScene` calls; the viewport pauses tracing meanwhile and keeps its image. Denoised tiles overlap by
  64 pixels so there are no seams. Rows are encoded as they arrive (`CompressionStream`), so a large capture never holds
  its whole raw image. Up to 16384 per side and 67,108,864 pixels.
- `renderImage(options)` (addition) returns the linear float image (3 floats per pixel), and with `aovs: true` the
  first-hit albedo, normal, distance and the instance (index into `scene.instances`) and palette index under each
  pixel centre. `jitter: false` traces pixel centres only. Up to 16,777,216 pixels.
- Both reject with the signal's reason when aborted (checked between GPU submissions, at most 4 in flight), with
  `MargoError` `failed` when the device is lost, with `MargoError` `disposed` when the tracer is disposed meanwhile, and
  with `TypeError`/`RangeError` for invalid options. Jobs run one at a time in call order.
- `raycast(origin, direction, maxDistance?)` (addition) returns the closest visible voxel on the CPU: instance and model
  ids, model-local cell, face normal and the adjacent cell, palette index, distance and world point.

## Limits

| Limit | Value |
| --- | --- |
| Model size | 1-256 per axis |
| Instances | 65,535 |
| Area lights | 256 |
| Voxel data | grids plus 512-byte mixed bricks within the device's `maxStorageBufferBindingSize` (WebGPU default 128 MiB: about 262,000 mixed bricks; uniform bricks cost one word) |
| Environment map | 8192 x 4096, and width x height x 16 bytes within the binding size (4096 x 2048 at the default) |
| Emissive faces | their tables (8 bytes each) within the binding size (about 16 million at the default) |
| Viewport | traced pixels x 16 bytes within the binding size (8.3 million pixels at the default; larger canvases are traced at a lower resolution) |
| Accumulation | float32 sums: refinement is expected to slow past about a million samples per pixel (not measured) |

## Measured performance

RTX A6000 (Ampere), Windows 11, Edge 155 (headless, WebGPU, D3D12), 2026-10-19, from
`tests/browser-check.mjs timing` (GPU time between timestamp queries around the pass, median of 40 frames):

| Scene at 1920 x 1080 | GPU per frame | GPU memory |
| --- | --- | --- |
| Material scene (7 models, glass, metal, emitter, cloud, sun, sky, ground), 1 sample | 5.24 ms | 95 MiB |
| Same, denoised | 8.59 ms | 190 MiB |
| One dense 256^3 model (3,967,601 voxels, terrain), 1 sample | 8.39 ms | 98 MiB |
| Same, 4 samples per frame | 31.98 ms | 98 MiB |

CPU: packing that 256^3 model takes 43-59 ms (attach or a new revision); `setScene` with unchanged revisions 0.2-0.5 ms;
encoding a frame 0.2 ms. A 1500 x 1100, 64-sample denoised PNG capture of the material scene took 0.77-0.88 s.
Numbers on other GPUs are not measured.

## Verification

- `tests/*.test.js` (Node, 29 tests, about 0.6 s; part of `npm run verify`): validation and atomic failure, dense
  indexing, all 255 palette identities, transformed/mirrored/hidden instances, model reuse by revision, voxel traversal
  against a brute-force slab test (2,000 random rays over 5 models whose sizes are not multiples of 8), resets for each
  camera/size/scene/option change, enable/disable, `maxSamples`, the denoiser's passes, upload reuse, disposal, device
  restore and device switch, pass order, PNG encoding with tile placement, AOV mapping, cancellation, pausing, device
  loss during a capture, and the frame uniform's lighting values. A recording fake device stands in for WebGPU.
- `tests/browser-check.mjs` (real WebGPU, run under `scripts/gpu-lock.mjs`) on the RTX A6000:
  - shaders compile with no diagnostics; no WebGPU validation errors anywhere;
  - GPU first hits equal `raycast` on all 19,200 pixels of a scene of rotated, scaled, sheared and mirrored instances,
    perspective and orthographic, distances within 2.6e-6 relative;
  - closed-form checks: furnaces (convex cube in a uniform sky) diffuse 0.5000 and 1.0000, smooth metal, smooth plastic
    and clear glass 1.0000, media 0.9999, subsurface 0.9998, constant environment map 0.4998 (expected 0.5); emission
    3.0000; Beer-Lambert 0.3678 (e^-1 = 0.3679); tinted absorbing glass slab 0.3321 (0.3322 with exact Fresnel);
    sun irradiance, point and disk, 0.5000; two emissive planes 0.6671 (2/3); a large area light 1.0000; shadow through
    an absorbing medium 0.1839 (0.5 e^-1); a non-uniform environment map over a plane within 1% of the texel integral;
  - GGX metal and plastic albedo at 20, 60 and 80 degrees within 0.0006 of a numerical integration of the same model;
  - environment orientation; equal seeds bit-identical;
  - convergence: error against a 16,384-sample reference falls 0.0216, 0.0114, 0.0058, 0.0030 at 16, 64, 256, 1024
    samples (1/sqrt(N)), both projections;
  - denoiser (480 x 300, against the same reference): RMSE of the diffuse scene x2.51 lower at 4 samples, x2.33 at 16,
    x1.99 at 64, x1.51 at 1024, object edges no worse except at 64 samples (8% higher); scenes dominated by small-sun
    caustics through glass gain less (x1.1-1.3);
  - depth of field blurs only out-of-focus edges; motion blur spreads a moving cube over its path;
  - viewport: disabled and disposed frames equal the raster frame bit for bit; a device restore redraws the same
    converged image bit for bit; resize restarts accumulation; Bloom composes with the HDR output;
  - a 1500 x 1100 denoised PNG decodes to that size; a 2048^2 x 4096-sample capture cancels within 0.32 s.

## How it works

- Models are packed into 8^3 bricks (empty, uniform or 512 bytes) and walked with Amanatides and Woo's grid traversal
  ("A Fast Voxel Traversal Algorithm for Ray Tracing", 1987), first over bricks, then over voxels inside mixed bricks;
  instances are found through a bounding volume hierarchy (binned surface-area heuristic) and rays are moved into each
  instance's model space by its inverse transform. The same walk runs on the CPU for `raycast` and the tests.
- Unidirectional path tracing with next-event estimation for the sun, emissive faces, area lights and the environment
  map, combined with BSDF sampling by multiple importance sampling with the power heuristic (Veach, 1997), and Russian
  roulette (structure as in PBRT, Pharr, Jakob and Humphreys).
- GGX / Trowbridge-Reitz microfacets with height-correlated Smith masking (Walter et al. 2007, Heitz 2014), sampled from
  visible normals (Heitz 2018); Schlick's Fresnel for conductors and coats, exact dielectric Fresnel for glass.
- Homogeneous media by free-flight sampling with Beer-Lambert absorption as a path weight, Henyey-Greenstein phase.
- Environment maps importance sampled by marginal and conditional CDFs (PBRT).
- Random numbers: PCG (O'Neill 2014) with Jarzynski and Olano's hash (2020); thin lens by Shirley and Chiu's concentric
  disk mapping; orthonormal bases by Duff et al. (2017).
- Denoising: the edge-avoiding a-trous wavelet filter (Dammertz et al. 2010) on albedo-demodulated radiance, with
  variance-guided luminance stops (Schied et al. 2017) and a plane-distance geometric stop.
- PNG output written from the W3C PNG specification over the platform's zlib `CompressionStream`.

## Parity status and known gaps

Implemented and verified as above: voxel traversal with shared transformed instances; diffuse, plastic, metal, glass,
emissive, blended and media materials; subsurface scattering by random walk; sun, sky, ground, HDR environment maps,
emissive voxels and area lights with next-event estimation; depth of field with round and polygonal apertures;
instance motion blur; perspective and orthographic cameras; progressive accumulation with a stable seed; a denoiser;
PNG and float captures with cancellation; device-loss recovery.

Not done or not verified, stated plainly:

- **No comparison against MagicaVoxel's renderer.** Images were not compared side by side; matching its exact look
  would need its proprietary material and lighting equations, which are not public. Mapping `.vox` render/material
  settings onto these inputs is the editor's job and is approximate.
- **Energy loss on rough surfaces:** single-scattering GGX without multiple-scattering compensation darkens very rough
  metal and glass (measured albedo 0.56 for white metal at roughness 0.8 seen at 20 degrees).
- **Denoiser:** a classical filter, not a learned one; it removes noise in smooth regions (about x2-2.5 lower error at
  4-16 samples) but leaves caustic fireflies and edge pixels mostly as they are.
- **Caustics converge slowly:** small-sun light through glass or off glossy surfaces is found only by path sampling;
  `clamp` trades that noise for bias.
- **Simplifications:** RGB only (no dispersion or spectral effects); refracted radiance is not scaled by the squared
  index ratio; media are homogeneous per palette index with grey extinction and do not emit; area lights do not block
  shadow rays; the ground is a plain diffuse plane; motion blur interpolates matrices linearly (fast rotations shrink a
  little) and moves instances only (no camera motion blur); no panoramic/fisheye projections, lens distortion or
  chromatic aberration; no physical sky model (use an environment map); bloom comes from `@margoengine/post`.
- **Measured only on one machine** (RTX A6000, Edge 155, Windows). Other GPUs, browsers and the editor's own scenes are
  untested.
