# @margoengine/creative

WebGPU grass, a planet renderer, a leaf/weather particle preset, toon shading, HDR targets and a grading post effect (fog, god rays, focus blur, ACES, grain) for Margo Engine.

Each capability has one implementation: `GPUParticles` is a preset over `@margoengine/vfx`, bloom is `Bloom` from `@margoengine/post/bloom`, and sky backdrops are `Sky` from `@margoengine/sky`.

Package name: `@margoengine/creative`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@0.1.0 @margoengine/creative@0.1.0
```

```ts
import { Engine } from '@margoengine/core';
import { GPUParticles } from '@margoengine/creative/particles';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu' });
engine.use(new GPUParticles({ count: 5000, sort: true, curl: 0.2 }));
engine.start();
```

Call `engine.dispose()` on teardown. Creative rendering requires supported WebGPU hardware on HTTPS or localhost.

Use a feature subpath for a static import or an on-demand `import()`:

| Subpath | Feature |
| --- | --- |
| `@margoengine/creative/particles` | `GPUParticles` (a `@margoengine/vfx` preset) and particle option types |
| `@margoengine/creative/targets` | `HDRRenderTarget` |
| `@margoengine/creative/toon` | `ToonShading` and toon option types |
| `@margoengine/creative/post` | `PostProcessing` (fog, god rays, focus blur, grading, grain) and its option types |
| `@margoengine/creative/grass` | `GrassField` and grass option types |
| `@margoengine/creative/planet` | `Planet` and planet option types |

```ts
const {Planet} = await import('@margoengine/creative/planet'); // loaded only when this line runs
```

`GPUParticles({count, gravity, wind, size, curl, obstacles, sort, texture})` keeps `count` particles drifting
inside a 6 m cube centred on the origin, re-entering on the opposite face. It is a `VFX` from `@margoengine/vfx`
(`instanceof VFX`, plugin name `gpu-particles`): `wind` is added to `gravity`, `curl` is VFX `turbulence`, and
`size` is the sprite half-width. Use `VFX` directly for emitters, lifetimes, bursts or up to 1,000,000 particles.

`PostProcessing` grades the HDR scene: exponential height fog, screen-space god rays, a depth-of-field focus
blur, exposure/contrast/saturation/gain/lift, ACES and grain. It has no bloom and no sky backdrop; passing
`bloom`, `threshold` or `atmosphere.sky`/`scattering`/`anisotropy` throws with the replacement. Alone it owns
scene capture. For bloom, or to combine it with SSAO, DOF or FXAA, add it to a `PostStack` from
`@margoengine/post/stack` as the display effect: `PostStack.attach(engine, [new SSAO(), new Bloom({strength:
0.3}), new PostProcessing({atmosphere: {density: 0.02}}), new FXAA()])`. In a stack its `target` is undefined.
For a sky behind the fog, attach `Sky` from `@margoengine/sky`.

Each subpath loads that feature and its dependencies. Existing named imports from `@margoengine/creative` remain available and can be tree-shaken by a bundler. `await stage.creative()` intentionally loads the complete pack namespace; use a subpath when loading one feature independently.

Attach a grass field directly to an existing Stage, without extending the facade:

```ts
import {createStage} from 'margoengine';
import {GrassField} from '@margoengine/creative/grass';

