# Night Citadel

An asset-free WebGPU scenery study using the engine and its optional rendering packages. Core and the stage facade remain unchanged.

The fortress still contains 548 solid instances. `ScatterInstances` groups them into 10 PBR batches, preserving the procedural towers, spires, buttresses, crag and ridges. Its 95 emissive windows now illuminate nearby masonry with `Clustered` point lights instead of additive wash quads. `Shadows` supplies four cascades with PCSS filtering and cached static casters. `Bloom` owns the HDR capture and AgX presentation. `Water` adds Gerstner waves, scene refraction, shoreline foam and moon glints below the crag. `VFX` simulates drifting amber embers on the GPU.

`Sky` (`@margoengine/sky`), held at midnight with its stylized `night` options, retains the original azimuth, elevation, phase, twinkle and moon glow controls. Sky's fog (`falloff: 'exp'`, `height: 0.065`, horizon `color`) composites height-dependent haze over masonry and water, reading the matching 4× or 1× depth texture per sample. Moon direction and phase drive the sky, directional lighting, cascades and water glints together. The opening moon is at azimuth 215° and elevation 24°.

Desktop scenes inherit the engine's **4× MSAA** with canvas DPR capped at 1 to avoid extra HiDPI supersampling. Phones inherit its **1× sampling** and canvas DPR cap of 2, with no 4× textures or pipelines. Phone shadows use 512² cascades rather than 1024²; the water grid uses 64 rather than 128 segments; embers use 512 rather than 2,048 particles. The panel shows the active quality setting. It also adds window intensity, wave height, bloom and exposure controls.

The water grid concentrates those segments into a 160 m patch around the crag, with the existing horizon extension covering distant water. This keeps nearby waves resolved on desktop and phone grids. Wave height sets the largest wave train's amplitude in meters; zero flattens its displacement.

Drag, wheel, pinch and keyboard inputs retain the inertial orbit controls. Touch events track both fingers together and prevent native page zoom over the canvas, including on iPhone browsers. Rotation or focus loss clears interrupted gestures. Reset restores the opening view. Auto-orbit and environmental animation respect reduced motion, including changes made while the app is open. On phones, **Direct the night** starts collapsed at the bottom. Opening it reserves space below the scene, with independently scrolling settings and a close handle that stays visible. Landscape phones use a side drawer, a single-line title and compact telemetry so text stays separate from the controls. Page exit releases effects, GPU resources and listeners; initialization and device errors appear in an accessible alert.

The 60/120 selector caps submitted frames while preserving the timing deadline across faster or jittery animation callbacks. It renders every available callback on slower clocks. Telemetry reports actual rendered FPS separately from the measured browser callback cadence, and explains when the browser supplies fewer callbacks than the selected target. A 120 FPS target requires sufficient display refresh, browser cadence and GPU throughput; a timer cannot create additional displayed frames.

The custom GPU renderer, single shadow map and ACES presentation have been replaced by the existing engine packages. The app retains camera/timing arrays and render options. Steady frames allocate no additional GPU buffers, textures, bind groups or pipelines after warmup. Resize replaces viewport targets and bind groups, including depth resolve pipelines; scene pipelines and geometry stay retained. WebGPU command wrappers, browser internals, package code and telemetry can allocate JavaScript objects; zero heap allocation is not promised.

From the repository root:

```sh
npm ci
npm run modern:dev:showcase
npm run modern:build:showcase
node --test tests/modern-frame-timing.test.js tests/modern-night-citadel.test.js
npm run modern:test:citadel
```

The browser check verifies HDR output, lunar and atmosphere controls, actual window lighting, PCSS shadows, twinkle, bloom, exposure, waves and visible embers. A GPU probe of the water vertex shader checks flat, default and maximum wave heights against the actual desktop and phone mesh spacing. It exercises orbit, zoom, keyboard, pinch, reduced motion, resize and resource cleanup. An emulated phone verifies 1× rendering, DPR and layout. An uncapped headless compositor measures the 60/120 pacer; a separate native-clock run verifies that 120 cannot exceed browser cadence. Neither run certifies presentation on a physical 120 Hz monitor. Screenshots and the GPU report are saved under `test-results/night-citadel*`.

No models, textures, images, fonts or UI libraries are downloaded by this scene.
