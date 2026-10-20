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
- **Large and sparse models** (addition). A model may be up to 2048 cells per axis, and may give its contents as
  `blocks` instead of `voxels`: dense windows (`origin`, `size`, `voxels`) inside it, cells no block covers empty,
  later blocks winning where they overlap. Only the bricks a block touches are read: a 2048 x 64 x 2048 world with
  two small blocks attaches in 9 ms (RTX A6000 machine) and holds its 2 MiB brick grid plus those bricks. One model
  instead of tiles also keeps volumes whole: glass or media cut into tiles get an interface wherever two tiles meet
  (measured: a 400-cell glass bar as one model renders exactly like a 200-cell bar stretched 2x; as two 200-cell tiles
  the image differs by RMS 0.85). Dense `voxels` and the same cells as `blocks` pack identically.
- **Model material tables** (addition). A model's own `materials` replace `scene.materials` for its voxels, so a scene
  holds any number of distinct materials (255 per table), as model banks of an editor do: two models may give palette 1
  different materials. Tables equal in content are stored once; at most 4096 per scene, 32 KiB each, within the
  storage binding size. Picks and AOVs still report palette indices. Scenes without model tables read `scene.materials`
  from a uniform buffer as before; the first scene with them compiles a second variant of the tracing kernels that
  reads every table from storage (the viewport shows the raster frame until it is ready, captures wait for it).
- **Revisions.** `setScene` packs each model into 8^3 bricks and uploads it. A model whose `id`, `revision` and `size`
  equal the previous scene's is reused without reading `voxels` again: bump `revision` whenever voxels change. Only
  changed models are re-uploaded; the others keep their GPU memory.
