# Margo vs three.js: same machine, same scenes

```sh
npm run build:packages
npm run bench:threejs            # = node examples/package-benchmarks/vs-threejs/run.mjs [--rounds=5] [--only=boxes,cad:50000] [--frames=300]
```

Writes `examples/package-benchmarks/results/vs-threejs.json` (or `--out=`) and one screenshot per scene and engine to
`test-results/vs-threejs/`. Takes the GPU lock, refuses to start on battery, and waits for a quiet CPU before every run
(`scripts/quiet-gate.mjs`; `--quietMax=40` loosens it, `--busy` skips it and records the CPU load; both label the JSON
as not for publication). Diagnosis: `--variants=margo,margo-culled,margo+nocull,three-webgpu-instanced+double` picks variants and
patches (`?diag=`, listed in `margo.js` and `three-scenes.js`), `--dump` records every shader and pipeline. Only a default run (5 rounds x 300
frames, all scenes) on a machine confirmed quiet (`BENCH_QUIET=1`) is publishable; anything shorter is labelled
`"SMOKE TEST, NOT FOR PUBLICATION"` in the JSON's `note`. No publishable run exists yet (see
`docs/whitepaper/reproduce.md`).

## What is compared

| Variant | Renderer | Scene objects | Pair |
| --- | --- | --- | --- |
| `margo` | Margo core (WebGPU) + gltf-pro/environment/shadows for the helmet | One core mesh per object (an entity each; core batches them into one draw per geometry) | mesh |
| `three-webgl` | three.js r186 `WebGLRenderer` | One `Mesh` per object (shared geometry and materials) | mesh |
| `three-webgpu` | three.js r186 `WebGPURenderer` (WebGPU backend; the run fails if it falls back to WebGL2) | One `Mesh` per object | mesh |
| `margo-instanced` | Margo core + `@margoengine/materials` | `createInstancedMesh` per shape (one entity, per-instance matrix and tint) | instanced |
| `margo-culled` | Margo core + `@margoengine/culling` | `CulledInstances`: one batch per (shape, material), GPU frustum culling, indirect draws | instanced |
| `three-webgl-instanced` | `WebGLRenderer` | One `InstancedMesh` per shape | instanced |
| `three-webgpu-instanced` | `WebGPURenderer` | One `InstancedMesh` per shape | instanced |

Compare within a pair: **mesh <-> mesh** is one scene object per box or part on both sides (what most three.js code
and most Margo code does; Margo's core meshes are batched automatically, three's are one draw each), **instanced <->
instanced** is the instanced API of each engine (static matrices uploaded once, no per-object CPU work). Until
2026-10-15 the harness only had core meshes for Margo and quoted them against three's `InstancedMesh`, which compares
a scene graph of 50,000 entities with one object holding 50,000 matrices (`docs/whitepaper/boxes-vs-threejs.md`).
Details of the instanced variants:

- `margo-instanced` boxes: one `createInstancedMesh` with a white material and the palette as per-instance tint
  (as three's `setColorAt`), so 1 draw like three. CAD: one per part shape with baked world matrices (5 draws), as
  three's instanced CAD. Moving boxes: `instances.setMatrixAt` per moving box per frame (uploads the changed rows).
  It draws with gltf-pro's shader, which tone-maps with ACES (core and three's box scenes use Reinhard), so its
  frames are brighter than the other variants'; its GPU time is gltf-pro's material, not core's.
- `margo-culled` boxes: `CulledInstances` has no per-instance colour, so one batch per palette colour (16 indirect
  draws). CAD: one batch per part shape (5). It draws with core's frame shader (same pixels as core meshes) but with
  its own cull-none pipeline, so it does not get core's back-face-culled pipeline (4be71f5). Moving boxes:
  `setTransform` per moving box per frame (one 64-byte upload each).

Scenes (`scenes.js`, the same data for every engine):

- `boxes-<n>`: n = 1,000 / 10,000 / 50,000 boxes of 0.5 m on a cubic grid, 16 colours, camera orbiting. Static.
- `boxes-10000-moving`: the same, every box rotating every frame (CPU transform updates + uploads).
- `cad-<n>`: the synthetic CAD assembly of `../cad` (plates, brackets, bolts, washers, nuts; 27 parts + 3 group nodes
  per module, 5 levels deep), 10,000 / 50,000 parts, static, camera orbiting.
- `helmet`: Khronos DamagedHelmet (`examples/assets/damaged-helmet.glb`) on a floor slab, image-based lighting from
  the same procedural HDR sky as `gates/post-stack.html`, directional light with a 2048 shadow map.

