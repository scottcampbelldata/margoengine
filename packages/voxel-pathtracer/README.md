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
| `media` | Index-matched homogeneous participating medium (cloud, fog, smoke): extinction `density` per world unit, single-scattering albedo `color`, Henyey-Greenstein `anisotropy`, optional emission per world unit | density 1, anisotropy 0 |

- `color` is linear RGB. Reflectance and albedo use it clamped to 1; emission `color * emission` is not clamped.
- Any surface type may emit (`emission > 0`, colour `emissionColor`, default `color`). Emissive voxels are lights: every
  exposed emissive face is sampled.
- Emissive media (addition): a `media` material with `emission` adds `emission x emissionColor` radiance per world unit
  along every ray through it, attenuated by its own extinction (fire, glowing gas): a ray crossing depth d sees
  `(j / density) (1 - exp(-density d))`. Their light reaches other surfaces only through paths that cross them (they
  are not light-sampled), so a scene lit mainly by glowing media converges slowly.
- Roughness below about 0.03 is perfectly specular. Roughness is perceptual: the GGX alpha is `roughness^2`.
- Rough metal and rough glass keep their energy: metals add Kulla and Conty's multiple-scattering lobe (weighted by the
  average Fresnel, so coloured metals saturate as they should) and rough dielectric interfaces are normalised by their
  directional albedo. A white rough metal or clear rough glass in a white sky is white at every roughness (measured
  within 0.79%). The plastic coat stays single scattering (its rough highlights lose a little energy at grazing angles).
- Glass: `color` tints light entering the volume; `density` adds Beer-Lambert absorption toward `color` per world unit
  (`color^(density * distance)`); `scatter` (addition) adds interior scattering per world unit, a random-walk subsurface
  look; `anisotropy` shapes that scattering. Adjacent voxels of the same glass index form one volume (no inner faces).
  A face of another model that coincides with a glass face (glass resting on a floor) is hit, not skipped.
- Dispersion (addition): `abbe` (Abbe number V_d, 5-200; 0 or absent is none) makes the glass index depend on the
  wavelength by Cauchy's law through `ior` at 587.6 nm, so light splits into colours: about 64 for crown glass, 30-40
  for flint, 20 for a strong effect. A path takes one wavelength (380-780 nm) at its first dispersive glass and carries
  its RGB weight from then on; a white furnace stays white. Dispersive glass adds colour noise and is not light
  sampled through.
- Media voxels of one index form one volume; light entering it is attenuated and scattered, and next-event estimation
  works from inside it (shadow rays are attenuated through media, blocked by anything else).

## Lighting

| Light | How | Notes |
| --- | --- | --- |
| Sky | `skyColor * skyIntensity`, constant radiance from every direction | Reached by scattered paths. Default white, intensity 1. |
| Sun | `sunColor * sunIntensity` is the **irradiance** on a surface facing it, whatever its size; `sunAngularSize` (radians) softens shadows and shows a disk | Sampled directly (next-event estimation) and by paths, combined by multiple importance sampling. Default intensity 0 (off), size 0.0093. |
| Ground | `groundColor` adds an infinite diffuse plane at `groundHeight` | Casts and receives like any surface. |
| Physical sky (addition) | `environment.physicalSky`: `{turbidity (1.7-10, default 3), intensity (radiance per kcd/m^2, default 0.1)}` | Preetham, Shirley and Smits' daylight model for `sunDirection`, baked to a 1024 x 512 map and importance sampled like one; black below the horizon (a sun below it is taken on the horizon). The sun disk stays the `sun*` light. Not together with `map`. |
| Environment map (addition) | `environment.map`: equirectangular linear RGB(A) floats, `intensity`, `rotation` about +Y | Replaces the constant sky; importance sampled by luminance x sin(theta). Its centre column faces -Z, three quarters +X. |
| Emissive voxels | Any material with `emission > 0` | Faces sampled by emitted power, instances by power x area. |
| Area lights (addition) | `scene.lights`: rectangles `position + s * edgeU + t * edgeV`, radiance `color * intensity`, `twoSided`, `opaque` | Facing `cross(edgeU, edgeV)`. Solid panels by default: seen, reflected and casting shadows (from the sun, the sky, emissive voxels and each other); a one-sided light's back is black. `opaque: false` keeps the earlier see-through light (no shadows, no back face). Dark (`intensity` 0) solid panels stay as occluders. At most 256. |