- **Content keys** (addition). Ids and revisions belong to the caller's documents: a reopened document may reuse an id
  and revision for other voxels, and the tracer, which does not hash voxels, would keep the stale bricks. A model's
  `contentKey` is an identity of its voxel contents instead (a content hash, a serial given to one immutable buffer, or
  the buffer object; compared as a `Map` compares keys) that must never stand for two different contents. A keyed
  model reuses the packing of any model of the previous scene, or an earlier model of the same scene, with the same key
  and size, whatever its id or revision, and never one packed under another key or without a key; models without a
  key keep the id, revision and size rule among themselves. `invalidateModels(ids?)` forgets the packing of the named
  models (all when omitted), so the next `setScene` packs and uploads them again whatever their revision or key.
  `stats.packedModels` and `stats.reusedModels` count what the last `attach` or `setScene` did.

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
- Compatible additions for other renderers' material models (the MagicaVoxel mapping below sets them):
  - `metalColor`: the metal lobe's reflectance at normal incidence, when it differs from `color` (default `color`).
  - `coat: 'additive'`: the coat adds to the whole diffuse base instead of taking its reflection out of it (default
    `'layered'`).
  - `tint: false`: glass colour acts only through `density` absorption, not at its faces (default true).
  - `cameraEmission`: the emission multiplier camera rays see on the surface, while lighting keeps `emission` (a light
    that shows dimmer than it shines).
  - `sunlit` (media): the sun lights the medium even when `sunInMedia` is off, and its scattering events count against
    `bounceLimits.subsurface` (each diffuse event earlier on the path uses 4 of them) instead of `scatter`; with
    `transparentShadows` off a shadow ray from inside it crosses the rest of its volume and nothing after it (only its
    start cell for a sun ray from a path that entered through a face turned from the sun), so mainly faces toward the
    sun glow.
  - `voxelwise` (blend): every voxel face inside the volume picks a lobe again; light passes straight through the
    glass share and the rest scatters there.
  - `contactTransmission` (blend): a ray inside the volume reaches another voxel's surface only with the glass share's
    probability, else the path ends (MagicaVoxel's partly transparent glass over what it rests on).
- Block textures (addition): `scene.textures` lists RGBA8 images (`{width, height, data}`, 1-1024 texels a side, sRGB
  colour, linear alpha, rows from the top; at most 4096); a material's `texture` is one index for every face or six for
  +x, -x, +y, -y, +z, -z in model axes. A face's texel (nearest) multiplies `color` and `metalColor`; emission stays
  untextured. Faces tile as in `@margoengine/voxel`'s renderer (tops by x and z, sides with v running down), one
  texture per voxel face, so a block game's 16 x 16 pixel art looks as it does there. The denoiser keeps textures
  sharp: it filters lighting, not surface colour.
- Cut-out texels (addition): with a `texture`, `cutout` (an alpha threshold, for example 0.5) lets rays and shadows
  through texels whose alpha is below it. A ray crossing such a voxel meets the texel where it enters, else the one
  where it leaves (the voxel's inner face, as leaves show theirs), else goes on to the next voxel. `raycast` still picks
  whole voxels.

## Lighting

| Light | How | Notes |
| --- | --- | --- |
| Sky | `skyColor * skyIntensity`, constant radiance from every direction | Reached by scattered paths. Default white, intensity 1. |
| Sun | `sunColor * sunIntensity` is the **irradiance** on a surface facing it, whatever its size; `sunAngularSize` (radians) softens shadows and shows a disk | Sampled directly (next-event estimation) and by paths, combined by multiple importance sampling. Default intensity 0 (off), size 0.0093. |
| Ground | `groundColor` adds an infinite diffuse plane at `groundHeight` | Casts and receives like any surface. |
| Physical sky (addition) | `environment.physicalSky`: `{turbidity (1.7-10, default 3), intensity (radiance per kcd/m^2, default 0.1)}` | Preetham, Shirley and Smits' daylight model for `sunDirection`, baked to a 1024 x 512 map and importance sampled like one; black below the horizon (a sun below it is taken on the horizon). The sun disk stays the `sun*` light. Not together with `map`. |
| Environment map (addition) | `environment.map`: equirectangular linear RGB(A) floats, `intensity`, `rotation` about +Y | Replaces the constant sky; filtered bilinearly; importance sampled by luminance x sin(theta). Its centre column faces -Z, three quarters +X. |
| Emissive voxels | Any material with `emission > 0` | Faces sampled by emitted power, instances by power x area. |
| Uniform fog (addition) | `environment.fog`: `{density (extinction per world unit), color?, anisotropy?}` | Rays outside volumes fade over distance toward the fog's glow, the sky and sun light it scatters (Henyey-Greenstein, no shadows); rays leaving the scene see only the glow; the sun reaches surfaces only through it; emissive voxels and area lights are attenuated by distance. |
| Area lights (addition) | `scene.lights`: rectangles `position + s * edgeU + t * edgeV`, radiance `color * intensity`, `twoSided`, `opaque` | Facing `cross(edgeU, edgeV)`. Solid panels by default: seen, reflected and casting shadows (from the sun, the sky, emissive voxels and each other); a one-sided light's back is black. `opaque: false` keeps the earlier see-through light (no shadows, no back face). Dark (`intensity` 0) solid panels stay as occluders. At most 256. |

Lighting additions: `environment.sunVisible: false` hides the sun disk from camera rays (it still lights and
reflects); `environment.groundFade` (a distance) fades the ground camera rays see into the sky behind it by
1 - e^(-(D - groundFadeStart) / groundFade) at camera distance D; `environment.background` (linear RGB) is what
camera rays show where they leave the scene, in place of the sky and the sun disk (the sky still lights).

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
| `samplesPerFrame` | 1 | 1-64, or `'auto'` (as many as keep the display's pace) | no |
| `maxBounces` | 8 | 1-64 (Russian roulette may end paths after 3) | yes |
| `maxSamples` | 1024 | 1+ or `Infinity` | no (raising it continues) |
| `seed` | 0 | integer 0-4294967295 | yes |
| `resolutionScale` | 1 | 0.1-2 | yes |
| `exposure` (EV) | 0 | -20-20 | no |
| `aperture` | 0 | 0+ | yes |
| `focusDistance` | camera to target (automatic) | above 0; `null` returns to automatic focus | yes |
| `denoise` | false | boolean, or `'auto'` (viewport: every frame below 32 samples, then as the samples grow by a quarter; captures denoise); the viewport's denoiser keeps a history across camera moves (see below) | no |
| `lensBlades`, `lensRotation` | 0, 0 | 0 or 3-16; radians | yes |
| `shutter` | 0 | 0-1 | yes |
| `previousCamera` | none | `{position, target, up?, fov?}` or null | yes |
| `projection` | `'camera'` | `'camera'`, `'panorama'`, `'fisheye'` | yes |
| `fisheye` | `{mapping: 'equidistant', fov: 180}` | mapping `'equidistant'` or `'equisolid'`, fov above 0 to 360 | yes |
| `distortion` | none | `{k1, k2, p1, p2}`, each -1 to 1, or null | yes |
| `clamp` (largest luminance a path may add; biased firefly control) | Infinity | above 0 | yes |
| `toneMapping` | `'neutral'` (Khronos PBR Neutral, Margo's display transform) | `'neutral'`, `'linear'`, `'aces-narkowicz'` (Narkowicz's ACES fit after x0.6) | no |
| `gamma` (display encoding after tone mapping) | sRGB | 1-5 (power 1 / gamma), or undefined for sRGB | no |
| `bounceLimits` (events per kind on top of `maxBounces`) | none | `{diffuse?, specular?, scatter?, subsurface?}` each 1-64, or null | yes |
| `transparentShadows` (shadow rays through glass and media) | true | boolean; false: any voxel blocks them | yes |
| `sunSpecular` (the sun lights glossy lobes, is seen in reflections) | true | boolean; false: diffuse lobes only | yes |
| `sunInMedia` (the sun lights media directly) | true | boolean | yes |
| `energyCompensation` (rough metal and glass keep their energy) | true | boolean | yes |
| `vignette` (cos^4 darkening: 1 / (1 + t^2)^2, t = vignette x r / (0.2238 x image height)) | 0 (off) | 0 or more | no |
| `edges` (camera rays see a band `width` voxels wide along turning voxel edges, in `color`, lit) | null | `{color, width}` | yes |
| `grid` (camera rays see lines every `spacing`, `2 x width` wide, on the ground and with `onVoxels` on voxels) | null | `{color, spacing, width, onVoxels?}` | yes |
| `order` (frame-graph order of the pass) | 20 | finite | no |

Options left out of `setOptions` (or `undefined`) keep their current value; `null` clears `previousCamera`,
`distortion`, `bounceLimits`, `edges` and `grid` and makes `focusDistance` automatic again. `resetOptions(names?)`
(addition) returns the named options, or all of them, to their defaults. `tracer.options` is a copy of the options in
effect, every default filled in.

Without an engine or GPU (additions): `VOXEL_PATHTRACER_DEFAULTS` holds every option's default (frozen);
`resolveTraceOptions(options, base?)` returns what `setOptions` would leave in effect over `base` (default: the
defaults) and throws exactly its errors; `validateTraceOptions(options)` returns `{ok, problems, unknown}` without
throwing: every invalid option with the error `setOptions` would throw for it, and names it ignores. For materials,
`resolveTraceMaterial(material, textures?)` returns the material with the defaults of its type filled in
(`emissionColor` and `metalColor` default to `color`, `cameraEmission` to `emission`, `texture` as six face indices), and
`validateTraceMaterial(material, textures?)` lists every invalid field; both match `setScene`'s checks (texture indices
against `textures` when given).

Accumulation also restarts on any change of the camera (matrix, position, target, up, projection), the drawing-buffer
size, the scene (`setScene`), `reset()`, turning `enabled` back on, and a GPU device change. Equal seed, scene, camera and
options give the same image on the same GPU and driver (measured bit-identical on the RTX A6000); other GPUs may differ
by floating-point rounding, which changes individual paths, not the converged image.

## Viewport, readiness, devices, disposal

- The pass (order 20) traces `samplesPerFrame` samples into float32 accumulation buffers, optionally denoises, and
  draws over the frame with exposure and tone mapping, writing each pixel's first-hit depth (so overlays drawn later
  depth-test against the traced image). On an `rgba16float` target (for example under `@margoengine/post` Bloom) it
  writes linear HDR and leaves tone mapping to that pass.
- With `denoise` on, the viewport's denoiser keeps a history while the camera moves: each frame reprojects the last
  frame's estimate onto the surfaces it sees again (up to 32 samples' worth, 8 through glass or mirrors) and blends the
  displayed image with the last one (temporal antialiasing: the frames' jittered samples average into smooth edges).
  Measured at 960 x 800, 1 sample per frame, 30 frames, 8-bit RMS error against a 2048-sample image of the last
  camera (diffuse, glass and cloud scenes): turning 0.001 degrees per frame 2.40 / 6.08 / 5.22 before, 0.98 / 2.33 /
  1.60 now; turning 0.5 degrees per frame 2.40 / 6.05 / 5.00 before, 2.13 / 2.78 / 2.32 now. Where a move uncovers a
  surface (behind an object the camera passes) the history starts again there, so those pixels are noisier for a few
  frames; 8 frames after the camera stops the diffuse and cloud scenes are 1.10 and 2.28 against 0.96 and 2.03 without
  history (the glass scene 1.95 against 2.03). A camera that never moves gives the same image as before. Every camera
  pose draws its own sample sequence, so equal inputs still give equal images. Cost at 1920 x 1080: two more images of
  history, kept in two textures (348 against 285 MiB for the denoised material scene) and about 0.6 ms per frame; scenes without glass,
  metal or glossy coats skip the caustic chain, which more than makes up for it (256 MiB for the dense scene).
- `enabled = false` leaves ordinary rendering unchanged (measured bit-identical); the tracer then encodes nothing.
- Until then the viewport shows a preview: a small kernel (compiled in a fraction of the full tracer's time, about 0.15
  against 2 s on an RTX A6000) draws the first hit lit by the sun and the sky; accumulation starts over when the full
  tracer is ready. `stats.samples` reads 0 meanwhile.
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

- `capture({width, height, samples, signal?, denoise?, transparent?})` renders a PNG (8-bit RGB, exposure and tone
  mapping applied)
  at exactly that size and sample count, from the engine camera with its aspect set to the image's. It renders in
  1024-pixel tiles on separate GPU buffers and private copies of the scene buffers, so it neither disturbs the viewport
  nor sees later `setScene` calls; the viewport pauses tracing meanwhile and keeps its image. Denoised tiles overlap by
  64 pixels so there are no seams. Rows are encoded as they arrive (`CompressionStream`), so a large capture never holds
  its whole raw image. Up to 16384 per side and 67,108,864 pixels. With `transparent: true` (addition) the PNG is RGBA:
  camera rays that leave the scene add nothing, alpha is the share of each pixel's camera rays (8 x 8 strata through
  the lens) that hit a voxel, the ground or an area light, and colours are stored unpremultiplied; rays that bounce
  still see the sky and are lit by it. Measured on the RTX A6000: pixels every camera ray covers equal the opaque
  render exactly, pixels off the scene are alpha 0 and black.