Particles (100k / 1M) are not in the harness yet: three.js has no built-in GPU particle system, so a fair version
needs a hand-written TSL compute simulation (three's `webgpu_compute_particles` example is the model) that matches
`@margoengine/vfx`'s gravity + curl turbulence + ground bounce + respawn, and a WebGL2 version needs
`GPUComputationRenderer`. Until both exist, particle numbers are Margo-only (`vfx-gpu.mjs`).

## Metrics (per run; the summary is the median over rounds of each run's median)

- `loadMs`: navigation start to the first frame finished on the GPU (script download/parse, engine and device
  creation, scene build incl. asset fetch/parse, pipeline compilation). Split into `createMs`, `buildMs`,
  `firstFrameMs`. Every run is a fresh browser with a fresh profile, so every load is a cold shader cache.
- `fps`, `cpuMs`: 300 frames driven by requestAnimationFrame after 60 warm-up frames, vsync and frame-rate cap off.
  `fps` is frames divided by the time until the GPU has finished the last one. With vsync off, requestAnimationFrame is
  not paced by the GPU, so the rAF rate (`rafFps`, what `fps` was before 2026-10-15) let an engine with cheap submits
  queue hundreds of frames and report several times what its GPU renders.
  `cpuMs` is main-thread time inside the frame call (scene update + the engine's render/submit). GPU-process and driver
  time is not in it.
- `gpuMs`: WebGPU (Margo and three's WebGPURenderer): every render and compute pass either engine begins is given
  timestamp writes by the harness (`GPUCommandEncoder.prototype.beginRenderPass/beginComputePass`), and a frame's GPU
  time is the sum of its pass durations, so neither engine's own profiler is trusted. `passMs`/`passes` give each
  pass's median and its attachments; `gpuSpanMs` runs from the first pass's start to the last pass's end (it includes
  gaps between passes). WebGL2: `EXT_disjoint_timer_query_webgl2` around the render call, `null` when the browser does
  not expose it.
- `serialFrameMs`: submit one frame, then wait for the GPU to be idle (WebGPU `onSubmittedWorkDone`, WebGL a 1-pixel
  `readPixels`): frame latency with no CPU/GPU overlap, comparable across APIs.
- `jsHeapMB`: `performance.memory.usedJSHeapSize` after two forced GCs (`--js-flags=--expose-gc`).
- `jsGzipBytes`: gzip (level 9) of the JavaScript files that page actually loaded from the production bundle. The
  bundles also contain this harness and the scene builders (the CAD part shapes are built with
  `@margoengine/geometry` for both engines), so these are page totals, not engine sizes; `npm run measure:threejs`
  is the engine-only comparison.
- `vsMargoImage`: the final frame at t = 0 against Margo's (mean of the per-pixel max channel difference, and the
  fraction of pixels more than 16 levels apart). A sanity check that the scenes match, not a quality score.

## Fairness choices

So nobody can call it a strawman:

- Same canvas (1280x720 CSS px, DPR 1), same camera path per frame (scene time advances 1/60 s per frame for every
  engine, whatever its frame rate), same geometry data, colours, light direction and intensity, same clear colour.
- 4x MSAA everywhere: Margo's desktop default; three.js `antialias: true` (WebGL default framebuffer MSAA, WebGPU
  sampleCount 4). The JSON records the sample count each page reports.
- Tone mapping matched to Margo's: `ReinhardToneMapping` for the box and CAD scenes (core maps x/(1+x)),
  `ACESFilmicToneMapping` for the helmet (gltf-pro maps ACES(x/0.6), which is three's ACES with exposure 1). sRGB output
  in both. three.js multiplies ambient light by albedo/π, Margo by albedo, so three's `AmbientLight` gets π x Margo's
  ambient.
- Single-sided materials on both sides for the boxes and CAD parts (closed solids): three's default `FrontSide`, Margo
  `doubleSided: false`. Margo core's default material is double-sided, which shades back faces three never draws
  (+45% GPU at 1k-50k boxes; `docs/whitepaper/boxes-vs-threejs.md`).
- three.js best practice: shared geometries and materials; static objects have `matrixAutoUpdate = false` and the scene
  `matrixWorldAutoUpdate = false` (the moving-boxes scene keeps auto-update on the moving boxes only); `InstancedMesh`
  variants with per-instance colour (`setColorAt`) and partial matrix uploads (`addUpdateRange`) for moving instances;
  for CAD the instanced variant bakes each part's world matrix into one `InstancedMesh` per part shape (5 draws).
  Per-object frustum culling is on (three's default) in the `Mesh` variants.
- Both engines' production builds (Vite, minified, tree-shaken, same target); three.js resolved from `node_modules`
  (`three@0.186.1`, pinned in package-lock.json); the WebGPU build aliases `three` to `three/webgpu` as three's docs
  recommend.
- Fresh browser per run, engine order rotated every round, AC power and the GPU lock as in every other GPU benchmark.

Known asymmetries (they are in the results, not hidden):

- Shadows: Margo's `@margoengine/shadows` renders 4 cascades with PCSS soft edges; three.js renders one 2048 map with
  its default PCF filter, three's usual setup for a small scene (its CSM add-on would be the like-for-like but is not
  what most apps use). This costs Margo GPU time in `helmet`.
- In `helmet` Margo's floor is a core mesh (Reinhard) while three tone-maps the whole frame with ACES, so the floor
  differs in brightness; the helmet itself is drawn by gltf-pro with ACES like three's.
- Back faces: since 4be71f5 Margo core draws a geometry batch whose instances are all single-sided and unmirrored with a
  back-culled pipeline without the shader's `discard`, as three does (`cullMode: 'back'`); before it, back faces
  were rasterized and discarded in the shader, and the `discard` cost early depth testing (most of three's GPU lead
  on the box scenes; `docs/whitepaper/boxes-vs-threejs.md`). `margo+nocull` reproduces the earlier core on the GPU.
  `margo-culled` still draws cull-none with the discard (see above).
- three's WebGPURenderer draws into an RGBA16F MSAA target and tone-maps in an extra full-screen pass (about 0.15 ms at
  1280x720); Margo and three's WebGLRenderer tone-map in the material shader and render straight to the canvas.
- three's `MeshStandardMaterial` includes features Margo core's material does not (e.g. maps, multi-scattering
  terms): its fragment shader does more work per pixel even when those inputs are unused.
- Margo's CAD hierarchy is a real scene graph in both the `margo` and three `Mesh` variants; three's instanced CAD
  variant drops the hierarchy (baked matrices), which is fine for a static viewer but loses per-part transforms.
- Draw counts are reported as each engine counts them (Margo: core batches only; three: `renderer.info`).

## Pinned versions

three 0.186.1 (`node_modules/three`), Margo at the commit in the JSON, browser version, adapter and driver strings in
the JSON's `hardware`.
