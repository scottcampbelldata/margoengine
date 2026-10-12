# @margoengine/water

A separate WebGPU water grid evaluates up to eight Gerstner waves with analytical normals. Wind-aligned micro-ripples, Fresnel reflection, sun glints and wavelength-dependent absorption shade the surface. Optional terrain coupling adds conservative GPU shallow-water flow, moving breaker foam and a fixed GPU spray pool.

```ts
import {Water} from '@margoengine/water';
const water = Water.attach(engine, {size: [100,100], segments: 128, height: 0});
```

Directions are XZ, dimensions/amplitudes are world units, wavelengths are positive, and phase is radians. Invalid steepness that would fold the surface is rejected. Default swells share a narrow directional spread and distinct wavelengths. Micro-ripples follow the first wave's direction. Default water owns a shared sampleable scene-depth target with HTML. With Bloom/SSAO/DOF, pass `depth: () => effect.depthTexture` explicitly; dimensions must match the viewport. Water is opaque and Y-up. It seeds its own depth target from opaque scene depth and writes that target to resolve overlapping wave triangles; the original scene depth stays available for shoreline comparisons. Default foam history is screen-space and resets on resize/restoration.

For the sandbox optics, connect the optional packages:

```ts
Water.attach(engine, {
  depth: () => bloom.depthTexture,
  sceneColor: () => bloom.sceneTexture,
  reflection: () => sky.reflectionTexture,
});
```

The borrowed sky texture must be a sampleable single-layer `rgba16float` 2D texture. The borrowed scene color must be a viewport-sized single-layer `rgba16float` texture with `COPY_SRC` usage. Water retains one GPU snapshot for depth-rejected screen refraction and seabed attenuation. Without these providers, it uses a sky gradient and an approximate seabed color. Reflections represent the atmosphere, not nearby objects. Direct glints use the existing engine lighting direction and radiance; the application must synchronize them with its sun clock.

For beaches and inland dips, supply `terrain: {heightmap: () => texture,
origin: [-80,-80], size: [160,160]}`. The borrowed heightmap must contain world-space
Y heights in a sampleable `r32float` texture, 2..512 cells per side. Each cell holds
water depth and exchanges conservative flux with its neighbors; higher ground
blocks flow and outlet sills retain puddles as the sea recedes. Gerstner waves drive
the open map boundary. Initially, depressions below the mean sea level are filled;
higher depressions start dry. Resize preserves simulation state, while replacing
the height texture or restoring the device resets it. All simulation textures,
bind groups and pass descriptors are retained between frames.

The solver runs three GPU substeps per frame and caps elapsed simulation time at
1/15 second after a stall. Fast shallow flow generates breaker foam, which advects
and decays with the water. Set `spray: true` with terrain coupling to enable a fixed
2,048-slot GPU droplet pool, with gravity, water/terrain collision and soft depth
fading. It approximates breaking surf; it does not solve overturning wave volumes
or erosion. Use heightmap cells of roughly 0.5 metres or larger for this preset;
very small cells require more substeps.

`water.setWaveHeight(meters)` scales the existing spectrum to that largest component
amplitude without recreating geometry. It validates the complete spectrum before
changing any amplitude, rejecting heights that would fold the surface.

Waves fade smoothly between two and four grid-diagonal lengths and are omitted
below two, preventing short waves from exposing the triangle pattern. Increase
`segments` to retain smaller ripples; their configured wavelengths and speeds stay
unchanged. Both displacement and analytical normals use the filtered amplitude.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/water

Physical WebGPU basin, channel, retention, spray and triangle-order checks: npm run test:gpu --workspace @margoengine/water