const stage = await createStage('#viewport', {backend: 'webgpu'});
const meadow = new GrassField(stage, {
  blades: 100_000, area: [50, 50], bladeHeight: 1.2, windSpeed: 1.2, spores: true,
});
meadow.windStrength = 0.6;
// Remove this field early, or let stage.dispose() release it with the scene.
meadow.destroy();
```

`GrassField` accepts any `{engine: EngineKernel}`, so core-only consumers can use `new GrassField({engine}, options)`. It attaches automatically, advances `windTime` by the frame delta, supports multiple fields, and rebuilds GPU resources after device restoration. Do not add a second time increment in `onTick`. All roots lie on Y=0 in a rectangle centered on the origin.

`meadow.destroy()` and `meadow.dispose()` perform the same idempotent teardown: remove the field's compute, grass and optional spore passes before destroying its GPU buffers. The field registers no tick listeners. Both indirect instance counters are cleared with `encoder.clearBuffer()` before each culling dispatch; the compute pass ends before the separate render passes read the compacted lists and indirect arguments.

| Option | Default | Meaning |
| --- | --- | --- |
| `blades` | `100_000` | Positive integer, bounded by device storage and dispatch limits |
| `area` | `[50, 50]` | Positive X/Z dimensions, up to 100,000 world units |
| `bladeHeight` | `1.2` | Positive blade height, up to 100; instances vary from 0.7× to 1.25× |
| `windSpeed` | `1.2` | Noise scrolling and spore drift speed, 0–100; mutable on the field |
| `windStrength` | `0.45` | Bend strength, 0–2; mutable on the field |
| `windDirection` | `[1, 0.35]` | Nonzero X/Z direction, normalized at creation |
| `drawDistance` | `100` | Positive distance cutoff, up to 100,000 world units |
| `spores` | `false` | Draw 240 drifting white dandelion particles |

The compute pass culls conservative blade bounds against all six camera planes and distance, then compacts two GPU instance lists. Indirect draws use seven-vertex near blades and three-vertex far blades, with stable density thinning beyond 70% of draw distance. The three near segments preserve their lengths during wind bending. Curved normals, root-to-tip color, wrap lighting and backlight transmission use the engine's existing lighting. Grass writes Reversed-Z depth; spores blend additively without writing depth. Both canvas and HDR/post-processing targets are supported.

Instance data, uniforms, bind groups and pass descriptors are allocated at creation. The initial pipeline variant is built during setup; additional supported target variants are cached on first use. Stable frames reuse these resources. There is no production CPU visibility readback. Frame rate depends on hardware, resolution and visible density; 60 FPS is a target, not a guarantee. Grass is not a core mesh and does not participate in mesh picking, Stage fitting, section clipping or shadows.

Run `npx vite --host 127.0.0.1` from the repository root and open `/examples/windy-meadow.html` for wind, density and seed controls, the optional Sky package's daylight/moonlight and moving clouds, and Bloom's HDR/AgX presentation. The demo uses the shared 4× MSAA desktop default; mobile uses 1× MSAA, a DPR cap of 2 and 35,000 blades, with collapsible settings. Orbit, pinch, keyboard navigation and reset remain available while motion is paused; reduced motion pauses the grass, seeds and clouds. Run `node --test tests/modern-grass.test.js` and `node scripts/modern-grass-tests.js` after building the creative, sky and post packages for the unit and GPU checks.

## Planet

The source checkout also exports `Planet` and `PlanetOptions`. Planet is an opt-in WebGPU plugin; neither core nor the Stage facade imports its shaders.

```ts
import {createStage} from 'margoengine';
import {Planet} from '@margoengine/creative/planet';