- `renderImage(options)` (addition) returns the linear float image (3 floats per pixel), and with `aovs: true` the
  first-hit albedo, normal, distance and the instance (index into `scene.instances`) and palette index under each
  pixel centre. `jitter: false` traces pixel centres only; `wavelength` (380-780 nm) traces dispersive glass at that one
  wavelength with weight 1 (a monochromatic check); `transparent: true` adds `alpha` (the colour is then premultiplied
  by it). Up to 16,777,216 pixels.
- Both reject with the signal's reason when aborted (checked between GPU submissions, at most 4 in flight), with
  `MargoError` `failed` when the device is lost, with `MargoError` `disposed` when the tracer is disposed meanwhile, and
  with `TypeError`/`RangeError` for invalid options. Jobs run one at a time in call order.
- Lifecycle (addition): when a capture or render promise settles, aborted ones included, its GPU buffers are already
  released (`stats.gpuBytes` no longer counts them) and the viewport traces again; dispatches it had already submitted
  may still be running on the GPU. `stats.renders` counts captures and renders queued or running. `whenIdle()`
  resolves once every capture and render called before it has settled and the GPU has finished the work submitted so
  far; it never rejects (after `dispose` or a lost device it resolves once the queued promises have settled).
- `raycast(origin, direction, maxDistance?)` (addition) returns the closest visible voxel on the CPU: instance and model
  ids, model-local cell, face normal and the adjacent cell, palette index, distance and world point.

