# @margoengine/voxel-pathtracer

Import `margoengine/voxel-pathtracer` from the `margoengine` package, or `@margoengine/voxel-pathtracer` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A progressive WebGPU path tracer for voxel models. Attach it to an engine and, while it is enabled, the frame shows a
path-traced image of your voxel scene through the engine camera, refining every frame until a sample budget. It also
renders off-screen PNGs and float images of any size, and answers ray picks against the same scene.

Optional and tree-shakable: `@margoengine/core` and the `margoengine` stage never import it. It needs the WebGPU backend
(`MargoError` `unsupported` otherwise), which the [WebGL2 compatibility layer](#on-the-webgl2-compatibility-layer) also
provides, and has no runtime dependency besides `@margoengine/math`.

Written clean-room from public rendering literature (see [How it works](#how-it-works)). It reproduces the kinds of
materials, lights and camera effects voxel editors offer; it does not claim to reproduce any other renderer's private
equations or images.

```ts
import { VoxelPathTracer, type VoxelTraceScene } from 'margoengine/voxel-pathtracer';
import {Engine} from 'margoengine/core';
// A generated solid block, so this example needs no external model file.
const voxels = new Uint8Array(4 * 4 * 4).fill(1);
const signal = AbortSignal.timeout(30_000);
const engine = await Engine.create(document.querySelector('canvas')!);

const scene: VoxelTraceScene = {
  revision: 1,
  models: [{ id: 'block', revision: 1, size: [4, 4, 4], voxels }], // voxels: Uint8Array of palette indices
  instances: [{ id: 'block-1', modelId: 'block', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, -2, 1] }],
  materials: [
    { id: 1, color: [0.8, 0.75, 0.7], type: 'diffuse' },
    { id: 2, color: [0.9, 1, 0.95], type: 'glass', ior: 1.5 },
    { id: 3, color: [1, 0.6, 0.3], type: 'emit', emission: 5 },
  ],
  environment: { skyColor: [0.6, 0.75, 1], sunIntensity: 3, sunDirection: [0.4, 0.8, 0.3], groundColor: [0.4, 0.4, 0.4] },
};
const tracer = VoxelPathTracer.attach(engine, { scene, maxSamples: 512, denoise: true });
await tracer.ready; // until then frames show the ordinary raster image
const nextScene = {...scene, revision: 2};
tracer.setScene(nextScene); // validated as a whole; accumulation restarts
const png = await tracer.capture({ width: 512, height: 512, samples: 64, signal });
tracer.enabled = false; // back to the raster frame, bit for bit
tracer.dispose();
```

## Combining optional tracing features

`margoengine/voxel-pathtracer/compose` (or `@margoengine/voxel-pathtracer/compose`) exports
`ComposedVoxelPathTracer`. Import feature factories from the entries you need and pass any subset,
including an empty array. The original standalone tracers remain available.

```ts
import { Engine } from 'margoengine/core';
import { ComposedVoxelPathTracer } from 'margoengine/voxel-pathtracer/compose';
import { resampledEmitters } from 'margoengine/voxel-pathtracer/restir';
import { causticGuiding } from 'margoengine/voxel-pathtracer/guiding';
import { coloredMedia } from 'margoengine/voxel-pathtracer/media';
import { triangleMeshes } from 'margoengine/voxel-pathtracer/mesh';
import { spectralTransport } from 'margoengine/voxel-pathtracer/spectral';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 1, 4], target: [0, 0, 0]},
});
const tracer = await ComposedVoxelPathTracer.create(engine, {
  scene: {
    revision: 1, models: [], instances: [],
    materials: [{id: 1, type: 'diffuse', color: [0.3, 0.6, 0.8]}],
    meshes: [{id: 'panel', material: 1,
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2])}],
    environment: {skyColor: [0.7, 0.8, 1], sunIntensity: 3},
  },
  features: [resampledEmitters(), causticGuiding(), coloredMedia(), triangleMeshes(), spectralTransport()],
  signal: AbortSignal.timeout(30_000),
});
engine.start();
window.addEventListener('pagehide', () => { tracer.dispose(); engine.dispose(); }, {once: true});
```

Defaults are `features: []`, 8 resampling candidates, guiding strength 0.5, an achromatic spectral
lens and focal length 0.05 world units. Options on a feature are fixed at creation and use the same
validators as the standalone entry. Factory settings must be an object; arrays and primitive values
reject. Duplicate features reject before GPU allocation. Array order
does not affect the result: transforms always run resampling, mesh, media, guiding, then spectral.
Only selected entries are imported; mesh Wasm loads during geometry preparation, with abort support.
RGB palette conversion precedes geometry preparation on every `create` and asynchronous `setScene`.
Updates copy caller arrays immediately, apply in call order and replace the scene atomically.
`whenIdle`, captures, viewport rendering, device restoration and disposal retain the root contracts.

| Entry | Factory | Feature options |
| --- | --- | --- |
| `/restir` | `resampledEmitters()` | `candidates: 1..64`, default 8 |
| `/guiding` | `causticGuiding()` | `guideStrength: 0..0.95`, default 0.5 |
| `/media` | `coloredMedia()` | RGB `extinction` on scene media materials |
| `/mesh` | `triangleMeshes()` | `meshes` on the scene |
| `/spectral` | `spectralTransport()` | `lensAbbe: 0` or `5..200`, default 0; `focalLength: 1e-6..1e6`, default 0.05 |

Composition retains each feature's documented transport limits. Triangle emission currently uses
path hits; emissive-triangle light sampling and triangle-bound caustic guiding remain gaps recorded
in `docs/known-bugs.md`. `tests/compose-browser.mjs` checks all 32 subsets, RGB media with RIS and
triangle markers on native WebGPU and WebGL2 compatibility.

## Resampled emissive lighting

`margoengine/voxel-pathtracer/restir` (or `@margoengine/voxel-pathtracer/restir`) exports
`ResampledVoxelPathTracer`. Its options and lifecycle are the root tracer's, with `candidates` added:
an integer from 1 to 64, default 8. One uses the original kernel exactly. Larger values combine
`ceil(candidates / 2)` power-weighted emissive-face proposals and `floor(candidates / 2)` cosine
proposals (phase-function proposals inside media) in a visibility-aware reservoir with balance MIS.

```ts
import { Engine } from 'margoengine/core';
import { ResampledVoxelPathTracer } from 'margoengine/voxel-pathtracer/restir';
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [3, 2, 5], target: [0, 0, 0]},
});
const tracer = ResampledVoxelPathTracer.attach(engine, {
  scene: {
    revision: 1,
    models: [{id: 'lamp', revision: 1, size: [1, 1, 1], voxels: new Uint8Array([1])}],
    instances: [{id: 'lamp', modelId: 'lamp', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,3,0,1]}],
    materials: [{id: 1, type: 'emit', color: [1, 0.8, 0.5], emission: 5}],
    environment: {groundColor: [0.8, 0.8, 0.8], skyIntensity: 0},
  },
  candidates: 8,
  denoise: false,
});
await tracer.ready;
const image = await tracer.renderImage({width: 64, height: 64, samples: 8, signal: AbortSignal.timeout(30_000)});
tracer.dispose();
engine.dispose();
```

This is independent resampled importance sampling, without spatial or temporal reservoir reuse. It only changes
emissive surface lighting; camera emission, delta paths, sun, area lights and the environment retain their treatment.
Every valid candidate evaluates visibility, and directional proposals also trace an intersection. Increasing the
candidate count costs work; no wall-time speedup or universal variance reduction is claimed. Native WebGL2 reports
`unsupported` with [setup help](https://margoengine.com/errors#voxel-pathtracer); the WebGL2 compatibility layer runs
the variant. The GPU regression keeps a 2x squared-error reduction requirement on its fixed 1,024-emitter ceiling
scene at 32 samples against an 8,192-sample baseline reference. See `tests/restir-browser.mjs`.

## Caustic path guiding

`margoengine/voxel-pathtracer/guiding` (or `@margoengine/voxel-pathtracer/guiding`) exports
`GuidedVoxelPathTracer`. It draws a share of pure diffuse continuation directions toward the scene's
glass and mirror bounds, then traces the actual voxels and Fresnel events. `guideStrength` is finite
from 0 to 0.95, default 0.5. Zero uses the original kernel exactly. The cosine share retains support
outside every bound. All overlapping bounds contribute to the mixture PDF, including direct-light MIS.

```ts
import { Engine } from 'margoengine/core';
import { GuidedVoxelPathTracer } from 'margoengine/voxel-pathtracer/guiding';
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [3, 2, 5], target: [0, 0, 0]},
});
const tracer = GuidedVoxelPathTracer.attach(engine, {
  scene: {
    revision: 1,
    models: [{id: 'glass', revision: 1, size: [1, 1, 1], voxels: new Uint8Array([1])}],
    instances: [{id: 'glass', modelId: 'glass', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, -0.5,1,-0.5,1]}],
    materials: [{id: 1, type: 'glass', color: [1, 1, 1], ior: 1.5}],
    lights: [{position: [0, 4, 0], direction: [0, -1, 0], width: 1, height: 1,
      color: [1, 0.8, 0.5], intensity: 10}],
    environment: {groundColor: [0.8, 0.8, 0.8], skyIntensity: 0},
  },
  guideStrength: 0.5,
  denoise: false,
});
engine.start();
window.addEventListener('pagehide', () => {
  tracer.dispose();
  engine.dispose();
}, { once: true });
```

This starts a progressive viewport immediately. A preview remains interactive while the guided
pipeline compiles in the background; module initialization does not wait for a driver compilation.
For an off-screen image, use `renderImage` as described in [Captures, float images and picks](#captures-float-images-and-picks).

The guide reuses the existing deflector table: at most eight static, orthogonal glass instances whose
used refracting material is pure smooth non-dispersive glass, plus eight mirror instances. Other objects
and all other BSDFs retain path sampling. Scene changes update the table automatically. Empty tables
retain the baseline random stream. The guide samples visible box faces by their world area and converts
their density to solid angle. Inside a bound it samples the enclosing faces. Empty space inside a sparse
model's box and below-surface directions retain their correct zero contribution. There is no learning,
photon storage, density-estimation blur or added persistent GPU allocation.

Roulette uses throughput with the accumulated cosine/mixture importance factor removed from its
survival heuristic, so it does not immediately discard the paths the guide finds. Actual throughput
is still divided by actual survival. The heuristic scale stays in `1e-20..1e20`, survival in `0.05..1`
after bounce three; the ordinary bounce caps still apply.

This is a geometry prior: convergence can improve when small glass objects carry important light paths,
and can worsen when the chosen objects contribute little. No universal variance or wall-time gain is
claimed. Native WebGL2 gives `unsupported` with [setup help](https://margoengine.com/errors#voxel-pathtracer);
the WebGL2 compatibility layer runs the guide. `tests/guiding-browser.mjs` requires 2x lower squared
RGB error on its fixed small-glass caustic scene, checks energy against independent baseline tracing,
overlapping-bound unit-furnace values, empty/huge bounds, disposal and real device restoration.

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
- **Half-block shapes** (addition). A model's `shapes` (and each block's, with `blocks`) gives one byte per cell in
  `voxels` order: 0 or 255 for a whole cell, else an octant mask, bit `x + 2y + 4z` for the half cell at (x, y, z) (0
  the low half on that axis, 1 the high), as `shapeOctants` of `@margoengine/voxel` gives for slabs and stairs. A
  shaped cell is hit, shadowed, entered and left as its filled half blocks only; `raycast` reports the box face hit and
  its point. Bricks holding a shaped cell carry 512 more bytes for the masks. A cut-out shaped cell is cut per run
  through its filled half blocks (the texel where the ray enters them, else the one where it leaves), and an emissive
  one is light-sampled as quarter faces, mid-cell ones included.
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
  Index-matched glass (`ior: 1`) also preserves energy around an enclosed diffuse voxel: inverse-refraction
  light proposals that reproduce the same direction are offered once, including near-identity refraction.
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
  - `contactTransmission` (blend): a ray leaving the volume into the air passes only with the glass share's
    probability, else it scatters back inside off the other lobes (MagicaVoxel's partly transparent glass and blends).
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
| Physical sky (addition) | `environment.physicalSky`: `{turbidity (1.7-10, default 3; below 2 read as 2), intensity (radiance per kcd/m^2, default 0.1)}` | Preetham, Shirley and Smits' daylight model for `sunDirection`, baked to a 1024 x 512 map and importance sampled like one; its chromaticity is kept on the daylight side of the CIE daylight locus, which the published fit leaves toward the horizon (a pink band); black below the horizon (a sun below it is taken on the horizon). The sun disk stays the `sun*` light. Not together with `map`. |
| Environment map (addition) | `environment.map`: equirectangular linear RGB(A) floats, `intensity`, `rotation` about +Y | Replaces the constant sky; filtered bilinearly; importance sampled by luminance x sin(theta). Its centre column faces -Z, three quarters +X. |
| Emissive voxels | Any material with `emission > 0` | Faces sampled by emitted power, instances by power x area. |
| Uniform fog (addition) | `environment.fog`: `{density (extinction per world unit), color?, anisotropy?}` | Rays outside volumes fade over distance toward the fog's glow, the sky and sun light it scatters (Henyey-Greenstein, no shadows); rays leaving the scene see only the glow; the sun reaches surfaces only through it; emissive voxels and area lights are attenuated by distance. |
| Area lights (addition) | `scene.lights`: `RectAreaLight` from `@margoengine/math` (`position` centre, `direction`, `width`, `height`, `up`), radiance `color * intensity`, `twoSided`, plus traced-only `opaque` and `visible` | The same light list as raster area lights (`castShadow` is raster only). Solid panels by default: seen, reflected and casting shadows (from the sun, the sky, emissive voxels and each other); a one-sided light's back is black. `opaque: false` keeps the earlier see-through light (no shadows, no back face). Dark (`intensity` 0) solid panels stay as occluders. At most 256. |

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
  linearly per sample by default (`motionInterpolation: 'matrix'`). With `motionInterpolation: 'trs'` translation and
  scale move linearly and rotation along the shortest arc, so spinning objects keep their shape (no shear; the
  handedness must not change). With `shutter` above 0, an interval that becomes singular, has shear or flips handedness
  throws `RangeError` (from `attach`, `setScene` or `setOptions`; the old scene stays). Instance records are 160 bytes,
  plus 64 for each 'trs' instance.
- **Camera motion blur (addition):** `previousCamera` (`{position, target, up?, fov?}`, the pose at shutter open) with
  `shutter` above 0 blurs the camera's own move toward the engine camera (shutter close), sharing the instances' time
  per sample. Projection, near and far are the engine camera's; the corner rays and lens axes are interpolated
  linearly, exact for translations and close for small turns.
- **Panorama and fisheye (addition):** `projection: 'panorama'` renders an equirectangular 360 x 180 degree view around
  the camera position (azimuth across the image, elevation down it, the view direction at the centre, up as the
  camera's); `panoramaFit: 'height'` keeps 180 degrees down the image and the same angle per pixel across
  (MagicaVoxel's Pano lens). `projection: 'fisheye'` renders a circular fisheye whose circle is the image height,
  `fisheye.mapping` `'equidistant'` (angle proportional to radius), `'equisolid'` (equal area) or `'stereographic'`
  (angles kept; fills the frame), `fisheye.fov` up to 360 degrees; pixels outside the circle are black. Both ignore the camera's projection and depth of field; overlays drawn later are not
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
| `panoramaFit` | `'width'` | `'width'` (360 degrees across), `'height'` (180 down, same angle per pixel across) | yes |
| `fisheye` | `{mapping: 'equidistant', fov: 180}` | mapping `'equidistant'`, `'equisolid'` or `'stereographic'`, fov above 0 to 360 | yes |
| `distortion` | none | `{k1, k2, p1, p2}`, each -1 to 1, or null | yes |
| `clamp` (largest luminance a path may add; biased firefly control) | Infinity | above 0 | yes |
| `toneMapping` | `'neutral'` (Khronos PBR Neutral, Margo's display transform) | `'neutral'`, `'linear'`, `'aces-narkowicz'` (Narkowicz's ACES fit after x0.6), `'agx'` (AgX, the same transform as Tonemap and ImagePost) | no |
| `gamma` (display encoding after tone mapping) | sRGB | 1-5 (power 1 / gamma), or undefined for sRGB | no |
| `bounceLimits` (events per kind on top of `maxBounces`) | none | `{diffuse?, specular?, scatter?, subsurface?, internalReflections?}` each 1-64 (`internalReflections` 0-64: reflections inside glass kept in full, each later one goes on with probability 1/2), or null | yes |
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

`toneMapping:'agx'` runs the engine's shared AgX transform (`packages/shared/agx.js`) in the display shader, and the
same math on the CPU for `capture`; it needs no extra data or textures. HDR viewport output stays linear for a
following ImagePost or Tonemap pass, so the transform runs once. Device replacement recreates owned GPU resources, and
disposal releases them.

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
- Reprojected viewport history uses only the bilinear taps that pass the surface mask. Rejected taps contribute
  neither color nor sample weight; surviving taps retain normalized weights. The controlled native WebGPU and
  WebGL2 regression covers all 16 masks, HDR 32768, zero/exhausted history and actual device replacement. Newly
  visible surfaces can still be noisy; this does not establish a noise-free first frame after a camera move.
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

## On the WebGL2 compatibility layer

Install the layer before `Engine.create` and the tracer runs with nothing else changed: viewport, denoiser, captures,
picks and device restores, with the same options.

```ts
import { Engine } from 'margoengine/core';
import { install } from 'margoengine/webgl2-compat';
import { VoxelPathTracer, type VoxelTraceScene } from 'margoengine/voxel-pathtracer';
const canvas = document.querySelector('canvas')!;
const scene: VoxelTraceScene = {
  revision: 1,
  models: [{ id: 'cube', revision: 1, size: [1, 1, 1], voxels: new Uint8Array([1]) }],
  instances: [{ id: 'cube-1', modelId: 'cube', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  materials: [{ id: 1, color: [0.8, 0.75, 0.7], type: 'diffuse' }],
};
await install();
const engine = await Engine.create(canvas);
const tracer = VoxelPathTracer.attach(engine, { scene });
engine.start(); // the viewport progresses while full tracing compiles
window.addEventListener('pagehide', () => {
  tracer.dispose();
  engine.dispose();
}, { once: true });
```

The WebGL2 kernels are the WebGPU ones except `trace`: its stores cannot run on the GPU on WebGL2, so the same sample loop
runs in a fragment shader writing four `rgba32float` targets and a small kernel adds them to the image. That route is a
lazy chunk (`src/compat.ts`) only the layer downloads. Results agree with the analytic checks at the same tolerances, and
the `trace` module stays the one source of the maths.

Compile time decides whether this is useful. ANGLE on Vulkan compiled everything in about 20 s on an RTX A6000; ANGLE on Direct3D 11, the default on Windows, does not finish `trace`: Microsoft's shader compiler was still running at the 50 minute limit, three times (its smaller kernels take 27 to 86 s each), while the page kept drawing at full rate. So that route shows the raster image and never a traced frame (`docs/known-bugs.md`).
Frames before `ready` show the raster image, so nothing stops working in the meantime. Speed against native WebGPU on one
GPU, diagnostic because other jobs ran: a 1500 x 1100, 64-sample denoised render took 6.4 s against 2.3 s, and a
400 x 240 viewport frame 24 ms against 9 ms.

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
| Voxel data | grids plus 512-byte mixed bricks (1,024 bytes with half-block shapes) within the device's `maxStorageBufferBindingSize` (WebGPU default 128 MiB: about 262,000 mixed bricks; uniform bricks cost one word) |
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

Committed run, 2026-10-31, same PC (RTX A6000, Edge 156, one exclusive run of all five GPU scripts and the timing case, every check passed; every number, the adapter and the commit are in `bench/results.json`, written by `bench/run.mjs`): material scene 19.92 ms and 95 MiB, denoised 28.05 ms and 348 MiB; dense 256^3 model 14.35 ms and 98 MiB, denoised 18.35 ms and 256 MiB, 4 samples per frame 61.54 ms and 98 MiB. These rows run slower than the table above, which was measured on 2026-10-20; compare rows from one run only.

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

- `tests/*.test.js` (Node, 72 tests, about 1.4 s; part of `npm run verify`): validation and atomic failure, dense
  indexing, all 255 palette identities, transformed/mirrored/hidden instances, model reuse by revision, voxel traversal
  against a brute-force slab test (2,000 random rays over 5 models whose sizes are not multiples of 8), resets for each
  camera/size/scene/option change, enable/disable, `maxSamples`, the denoiser's passes (the caustic chain only for
  materials that focus light), a new denoised image after every restart (also one that converges in a single frame)
  and when the viewport's history is kept, used or dropped, upload reuse, growth to the binding limit, disposal, device
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
    panorama directions, 0.09 px for 3 more fitted to the height, 0.08 px for 7 equidistant (180-degree) and equisolid
    (200-degree) and 0.03 px for 4 stereographic (90-degree) fisheye directions and
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

`magicaVoxelMaterial(id, rgb, attributes, gamma?)`, `magicaVoxelLighting(renderObjects)`, `magicaVoxelCamera(camera,
renderObjects)`, `magicaVoxelModel(id, revision, size, xyzi)` and `magicaVoxelMatrix(size, translation, rotation)`
turn a `.vox` file's palette, MATL materials, rOBJ render settings, rCAM camera and models into this tracer's inputs
(MagicaVoxel is z-up; tracer = MagicaVoxel (x, z, -y)). `magicaVoxelCamera` reports the projection: orthographic for
the orth and iso modes (`orthographicHeight` tall, the radius; iso at the isometric pitch with the stored yaw; merge
its `environment`, which turns the ground fade off as MagicaVoxel does in these views), and for the lens projections
tracer `options` (Pano: the panorama fitted to the height; lens projection 1, SG: stereographic); all measured against
MagicaVoxel's renders (100% of pixels within 3 levels). `magicaVoxelLighting` also returns the tracer options that
reproduce MagicaVoxel's choices (ACES with gamma 2.2, bounce caps 2/5/5, no transparent shadows, the sun on diffuse
lobes only and not in media, no energy compensation) and lists the settings it does not reproduce yet. With
`{look: 'margo'}` it keeps the file's film, colours, sky, sun and fog but traces light physically (sun highlights on
metal and glass, light through glass, sun-lit clouds, rough metal keeping its energy, no bounce caps): MagicaVoxel's
look, lit correctly.

The mapping was measured from MagicaVoxel 0.99.7's own renders of calibration scenes (a black box: its code was not
read): palette and light colours are linear by the film gamma's power (default 2.2), sky radiance is its intensity, sun irradiance 5 x intensity,
emitters `colour x (1 + 3 x emission x 10^power)`, metal reflectance `min(1, specular x colour)` with GGX width
0.13 x roughness, glass colour through `_d` absorption only, media extinction `_d` per voxel, fog extinction
0.001 x `_d`. Its atmosphere sky (`_env _mode 1`) is reproduced by `bakeAtmosphere` (exported with
`atmosphereRadiance` and `atmosphereTransmittance`): single scattering with Rayleigh, Cornette-Shanks Mie and ozone
terms fitted to 16 of MagicaVoxel's panoramas (0.3-1 levels mean for the default and singly changed settings), baked
to a 256 x 512 map in about 0.55 s (below the horizon the horizon's light, which the ground fades into, or with the
ground off that light fading into a dim surface: `bakeAtmosphere`'s `below` argument); the sun then lights at 10 x
intensity through the air's transmittance. Its display settings
map to `environment.background`, `vignette`, `edges` and `grid`; a transparent background (`_setting _bg_a`) is
reported as `transparentBackground` (pass `transparent: true` to `capture`) and non-cubic voxels (`_setting _scale`)
as `voxelScale`, which `magicaVoxelMatrix` takes as its fourth argument (the scene scaled about the origin); its image sky (`_env _mode 2`) needs the decoded HDR
file passed as `magicaVoxelLighting(objects, { imageSky })` (the result's `imageSky.path` names it). Six default-lit scenes (diffuse, metal at roughness 0.2 and 0.8, glass, emitter, cloud) match
MagicaVoxel's images within 3 of 255 levels on 99.2-99.97% of pixels; the calibration scripts are in `tests/magicavoxel/`. On the same scenes at 960 x 800 and 1024 samples this tracer takes
1.7-1.85 s on an RTX A6000.

Pass `magicaVoxelLighting(...).options.gamma` to material conversion when the file changes `_film _gam`.
The omitted argument keeps the default 2.2; explicit gamma must be finite and within 1..5.
`magicaVoxelLinear(value, gamma?)` uses the same conversion. Light, ground, edge and grid colours use the
file gamma automatically. Fog and atmosphere density colours retain their raw coefficient convention.

```ts
import { magicaVoxelLighting, magicaVoxelMaterial } from '@margoengine/voxel-pathtracer';

const lighting = magicaVoxelLighting([{ _type: '_film', _gam: '1', _aces: '0' }]);
const material = magicaVoxelMaterial(1, [128, 128, 128], { _type: '_diffuse' }, lighting.options.gamma);
console.log(material.color); // [128 / 255, 128 / 255, 128 / 255]
```

## Parity status and known gaps

Implemented and verified as above: voxel traversal with shared transformed instances; diffuse, plastic, metal, glass,
emissive, blended and media materials; subsurface scattering by random walk; sun, sky, ground, HDR environment maps,
emissive voxels and area lights with next-event estimation; depth of field with round and polygonal apertures;
instance motion blur; perspective and orthographic cameras; progressive accumulation with a stable seed; a denoiser;
PNG and float captures with cancellation; device-loss recovery.

Not done or not verified, stated plainly:

- **MagicaVoxel parity is not complete:** next to a subsurface block under the sun at diffuse cap 4 some tiles are
  7-16 levels off; subsurface is fitted at one density only;
  glass over a lit floor is 1-2 levels brighter; under the atmosphere, a view into a low sun matches on 98.7% of
  pixels and very dense air settings by 2-3 levels on average; with the ground off its sky below the horizon is
  within 4.2 levels on average (2-degree blocks), not per pixel.
- **Denoiser:** a classical filter, not a learned one. While the camera moves, surfaces it uncovers are noisy for a
  few frames, and for a few frames after it stops the history makes diffuse and cloud scenes slightly worse than
  without it (numbers under "Viewport"). Averaged over four seeds against 131,072-sample references
  (noise removed in quadrature) it lowers the error x2.46, x2.32, x2.24 at 4, 16, 64 samples on the material scene and
  x2.20, x2.09, x2.03 on the caustic scene (whose undenoised error rose a little when the glass walks became one per
  point; its denoised error stayed within 4%). Edge pixels gain less.
- **Speed:** light sampling through glass costs time even in scenes without glass (see "Measured performance").
- **Caustics:** light turned more than once by glass (or by glass and a mirror), glossy reflections of a small sun and
  glass beyond the 8 light-sampled instances are found by path sampling only and converge slowly; `clamp` trades that
  noise for bias. The optional `/guiding` entry directs pure diffuse continuations toward the existing deflector
  bounds; it does not add objects to the eight-per-kind table or solve specular manifolds.
- **Root-entry simplifications:** RGB everywhere except dispersive glass, which samples one wavelength per path (no hero-wavelength
  sharing, so dispersion converges with colour noise); refracted radiance is not scaled by the squared
  index ratio; media are homogeneous per palette index with grey extinction; the ground is a plain diffuse plane;
  default matrix motion and the camera's corner rays interpolate linearly (matrix rotations can shrink; explicit TRS
  motion preserves rigid shape); no chromatic aberration; the physical sky is Preetham's (no multiple scattering, ozone or night sky);
  bloom comes from `@margoengine/post`. The optional `/sky` entry replaces the Preetham environment with Hillaire
  multiple scattering, ozone and stylized night, as described below. The optional `/spectral` entry adds
  deferred hero wavelengths, index-ratio scaling and a chromatic thin lens, with its limits below.
- **Measured only on one machine** (RTX A6000, Edge 155, Windows). Other GPUs, browsers and the editor's own scenes are
  untested.

## Editor helpers (`@margoengine/voxel-pathtracer/studio`)

Outside the root entry: `studioPresets()` / `studioPreset(name)` (lighting presets as a `TraceEnvironment`),
`PreviewBudget` (samples per frame while the view changes and after it settles), and material builders (`diffuse`,
`metal`, `glass`, `emit`, `blend`, `media`, `materialBuilders`, `paletteFromMaterials`).

## Multiple-scattering sky (`@margoengine/voxel-pathtracer/sky`)

Install the optional `@margoengine/sky` peer to bake Hillaire's multiple-scattering atmosphere, ozone and a stable
stylized night into the tracer's existing importance-sampled HDR environment. The bake also returns the separate
sun with its atmospheric transmittance. The sun disc is excluded from the map, so it is sampled only once.

```ts
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { VoxelPathTracer } from '@margoengine/voxel-pathtracer';
import { traceSkyEnvironment } from '@margoengine/voxel-pathtracer/sky';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const environment = await traceSkyEnvironment(engineRuntime(engine).gpu!, {
  hours: 18.2, signal: AbortSignal.timeout(60000),
});
const tracer = VoxelPathTracer.attach(engine, {
  scene: { revision: 1, models: [], instances: [], materials: [], environment },
});
engine.start(); // retain progressive feedback while full tracing compiles
window.addEventListener('pagehide', () => {
  tracer.dispose();
  engine.dispose();
}, { once: true });
```

Options and defaults: `width: 256` (1..2048), `height: 128` (1..1024), `hours: 12` (finite, wraps at 24),
`sunDirection` (optional, nonzero, normalized; overrides hours), `altitude: 0` metres (0..100000000),
`sunIlluminance: 20` (0..1000000), `atmosphere` (Earth; coefficients and ground albedo 0..1, radii and scale heights
at most 100000 km), `multipleScattering: true` (false isolates single scattering), `night: {}` (the sky package's
stylized gradient, stars and phased moon; false disables it), and optional `signal`. Night settings follow
`SkyNightOptions`; twinkle is always disabled and time held at zero. Other night numeric magnitudes are at most
1000000, except the normalized moon direction. Unresolved procedural stars retain their mean integrated light.

The bake reuses the sky package's 256x64 transmittance and 32x32 multiple-scattering LUTs and marches 64 steps per
map texel. It uses GPU compute, returns owned RGBA Float32 texels, and frees temporary GPU resources on success,
cancellation or failure. The returned map works with the existing tracer and device restoration. WebGL2 works
through `@margoengine/webgl2-compat`; a plain WebGL2 context is refused with coded `unsupported` and a help link.
Rebake when time, atmosphere or observer altitude changes, then update the scene revision. This is a distant
environment, with isotropic higher scattering orders, a spherical planet and stylized night; it does not add
aerial perspective or astronomical catalogues. Ground bounce comes from the atmosphere's `groundAlbedo`;
the tracer's optional local ground remains a separate surface. No root entry, core or stage feature was added.

The environment bake requires Float32-distinct planet/atmosphere radii and vertical scattering optical depth
at most 6 in every channel (Rayleigh plus scattering Mie, integrated from ground to top). This keeps a
representable escape probability in the geometric-series LUT. Minimum observer clearance is 1 metre or
2 to 4 Float32 radius steps, whichever is larger. Night moonSize must be at least 0.000001 radians; narrower
discs are outside the bake domain. Both equirectangular dimensions determine the night filtering footprint.

## Heterogeneous coloured media

`margoengine/voxel-pathtracer/media` (or `@margoengine/voxel-pathtracer/media`) exports
`MediaVoxelPathTracer`. A media palette material adds `extinction: [red, green, blue]`, per world unit,
each finite in 0..1000000. It overrides `density`; when absent, extinction is the existing scalar density
(default 1) in every channel. `color` remains single-scattering albedo; `anisotropy` defaults to zero.
Different palette indices supply different density, absorption colour, albedo and phase function throughout
a model. Model-local palettes work too. Empty cells are vacuum, and the existing half-cell shapes apply.

```ts
import { Engine } from 'margoengine/core';
import { MediaVoxelPathTracer } from 'margoengine/voxel-pathtracer/media';
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [3, 2, 5], target: [0, 0, 0] },
});
const tracer = MediaVoxelPathTracer.attach(engine, {
  scene: {
    revision: 1,
    models: [{ id: 'smoke', revision: 1, size: [1, 1, 3], voxels: new Uint8Array([1, 2, 1]) }],
    instances: [{ id: 'smoke', modelId: 'smoke', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, -0.5,-0.5,-1.5,1] }],
    materials: [
      { id: 1, type: 'media', color: [0.8, 0.9, 0.95], extinction: [0.2, 0.4, 0.8] },
      { id: 2, type: 'media', color: [0.6, 0.6, 0.7], extinction: [0.8, 0.3, 0.1], anisotropy: 0.4 },
    ],
    environment: { skyColor: [1, 1, 1], sunIntensity: 3, groundColor: [0.5, 0.5, 0.5] },
  },
  denoise: false,
});
engine.start();
const capture = document.createElement('button');
capture.textContent = 'Render 32 x 32 image';
document.body.append(capture);
capture.addEventListener('click', async () => {
  capture.disabled = true;
  try {
    const image = await tracer.renderImage({ width: 32, height: 32, samples: 16, signal: AbortSignal.timeout(30000) });
    console.log(image);
  } finally {
    capture.disabled = false;
  }
});
window.addEventListener('pagehide', () => {
  tracer.dispose();
  engine.dispose();
  capture.remove();
}, { once: true });
```

The viewport starts while the full tracing pipelines compile. The button explicitly requests and
awaits the same 16-sample float image; `renderImage` waits for readiness internally. Initialization
does not depend on a capture. Capture errors propagate, and page exit disposes both owners.

The existing hierarchy walks piecewise constant palette regions. Shadow rays integrate RGB optical depth
analytically. Free flights mix the three exponential channel distributions and divide by their actual
mixture density (or survival probability), retaining clear channels and avoiding underflow in the ratios.
Pure absorption is deterministic. Emissive chromatic cells integrate emission analytically, including
zero and very small extinction. Neutral media retain the existing scalar sampling. The entry uses no
additional GPU allocation, density resampling, majorant or Wasm. Its palette conversion reserves media's
unused metal reflectance; `metalColor` has no meaning on a medium.

This is RGB transport over a palette grid, without continuous density interpolation, procedural density,
VDB import, fluorescence or overlapping-medium composition. The root tracer's path, scene and bounce
limits apply, including its finite boundary-iteration guard; highly layered grids may exhaust that guard
before the bounce limit. Disjoint instances and opaque objects beside the grid are supported. The root
tracer's `environment.fog` remains its separate scalar artistic effect. Native WebGPU and the WebGL2
compatibility device run the entry; plain WebGL2 reports linked `unsupported`. Lifecycle, cancellation,
disposal and scene replacement use the root APIs. No reference-renderer equality or speed claim.

Medium boundaries now offset the intersection query only, preserving the physical path length used by
absorption, emission and scattering. This corrects the root tracer too: three one-unit vacuum-emitting
cells produce radiance 3, rather than losing 0.006 to the old 0.002-cell offsets.

At negative grazing directions, cell and brick starts use the forward half-open interval (ceil minus one),
so a rounded point on a boundary cannot repeatedly re-enter the cell behind it. Both voxel and brick
boundary regressions check emitted path length with Float32 camera-coordinate uncertainty included.

## Triangle meshes beside voxels

`margoengine/voxel-pathtracer/mesh` (or `@margoengine/voxel-pathtracer/mesh`) exports
`MeshPathTracer`. Its asynchronous `create` builds a feature-local Rust/Wasm BVH and attaches
the root integrator. Triangles and voxels intersect the same camera, shadow and secondary paths.
The root package imports neither this entry nor its Wasm. No CAD or model parser is included.

```ts
import { Engine } from 'margoengine/core';
import { MeshPathTracer } from 'margoengine/voxel-pathtracer/mesh';
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 1, 4], target: [0, 0, 0]},
});
const tracer = await MeshPathTracer.create(engine, {
  scene: {
    revision: 1, models: [], instances: [],
    materials: [{id: 1, type: 'diffuse', color: [0.3, 0.6, 0.8]}],
    meshes: [{id: 'panel', material: 1,
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2])}],
    environment: {skyColor: [0.7, 0.8, 1], sunIntensity: 3},
  },
  signal: AbortSignal.timeout(30_000),
  denoise: true,
});
await tracer.ready;
const image = await tracer.renderImage({
  width: 64, height: 64, samples: 16, signal: AbortSignal.timeout(30_000), aovs: true,
});
tracer.dispose();
engine.dispose();
```

Mesh positions are static, indexed, world-space Float32 xyz triplets, finite within +/-1e8 units;
each mesh names a scene palette material (1..255). Empty meshes and scenes work. Indices must be
Uint32 triangle triplets referencing existing vertices. Degenerate triangles are rejected. At most
1,000,000 triangles and 128 MiB of input are accepted, and the combined scene storage must fit the
device's binding limit. Every triangle adds 64 bytes and each binary BVH node 32 bytes, at most
two nodes per triangle. Builds use a spatial median, outward-rounded bounds and a stackless walk.
The ray-space predicate resolves uncertain edge signs by subtracting exact integer significand
products before rounding, retaining shared edges under shader arithmetic contraction. This is
Float32 geometry, without a double-precision coordinate fallback or
a promise of exact intersection for all ill-conditioned triangles.

Surfaces are flat-shaded and double-sided. Diffuse, plastic, metal, emission, blend and glass use
the root BSDFs. Meshes have no UV textures, alpha cutouts, vertex normals, instancing, skinning or
motion blur. For glass, supply a closed, consistently outward-wound shell of one material, with
the camera outside; overlapping/nested mesh volumes and mesh media are unsupported. Mesh emission
is reached by path sampling; it has no emissive-triangle light sampler or prism/mirror light guide.
Finite point lights and zero-angular-size suns behind a specular chain retain that sampling limit.
Existing voxel lights, glass, media, environments, capture tiling and bounce limits remain available.
Diffuse surfaces inside a glass shell receive distant light by path sampling. The voxel-box
inverse-refraction sampler does not apply to triangle shells; their path weights retain the
entire contribution. Straight-through walks from outside the shell still use matched MIS.

`setScene(scene, {signal?})` returns a promise and rebuilds all triangles before atomically replacing
the scene. Caller arrays are copied before waiting. Failed or cancelled updates preserve the old
scene; overlapping updates commit in call order. Cancellation is checked around synchronous Rust
work; use a worker when an in-flight CPU build must be interruptible. `whenIdle()` waits for updates
and captures. `enabled`, `ready`, `status`, `error`, `options`, `stats`, rendering options, captures,
reset, disposal and `Symbol.dispose` follow the root lifecycle. `raycast` remains CPU voxel picking.
With image `aovs`, `instance <= -4` means triangle ordinal `-instance - 4`, in mesh order then index
triplet order; `palette` is zero for triangles. Sky/ground/area and voxel ids keep their root meanings.

Native WebGPU and WebGL2 compatibility execute the same geometry path. Plain WebGL2 returns
`unsupported` with [setup help](https://margoengine.com/errors#voxel-pathtracer). Generated GPU tests
assert constant emission, analytic sunlight, mutual shadows and mirror paths, shared edges, empty
geometry, glass furnace values, real device replacement and exact raster restoration. They establish
no outside-renderer equality, arbitrary asset coverage or GPU speed claim. The paired CPU preparation
driver requires the Rust output to match an independent scalar builder byte for byte.

## Spectral transport and chromatic lens (optional)

`SpectralVoxelPathTracer` from `@margoengine/voxel-pathtracer/spectral` traces one RGB path until
wavelength-dependent transport is needed. At the first dispersive glass event it importance-samples
one hero wavelength over 380-780 nm and weights only subsequent contributions by its CIE response
divided by the wavelength density. An active chromatic lens samples that hero at the camera instead.
Paths without dispersion receive no spectral weight, have exactly zero channel spread in a white
scene per sample and share the root tracer's random stream. No identical paths are replayed.
Every transmitted dielectric
sample, including refracted light-sampling walks, scales radiance by `(nIncident/nTransmitted)^2`.
The root tracer retains its existing colour and transport convention.

```ts
import { Engine } from '@margoengine/core';
import { SpectralVoxelPathTracer } from '@margoengine/voxel-pathtracer/spectral';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {
  camera: { position: [0, 0, 4], target: [0, 0, 0] },
});
const tracer = SpectralVoxelPathTracer.attach(engine, {
  scene: {
    revision: 1,
    models: [{ id: 'glass', revision: 1, size: [1, 1, 1], voxels: new Uint8Array([1]) }],
    instances: [{ id: 'glass', modelId: 'glass',
      matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, -0.5,-0.5,-0.5,1] }],
    materials: [{ id: 1, type: 'glass', color: [1, 1, 1], ior: 1.5, abbe: 30 }],
    environment: { skyColor: [1, 1, 1] },
  },
  aperture: 0.02,
  focusDistance: 4,
  lensAbbe: 30,
  focalLength: 0.05,
});
await tracer.ready;
const image = await tracer.renderImage({ width: 64, height: 64, samples: 16,
  signal: AbortSignal.timeout(120000) });
console.log(image.color.length);
tracer.dispose();
engine.dispose();
```

The two lens settings are fixed at attachment. `lensAbbe` defaults to 0 (achromatic), otherwise 5-200;
`focalLength` defaults to 0.05 world units, range 1e-6-1e6. In metre scenes 0.05 is 50 mm.
The root's `aperture` and `focusDistance` keep their defaults and remain mutable. Chromatic lens power is
`P(lambda) = P(d) * (n(lambda)-1)/(n(d)-1)`, with the root's Cauchy/Abbe model. Only the camera projection
with a nonzero aperture uses the lens. Other projections and a pinhole remain achromatic. A slope formulation
stays finite at infinite and virtual wavelength focus distances. This is longitudinal colour from a
paraxial thin lens, without a physical multi-element lens, diffraction, lens transmission or lateral colour.

Material/light coefficients remain RGB; CIE analytic colour weights integrate wavelength-dependent paths.
This is not RGB-to-spectrum reconstruction or measured spectral colour fidelity. A capture's `wavelength`
selects one monochromatic path with unit RGB weight. Albedo, normal and depth use hero samples; instance/palette IDs retain the root centre-ray rule. Transparent alpha is geometric coverage averaged uniformly over wavelengths (or the fixed capture wavelength). A sample is one path; there is no equal-cost speed or convergence claim. This subclass is independent
of the other tracer subclasses. Native WebGPU and WebGL2 compatibility run the feature; plain WebGL2
raises coded `unsupported` with help. Tests use generated scenes, analytic radiance and finite-slab disk
coverage; no outside renderer or production lens was used.
