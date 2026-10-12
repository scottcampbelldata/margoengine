# @margoengine/water

A separate WebGPU water grid evaluates up to eight swell trains with analytical normals. Each train spreads into three Gerstner components with varied directions, wavelengths and gently bending crests. Advected noise gradients add wind agitation and micro-ripples, filtered separately by their screen footprint. Fresnel reflection, sun glints and wavelength-dependent absorption shade the surface. Optional terrain coupling adds conservative GPU shallow-water flow, moving breaker foam and a fixed GPU spray pool.

```ts
import {Water} from '@margoengine/water';
const water = Water.attach(engine, {size: [100,100], segments: 128, height: 0});
```

For an open ocean, set `horizon: true`. The central 75% of each grid axis keeps
its original spacing; outer rows stretch toward a 10 km horizon and render beyond
the scene's far clip. Wave displacement and normals fade together when those
larger cells cannot resolve the wavelength. The default grid remains bounded for
ponds and finite surfaces. Horizon mode is centered at the origin, so use a size
that keeps the shoreline and terrain map within the central grid.

Directions are XZ, dimensions/amplitudes are world units, wavelengths are positive, and phase is radians. A configured wave supplies the dominant direction and wavelength of its train; its three component amplitudes sum to the configured amplitude. Invalid steepness that would fold the surface is rejected. The crest bend includes analytical derivatives and a displacement margin to preserve that bound. Agitation and micro-ripples follow the first wave's direction. Open-water sky reflections clamp below-horizon rays to the horizon and soften with roughness. Fresnel inputs are saturated before exponentiation so floating-point roundoff cannot feed a negative base into `pow`. Default water owns a shared sampleable scene-depth target with HTML. With Bloom/SSAO/DOF, pass `depth: () => effect.depthTexture` explicitly; dimensions must match the viewport. Water is opaque and Y-up. It seeds its own depth target from opaque scene depth and writes that target to resolve overlapping wave triangles; the original scene depth stays available for shoreline comparisons. Default foam history is screen-space and resets on resize/restoration.

For the sandbox optics, connect the optional packages:

```ts
Water.attach(engine, {
  depth: () => bloom.depthTexture,
  sceneColor: () => bloom.sceneTexture,
  reflection: () => sky.reflectionTexture,
  lights: sky.lights,
});
```

The borrowed sky texture must be a sampleable single-layer `rgba16float` 2D texture. The borrowed scene color must be a viewport-sized single-layer `rgba16float` texture with `COPY_SRC` usage. Water retains one GPU snapshot for depth-rejected screen refraction and seabed attenuation. Without these providers, it uses a sky gradient and an approximate seabed color. Reflections represent the atmosphere, not nearby objects.

`lights: sky.lights` keeps sun and moon glints aligned with their separate visible
directions through dusk, instead of reflecting the engine's blended shadow light.
Waves still break the paths into moving highlights. Custom callers can supply up
to two retained lights with `direction` (four numbers: XYZ and nonnegative intensity)
and `radiance` (three nonnegative RGB numbers), updated before each render. An empty
array disables direct glints. Omitting `lights` retains engine lighting behavior;
the application must synchronize that direction with its sun clock.

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

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/water

Wave glints, foam and spray use the engine's directional radiance and intensity,
so optional sky moonlight produces cool reflections without daytime-white surf.
The water body uses the scene's ambient floor; a borrowed sky environment carries
the matching night sky into Fresnel reflections.

Physical WebGPU all-shore run-up/recession, deep isolated-basin retention, curved-crest/normal, zero-amplitude, channel, spray, triangle-order, coastal-seam,
refraction and device-restoration checks: npm run test:gpu --workspace @margoengine/water
(build core, post and terrain packages first).