## Limits

| Limit | Value |
| --- | --- |
| Model size | 1-2048 per axis (256 before); its brick grid (4 bytes per 8^3 cells, empty ones included) and mixed bricks within the binding size |
| Instances | 65,535 |
| Area lights | 256 |
| Block textures | 4096, each 1-1024 texels a side (in the scene buffer, within the binding size) |
| Material tables | 4096 per scene (`scene.materials` and distinct model tables), 32 KiB each, within the binding size |
| Light-sampled glass and mirror instances | 8 of each (others are path sampled) |
| Voxel data | grids plus 512-byte mixed bricks within the device's `maxStorageBufferBindingSize` (WebGPU default 128 MiB: about 262,000 mixed bricks; uniform bricks cost one word) |
| Environment map | 8192 x 4096, and width x height x 16 bytes within the binding size (4096 x 2048 at the default) |
| Emissive faces | their tables (12 bytes each), with the scene records, block textures and other light tables in one binding (about 11 million at the default) |
| Viewport | every image 16 bytes per pixel within the binding size (8.3 million pixels at the default, so 3840 x 2160 is traced at its native size, denoised or not); the denoiser's two history images are textures within `maxTextureDimension2D` (8192 at the default). Larger canvases are traced at a lower resolution, keeping the aspect: `stats.requestedWidth`/`requestedHeight` give the size asked for, `stats.limitedBy` the limit that reduced it, and `traceViewportSize(width, height, device.limits, options)` predicts it |
| Accumulation | float32 sums: refinement is expected to slow past about a million samples per pixel (not measured) |

