# @margoengine/water

Gerstner water surfaces, terrain-coupled shallow-water flow, foam and spray.

Import `margoengine/water` from the `margoengine` package, or `@margoengine/water` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A separate WebGPU water grid evaluates up to eight swell trains with analytical normals. Each train spreads into three Gerstner components with varied directions, wavelengths and gently bending crests. Advected gradient noise (random unit gradients, Perlin's 2002 quintic fade, analytic derivatives) adds wind agitation and micro-ripples, filtered separately by their screen footprint. Fresnel reflection, sun glints and wavelength-dependent absorption shade the surface. Optional terrain coupling adds conservative GPU shallow-water flow (the momentum-conservative staggered scheme of Stelling and Duinmeijer 2003 with Manning bed friction, its speed capped at half a cell per step, so falls of any height stay bounded and a swash runs up a beach), moving breaker foam and a fixed GPU spray pool.

```ts
import {Water} from 'margoengine/water';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const water = Water.attach(engine, {size: [100,100], segments: 128, height: 0, chop: 0.35});
```

For an open ocean, set `horizon: true`. The central 75% of each grid axis keeps
its original spacing and follows the camera in whole cells, so the swell
surrounds the camera wherever it goes and the waves stay put in the world. Each
outer row is a fixed ratio wider than the one inside it, out to 10 km past the
grid's edge, and the last row lies 10,000 km out, so the sea meets the true
horizon even from a camera kilometres up. Below the far clip the displaced mesh
writes its ordinary scene depth. Beyond the far clip a flat quad fills the ocean
at sky depth, where it cannot cover opaque terrain inside the camera's range.
Wave displacement and normals fade
together over those rows as the cells grow too large to resolve the wavelength.
The default grid remains bounded and centred on the origin for ponds and finite
surfaces. Use a size that keeps the shoreline and terrain map within 37.5% of
`size` of the camera, where the cells are regular.

The five ripple layers fade according to their projected screen footprint in
the direction of each layer. A nonzero `chop` adds two short crossing wave
bands whose crests and strength vary across travelling wind patches. This is
shading detail, with the swell trains still controlling the mesh, depth and buoyancy.

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

With `sceneColor`, Water traces the Snell-bent ray against opaque depth in the
current view. The sampled color and attenuation use the same intersection.
A ray that leaves the frame takes the last scene texel it crosses on screen;
one that misses the capture uses the fallback seabed and water-body color.
`foamDistance` uses the local contact depth to place foam at the shore or hull.
See [screen-space water refraction](../../docs/limits.md#above-water-screen-space-refraction)
for the capture limits.

The borrowed sky texture must be a sampleable single-layer `rgba16float` 2D texture. The borrowed scene color must be a viewport-sized single-layer `rgba16float` texture with `COPY_SRC` usage. Water retains one GPU snapshot for depth-rejected screen refraction and seabed attenuation. Without these providers, it uses a sky gradient and an approximate seabed color. Reflections represent the atmosphere, not nearby objects.

Pass an `Environment` as `reflectionEnvironment` to use the same longitude, live rotation, and HDR radiance scale as `EnvironmentBackground`. Use `() => sky.reflectionTexture` for the procedural `Sky` package. Both forms filter reflections across azimuth and elevation with a lobe widened by the wave normals' screen footprint. On open water, a down-going reflection samples horizon radiance with a softer weight to approximate occlusion by nearby waves. The HDR sky also lights the water body and refracted seabed through a cosine-weighted irradiance estimate.

The same HDR environment lights the surface and appears in Snell's window below it through `@margoengine/water/underwater`.

```ts
import {Engine} from 'margoengine/core';
import {Environment, EnvironmentBackground} from 'margoengine/environment';
import {Water} from 'margoengine/water';
import {Underwater} from 'margoengine/water/underwater';
const engine = await Engine.create(document.querySelector('canvas')!);
const sky = await Environment.attach(engine, {
  width: 2, height: 1,
  data: new Float32Array([0.3, 0.4, 0.6, 1, 0.8, 0.7, 0.6, 1]),
}, {float32: false});
EnvironmentBackground.attach(engine, sky);
const surface = Water.attach(engine, {size: [200, 200], horizon: true, reflectionEnvironment: sky});
Underwater.attach(engine, {surface, skyEnvironment: sky});
engine.render({delta: 0});
```

For reflections of nearby geometry, attach the optional planar adapter with a
horizontal capture aligned to the water surface. The adapter fades across the
capture edge and toward the horizon into the base reflection using the filter footprint
and projected wave offset, so an open surface does not show a hard rectangular edge.

```ts
import {Engine} from '@margoengine/core';
import {Reflector} from '@margoengine/environment/reflector';
import {Water} from '@margoengine/water';
import {WaterReflection} from '@margoengine/water/reflector';

const engine = await Engine.create(document.querySelector('canvas')!);
const surface = Water.attach(engine, {size: [80, 80], height: 0});
const reflector = Reflector.attach(engine, {width: 80, height: 80, captureOnly: true});
reflector.node.setRotation([-Math.PI / 2, 0, 0]);
WaterReflection.attach(engine, {surface, reflector});
engine.start();
```

`contactHardening: true` blurs the planar reflection by a roughness cone instead of the cross filter: a pier or hull
reflects sharp where it meets the water and softer with height above it, and the far shore softest. The cone's
roughness is the waves' slope variance inside each pixel (alpha² = 2 variance, after Toksvig 2005; the waves a pixel
resolves already bend the lookup), and at least `roughness`. It reads the Reflector's `blurTexture` (its mip chain, so
give the Reflector a `roughness` above 0) and `depthTexture`; it is fixed at construction. The cone and distance maths
are environment's (`@margoengine/environment/reflector`, "Rough reflections with contact hardening": Karis 2013,
Walter et al. 2007, Uludag 2014).

```ts
import {Engine, PbrMaterial, box} from '@margoengine/core';
import {Reflector} from '@margoengine/environment/reflector';
import {Water} from '@margoengine/water';
import {WaterReflection} from '@margoengine/water/reflector';

const engine = await Engine.create(document.querySelector('canvas')!);
const surface = Water.attach(engine, {size: [80, 80], height: 0});
engine.createMesh().setGeometry(box(0.4, 3, 0.4)).setMaterial(new PbrMaterial({color: '#6b4a2b'})).setPosition([0, 1.5, 0]);
const reflector = Reflector.attach(engine, {width: 80, height: 80, captureOnly: true, roughness: 1});
reflector.node.setRotation([-Math.PI / 2, 0, 0]);
WaterReflection.attach(engine, {surface, reflector, contactHardening: true, roughness: 0.1});
engine.start();
```

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
map, as the scene's single blended light does. The depth-based contact band uses
`foamDistance` in metres. Screen-space edge filtering is restricted to that
local band, so a deeply submerged object's silhouette produces no contact foam.

`whitecaps` (0 to 1, default 0) breaks steep crests into white foam: where the summed slope of a crest's
components passes a threshold that falls as the amount rises, read a little ahead of the crest where spilling foam
runs down the face, broken into patches by gradient noise, with long foam streaks down-wind toward 1. With
`terrain`, foam lines ring the land (ground near the sea in a few taps round each point) and drift with the
backwash, breaker foam grows, and with `spray` more and larger droplets fly from the breakers. While it is above 0,
foam also takes the light of the sky above it, so whitecaps read at night. `chop` (0 to 1, default 0) roughens the
normals: the ripple layers grow and a short wind-sea layer joins them. `water.setWhitecaps(amount)` and
`water.setChop(amount)` change either from the next frame (a storm slider), and both reject values outside 0 to 1
with RangeError. At 0 both draw exactly as before.

For beaches and inland dips, supply `terrain: {heightmap: () => texture,
origin: [-80,-80], size: [160,160]}`. The borrowed heightmap must contain world-space
Y heights in a sampleable `r32float` texture, from 2 cells per side up to the device's
`maxTextureDimension2D` (8,192 on every WebGPU device; 512 until 2026-11-24, FG-02), within its storage binding limit
(one 4-byte word a cell for a flood or river, nine for the open-sea surf, else a coded error naming the bytes). Each cell holds
water depth and exchanges conservative flux with its neighbors; higher ground
blocks flow and outlet sills retain puddles as the sea recedes. A GPU connectivity
pass identifies below-sea-level cells connected to the map boundary. Those open-sea
cells get breaking surf by default (next section); enclosed basins receive no offshore forcing. Initially, depressions below the mean sea level are filled;
higher depressions start dry. Resize preserves simulation state, while replacing
the height texture or restoring the device resets it. All simulation textures,
bind groups and pass descriptors are retained between frames.

### Surf on a beach

A swell running onto a sloping beach shoals, turns toward the shore and breaks in lines, with no surf options: give the
water `waves` and a `terrain` map whose open sea reaches the map edge. When the flow starts, a GPU pass solves each
open-sea cell's travel time from deep water (an eikonal, relaxed over the eight neighbours), so every swell component
arrives with its phase delayed and its crest turned by the depth (Snell's law). Its wavenumber follows the depth
(Fenton and McKee 1990), its height grows by linear shoaling and is capped at 0.78 of the depth (McCowan), and the
breaking wave takes a skewed, forward-leaning shape fitted to measured surf (Abreu et al. 2010, Ruessink et al. 2012).
Breaking crests carry a roller of white foam with a lacy trail behind it. Breaking is short-crested: it starts and
stops along each crest in sections about 0.45 surf wavelengths over the swell's directional spread long (Baker et al.
2023), the white water thins where a section breaks less, its toe is ragged and its body has holes. The broken water
turns grey-green with
stirred sand, and short wind waves fade where the swell breaks. Seaward of 0.9 m of depth the surface is this analytic
surf; between 0.9 and 0.35 m it hands over to the conservative shallow flow, which it drives (height and flux, as a
numerical wave maker), and the flow carries the bores up the sand: it carries their momentum (Stelling and Duinmeijer
2003) and drags on the sand (Manning n 0.02), so a 1 m, 60 m swell on a 1:50 beach runs 0.126 m up it on 0.78 m cells,
near Hunt's 0.155 m for regular waves (more on finer cells), and a solitary wave runs up within 1.5% of Synolakis 1987.
The flow spins up over the surf's last 40 s before its first frame, so the swash and the wet sand are there from the
first frame (about 0.4 s more on the first frame on WebGPU for a 512 x 82 map, 3 s on the WebGL2 layer; about 4.5 s of
GPU time for a 512 x 512 map on a laptop GPU). That set-up goes to the GPU ahead of the frame in pieces of at most
2^18 workgroups, each its own submission, so no single submission runs past the 2 s after which Windows resets the GPU
(KB-SCENES-DUNE-ARCHANG1). It reads the heightmap as uploaded; a heightmap you write on the GPU in the same frame's
command encoder is not ready for it, so write it in an earlier frame or submission. Still water
(`still`) and `water/rivers` get no surf field. The surf follows the train with the most height (the peak of the sea), so a wind sea (`wind`, no `waves`) breaks
too; until 2026-11-17 its near-empty long trains set the field and its waves never broke (KB-WATER-SURFFIELD1).

