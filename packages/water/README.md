# @margoengine/water

Import `margoengine/water` from the `margoengine` package, or `@margoengine/water` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A separate WebGPU water grid evaluates up to eight swell trains with analytical normals. Each train spreads into three Gerstner components with varied directions, wavelengths and gently bending crests. Advected gradient noise (random unit gradients, Perlin's 2002 quintic fade, analytic derivatives) adds wind agitation and micro-ripples, filtered separately by their screen footprint. Fresnel reflection, sun glints and wavelength-dependent absorption shade the surface. Optional terrain coupling adds conservative GPU shallow-water flow, moving breaker foam and a fixed GPU spray pool.

```ts
import {Water} from 'margoengine/water';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const water = Water.attach(engine, {size: [100,100], segments: 128, height: 0});
```

For an open ocean, set `horizon: true`. The central 75% of each grid axis keeps
its original spacing and follows the camera in whole cells, so the swell
surrounds the camera wherever it goes and the waves stay put in the world. Each
outer row is a fixed ratio wider than the one inside it, out to 10 km past the
grid's edge, and the last row lies 10,000 km out, so the sea meets the true
horizon even from a camera kilometres up; both draw beyond the scene's far clip.
Wave displacement and normals fade
together over those rows as the cells grow too large to resolve the wavelength.
The default grid remains bounded and centred on the origin for ponds and finite
surfaces. Use a size that keeps the shoreline and terrain map within 37.5% of
`size` of the camera, where the cells are regular.

```ts
import {Bloom} from 'margoengine/post/bloom';
import {Sky} from 'margoengine/sky';
import {Water} from 'margoengine/water';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
// A 4 km sea on 8 m cells: the swell follows the camera to the horizon.
const sea = Water.attach(engine, {
  size: [4096, 4096],
  segments: 512,
  horizon: true,
  waves: [{direction: [1, 0.3], amplitude: 0.9, wavelength: 48}],
});
```

Directions are XZ, dimensions/amplitudes are world units, wavelengths are positive, and phase is radians. A configured wave supplies the dominant direction and wavelength of its train; its three component amplitudes sum to the configured amplitude. Steepness defaults to 0.5 and must be 0..1. For N configured trains, each must satisfy `steepness * amplitude * (2 * Math.PI / wavelength) <= 1 / N`. Folding input and `setWaveHeight` changes reject atomically with code `failed` and a geometry help link; authored values are never silently clamped. The crest bend includes analytical derivatives and a displacement margin to preserve that bound. Agitation and micro-ripples follow the first wave's direction; each of their four layers is turned by its own angle (11° to 41°) and scaled by non-integer ratios, so no two noise lattices line up into visible streaks. Open-water sky reflections clamp below-horizon rays to the horizon and soften with roughness. Fresnel inputs are saturated before exponentiation so floating-point roundoff cannot feed a negative base into `pow`. Default water owns a shared sampleable scene-depth target with HTML. With Bloom/SSAO/DOF, pass `depth: () => effect.depthTexture` explicitly; dimensions must match the viewport. Water is opaque and Y-up. It seeds its own depth target from opaque scene depth and writes that target to resolve overlapping wave triangles; the original scene depth stays available for shoreline comparisons. Default foam history is screen-space and resets on resize/restoration. Each engine view keeps its own foam history; a view not drawn for a frame releases it.

For the sandbox optics, connect the optional packages:

```ts
const bloom = Bloom.attach(engine), sky = Sky.attach(engine);
Water.attach(engine, {
  depth: () => bloom.depthTexture,
  sceneColor: () => bloom.sceneTexture,
  reflection: () => sky.reflectionTexture,
  lights: sky.lights,
});
```

The borrowed sky texture must be a sampleable single-layer `rgba16float` 2D texture. The borrowed scene color must be a viewport-sized single-layer `rgba16float` texture with `COPY_SRC` usage. Water retains one GPU snapshot for depth-rejected screen refraction and seabed attenuation. Without these providers, it uses a sky gradient and an approximate seabed color. Reflections represent the atmosphere, not nearby objects.

`water.depthTexture` exposes borrowed viewport depth including opaque geometry and
the water surface for subsequent effects, such as `Sky` distance fog. It is
undefined before the first draw and after disposal/restoration until drawing
resumes. Its 1x/4x sample count follows scene quality, and the texture changes on
resize or device restoration. Consumers must re-read it and must not destroy it.

`lights: sky.lights` keeps sun and moon glints aligned with their separate visible
directions through dusk, instead of reflecting the engine's blended shadow light.
Waves still break the paths into moving highlights. Custom callers can supply up
to two retained lights with `direction` (four numbers: XYZ and nonnegative intensity)
and `radiance` (three nonnegative RGB numbers), updated before each render. An empty
array disables direct glints. Omitting `lights` retains engine lighting behavior;
the application must synchronize that direction with its sun clock.

Foam is lit like the scene's diffuse surfaces: the engine light's N·L over π plus
the ambient level, so it dims with the light angle instead of glowing at full light
strength. Pass `shadows: shadows` (a `Shadows` from `@margoengine/shadows` attached
to the same engine) to darken glints and foam where the engine light is blocked.
Water binds the cascades at group 1 and samples them with the same PCSS filter as
the scene, only where a glint or foam shows. All glint lights take that one shadow
map, as the scene's single blended light does.

For beaches and inland dips, supply `terrain: {heightmap: () => texture,
origin: [-80,-80], size: [160,160]}`. The borrowed heightmap must contain world-space
Y heights in a sampleable `r32float` texture, 2..512 cells per side. Each cell holds
water depth and exchanges conservative flux with its neighbors; higher ground
blocks flow and outlet sills retain puddles as the sea recedes. A GPU connectivity
pass identifies below-sea-level cells connected to the map boundary. The same
curved swell spectrum drives those open-sea cells, fading the forcing between
0.65 and 2.4 metres of depth so conservative shallow flow carries run-up to every
shore. Enclosed basins receive no offshore forcing. Initially, depressions below the mean sea level are filled;
higher depressions start dry. Resize preserves simulation state, while replacing
the height texture or restoring the device resets it. All simulation textures,
bind groups and pass descriptors are retained between frames.

Standing water above the sea takes `fill` and `still`. `fill(x, z)` gives the surface height per heightmap texel (undefined
for none), read once when the flow starts: cells below it fill up to it, cells whose ground stands above it stay dry and
hold that height for the mesh around them. `still: true` stops the flow there: the surface stands, a sloped one included,
and no flow pass runs after the first frame, so a river costs only its draw. Without `still`, a fill starts the flow.

```ts
import { Engine } from '@margoengine/core';
import { Water } from '@margoengine/water';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
// A channel 12 m wide along z, its bed rising 2 m per 100 m, on banks 30 m higher.
const side = 128;
const ground = new Float32Array(side * side);
for (let j = 0; j < side; j++)
  for (let i = 0; i < side; i++) {
    const x = (i + 0.5) * 4 - 256;
    const z = (j + 0.5) * 4 - 256;
    ground[j * side + i] = 15 + z * 0.02 + (Math.abs(x) <= 6 ? 0 : 30);
  }
const heightmap = engine.gpu!.createTexture({
  size: [side, side],
  format: 'r32float',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
engine.gpu!.queue.writeTexture({ texture: heightmap }, ground, { bytesPerRow: side * 4 }, [side, side]);
Water.attach(engine, {
  size: [512, 512],
  segments: 128,
  terrain: { heightmap: () => heightmap, origin: [-256, -256], size: [512, 512] },
  fill: (x, z) => (Math.abs(x) <= 14 ? 16.5 + z * 0.02 : undefined),
  still: true,
});
```

Rendering blends offshore swells into the shallow simulation according to ocean
connectivity and seabed depth, including blend derivatives in the surface normals.
Deep ocean keeps the same wave field on both sides of the map boundary. The outer
four cells (at least 4 m, capped at a quarter of the map) fade sampled seabed color
into its approximation. Outside the map, the nearest open seabed sample deepens
at 0.35 m/m; extend the heightmap to represent distant shoals. Optical depth stays
continuous across the map edge. Refraction samples submerged geometry only;
clear-depth sky pixels never become seabed color. Shoreline fragments retain
helper lanes until their screen derivatives are complete, then discard dry cells.

The solver runs three GPU substeps per frame and caps elapsed simulation time at
1/15 second after a stall. Fast shallow flow generates breaker foam, which advects
and decays with the water. Set `spray: true` with terrain coupling to enable a fixed
2,048-slot GPU droplet pool, with gravity, water/terrain collision and soft depth
fading. It approximates breaking surf; it does not solve overturning wave volumes
or erosion. Use heightmap cells of roughly 0.5 metres or larger for this preset;
very small cells require more substeps.

`water.setWaveHeight(meters)` scales the existing spectrum to that largest configured train
amplitude without recreating geometry. It validates the complete spectrum before
changing any amplitude, rejecting heights that would fold the surface.

`water.coastalDepthTexture` exposes the borrowed current coastal state for optional
terrain wetness and diagnostics. Its `rgba32float` channels hold water depth (R),
ground height (G), foam (B) and breaker intensity (A), with `COPY_SRC` usage. It is
undefined before the first simulation frame, after disposal and during device
restoration. It alternates between the flow's retained textures; sample the getter
each frame and never destroy its result. `TerrainColors` can use it to animate wet
sand while keeping the grass/dirt blend anchored to ground height.

Waves fade smoothly between two and four grid-diagonal lengths and are omitted
below two, preventing short waves from exposing the triangle pattern. Increase
`segments` to retain smaller ripples. Both displacement and analytical normals use
the filtered amplitude, accounting for each component's wavelength and crest bend.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/water

Wave glints, foam and spray use the engine's directional radiance and intensity,
so optional sky moonlight produces cool reflections without daytime-white surf.
The water body uses the scene's ambient floor; a borrowed sky environment carries
the matching night sky into Fresnel reflections.

Physical WebGPU all-shore run-up/recession, deep isolated-basin retention, curved-crest/normal, zero-amplitude, channel, spray, triangle-order, coastal-seam,
refraction and device-restoration checks: npm run test:gpu --workspace @margoengine/water
(build core, post and terrain packages first).

## Fog

`water.setFog(fog)` fogs the surface and its spray with `@margoengine/environment`'s `Fog` or any object with its fields
(`color`, `near`, `far`, `density`, `heightFalloff`, `height`, `enabled`), read every frame with Fog's maths. The surface
mixes where Fog mixes on meshes: after the display tone mapping on the canvas and in linear radiance on an HDR target,
so fogged water matches fogged terrain and a fully fogged surface shows exactly the fog colour. Spray fades toward the
same colour. Water does not import environment. `fog.enabled = false` clears it without recompiling;
`water.setFog(null)` (the default) draws exactly as before. The SSR capture keeps the unfogged reflection term.

```ts
import {Fog} from 'margoengine/environment';
import {Water} from 'margoengine/water';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const water = Water.attach(engine, {size: [512, 512]});
const fog = Fog.attach(engine, {color: '#8090a0', density: 0.02});
water.setFog(fog);
```

Checked on a real GPU (NVIDIA RTX A6000, Edge 155; `node scripts/gpu-lock.mjs run --owner=fog-all -- node
scripts/fog-all-gpu-check.js`): fogged pixels equal unfogged + a x (fully fogged - unfogged), with a the analytic fog
amount, within 0.00022 in HDR and 1/255 on the canvas, for linear-with-height and exp2 fog at 4x and 1x MSAA; without fog
and with `enabled: false` the pixels equal the pre-fog build bit for bit.

## Screen-space reflections

`Water` takes SSR's capture hook (`@margoengine/post/ssr`): `ssr.add(water)` draws the surface again into SSR's
material targets with the sky reflection it added (sky colour times Fresnel, less the foam's share) as the specular to
replace, that Fresnel weight, its rippled normal and roughness. The capture writes the water's depth into what SSR
traces, so rays start at the surface (not the seabed) and other rays stop at it. Where an SSR ray hits, the water's
sky reflection is replaced by the screen, not added to; where it misses the water keeps its own sky. Without the hook
the GPU calls are exactly as before (`examples/package-benchmarks/proofs/water-ssr.proof.js`, against `6c20076d`).
Checked on a real GPU (NVIDIA RTX A6000, Edge 155; `examples/package-benchmarks/post-effects-gpu.mjs --only=ssr-surfaces`, [ssr-surfaces-gpu.json](../../examples/package-benchmarks/results/ssr-surfaces-gpu.json)): a red box above calm water (a uniform grey sky texture as `reflection`) appears in it within the
box's planar mirror through the water plane (14,825 pixels at 4x, 12 outside the mirror bounds by more than 16 px,
the ripples bending its edges) and at the mirrored centre its green falls (143 to 136/255: the box's light replaced
the sky's, it could not have added green), at 4x and 1x MSAA. Limits: only the water's own reflection term is
replaced (refraction, foam and glints stay); SSR's `maxRoughness` fades reflections on rough, rippled water.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

## FFT ocean

`@margoengine/water/fft` is a separate entry. `FFTOcean` creates a deterministic
Gaussian ocean spectrum on the GPU, evolves Tessendorf's conjugate wave pairs,
and runs a two-dimensional radix-two inverse FFT for height, choppy XZ displacement
and their time derivatives. Select `spectrum: 'jonswap'` (default) for fetch-limited
seas or `'phillips'` for a fully developed wind sea. The default three disjoint
cascades cover 512..64, 64..8 and 8..0.125 metre wavelengths at resolution 128.
Overlapping bands reject instead of counting the same wave energy twice.

```ts
import { Engine } from '@margoengine/core';
import { FFTOcean } from '@margoengine/water/fft';
const engine = await Engine.create(document.querySelector('canvas')!);
const ocean = FFTOcean.attach(engine, {
  spectrum: 'jonswap', windSpeed: 10, fetch: 100000,
  windDirection: [1, 0.3], resolution: 128,
});
engine.render({ delta: 1 / 60 });
```

Foam forms from the horizontal displacement Jacobian determinant and persists
with exponential decay. The default compression threshold is 0.7, choppiness is
1 and foam lifetime is 4 seconds. Normals include horizontal displacement. The
surface has Fresnel sky reflection, sun glints, diffuse foam, a water body colour,
and an underside with the water-air critical angle. It writes scene depth, supports
1x/4x MSAA and offset viewports, and rebuilds on device restoration.

The 1024 m draw grid has 256 cells per axis and follows the camera in whole cells
by default; `followCamera: false` anchors it at the world origin. The spectral
patches remain world anchored and wrap periodically. `size`, `segments`, `height`
and `color` configure the draw independently of the spectrum. Increase segments
or reduce size to resolve shorter waves in geometry. There is no shoreline flow
in this entry; `Water` remains the terrain-coupled surface.

Every spectrum setting is copied on construction. `amplitude` is energy scale
(default 1 for JONSWAP or 0.0005 for Phillips); displacement scales with its square
root. Wind speed defaults to 10 m/s at 10 m, fetch to 100 km, peak enhancement to
3.3, wind direction to [1, 0.3], seed to 234, mean height to 0 and body RGB to
[0.01, 0.18, 0.25]. Resolution is a power of two from 16 to 512; one to four
cascades can be supplied with `length`, `minWavelength` and `maxWavelength` in
metres (defaults: twice cell width and patch length). The DC and Nyquist row/column
are zero so choppy derivatives remain real. Spectra use deep-water gravity
dispersion; they do not solve overturning volumes or finite-depth dispersion.

`ocean.time` advances once per engine update. `setTime(seconds)` selects an
absolute time; backwards seeking resets foam. Rendering itself has no GPU
readback. `await ocean.readFrame({signal})` explicitly copies the last rendered
frame into an independent CPU snapshot: time, height, patch lengths and twelve
float32 values per point (displacement XYZ/foam, velocity XYZ/Jacobian, normal
XYZ/unused), in cascade-major order. Render before reading; await each read before
the next. Cancellation, disposal and restoration invalidate a pending copy.
Snapshot time, height and patch lengths are the actual binary32 GPU values,
including their rounding from authored JavaScript numbers.
`dispose()` or `using` detaches the pass and frees owned buffers.

The correctness demonstration uses a retained public-domain NOAA NDBC wind
observation, with provenance in [test/data/README.md](test/data/README.md).
Run `node packages/water/test/fft.browser.mjs`, then the same command with
`--compat`, through the shared GPU lock. The independent Fourier-sum oracle,
Jacobian/normal checks and lifecycle evidence are described in
[the batch record](../../docs/water-fft.md). These are correctness checks,
with no timing or speed claim.

## CPU wave queries

Import `WaveQuery` from `@margoengine/water/query`. Capture a rendered `Water`
or `FFTOcean` once, then query any number of world XZ positions synchronously
on the CPU. The snapshot uses the actual displaced draw triangles, including
camera-following grids, coastline blending and overlapping FFT folds.

```ts
import { Engine } from '@margoengine/core';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
const engine = await Engine.create(document.querySelector('canvas')!);
const water = Water.attach(engine, { size: [128, 128] });
engine.render({ delta: 1 / 60 });
const frame = await WaveQuery.capture(water);
const surface = frame.sample(0, 0);
if (surface) console.log(surface.height, surface.normal, surface.velocity, surface.time);
```

`sample(x, z)` returns height in metres, unit macro normal, upward geometric
triangle normal, surface-particle XYZ velocity in m/s and rendered time in
seconds. `heightAt`, `normalAt` and `velocityAt` return individual fields.
All return `undefined` on dry ground or outside the finite draw mesh. Folded
surfaces return the highest hit. The macro normal is the surface's authored
orientation before a view-dependent underside flip; Water's shading-only
micro ripples do not change geometry or floating-object orientation.

Wave velocities differentiate the same bent Gerstner phases or transformed
FFT fields as the renderer. Coastal motion uses the current conservative
face flux, height gradient and sea relaxation; `still` suppresses that flow.
This is surface-particle motion, including currents, rather than height change
at a fixed world coordinate. It is not a boat dynamics solver.

`capture(source, { signal })` defaults to no cancellation. It performs an
explicit GPU geometry/bounds evaluation and readback; ordinary rendering and
CPU queries perform no readback. A snapshot stays valid after the water is
disposed and retains its original time. Capture another rendered frame to
refresh it. Keep the previous snapshot while the next capture is pending.
Concurrent captures are independent. Aborting, disposing or restoring the
source during capture rejects; capture before the first draw rejects with
linked `state`. Unrendered `setWaveHeight`/`setTime` edits do not leak into the
last rendered snapshot. No GPU resources remain owned after capture resolves.

Snapshot memory is 48 bytes per draw vertex plus 16 bytes per node of a
GPU-built bounding hierarchy, an FFT field copy (48 bytes per spectral sample)
or a coastal field copy (16 bytes per texel). Capturing temporarily also owns
GPU output and staging buffers. Capture frequency and grid resolution control
this cost. Native WebGPU and the full WebGL2 compatibility layer are supported;
the small preview tier cannot render these water sources.

`node packages/water/test/query.browser.mjs` and the same with `--compat`
compare CPU answers to actual GPU raster samples, analytic wave motion to
GPU finite differences, and coastal velocities to an independent flux oracle.
Use the shared GPU lock. Sources and evidence: [wave-query record](../../docs/water-query.md).

## Water bodies

`@margoengine/water/bodies` puts lakes, pools and rivers on one `Water`. Each body is a closed XZ `outline` at its own
`level`, or a river `path` of `[x, level, z]` points with a `width`, smoothed by a uniform Catmull-Rom spline so the
level falls along it. Each has its own share of the Water's waves (`waves`, 0 for a still pool) and colour. Water is
drawn only inside the bodies; the body map (signed distance, level, wave share, index per texel) is rasterized on the
CPU and read with the same bilinear sample by the surface shader, `WaveQuery` heights and `bodies.sample(x, z)`.
Where bodies overlap the later one covers the earlier. The Water grid stays centred on the world origin: size it to
cover `bodies.bounds`. Islands (holes), per-body foam and flow, and a grid that follows the bodies are not done yet.

## Caustics

`@margoengine/water/caustics` lights opaque submerged geometry (a seabed, rocks, hulls, any receiver the camera sees below
the surface) with the light that the live waves refract. Every wave triangle is refracted by Snell's law along the
directional light, projected onto horizontal depth slices and added as conserved flux, so crests focus into bright
filaments and troughs spread out, and the pattern moves with the surface. Light is absorbed per metre in red, green
and blue, the surface entry and the receiver can be shadowed with a `Shadows`, and dry pixels get nothing. It runs before
the water draw, on `Water` and `FFTOcean`, on WebGPU and the WebGL2 layer.

```ts
import { Engine } from '@margoengine/core';
import { Water } from '@margoengine/water';
import { Caustics } from '@margoengine/water/caustics';
const engine = await Engine.create(document.querySelector('canvas')!);
const water = Water.attach(engine, { size: [64, 64], segments: 128, height: 0 });
// A 64 m square of seabed down to 8 m below the surface, a 256 x 256 map in 12 depth slices.
const caustics = Caustics.attach(engine, { surface: water, size: 64, heightRange: [-8, 0] });
engine.render({ delta: 1 / 60 });
```

Defaults: `size` 100 m, `heightRange` [-20, 0], `resolution` 256 (a power of two, 32..2048), `layers` 12 (2..32),
`intensity` 1, `absorption` [0.38, 0.1, 0.045] per metre, `color` [1, 1, 1], `refractiveIndex` 1.333.
Set `enabled: false` for the unlit scene. The flux maps cost `3 * resolution^2 * layers * 8` bytes (18 MiB at the
defaults, 3 GiB at 2048 and 32 layers), and every depth slice draws two triangles per surface cell, so raise
`resolution` and `layers` together with the surface `segments` only as far as the frame budget allows
(measured numbers in [limits](../../docs/limits.md)). There is no per-channel dispersion: every colour refracts at the
same index. Method and sources: [caustics record](../../docs/water-caustics.md).

## Particle liquid

`@margoengine/water/liquid` draws any set of particles as a liquid surface: your own solver's output, a recorded
cache, a compute array. Each particle is a sphere sprite; their nearest depth is smoothed by a narrow-range filter
(sharp silhouettes, no bleeding across depth gaps), and one composite pass refracts the scene behind by the summed
thickness, absorbs it by Beer-Lambert, and adds the Fresnel reflection of the sky and the sun's highlight. It is an HDR
`PostStack` stage on WebGPU and the WebGL2 layer, and renders only: it moves no particle.

```ts
import { Engine } from '@margoengine/core';
import { ParticleLiquid } from '@margoengine/water/liquid';
const engine = await Engine.create(document.querySelector('canvas')!);
// 32,768 particles 2.5 cm apart in a block; after each step of your own solver call liquid.update().
const positions = new Float32Array(32768 * 3);
for (let i = 0; i < 32768; i++)
  positions.set([(i % 32) * 0.025 - 0.4, Math.floor(i / 1024) * 0.025, (Math.floor(i / 32) % 32) * 0.025 - 0.4], i * 3);
const liquid = ParticleLiquid.attach(engine, { particles: { positions }, radius: 0.025 });
engine.render({ delta: 1 / 60 });
```

`particles.positions` is a `Float32Array` (uploaded at creation and on each `update()`), a `GPUBuffer` with STORAGE
usage, or anything with such a `buffer` such as a `@margoengine/compute` `GpuArray` (read in place, no copy);
`stride` (default 3 floats), `offset` (0) and `count` (required for a GPU source) say where the centres are. Up to
4,194,304 particles. Defaults: `radius` 0.05, `ior` 1.333, `absorption` [0.38, 0.1, 0.045] per world unit (Water's own),
`color` [1, 1, 1], `smoothing` 0.7 * radius (the filter's world-space sigma), `filterRange` 10 * radius and
`filterClamp` radius (the paper's delta and mu), `maxFilterRadius` 32 pixels, `thicknessScale` 1 (the thickness is the
sum of the sphere chords; set it to your packing fraction), `resolutionScale` 1 (0.5 draws the thickness at half
resolution), `shininess` 2000, the sky gradient of Water (`skyHorizon`, `skyZenith`) or an `environment` texture, and
`enabled` true. A frame is six render passes and six draws (two instanced sprite draws, four full-screen ones), one
320-byte uniform write and no new bind group; `frameStats` reports them. The liquid writes no scene depth. Method,
sources and measured numbers: [liquid record](../../docs/water-liquid.md).

## Wave subsurface scattering

`@margoengine/water/scatter` makes thin crests glow when the viewer looks toward one of the Water's directional
lights, as sunlight does through a breaking wave. `WaterScatter.attach(engine, { surface })` takes optional `color`
(linear RGB), `strength`, `power` (how tightly the glow gathers around the light) and `distortion` (how much the wave
normal bends it); `set` changes them later. Attach it after `WaterBodies` so each body's level is used. It changes
shading only.

## Rain ripples

`@margoengine/water/rain` puts rain drop rings on a `Water`. `WaterRain.attach(engine, { surface, weather })` follows a
`WeatherMachine`'s `state.rain` (or any object with a numeric `rain`); without a weather, `rain` sets the intensity.
`cell`, `lifetime` and `strength` shape the rings, which fade out with distance. With `splashes: { field }` heavier
drops also fall into a `Ripples` field around the camera, so the simulated surface moves too. It composes with
`WaterFlow` in either attach order.