## Measured performance

RTX A6000 (Ampere), Windows 11, Edge 155 (headless, WebGPU, D3D12), 2026-10-20, from
`tests/browser-check.mjs timing` (GPU time between timestamp queries around the pass, median of 40 frames; two runs):

| Scene at 1920 x 1080 | GPU per frame | GPU memory |
| --- | --- | --- |
| Material scene (7 models, glass, metal, emitter, cloud, sun, sky, ground), 1 sample | 13.76 ms | 95 MiB |
| Same, denoised | 21.17-21.63 ms | 348 MiB |
| One dense 256^3 model (3,967,601 voxels, terrain; diffuse and emissive), 1 sample | 10.68-10.75 ms | 98 MiB |
| Same, denoised (no glass, metal or glossy coat: no caustic chain) | 14.42-14.61 ms | 256 MiB |
| Same, 4 samples per frame | 42.07-42.40 ms | 98 MiB |

The same day, before the viewport denoiser kept history, the denoised material scene took 20.97-21.23 ms and 285 MiB;
before the caustic chain was skipped for scenes without focusing materials, the denoised dense scene took 18.74-19.01
ms and 351 MiB. The previous day's run gave 12.39, 19.92, 9.90 and 36.96 ms for the other rows: compare rows from one
day only. On 2026-10-21, when every row ran slower (material scene 17.43-17.50 ms), the denoiser's edge weighing and
ratio stop cost 0.2-0.6 ms per denoised frame against the previous denoiser in the same session (material scene
27.39-27.46 against 26.87-27.20 ms, dense scene 18.02-18.42 against 17.83-17.89 ms) and no memory.

Model material tables, 2026-10-21, against the previous commit in one session: scenes without them run as before
(material scene 17.30-17.50 against 17.50-17.56 ms, denoised 26.94-27.39 against 27.53-27.79 ms, dense 4 samples
57.93-58.39 against 56.62-56.95 ms, every other row within 0.3 ms). Reading every table from storage instead cost the
material scene about 1 ms (5%); reading `scene.materials` from the uniform and the rest from storage in one kernel
cost 2 ms; hence the second kernel variant.

