# Known bugs and unverified features

What is known to be wrong or not yet proven, and what it would take to close each item. Design limits (where a
boundary is a decision, with its escape hatch) live in [limits.md](limits.md); this page lists defects and checks that
are still open.

## Blocked on hardware we do not have

These features pass their tests against the published specifications, but the only real check is a device the project
does not own. Each entry says exactly what is needed to close it.

### USDZ export with textures: never opened in Quick Look

- **What:** `exportUSDZ` in `@margoengine/exporters` (`packages/exporters/src/usdz.ts`) writes UsdPreviewSurface
  materials with texture readers (base colour with opacity and `opacityThreshold`, metal-rough on the g and b channels,
  normal, occlusion, emissive, `st`/`st1` texcoords with the V flip, a base-colour `UsdTransform2d`, wrap modes) and
  stores each image 64-byte aligned and uncompressed.
- **Verified:** the USDZ tests (`packages/exporters/tests/usdz.test.js`) check the shader graph text, every file's
  alignment, the image bytes and a round trip through our own USD reader (`@margoengine/usdz`). OpenUSD's own checker
  (`packages/exporters/tests/validate-usdz.py`) has not been run on textured output: it needs the `usd-core` Python package, which is not
  installed on the development machines.
- **Not verified:** that Apple's renderers show the textures as intended. A non-default `normalScale` writes a normal
  scale and bias that OpenUSD's validator may flag as non-standard.
- **Needed to close:**
  1. An iPhone or iPad on iOS 17 or later, or a Mac on macOS 14 or later (Quick Look and AR Quick Look).
  2. The kit's exported files opened there, each compared with the same scene drawn by Margo: a base-colour texture with an
     alpha mask (`opacityThreshold`), a blended (alpha) texture, a metal-rough map plus a normal map at `normalScale` 1
     and 2, an occlusion plus emissive map, a base-colour texture transform (offset, scale and rotation) with repeat
     and mirror wrapping, and rotation alone at +30 and -30 degrees.
     `node scripts/make-usdz-quicklook-kit.mjs <folder> --glb` writes them (eight files: `normalScale` 1 and 2 are
     separate; 07 and 08 are the rotations), with engine-drawn reference twins.
     Texture rotation (KHR_texture_transform radians, written as `UsdTransform2d` degrees with the same sign, and read
     back the same way by `@margoengine/usdz`) is written but not yet confirmed on a device: Quick Look on iOS 27.2 drew file 06 leaning clockwise, as gltf-pro draws the same glTF
     transform (the kit's first checklist expected anticlockwise; that expectation was wrong). Files 07 (+30, should
     lean clockwise) and 08 (-30, anticlockwise) await a device re-check.
  3. `pip install usd-core`, then `python packages/exporters/tests/validate-usdz.py <file>` on the same files.
  4. The result (pass, or the difference seen) recorded here and in `docs/threejs-parity.md` (USDZExporter row).

### WebXR AR hit testing: never run on an AR device

- **What:** `HitTest` in `@margoengine/xr` (`packages/xr/src/hit-test.ts`): hit-test sources from the viewer, an input
  source or transient input, results as reference-space poses, anchors.
- **Verified:** tests against the W3C WebXR Hit Test Module's interfaces with a mocked session
  (`packages/xr/tests/hit-test.test.js`); [limits.md](limits.md) has its row.
- **Needed to close:** an Android phone with ARCore and a Chromium browser that exposes WebXR `immersive-ar` with the
  WebGPU XR binding (`XRGPUBinding`), or an AR headset with the same; then a reticle placed on a real floor and a real
  table (viewer source) and by screen tap (transient source), one placement anchored, and the result recorded here.

### Intel Arc 140V: three new GPU-suite failures fixed on this PC, not yet rerun on Intel

- **Verified on Intel** (Core Ultra 7 258V, Arc 140V, driver 32.0.101.8860, main at 30bea6fa, recheck of 2026-10-27):
  the four failures of the first run (main d000e4b6) are fixed there. FFT: the Stockham passes match the host-twiddle
  f32 reference exactly (0.00 u at n = 1024 and 65536); path tracer `combinedHDR` within 1 sRGB level (was 226),
  converged after 17 frames; the Next client drew the mint cube after 598 ms (past the old 300 ms fixed wait); the voxel
  and path-tracer `test:gpu:slow-compile` twins and `modern:test:browser` with its twin pass.