const stage = await createStage('#viewport', {backend: 'webgpu'});
const earth = await Planet.create(stage.engine, {
  dayMap: '/earth_day.jpg',
  nightMap: '/earth_night.jpg',
  specularRoughnessMap: '/earth_oceans.png',
  clouds: '/earth_clouds.jpg',
  radius: 1,
  tilt: 23.4,
  atmosphere: {color: [0.3, 0.6, 1], intensity: 1.2},
});
earth.setSunDirection([-1, 0.2, 0.5]);
stage.onTick(dt => {
  earth.rotation.y += 0.05 * dt;
  earth.clouds.offsetU += 0.01 * dt;
});
window.addEventListener('pagehide', () => stage.dispose(), {once: true});
```

`Planet.create` loads maps and attaches through the existing `engine.use()` API. It rejects unsupported WebGL2 engines, disposed engines, invalid options, HTTP/decode failures and oversized images. Supply `signal` to cancel creation. Loading is also aborted when the engine or Planet is disposed; failed creation removes its plugin and partial resources. Remove a ready Planet with `earth.dispose()` or `stage.engine.removePlugin(earth.name)`. One Planet is supported per engine.

Use `await earth.updateMaps({dayMap, nightMap, specularRoughnessMap, normalMap, clouds, signal})` to replace a ready Planet's complete map set after a preview is visible. The current surface, clouds and atmosphere remain drawable during downloads and decoding; the new set becomes active only after GPU validation. Omitted optional maps use their usual fallbacks. A failed or canceled update keeps the complete previous set, and a second update is rejected while one is pending. The same Planet, transform accessors, tilt, sun and cloud drift survive the swap and device restoration. Distinct committed plus pending decoded images share the 256 MiB budget. Rendering retains the existing linear sampler and single mip level; rebuilding/uploading the replacement pass can still cause a device-dependent hitch.

Only `dayMap` is required. All maps accept a URL or string, including relative URLs. `dayMap` and optional `nightMap` are sRGB color; night lights are boosted 3× before tone mapping and fade across twilight (`NdotL` from 0.05 to −0.15). `specularRoughnessMap` is linear data with ocean specular strength in red and roughness in green (0 = smooth, 1 = rough). An omitted map gives matte terrain. Optional `normalMap` is a linear RGB tangent-space normal map (+Y convention); it affects shading, not the silhouette. `clouds` is a linear grayscale coverage map, with black transparent and white opaque. Maps must be equirectangular, north at the top. Downloads are limited to 32 MiB per map; retained decoded maps are limited to 256 MiB in total and the current device's texture dimension limit.

Radius defaults to 1, tilt to 23.4 degrees, sun direction to `[-1, 0.2, 0.5]`, and atmosphere color/intensity to `[0.3, 0.6, 1]` / 1.2. `earth.rotation` uses the existing stable transform accessors in radians. `earth.clouds.offsetU` is finite and wraps to `[0, 1)`. `setSunDirection` normalizes a nonzero world-space vector. GPU restoration preserves spin, drift and decoded maps; full disposal closes those images.

Rendering adds two indexed draws: a surface with depth writes, then a front-facing cloud/rim shell at `radius * 1.01` that tests scene depth without writing it. Both share retained sphere buffers and use reversed depth. The shell produces geometric cloud parallax; UV drift animates it independently. The atmospheric rim is an analytical Fresnel approximation. Clouds and glow share one altitude, and the camera must remain outside the shell. Textures currently use linear filtering without mipmaps, so distant views can alias. The initial pipeline variant is built during setup; additional supported canvas and HDR target variants are cached on first use. Stable frames reuse these resources, and existing post-processing works with the same attachments.

Planet-owned arrays, GPU resources and render-pass descriptors are retained across steady frames. Browser/WebGPU command objects and the rest of the engine can still allocate, and actual FPS depends on the browser, display and GPU. Custom planet draws do not participate in the base `pick()`, `stats.drawCalls`, or `Stage.fit()` APIs; position the camera explicitly and inspect recorded commands for draw counts.

### Earth demo and module checks

From the repository root:

```sh
npm run dev --workspace @margoengine/creative
# Open /examples/earth/ at the printed localhost URL.
npm run test --workspace @margoengine/creative
npm run test:browser --workspace @margoengine/creative
```

The demo combines Planet's linear HDR surface/cloud/rim output with optional Bloom and AgX tone mapping. It presents a complete local 1k Earth map set first, then atomically upgrades all five maps to 2k on desktop while keeping that preview visible. Mobile keeps the complete 1k set. It includes damped OrbitControls with exterior zoom limits, a switchable procedural starfield, sun direction, independent rotation/cloud speeds, bloom and exposure controls. Desktop uses the shared 4× MSAA default; mobile uses 1× MSAA, a DPR cap of 2 and collapsible settings. Reduced-motion preferences pause rotation and cloud drift and disable navigation damping; keyboard and pinch navigation remain available. [Texture attribution and licenses](examples/earth/assets/ATTRIBUTION.md) travel with the example.

The build and prepack commands write only this package's `dist` and license copy. Checks and screenshots write to this package's `test-results`; they use existing core artifacts without rebuilding the base. The browser check uses Edge by default (or installed Playwright Chromium as a fallback); set `BROWSER_CHANNEL` to choose another installed Chromium channel. The unit checks cover loading, lifecycle, validation, resource retention and bundle isolation. The WebGPU checks cover shaders, rendered pixels, depth, HDR and device restoration.

This ESM package includes TypeScript declarations, requires `@margoengine/core` 0.1.0 and depends on `@margoengine/vfx` for particles. See the [effect options and limitations](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md).

MIT licensed.