Sun and environment light that reaches a surface through smooth glass or off a mirror is sampled directly too, not only
found by chance: voxel faces are planes, so the shadow ray refracts (exact Fresnel, tint, absorption) and reflects
deterministically. Covered: any number of smooth glass volumes with parallel faces (slabs, windows), seen from outside
or inside; light turned once by up to 8 glass instances whose model has one smooth glass material (the first in scene
order that do not move and have no shear: in through one face and out through another, total internal reflection
included) and by the faces of up to 8 mirror instances (models with smooth metal of `metalness` 1). Other light through
glass (several turns, glass touching glass or media, partial internal reflections) is still found by path sampling;
both are combined by multiple importance sampling, so nothing is counted twice. A shadow ray that has to refract is
walked by the path loop itself; of the candidate directions a surface point has for such walks, one is walked per
point, chosen by weighted reservoir sampling and weighted back (unbiased; candidates a box model makes unlikely are
chosen rarely).

## Camera

The engine camera is used as is: perspective by default, orthographic (or any affine/perspective projection) through
`Camera.project`, which core's Camera already exposes. Rays start on the near plane, as rasterised geometry does.

- **Depth of field:** `aperture` is the thin lens diameter in world units, `focusDistance` the distance to the plane in
  focus (default: camera position to target). Addition: `lensBlades` (0 round, 3-16 polygon bokeh) and `lensRotation`.
- **Motion blur (addition):** give an instance `previousMatrix` (shutter open) and set `shutter` (0-1, the share of the
  move from `previousMatrix` to `matrix` the shutter is open for, ending at `matrix`). Matrices are interpolated
  linearly per sample.
- **Camera motion blur (addition):** `previousCamera` (`{position, target, up?, fov?}`, the pose at shutter open) with
  `shutter` above 0 blurs the camera's own move toward the engine camera (shutter close), sharing the instances' time
  per sample. Projection, near and far are the engine camera's; the corner rays and lens axes are interpolated
  linearly, exact for translations and close for small turns.