**The breaker line on the CPU.** Give `terrain.heights` (the heightmap's values, row by row along z) and
`water.breakerLine()` returns where the swell starts breaking: the seabed contour at `breakerDepth`, the deepest water
where the shoaled root-mean-square height of the sea reaches 0.78 of the depth, as [x, z] segments. It follows `setWind`
and `setWaveHeight` and is kept until they change it. A `WeatherDrive` reads it from every `water:N` in the scene to
thicken the sea spray near the breakers; `breakerDepth(waves)` and `contourSegments(heights, origin, size, level)` are
exported for other uses.

```ts
import { Engine } from '@margoengine/core';
import { Water } from '@margoengine/water';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
// A beach along z: dry sand at x < 0, the seabed falling 1 m per 50 m to 7 m deep at the map edge.
const side = 256;
const ground = new Float32Array(side * side);
for (let j = 0; j < side; j++)
  for (let i = 0; i < side; i++) {
    const x = ((i + 0.5) / side) * 400 - 50;
    ground[j * side + i] = x > 0 ? -x / 50 : -x / 28;
  }
const heightmap = engine.gpu!.createTexture({
  size: [side, side],
  format: 'r32float',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
engine.gpu!.queue.writeTexture({ texture: heightmap }, ground, { bytesPerRow: side * 4 }, [side, side]);
const water = Water.attach(engine, {
  size: [1200, 1200],
  segments: 128,
  horizon: true,
  // `heights` is the same ground on the CPU, for the breaker line.
  terrain: { heightmap: () => heightmap, origin: [-50, -200], size: [400, 400], heights: { data: ground, width: side, height: side } },
  // A 60 m swell of 1 m height heading for the beach.
  waves: [{ direction: [-1, 0], amplitude: 0.5, wavelength: 60, steepness: 0.35 }],
});
// The swell starts breaking about 1 m deep, 50 m out on this 1:50 beach.
console.log(water.breakerLine()[0]);
```

The surf adds 32 bytes per heightmap cell of GPU memory (two travel-time fields), built once when the flow starts and
again when the heightmap is replaced or the device restored. Limits are in `docs/limits.md` (Water surf).

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
continuous across the map edge. Refraction samples submerged geometry only, where the
ray bent by Snell's law meets it: at a grazing view, ground far along the unbent eye ray stays hidden, since its light
could leave the water only outside Snell's window;
clear-depth sky pixels never become seabed color. Shoreline fragments retain
helper lanes until their screen derivatives are complete, then discard dry cells.

The solver runs three GPU substeps per frame and caps elapsed simulation time at
1/15 second after a stall. Fast shallow flow generates breaker foam, which advects
and decays with the water. Set `spray: true` with terrain coupling to enable a fixed
GPU droplet pool of `sprayCount` droplets (a multiple of 64 from 64 to 65,536, 32 B each; default 4,096), with gravity,
water/terrain collision and soft depth fading. Droplets fly from the breakers, and clumps of spray burst up cliffs and
sea stacks in open water where a swell crest drives its water into them (the swell's orbital velocity into the wall),
and up any wall the flow itself runs at (flood or surge water: the speed into the wall of the water one cell out). It approximates breaking surf and wall impact; it
does not solve overturning wave volumes or erosion. Use heightmap cells of roughly 0.5 metres or larger for this preset;
very small cells require more substeps.

`water.setSeaLevel(y)` moves the mean sea level (world Y, -100,000 to 100,000; `water.seaLevel` reads it) every frame
without rebuilding anything. With terrain coupling the flow's map edge and open-sea cells follow it, so a level raised
slowly floods the land below it from the sea and a fall drains it again: a storm surge or a tide. The open sea, the surf
and the wave queries ride on the new level. `test/surge.browser.mjs` raises a beach's sea by 1 m over 10 s: a cell at
0.45 m floods to 0.55 m within 0.1 m, ground at 1.45 m stays dry, the sea holds its still-water volume at rest (within
1%) and at the raised level (within 2%), and after the fall the beach drains to under 0.02 m and the sea returns to its
volume within 2%, on WebGPU and the WebGL2 layer.

`water.setFarField({sides, profile, range, spread})` (null by default, read every frame) makes the open sea past the
terrain's sea sides a long wave instead of one level: `profile` is the rise over the sea level at 2 to 64 evenly spaced
distances from 0 to `range` metres past the sides (the last holds beyond), and near a side the sea starts from the flow's
own edge level where water stands there, its difference spread as 1 / sqrt(1 + r / `spread`) (default the terrain's
longer side). The surface, its normals and the wave queries all carry it. `water/flood` sets it from its surge and
tsunamis (see "The sea, tsunamis, wind and rain").

```ts
import {Water} from 'margoengine/water';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const N = 64, ground = new Float32Array(N * N).map((_, k) => -2.95 + 0.1 * (k % N)); // a beach rising along x
const device = engine.gpu!; // WebGPU, or the WebGL2 compatibility layer's device
const heightmap = device.createTexture({size: [N, N], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
device.queue.writeTexture({texture: heightmap}, ground, {bytesPerRow: N * 4}, [N, N]);
const sea = Water.attach(engine, {size: [64, 64], segments: 64, spray: true, sprayCount: 16384,
  terrain: {heightmap: () => heightmap, origin: [-32, -32], size: [64, 64]}});
let t = 0;
const frame = () => {
  t += 1 / 60;
  sea.setSeaLevel(Math.min(1, t / 10)); // a 1 m surge over ten seconds
  engine.render({delta: 1 / 60});
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```

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

Physical WebGPU all-shore run-up/recession, beach surf (shoaling, depth-limited breaking, foam), deep isolated-basin retention, curved-crest/normal, zero-amplitude, channel, spray, whitecaps and chop, triangle-order, coastal-seam,
refraction (depth-checked bent rays), HDR sky radiance, contact foam and device-restoration checks. Run every Water browser suite from the repository root with
`npm run check:gpu-packages -- --only=water`. Set `MARGO_COMPAT=1` for the WebGL2 compatibility layer.
(build core, post and terrain packages first). Each suite runs with its own time limit.

## A sea from the wind

A Water with no options already has this sea: with neither `waves` nor `wind`, `wind` is 6 m/s (a gentle breeze: 0.8 m significant height, 0.17% of the sea under foam, a glitter lobe to match). Passing `waves` keeps exactly your trains and the old calm default, two trains along [1, 0.3] and [1, 0.6] with amplitudes 0.3 and 0.15 and wavelengths 12.73 and 7.19 m, is
`waves: [{direction: [1, 0.3], amplitude: 0.3, wavelength: 12.73, phase: 0.43}, {direction: [1, 0.6], amplitude: 0.15, wavelength: 7.19, phase: 2.17}]` (with `whitecaps` 0 for the old unbroken crests). `setWind` throws on a Water made with `waves`.

Give `wind` (m/s at 10 m, or `{ speed, fetch, direction }`) and the swell trains become the fetch-limited JONSWAP sea of
that wind: `Hs = 0.0016 sqrt(g F / U^2) U^2 / g`, never above the fully developed `0.22 U^2 / g` (10 m/s over 100 km is
1.6 m, a 6 s peak and 57 m crests). The eight trains sit on fixed wavelengths from 2 m to 1,500 m, so `setWind` changes
only their amplitudes, directions and steepness, every frame if you like (a `fetch` or `direction` you leave out, or pass as `undefined`, keeps the one the Water holds), and no wind from 0 to 100 m/s folds the surface
(each train's steepness keeps `steepness * amplitude * k` under `1 / trains`). Wind 0 is a flat sea. `wind` is ignored when
`waves` is given. `@margoengine/water/sea-state` is the same sea as plain numbers, with no GPU:

```ts
import {Water} from 'margoengine/water';
import {seaState, whitecapCoverage} from 'margoengine/water/sea-state';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const sea = Water.attach(engine, {size: [4096, 4096], segments: 512, horizon: true, wind: {speed: 8, direction: [1, 0.3]}});
// A front arrives: the sea builds over the next seconds, the trains keep their wavelengths.
let speed = 8;
const frame = () => {
  sea.setWind({speed: (speed = Math.min(25, speed + 2 / 60)), direction: [1, 0.3]});
  engine.render({delta: 1 / 60});
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
const state = seaState(25);
console.log(state.significantHeight, state.peakPeriod, state.peakWavelength, whitecapCoverage(25));
```

With `wind` set and `whitecaps` left out, the foam follows the wind: it covers `3.84e-6 U^3.41` of the sea (0.5% at 8 m/s,
4% at 15, 22% at 25; none below 3), whatever the `chop`, and `setWind` moves it with the sea. In a top-down 200 m view
the foam that is at least half white measures 0.45% at 8, 4.0% at 15 and 24% at 25, and 0.012% at 3
(`test/whitecap-coverage.browser.mjs`, WebGPU and the WebGL2 layer). Pass `whitecaps` (0 to 1) to set the foam by hand
instead; `whitecaps: 0` turns it off. The sun's glitter widens with the wind too: with `wind` set, the glint lobe gets the
rest of Cox and Munk's mean square slope `0.003 + 0.00512 U` after the swell and ripples (its half width at 2 and 12 m/s
is within a factor 1.5 of Cox and Munk's crosswind slope, `test/glitter.browser.mjs`). The sea's body is lit by the sky it
mirrors: a Water with no options under a night's low ambient is not brighter than the sky above the horizon
(`test/night-sea.browser.mjs`); a clear day's sky lights it as before.

`seaState(U, {fetch, direction, trains, seed})` returns the significant height, peak period and wavelength, whether the sea is
fully developed, the whitecap coverage `3.84e-6 U^3.41` (1% at 10 m/s, 22% at 25) and the `waves` for `WaterOptions.waves`.
Sources: Hasselmann et al. (JONSWAP) 1973; Pierson and Moskowitz 1964; Horvath, DigiPro 2015; Monahan and O'Muircheartaigh 1980.

### The physics sea, drawn: `sea`

Pass a physics sea (`SpectralSea` of `@margoengine/physics/sea`, or anything with `waveComponents(t, out)`) as `sea` and
Water draws its waves in place of the swell trains: the same linear waves, the same spectrum, phases and seed, at
Water's time (`setTime`, or the frame clock), so a hull floating on `sea.sample` rides the waves the camera sees. Each
frame the sea works out every wave's phase at that time in doubles and Water uploads them once as f32 (at most
`WATER_SEA_WAVES`, 896, which holds every bin of the wave solver's default spectrum); the shader sums them as the
physics does, height `a cos(theta)` with no sideways displacement. Waves shorter than two of the mesh's samples fade out
of the drawn surface, as the swell's do. The wind still drives what is only seen: the shading ripples, the glints and the
foam patterns, which are not part of the surface a query reads. `test/sea-agreement.browser.mjs` captures the drawn surface
at 2,000 vertices over three times (to an hour) and checks height and normal against `sea.sample` inside the bound in
`docs/limits.md` ("Drawn sea"), on WebGPU and the WebGL2 layer: on an Apple M6 the largest height difference is 0.002 mm.

```ts
import {Water} from 'margoengine/water';
import {Engine} from 'margoengine/core';
import {SpectralSea} from 'margoengine/physics/sea';
import {jonswap} from 'margoengine/physics/waves';

const engine = await Engine.create(document.querySelector('canvas')!);
const spectrum = {
  frequencies: Float64Array.from({length: 34}, (_, i) => 0.04 * 25 ** (i / 33)),
  directions: Float64Array.from({length: 24}, (_, j) => (2 * Math.PI * j) / 24),
  energy: new Float64Array(34 * 24),
  depth: 40,
  density: 1025,
};
jonswap({height: 2, period: 8, direction: 0}, spectrum);
const sea = new SpectralSea({waves: spectrum, seed: 1});
const water = Water.attach(engine, {size: [400, 400], segments: 512, sea});
water.setTime(12);
engine.render({delta: 0});
console.log(sea.sample(0, 0, 12).height.toFixed(2)); // the height the camera sees at the origin
```

### A physics wake, drawn: `WaterWake` (`@margoengine/water/wake`)

`WaterWake.attach(engine, {surface: water, wake})` draws a physics wake (`WakeSolver` of `@margoengine/physics/sea`, or
anything with a `grid` and `heights()`) on a Water: each frame the wake's height grid, as the solver holds it after its
last step, goes to the GPU once (its doubles rounded once to f32), and the surface adds it to the waves it draws, read by
the same bilinear rule and slope as `WakeSolver.sample` (0 within a cell and a half of the grid's edge; the slope a
central difference one cell either side). So with the wake also among the sea's `patches`, the hull floating on
`sea.sample` rides the wake the camera sees, and WaveQuery reads it too. `test/wake-agreement.browser.mjs` captures the
drawn surface at 1,362 vertices, 494 of them on the wake, and checks height and normal against `sea.sample` inside the
bound in `docs/limits.md` ("Drawn wake"), on WebGPU and the WebGL2 layer: on an Apple M6 the largest difference is 0.04
percent of the bound. `dispose()` (or the Water's) stops drawing it and frees its two buffers.

```ts
import {Water} from 'margoengine/water';
import {WaterWake} from 'margoengine/water/wake';
import {Engine} from 'margoengine/core';
import {SpectralSea, WakeSolver} from 'margoengine/physics/sea';
import {PhysicsWorld} from 'margoengine/physics/world';

const engine = await Engine.create(document.querySelector('canvas')!);
const wake = new WakeSolver();
const world = new PhysicsWorld({rate: {num: 30, den: 1}}).add(wake, {
  cells: [256, 128],
  cellSize: 0.5,
  // A hull 12 m long at 4 m/s: 0.3 m of water's weight on its waterplane.
  sources: (t) => [{x: -50 + 4 * t, z: 0, radius: 6, pressure: 1025 * 9.81 * 0.3, volume: 0}],
});
const spectrum = {frequencies: Float64Array.from([0.1, 0.2]), directions: Float64Array.from([0, Math.PI]), energy: new Float64Array(4), depth: Infinity, density: 1025};
const sea = new SpectralSea({waves: spectrum, patches: [wake]});
const water = Water.attach(engine, {size: [120, 60], segments: 512, sea});
WaterWake.attach(engine, {surface: water, wake});
world.advance(10 * 30); // ten seconds of the hull's run
water.setTime(10);
engine.render({delta: 0}); // the wake drawn where the physics has it
```

### Sliders for every control: settings

`@margoengine/water/settings` lists every live Water control as one table for panels and tools, and names eleven looks made
only of its values. `WATER_SETTINGS` has thirteen rows: `windSpeed` (m/s), `windDirection` (compass degrees, 0 is +Z, 90 is
+X), `fetch`, `whitecaps`, `chop`, `waveHeight`, `seaLevel` (m, world Y), `color`, `foamDistance`, `glitterRoughness` (0.02 to 0.6, the floor of the sun glitter's roughness; 0.12 is the real sea's), `foamSoftness` (0 to 1: 0 is the physical foam, 1 fades its fine pattern and widens its edge into large soft shapes), `shallowColor` and `shallowDepth` (m: water over a bed less than that deep takes the shallow colour, fading into the deep one; 0 turns the band off). Each gives `name`, `group`, `kind`, `default`,
`min`, `max`, `step`, `unit`, `about` and `live`; the row shape is shared by every package's settings
(`packages/shared/settings.js`). All thirteen are `live`: a row writes numbers into the frame's uniform and never makes a
pipeline, buffer or texture, so a film can key any of them over a shot (`test/settings.test.js` counts 60 frames of every
row, and the last frame equals writing those values once). What a Water is built from (`size`, `segments`, `waves`,
`terrain`, `spray`, `sprayCount`, `horizon`, the capture hooks) is chosen when it is made; `height` is the starting
`seaLevel`.

`windSpeed`, `windDirection`, `whitecaps` and `chop` are what the weather drives, so their default is null, which
follows the weather: a `WeatherDrive` sets the wind (and with it the foam), and a null row leaves what it set. A null
`whitecaps` lets the wind decide the foam, a null `waveHeight` gives the trains the wind's own amplitudes, a null `chop`
leaves the chop alone (a chop these rows set goes back to the options' `chop`, and when `windSpeed` and `windDirection`
are both null a wind these rows set goes back to the one the Water had before they set it, so `WATER_LOOKS.natural`
after another look draws the Water as it was made), a null `seaLevel` (its default) keeps the level the Water was made with or last given. The other rows' defaults are what a Water does without the option, so applying them changes no byte
of the frame (`test/settings.test.js`; `test/settings.browser.mjs` on WebGPU and the WebGL2 layer). The wind rows need a
Water made without `waves`; on one made with `waves`, `applyWaterSettings` throws a TypeError for them. A `waveHeight` the
wind's steepness cannot carry folds the surface and throws, as `setWaveHeight` does. Values are checked before anything is
written: an unknown name is a TypeError, an out-of-range value a RangeError.

```ts
import {Water} from 'margoengine/water';
import {WATER_LOOKS, WATER_SETTINGS, applyWaterSettings, waterSettingDefaults} from 'margoengine/water/settings';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const sea = Water.attach(engine, {size: [4096, 4096], segments: 512, horizon: true});
applyWaterSettings(sea, WATER_LOOKS.gale);                          // a named look
applyWaterSettings(sea, {...WATER_LOOKS.gale, whitecaps: 0.2});     // a look with one slider moved
const panel = waterSettingDefaults();                               // a slider panel's state
for (const row of WATER_SETTINGS) console.log(row.group, row.name, row.default, row.min, row.max, row.unit, row.live);
let t = 0;
const frame = () => {
  applyWaterSettings(sea, {windSpeed: 4 + 20 * Math.min(1, (t += 1 / 600)), chop: 0.5}); // a front builds over ten seconds
  engine.render({delta: 1 / 60});
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
void panel;
```

The looks are `glassy`, `calm`, `breeze`, `tropical`, `arctic`, `harbour`, `gale`, `storm`, `hurricane`, `flood` and `nightSea`;
the sea's own height, period and foam for a wind are in `seaState` above.

## Fog

With `@margoengine/environment/volumetric`'s `VolumetricFog` in the scene the water needs no fog of its own: the
froxel fog composites over the water's depth (with a post capture it finds the depth the water drew this frame by
itself, so the surface, not the sea bed or the sky, ends each ray; pass `depth: () => water.depthTexture` only with no
capture), and past its `range` it fogs the far sea and the sky with the same air in closed form, so the horizon
meets the sea with no step. `setFog` below stays for a scene without VolumetricFog, or to override it.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Water} from 'margoengine/water';
import {VolumetricFog} from 'margoengine/environment/volumetric';
import {Tonemap} from 'margoengine/tonemap';
const engine = await Engine.create(document.querySelector('canvas')!);
Sky.attach(engine, {hours: 17});
Tonemap.attach(engine); // the post capture gives the fog the scene depth, the water's surface included
Water.attach(engine, {horizon: true});
VolumetricFog.attach(engine, {visibility: 3000});
```

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

Checked on a real GPU (NVIDIA RTX A6000, Edge 155; `node scripts/run-with-timeout.mjs -- node
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

Other capture effects take the water too: `SceneTargets.add(water, {ground: false})` (`@margoengine/post/mrt`),
`meshBlend.tag(water, radius)` and LightBounce get their own `margoSSR` with the water's surface (its normal, its body
colour with the foam it shows, its roughness, not metal) instead of SSR's reflection fields, and its depth. One water
can be in several effects at once; each keeps its own capture pipeline.

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
`--compat`. The independent Fourier-sum oracle,
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
last rendered snapshot. A capture from a plugin's `onPreUpdate`, where a scene
steps a floating object each frame, reads the frame on screen. No GPU resources
remain owned after capture resolves.

Snapshot memory is 48 bytes per draw vertex plus 16 bytes per node of a
GPU-built bounding hierarchy, an FFT field copy (48 bytes per spectral sample)
or a coastal field copy (16 bytes per texel). Capturing temporarily also owns
GPU output and staging buffers. Capture frequency and grid resolution control
this cost. Native WebGPU and the full WebGL2 compatibility layer are supported;
the small preview tier cannot render these water sources.

`node packages/water/test/query.browser.mjs` and the same with `--compat`
compare CPU answers to actual GPU raster samples, analytic wave motion to
GPU finite differences, and coastal velocities to an independent flux oracle.
Sources and evidence: [wave-query record](../../docs/water-query.md).

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
the water draw, on `Water` and `FFTOcean`, on WebGPU and the WebGL2 layer. The beams and the projection are the shared
ones of `@margoengine/post/caustics`, whose `SurfaceCaustics` casts the same light from any surface mesh.

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

`Caustics.attach`, `Underwater.attach` and `ParticleLiquid.attach` add the effect to the scene's `PostStack` after its
last HDR effect when the scene has one (for example SSAO's), or make a stack for it when it has none; disposing the
effect takes it out, and a stack made for it goes with it (`PostStack.join` in `@margoengine/post`).

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
usage, anything with such a `buffer` such as a `@margoengine/compute` `GpuArray` (read in place, no copy), or
`(device) => buffer` (also `velocities`), called once per device and again after a device restore, so a restore costs
nothing: `positions: (device) => device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })`.
A plain `GPUBuffer` belongs to the device that made it: after a restore it is dropped and reported once through
`engine.onError` (`'state'`, help `borrowed-lost`), the lost positions draw no particles and the lost velocities no
whitewater, until `liquid.update({ positions, count })` hands in a new one;
`stride` (default 3 floats), `offset` (0) and `count` (required for a GPU source) say where the centres are. Up to
4,194,304 particles. Defaults: `radius` 0.05, `ior` 1.333, `absorption` [0.38, 0.1, 0.045] per world unit (Water's own),
`color` [1, 1, 1], `smoothing` 0.7 * radius (the filter's world-space sigma), `filterRange` 10 * radius and
`filterClamp` radius (the paper's delta and mu), `maxFilterRadius` 32 pixels, `thicknessScale` 1 (the thickness is the
sum of the sphere chords; set it to your packing fraction), `resolutionScale` 1 (0.5 draws the thickness at half
resolution), `shininess` 2000, the sky gradient of Water (`skyHorizon`, `skyZenith`) or an `environment` texture, and
`enabled` true. A frame is six render passes and six draws (two instanced sprite draws, four full-screen ones), one
320-byte uniform write and no new bind group; `frameStats` reports them. The liquid writes no scene depth. Method,
sources and measured numbers: [liquid record](../../docs/water-liquid.md).

### Whitewater

Give the particles their velocities and set `whitewater`, and the liquid makes spray, foam and air bubbles where it
traps air or breaks at a crest, scaled by kinetic energy (Ihmsen et al. 2012). Each `update()` advances the whitewater
one `timeStep`, so call it once per solver step; frames without one only draw it.

```ts
import { Engine } from '@margoengine/core';
import { ParticleLiquid } from '@margoengine/water/liquid';
const engine = await Engine.create(document.querySelector('canvas')!);
// Two blocks of 4,096 particles 5 cm apart meeting at 4 m/s; your solver rewrites both arrays each step.
const positions = new Float32Array(8192 * 3);
const velocities = new Float32Array(8192 * 3);
for (let i = 0; i < 8192; i++) {
  const side = i < 4096 ? -1 : 1,
    j = i % 4096;
  positions.set([side * 0.45 + (j % 16) * 0.05 - 0.375, Math.floor(j / 256) * 0.05, (Math.floor(j / 16) % 16) * 0.05], i * 3);
  velocities.set([-side * 4, 0, 0], i * 3);
}
const liquid = ParticleLiquid.attach(engine, {
  particles: { positions, velocities },
  radius: 0.025,
  whitewater: { kineticEnergy: [0.5, 5] },
});
liquid.update(); // after each solver step
engine.render({ delta: 1 / 60 });
console.log(await liquid.readWhitewater()); // { spray, foam, bubbles }
```

`particles.velocities` follows the positions' layout (same `stride`; `velocityOffset` for an interleaved array). The
defaults are the paper's: trapped-air range `trappedAir` [5, 20] m/s, `waveCrest` [2, 8], `kineticEnergy` [5, 50] J with
`particleMass` 1000 * (2 * radius)^3 kg (a water cube one spacing wide; small scenes need a lower energy range, as
above), fewer than `sprayNeighbours` 6 fluid neighbours makes spray, more than `bubbleNeighbours` 20 a bubble, and
`support` (the fluid's influence radius h) is 4 * radius. Also: `trappedAirRate` and `waveCrestRate` 100 particles per
second at full potential, `maxParticles` 65,536 (the oldest are replaced first), `timeStep` 1 / 60 s, foam `lifetime`
[2, 6] s, bubble `buoyancy` 2 and `drag` 0.8, `gravity` [0, -9.81, 0], sprite `radius` 0.25 * radius, `color` [1, 1, 1],
`opacity` 0.7, `seed` 0 and `surfaceThreshold` 0.25. Everything runs as render passes on the GPU, on WebGPU and the
WebGL2 layer alike, and the same seed gives the same whitewater on both. The code loads on first use.

### Narrow band

Set `narrowBand` and only the particles near the surface go into the depth pass; the thickness comes from one ball per
voxel instead of one per particle (Oliveira and Paiva 2022). The surface looks the same, and a steady frame draws fewer
sprites. The band is rebuilt on each `update()`.

```ts
import { Engine } from '@margoengine/core';
import { ParticleLiquid } from '@margoengine/water/liquid';
const engine = await Engine.create(document.querySelector('canvas')!);
// A 32 x 32 x 32 block of particles 5 cm apart; the core of the block is left out of the depth pass.
const positions = new Float32Array(32768 * 3);
for (let i = 0; i < 32768; i++) positions.set([(i % 32) * 0.05, (Math.floor(i / 32) % 32) * 0.05, Math.floor(i / 1024) * 0.05], i * 3);
const liquid = ParticleLiquid.attach(engine, { particles: { positions }, radius: 0.025, narrowBand: true });
engine.render({ delta: 1 / 60 }); // starts loading the band code
await liquid.ready();
engine.render({ delta: 1 / 60 }); // builds the band and draws with it
console.log(await liquid.readNarrowBand()); // { voxels, layer1, layer2, particles, band, ... }
```

`bandVoxel` sets the voxel size, the paper's 2h (default 4 * radius, two particle spacings); it grows by 1.25 until the
grid fits the band's atlas. Default `narrowBand` false. The code loads on first use; `ready()` resolves when it has.

## Floods, dam breaks and walls

`@margoengine/water/flood` floods a `Water`'s terrain: dam breaks, bores, hydraulic jumps, run-up and water spreading
over dry ground, round buildings and over walls. `Flood.attach(engine, {surface})` runs in place of the Water's own
shore flow, so the surface, `spray` and `WaveQuery` draw the flood unchanged; `dispose()` hands the Water back its own
flow. It solves the shallow-water equations with a finite-volume scheme (hydrostatic reconstruction after Audusse et
al. 2004 and Chen and Noelle 2017, the HLL flux with Kurganov and Petrova's one-sided speeds, fifth-order WENO-Z face
values after Borges et al. 2008 where five cells are wet and minmod slopes at shores and fronts, two-stage SSP
Runge-Kutta, semi-implicit Manning friction after Chertock et al. 2015), on WebGPU and the full WebGL2 compatibility
layer. Over open water a wave keeps its height: a 0.1 m crest 18 m wide keeps it within 0.2% over 500 m of flat bed. The water starts at the higher of the Water's `height` and its `fill` surface, at rest.

- `walls` (or `wall(...)`, at most 16): a segment `from`-`to` raising the bed to `top` (world y) in every cell it
  touches, `width` m thick (default one line of cells), so water below the crest stays behind it exactly, straight or
  diagonal. `breach(index, {at, over})` lowers the crest to the ground from flood time `at` over `over` seconds.
- `obstacles(x, z)`: buildings and blocks, the height a block stands above the ground, read once per cell. Water goes
  round them and never into them.
- `sources` (at most 16, `setSources` live): inflows in m^3/s over a footprint, as `water/rivers` takes them.
- `mud` (null): a mud or debris flow in place of water, `{sediment, concentration, resistance, grainDensity}`, read
  every frame. Its friction is the quadratic rheology of O'Brien, Julien and Fullerton (1993): the yield stress over
  rho_m h, the viscous K eta V / (8 rho_m h^2) and a turbulent-dispersive Manning term n_td = n 0.0538 exp(6.0896 Cv),
  with tau_y and eta of the named sediment measured by O'Brien and Julien (1988) (`MUD_SEDIMENTS`: 'aspen-natural-soil'
  default, 'aspen-pit-1', 'glenwood-4' and seven more; `concentration` Cv 0.4, `resistance` K 2,285, `grainDensity`
  2,650 kg/m^3). Mud stops where its yield stress holds its slope: released on flat ground it comes to rest in the
  yield profile h^2 = 2 tau_y (x_f - x) / (rho_m g) (test/flood-mud.browser.mjs). `mudRheology(mud)` gives the SI
  yield stress, viscosity, mixture density and n_td factor. Colour the surface brown with the Water's own colour
  options; carried timber and stones read the flow through `@margoengine/water/query`.

  ```ts
  import { mudRheology } from 'margoengine/water/flood';

  const r = mudRheology({ sediment: 'aspen-natural-soil', concentration: 0.45 });
  console.log(Math.round(r.yieldStress)); // 69 Pa: a mud that stands in heaps
  ```
- `sediment` (null, FG-13): suspended soil, `{erosion, criticalShear, settling, soil, tint}`, read when the flow
  starts. Each 1/120 s tick the load c (kg/m^3) is carried with the current (a semi-Lagrangian step, Stam 1999), the bed
  gives up E = M (tau / tau_c - 1) where the Manning bed shear tau = rho g n^2 U^2 / h^(1/3) passes `criticalShear`
  (Partheniades 1965; `erosion` M 5e-5 kg m^-2 s^-1, `criticalShear` 0.2 Pa), and it settles at `settling` x c / h
  (Krone 1962; 0.001 m/s, medium silt), so steady flow tends to E / w_s; a cell that dries drops its load, and c stays
  under 100 kg/m^3 (`FLOOD_SEDIMENT_MAX`; heavier loads are `mud`). `soil(x, z)` gives the ground's erodibility 0..1
  (0 paving, default 1), read once per cell. The load is the fourth channel of `wetTexture`, `read()` returns it per
  cell as `sediment` with the total `sedimentMass` in kg, and `flood-bake` writes it as the 'sediment' field. With
  `tint` (default true) the Water surface turns brown-grey with it: the non-algal particle absorption of Babin et al.
  (2003) and a brown back-scatter, the same terms as `BreakingWaveMaterial`'s `look.sediment`, with beige foam.

  ```ts
  import {Engine} from 'margoengine/core';
  import {Water} from 'margoengine/water';
  import {Flood} from 'margoengine/water/flood';
  const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
  // A dam break down a 100 x 20 m valley of soil, with a paved town east of x = 60 m.
  const width = 100, height = 20, ground = new Float32Array(width * height).fill(0);
  const terrain = engine.gpu!.createTexture({size: [width, height], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  engine.gpu!.queue.writeTexture({texture: terrain}, ground, {bytesPerRow: width * 4}, [width, height]);
  const water = Water.attach(engine, {
    height: -50,
    terrain: {heightmap: () => terrain, origin: [0, 0], size: [width, height]},
    fill: (x) => (x < 20 ? 2 : undefined),
  });
  const flood = Flood.attach(engine, {
    surface: water,
    maxDepth: 3,
    maxSpeed: 8,
    sediment: {criticalShear: 0.3, soil: (x) => (x > 60 ? 0 : 1)},
  });
  for (let i = 0; i < 240; i++) engine.render({delta: 1 / 60});
  await flood.settle();
  const {sediment = new Float32Array(), sedimentMass = 0} = await flood.read(); // read() always sets both
  console.log(Math.max(...sediment), Math.round(sedimentMass)); // kg/m^3 at the muddiest cell, kg in the water
  ```
- `roughness`: Manning n, default 0.03 (earth channel), read every frame. `boundary`: per map side 'wall' (default),
  'open' (zero gradient) or 'sea' (an open boundary held at the sea level, see below).
- `maxDepth` (20 m) and `maxSpeed` (15 m/s) set the fixed step, `1 / (120 m)` s with `m` the least whole number that
  keeps the Courant number at or under 0.25, so frames at 24, 30 and 60 fps are whole steps; a map that needs more than
  16 steps per 1/120 s (cells too small for the depth and speed) is refused. The clock moves with the frame delta and
  `advanceTime`; at most 240 ticks (2 s) run in one frame and the rest carry over (see "The film clock").
- `read()` resolves to the volume, wet area, deepest water, fastest flow, the Courant number, `capped` (cells past
  `maxDepth` or `maxSpeed`) and every cell's depth, bed and velocity, summed in doubles.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {Flood} from 'margoengine/water/flood';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [60, 70, 140], target: [60, 0, 40], near: 0.5, far: 1000},
});
// A valley 120 x 80 m on 120 x 80 cells, falling to the east, and a reservoir of 8 m behind a dam at x = 30.
const width = 120, height = 80, ground = new Float32Array(width * height);
for (let z = 0; z < height; z++)
  for (let x = 0; x < width; x++) ground[z * width + x] = 10 - x * 0.08 + Math.abs(z - 40) * 0.15;
const terrain = engine.gpu!.createTexture({size: [width, height], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
engine.gpu!.queue.writeTexture({texture: terrain}, ground, {bytesPerRow: width * 4}, [width, height]);
const water = Water.attach(engine, {
  height: -50,
  size: [400, 400],
  terrain: {heightmap: () => terrain, origin: [0, 0], size: [width, height]},
  fill: (x) => (x < 30 ? 16 : undefined),
});
const flood = Flood.attach(engine, {
  surface: water,
  walls: [{from: [30.5, 0], to: [30.5, 80], top: 18, width: 2}],
  // A row of houses downstream: 4 m blocks standing 5 m tall.
  obstacles: (x, z) => (x > 70 && x < 74 && z % 10 < 4 ? 5 : 0),
});
flood.breach(0, {at: 2, over: 3});
for (let i = 0; i < 300; i++) engine.render({delta: 1 / 60});
const reading = await flood.read();
console.log(reading.time, reading.volume, reading.maxSpeed, reading.courant);
```

Measured (`test/flood.browser.mjs`, WebGPU and the WebGL2 layer): 200 steps of a dam break over a bump with a wall, a
building, an inflow and friction stay within 2e-6 m of depth and 1e-5 m^2/s of momentum of the plain JavaScript
reference (`test/flood-reference.js`, bound 1e-4); Ritter's dam break at 400 cells has the dam depth and speed within 3%
and an L1 depth error of 0.22% of h0; walls hold to exactly 0, a lake at rest over steps and an island moves under
1e-5 m/s after 10,000 steps, a closed town keeps its volume within 2e-6 over 20,000 steps with no water inside a block,
and an inflow adds its volume within 1e-5. The reference meets every bound of the disaster-water plan in node
(`test/flood-bounds.test.js`): Ritter, Stoker, bores, hydraulic jumps, Synolakis run-up, Thacker's bowl and more.
The film clock, the sea and the weather are below.

### The film clock

The flood runs in ticks of 1 / 120 s (`m` steps each). Every input is a function of the tick, so frame rate does not
matter: a setter called at flood time `t` (`setSources`, `setWind`, `setRainRate`, `wall`, `breach`, `tsunami`, or a
live option such as `roughness`) takes effect from tick `ceil(120 t)`, and a breach, a surge or a tsunami is a function of
the tick's own time. Each tick writes its own uniform (only when it differs from the last) and runs its steps, so 24, 30
and 60 fps runs, a seek and a device restore all reach the same state bit for bit.

- A seek is what `@margoengine/cutscene/seek` already does for every clock: a fresh flood is given the same `advanceTime`
  calls (and the same director calls at the same film times) as a continuous run, then one frame starts it, then
  `await flood.settle()` runs every owed tick in chunks of 240 and waits for the GPU. `flood.ticks` and `flood.steps` say
  how far it has run.
- A device restore starts a new solver at tick 0 and replays the history at 240 ticks a frame (`settle()` finishes it).
- Seeking a flood backwards is not supported: make a fresh one and replay, as `seek` does.
- Change notes (push 4; water is in watch mode, so the API check warned and did not block): `Flood.revision` is gone (a restore replays the log instead), `Flood.owed(dt, steps)` became `Flood.owedTicks(done, limit)`, `Flood.writeUniform(data, k)` takes the tick it writes for (it took a time and wrote one uniform per frame), and `FloodBoundary` gains `'sea'`.

### The sea, tsunamis, wind and rain

Mark a map side `'sea'` (`boundary: {west: 'sea'}`) and it becomes an open boundary after Flather (1976), in its nonlinear
form from the Riemann invariants (Blayo and Debreu 2005): the outer surface is the Water's own level plus a surge plus the
tsunamis plus the Water's swell, a wave leaving passes out without reflection (0.01% of it measured, see "Waves"), a lake
at rest stays at rest, and the sea comes back over an edge the trough bared, or over land at the edge, as a flood front
no faster than a dam break. The Water's own `seaLevel` follows (`flood.seaLevelAt()`), so the
open sea beyond the map rides on the surge and the waves; a level you set with `water.setSeaLevel` becomes the new base,
and `dispose()` gives the Water its level back.

Past the sea sides the drawn sea is not one flat level (FG-05, FG-06): the flood sets `water.setFarField` every frame, so
the surge and the tsunamis travel on to the map at the long-wave speed c = sqrt(g `farField.depth`) (default the shelf's
depth) over `farField.range` metres (default 20 km), a crest standing out at sea r / c seconds before it reaches the
side, and near the side the open sea starts from the sim's own edge level, its difference from the sea level spreading
out as 1 / sqrt(1 + r / L) (a long wave leaving an edge of length L, the map's longer side; Lamb 1932 sec. 191). The
incoming and outgoing parts are the characteristic split of Blayo and Debreu (2005). `flood.farFieldAt(t)` gives the
profile the Water draws; `farField: null` keeps one flat level. Measured on the Doggerland film's 42 m trough over 40 m of
sea (`test/flood-far.browser.mjs`, WebGPU and the WebGL2 layer): the drawn sea 2 km out matches the travelling wave within
2e-5 m, and the open sea meets the sim's edge cell within 0.2 m all through the trough, where the flat sea stood 19.5 m
below it. Between samples the profile is linear (64 samples over `range`); the outgoing part keeps the edge's current
difference rather than its history, so a fast change at the side shows at once along the open sea.

```ts
// A wider Water than the map, so the open sea in the west shows the tsunami coming in.
const deep = engine.gpu!.createTexture({size: [64, 8], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
engine.gpu!.queue.writeTexture({texture: deep}, new Float32Array(64 * 8).fill(-40), {bytesPerRow: 64 * 4}, [64, 8]);
const ocean = Water.attach(engine, {height: 0, size: [6000, 600], terrain: {heightmap: () => deep, origin: [0, 0], size: [512, 64]}});
const offshore = Flood.attach(engine, {surface: ocean, boundary: {west: 'sea'}, maxDepth: 90, maxSpeed: 40, farField: {depth: 40, range: 20000}});
offshore.tsunami({height: 20, period: 260, at: 60});
engine.render({delta: 1 / 30});
console.log(offshore.farFieldAt()?.profile[63]); // the crest 20 km out, about 16 minutes before it reaches the side
```

- `tsunami({height = 3, period = 300, leading = 'trough', at = now, shape = 'n-wave'})` (at most 8): the N-wave of
  Tadepalli and Synolakis (1994), `height` is both the crest and the trough, the sea draws back first by default and the
  crest follows; `shape: 'solitary'` is one crest H sech^2 of time (Synolakis 1987). `tsunamiElevation(t, wave)` is the
  same shape as a plain function. A trough deeper than 5/9 of the still depth at the side cannot come in: drawn down to
  4/9 of its depth, the water leaving through the side is critical (u = -sqrt(g h) for a simple wave, the Ritter 1892
  dam-break section) and no wave from outside reaches the map past it, so the edge stops at 5/9 of its depth (a 42 m
  trough over 60 m of sea stands at -33.3 m, within 1%, packages/water/test/flood-sea.browser.mjs case 10). Put the sea
  side where the still depth is at least 1.8 times the trough (FG-01).
- `surge` (m, default null) is the storm surge at the sea sides; null means the wind's set-up, `stress x shelf length /
  (rho g shelf depth)` on `shelf` (default 50 km x 20 m): 0.2 m at 18 m/s and 1.2 m at 40 m/s. A change eases in over
  `surgeRise` seconds (default 600).
- `setWind({speed, direction})` drags the water with the stress rho_air Cd U^2, Cd = (0.75 + 0.067 U) 1e-3 from Garratt
  (1977), whose fit spans measurements from about 4 to 21 m/s; the line is carried on to 26 m/s (2.49e-3) and held there
  above it, as the drag measured under hurricanes stops growing (Powell et al. 2003), and sets the sea up while `surge`
  is null; it is the call the weather drive makes on a `water:*`
  plugin, so the flood follows the one wind. `setRainRate(mm/h)` or the `rain` option (mm/h, default null: the driven
  rate) rains on the whole map as depth. The drive calls `setRainRate` with the state's rain rate on every `water:*`
  plugin that has it, once per change, unless the rain was set by hand (`holdFromWeather(flood, 'rain')`, which
  `applyFloodSettings` does for a number): the weather is the master, a set value is never written by the drive.
- `inflow` (default 1, 0..100) multiplies every source's discharge, live: 0 shuts the sources and 2 doubles them, from the
  next tick.

```ts
// A beach 160 m long falling to the sea in the west, a surge and a tsunami arriving through the western side.
const beach = new Float32Array(160 * 8);
for (let z = 0; z < 8; z++) for (let x = 0; x < 160; x++) beach[z * 160 + x] = -8 + x * 0.1;
const shore = engine.gpu!.createTexture({size: [160, 8], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
engine.gpu!.queue.writeTexture({texture: shore}, beach, {bytesPerRow: 160 * 4}, [160, 8]);
const sea = Water.attach(engine, {height: 0, size: [400, 400], terrain: {heightmap: () => shore, origin: [0, 0], size: [160, 8]}});
const coast = Flood.attach(engine, {surface: sea, boundary: {west: 'sea'}, maxDepth: 12, maxSpeed: 10});
coast.setWind({speed: 24, direction: [-1, 0]});
coast.tsunami({height: 2, period: 120, at: 10});
for (let i = 0; i < 600; i++) engine.render({delta: 1 / 30});
await coast.settle();
console.log(coast.seaLevelAt(), (await coast.read()).wetArea);
```

Measured on the GPU (`test/flood-film.browser.mjs` and `test/flood-sea.browser.mjs`, WebGPU and the WebGL2 layer): two
runs of 600 frames at 30 fps, 1,200 frames at 60 fps, a seek then `settle()` and a device restore give the same depths,
beds and velocities bit for bit, with a tsunami, wind, rain, an inflow and a breach in the film; the Courant number stays
under 0.1 and no cell is capped. A sea side holds a lake at rest (0 m/s, 0 m); a 0.3 m hump leaves with 0.00015 m left
(0.05%; 0.007 m before the sea side's ghost was fixed, KB-FLATHER-GHOST1); an N-wave of 0.2 m arrives at the shallow-water speed with its height within 8%; a 1 m trough-first wave bares
23 m of a 1 : 20 beach before the crest floods 51 m past the shore; a solitary wave of H / d = 0.0185 runs up a 1 : 19.85
beach to 0.0860 d (Synolakis: 0.0860 d, bound 5%); a 30 m/s wind tilts a 400 m basin of 2 m by 0.0563 m (0.0560 m); rain
of 100 mm/h for 60 s is 1.6666 mm (1.6667 mm); a surge of 0.5 m fills a basin to 0.4996 .. 0.4997 m; a 7 m tsunami at a sea side that is half land floods the land edge
at 15.7 m/s at most with no cell capped.

### Waves: the swell and wave makers

Through a `'sea'` side the Water's own swell trains come in: each component's linear elevation at the face, on the
Water's wave clock and filtered to the cell size as Water filters it to its mesh, is added to the outer surface and to
the incoming wave of the Flather boundary, so the swell that rolls on the open sea beyond the map rolls on into it.
Components running along the side or out of the map are left to the inside. `swell` (default 1, 0..10, live) scales
them: 0 keeps the swell out. Inside the map the swell runs at the shallow-water speed sqrt(g h), and it does not
refract round islands or diffract (a shallow-water model).

`waveMaker({position, direction, amplitude = 0.5, period = 10})` (at most 4; `setWaveMakers` replaces them) is a line
across `direction` through `position` (`length` m, default the whole map) that sends a train of that amplitude and
period one way. It is the source function of Wei, Kirby and Sinha (1999, https://doi.org/10.1016/S0378-3839(99)00009-5):
a Gaussian band adds depth D s(t) exp(-beta r^2) with D = a c / I, I = sqrt(pi / beta) exp(-k^2 / (4 beta)), plus c
times that on the momentum along `direction`, which leaves the backward Riemann invariant untouched, so nothing runs
out of the back. The band only adds, so a wave crossing it (a reflection off a sea wall) passes through, unlike a paddle
at the map edge (Larsen and Dancy 1983, https://doi.org/10.1016/0378-3839(83)90022-4). `width` (default 0: Wei's
beta = 80 / (0.25 L^2), at least 1.5 cells), `phase`, `at` (default now), `duration` (default null: runs on) and
`ramp` (default two periods, eased in and out) shape it; `waveMaker` in the options (default 1, live) scales every
maker. `waveMakerSignal(t, maker)` is the signal as a plain function. It needs water at the line.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {Flood} from 'margoengine/water/flood';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [150, 60, 120], target: [150, 0, 8], near: 0.5, far: 1000},
});
// 300 m of 10 m deep water ending on a 1 : 10 beach; the open sea in the west.
const width = 150, height = 8, ground = new Float32Array(width * height);
for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) ground[z * width + x] = Math.min(-10 + Math.max(0, x * 2 - 180) * 0.1, 3);
const terrain = engine.gpu!.createTexture({size: [width, height], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
engine.gpu!.queue.writeTexture({texture: terrain}, ground, {bytesPerRow: width * 4}, [width, height]);
const sea = Water.attach(engine, {
  height: 0,
  size: [600, 600],
  waves: [{direction: [1, 0], amplitude: 0.3, wavelength: 120}],
  terrain: {heightmap: () => terrain, origin: [0, 0], size: [width * 2, height * 2]},
});
const flood = Flood.attach(engine, {surface: sea, boundary: {west: 'sea'}, maxDepth: 12, maxSpeed: 6});
// Waves of 0.4 m every 9 s from a line at x = 60 m, on top of the swell coming in from the sea.
flood.waveMaker({position: [60, 8], direction: [1, 0], amplitude: 0.4, period: 9});
for (let i = 0; i < 900; i++) engine.render({delta: 1 / 30});
await flood.settle();
const reading = await flood.read();
console.log(reading.maxDepth, reading.foamArea);
```

Measured (`test/flood-waves.browser.mjs`, quasi-1D strips over 10 m of water, WebGPU and the WebGL2 layer): a maker
of 0.1 m and 8 s gives 0.0997 m and 8.000 s 19 m ahead (bounds 3% and 1%) and under 1e-4 m behind it (bound
3%); a wall's reflection has 0.991 of its height 11 m behind the band to 11 m in front (bound 3%, the scheme's own
damping over 22 m included); the sea side sends back 0.02% of the train leaving through it (bound 3%); the Water's
swell (0.2 m, 150 m) has 1.003 of its rms height in the first cell, correlation 0.997 with the train at
the face, and `swell: 0` keeps every cell at 0. A wave of 40 cells to the wavelength loses 0.26% of its height per
50 m (0.0997 m at 219 m, 0.0984 m at 469 m; minmod slopes everywhere lost about 3% per 50 m until 2026-11-18,
KB-FLOOD-DAMP1), and a 0.1 m solitary tsunami's crest keeps 0.998 of its height from 60 m to 568 m (bound 1%; a simple
wave keeps its crest exactly until it breaks, Stoker 1957).

### White water, the current and wet ground

The flood makes its own foam and spray. Each step finds the water breaking in every cell, after Ihmsen et al. 2012's
potentials (https://doi.org/10.1007/s00371-012-0697-9), each through a clamped ramp: water pushed together (neighbours
closing on each other at 0.25 to 1 m/s across a cell: a hydraulic jump, a jet into slower water), a steep surface the
water runs at (fronts after Chentanez and Muller 2010, https://doi.org/10.2312/SCA/SCA10/197-206) and a surge running
into water 20 to 60 percent shallower than itself (the aerated roller of a surge or bore front, Chanson 2009,
https://doi.org/10.1016/j.euromechflu.2008.06.004), all scaled by the flow's speed (0.5 to 2 m/s), which alone makes no
white water. Fast flow that is neither compressed nor steepened, such as the long current behind a tsunami bore or a
uniform chute, stays clear, so the foam marks the breaking front and what it sheds (until 2026-11-24 every cell above
Froude 0.7 or 3 m/s was breaking, so foam sat at 1 for kilometres behind a bore, FG-07). That is the state's breaker channel, which Water's spray takes off from at any
depth, and the foam is never less than it. Foam is carried with the water on each face's mass flux, taken upwind, and
fades with an e-folding time of 3 s (oceanic whitecap foam: 1.4 to 4.8 s on the area-weighted mean, Callaghan, Deane,
Stokes and Ward 2012, https://doi.org/10.1029/2012JC008147); inflow, rain and the sea bring clean water. `read()` adds
`foam`, `breaker` and `foamArea`.

- `flood.velocityTexture`: rgba32float, one texel a cell, (u, v, speed, depth) in m/s and m after the last tick, for
  `WaterFlow` (`map: () => flood.velocityTexture, signed: true`, the terrain's origin and size) so ripples run with the
  current. Read it each frame: it changes texture between ticks.
- `flood.wetTexture`: rgba32float, (deepest depth so far in m, seconds since the cell was last wet above 1 cm, 1 once it
  has been wet, 0), updated every tick, so the deepest water between frames counts and a seek or a device restore
  reaches the same record. For wet sand, debris lines and the drying ground after the water goes back:
  `WetGround.attach(engine, terrain, {record: () => flood.wetTexture, origin, size})` of
  `margoengine/terrain/wet-ground` draws a clipmap terrain darker and glossier where the flood has been, drying back
  over time (see the terrain README).
- Spray: until 2026-11-17 breaker spray took off only under 1.8 m of water (4 m more under whitecaps); the coast flow's
  breaker is 0 past 1.8 m anyway, so only floods see the change.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {WaterFlow} from 'margoengine/water/flow';
import {Flood} from 'margoengine/water/flood';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [50, 40, 60], target: [50, 0, 10], near: 0.5, far: 1000},
});
// A street 100 x 20 m falling gently east, and 2 m of water held behind x = 15 m that breaks loose.
const width = 100, height = 20, ground = new Float32Array(width * height);
for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) ground[z * width + x] = 5 - x * 0.02;
const terrain = engine.gpu!.createTexture({size: [width, height], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
engine.gpu!.queue.writeTexture({texture: terrain}, ground, {bytesPerRow: width * 4}, [width, height]);
const water = Water.attach(engine, {
  height: -50,
  size: [400, 400],
  spray: true,
  terrain: {heightmap: () => terrain, origin: [0, 0], size: [width, height]},
  fill: (x) => (x < 15 ? 7 : undefined),
});
const flood = Flood.attach(engine, {surface: water, maxDepth: 3, maxSpeed: 8});
WaterFlow.attach(engine, {surface: water, map: () => flood.velocityTexture, signed: true, origin: [0, 0], size: [width, height]});
for (let i = 0; i < 120; i++) engine.render({delta: 1 / 30});
const reading = await flood.read();
console.log(reading.foamArea, Math.max(...reading.breaker), flood.wetTexture?.width);
```

Measured (`test/flood-foam.browser.mjs`, WebGPU and the WebGL2 layer): a lake at rest over a step and an island has
foam and breaker exactly 0 and a current under 1e-5 m/s; a dam break of 1 m runs at Froude 1.6 at its front, breaks
white (0.97) and leaves 18 m^2 of foam on a strip 2 m wide, which falls under 0.002 once the water calms; a uniform
chute 400 m long at Froude 1.9 and 4.3 m/s has breaker 0 and foam under 0.01 once its front has run out; `velocityTexture`
matches the reading within 2.4e-7; a dam-break bore of 0.5 m (Ritter's front speed U0 = 2 sqrt(g h0), 4.43 m/s) runs up a
frictionless 1 : 10 beach to 0.89 m, under Shen and Meyer's U0^2 / 2g = 1.02 m (1963,
https://doi.org/10.1017/S0022112063000628), and the wetting record is never below the depth and dries only the cells the
run-up left.

Bared ground takes as long as the water needs to run off it. A plane of 1 m of water on a 1 in 1,000 slope (Manning n
0.045) drains at 8 m cells to within 3 mm of the same plane at 2 m cells in the JavaScript reference (0.40 m left 200 m
from its top after 800 s; 4 m and 2 m cells agree within 3 mm), so the cell size leaves no film behind. A drawback bares
flats only when its trough lasts longer than the flats take to drain: roughly their width over the Manning speed
h^(2/3) S^(1/2) / n (Chow 1959), about 1.8 m/s for 1.5 m of water on a 1 in 250 surface slope at n 0.045. A tsunami trough
of 100 s over flats 500 m wide leaves most of their water (Doggerland's 260 s N-wave over 8 m cells kept 1.3 m of its 2
m there; none of it sat in a closed basin), so give the wave the period the scene needs (Storegga's run-in periods were
tens of minutes) or a smoother bed (lower `roughness`) rather than finer cells (FG-09).

### Draw a PhysicsWorld flood with Water

Attach the optional ShallowWaterSurface mirror to a flowing Water surface. Advance the PhysicsWorld first and
render it after each desired tick. The shallow-water solver owns the water state and clock. The mirror samples
each cell centre and uploads a drawing copy for Water's coastal surface and depth effects. The Water terrain
texture must match the solver's number of cells, extent and centre in the same coordinate frame. The texture
remains caller-owned. Use this path for the framework's rigid-body pressure or drag coupling, with the same
ShallowWaterSolver supplied to the mirror.

The mirror supports WebGPU and the full WebGL2 compatibility layer. It uses the live depth and bed height.
Water's existing coastal interpolation, shoreline threshold and velocity reconstruction also apply. The
mirror does not publish simulated foam, breakers or GPU flood diagnostics.

```ts
import { EngineKernel } from '@margoengine/core';
import { bedSurface } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { PhysicsWorld } from '@margoengine/physics/world';
import { Water } from '@margoengine/water';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const grid = { columns: 8, rows: 4, width: 12, depth: 8, centre: [0, 0] as const };
const source = new ShallowWaterSolver();
const bed = bedSurface(grid, new Float64Array((grid.columns + 1) * (grid.rows + 1)));
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(source, { bed, depth: (x) => (x < -2 ? 0.8 : 0.15) });
const texture = engine.gpu!.createTexture({
  size: [grid.columns, grid.rows],
  format: 'r32float',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
engine.gpu!.queue.writeTexture(
  { texture },
  new Float32Array(grid.columns * grid.rows),
  { bytesPerRow: grid.columns * 4 },
  [grid.columns, grid.rows],
);
const water = Water.attach(engine, {
  height: -1,
  size: [grid.width, grid.depth],
  terrain: { heightmap: () => texture, origin: [-6, -4], size: [grid.width, grid.depth] },
});
const mirror = ShallowWaterSurface.attach(engine, { surface: water, source });
world.advance(1);
engine.render({ delta: 0 });
mirror.dispose();
water.dispose();
texture.destroy();
engine.dispose();
```


### Display the framework's suspended sediment

Pass a `SedimentTransport` solver as `sediment.source` to sample its concentration for the existing flood
surface tint. The grid must cover the terrain rectangle in the same X/Z order. The solver owns the concentration.
The flood surface samples its current values each render and runs its own hydrodynamic updates.

```ts
import { EngineKernel } from '@margoengine/core';
import { TerrainBed } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { SedimentTransport } from '@margoengine/physics/sediment';
import { PhysicsWorld } from '@margoengine/physics/world';
import { Water } from '@margoengine/water';
import { Flood } from '@margoengine/water/flood';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const grid = { columns: 4, rows: 4, width: 40, depth: 40, centre: [20, 20] as const };
const terrain = new TerrainBed();
const sediment = await SedimentTransport.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(terrain, { ...grid, elevations: () => 0 });
world.add(new ShallowWaterSolver(), { bed: terrain.bed, depth: 1 });
world.add(sediment, { grid, suspendedMass: 20, settlingVelocity: 0 });
world.advance(1);
const map = engine.gpu!.createTexture({
  size: [16, 16],
  format: 'r32float',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
engine.gpu!.queue.writeTexture({ texture: map }, new Float32Array(256), { bytesPerRow: 64 }, [16, 16]);
const water = Water.attach(engine, {
  height: -50,
  size: [60, 60],
  terrain: { heightmap: () => map, origin: [0, 0], size: [40, 40] },
  fill: () => 1,
});
const flood = Flood.attach(engine, { surface: water, sediment: { source: sediment } });
engine.render({ delta: 1 / 60 });
await flood.settle();
flood.dispose();
water.dispose();
map.destroy();
engine.dispose();
```

### Sliders for the flood: `FLOOD_SETTINGS`

`@margoengine/water/settings` also lists the flood's live controls on the same row shape as `WATER_SETTINGS`:
`FLOOD_SETTINGS` has nine rows, all `live`: `surge` (m, null is the wind set-up), `surgeRise` (s), `shelfLength` (m),
`shelfDepth` (m), `swell` (the Water's swell let in at the sea sides), `waveMaker` (every wave maker's amplitude), `rain` (mm/h, null follows the weather drive; a number holds it against the drive), `roughness`
(Manning n) and `inflow`. `FLOOD_LOOKS` names three looks made only of those values (`stormSurge`, `flashFlood`, `muddy`),
`floodSettingDefaults()` is a panel's state and `applyFloodSettings(flood, values)` writes a set onto a Flood (a name left
out takes its default, and the values are checked before anything is written). Every write is a number the next tick
reads: nothing is created, so a film can key any row over a shot (`test/flood-settings.test.js`;
`test/flood-settings.browser.mjs` on WebGPU and the WebGL2 layer: the defaults applied for 60 frames change nothing, rows
moving every frame make no buffer, texture or pipeline, and once the uniform ring has turned no bind group either). A
brown of a flood is a Water look: `WATER_LOOKS.flood`.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {Flood} from 'margoengine/water/flood';
import {FLOOD_LOOKS, applyFloodSettings, floodSettingDefaults} from 'margoengine/water/settings';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const beach = new Float32Array(160 * 8);
for (let z = 0; z < 8; z++) for (let x = 0; x < 160; x++) beach[z * 160 + x] = -8 + x * 0.1;
const shore = engine.gpu!.createTexture({size: [160, 8], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
engine.gpu!.queue.writeTexture({texture: shore}, beach, {bytesPerRow: 160 * 4}, [160, 8]);
const sea = Water.attach(engine, {height: 0, size: [400, 400], terrain: {heightmap: () => shore, origin: [0, 0], size: [160, 8]}});
const coast = Flood.attach(engine, {surface: sea, boundary: {west: 'sea'}, maxDepth: 12, maxSpeed: 10});
const panel = floodSettingDefaults();                      // {surge: null, surgeRise: 600, ..., rain: null, inflow: 1}
applyFloodSettings(coast, FLOOD_LOOKS.stormSurge);         // the wind sets the sea up, 30 mm/h of rain
applyFloodSettings(coast, {...FLOOD_LOOKS.flashFlood, inflow: 3}); // a look with one slider moved
for (let i = 0; i < 60; i++) {
  applyFloodSettings(coast, {surge: 0.5 + 0.01 * i, surgeRise: 5}); // a surge building over a shot
  engine.render({delta: 1 / 30});
}
console.log(panel.roughness, coast.surgeAt());
```

### Baking a flood to files: `@margoengine/water/flood-bake`

For a renderer or compositor outside the engine, `bakeFlood(flood, {from, to, fps = 24, signal})` is an async iterator
that moves the flood's own clock (`advanceTime`, then `settle`) and yields `{index, time, reading}` at each frame time
from `from` (default now) to `to` inclusive; no render loop is needed and each frame equals a live run read at the same
time bit for bit (`test/flood-bake.browser.mjs`, WebGPU and the WebGL2 layer). The readings turn into files with no
resampling, one pixel a cell:

- `floodImage(reading, {fields, type = 'FLOAT', northUp = true})`: named float channels, from `FLOOD_BAKE_FIELDS`
  (`depth`, `surface`, `velocity`, `foam`, `breaker`) by default; also `bed`, `speed` and `wet` (1 above 1 mm).
  `velocity` is two channels, `velocity.x` and `velocity.z`; `surface` is depth + bed (world y). With `northUp` the
  image's top row is the map's largest z. `type: 'HALF'` halves the file.
- `encodeFloodEXR(reading, options)`: that image as an uncompressed scanline OpenEXR (through
  `@margoengine/environment/exr-write`, loaded on first use), which Blender, Houdini, Nuke and Unreal read by channel name.
- `floodAtlas(frames, {columns, ...})`: frames tiled row-major from the top left into one flipbook image (columns default
  about square, at most 16,384 pixels a side), with `columns`, `rows`, `frameWidth`, `frameHeight` and each tile's `time`.
- `encodeFloodPNG(image, {channel, range})`: one channel of an image or atlas as a 16-bit greyscale PNG, `range` (default
  the channel's own least and greatest value) mapped to 0..65,535, so p reads back as lo + (hi - lo) p / 65535.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {Flood} from 'margoengine/water/flood';
import {bakeFlood, encodeFloodEXR, encodeFloodPNG, floodAtlas} from 'margoengine/water/flood-bake';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const bed = engine.gpu!.createTexture({size: [64, 4], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
engine.gpu!.queue.writeTexture({texture: bed}, new Float32Array(256).fill(-1), {bytesPerRow: 256}, [64, 4]);
const lake = Water.attach(engine, {height: -1, size: [200, 200], fill: (x) => (x < 16 ? 1 : 0), terrain: {heightmap: () => bed, origin: [0, 0], size: [64, 4]}});
const flood = Flood.attach(engine, {surface: lake, maxDepth: 3, maxSpeed: 8});
engine.render({delta: 0}); // the flood starts with the Water's first frame
const frames = [];
const files: Uint8Array[] = [];
for await (const frame of bakeFlood(flood, {to: 2, fps: 12})) {
  frames.push(frame);
  files.push(await encodeFloodEXR(frame.reading)); // one EXR a frame: depth, surface, velocity.x/z, foam, breaker
}
const sheet = floodAtlas(frames, {fields: ['depth']}); // 25 frames, 5 x 5 tiles of 64 x 4
const png = await encodeFloodPNG(sheet, {range: [0, 1]});
console.log(files.length, sheet.columns, sheet.rows, png.byteLength);
```

#### Spray and debris emitters (FG-08)

`floodEmitters(reading, {place})` turns a frame into emitter sites a particle system, Blender or Houdini can spawn from:
`spray` where the water breaks and `debris` where the current lifts the bed, each `count` sites with a world `position`,
a launch `velocity` (m/s) and a `rate` (particles a second), highest rate first, deterministic. Spray uses the solver's
breaker channel (Ihmsen et al. 2012's potentials): `sprayRate` (default 20) particles a second per square metre of fully
breaking water above `sprayThreshold` (0.2), leaving with the current and an upward `sprayLift` (0.5) x breaker x
sqrt(g h). Debris starts where the Manning bed shear passes the Shields threshold of pieces of `debrisSize` (0.05 m) and
`debrisDensity` (2.65), at the bedload rate of Meyer-Peter and Mueller (1948), q = 8 (theta - 0.047)^1.5 sqrt((s - 1) g
d^3), counted in pieces of d^3 across the cell (`debrisRate` scales it, `roughness` is Manning n, default 0.03).
`floodBirths(sites, seconds, {cell, seed, frame})` draws one frame's births: rate x seconds on average per site, spread
over the cell, the same call giving the same births. `test/flood-emit.test.js` checks the rates against the formulas.

```ts
import {floodBirths, floodEmitters} from 'margoengine/water/flood-bake';
import type {FloodReading} from 'margoengine/water/flood';

// A frame as flood.read() gives it: here two 4 m cells, a bore breaking over 3 m of water and a 5 m/s sheet over sand.
const frame = {
  time: 0, steps: 0, ticks: 0, volume: 0, wetArea: 32, maxDepth: 3, maxSpeed: 5, courant: 0, capped: 0, foamArea: 0,
  width: 2, height: 1,
  depth: Float32Array.from([3, 0.4]), bed: Float32Array.from([-3, 0]),
  velocity: Float32Array.from([2, 0, 5, 0]), foam: new Float32Array(2), breaker: Float32Array.from([0.9, 0]),
} satisfies FloodReading;
const place = {origin: [0, 0] as const, size: [8, 4] as const};
const {spray, debris} = floodEmitters(frame, {place, sprayRate: 40, debrisSize: 0.01});
const births = floodBirths(spray, 1 / 24, {cell: [place.size[0] / frame.width, place.size[1] / frame.height], frame: 12});
console.log(spray.count, debris.count, births.count);
```

#### Spray mist (FG-10)

`floodMist(spray, options)` turns the spray sites into the mist the breaking water leaves hanging in the air: Gaussian
puffs (a Lagrangian puff model, Turner 1970 and Csanady 1973) whose sum is the mist's extinction per metre. Each site is
a steady source; a puff of age t holds the drops released t seconds ago that are still in the air, exp(-t / `lifetime`)
(default 3 s), drifts with `wind` ([x, z] m/s, default [0, 0]), spreads with variance `sourceRadius`^2 (0.5 m) + 2 K t
(`diffusivity` K, default 0.3 m^2/s, Taylor 1921) and rises to the ballistic apex of the site's launch speed before
settling at `fallSpeed` (0.3 m/s), never below the water. Each spray particle stands for `dropsPerParticle` (1e4) drops of
`dropRadius` (0.1 mm), each blocking twice its cross-section (van de Hulst 1957), so the puffs carry a real extinction.
`puffs` (6) per site cover three lifetimes; at most `maxPuffs` (16,384) are kept, the strongest first. Splat them into a
`DensityVolume` (`@margoengine/environment/density-volume`) with density 1 and give it to `VolumetricFog` as its
`volumes`: the mist takes the sun, its shafts and shadows like any fog. `test/flood-mist.test.js` checks the puffs
against the formulas and that the splatted grid holds every airborne drop's cross-section.

```ts
import {floodEmitters, floodMist} from 'margoengine/water/flood-bake';
import {DensityVolume} from 'margoengine/environment/density-volume';
import type {FloodReading} from 'margoengine/water/flood';

const frame = {
  time: 0, steps: 0, ticks: 0, volume: 0, wetArea: 32, maxDepth: 3, maxSpeed: 2, courant: 0, capped: 0, foamArea: 0,
  width: 2, height: 1,
  depth: Float32Array.from([3, 2]), bed: Float32Array.from([-3, -2]),
  velocity: Float32Array.from([2, 0, 2, 0]), foam: new Float32Array(2), breaker: Float32Array.from([0.9, 0.5]),
} satisfies FloodReading;
const {spray} = floodEmitters(frame, {place: {origin: [0, 0], size: [8, 4]}});
const mist = floodMist(spray, {wind: [3, 0.5], lifetime: 4});
const grid = new DensityVolume({voxelSize: 0.5});
grid.splat(mist.position, {radius: mist.radius, weight: mist.weight});
console.log(mist.count, grid.brickCount, grid.sample([1, 1, 2]).toFixed(4));
// new VolumetricFog({volumes: grid}) draws it; clear() and splat() again each frame.
```

### Breaking and plunging fronts: `@margoengine/water/breaking` (FG-04, FG-12)

The flood keeps one height per cell, so its fronts draw as a steep hump and never overturn. `breakingFronts(reading,
{place})` finds the breaking fronts of a frame (Thuerey et al. 2007's approach for shallow water): cells whose surface
stands `minHeight` (0.5 m) or more above the water or ground one cell ahead along the flow, where the breaker is at least
`threshold` (0.3), linked across the flow into lines of crest points. Each point carries its drop `height`, the `depth`
ahead, the breaking `phase` (the breaker's share above the threshold) and a `curl` from the Iribarren number xi = tan(beta)
/ sqrt(H / L0) (Battjes 1974; `period` T sets L0 = g T^2 / 2 pi, default 10 s): 0 spilling under xi 0.4, 1 plunging from
0.7 to 3.3, 0 again surging from 4. `plunge: 0..1` sets the curl by hand (a film's tsunami over flat land spills by the
numbers; ask for 1 to plunge it).

`breakingWaveGeometry(fronts)` builds the overturning crest as one mesh: a 26-point section (`breakingSection`) at every
crest point, from the back over the crest along the jet to its tip, back under the jet and down the face to the toe,
joined along the front, with a tapered section past each end. The jet follows a free fall from the crest (Longuet-Higgins
1982, Peregrine 1983): out to p R at the phase p, R = sqrt(2 H (h + H)) capped at 2.5 H, dropping H p^2, so at full phase
it lands on the water ahead and closes a tube. `uvs1` holds the water's thickness there (m) and the white water (0..1).

`BreakingWaveMaterial` draws it (double-sided): a dark grey-green face, light through the thin lip attenuated over its
thickness by pure water's absorption (Pope and Fry 1997) and spread forward by a Henyey-Greenstein phase about the sun,
white only on the crest, the tip and the toe (FG-12). `look.sediment` (kg/m^3) adds the absorption of suspended mud
(Babin et al. 2003) and its brown back-scatter, for flood water churning over soil (FG-13). Draw it with
`createMesh(engine, breakingWaveGeometry(fronts), material)` from `@margoengine/materials` and call `mesh.setGeometry`
with each new frame's fronts. `test/breaking.test.js` holds the fronts and sections; `test/breaking.browser.mjs` draws
the tube on both backends.

```ts
import {BreakingWaveMaterial, breakingFronts, breakingWaveGeometry} from 'margoengine/water/breaking';
import type {FloodReading} from 'margoengine/water/flood';

// A bore 3 m high into 1 m of water across a 4 x 2 map of 2 m cells, running +x at 5 m/s.
const frame = {
  time: 0, steps: 0, ticks: 0, volume: 0, wetArea: 32, maxDepth: 4, maxSpeed: 5, courant: 0, capped: 0, foamArea: 0,
  width: 4, height: 2,
  depth: Float32Array.from([4, 4, 1, 1, 4, 4, 1, 1]), bed: new Float32Array(8),
  velocity: Float32Array.from([5, 0, 5, 0, 0, 0, 0, 0, 5, 0, 5, 0, 0, 0, 0, 0]), foam: new Float32Array(8),
  breaker: Float32Array.from([0, 1, 0, 0, 0, 1, 0, 0]),
} satisfies FloodReading;
const fronts = breakingFronts(frame, {place: {origin: [0, 0], size: [8, 4]}, plunge: 1});
const geometry = breakingWaveGeometry(fronts);
const material = new BreakingWaveMaterial({look: {sediment: 2}});
console.log(fronts.length, fronts[0].count, geometry.positions.length / 3, material.look.sediment);
```

## Ships riding the sea

`@margoengine/water/ships` puts ships on any Water: the open sea, or the Water a `Flood` runs on.

- `Floater` rides a water height query (a `WaveQuery`, or `floodSurface(flood reading, extent)` over a Flood's water).
  Each `update(source, dt)` samples a 7 x 3 grid of points over the waterplane and fits a plane through them by least
  squares. Heave, pitch and roll then follow that plane through a damped response with the ship's own periods. The heave
  period is 2 pi sqrt(1.5 draft / g). The roll period comes from the IMO Intact Stability Code, 2 C B / sqrt(GM). The
  damping ratios are Lloyd's (1989). No forces are computed, so a wave much shorter than the hull averages out of its pitch.
  `matrix()` is the hull's world transform (+X port, +Y up, +Z forward, as glTF models face). `drift` lets a derelict
  move with the current. `aground` is true when fewer than three points find water. Sinking stays a Blender bake.
  `advanceTime(delta)` rides on the water last given to `update`, so a film seek (`@margoengine/cutscene` `seek`, the
  floater in its `extra`) lands the drift and the ride where a played film has them; `ShipWakes.advanceTime` moves the
  wake clock the same way.
- `ShipWakes` adds each ship's wake to the surface the Water draws and that `WaveQuery` reads, so other floaters ride it.
  It draws up to 8 ships and 16 lamps:
  - The Kelvin wake has bow and stern wave systems. Its brightest ray sits at 19.47 degrees up to a hull Froude number of
    0.49. Above that it narrows as `wakeAngle(Fr)` (Rabaud and Moisy 2013), about 1 / (2 sqrt(2 pi) Fr).
    The crest phase uses the aft travel distance and opposing lateral wavevector projection. The outer waves spread away
    from the hull while the waterline rise and the propeller trail remain attached to their own sources.
  - The bow wave follows `bowWave(speed, hull)` (Noblesse et al. 2008) and never passes the stagnation head U^2 / 2g.
    Its crest sweeps aft away from the hull as it loses height. Breaking foam follows that crest, including when the ship turns.
    The moving hull lifts a lower band of water along both shoulders, with a shallow trough just outside it. This motion
    follows the current hull, fades toward the stern, and uses the same `bowWave` multiplier as the crest.
    At harbor speeds the bow and side profiles have broader support so the narrow pressure rise remains visible on the
    Water mesh. Its height falls with speed and is zero at rest.
  - Foam runs along the waterline, in the turbulent wake and where the bow wave breaks. The turbulent trail follows
    where the stern has passed. Fresh foam spreads and decays downstream with `foamLife`, even on long hulls at low speed.
    The surface shader concentrates faint foam into sparse patches as it disperses. `ShipWakes.sample` reports the
    underlying foam density before this shading step.
  - `ShipOptions.wakeTint` is optional linear RGB in the range 0 to 1, with `null` as the default. It colours water
    and foam along this ship's turbulent stern trail. The tint spreads and fades with the turbulence. Change
    `WakeShip.wakeTint` to recolour the current trail, including on a paused frame. Where tinted trails overlap,
    the strongest local contribution supplies the colour. The tint leaves the height and foam-density queries intact.
    It is an art override of the trail's look and is deprecated as the source of discoloured water: water coloured by
    what a ship leaks (iron ore from a breached hold, coal, fuel) is a tracer of `TracerSolver`
    (`@margoengine/physics/tracers`), which carries, settles and spreads it.
  - Ships' and shore lamps leave glints on a night sea.
  - A ship with a `path` (time to [x, z]) draws the same wake after a seek as after playing to that time. A ship placed
    with `setPose` leaves the trail it has passed through. Either way a turning ship's wake bends with its track.
- `ShipSplash` drives a particle emitter (a `VFX` fits). It sends bow spray where the bow wave breaks, and a burst when the
  bow re-enters the water faster than Ochi's slam threshold, 0.093 sqrt(g L).
- `SHIP_SETTINGS` in `@margoengine/water/settings` holds the slider rows on the shared shape, all live. They are
  `wakeHeight`, `sternWaves`, `wakeLife`, `bowWave`, `waterlineFoam`, `foamLife`, `turbulentWake`, `lampRoughness`,
  `lampIntensity`, `sprayRate`, `slamBurst` and `slamThreshold`. `lampRoughness` defaults to null, which follows the
  Water's glitter and so the weather's wind. A lamp reflects through the Water's own glint lobe, so a set
  `lampRoughness` is a perceptual roughness like the Water's (GGX alpha is its square, widened by the waves' slope
  variance), and a lamp and the sun glitter alike at one roughness. `SHIP_LOOKS` names `calmNight` and `heavyWeather`. `applyShipSettings(wakes,
  values, splash?)` writes a set of values.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {WaveQuery} from 'margoengine/water/query';
import {Floater, ShipSplash, ShipWakes, wakeAngle, hullFroude} from 'margoengine/water/ships';
import {SHIP_LOOKS, applyShipSettings} from 'margoengine/water/settings';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sea = Water.attach(engine, {size: [400, 400], segments: 256, wind: {speed: 6}});
const hull = {length: 40, beam: 8, draft: 3, entrance: 20};
const wakes = ShipWakes.attach(engine, {
  surface: sea,
  ships: [{hull, path: (t) => [0, -150 + 6 * t], lamps: [{position: [0, 12, 0], intensity: 80}]}],
  lamps: [{position: [60, 8, 100], color: [1, 0.9, 0.7], intensity: 400}], // a harbour light
});
applyShipSettings(wakes, SHIP_LOOKS.calmNight);
wakes.ships[0].wakeTint = [0.56, 0.15, 0.065]; // illustrative suspended sediment, linear RGB
// A small boat rides the ship's wake and the sea; the bow spray goes to any emitter with options and burst().
const boat = new Floater({hull: {length: 6, beam: 2, draft: 0.5}, position: [20, 0, 0], heading: 45});
const spray = {options: {}, burst: (count: number) => count};
const splash = new ShipSplash({floater: boat, particles: spray});
for (let i = 0; i < 30; i++) {
  engine.render({delta: 1 / 30});
  boat.update(await WaveQuery.capture(sea), 1 / 30);
  splash.update(3);
}
console.log(boat.matrix(), wakes.sample(10, -60), (wakeAngle(hullFroude(6, 40)) * 180) / Math.PI); // 19.47 degrees
```

On a Flood, ride `floodSurface(await flood.read(), {origin, size})` (the Water's terrain extent), or `WaveQuery.capture`
of its Water, which already holds the flood. The GPU check (`test/ships.browser.mjs`, WebGPU and MARGO_COMPAT=1) holds
the drawn wake to `wakes.sample` within 4e-6 m on the open sea and on a flood, and a Floater's ride to the CPU law within
1e-7. It also checks the stern tint in a fixed frame, the untouched water outside the trail, and the lamp glint
at the mirror line and across a rougher sea. `test/ships.test.js`
measures the bounds: the brightest ray of the drawn wake at 19.47 degrees below Fr 0.49 and at Rabaud and Moisy's angle
at Fr 0.8 to 2, the bow wave law, the Floater's least-squares pitch and its damped overshoot exp(-zeta pi / sqrt(1 -
zeta^2)), and the slam threshold. `examples/test-pages/ships.html` runs all of it in one scene.

The wake is the deep-water pattern; see docs/limits.md for shallow water and the grid it needs.

## Icebergs and sea ice

`@margoengine/water/ice` floats ice on any Water: a berg at its own waterline, a field of sea ice, and the white water
round them. Bring the meshes (a CC0 berg model, a pancake or floe model); nothing here builds a model.

- `IceMaterial` is a `WgslMaterial` (from `@margoengine/materials`) for glacier ice that holds up close:
  - White bubbly ice with bands of blue clear ice (`blueIce`, `bandScale`). Both colours come from the absorption of
    ice (Warren and Brandt 2008, `iceAbsorption`) and the scattering of its bubbles (Mullen and Warren 1988, `iceAlbedo`).
  - Light seen through it (`subsurface`), tinted by `scatterDepth` metres of clear ice (`iceTransmittance`).
  - Wet and glossy as high as the waves reach (`wetHeight`, `wetDarkening`, `wetRoughness`; Lekner and Dorf 1988).
  - A wave-cut notch along the waterline (`notchDepth`, `notchHeight`), cut into the mesh by its vertex stage, and melt
    scallops on its walls (`scallopSize`, `scallopDepth`) that fade out where they would be under a few pixels.
  - `notch: false` drops the vertex cut (instanced sea ice). `waveErosion(wind, sea temperature, ice cover)` gives
    metres a day of notch (Bigg et al. 1997).
- `iceBuoyancy(mesh, {iceDensity, waterDensity})` measures how a closed mesh floats, exactly over its triangles:
  - the waterline where it displaces its own mass (about 88% under water for glacier ice at 900 kg/m^3 in 1027 kg/m^3
    sea water), the draft and freeboard, and the centres of mass and buoyancy;
  - its resting heel and trim, found until the centre of buoyancy is under the centre of mass;
  - the metacentric heights for roll and pitch (a berg with one below zero rolls over: `stable`), and the heave, roll
    and pitch periods. A box berg rolls over below `capsizeRatio()`, sqrt(6 a (1 - a)) (Weeks and Mellor 1978).
- `Iceberg` floats a mesh on the sea through the `Floater` of `water/ships`, with the periods of its own shape and
  mass. `update(source, dt)` rides a `WaveQuery`, and keeps its `material`'s wet band and notch on the water.
  `matrix()`, `position` and `quaternion()` place the mesh. An unstable shape is drawn upright; capsizing and calving
  stay a Blender bake.
- `SeaIce` lays out pancakes, brash or floes at a concentration with no overlaps, in the WMO's sizes. The field drifts
  in free drift at 2% of the wind turned 25 degrees right (`windFactor`, `turning`; negative for the south), plus a
  current, and wraps round so it stays full. Each piece rides the swell at its freeboard. The swell weakens into the
  field at Doble et al.'s (2015) rate (`attenuation`). The drift is a function of time, so `setTime` draws the field
  that playing there draws. `writeInstances(mesh.instances)` places a unit model (1 m across, 1 m thick, centred) per
  piece.
  `SeaIce` and `Iceberg` have `advanceTime(delta)`, which rides on the water their last `update` gave them, so a film
  seek (`@margoengine/cutscene` `seek`, with the field and the berg in its `extra`) lands them where a played film has
  them.
- `BergFoam` (a Water surface effect, up to 8 bergs) draws a foam ring round each berg's waterline. The ring is wider
  and whiter on the weather side, where the swell breaks. Streaks of foam run past the lee. `sample(x, z)` is its CPU
  twin. `BergSpray` throws spray off the weather face into a particle emitter (a `VFX` fits) while the water climbs it,
  and a burst at each surge.
- `ICE_SETTINGS` in `@margoengine/water/settings` holds 25 live slider rows on the shared shape: the material's look,
  the drift, the foam and the spray. Two rows are null by default and follow the weather. A null `waveHeight` takes the
  Water's wind (0.21 U^2 / g). A null `driftWind` takes the wind of the Water you pass. `ICE_LOOKS` names `calmNight`
  and `gale`. `applyIceSettings({material, seaIce, foam, spray, water}, values)` writes a set of values.

```ts
import {Engine} from 'margoengine/core';
import {createInstancedMesh, createMesh} from 'margoengine/materials';
import {cylinderGeometry, icosahedronGeometry} from 'margoengine/geometry';
import {Water} from 'margoengine/water';
import {WaveQuery} from 'margoengine/water/query';
import {BergFoam, IceMaterial, Iceberg, SeaIce} from 'margoengine/water/ice';
import {ICE_LOOKS, applyIceSettings} from 'margoengine/water/settings';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sea = Water.attach(engine, {size: [800, 800], segments: 256, wind: {speed: 8}});
// Stand-in shapes; load a real berg and pancake model for a film.
const bergShape = icosahedronGeometry(40, 4);
const ice = new IceMaterial();
const berg = new Iceberg({mesh: bergShape, material: ice});
const bergMesh = createMesh(engine, bergShape, ice);
const foam = BergFoam.attach(engine, {surface: sea, bergs: [berg]});
const field = new SeaIce({kind: 'pancake', centre: [120, 0], size: [100, 100], wind: {speed: 8, direction: [1, 0]}});
const pancakes = createInstancedMesh(engine, cylinderGeometry(0.5, 0.5, 1, 16), new IceMaterial({notch: false}), field.pieces.length);
applyIceSettings({material: ice, foam, seaIce: field, water: sea}, ICE_LOOKS.calmNight);
for (let i = 0; i < 30; i++) {
  engine.render({delta: 1 / 30});
  const water = await WaveQuery.capture(sea);
  berg.update(water, 1 / 30);
  bergMesh.root.setPosition(berg.position);
  bergMesh.root.setQuaternion(berg.quaternion());
  field.update(water, 1 / 30).writeInstances(pancakes.instances);
}
console.log(berg.buoyancy.submergedFraction, berg.buoyancy.draft, berg.buoyancy.stable, foam.sample(-45, 0));
```

`test/ice.test.js` measures the bounds: the absorption is Warren and Brandt's table, and clear ice is blue. A berg
floats with ice / water density of its volume under water, and a box's waterline, draft, freeboard, waterplane,
metacentric heights and periods are the closed forms. A box rolls over just below Weeks and Mellor's ratio and floats
just above it. A lopsided berg rests with its centre of buoyancy under its centre of mass. Sea ice never overlaps, sits
at its freeboard, drifts at 2% turned 25 degrees, seeks to the field it steps to, and rides Doble et al.'s share of the
swell. The GPU check (`test/ice.browser.mjs`, WebGPU and MARGO_COMPAT=1) draws the material bluer with `blueIce`, darker
where wet and narrower at the notch, and the foam whiter on the weather side than abeam.
`examples/test-pages/ice.html` runs a whole night scene: a berg, pancakes, brash and floes, foam and spray.

## Shot splashes

`@margoengine/water/splash` throws up the water where round shot hits the sea. A shot at a grazing angle skips off the
water, throwing a fan of spray at each graze; one that goes in throws a crown of spray, then a column of water when the
air cavity behind it closes, and leaves a drifting mist and a ring of foam on the Water. The spray is drawn by particle
emitters you make (a `VFX` of `@margoengine/vfx` fits); the foam is a Water surface effect.

```ts
import {Engine} from 'margoengine/core';
import {VFX} from 'margoengine/vfx';
import {Water} from 'margoengine/water';
import {SPLASH_EMITTERS, ShotSplash, planSplashes} from 'margoengine/water/splash';
import {SPLASH_LOOKS, applySplashSettings} from 'margoengine/water/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 8, 90], target: [0, 4, 0]},
});
const sea = Water.attach(engine, {size: [400, 400], segments: 256, wind: {speed: 6}});
// A 32-pounder ball coming in at 3 degrees, 1 s in: it skips, then goes in.
const shot = {time: 1, position: [-80, 0, 0] as [number, number, number], velocity: [300, -15.7, 0] as [number, number, number], radius: 0.0783, density: 7200};
const splash = ShotSplash.attach(engine, {
  surface: sea,
  source: [shot],
  particles: (kind) => VFX.attach(engine, {...SPLASH_EMITTERS[kind]}),
});
applySplashSettings(splash, SPLASH_LOOKS.calm);
for (let i = 0; i < 90; i++) engine.render({delta: 1 / 30});
console.log(planSplashes(shot).map((e) => e.kind), splash.active().length, splash.sample(0, 0));
```

- `ShotSplash` options: `particles(kind, slot)` makes each slot's three emitters (`'crown'`, `'column'`, `'mist'`;
  `SPLASH_EMITTERS[kind]` holds settings for a `VFX`); `source` (a `Battery` of `@margoengine/vfx/gunfire`, whose
  `impacts()` it reads every frame, or a list of `{time, position, velocity, radius, density}`); `slots` (6, at most
  32; the oldest is reused); `surface` (the Water that takes the foam; attach it first); `water` (a height source,
  such as a `WaveQuery`: the water between skips, and the wave each splash rises from); `wind` (the air the skips fly
  through; default the wind the weather wrote on the spray); `maxSkips` (8); `look`. `add(impact)` adds one by hand.
- The skip. The water presses on the part of the ball below the surface that moves into it at 1/2 rho (U . n)^2
  (Birkhoff et al. 1944). `birkhoffContact(velocity, radius, density)` integrates that over the wetted cap through the
  contact and says whether the ball comes out, how fast and at what angle; its critical angle is within 4% of Johnson
  and Reid's (1975) 18 degrees / sqrt(sigma) for a ball sigma times as dense as the water (`ricochetAngle`).
  `planSplashes(impact)` lists the skips, each slower than the last, then the entry. Between grazes the ball flies
  through the air (`skipFlight`): gravity and Hoerner's sphere drag (`sphereDragCoefficient`) on its velocity
  relative to the wind, so a skip falls short of its vacuum range and a crosswind moves it by McCoy's lag-time rule.
- The entry. The crown sheet leaves at U sqrt(Cd / 2) (Logvinovich, with May's 1975 cavity drag 0.3), less at a slant;
  its drops rise to the drag-limited height of 2 mm drops (`dragLimitedHeight`, Gunn and Kinzer 1949). The cavity seals
  2.3 sqrt(R / g) after entry (`cavitySeal`, Glasheen and McMahon 1996; Duclaux et al. 2007), halfway down the path the
  ball has run (`entryDepth`; Aristoff and Bush 2009), and the column rises from there as a jet of 5 mm drops.
- On waves. With `water`, each splash rises from the surface height under it at its own time and its crown, column and
  mist carry the surface's velocity (the sheet speed is relative to the water it leaves); the column follows the wave
  frame by frame. `look.waveLift` (1) scales both, 0 for the impact at rest; `surface(position)` gives them.
- The foam is a ring per splash (up to 16), sized by the crown and spreading and fading over `foamLife` seconds.
  `sample(x, z)` is its CPU twin and `rings()` lists them. `active()` lists the splashes being drawn.
- From the physics. For bodies the physics carries (a cannonball, a diver, a launched hull, a breaching whale), pass an
  `EntrySolver` of `@margoengine/physics/entry` as `splashes`: ShotSplash draws its splashes as they fall due, each
  worked out against the local surface and relative to the waves' motion, the cavity as the body actually ran it:
  an `entry`'s crown, a `seal`'s Worthington jet and an `exit`'s lifted water as columns, a `skip`'s fan. The
  splash clock then runs on the world's time (advance both on one film clock). `splashOf(e)` is the conversion.

  ```ts
  import {Engine} from 'margoengine/core';
  import {VFX} from 'margoengine/vfx';
  import {Water} from 'margoengine/water';
  import {SPLASH_EMITTERS, ShotSplash} from 'margoengine/water/splash';

  const engine = await Engine.create(document.querySelector('canvas')!);
  const sea = Water.attach(engine, {size: [200, 200], segments: 256});
  // An EntrySolver's splashes, as its splashes() lists them (here one entry at 0.5 s and its seal at 0.6 s).
  const entry = {kind: 'entry' as const, row: 0, time: 0.5, position: [0, 0, 0] as [number, number, number], velocity: [0, -9, 0] as [number, number, number], speed: 9, sine: 1, radius: 0.0125, crownSpeed: 3.3, crownHeight: 0.4, columnSpeed: 0, columnHeight: 0};
  const solver = {splashes: () => [entry, {...entry, kind: 'seal' as const, time: 0.6, crownSpeed: 0, crownHeight: 0, columnSpeed: 89, columnHeight: 21}]};
  const splash = ShotSplash.attach(engine, {
    surface: sea,
    splashes: solver,
    particles: (kind) => VFX.attach(engine, {...SPLASH_EMITTERS[kind]}),
  });
  for (let i = 0; i < 30; i++) engine.render({delta: 1 / 30});
  console.log(splash.events.map((e) => e.columnSpeed > 0 ? 'column' : 'crown')); // ['crown', 'column']
  ```
- `advanceTime(delta)` moves its clock; each splash is a function of film time, so a cutscene `seek` (with it in
  `extra`) lands where playing lands.
- Sliders: `SPLASH_SETTINGS` in `@margoengine/water/settings` holds the live rows on the shared shape: `crown`,
  `column` and `mist` (particle counts), `height`, `waveLift`, `foamWidth` and `foamLife`, and `wind.x` and `wind.z`, null by
  default to follow the weather. `SPLASH_LOOKS` names `calm`, `gale` and `animatedFeature`; `applySplashSettings(splash,
  values)` writes a set.
- `test/splash.test.js` holds the laws: Johnson and Reid's angle, the drop height, the seal, the cavity path, skips
  then an entry, the column after the seal, the rings, a seek, the quadratic-drag range of a skip, the lag-time rule
  and spray that rides a wave. The GPU check (`test/splash.browser.mjs`, WebGPU and MARGO_COMPAT=1) draws the foam
  white at the entry and nowhere else, spray above the water from real `VFX` emitters, and the same spray higher by
  the height of a raised surface.
- Limits: the foam rings stay where the shot fell (they do not drift on the waves); ricochets off ships are
  `@margoengine/vfx/gunfire`'s (a `Battery`'s `targets`). Sources are in `docs/clean-room.md`.

## Wave subsurface scattering

`@margoengine/water/scatter` makes thin crests glow when the viewer looks toward one of the Water's directional
lights, as sunlight does through a breaking wave. `WaterScatter.attach(engine, { surface })` takes optional `color`
(linear RGB), `strength`, `power` (how tightly the glow gathers around the light) and `distortion` (how much the wave
normal bends it); `set` changes them later. Attach it after `WaterBodies` so each body's level is used. It changes
shading only.

## Film time: seeking waves to a cut

A film rendered scene by scene starts each scene in a fresh process, and the wave clocks add up frame deltas: `Water`'s
Gerstner waves, `FFTOcean`, `WaterFlow` and the `WaterRain` rings. Each has `advanceTime(delta)`, the CPU part of its
frame update (a delta of 0 or less moves nothing), and a `time` getter; its `onPreUpdate` runs the same
`advanceTime`. So `seek` from `@margoengine/cutscene/seek` replays a run's steps and the next frame draws the waves a
run started at 0 draws there, bit for bit (`test/seek.test.js` to 54,000 steps; `test/seek-check.browser.mjs` pixel for
pixel on WebGPU and the WebGL2 compatibility layer). `setTime(seconds)` on `Water`, `FFTOcean`, `WaterFlow` and
`WaterRain` still sets one clock outright.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {WaterRain} from 'margoengine/water/rain';
import {seek} from 'margoengine/cutscene/seek';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const water = Water.attach(engine, {size: [40, 40], segments: 128, waves: [{direction: [1, 0.3], amplitude: 0.25, wavelength: 7}]});
const rain = WaterRain.attach(engine, {surface: water, rain: 0.8});
// This scene starts 95 s into the film: the swell and the rings are where a run from 0 had them.
await seek(engine, 95, {fps: 30});
engine.render({delta: 1 / 30});
console.log(water.time, rain.time);
```

- Changed 2026-11-16: `Water`'s wave clock moves in its frame update, not in its draw pass. Hidden water (not drawn
  for a while) now keeps time instead of standing still, and two views drawing it in one frame move it once instead of
  twice.
- History on the GPU comes from the scene's warm-up frames, not from the seek: foam (FFT foam decays with
  `foamLifetime`, 4 s), `Ripples`, rain splashes into a `Ripples` field and coastal flow.
- Several cuts in one process: `resetTime()` puts each water clock back as a fresh one with the same options has it
  (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock), so a later `seek` gives what a fresh world
  seeked there gives. `Water` drops each view's foam history, its coastal flow and spray (the next frame builds them
  again), `FFTOcean` starts its foam again, `WaterRain` owes no splash, `ShipWakes` forget each ship's trail and pose,
  `ShotSplash` plans the source's impacts again (ones added by hand are dropped), and `Floater`, `Iceberg` and `SeaIce`
  go back where they were built, at rest, until the next `update` gives them water. `Flood` goes back to tick 0 with
  the inputs it had there (walls, breaches, sources, tsunamis, wave makers, wind and rain set later are dropped), puts
  the Water's sea level back and starts a fresh solver at the next frame. Evidence: `test/reset-time.test.js` (state of
  a reset clock equals a fresh one's, before and after a seek, for all of them).

### On a film clock: `clock`

Give `Water` a film clock (`FilmClock` of `@margoengine/math/clock`) as `clock` and its time is the clock's: the wave
clock reads `clock.time`, and the coastal or river flow and its spray step in fixed ticks of 60 * 2^k Hz (240 for the
coast's three substeps a frame, 480 for a river's eight), as many as the clock owes since the last frame. Each tick's
wave time and step are worked out on the CPU in doubles and reach the GPU once, in a ring of frame-uniform slices copied
in before the tick's flow and spray passes. So the same beach drawn at 24, 30, 60 or 5 fps holds the same flow and spray,
every byte, at the times those rates share; a slow frame loses no time; and a seek is setting the clock. A frame runs at
most `WATER_FLOW_TICKS_PER_FRAME` (480) ticks; `await water.settle()` runs the rest at once (after a jump ahead). Setting
the clock back starts the flow again and replays it to the earlier time. The flow's first set-up (the surf's spin-up)
runs at its first tick's time, whatever frame builds it. `test/film-clock.browser.mjs` checks all of it on WebGPU and
the WebGL2 layer, and that without a clock 24 and 60 fps flow differently. A flood on the bridge (`@margoengine/water/flood`)
keeps its own film clock. A `Ripples` field on a Water with a clock steps on the same clock, at the dyadic rate its stability limit needs
(60 * 2^k Hz up to 7,680, then whole substeps a tick), and a drop or wake queued with `disturb` or `wake` falls due at the
clock's tick when it is queued, so it is born at the same instant at any frame rate; setting the clock back clears the
field and replays it.

```ts
import {Engine} from 'margoengine/core';
import {Water} from 'margoengine/water';
import {FilmClock} from 'margoengine/math/clock';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const heightmap = engine.gpu!.createTexture({size: [64, 64], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
const heights = new Float32Array(64 * 64).map((_, i) => -3 + ((i % 64) / 63) * 4.5); // a beach rising to +x
engine.gpu!.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: 256}, [64, 64]);
const clock = new FilmClock({fps: 24});
const water = Water.attach(engine, {size: [64, 64], segments: 64, spray: true, terrain: {heightmap: () => heightmap, origin: [-32, -32], size: [64, 64]}, clock});
clock.frame = 72; // the shot's first frame is 3 s in
engine.render({delta: 1 / 24});
await water.settle(); // the 720 ticks of 3 s, all of them
console.log(water.time); // 3
```

## Rain ripples

`@margoengine/water/rain` puts rain drop rings on a `Water`. `WaterRain.attach(engine, { surface, weather })` follows a
`WeatherMachine`'s `state.rain` (or any object with a numeric `rain`); without a weather, `rain` sets the intensity.
`cell`, `lifetime` and `strength` shape the rings, which fade out with distance. With `splashes: { field }` heavier
drops also fall into a `Ripples` field around the camera, so the simulated surface moves too. It composes with
`WaterFlow` in either attach order.

### Display a simulated pack

Pass a live `floeSource` to `SeaIce` to display the simulated floes. Call `update` after advancing or
restoring the physics world. The surface still supplies heave and tilt, while each floe supplies its
world XZ position, yaw, diameter and volume-equivalent thickness. Use the same origin cell for both.

```ts
import { PackIceSolver } from '@margoengine/physics/pack-ice';
import { PhysicsWorld } from '@margoengine/physics/world';
import { SeaIce } from '@margoengine/water/ice';

const pack = await PackIceSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(pack, {
  floes: [{ position: [0, 0], velocity: [0.25, 0], radius: 1, thickness: 0.1 }],
});
const view = new SeaIce({ kind: 'floe', size: [40, 40], floeSource: pack });
world.advance(1);
view.update({ sample: () => ({ height: 0 }) }, 1 / 60);
console.log(view.matrices[12]);
```