Native 4K (`tests/browser-check.mjs native4k`, 2026-10-21, the same slower day): the material scene in a 3840 x 2160
canvas with the default device limits is traced at 3840 x 2160, 1 sample per frame while the camera moves: 68.81 ms
and 380.0 MiB raw, 113.44 ms and 1,392.5 MiB denoised (history in textures). Before the history moved into textures
the budget of 48 bytes per pixel in one 128 MiB binding traced a denoised 4K canvas at 2229 x 1254 (a third of the
pixels).

Light sampling through glass and mirrors made a sample dearer than before it (measured the same day on the same
machine: 6.09 ms for the material scene, 8.45 ms for the dense one, 9.11 ms denoised): glass and mirror candidates need
walks, and the larger shader is slower even where there is no glass. Noise per sample fell (two renders' difference at
64 samples, 480 x 300: material scene 0.0347 to 0.0284, caustic scene 0.0484 to 0.0336), which does not make up for the
time in the material scene (about 17% more noise at equal time); the caustic scene's time was not measured. The earlier
version also converged to a wrong image where glass rests on another model (the floor under it was black). The
denoiser's second (caustic) chain, used only when a material can focus light (glass, or metal or a coat with roughness
below about 0.32), adds three images of the canvas's size and six filter passes.

CPU: packing that 256^3 model takes 43-59 ms (attach or a new revision); `setScene` with unchanged revisions 0.2-0.5 ms;
a new physical sky (other turbidity, intensity or sun direction) bakes in 50-63 ms, an unchanged one 1.4-3.8 ms;
encoding a frame 0.2 ms. A 1500 x 1100, 64-sample denoised PNG capture of the material scene took 1.25-1.38 s.
Numbers on other GPUs are not measured.

## Verification