- **Panorama and fisheye (addition):** `projection: 'panorama'` renders an equirectangular 360 x 180 degree view around
  the camera position (azimuth across the image, elevation down it, the view direction at the centre, up as the
  camera's). `projection: 'fisheye'` renders a circular fisheye whose circle is the image height, `fisheye.mapping`
  `'equidistant'` (angle proportional to radius) or `'equisolid'` (equal area), `fisheye.fov` up to 360 degrees; pixels
  outside the circle are black. Both ignore the camera's projection and depth of field; overlays drawn later are not
  depth-tested against them (the pass writes far depth).
- **Lens distortion (addition):** `distortion: {k1, k2, p1, p2}` applies Brown-Conrady radial and tangential distortion
  to the camera projection, in coordinates measured from the image centre in half image heights (y up): an undistorted
  point is seen at `x (1 + k1 r^2 + k2 r^4) + 2 p1 x y + p2 (r^2 + 2 x^2)` and likewise for y. Each pixel's ray is found
  by inverting that (fixed-point iteration).

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
| `previousCamera` | none | `{position, target, up?, fov?}` or null | yes |
| `projection` | `'camera'` | `'camera'`, `'panorama'`, `'fisheye'` | yes |
| `fisheye` | `{mapping: 'equidistant', fov: 180}` | mapping `'equidistant'` or `'equisolid'`, fov above 0 to 360 | yes |
| `distortion` | none | `{k1, k2, p1, p2}`, each -1 to 1, or null | yes |
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
  pixel centre. `jitter: false` traces pixel centres only; `wavelength` (380-780 nm) traces dispersive glass at that one
  wavelength with weight 1 (a monochromatic check). Up to 16,777,216 pixels.
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
| Light-sampled glass and mirror instances | 8 of each (others are path sampled) |
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
| Material scene (7 models, glass, metal, emitter, cloud, sun, sky, ground), 1 sample | 12.39 ms | 95 MiB |
| Same, denoised | 19.92 ms | 285 MiB |
| One dense 256^3 model (3,967,601 voxels, terrain), 1 sample | 9.90 ms | 98 MiB |
| Same, 4 samples per frame | 36.96 ms | 98 MiB |

Light sampling through glass and mirrors made a sample dearer than before it (measured the same day on the same
machine: 6.09 ms for the material scene, 8.45 ms for the dense one, 9.11 ms denoised): glass and mirror candidates need
walks, and the larger shader is slower even where there is no glass. Noise per sample fell (two renders' difference at
64 samples, 480 x 300: material scene 0.0347 to 0.0284, caustic scene 0.0484 to 0.0336), which does not make up for the
time in the material scene (about 17% more noise at equal time); the caustic scene's time was not measured. The earlier
version also converged to a wrong image where glass rests on another model (the floor under it was black). The
denoiser's second (caustic) chain doubles its memory.

CPU: packing that 256^3 model takes 43-59 ms (attach or a new revision); `setScene` with unchanged revisions 0.2-0.5 ms;
a new physical sky (other turbidity, intensity or sun direction) bakes in 50-63 ms, an unchanged one 1.4-3.8 ms;
encoding a frame 0.2 ms. A 1500 x 1100, 64-sample denoised PNG capture of the material scene took 1.25-1.38 s.
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
    perspective and orthographic, distances within 2.6e-6 relative; also panorama (12,800 pixels), equisolid 200-degree
    fisheye (16,384) and Brown-Conrady distortion (19,200), all agreeing, distances within 4.4e-6;
  - physical sky against Preetham's formulas (typed again in the page): zenith luminance 0.65255 (0.65250) at
    turbidity 3, sun 40 degrees up, and 0.80458 (0.80453) at turbidity 6, sun 25 degrees, chromaticity equal to 4
    digits; luminance ratios to the zenith in 10 directions (including near the sun) within 0.04%; a diffuse floor under
    the sky alone 0.43842 (0.43857) and 0.47004 (0.47019), 0.5 / pi times the numerically integrated irradiance;
  - projections: small emissive markers in known directions land where the formulas put them, within 0.13 px for 5
    panorama directions, 0.08 px for 7 equidistant (180-degree) and equisolid (200-degree) fisheye directions and
    0.16 px for 5 points under distortion k1 -0.15, k2 0.05, p1 0.01, p2 -0.005 (up to 1.4 half-heights off centre);
  - closed-form checks: furnaces (convex cube in a uniform sky) diffuse 0.5000 and 1.0000, smooth metal, smooth plastic
    and clear glass 1.0000, media 0.9999, subsurface 0.9998, constant environment map 0.4998 (expected 0.5); emission
    3.0000; Beer-Lambert 0.3678 (e^-1 = 0.3679); emissive media 8 deep emitting 2 per unit 15.996 without
    extinction (16; the ray starts 0.002 inside each face), 10.1105 at density 0.125 (10.1139) and 3.9272 at 0.5
    (3.9267); tinted absorbing glass slab 0.3321 (0.3322 with exact Fresnel);
    sun irradiance, point and disk, 0.5000; two emissive planes 0.6671 (2/3); a large area light 1.0000; shadow through
    an absorbing medium 0.1839 (0.5 e^-1); a non-uniform environment map over a plane within 1% of the texel integral;
  - area lights as panels: a 4 x 4 panel 8 above a floor under a point sun at 45 degrees shadows 16.000 units^2 of it
    (exactly its area; 0 with `opaque: false`); its front shows radiance 3.0000 (3), a one-sided back 0 and, see-through,
    the sky 0.2500; a dark panel between a floor and a lit 40 x 40 ceiling leaves the floor 0.3762 against
    rho L (F_ceiling - F_panel) = 0.3774 from parallel-rectangle view factors (0.9314 against 0.9316 see-through);
  - energy compensation: white furnaces of a metal plane and a 16-voxel clear glass slab at roughness 0.2, 0.5, 0.8 and
    1.0, seen at 20, 60 and 80 degrees, all within 0.79% of 1 (worst: metal at roughness 0.2 and 80 degrees; glass
    worst 0.68%); a gold plane within 0.14% per channel of single scattering plus Kulla-Conty's Fresnel-weighted
    multiple scattering, both integrated numerically in the page;
  - the GGX plastic coat's albedo at 20, 60 and 80 degrees within 0.0002 of a numerical integration of the same model;
  - dispersion: an emissive line seen through a 12-unit glass slab tilted 0.6 rad (orthographic, 32 px per unit)
    shifts by Snell's lateral offset at each wavelength, from Cauchy's index with V_d 20: 450 nm 2.8351 (expected
    2.8333), 550 nm 2.7700 (2.7682), 650 nm 2.7315 (2.7298), no dispersion 2.7533 (2.7516); the 450-650 nm spread
    0.1036 (0.1035); over the whole spectrum blue lands furthest and red least; a dispersive glass cube in a white
    furnace stays white per channel (1.0025, 0.9993, 0.9968);
  - light through glass and off mirrors: a glass slab's shadow at 0 and 40 degrees within 0.30% of
    `cos * T / (1 - albedo * rd)` (transmission with internal reflections, floor-slab interreflection), also for a
    point sun (only light sampling reaches it); the floor under glass resting on it within 0.87% of the refracted
    irradiance; a mirror wall's floor `E (1 + R)` exact to 4 digits for a point and a disk sun; a floating glass cube's
    shadow and caustic with light sampling equal to path sampling of the same light within 0.31% (IOR 1.5, totally
    reflected chains) and 0.40% (IOR 1.33, perpendicular faces) at 1024 against 16,384 samples (0.32% and 0.41%, the
    other way, at 4096 against 32,768: within the path-sampled side's noise);
  - environment orientation; equal seeds bit-identical;
  - convergence: error against a 16,384-sample reference falls 0.0216, 0.0114, 0.0058, 0.0030 at 16, 64, 256, 1024
    samples (1/sqrt(N)), both projections;
  - denoiser (480 x 300, against a 16,384-sample reference; two halves of 32,768 for the glass scenes, whose own noise
    is removed in quadrature): RMSE of the diffuse scene x2.78 lower at 4 samples, x2.53 at 16, x2.15 at 64, x1.61 at
    1024, object edges no worse except at 64 samples (8% higher); the material scene (glass, gold, plastic, cloud)
    x2.42, x2.30, x2.29; a caustic scene (strong sun through a glass block and a low-IOR slab, a mirror panel, rough gold;
    dim sky) x2.22, x2.10, x2.08 (asserted: at least x2 and x1.6);
  - depth of field blurs only out-of-focus edges; motion blur spreads a moving cube over its path; camera motion of 2
    units with the shutter open moves a 1-unit line's centroid by 0.9977 (1) and widens its profile to a standard
    deviation of 0.6455 units (the box convolution's sqrt(5/12) = 0.6455);
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
- Energy compensation: Kulla and Conty's multiple-scattering lobe for conductors ("Revisiting Physically Based Shading
  at Imageworks", 2017) and albedo normalisation for rough dielectrics (as in Turquin 2019). The albedo tables
  (E(mu, roughness) 32 x 32, Eavg 32, dielectric E(mu, roughness, eta) 16 x 16 x 32) are integrated once per device on
  the GPU with the tracer's own sampling code and a low-discrepancy R2/R3 sequence (Roberts 2018).
- Homogeneous media by free-flight sampling with Beer-Lambert absorption as a path weight, Henyey-Greenstein phase;
  their emission by the track-length estimator (emission times the distance flown in the medium, whose expectation
  is the attenuated integral).
- Environment maps importance sampled by marginal and conditional CDFs (PBRT). The physical sky: Preetham, Shirley and
  Smits ("A Practical Analytic Model for Daylight", 1999): Perez's distribution with their turbidity fits for luminance
  and chromaticity, xyY to linear sRGB, baked per texel.
- Dispersion: one wavelength per path, sampled from a mix of a uniform and a logistic density, weighted by its colour
  matching weight over that density. The weights come from Wyman, Sloan and Shirley's analytic fit of the CIE 1931
  2-degree observer ("Simple Analytic Approximations to the CIE XYZ Color Matching Functions", 2013) through the sRGB
  matrix (IEC 61966-2-1), normalised per channel so an equal-energy spectrum is white; Cauchy's index from the Abbe
  number.
- Random numbers: PCG (O'Neill 2014) with Jarzynski and Olano's hash (2020); thin lens by Shirley and Chiu's concentric
  disk mapping; orthonormal bases by Duff et al. (2017).
- Light through smooth glass and off mirrors: deterministic refraction and reflection of shadow rays at planar voxel
  faces with each interface's solid-angle Jacobian, the candidate directions solved per face axis from Snell's law and
  mirror reflection, and MIS against BSDF-sampled paths through the same chain (a planar special case of specular
  next-event estimation, cf. Hanika et al. 2015, "Manifold Next Event Estimation"); one walk per surface point among
  the candidates by weighted reservoir sampling (as in Talbot et al. 2005, resampled importance sampling), walked by
  the path loop's own closest-hit call so the shader holds one traversal.
- Denoising: the edge-avoiding a-trous wavelet filter (Dammertz et al. 2010) on albedo-demodulated radiance, with
  variance-guided luminance stops (Schied et al. 2017) and a plane-distance geometric stop. Light focused by glass,
  mirrors and glossy metal onto diffuse surfaces is filtered separately, more widely. The luminance stop compares a
  difference with the variance of that difference (both pixels' variances): against the centre's variance alone it
  rejects bright, noisy neighbours more than dark ones, which darkened images by about 1.5% (measured).
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
- **Denoiser:** a classical filter, not a learned one. Averaged over four seeds against 131,072-sample references
  (noise removed in quadrature) it lowers the error x2.46, x2.32, x2.24 at 4, 16, 64 samples on the material scene and
  x2.20, x2.09, x2.03 on the caustic scene (whose undenoised error rose a little when the glass walks became one per
  point; its denoised error stayed within 4%). Edge pixels gain less.
- **Speed:** light sampling through glass costs time even in scenes without glass (see "Measured performance").
- **Caustics:** light turned more than once by glass (or by glass and a mirror), glossy reflections of a small sun and
  glass beyond the 8 light-sampled instances are found by path sampling only and converge slowly; `clamp` trades that
  noise for bias.
- **Simplifications:** RGB everywhere except dispersive glass, which samples one wavelength per path (no hero-wavelength
  sharing, so dispersion converges with colour noise); refracted radiance is not scaled by the squared
  index ratio; media are homogeneous per palette index with grey extinction; the ground is a plain diffuse plane; motion blur interpolates matrices and the camera's corner rays linearly (fast rotations shrink
  a little); no chromatic aberration; the physical sky is Preetham's (no multiple scattering, ozone or night sky);
  bloom comes from `@margoengine/post`.
- **Measured only on one machine** (RTX A6000, Edge 155, Windows). Other GPUs, browsers and the editor's own scenes are
  untested.
