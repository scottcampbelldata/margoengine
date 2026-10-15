# @margoengine/environment

HDR, EXR and UltraHDR loading, GPU image-based lighting (prefiltered specular, spherical-harmonic irradiance, BRDF LUT) applied to meshes and glTF models, environment and color backgrounds, and scene-wide fog for Margo Engine on WebGPU.

Build from source with `npm run build` in `packages/environment`.

Covers the common cases of Three.js `RGBELoader`, `EXRLoader` (single-part scanline EXR with NONE, RLE, ZIPS, ZIP or PIZ; no PXR24, B44 or DWAA/DWAB, see Limits), `UltraHDRLoader`, `PMREMGenerator`, `scene.environment`, `scene.background` (texture with `backgroundIntensity`, `backgroundRotation` and `backgroundBlurriness`, or a color) and `scene.fog` (`Fog`, `FogExp2`), plus froxel volumetric fog with light shafts (the `webgpu_volume_lighting` example's job) in the optional `/volumetric` entry.

```ts
import {Engine} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Environment, EnvironmentBackground, EnvironmentLighting, loadEnvironmentImage} from '@margoengine/environment';

const canvas = document.createElement('canvas');
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const image = await loadEnvironmentImage('/studio.hdr'); // .hdr, .exr or UltraHDR .jpg, picked by signature
const environment = await Environment.attach(engine, image, {rotation: 0.5}); // rebuilds itself after a device loss
EnvironmentBackground.attach(engine, environment, {exposure: 1, blur: 0});
const lighting = EnvironmentLighting.attach(engine, environment);               // core meshes: IBL replaces the constant ambient term
lighting.add(await loadGLTF(engine, '/helmet.glb'));       // glTF-pro models: same, scaled by occlusion maps
engine.start();
// On teardown: engine.dispose() disposes every plugin; lighting.dispose() also detaches it from models.
```

A plain color (or vertical gradient) background and fog, without any environment map:

```ts
import {Engine} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {ColorBackground, Fog} from '@margoengine/environment';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
ColorBackground.attach(engine, {color: '#bcd4e6'});            // scene.background = new Color(...)
const fog = Fog.attach(engine, {color: '#bcd4e6', near: 10, far: 80}); // fogs core meshes; {density: 0.02} for FogExp2; heightFalloff for height fog
fog.add(await loadGLTF(engine, '/helmet.glb'));                // glTF-pro models, opaque and blended
fog.far = 120;                                                 // every option is a live property
```

## Scene lighting, fog and color backgrounds

- **`EnvironmentLighting(environment)`** is an engine plugin and a glTF-pro `LightingEffect`. As a plugin it runs a pass at order -1 (after shadows, sky, clustered lights and the post-processing captures) that patches core's mesh shader through `PassContext.shader`, adding `margoAmbient` (declared just before as `let margoAmbient=iblShade(...);`) to the `let linear=` term in place of the constant ambient `lighting.radiance[3]`; core itself is not changed. `add(model)` (or `model.addLighting(lighting)`; `applyTo(model)` is a deprecated alias) does the same for glTF-pro's shader through its declared `ambient` lighting hook (glTF-pro README, "Lighting hooks"), replacing its hemisphere `ambient()` and multiplying IBL by the occlusion map. The five IBL bindings are 20 to 24 in core's group 0 and glTF-pro's group 2. While the environment is restoring or disposed, or lives on another device, nothing is patched and nothing is bound. Sky's ambient patch is kept and IBL adds to it; terrain wetness does not scale IBL. glTF-pro's physical variant (clearcoat, sheen, transmission, specular) is patched the same way, but its IBL term uses the plain metallic-roughness F0 and its clearcoat and sheen layers keep their hemisphere ambient; unlit materials ignore IBL. **Ambient occlusion**: in core's shader, naming the IBL term `margoAmbient` is a shader convention, not an import (listed in `tests/shader-contracts.test.js`); glTF-pro gets it through its `ambient` hook: post's SSAO (core meshes and registered glTF-pro models) replays `margoAmbient` as the light it occludes, so SSAO darkens IBL diffuse and specular in creases instead of the constant ambient term. Without SSAO the lit output is unchanged; specular occlusion uses the same AO factor as diffuse (an approximation, see post's README).
- **`Fog(options)`** computes `amount = linear (near, far)` or `1 - exp(-(density * d)^2)` from the camera distance, times `exp(-heightFalloff * max(y - height, 0))`, inside the mesh shaders (binding 25), so blended glTF primitives are fogged too (glTF-pro's `output` hook), unlike sky's depth-based post fog. On the canvas it mixes after tone mapping, so a fully fogged pixel shows exactly `color` and matches a `ColorBackground` of the same color; on an rgba16float target (tonemap, ssao, dof, creative PostProcessing) it mixes linear radiance before their tone mapping. Height fog is the per-fragment factor, not an integral along the view ray. The background, particles, VFX, splats and other custom shaders are not fogged. `fog.enabled = false` switches it off by uploading zero-fog parameters (near and far at the float maximum, density 0); the patched shaders and pipelines stay, so switching either way never compiles a shader (HANDOFF 1d''), and off renders the same pixels as no fog (checked on the real GPU). Adding or removing the plugin instead changes the shaders.
- **`ColorBackground({color, bottom})`** draws a full-screen triangle at order 0.5 (after core's opaque meshes, before glTF-pro models so blended primitives composite over it) at reversed-Z depth 0 with a read-only `greater-equal` test, so it only fills pixels whose depth was never written. On the canvas it writes the sRGB bytes exactly (no tone mapping, as Three.js does for a background color); on an rgba16float target it writes the linear value. `bottom` makes a vertical screen-space gradient. Colors are `'#rgb'`, `'#rrggbb'`, `0xrrggbb` or sRGB `[r, g, b]` in 0..1.
- **`TransparentCanvas.attach(engine)`** is the transparent canvas (three.js `alpha: true` with clear alpha 0) without a core change: it reconfigures core's canvas context with `alphaMode: 'premultiplied'` (same device and preferred format) and runs the `ColorBackground` pass writing premultiplied alpha 0, so the page shows wherever nothing is drawn and multisampled silhouettes resolve to valid premultiplied edges. It reapplies itself after `engine.rebootDevice()` (core reconfigures the context opaque, then calls `onDeviceRestored`), and `dispose()` (or `using`) restores the opaque canvas and detaches. Attach no other background with it (`ColorBackground`, `EnvironmentBackground`, `Sky` would fill the pixels again). On the WebGL2 fallback it does nothing; create that renderer transparent: `fallback: canvas => webglRenderer(canvas, {transparent: true})`. Which post effects keep alpha: `@margoengine/post` README. Real-GPU check: `examples/package-benchmarks/transparent-canvas-gpu.mjs`.
- **`ColorOutput.attach(engine, {gamut, hdr, peak, force})`**: Display P3 and HDR canvas output (three.js `outputColorSpace`; WebGPU `colorSpace` and `toneMapping`), zero core bytes. See "Display P3 and HDR output" below.
- All three are built to allocate nothing in steady frames (the browser test measures this for the backgrounds), patch each distinct shader string once (cached), rebuild their GPU state in `onDeviceRestored`, and throw on a shader they do not recognize instead of drawing wrong.

## Volumetric fog and light shafts

`@margoengine/environment/volumetric` is a separate entry (6.7 kB min+gzip on its own; nothing is loaded, compiled or run unless you import and attach it; the root entry is byte-identical without it):

```ts
import {Engine} from '@margoengine/core';
import {Shadows} from '@margoengine/shadows';
import {Clustered} from '@margoengine/clustered';
import {LocalShadows} from '@margoengine/clustered/shadows';
import {Tonemap} from '@margoengine/tonemap';
import {VolumetricFog} from '@margoengine/environment/volumetric';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);                                  // any post capture gives the fog its scene depth
const shadows = Shadows.attach(engine, {distance: 80});  // sun shadows: light shafts through gaps
const lights = Clustered.attach(engine);                 // point and spot lights scatter in the fog
LocalShadows.attach(engine, {lights});                   // ...and their shadows carve it
const fog = VolumetricFog.attach(engine, {density: 0.03, heightFalloff: 0.15, anisotropy: 0.6, shadows, lights});
fog.options.density = 0.05;                              // options are read every frame
```

How it works. A camera-frustum grid of froxels (default 160 × 90 × 64, slices spaced quadratically over `range` metres beyond the near plane, so finer near the camera) is filled by one compute pass: density (uniform, `heightFalloff` above `height`, optional `noise` drifting with `wind`), then the light scattered toward the camera with a Henyey-Greenstein phase (`anisotropy`): the engine's directional light, shadowed through `Shadows`' cascades (four stratified comparison samples along each froxel's depth); `ambient` (default the engine's ambient term, grey); and, with `lights`, every clustered point and spot light in the froxel's cluster (the cluster lists clustered already built this frame), times its `LocalShadows` term when one is attached. Each froxel's sample is jittered within its cell every frame (Halton 2, 3, 5 over 16 frames) and blended with the previous frame's value reprojected at the froxel's centre (`temporal`, default 0.9 history; a still camera reads its own texel unfiltered, so nothing drifts), which removes the stair-stepping of a coarse grid. A second compute step integrates every froxel column front to back (energy-conserving per slice, through a 3 x 3 tent filter across columns) into a 3D texture of in-scattered light and optical depth. The composite then reads the scene depth per pixel (per sample at 4x MSAA), looks the volume up at that distance and blends premultiplied `light + scene × transmittance` over opaque surfaces and the sky (the sky and empty pixels take the fog up to `range`). Perspective and orthographic cameras both work: distances are measured from the camera's near plane along its view axis, read from `camera.matrix`.

It renders in its own passes at order 5 (after opaque meshes, glTF-pro models, the sky and water; before VFX and post effects) and never patches a lit shader, so it adds no texture or sampler to the 16 per stage (gltf-pro README, "Texture bindings"); its compute pass binds 3 sampled textures at most (history, sun cascades, local shadow maps). Scene depth comes from the post capture that owns the scene target (Tonemap, Bloom, PostStack, SSAO, TAA, DOF), at 1x or 4x; without one, pass `depth: () => texture` (for example water's `depthTexture`), otherwise the first frame throws saying so. On an `rgba16float` capture it composites linear radiance; on a display target it tone maps the fog colour like sky fog. Output is premultiplied, so with `TransparentCanvas` the fog in front of empty pixels becomes a translucent layer (alpha = fog opacity) instead of an invalid colour. `fog.texture` exposes the integrated volume (rgba16float, rgb light and a optical depth at each slice's far edge) for custom shaders, such as fogging particles.

**With the other fogs.** VolumetricFog replaces environment `Fog` and sky's `fog` option rather than adding to them: both already darken distant surfaces toward a colour, so running two would fog the scene twice. It throws, naming the other one, while a `Fog` is enabled, sky fog has a density or creative `PostProcessing` has an `atmosphere.density`; a `Fog` with `enabled = false` can stay attached (for a quality switch between the two). Keep the sky itself: its background is fogged like any far surface, and `ambient` can take the sky's horizon colour. It also takes the place of creative's screen-space `atmosphere.godRays` where shafts must follow real occluders.

Measured (Intel Arc 140V, Edge, AC power, GPU lock; `node examples/package-benchmarks/volumetric-gpu.mjs`, [volumetric-gpu.json](../../examples/package-benchmarks/results/volumetric-gpu.json)): light shafts through a 1.5 m slit with the sun behind the wall: the wall seen through the shaft is 9.6x brighter than the wall seen through shadowed fog (1.1x with the slit plugged; orthographic 15.6x vs 1.2x); a clustered spot light's cone in fog is 4.3x its surroundings (no difference without `lights`) and its `LocalShadows` darken the fog under a box caster to 0.48x; fog grows with density (luma 95, 152, 190 at 0.01, 0.03, 0.09) and with `heightFalloff: 0.4` the low wall is 2.5x as fogged as the high wall (equal without it); no NaN, Inf or negative value in the volume; at 4x and 1x MSAA alike. Still camera: mean frame-to-frame change 0.05 of 255 (p99 1 level); slow pan (0.05 degrees per frame): 0.19 against 0.05 without fog, no spike (max 0.24, p99 1). GPU time, quiet machine, sun shadows, default grid: the froxel compute pass 1.3-2.2 ms whatever the resolution (it scales with the grid: 80 x 45 x 32 0.3-0.5 ms, 240 x 135 x 96 3.4-3.9 ms); the composite 0.26 ms at 1280 x 720 and 0.4 ms at 1920 x 1080 at 1x, 1.1 and 2.3 ms at 4x (it runs per sample there). Whole frame: 720p 4x 5.3 -> 7.8 ms, 1080p 4x 11.6 -> 15.7 ms, 720p 1x 1.9 -> 5.0 ms, 1080p 1x 4.6 -> 6.9 ms; 8 clustered point lights in the fog add at most 0.3 ms to the compute pass. (Those timings are from the build before centre reprojection, which adds two matrix products per froxel; the final build's run in the JSON is labelled diagnostic: the machine was busy and its times run up to 50% higher.)

Limits: the 4x composite is per sample (about 4x the 1x cost; a per-pixel variant would be cheaper at the price of silhouette halos); one froxel grid resolution regardless of screen size, so sharp shadow edges in the fog are about one froxel wide (8 × 8 pixels at 1280 × 720 with the default grid) and softened by the temporal blend; fast-moving lights or occluders leave a short trail (lower `temporal`); transparent surfaces, particles, VFX and splats drawn after it are not fogged (blended glTF-pro primitives take the fog of what is behind them); fog beyond `range` is not modelled (distant surfaces get the fog up to `range`); the sun's shadow is a single comparison sample of the cascade, without PCSS; no participating media volumes (boxes, local density fields) and no multiple scattering. WebGPU only.

## Light probes: irradiance volumes and reflection probes

`@margoengine/environment/probes` is a separate entry (10,845 B min+gzip; the root entry is byte-identical without it).
It bakes the scene into light probes on the GPU and uses them as the ambient light of core meshes and of every model
you `add` (gltf-pro and materials models, terrain), the receivers clustered lights reach:

```ts
import {Engine} from '@margoengine/core';
import {Environment, loadEnvironmentImage} from '@margoengine/environment';
import {LightProbes} from '@margoengine/environment/probes';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const environment = await Environment.create(engine, await loadEnvironmentImage('/sky.hdr'));
const probes = LightProbes.attach(engine, {
  environment,                                                            // ambient outside the probes, and the sky they see
  volume: {min: [-5, 0, -4], max: [5, 3, 4], counts: [6, 2, 5]},          // irradiance probes at the cell centres
  reflections: [{position: [0, 1.5, 0], min: [-5, 0, -4], max: [5, 3, 4]}], // box-projected onto the room's walls
});
// probes.add(model) for each gltf-pro / materials model or terrain; added models are also captured.
await probes.bake();                                                      // at load, or again whenever the scene changes
```

- **Irradiance volume.** A box filled with a grid of probes (1-64 per axis, at most 4,096), one per cell centre. Each probe
  renders the scene into six faces (`resolution`, default 16 px) and projects them to L2 spherical harmonics (`sh: 1` keeps
  L1: 4 instead of 9 coefficients), stored as irradiance / PI like the environment's SH. Receivers blend the eight nearest
  probes trilinearly (clamped to the outer cell centres); surfaces on the box faces are inside, and the volume fades to
  the fallback over `blend` metres outside the box (default 0).
- **Reflection probes.** Up to 16, each captured at `position` (`resolution`, default 128 px faces) and stored as
  octahedral radiance levels down to 4 x 4: level 0 resampled from the faces, each rougher level a GGX convolution of
  level 0 at roughness level / (levels - 1) (n = v = r, as the environment's prefilter). A surface's reflected ray is
  intersected with the probe's box (box projection) and the radiance read trilinearly over the levels by roughness. The
  box is also the influence volume (its faces included, so a room box lights its own walls); the probe fades out over
  `blend` (default 10% of its smallest side) outside it, and
  where boxes overlap the earlier probe in the list wins, so list nested boxes first.
- **Replacing the ambient term.** Probes replace the ambient light, named `margoAmbient` like `EnvironmentLighting`, so
  SSAO occludes it: diffuse from the volume and specular from the reflection probes, split-sum weighted as
  EnvironmentLighting; where a probe's weight is below 1 the rest comes from `environment` (its SH and prefiltered cube,
  exactly EnvironmentLighting's term) or, without one, from the receiver's own ambient (core's scalar ambient, gltf-pro's
  hemisphere). Use LightProbes instead of EnvironmentLighting, not with it (patching both throws, naming the fix). Unbaked
  probes have weight 0, so attaching them changes nothing until `bake()` resolves.
- **Baking.** `bake()` renders one ordinary frame (shadow maps and other per-frame inputs come from the previous frame),
  then a frame whose pass at order -0.5 captures every probe: core meshes through core's fully patched lit shader drawn
  from the probe camera, and every added model with a `draw` method, as linear radiance without fog (receivers fog
  themselves); clustered point and spot lights are looped in full (the light lists are culled for the main camera), area
  lights and shadows are as the frame has them; where nothing was drawn the environment's sky (or black) fills in. One
  submit per face, then one compute pass per probe. `bounces: n` repeats the capture n times, each seeing the previous
  bake's probe light (one more bounce each). The result is also read back to the CPU: a device restore re-uploads it, and
  `irradianceAt(position, normal)` returns the volume's irradiance there, as the shaders compute it.
- **Bindings.** One storage buffer (header, then float16 RGB texels: 72 B per L2 probe, 21,840 texels per 128 px
  reflection probe) and no sampled texture; with an environment the same five IBL bindings EnvironmentLighting uses. So
  gltf-pro's physical material with shadows, LocalShadows and environment lighting stays at 16 sampled textures; storage
  buffers in the lit fragment become 6 of 8 with clustered + area lights.
- **SSR.** `@margoengine/post/ssr` removes the probes' own specular (`probeSpecular`) where it finds a reflection on
  screen and keeps the probe's elsewhere, so reflection probes are SSR's off-screen fallback.

Measured (Intel Arc 140V, Edge 155, AC, GPU lock; `node examples/package-benchmarks/probes-gpu.mjs`,
[probes-gpu.json](../../examples/package-benchmarks/results/probes-gpu.json)). A closed 4 x 3 x 4 m room whose six walls
radiate exactly their colour, with a 2 x 2 x 2 L2 volume and one 128 px reflection probe filling it:

- Volume SH read back vs a CPU projection of the analytic room (6 x 256^2 samples): every coefficient of every probe
  within 1.7% of the probe's DC term (0.7-1.7%).
- Reflection levels vs the analytic radiance (level 0) and a CPU GGX convolution of it (levels 1-5, roughness 0.2-1):
  median error 0.0002-0.0018, 95th percentile 0.0003-0.0083 (radiance 0.1-0.9); the largest errors (level 0: 0.22, level
  1: 0.04) sit on the texels that straddle a wall-colour boundary.
- Shading through a CPU mirror of the WGSL (trilinear SH, box projection, trilinear levels, split sum, each path's tone
  map): a white core sphere and a white materials sphere (gltf-pro hook) and a rough (0.5) metal floor within 1/255; a
  mirror metal floor within 2/255 at the 95th percentile (5/255 at most) for wall points 0.4 m or more from a wall edge.
- Box projection is physical: on that mirror floor each pixel shows the wall its reflected ray hits (95th percentile
  2/255). Closer to an edge, where several walls fall in one 128 px octahedral texel seen from the probe, the reflection
  shows texel-sized steps (a finer `resolution` shrinks them).
- No geometry, a synthetic HDR sky: the volume's SH equals the Environment's own within 0.05% of DC, and spheres lit by
  `LightProbes({environment})` match `EnvironmentLighting` within 1/255.
- Unbaked probes: core meshes bit-identical to no probes, gltf-pro identical (0/255).
- With SSR (two views, mirror floor): on screen, 99% of reflecting pixels are no brighter than both the wall as rendered
  and the probe reflection (adding instead of replacing would exceed both; median difference to the wall 2/255); off
  screen the floor equals the frame without SSR (95th percentile 0/255).
- Cost (diagnostic: the quiet gate passed at 12% CPU, but other agents' sessions were open), GPU time of the whole
  frame at 4x MSAA with the room, both spheres and the volume (4 x 2 x 4) and one reflection probe covering the screen:
  1280 x 720 0.6-1.1 ms -> 3.8-3.9 ms (volume alone 2.5, reflection probe alone 2.1); 1920 x 1080 2.4 ms -> 8.1-9.2 ms
  (5.6 and 4.9). Bake of 8 volume probes (16 px) and one 128 px reflection probe: 114-121 ms, 382 ms the first time
  (pipeline creation included).

Limits: static: a moving object or light needs a re-bake (CPU encode plus GPU, see above); no visibility per probe, so
light leaks through walls thinner than the probe spacing (place volume boxes per room); one volume per LightProbes;
reflection probes are box-projected only (no sphere projection); the receiver's normal map and occlusion shade the probe
light (terrain takes the core-style patch like EnvironmentLighting); core meshes and models with a `draw` method
(gltf-pro, materials) are captured, terrain, water, sky backgrounds, particles and other custom pipelines are not (the
environment fills in where nothing was drawn); GPU-culled
(`CulledMeshes`) parts use the main camera's culling in the capture. WebGPU only.

## Display P3 and HDR output

```ts
import {ColorOutput} from '@margoengine/environment';
import {Tonemap} from '@margoengine/tonemap';
const output = ColorOutput.attach(engine); // defaults: {gamut: 'p3', hdr: true, peak: 4}
Tonemap.attach(engine, {curve: 'neutral'}); // HDR highlights and colours outside sRGB come from Tonemap
console.log(output.gamut, output.hdr); // what the canvas actually is: 'srgb' | 'p3', true | false
```

One class for both because they share one canvas configuration (`format`, `colorSpace` and `toneMapping` are one
`configure()` call; two plugins would overwrite each other) and one output pass.

**What "on" means.** Each feature turns on only when the display reports it (`matchMedia('(color-gamut: p3)')`,
`matchMedia('(dynamic-range: high)')`; `force: true` skips the queries) and the browser keeps it (checked with
`getConfiguration()`). Otherwise nothing happens: no configure call, no pass, the GPU calls are those of an engine
without the plugin.
- **P3 on**: the canvas is `colorSpace: 'display-p3'` and the final pass converts the engine's working space (linear
  sRGB / Rec.709 primaries) to linear P3 before the sRGB transfer function. sRGB-authored content therefore looks the same
  as on the sRGB canvas (measured: 0 to 1 eight-bit P3 units apart) - P3 does not make sRGB colours more saturated,
  which would be wrong. What it adds is room for colours outside sRGB: linear Rec.709 values with negative components
  (a P3-authored texture or colour converted into the working space, an external HDR `source`), which Tonemap clips to
  the P3 gamut instead of the sRGB gamut. Core's own shader, materials and hex colours are sRGB, so without such input
  a scene looks identical either way.
- **HDR on**: the canvas is `rgba16float` with `toneMapping: {mode: 'extended'}`, so values above 1 (SDR white) reach the
  display, up to what it can show. Tonemap's curves stay the SDR ones below the 0.76 knee; above it Khronos PBR
  Neutral's highlight rolloff aims at `peak` (relative to SDR white, 1 to 16, default 4) instead of 1, and AgX/ACES are
  scaled by the same rolloff ratio of the brightest channel. `peak: 1` gives the SDR curve. There is no web API for the
  display's real headroom; set `peak` for the target display (values above its headroom are clipped by the browser).

**How it works.** Core configures the canvas and draws into `getCurrentTexture()` (into its 4x target, resolved to that
texture). ColorOutput reconfigures the same context, merging with `getConfiguration()` so TransparentCanvas's
`alphaMode` and any `usage` survive (TransparentCanvas now merges the same way, so either attach order works). It
replaces `getCurrentTexture` on that context object with an offscreen texture in the preferred canvas format, so core
and every package keep drawing exactly what they drew before (sRGB-encoded, canvas format). At order 1e5 it resolves
core's multisampled target into that texture and draws one full-screen pass into the real canvas texture: decode sRGB,
add Tonemap's excess, convert to P3, clamp to 0..1 (SDR) or 0..`peak` (HDR), encode (extended sRGB transfer function on
the float canvas). Between its passes (order -1e5 to 1e5) it leaves a contract on the pass context
(`Symbol.for('margoengine.color-output')`) that Tonemap reads, alone or as a PostStack's display effect: Tonemap then
compiles an output variant of its shader that writes the SDR part to the canvas target as before and the part outside
0..1 (highlights above white, negative components outside sRGB, linear) into a 1x rgba16float excess texture. Device
restore: core reconfigures sRGB, then `onDeviceRestored` reapplies (and re-checks what the browser kept); `dispose()`
restores the sRGB/SDR canvas and the original `getCurrentTexture`.

**Cost**: one full-screen pass, a resolve when MSAA is on, a canvas-size texture in the canvas format and, with Tonemap,
a canvas-size rgba16float excess texture and a second full-screen Tonemap pass. Root entry +1,791 B min+gzip
(environment, includes the TransparentCanvas merge), tonemap +684 B (the output shader variant, compiled only under
ColorOutput); core and stage +0.

**Limits.** HDR highlights and out-of-sRGB colours come only from `Tonemap`; Bloom, SSAO, DOF alone and creative
PostProcessing tone map to 0..1 themselves, so with them the canvas is P3/HDR but the image stays SDR-range. Passes that
draw after Tonemap (FXAA, TAA, overlays) see the SDR image; the excess is added back under them, so an opaque overlay
drawn over a highlight above white is lifted by that highlight, and FXAA/TAA do not filter the excess. LUT grading
applies to the 0..1 part (the excess above 1 is added back unchanged; the out-of-sRGB part is not graded). The
out-of-sRGB part is scaled by the curve's compression of the brightest channel, not passed through the curve. SceneFade
captures the offscreen image (pre-conversion), which is also what it blends into, so it should keep working (not
tested). Creative's `Planet` and `GrassField` build canvas pipelines with `navigator.gpu.getPreferredCanvasFormat()`,
which still matches the offscreen texture (also untested). Composition with TransparentCanvas needs `getConfiguration()` (Chrome/Edge 131+); without it the
last plugin to configure wins. WebGL2 fallback: no-op (`gamut` 'srgb', `hdr` false). Display changes (moving the window
to another monitor) are not followed until the next device restore or a new ColorOutput.

**Proofs.** `packages/environment/tests/output.test.js` (fake GPU through a real core engine): on an sRGB/SDR display
the configure calls and GPU calls equal an engine without ColorOutput; P3/HDR configuration, offscreen redirect,
final pass, device restore, dispose, both attach orders with TransparentCanvas, a browser that drops `toneMapping`, and
the Tonemap contract. `examples/package-benchmarks/proofs/color-output.proof.js`: without ColorOutput, Tonemap (alone,
DOF-sourced, in a PostStack before FXAA), TransparentCanvas and ColorBackground make exactly the GPU calls of `7dcc958`
(6,174 recorded calls, 1x and 4x). Real GPU: `examples/package-benchmarks/color-output-gpu.mjs` (Edge 155 and Chrome 155,
Intel Arc 140V; results `results/color-output-gpu-{msedge,chrome}.json`). The laptop's display reports `color-gamut:
srgb` only and `dynamic-range: standard`, so `auto` stays sRGB/SDR there (and renders like no plugin); with `force` the
canvas reports the requested `display-p3` / `rgba16float` / `extended`. A Display P3 green patch (outside sRGB) reads
back through a Display P3 2D canvas as (0, 188, 0) with P3 on and (86, 188, 55) (clipped to sRGB green) with it off; a
grey highlight at 3x white reads 1.373 (extended sRGB, linear 2.07) from the float16 canvas texture and from a float16
P3 2D canvas with HDR on, 252/255 with it off; in-gamut content is 0 to 1 P3 units apart on and off; after
`rebootDevice()`, with TransparentCanvas (premultiplied) and with a Bloom + Tonemap + FXAA PostStack: same values, no
validation errors.

## UltraHDR

`decodeUltraHDR(bytes, {decode?, weight?})` reads gain-map JPEGs (Android UltraHDR, Adobe gain maps) with the `hdrgm` XMP metadata: `parseUltraHDR` walks the JPEG segments, takes the next JPEG stream after the primary image as the gain map, and reads `GainMapMin`, `GainMapMax`, `Gamma`, `OffsetSDR`, `OffsetHDR` and `HDRCapacityMin/Max` (single values or per-channel `rdf:Seq`) from either image's XMP. `applyGainMap` then computes `(sdr + offsetSdr) * 2^(weight * mix(min, max, gain^(1/gamma))) - offsetHdr` with the base image decoded from sRGB and the gain map bilinearly upsampled; `weight` defaults to 1 (full HDR, right for lighting). JPEG pixels come from `createImageBitmap` and `OffscreenCanvas` by default; in Node pass `decode`. `loadEnvironmentImage` picks it automatically for JPEG signatures; the synchronous `parseEnvironmentImage` cannot (JPEG decoding is asynchronous). Not supported: ISO 21496-1 binary-only metadata, HDR base renditions, and color-gamut conversion (Display P3 bases are treated as sRGB).

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
- **BRDF LUT.** A compute pass integrates the split-sum scale and bias with the same GGX distribution and separable Smith-GGX visibility as core's direct lighting. It is a storage buffer, not a texture, so IBL costs one of the 16 sampled textures WebGPU guarantees per shader stage (a physical glTF material with every lighting package needs all 16; see the gltf-pro README, "Texture bindings").
- **Background.** A full-screen triangle at reversed-Z depth 0 with a read-only `greater-equal` depth test runs after core's main pass (order 1), so it only touches pixels whose depth still holds the cleared 0 and never covers geometry. It samples the equirect (sharpest), the source cube, or a prefiltered mip when `blur > 0`. Output matches core's shader: `c / (1 + c)` Reinhard then the exact sRGB encode into the canvas format; when the pass target is rgba16float (for example creative's `PostProcessing` HDR capture) it writes linear radiance instead. Steady frames allocate nothing.
- **Device loss.** The CPU source is kept by default. As a plugin (or through the background plugin) the environment rebuilds on the new device in `onDeviceRestored`; `version` increments and `onChange` listeners fire, so consumers can rebuild bind groups. Nothing touches `window`, `document`, `navigator` or GPU globals at import time.

## What an IBL shader needs

Five bindings, any group and binding numbers. `iblLayoutEntries(firstBinding)` and `iblBindGroupEntries(environment, firstBinding)` build them, and `IBL_WGSL` provides the functions below.

| Binding | WGSL type | Resource | Format |
| --- | --- | --- | --- |
| specular | `texture_cube<f32>` | `environment.specularView` | rgba16float, `specularMips` mips (filterable float) |
| sampler | `sampler` (filtering) | `environment.sampler` | trilinear, clamp-to-edge |
| BRDF LUT | `var<storage, read> array<u32>`, named `iblBrdf` | `environment.brdfLut` | `brdfSize`² u32, row-major, each `pack2x16float(scale, bias)` |
| SH | `var<uniform> array<vec4f, 9>` | `environment.shBuffer`, offset 0, size 144 | 9 x vec4f, rgb used |
| params | `var<uniform> vec4f` | `environment.paramsBuffer` | (cos rotation, sin rotation, specularMips - 1, intensity) |

- **Rotation.** The environment is rotated by `rotation` radians about +Y. Rotate every world lookup vector `d` with `iblRotate(d, params)`: `(c * d.x - s * d.z, d.y, s * d.x + c * d.z)` with `c, s = params.x, params.y`.
- **Roughness to mip.** `lod = clamp(perceptualRoughness, 0, 1) * (specularMips - 1)`, that is `roughness * params.z`, sampled with `textureSampleLevel(specular, sampler, iblRotate(reflect(-v, n), params), lod)`. Roughness is perceptual; GGX alpha is roughness squared, as in core.
- **BRDF LUT.** Read at `(NdotV, perceptualRoughness)` (entry `(x, y)` holds `((x + 0.5) / size, (y + 0.5) / size)`); `iblBrdfTerms(nv, roughness)` filters it bilinearly with clamp to edge, as a texture sampler would. It reads the binding by its name `iblBrdf`, since WGSL cannot pass a storage array to a function. Split-sum specular is `prefiltered * (F0 * scale + bias)`.
- **SH irradiance.** The uniform holds diffuse-ready coefficients `c_k` (irradiance divided by PI), so for a unit rotated normal `n`:

  `diffuse = albedo * max(0, sum_k c_k * Y_k(n))`

  with `Y_0 = 0.282094792`, `Y_1 = 0.488602512 n.y`, `Y_2 = 0.488602512 n.z`, `Y_3 = 0.488602512 n.x`, `Y_4 = 1.092548431 n.x n.y`, `Y_5 = 1.092548431 n.y n.z`, `Y_6 = 0.315391565 (3 n.z^2 - 1)`, `Y_7 = 1.092548431 n.x n.z`, `Y_8 = 0.546274215 (n.x^2 - n.y^2)`. The plain radiance projection `L_k` is at byte offset 256 of the same buffer (and in `environment.sh.radiance`); `c_k = L_k * A_l / PI` with `A_l / PI = 1, 2/3, 1/4` for bands 0, 1, 2.
- **Combined.** `iblShade(specular, sampler, sh, params, n, v, baseColor, metalness, roughness)` returns `(diffuse * (1 - F) * (1 - metalness) + prefiltered * F) * intensity` with `F = F0 * scale + bias` and `F0 = mix(0.04, baseColor, metalness)`. It outputs linear radiance; tone map like core.
- **Conventions.** Cube layers are +X, -X, +Y, -Y, +Z, -Z (WebGPU). Equirect `u = 0.5 + atan2(d.x, -d.z) / 2PI` (image center faces -Z), `v = acos(d.y) / PI` (row 0 is +Y).

## Options

`Environment.attach(engine, source, options)` resolves once the IBL is built and the environment is attached (it then rebuilds itself after a device loss); `Environment.create(engineOrDevice, source, options)` builds one without attaching it, for example on a bare `GPUDevice`. Options:

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

`EnvironmentBackground.attach(engine, environment, options)` (the class is also exported as `Skybox`):

| Option | Default |
| --- | --- |
| `exposure` | 1, linear multiplier before tone mapping |
| `blur` | 0; 0..1 picks the prefiltered mip for that roughness |
| `source` | `'auto'`: equirect if kept, else cube. `'equirect'` or `'cube'` force one when `blur` is 0 |
| `rotation` | 0, added to `environment.rotation` |
| `order` | 1, frame graph order (must be above 0) |
| `name` | `'environment:background'` |

`EnvironmentBackground.record(context)` draws into any WebGPU pass context without an engine.

| Class | Options (default) |
| --- | --- |
| `EnvironmentLighting(environment, options)` | `name` (`'environment:lighting'`). Intensity and rotation come from the environment |
| `Fog(options)` | `color` (`'#ffffff'`), `near` (1), `far` (1000), `density` (0 = linear fog), `heightFalloff` (0 = off), `height` (0), `name` (`'fog'`) |
| `ColorBackground(options)` | `color` (`'#000000'`), `bottom` (none), `order` (0.5, above 0), `name` (`'background'`); `record(context)` works without an engine |
| `TransparentCanvas(options)` | `order` (0.5), `name` (`'transparent-canvas'`) |
| `VolumetricFog(options)` (`/volumetric`) | `density` (0.02 per m), `heightFalloff` (0), `height` (0), `color` (albedo, [1, 1, 1]), `anisotropy` (0.5), `ambient` (engine ambient), `noise` (0), `noiseScale` (8 m), `wind` ([0, 0, 0] m/s), `range` (100 m), `grid` ([160, 90, 64]), `temporal` (0.9), `shadows`, `lights`, `depth` |
| `ColorOutput(options)` | `gamut` (`'p3'`), `hdr` (true), `peak` (4, 1..16), `force` (false); name `'color-output'` |

## Limits

WebGPU only: `EnvironmentBackground.setup` throws on the WebGL2 backend and `Environment.create` needs a device. EXR tiled, multi-part, deep and subsampled (chroma) images and PXR24, B44, B44A, DWAA, DWAB and HTJ2K compression are rejected with an error, as are Radiance `xyze` files and mirrored or transposed orientations. Huffman codes longer than 44 bits are rejected (OpenEXR writers do not produce them for normal images). `EXPOSURE` and `GAMMA` headers are reported, not applied. Equirects larger than the device's texture limit are box-downsampled on the CPU. The diffuse term is L2 SH (no ringing suppression), and the split sum ignores multiple scattering. Source and specular sizes must be powers of two.

Two portability measures are deliberate: the specular prefilter samples the cube in a fragment pass (cube sampling with explicit LOD in compute shaders returned wrong seam texels on SwiftShader), and the WGSL avoids `atan2(-0.0, x)` (SwiftShader returns PI).

## Tests

`npm test` in `packages/environment` runs Node checks: every binary16 value round trip; 20 EXR fixtures written by the reference OpenEXR library (NONE, RLE, ZIPS, ZIP and PIZ, each with HALF RGBA, FLOAT RGB, HALF Y and a mixed HALF/FLOAT/UINT layout) decoding bit-exactly; an independent in-test EXR writer (including raw-fallback chunks, decreasing Y and stored, fixed and dynamic deflate blocks); real files `BrightRings.exr` (ZIP) and `AllHalfValues.exr` (PIZ, every half value) from the OpenEXR test images and `spot1Lux.hdr` from the Three.js examples, matched against reference digests; HDR adaptive, flat and old-style runs in both orientations; truncation and random-corruption fuzzing; CPU SH; and SSR safety. `tests/scene.test.js` checks the scene pieces on a mock GPU: `EnvironmentLighting` and `Fog` patch core's shader as left by shadows, sky, clustered and the HDR captures, leave it untouched when not ready, on another device or disposed, follow device restores and rebuild bind entries on `environment.version`; a real glTF-pro model gets lit and fogged pipelines for opaque and blended primitives and returns to the unpatched pipelines when removed; `ColorBackground` writes exact sRGB or linear values, allocates nothing in steady frames or on resize and releases its uniform; and UltraHDR parsing (attribute and element metadata, corruption fuzzing) and gain-map math against the formula.

`tests/probes.test.js` checks LightProbes on a mock GPU: validation and buffer layout, the ambient patch on core's shader variants (with and without an environment, terrain, clustered) and on a glTF-pro model, the bake's capture shader (rebound frame, linear output, no fog, every clustered light), its submits and dispatches, and the CPU irradiance mirror; the real-GPU checks are `examples/package-benchmarks/probes-gpu.mjs` (README section above).

`npm run test:browser` (a real-GPU script, not in CI) runs Chromium WebGPU checks (set `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS` as in the repository brief): a constant environment gives constant values at every prefiltered mip and L0-only SH; a single bright direction gives SH matching both a CPU projection and the analytic delta projection, with no fireflies in the prefiltered mips; prefiltered mip 0 equals the source; the cube follows the documented face convention; GPU SH matches a CPU projection of the same cube texels; six `CubeFaces` give the same SH as the equirect; the BRDF LUT matches brute-force quadrature, the smooth-surface analytic limit and Karis's published mobile fit; the background renders the expected color in each direction (equirect, cube, rotation, exposure, blur, HDR and tone-mapped targets) and never draws over non-cleared depth; `IBL_WGSL` compiles against `iblLayoutEntries` and passes a white furnace test; a real `.hdr` goes through the whole pipeline; and in a real engine the background leaves every pixel of a core mesh untouched, matches core's tone mapping elsewhere, allocates nothing in steady frames and comes back after `engine.rebootDevice()`; in a real engine `ColorBackground` writes exact bytes on cleared depth only, `EnvironmentLighting` lights a core mesh and a glTF-pro triangle with direct and ambient light off, full `Fog` turns the whole frame (including the blended triangle) into its color, and removing all three restores the original frame byte for byte; and an UltraHDR file assembled from two browser-encoded JPEGs decodes through `createImageBitmap`. Every check runs under WebGPU error scopes with zero validation errors. `tests/fixtures/generate.py` regenerates the synthetic fixtures (`pip install OpenEXR numpy`).

MIT licensed. Test fixtures: see `tests/fixtures/NOTICE.md`.