- `tests/*.test.js` (Node, 69 tests, about 1.4 s; part of `npm run verify`): validation and atomic failure, dense
  indexing, all 255 palette identities, transformed/mirrored/hidden instances, model reuse by revision, voxel traversal
  against a brute-force slab test (2,000 random rays over 5 models whose sizes are not multiples of 8), resets for each
  camera/size/scene/option change, enable/disable, `maxSamples`, the denoiser's passes (the caustic chain only for
  materials that focus light) and when the viewport's history is kept, used or dropped, upload reuse, disposal, device
  restore and device switch, pass order, PNG encoding with tile placement, AOV mapping, cancellation, pausing, device
  loss during a capture, and the frame uniform's lighting values; the exported defaults, `resolveTraceOptions` and
  `validateTraceOptions` against `setOptions`' own errors, `resetOptions` and automatic focus, `resolveTraceMaterial`
  defaults per type and `validateTraceMaterial` against `setScene`'s errors; reuse by `contentKey` across ids, never
  across keys, one packing for two models with one key, `invalidateModels`; `stats.renders`, buffers released before an
  aborted render rejects, and `whenIdle` waiting for the GPU queue and resolving after `dispose`; the viewport's size
  (every storage buffer one image within the binding limit, history textures within the texture limit, 3840 x 2160
  native with the default limits, `traceViewportSize`); model material tables (more than 255 distinct materials, equal
  tables stored once, table numbers in the model records, the TABLES kernels used only for scenes with them, errors
  naming the model's table); large and sparse models (dense voxels and the same cells as blocks give identical
  voxel buffers and picks, a sparse 2048 x 64 x 2048 world, emissive faces past cell 255, block and size errors). A
  recording fake device stands in for WebGPU.
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
    is removed in quadrature): RMSE of the diffuse scene x2.79 lower at 4 samples, x2.64 at 16, x2.32 at 64, x1.62 at
    1024, object edges lower at every count (at 64 samples 7% lower; 8% higher before the edge weighing); the material
    scene (glass, gold, plastic, cloud) x2.44, x2.31, x2.30; a caustic scene (strong sun through a glass block and a
    low-IOR slab, a mirror panel, rough gold; dim sky) x2.23, x2.10, x2.08 (asserted: at least x2 and x1.6; edges of all
    four scenes no worse than raw at 16 and 64 samples, within 2% at 1024);
  - a lamp beside a wall (160 x 120, against 16,384 samples): the lit stretch keeps 0.912 of its level at 16 samples and
    0.967 at 64 (0.883 and 0.958 before the wide levels' ratio stop), RMSE x1.99 and x1.38 below raw (it was worse than
    raw at 64 before);
  - the viewport denoiser while the camera moves (30 frames, 1 sample each): RMS 5.31 against the converged image,
    raw frames 16.00, a still camera 2.78;
  - depth of field blurs only out-of-focus edges; motion blur spreads a moving cube over its path; camera motion of 2
    units with the shutter open moves a 1-unit line's centroid by 0.9977 (1) and widens its profile to a standard
    deviation of 0.6455 units (the box convolution's sqrt(5/12) = 0.6455);
  - viewport: disabled and disposed frames equal the raster frame bit for bit; a device restore redraws the same
    converged image bit for bit; resize restarts accumulation; Bloom composes with the HDR output;
  - a 1500 x 1100 denoised PNG decodes to that size; a 2048^2 x 4096-sample capture cancels within 0.33 s, its buffers
    released when it rejects, and `whenIdle` drains the GPU 0.4 ms later;
  - a 3840 x 2160 canvas is traced at 3840 x 2160 with the default limits, raw and denoised, while the camera moves;
  - model material tables: the material scene with each model's palette moved to its own index in a table of its own
    renders bit for bit as with one shared table (0 of 57,600 values differ); 300 models whose own tables give palette
    1 300 colours each show their colour (worst albedo error 2.9e-8), picks reporting palette 1;
  - large models: a 400-cell glass bar as one model renders bit for bit as a 200-cell bar stretched 2x (two 200-cell
    tiles: RMS 0.85 against it); a 2048 x 64 x 2048 sparse world whose lamp lies past cell 255 renders as the same lamp
    and floor in a 64^3 model at the same place (relative RMS 1.5e-5, float rounding).

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
  variance-guided luminance stops (Schied et al. 2017) and a plane-distance geometric stop. In the viewport the
  demodulated estimate is accumulated over frames by reprojection with position and normal tests, as in Schied et
  al.'s spatiotemporal filter, and the output is blended with the previous output (temporal antialiasing, Karis 2014,
  "High Quality Temporal Supersampling"), clamped to the neighbourhood's mean and standard deviation in YCoCg (Salvi
  2016) and dropped where the reprojected taps saw an occluder. First-hit distances for reprojection are taken along
  each pixel's centre ray to the plane of the face the sample hit. History is stored in halves rounded to nearest
  (some GPUs convert toward zero, which compounds into a darker image). Light focused by glass,
  mirrors and glossy metal onto diffuse surfaces is filtered separately, more widely. The luminance stop compares a
  difference with the variance of that difference (both pixels' variances): against the centre's variance alone it
  rejects bright, noisy neighbours more than dark ones, which darkened images by about 1.5% (measured). The wide
  levels also stop on the ratio of two pixels' luminances, so the peak of a steep gradient (a wall beside a light)
  keeps its level. At object, material and texture edges, from 16 samples on, the filtered estimate is weighed against
  the raw mean by their estimated squared errors, the filtered one's including the bias that its difference from the
  raw means shows over a 3 x 3 neighbourhood (selecting among filters per pixel by estimated error, as in Rousselle et
  al. 2012, "Adaptive Rendering with Non-Local Means Filtering"): where the samples already resolve detail, filtering
  does not blur it.
- PNG output written from the W3C PNG specification over the platform's zlib `CompressionStream`.

## MagicaVoxel files

`magicaVoxelMaterial(id, rgb, attributes)`, `magicaVoxelLighting(renderObjects)`, `magicaVoxelCamera(camera,
renderObjects)`, `magicaVoxelModel(id, revision, size, xyzi)` and `magicaVoxelMatrix(size, translation, rotation)`
turn a `.vox` file's palette, MATL materials, rOBJ render settings, rCAM camera and models into this tracer's inputs
(MagicaVoxel is z-up; tracer = MagicaVoxel (x, z, -y)). `magicaVoxelLighting` also returns the tracer options that
reproduce MagicaVoxel's choices (ACES with gamma 2.2, bounce caps 2/5/5, no transparent shadows, the sun on diffuse
lobes only and not in media, no energy compensation) and lists the settings it does not reproduce yet. With
`{look: 'margo'}` it keeps the file's film, colours, sky, sun and fog but traces light physically (sun highlights on
metal and glass, light through glass, sun-lit clouds, rough metal keeping its energy, no bounce caps): MagicaVoxel's
look, lit correctly.