- **What failed instead** (same run), and the cause and fix of each, measured on the RTX A6000:
  1. compute CPU/GPU parity, `sin, cos, atan2[16]: cpu -0.4964582920074463, gpu -0.49644696712493896` (1.13e-5 off,
     tolerance 1e-5). Cause: the WGSL builtins. WGSL allows `sin` and `cos` 2^-11 absolute error inside [-pi, pi] (and
     none promised outside), `atan2` 4096 ulp, `asin` 6.8e-5; the Arc 140V is 1.1e-5 off near 1.5 where the A6000 is
     within 3.3e-7 (the A6000 is itself 1e-5 off at |x| near 100, 133 ulp for `tanh`, 114 for `pow`). Fixed: element-wise
     functions use precise f32 versions (`packages/shared/precise-math.js`: integer Payne-Hanek reduction, minimax
     polynomials from `scripts/precise-math-coefficients.mjs`), within 1 to 2.5 ulp (pow 5) on every GPU;
     `createCompute({ fastMath: true })` keeps the builtins. The parity check is tighter now (1e-6, plus each function
     in ulp) and the fastMath path is checked against the WGSL bounds. Regression tests: `tests/precise-math.test.js`
     (the bounds over dense inputs with fused and unfused rounding and with division and sqrt at WGSL's limits), the
     GPU check `compute-precise-browser.js` (the A6000 computes the host mirror's values bit for bit), and
     `compute test:browser:spec-math`, which moves every builtin result by WGSL's whole allowed error
     (`--spec-math-error`, scripts/browser.js): the old parity check fails there as on Intel, the new one passes.
  2. voxel normal suite, `4x four-view blue`: the bottom two views black. Cause: the bevel check took "the quad and
     triangle counts did not change for 3 frames" for "every chunk is meshed"; with one mesher worker on a slower CPU
     a bevelled chunk takes several frames, so the last two chunks (the bottom views) were not on the GPU yet. Fixed:
     `VoxelRenderer.stats.pending` counts the chunks not yet on the GPU (changed, meshing, waiting for upload); the
     check waits for a frame with `pending` 0, `compiling` false and draws. Regression test: `voxel test:gpu:slow-mesh`
     delivers every worker message 150 ms late (`--worker-delay`): the old check fails there the same way, the new one
     passes.
  3. voxel-pathtracer normal suite, `traversal fisheye: depth`: 1.17e-3 relative depth error against the CPU raycast
     (assertion < 1e-4), 16379 of 16384 first hits alike. Cause: the fisheye rays came from the builtin `asin`, `sin`
     and `cos`; a ray that far off grazes a different voxel face. Fixed: the panorama and fisheye rays use the precise
     functions. Regression test: `voxel-pathtracer test:gpu:spec-math` (the projections check with every builtin at
     WGSL's error bound) fails with the builtins and passes with the fix.
- **The class:** five checks have now waited "N frames" or "N ms" for something that takes longer on a slower GPU or
  CPU. `scripts/check-fixed-waits.mjs` (run by `tests/check-fixed-waits.test.js` in `npm run verify`) fails on any new
  fixed frame count or sleep in a GPU or browser check unless it carries `// fixed-wait: <reason>`; the ones already
  there are counted in `scripts/fixed-waits-baseline.json` and only go down. `scripts/support/gpu-ready.js`
  (`waitForPipelines`) waits for the pipelines themselves.
- **Not verified:** that the three now pass on the Intel GPU, and the precise functions' bounds on its compiler.
- **Needed to close:** the steps in `private/handoffs/intel-recheck.md` on the Intel PC (the suites, their
  slow-compile, slow-mesh and spec-math twins, and the precise maths results in `compute-browser.json`), zipped; then
  this entry removed or turned into the cause found.

## Open defects

### `@margoengine/react` installed alone does not build with webpack or Turbopack

- **What:** the React README offers `npm i @margoengine/react` alone. Vite builds that app (it stands in a stub for an
  optional peer that is not installed, and the bundler matrix checks it emits no optional package), but Next.js fails:
  webpack and Turbopack must resolve every string-literal `import()` in every module they reach, called or not.
- **Repro:** a Next.js 16.4.3 App Router page with a client `Scene` that renders `Canvas`, `Mesh`, `BoxGeometry`,
  `PbrMaterial` and `OrbitControls` from `@margoengine/react`, installed with only `@margoengine/react`,
  `@margoengine/controls`, `react` and `react-dom` (npm adds the required peers core and stage). `next build --webpack`
  and `next build --turbopack` both stop with `Module not found: Can't resolve` for 18 optional peers (2026-10-26).
  A plain webpack 5 build of an entry importing those five names fails the same way: 39 module names in 19 packages
  (2026-10-27).
- **Cause (measured, 2026-10-27):** two sources, each enough on its own.
  1. **Fixed (2026-10-27):** the ten loaders moved out of the `Stage` class into feature entries that take the stage
     (`@margoengine/stage/gltf` `addGLTF`, `/cad` `addCAD`, `/sky` `addSky`, `/particles` `addParticles`, `/effects`
     `addEffects`, `/environment` `addEnvironment`, `/shadows` `addShadows`); the stage root holds no `import()`
     (`tests/modern-facade-isolation.test.js` builds a stage-only app and fails on any lazy import). Callers migrate
     with `node scripts/codemod-stage-loaders.mjs`. Before:
     The stage facade: `Canvas` constructs a `Stage` (it hands it to `onCreated` and `<Stage>`), and the `Stage` class
     methods `load` (glTF, CAD), `gltf`, `machinery`, `creative`, `scenery`, `sky`, `particles`, `effects`,
     `environment` and `shadows` hold 10 `import()`s of 6 optional packages (`creative`, `creative/particles`,
     `creative/post`, `environment`, `gltf`, `machinery`, `machinery/cad`, `scenery`, `scenery/sky`, `shadows`).
     Class methods are never tree-shaken, so they are reached from every `Canvas`.
  2. The React package's root entry re-exports every binding, so the modules holding the other 29 `import()`s are in
     the graph of any import from it: `post` (14 effects and `post/stack`), `extras` (`materials`, `post/depth`,
     `post/mrt`, `machinery/section`), `assets` (`gltf-pro`, `fbx`, `cache/manager`, `environment`), `components`
     (`shadows`, `cameras/layers`, `html`), `picking` (`selection`), `lights`, `voxels` and `xr`.
  Changing only the React package cannot fix it: even with every optional binding behind its own subpath (a breaking
  change of the root entry's exports), `Canvas` still reaches `Stage`. Bundler hints that skip the `import()`
  (`webpackIgnore`, `turbopackIgnore`) are not a fix: the bare specifier then reaches the browser, which cannot resolve
  it without an import map, so those features would break under webpack even with the peer installed.
- **Needed to close:** (1) a stage facade change, frozen for 1.0: the ten loaders out of the `Stage` class into entries
  the app imports (for example `@margoengine/stage/gltf` with a `loadGLTF(stage, url)`), so that the root entry holds no
  `import()` of an optional package; and (2) the React root entry holding only bindings that need no optional peer,
  with the others behind subpaths (`@margoengine/react/post` already exists; `html`, `xr`, `voxels`, `lights` and the
  rest would join it). Until then, install `margoengine` for webpack and Turbopack, as the README says; the bundler
  matrix builds both Next.js bundlers from it.

### Pinned proofs: nine historical claims no longer run against today's core

- **What:** `npm run proofs` (pinned, every proof; not part of `verify` or `check:merge`) fails color-output,
  environment-volumetric, math-consolidation, post-ssr, post-ssr-models, post-stack, probes-decals, quality-presets
  and water-ssr ("story must exercise the GPU", "fog requires the standard core PBR shader", "Water GPU calls
  differ", math-consolidation's `multiplyMatrices` writing into `undefined`), on this PC, which holds their commits, on
  main before the 2026-10-24 rewrites and after (a clone without the commits reports them HISTORICAL instead).
  `npm run proofs -- --current` (the ongoing guarantees, in `verify`, read from `proofs/baselines/`) passes 20/20.
- **Repro:** `npm run build:packages && npm run proofs -- --only=environment-volumetric`.
- **Cause:** a pinned run builds the old package sources at their claim commits but imports today's
  `@margoengine/core` (compare.js: "core (frozen at 1.0.0) ... today's"). Core has had bug fixes and clean-room
  rewrites since, so old sources that patch core's WGSL text by search and replace no longer find it
  (environment at `366ebff`, `lighting.ts`: `if (code === source) throw ... requires the standard core PBR shader`),
  their stories throw on the first frame (hence "must exercise the GPU"). math-consolidation is the same mismatch the
  other way round: today's proof script calls `mat4.multiplyMatrices(a, b)` without `out` (optional in today's math),
  but the pinned run builds math at `4eed254`, where `out` is required.
- **Needed to close:** build `packages/core/src` (and the proof script's own calls) at the pin as well, from Git, on a
  checkout that holds the commits; or retire the nine pinned runs as HISTORICAL with that reason, keeping their
  `--current` guarantees.

### Chrome on Windows logs a console warning on every Margo page

- **What:** on Chrome and Edge for Windows every page that starts the renderer logs `The powerPreference option is
  currently ignored when calling requestAdapter() on Windows. See https://crbug.com/369219127` (a console warning, found
  2026-10-27 by `npm run check:quickstart`, which expects a quiet console). The scene is not affected.
- **Repro:** open the README quickstart in Edge on Windows and read the console.
- **Cause:** `GPURenderer.create` in `packages/core/src/renderer.ts` calls `requestAdapter({ powerPreference:
  'high-performance' })` on every platform.
- **Needed to close:** skip the option where the browser ignores it (`/Win/.test(navigator.platform)`). That costs 17 to
  21 bytes gzip, and core is within 20 bytes of its 20 KiB gzip ceiling in `scripts/build-modern.js`, so the build
  stops. Either 20 bytes are found elsewhere in core or the ceiling is raised on purpose. The fix and its test are
  written (a platform table for the adapter request in `tests/core-timestamp-feature.test.js`). `@margoengine/compute`
  has the same default (`packages/compute/src/context.ts`). Until then `check:quickstart` records this one message
  as a known issue and fails on any other console output.

### 4x MSAA blending is not repeatable (RTX A6000 under CPU load, and Intel Arc 140V)

- **What:** the voxel GPU check (`packages/voxel/tests/render-browser-check.mjs`, run by `check:merge`) fails now and
  then in a busy run at its "tree and overhang" view, at 4x MSAA: "meshes in another order drew {differing:36, max:1}"
  (mesh arrival order step) and "greedy vs naive differ over an area" (same view, same pixels). Run alone it passes.
- **Repro:** `node scripts/gpu-lock.mjs run --owner=<you> -- node packages/voxel/tests/render-browser-check.mjs
  --repeat=450`: one renderer, the still view drawn 450 times while the other cores spin. 1 to 3 frames in 450 differ
  from the first by 1 in 8 bits (1 ulp on rgba16float) on 13 to 82 pixels, then the next frame is back (Edge and
  Chrome, Dawn D3D12, RTX A6000, driver 32.0.16.1742, 2026-10-26).
- **Intel Arc 140V** (driver 32.0.101.8860, main at 30bea6fa, recheck of 2026-10-27): the same repro drew 6 of 450
  frames differently, always the single pixel (101, 72): [109, 107, 104] instead of [100, 99, 96], 9 of 255 (the
  printed frames: 25, 198, 256, 327, 400), so all 6 also exceed the blended-4x tolerance of 1 below. So it is not
  NVIDIA-only; the earlier run on main d000e4b6 that drew all 450 alike was not a controlled comparison (another
  commit and other conditions).
- **Cause: open, and it may be on Margo's side.** Measured on the A6000 so far: every differing pixel is seen through
  the glass wall, along glass and terrain edges (pixels whose samples hold more than one surface). Between the frames
  nothing that Margo hands the GPU changes: no buffer write but the frame uniform and indirect arguments, bit for bit
  the same each frame; the glass quads in the same order. The frames stay identical at 1x, without the glass, with the
  glass drawn unblended, with blending on but the destination factor zero, with the glass drawn in the opaque pass,
  without core's mid-frame resolve and with Dawn's D3D12 render-pass toggle off; they still differ with `max`
  blending, which does not depend on order. Mesh arrival order is not involved: 168 permutations of the mesh replies
  drew the same pixels on a quiet machine. The NVIDIA report drafted from this is withdrawn.
- **What the checks do about it (Scott, 2026-10-26):** the voxel GPU checks allow a difference of at most 1 in 8 bits
  (1 half-float ulp on the rgba16float HDR scene) on views that blend a translucent layer at 4x MSAA, and nowhere else:
  1x views, views with no translucent layer, every other check and every other package stay exact. The rule is the named
  constant `BLENDED_4X_MAX_CHANNEL_DIFF` in `packages/voxel/tests/blend-tolerance.js`, unit-tested
  (`blend-tolerance.test.js`: 1 passes, 2 fails). The GPU check shows it cannot hide an ordering bug: the same two
  translucent panes in the other order differ by up to 132 of 255 (`swapped layer order` step), and the mesh arrival
  order step stays a pixel comparison with that tolerance only. The check's output prints the exact count next to the
  tolerant one, and `--repeat` reports both (it still fails on any exact difference: it is the repro).
- **Needed to close:** the cause found (Margo-side or not) with both GPUs' repro results explained, and the fix or the
  vendor's explanation recorded here; then the tolerance can go.

## Performance losses still open

Measured but not fixed. Their history, sources and rerun commands are in
[whitepaper/perf-history.md](whitepaper/perf-history.md#open-losses).

- **three.js `InstancedMesh` against Margo's instanced paths:** partly closed on 2026-10-25 (culled pipeline, one
  upload per frame, GPU spheres, untextured materials); `CulledInstances` now leads on static boxes at 10k and 50k.
  The three gaps still open are the entries below.
- **Galaxy S23 Ultra island demo at 3-5 FPS** (particles off does not help). Partial fixes have landed; no after number
  exists. **Needed to close:** the device, then a measured run.

The entries below were measured with `npm run bench -- instanced --engines=margo,three-webgl,three-webgpu` (busy
machine, diagnostic; numbers and method in [whitepaper/boxes-vs-threejs.md](whitepaper/boxes-vs-threejs.md),
"Instanced: fixes and what is left"). Each cause was measured, not guessed.

### createInstancedMesh reads vertex attributes its material does not use

- **What:** `@margoengine/materials` `createInstancedMesh` boxes at 50,000: GPU 0.63 ms against three's WebGL2
  `InstancedMesh` 0.47 ms (10,000: 0.156 against 0.128 ms). `CulledInstances` draws the same scene in 0.30 ms.
- **Cause (measured):** gltf-pro's vertex is 80 bytes (position, normal, tangent, two UV sets, colour as five vec4)
  and its vertex stage reads all of them even when the material uses no UV, tangent or vertex colour. The same page
  with the vertex stage reading only position and normal draws 50k in 0.47 ms; texture reads at one fixed texel
  (0.643 ms) and dropping the node x instance matrix product (0.642 ms) change nothing.
- **Plan:** gltf-pro chooses the vertex inputs per primitive from what the finished shader reads: a material with no
  map and no tangent-space lobe (materials' bare standard material) drops the tangent frame, and the vertex stage then
  writes constant UV and tangent outputs without fetching them. It needs the instancing patch to anchor on the
  vertex stage after that choice (today it patches `o.uv=i.uv; o.color=...` last) and a pixel check that untextured
  materials draw the same frames.

### A package's own render pass costs a fixed MSAA store and reload

- **What:** at 1,000 boxes both Margo instancing paths take 0.037-0.039 ms of GPU per frame against three's WebGL2
  0.030 ms (three's WebGPU renderer 0.050 ms).
- **Cause (measured):** core draws a frame in one render pass when no package adds one. A package pass (gltf-pro for
  `createInstancedMesh`, `CulledInstances`) makes core store its multisampled colour and depth, the package reload
  and store them, and core resolve them in a final pass: three passes against one. The resolve pass's depth
  attachment is not the cost (removing it: 0.037 -> 0.037 ms).
- **Plan:** let a package draw inside core's main pass (for example a frame-graph pass that core encodes in its own
  render pass when it needs only core's targets). That is a new core capability, so it waits for the core freeze to
  lift; until then the cost is about 0.01 ms per frame and matters only for very small scenes.

### Moving instances spend twice three's CPU per frame

- **What:** 10,000 instances moving every frame: CPU 1.23 ms (`createInstancedMesh`) and 1.33 ms (`CulledInstances`)
  per frame against three's WebGL2 0.63 ms and WebGPU 0.89 ms.
- **Cause (measured by CPU profile):** the matrix maths is now the same cost in both (Euler to quaternion, about
  0.3 ms, mostly sine and cosine). The rest is Margo's per-row validation (finite values, affine last row, nonsingular
  for `CulledInstances`; about 0.2 ms), which three's `setMatrixAt` does not do, and the upload of 96-byte rows
  (960 KB a frame) where three uploads 64-byte matrices.
- **Plan:** a bulk `setMatrices(start, Float32Array)` on PBRInstances and CulledInstances that validates and copies
  a whole range in one call, and a separate matrix stream so moving instances upload 64 bytes each. Both are package
  changes; the validation itself stays (it is what keeps a bad matrix from reaching the GPU).

The two entries below come from the three.js speed matrix ([whitepaper/perf-vs-threejs.md](whitepaper/perf-vs-threejs.md),
rows 10.11 and 11.3; run `20261026-165034`, busy machine, diagnostic). Their first causes are fixed (perf-history entry
26); what is left is different work.

### STL import still computes normals three's STLLoader leaves zero

- **What:** `p-stl`, a 204,800-triangle binary STL: the plain `parseSTL` 4.9 ms against three's `STLLoader` 2.8 ms
  (run `20261026-201722`, busy machine, diagnostic); the CAD path `parseCAD` (scene `p-stl-cad`) is 29.4 ms, with no
  three.js equivalent. History: `parseCAD` 111 ms before perf-history entry 26, 28.7 after it, then `parseSTL`
  (entry 31).
- **Cause (measured, Node CPU profile of `parseSTL`):** both readers copy the file's floats into one non-indexed
  buffer (614,400 vertices). This file stores zero facet normals, as most writers do. three copies the zeros;
  `parseSTL` computes the flat normal of each such facet (`flatNormal`, about 1.3 ms of its time in Node), writes an
  identity index array and zero-fills a third array. `parseCAD` additionally welds corners (205,440 vertices), builds
  parts and creates GPU meshes with a `PbrMaterial`; the weld is what CAD sections, edges and part deduplication rely
  on, so it keeps it.
- **Status: accepted difference in work (Scott, 2026-10-26).** `parseSTL` computes flat face normals on ingestion so the
  mesh is render-ready; three's `STLLoader` copies the file's zero normals, which light wrongly until the user calls
  `computeVertexNormals()`. The full job is measured as `p-stl-normals` (run `20261026-211213`, diagnostic): three
  `STLLoader.parse` + `computeVertexNormals()` 8.7 ms, `parseSTL` 4.7 ms, so Margo is faster when both produce a
  lit mesh. The plain-copy `p-stl` gap (4.7 against 2.7 ms, 1.7x) stays listed. The entry stays because `p-stl-cad`
  (the CAD path, 32 ms) is a different job with no three.js equivalent.
- **Plan:** none for the CAD path (different job). For `parseSTL`, the remaining gap is the computed normals, which are
  the behavior a user needs; an opt-out only to win a benchmark would measure less work, so it is not planned.

### USDZ export writes every mesh in world space

- **What:** `p-export-usdz`, 1,000 boxes: `exportUSDZ` 16.0 ms (52.8 before entry 26) against three's `USDZExporter`
  2.5 ms; the archives are 2.46 MB against 444 KB.
- **Cause (measured):** `exportUSDZ` writes each node as its own world-space mesh, so the box's 24 vertices, normals
  and UVs are written 1,000 times as shortest round-trip text (144,000 numbers). three's archive is 5.5x
  smaller, so it writes far fewer.
- **Plan:** write a geometry shared by several nodes once (a mesh under a class prim) and give each node an Xform with
  its transform that references it, with `orientation = "leftHanded"` for mirrored nodes. It changes the archive's
  layout, so it waits for the Quick Look check of the entry at the top of this page.

### Morph targets: CPU per Animation per frame

- **What:** `p-morph`, 100 MorphStressTest copies with 8 weights each changing every frame: 0.52 ms CPU a frame
  against three's WebGL 0.27 (run `20261027-032923`). The GPU half of this entry is fixed (perf-history entry 34:
  1.33 -> 0.19 ms, one dispatch per buffer page and pipeline instead of 200); what is left on the GPU is the 0.05 ms
  deform pass, an accepted difference in work recorded in the matrix row 12.5.
- **Cause (not profiled yet):** the CPU time did not move with the batching (0.51 before, 0.52 after), so it sits in
  the 100 Animations' per-frame work: each one's checks, weight writes and uploads, and the per-model draw records.
- **Plan:** take a browser CPU profile of a `p-morph` frame, then write the weights of every Animation of a device
  in one upload (the weights already sit in one shared buffer per page) and skip per-Animation work for models whose
  inputs did not change.

### cloneModel: two engine-wide ticks per copy

- **What:** `p-skeleton-clone`, 50 `cloneModel` copies of RobotExpressive per call (the call also destroys the
  previous 50): 17.6 ms against three's `SkeletonUtils.clone` 7.8 ms (84.5 before entry 28, 63.6 before entry 29, 47.9
  before entry 32).
- **Cause (measured, CPU profile of the call):** `PBRModel.installBatches` runs `store.tick(false)` before and after
  baking the static parts, and a tick runs every mesh of the engine, so 50 copies cost 100 ticks over a growing
  scene (about 6.5 ms); then each copy's material uniforms and bind groups (about 3 ms) and core node creation
  (about 2.5 ms). three's clone creates objects only. Fixed so far: repacked vertices (entry 28), core `Engine.remove`
  (entry 29), per-copy GPU buffers, baked arrays, views and samplers (entry 32).
- **Plan:** bake the static batches of models set up in one go after one tick (for example on the first frame or
  CPU read that needs them) instead of two ticks per model. Skipping a tick alone breaks draws made before the next
  one: skipping the first for a model with nothing to bake left its node matrices unpublished
  (`packages/gltf-pro/tests/model-runs.test.js` caught it), and the second publishes the batch nodes'.

### GPU picking waits for one readback per pick

- **What:** `p-gpu-pick`, 100 `engine.pick` calls: 325 ms against three's WebGL 61 ms (407 before entry 29; three's
  WebGPU backend takes 423 ms).
- **Cause (measured, CPU profile):** 0.15 ms of JavaScript a pick; the main thread is idle the rest of the 3.25 ms,
  waiting for the pick's GPU pass and its `mapAsync` readback. `engine.pick` answers overlapping calls one at a time by
  contract, each reading the scene as it is when its turn comes, so 100 picks wait for 100 round trips. three's WebGL
  `readRenderTargetPixels` is a synchronous `readPixels`. Entry 29 removed the per-pick shader compile and pipeline
  and the full instance upload.
- **Plan:** a batch query that answers many points from one ID pass and one readback (an optional package, or a core
  change once core has bytes for it: core is at 20,479 of its 20,480 B cap). Changing `engine.pick` to start queued
  picks before the previous readback would break its documented turn order.

### SciFiHelmet: default soft shadows cost the GPU time

- **What:** `helmet`: 0.78 ms GPU a frame against three's WebGL 0.09 (CPU 0.11 against 0.07).
- **Cause (measured, timestamps per pass with each feature switched off, entry 30):** image-based lighting costs
  nothing measurable. `Shadows`' default `'soft'` filter (PCSS: 16 blocker reads and 32 comparison taps per lit pixel,
  spread over a penumbra up to a tenth of the map) is 0.68 of the 0.78 ms; with
  `'pcf'` the same frame takes 0.12 ms, and with `'pcf'` and one cascade, the setup closest to three's one
  PCFSoftShadowMap, 0.08 ms (`helmet-filterpcf-cascades1`, same image: SSIM 0.984). The CPU gap (0.11 against 0.07)
  is spread over the frame's four passes.
- **Plan:** a cheaper soft filter with the same look: blocker search with `textureGather` on fewer, nearer taps and a
  penumbra radius capped in texels rather than map fractions. It changes the image, so the shadow views of the
  visual check are re-recorded with it.

## Unverified against the specification

### IGES parametric spline surface (entity 114): coefficient order not checked

- **What:** `igesToSTEP` and `parseIGES` in `@margoengine/brep` (`packages/brep/src/iges/step.ts`) refuse entity 114
  with `MargoError` code `unsupported`; a file holding other surfaces converts with the 114 left out and named in
  `warnings`.
- **Why:** the IGES 5.3 specification (US PRO/IPO-100-1996) gives the 114 bicubic patch polynomial only as a formula
  image, which could not be viewed when the reader was written. The order of the 16 coefficients per coordinate
  (48 per patch: x, then y, then z, named A to S) was taken from memory, not the text, so it was not shipped.
- **Needed to close:**
  1. Read the specification's section on entity 114 (section 4.15, "Parametric Spline Surface Entity"; the request
     that opened this item said 4.25, which is the Offset Curve Entity) and its Appendix B.5, and write down the
     formula image: which power of s = u - TU(i) and t = v - TV(j) each of the 16 coefficients multiplies.
  2. Confirm or correct the assumed order 1, s, s^2, s^3, t, s t, s^2 t, s^3 t, t^2, ..., s^3 t^3, and confirm the
     patch order (u patches outer, with the (N + 1)-th placeholder column per row).
  3. Restore the power-to-Bezier conversion of each patch into one B-spline surface (knots at the breakpoints with
     multiplicity 3) and enable the 114 case.
  4. Test against an analytic bicubic with cross terms (for example x = s, y = t, z = s^2 t^3 over two patches each
     way), comparing sampled points and the meshed area with the exact values, and replace the refusal test in
     `packages/brep/tests/iges.test.js`.

## Shadows

### Speckled shading on lit faces of a skinned model with default shadow settings

- **What:** with `Shadows.attach(engine, { resolution: 2048 })` and the default `'soft'` filter, the upper torso and
  head of RobotExpressive show a fine pattern of dark dots on faces that face the sun, and the soft edge of the ground
  shadow looks dotted instead of smooth. It is visible in `docs/images/guide-animation.webp` and, faintly, at the foot
  of the crate in `docs/images/quickstart.webp`.
- **Repro:** follow [the animation guide](guides/animation.md) (or `npm run test:docs:browser` with
  `DOCS_SCREENSHOTS=1`) and look at the robot's chest.
- **Cause:** not found. The dots are not penumbra (they sit on lit faces), so receiver-plane bias or the cascade
  selection on a low-poly skinned mesh is the first suspect; the noise term in the PCSS filter (documented in the
  shadows README) shows it up.
- **Needed to close:** a pixel test of a lit, sun-facing plane and a skinned low-poly mesh with the default settings that
  fails while any lit pixel is shadowed, then the fix in `@margoengine/shadows`.
- **Update 2026-10-27 (found while timing the quickstart):** the README quickstart's sun pointed away from the camera, so its
  shadow was hidden behind the ball; the README now aims the sun so the shadow shows, and with it the whole umbra of the
  ball and crate on the floor shows white speckle (about a third of the pixels lit inside a solid shadow, on a floor that
  is not a caster either). `Shadows.attach(engine, { filter: 'pcf' })` gives a clean shadow in the same scene;
  a larger `normalBias` (0.05) does not change the speckle. So the fault is in the `'soft'` (PCSS) path of
  `packages/shadows/src/shader.ts`, not in cascade selection or receiver bias alone. First suspect: the receiver-plane
  term `dot(offset, slope)` added to the compared depth in the 32-tap loop, which can pull a tap in front of the blocker
  when the sun is low. This needs a stronger-model bug hunt; `npm run check:quickstart` shows it in
  `test-results/quickstart-timing/shipped.png`.
