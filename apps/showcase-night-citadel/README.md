# Night Citadel

A standalone, asset-free WebGPU showcase of Margo Engine core geometry/camera, creative's `HDRRenderTarget`, and scenery's `SkyMoonPass`. Scenery remains a separate optional package, as in the Vite starter's machinery/scenery toggles. This app uses a custom recorded render loop rather than `Engine.start()` to retain its camera math, uniform staging, descriptors and instanced draw bundles.

From the repository root:

```sh
npm ci
npm run dev
```

Open Vite's localhost URL. `npm run modern:dev` opens the original starter with its lazy scenery toggle. `npm run modern:build:showcase` builds this app into `dist/`; `npm run build` includes it alongside both starters. WebGPU requires localhost or HTTPS and a supported browser/GPU; initialization and device-loss errors appear in the scene overlay.

The six solid batches contain 548 instances: masonry, octagonal towers, conical spires/shards, curved flying buttresses, a fractured foundation crag, and distant ridges. A seventh batch adds 95 small lantern-wash quads, for 643 instances and 15 total draw calls. Core `Geometry` packs `[px, py, pz, nx, ny, nz]` into 24-byte vertices. Static instance buffers use core's 96-byte matrix/color/material layout. No models, images, fonts, textures or UI libraries are downloaded.

Each frame renders a 2048² moon-aligned depth shadow map, then `SkyMoonPass` followed by moonlit geometry and lantern wash into creative's HDR target, then a fullscreen tone-mapped presentation. All depth clears use zero and all depth comparisons use `greater-equal`. The background triangle does not write depth. Four diffuse bands, cool ambient fill, a restrained Fresnel rim, amber window emissives and height-dependent fog give the fortress its night palette. Lantern wash uses a smooth radial falloff with additive blending and fog attenuation; it tests depth without writing depth or casting shadows. The moon direction is shared directly by sky, lighting and the shadow projection. The opening view places the lunar disc above the keep at azimuth 215° and elevation 24°; free orbit can move it out of view.

Azimuth, elevation, phase, haze, twinkle amplitude and glow update on input events. Stars appear above 15° with a soft elevation fade. Drag, wheel, pinch and keyboard controls use inertial scalar camera state; auto-orbit respects reduced-motion preferences at startup. Collapse **Direct the night** to expose more of the scene on small screens. Resize replaces and destroys the two HDR textures and updates the presentation bind group; pipelines, shadow map, geometry and uniform buffers remain retained. Page exit disposes GPU resources and input/resize listeners.

The animation callback constructs no matrices, vectors, arrays, objects, strings or closures. Uniform arrays, inverse workspace, transform buffers, pass descriptors, command submission array and render bundles are allocated at startup. Telemetry reuses preformatted strings. Input events and resize may allocate. WebGPU creates command encoder/pass/buffer and swapchain-view wrappers during submission, and browser internals can allocate and collect; **total zero heap allocation is not a claim this app can make**.

The 60/120 selector preserves the frame deadline across faster or bursty `requestAnimationFrame` callbacks. Near-native clocks bypass the timing gate, so small VSync jitter cannot skip alternate frames. Long stalls reset the deadline without replaying missed frames. The selector is a cadence target, not a hardware guarantee; actual FPS is shown in the HUD. Display refresh, browser throttling and GPU load can limit it. Pixel ratio is capped at 1.5 and texture dimensions at 4096 to bound fill rate and resize memory.

Scenery reconstructs the view ray at the fullscreen triangle's three vertices and interpolates it across the screen. Lunar angular sine/cosine are computed only when configuration changes. The 160-byte staging array, pipeline and bind group stay retained. These optimizations apply to every `SkyMoonPass` consumer. Core remains unchanged at 19,874 bytes gzip; optional modules have no 20 KiB ceiling.

```sh
npm test
npm run modern:test:citadel
npm run modern:bench:sky
```

The browser check reads actual HDR/depth pixels to verify lunar phases, synchronized lighting, crisp shadows, haze, twinkle and the 15° star cutoff. It exercises drag, wheel, pinch, keyboard controls, resize, teardown and a 15-second continuous-orbit heap/GC profile including collected allocations. For pacing measurements it disables Chromium's headless compositor frame limiter; those measurements do not establish a physical display's presentation rate. Reports, screenshots, allocation profile and performance trace are saved under `test-results/night-citadel*`.