The mapping was measured from MagicaVoxel 0.99.7's own renders of calibration scenes (a black box: its code was not
read): palette colours are linear by a pure 2.2 power, sky radiance is its intensity, sun irradiance 5 x intensity,
emitters `colour x (1 + 3 x emission x 10^power)`, metal reflectance `min(1, specular x colour)` with GGX width
0.13 x roughness, glass colour through `_d` absorption only, media extinction `_d` per voxel, fog extinction
0.001 x `_d`. Its atmosphere sky (`_env _mode 1`) is reproduced by `bakeAtmosphere` (exported with
`atmosphereRadiance` and `atmosphereTransmittance`): single scattering with Rayleigh, Cornette-Shanks Mie and ozone
terms fitted to 16 of MagicaVoxel's panoramas (0.3-1 levels mean for the default and singly changed settings), baked
to a 256 x 256 map in about 0.5 s; the sun then lights at 10 x intensity through the air's transmittance. Its display settings
map to `environment.background`, `vignette`, `edges` and `grid`; a transparent background (`_setting _bg_a`) is
reported as `transparentBackground` (pass `transparent: true` to `capture`) and non-cubic voxels (`_setting _scale`)
as `voxelScale`, which `magicaVoxelMatrix` takes as its fourth argument (the scene scaled about the origin); its image sky (`_env _mode 2`) needs the decoded HDR
file passed as `magicaVoxelLighting(objects, { imageSky })` (the result's `imageSky.path` names it). Six default-lit scenes (diffuse, metal at roughness 0.2 and 0.8, glass, emitter, cloud) match
MagicaVoxel's images within 3 of 255 levels on 99.2-99.97% of pixels; the measured mapping, the calibration procedure
and the open items are in docs/magicavoxel-parity.md. Same scenes, same GPU (RTX A6000), 960 x 800 at 1024 samples:
MagicaVoxel about 14-15 s, this tracer 1.7-1.85 s.

## Parity status and known gaps

Implemented and verified as above: voxel traversal with shared transformed instances; diffuse, plastic, metal, glass,
emissive, blended and media materials; subsurface scattering by random walk; sun, sky, ground, HDR environment maps,
emissive voxels and area lights with next-event estimation; depth of field with round and polygonal apertures;
instance motion blur; perspective and orthographic cameras; progressive accumulation with a stable seed; a denoiser;
PNG and float captures with cancellation; device-loss recovery.

Not done or not verified, stated plainly:

- **MagicaVoxel parity is not complete:** a transparent background (`_bg_a`) and non-cubic voxels (`_scale`) are
  reproduced but not yet compared with MagicaVoxel's images; subsurface is fitted at one density only; glass over a lit floor is 1-2 levels brighter; under the atmosphere, a view into a low sun matches on 97.7% of
  pixels and very dense air settings by 2-3 levels on average (docs/magicavoxel-parity.md).
- **Denoiser:** a classical filter, not a learned one. While the camera moves, surfaces it uncovers are noisy for a
  few frames, and for a few frames after it stops the history makes diffuse and cloud scenes slightly worse than
  without it (numbers under "Viewport"). Averaged over four seeds against 131,072-sample references
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
