# Known bugs and unverified features

What is known to be wrong or not yet proven, and what it would take to close each item. Design limits (where a
boundary is a decision, with its escape hatch) live in [limits.md](limits.md); this page lists defects and checks that
are still open.

## React

### The development hints of @margoengine/react stay off under the Vite dev server

- **What:** the hints for lowercase React Three Fiber tags and for pointer handlers on WebGL2 never print on a page served by Vite.
- **Cause:** their guard, `typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'` in
  `packages/react/src/components.tsx`, needs a global `process`. Vite replaces only the member expression and the page has no
  `process`, so the guard is false. Found when `<DevTools>` used the same guard in `scripts/test-extras-browser.js`: no name arrived.
- **Repro:** `npm run test:browser:extras -w @margoengine/react` serves through Vite; render `<mesh />` in
  `tests/extras-browser.tsx` and no hint prints. `tests/dev-hints.test.js` passes because Node has `process`.
- **To close:** a guard that also holds under Vite and still lets a production bundle drop the hints, with a browser test.

## Boulder demo

### The robot's arm shows a copper piston through its shell at close range

- **What:** in the Boulder demo, from the nearest orbit distance (1.2 m), a copper rod shows through the upper arm shell
  and the shell has a jagged edge near the elbow. It does not show from the default view, and it does not affect the
  collision results, which use the link hulls.
- **Repro:** `npm run build:boulder`, then `node scripts/test-boulder-browser.mjs --shots=<dir> --closeups`, and open
  `boulder-high-close-right.png` and `boulder-high-close-left.png`.
- **Cause, not yet confirmed:** the piston, washers and hubs in `examples/assets/source/skinning_ik/build_robot.py` are
  not in its `NO_CROSSING` list, so the crossing check in that script does not see them.
- **Needed to close:** decide whether this model stays. If it does, add those parts to `NO_CROSSING`, fix what the check
  then reports and rebuild the GLB. If another model replaces it, this entry goes with the old model.

## Package test scripts

### Fourteen packages' own `npm test` misses some of their test files

- **What:** animation, audio, clustered, creative, culling, decoders, environment, ifc, lines, loaders, materials,
  physics, points and splats name test files in their `test` script, so a file added later runs only in the root
  `test:all`.
- **Repro:** `node --test tests/package-test-scripts.test.js`; `STILL_MISSING_FILES` there is the list and only shrinks.
- **Cause:** the scripts list files by name instead of `tests/*.test.js`.
- **Needed to close:** change each script to the glob and make every newly run file pass, then take the package off the
  list. `exporters` is done.

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

### Intel Arc 140V: three GPU-suite failures fixed on this PC and rechecked on Intel by the outside audit

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
- **Rechecked on Intel by the outside audit of 2026-10-28** (a second Intel Arc 140V laptop; the audit is the source
  for this paragraph): the compute spec-math case, the voxel normal and slow-compile cases and the voxel-pathtracer
  spec-math fisheye case all passed. The audit does not say whether the three fixes above (the precise maths, the
  `pending` count and the precise fisheye rays) were what changed them, and it reports no per-function bounds.
- **Not verified:** the precise functions' error bounds on the Intel compiler (`compute-browser.json` from an Intel
  PC), which no recheck has recorded.
- **Needed to close:** the `compute-browser.json` precise-maths results from an Intel PC, then this entry removed or
  turned into the cause found.

### Intel Arc 140V: voxel-pathtracer `denoise` case ran out of time with no output

- **What:** on the Intel Arc 140V laptop, `voxel-pathtracer test:gpu` finished every case before `denoise`, which started
  at about 172 s and printed nothing until the test runner killed the suite at 900 s (`HUNG: no result after 900 s`).
  The cases after it never ran there.
- **Measured on the RTX A6000** (shared GPU, 2026-10-29): the case renders six 480 x 300 references at 16384 samples
  and took 196 s (diffuse 14, opaque 15, materials 82, caustics 85); the longest wait for any GPU work to finish was
  1 s. The Arc ran `convergence` in 61.3 s against 13.1 s here (4.7 times slower), which puts `denoise` near 915 s there,
  more than the 728 s it had. Most likely cause: the case was simply longer than the time limit. A GPU wait that never
  resolves is not ruled out without an Arc run.
- **Done:** each scene is its own case (`denoise-diffuse`, `denoise-opaque`, `denoise-materials`,
  `denoise-caustics`; `denoise` runs all four). Every render prints a
  `progress denoise <scene>: ...` line. A case in which no GPU work finishes for `MARGO_GPU_STALL_S` (120 s) now fails
  at once, naming the case, the step and the render (`tests/progress.mjs`). Each case prints its time and its longest GPU
  wait. Regression test: `voxel-pathtracer test:gpu:stall` (`tests/stall-check.mjs`) hangs every GPU wait once the
  first render starts and expects that named failure. It fails in 17 s with the watchdog; without it the run has not
  ended at the 180 s limit.
- **Measured again on the Arc** (origin/main cb42459a, mains, Edge 156): `test:gpu` still hit its 900 s limit with no
  `GPU stall` line, so the GPU kept finishing work: the denoise references started at 147 s (diffuse), 242 s
  (opaque), 327 s (materials) and 748 s (caustics), and the caustics case was still running at 898 s. Slow, not hung.
  `denoisepeak`, `denoisehistory`, `lens`, `viewport`, `capture`, `materialtables`, `largemodels` and `native4k`
  never ran there.
- **Done (split, 2026-10-30):** the check runs as five package scripts that name their cases, each with its own limit
  in `margo.gpuTestTimeoutMinutes`; same cases, samples and tolerances. A6000 time, Arc estimate (from the run above),
  limit: `test:gpu` (agx to convergence) 57 s, about 150 s, 10 min; `test:gpu:denoise` (diffuse, opaque, denoisepeak,
  denoisehistory) 46 s, about 240 s, 10 min; `test:gpu:denoise-materials` 99 s, about 450 s, 15 min;
  `test:gpu:denoise-caustics` 109 s, about 500 s, 15 min; `test:gpu:viewport` (motion, lens, viewport, bloom, capture,
  materialtables, largemodels, native4k) 36 s, about 200 s, 10 min. `tests/voxel-pathtracer-gpu-split.test.js` fails
  if a split script is missing, if their cases are not exactly the check's case list (each once), if a script runs the
  whole check with no case named, or if check:merge would not run one when the package is affected. An unknown case
  name now fails the browser check instead of running nothing.
- **Needed to close:** run the five split scripts above on the Arc. If each passes
  inside its limit, remove this entry. If one stops with `GPU stall`, the message names the render to hunt.

### Linux (Intel UHD, Mesa): three GPU suites not finished

- **What:** on the Ubuntu test server (Intel N100 with Intel UHD, Chromium on Mesa's Vulkan driver, Node 24, main
  b92998d6, 2026-10-28) 42 of the 43 package GPU suites were started, one at a time, and 38 passed. The voxel, voxel
  path tracer and root browser suites were stopped by the heat watchdog at 82 C before they finished, so they have no
  Linux result yet. The text failure of the same run is the colour emoji entry below.
- **Needed to close:** those three suites run to the end on Linux, on a machine that stays cool under a long GPU
  run, and the results recorded here.

## Open defects

### The frame-budget step fails on the gameplay sandbox (WebGL2 layer, CPU tier)

- **What:** `npm run visual:compat:budget` fails since 974a2a48c, which times gameplay-sandbox while it runs (it stops
  drawing under reduced motion; before, a missing median passed without a check): 2,403 ms a frame on the layer against
  0.8 ms native, budget 50 ms (RTX A6000, Edge 156). windy-meadow, timed the same way, passes at 22.3 ms.
- **Repro:** `npm run visual:compat:budget -- --only=gameplay-sandbox`.
- **Cause:** the VFX and scatter kernels of the sandbox use atomics, which the layer runs on the CPU tier.
- **Needed to close:** layer routes for the VFX and scatter prefix counts (a branch with an unchecked start exists,
  `sandbox-compat-routes`, 27aa6aff5). Parked by Scott with the sandbox's speed; no budget was raised and no step skipped.

### `KHR_materials_specular` weight does not scale Fresnel at grazing angles on gltf-pro's native paths

- **What:** the spec's Fresnel is `specular * (f0 + (1 - f0) * (1 - v.h)^5)`, so `specularFactor` 0 reflects nothing at any
  angle, and the base is weighted by `1 - specular * max(F)`, one number for all channels. gltf-pro's native physical
  shader and the `Transmission` pass multiply only F0 by the weight (`s.f0`), keep F90 at 1, and subtract F per channel.
- **Measured (`Transmission` pass, white glass, unlit, n.v 0.25, 2026-10-31):** specular 0 passes 0.76 of the light
  behind, the spec gives 1.0; specular 0.5 passes 0.75, the spec 0.87. Colour [2,1,1] at normal incidence passes
  (0.92, 0.96, 0.96), the spec 0.92 in all channels. Normal incidence with white specular is right.
- **Repro:** a material with `KHR_materials_specular: {specularFactor: 0}` through `Transmission.add(model)`; for the
  reflection, the same material lit at a grazing view through `loadGLTF`.
- **Cause:** `s.f0=min(ior*ior*color,1)*weight` in `physicalEdits` (`packages/gltf-pro/src/shader.ts`), used by
  `direct_light` and `margoTransmission` (`packages/materials/src/transmission-pass.ts`), and the split-sum ambient in
  `environment`, `sky` and `clustered`, which all take F90 = 1. The fix needs a surface F90 through those packages.
  The materials `install` lobes and the native tint draw already follow the spec, so on the native tint path a surface with
  specular 0 passes all the light behind and still reflects at grazing angles until this is fixed.

### gltf-pro's native tint draw reads factors, never maps

- **What:** transmitted light on the default path (no `install`, no `Transmission`) is a multiply draw that binds no
  textures. It reads the sheen, specular and clearcoat factors, not their maps, and has never read the base colour or
  transmission maps. `metallicFactor` is left out altogether: the default is 1 with the real value in a map, and reading
  it turned FlightHelmet's lenses black. So a metal factor below 1 does not dim the light behind on this path (spec:
  `1 - metal`), and a sheen factor of 1 with a dark map dims as if the map were white. Iridescence does not reach it.
- **Repro:** a glass material with `KHR_materials_transmission.transmissionTexture` black on half its area through
  `loadGLTF`: the whole surface passes the light behind. The two other paths honour it.
- **Cause:** `tintEntry` in `packages/gltf-pro/src/shader.ts`, drawn with group 0 only (`frameGroup`). The fix is a tint
  read from the full surface (`createDrawGroups`, as `texturedTint` does), with the volume attenuation apart from the base
  colour in the uniform; it costs a second textured fragment pass on every native glass surface.

### Clearcoat does not dim the opaque base under it through materials `install`

- **What:** the spec's coated material is `mix(material, clearcoat_brdf, clearcoat * F)`, so the base keeps
  `1 - clearcoat * F`. `clearcoatShader`'s `direct` hook only adds the coat (`direct+=materialClearcoat`), and no ambient
  term exists. Transmitted light under the coat is right since `materialCoatKeep` (2026-10-31); opaque lit light is not.
- **Size:** with clearcoat 1 the base should read 0.96 of itself at normal incidence and 0.73 at n.v 0.25.
- **Repro:** `install(model)` on an opaque `KHR_materials_clearcoat` material, against the same model through gltf-pro's
  native `layers()`, which does scale it.
- **Cause:** `packages/materials/src/shader.ts`. The fix is `direct=direct*materialCoatKeep+materialClearcoat` plus a coat
  ambient term; it moves the clearcoat baselines, so it was left for its own change.

### Display-encoded targets add transmitted and lit light in encoded values

- **What:** without an HDR scene target (`f.settings.w` below 0.5), the lit colour and the transmitted light are both
  display-encoded when they are added: `color+...` in `materialTransmission`, and the lit draw's blend over the tint on
  the native path. Light adds in linear values, so bright highlights over bright backgrounds come out too bright.
- **Size:** encoded 0.5 + 0.5 reads 1.0; adding in linear light reads 0.69. The share itself is linear since 2026-10-31.
- **Repro:** glass with a strong highlight over a bright background, on a target with no PostStack, against the same
  scene with `Tonemap`.
- **Cause:** the tone map and encoding run before the `output` hook; the extension path could decode and re-encode, the
  native path's second draw cannot without a scene copy. Also, the native tint encodes the share and multiplies, which
  is exact only for a power curve: within 1 step above about 40 of 255, up to 2 steps below it.

### Findings of the outside audit (2026-10-28)

- **What:** an outside audit of revision 74a01810 (a source review, canary tests on a second laptop with temporary
  files, mock fetches, fake sockets and loopback servers only, a full verify that passed 6,344 of 6,346 tests with 2
  skipped, a short fuzz run over 36 targets and GPU checks) reported 20 findings, F01 to F20, about input handling,
  the converter command line, the network servers and one slow decoder input. The audit marks each as reproduced, code
  confirmed or project documented, and states its own limits: a short fuzz run, local canaries only, no production
  test, and a passing verify does not show there are no bugs.
- **Status on main (2026-10-28):** 16 of the 20 are fixed with regression tests (F01 to F07 and F11 to
  F19; classes, commits and tests in
  [whitepaper/perf-history.md](whitepaper/perf-history.md#44-an-outside-audit) and the table at the end of this page).
  F20 is being fixed; its details are published once the fix is on main.
- **netcode room server limits (F08, F09, F10): fixed.** `RoomServer` has `joinTimeout`, `maxConnections`,
  `maxRooms` and per-client message rates, and room timers that throw no longer throw uncaught (`92b7c5ba`, bug 50;
  tests in `packages/netcode/tests/rooms.test.js`). The low-level `listenWebSocket` of `@margoengine/netcode/node` had
  none of them (audit E-02, bug 67); it now has the same kind of defaults: own-host `origins` (`'*'` opts out),
  `maxConnections` (1,024) and `firstMessageTimeout` (10 s), with tests in `packages/netcode/tests/transports.test.js`.
  Authentication and network-level denial of service (a flood below the TCP layer) are still the application's.
- **Needed to close:** F20 fixed with a regression test that fails without it.

### The exporters USDZ timing test can still fail when every core is busy allocating

- **What:** `packages/exporters/tests/exporters.test.js` "numbers are written as the shortest text ... (and fast:
  p-export-usdz)" asserts that a whole `exportUSDZ` of 1,000 boxes is faster than the old digit-by-digit number search
  alone. Alone it is about 20 against 48 ms. It failed once in a `check:merge` verify on 2026-10-28 (66.9 against
  64.4 ms) while other checks ran on the machine.
- **Done:** the two jobs now take turns for nine rounds and each keeps its best round, so a burst of load falls on
  both. With 32 processes allocating memory on all 32 hardware threads, the old timing failed 4 of 6 runs and the new
  one 1 of 6; with 8 such processes (the verify's own concurrency) both passed 8 of 8.
- **Cause of what is left:** the export allocates strings and buffers and the old search barely does, so when memory
  bandwidth is saturated the export slows more than the search, and the comparison flips.
- **Fix needed:** compare work with the same allocation profile (the new number writer against the old search, both
  producing the same strings, with the whole-export time kept as a separate check against a recorded budget), and
  show it holds with all cores allocating.

### text: the colour emoji check needs a colour emoji font on the machine

- **Repro:** `npm run test:browser --workspace @margoengine/text` on a Linux machine with no colour emoji font
  installed (the Ubuntu test server, 2026-10-28) fails "Emoji not drawn in color" (`colorGlyphs` 0) at
  `packages/text/tests/text-browser.js`.
- **Cause:** the check draws an emoji through the system's fonts, so its result depends on the machine. Windows has a
  colour emoji font; a headless Linux server often has none. The engine draws what the system font gives it.
- **Fix needed:** the test brings its own colour glyph source (a standard emoji font file recorded with its source and
  licence in `THIRD-PARTY-NOTICES.md`, or a test font), or it detects that no colour font exists and says so with a
  clear skip message; either with a test that the check fails when colour glyphs are not drawn although a colour
  font is present.


### biomes test:gpu on the Intel Arc laptop: every check OK, then killed at 600 s (not reproduced)

- **Repro:** on the Intel laptop (Arc 140V) at 6a8607de, `biomes test:gpu` in the GPU package tests printed all three
  checks OK (view; objects 172569; flythrough p99 +0.00 ms) and then "HUNG: no result after 600 s, process tree
  killed". Not seen on the RTX A6000 PC; the laptop reruns it 3 times.
- **Measured here** (RTX A6000, 9950X, one run in a shared GPU slot): the chain takes 431.5 s of its 600 s limit
  (view 2.8 s, objects 14.9 s, flythrough 413.7 s, of it the six timed flights 298 s); the flythrough's close took
  0.2 s. Earlier check:merge runs here: 326 to 431 s.
- **Two causes fit; which one is not known yet:**
  1. A teardown wait with no limit: `close()` in `scripts/browser.js` waited for the WGSL compilation reports with a
     bare `page.evaluate`, which never times out, so a `getCompilationInfo` the GPU process never answered (Arc has
     WebGPU promises that never settle, see the startup-hang fix) or a page that never answered held the suite
     silently. Fixed: `settleWgslReports` (`scripts/support/wgsl-guard.js`) fails within 30 s naming the modules
     still waiting, or the page; and the biomes checks call `watchExit` (`scripts/support/shutdown.mjs`), which names
     what is still open (`process.getActiveResourcesInfo()`) and exits 1 when a finished suite does not end within
     30 s. Tests: `tests/wgsl-guard.test.js`, `tests/shutdown.test.js`.
  2. The chain is near its limit: the whole `test:gpu` (three checks) is one step with the default 10 min limit, and
     on the fastest PC it already takes 72 percent of it; the flights run in real time, but world creation, prefetch
     and idle waits scale with the CPU, so on the laptop the chain can reach 600 s right as the flythrough ends.
- **Needed to close:** the laptop's three reruns at the commit that carries the fix above. A `SHUTDOWN_TIMEOUT` or
  "did not exit" message names the stuck handle (cause 1, fix it there). A kill with no such message is cause 2: the
  step's wall time (gpu-packages.json `seconds`, and the time the flythrough's OK line printed) decides between
  splitting the chain into one step per check and a measured `margo.gpuTestTimeoutMinutes` for biomes, which is
  Scott's call.
- **Since 2026-10-30:** the chain is split, one step per check (`test:gpu` view, `test:gpu:objects`,
  `test:gpu:flythrough`), each with its own 10 min limit; the flythrough, a timing test, runs last under the exclusive
  GPU lock (it failed at +2.6 ms worst frame in a shared slot beside other suites). A failed check exits at once with
  its own error (`runSuite`, `scripts/support/shutdown.mjs`), its teardown bounded and printed beside it: the laptop's
  3 kills at 8bd1fb40 came after 'packing:', which fits an assertion that failed there and then the unbounded WGSL wait
  in close() (cause 1). Open then: the laptop's slow sends check (one frame with 2 ms sends: 5.8 ms seen once
  standalone, limit 3.5 ms, 2.3 to 2.4 ms before); not loosened. See the slow sends bullet below.
- **Since 2026-10-30 (Scott's ruling):** the flythrough step has a 750 s (12.5 min) limit, set per script in
  `packages/biomes/package.json` (`"margo": { "gpuTestTimeoutMinutes": { "test:gpu:flythrough": 12.5 } }`, read by
  `packageMinutes` in `scripts/support/run-limited.mjs`); the view and objects steps keep 600 s. Test:
  `tests/gpu-timing-lock.test.js`.
- **The slow sends frame (cause found for one frame, the rest not proven):** the laptop's 4.0, 5.6 and 5.8 ms frames
  (limit 3.5 ms: a 2 ms send plus 1.5 ms) came from the check before 2bb1ab52f, which timed the view's frame on the wall
  clock with the check's own busy waits inside it. The laptop's trace of the 4.0 ms frame (flight 6, frame 77) shows
  the page thread stopped 2.9 ms inside the wait that stands for a 16 kB r32float write's cost, with no garbage
  collection, compile or task on the thread; the real write took 0.1 ms or less. Since 2bb1ab52f the waits run on
  `tests/flythrough-clock.mjs`, which leaves out time the thread did not run inside them and still counts a stop in the
  view's code or a slow real call (`tests/flythrough-clock.test.js` fails against the old wait); the limit is
  unchanged. The 5.6 and 5.8 ms frames had no trace. Read at 72de6c42, the view cannot spend more than one send or one
  copy step begun inside its 0.25 ms budget in a frame, plus the plan: each send step posts once (the overview job per
  worker starts all 4 workers at attach, so no send in a flight starts a worker, which would post twice), a send starts
  only on budget that covers the last send's cost, and terrain goes in 16 kB bands, never a whole 200 kB tile. That
  fits the 2.3 to 2.4 ms of the other runs, so the 5.8 ms frame was most likely the same kind of stop. Not proven: the
  A6000 PC has never shown it.
- **Needed to close:** on the laptop, at a commit that has the worst-frame report (the commit after 72de6c42 that adds
  this bullet), run `npm run test:gpu:flythrough --workspace @margoengine/biomes` (it takes the exclusive GPU lock) 3
  times. The `slow sends worst frame:` line takes the slowest frame apart: view time, clock time, time not run inside
  the waits, sends, texture writes and kB, and the time in the real postMessage and writeTexture calls. 3 passes:
  remove this entry. A failure names its owner: 2 or more sends, or about 200 kB of writes, in that frame is the view's
  scheduling (`#apply` in `src/view.ts`); most of it in the real calls is the browser or the Arc driver (still counted,
  hunt it there); neither is the view's own code.
- **Since 2026-11-05 (bounded without a GPU run, Scott: no GPU checks now):** `packages/biomes/tests/gpu-chain-bound.test.js`
  pins the structure that keeps a stuck check from hiding: every biomes GPU step has a limit above its A6000 time with a
  1.4x margin, none chains more than two check files (the timing test runs alone), and every check file ends through
  `runSuite` and `watchExit`. The kill itself is still not reproduced; the laptop reruns of the first **Needed to close** above still close the entry.

### GPU resets during busy check:merge runs on the RTX A6000 PC (nvlddmkm event 153)

- **What:** the Windows System log shows nine `nvlddmkm` event 153 entries ("Error occurred on GPUID: 100") on
  2026-10-27 and 28: 07:42:55, 08:18:47, 08:58:27, 09:37:03, 09:53:29, 22:45:31, 22:45:39, 01:21:49 and 01:41:02,
  each while two or three `check:merge` runs shared the GPU (NVIDIA RTX A6000, driver 617.42, hardware-accelerated GPU
  scheduling on, Edge 156 headless). Each took the WebGPU device of one page, and a page asking for a device just then
  was refused: sciviz at 01:21:47 failed its first `requestDevice` with "D3D12 create command queue failed with
  E_OUTOFMEMORY (0x8007000E)" with 2 of 48 GB in use, so the failing test is the casualty, not the cause.
- **Two kinds of reset, told apart by measurement (2026-10-28):** a Windows watchdog reset (TDR) of one GPU engine
  writes a WER `LiveKernelEvent` 141 report and a `WATCHDOG-*.dmp`; event 153 comes with none, so it is the NVIDIA
  driver's own reset, not the Windows 2 s watchdog. A deliberate 3 s compute dispatch on the A6000 gives exactly the
  first kind (141 at 02:08 and 03:11) and no event 153, so our long dispatches are not what makes 153. Nine 141
  reports from 19:27 to 23:04 on 10-27 came while Edge ran on the AMD integrated GPU (bug 33; at 23:04 the path tracer's
  spec-math suite was on `amd` and lost its device), which is slow enough for our bigger dispatches to pass 2 s.
- **Not the trigger (each run under the GPU lock, with a watcher sampling every second):** killing the browser's GPU
  process in the middle of a 0.6 s dispatch (15 times) or the whole browser tree (15 times); CDP
  `Browser.crashGpuProcess` mid-work beside a second busy browser (12 times, the lifecycle test's crash); 300 device
  create and destroy cycles; 6 browsers with back-to-back dispatches for 90 s; one 0.4, 0.8, 1.0 or 1.4 s compute or
  draw submission at a time against 2 or 3 other browsers (the A6000 runs each submission to the end before another
  process's, so a short one waits the whole long one, but nothing resets); `test:lifecycle:browser` beside sciviz, 10
  rounds; two whole `check:gpu-packages` runs and four `visual:check` runs beside other agents' checks (03:00 to 03:10).
- **Best evidence so far:** eight of the nine came while Scott's Remote Desktop session was connected (07:14 to 14:42,
  21:11 to 22:59, 01:20 to 01:22; the 01:21:49 reset 17 s before a disconnect); while it is connected the A6000 also
  draws that session's desktop (it is DXGI adapter 0 only then, bug 33). With the session disconnected, 0 resets in about 90 minutes of the heavier load above. The
  01:41:02 reset is the exception (disconnected). The morning ones came about every 40 minutes, the length of one
  check:merge run, while the path tracer still traced a whole frame in one dispatch (fixed 49dca9dd at 11:07).
- **Also found:** a watchdog reset of one engine (141) cuts that submission short and WebGPU does not lose the device:
  `onSubmittedWorkDone` resolved at 2.3 s for a 3 s dispatch, a later dispatch and a new device worked, so the page got
  wrong results with no error. Only the event log shows it, which is why the checks read it (below).
- **What is done:** a page whose device is lost (any reason but `destroy()`), or whose `requestDevice` the driver
  refuses, fails its next wait at once, and the message names the reset from the Windows event log (for example
  "nvlddmkm event 153 at 01:21:49") or says that none was logged (`scripts/support/device-loss.js`,
  `scripts/support/driver-resets.mjs`). A `check:gpu-packages` test, or any other `check:merge` step, that fails while
  the log shows a GPU driver reset runs once more; the reset and the rerun are printed and kept in
  `test-results/gpu-packages.json` and `test-results/check-merge.json`, and a second failure fails the check. A run
  that passed only on such a rerun ends with a "PASSED WITH A DRIVER RESET: <step>, <reset and time>" line per step
  and sets `passedAfterDriverReset: true` at the top of both files, so it never reads like a clean pass. The path
  tracer viewport traces at most 2^20 paths a dispatch (`packages/voxel-pathtracer/src/dispatch.ts`).
- **Needed to close:** run the checks with the Remote Desktop session disconnected (or with Remote Desktop not using the
  GPU) for a day and count resets; if 153 still comes, a per-second recorder (GPU engine use and memory per process,
  Edge GPU processes, lock holders, running tests; kept with the private notes) saves the 150 s before it, and the
  NVIDIA driver is the next suspect (update it, or try with hardware-accelerated GPU scheduling off).

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
- **Second Intel Arc 140V** (an outside audit's laptop, revision 74a01810, 2026-10-28): the same 450-frame repro
  differed on 4 frames (46, 99, 112 and 326), at the same pixel (101, 72), [109, 107, 104] instead of [100, 99, 96], 9
  of 255. The standard voxel check passed there.
- **Cause of the Arc's pixel (101, 72): below Margo, in the Arc's 4x MSAA blending (traced 2026-10-30, Arc 140V,
  driver 32.0.101.8860, Edge 156.0.4314.50, main c041238b).** Only sample 0 of that pixel goes wrong, only in the voxel
  translucent pass, always to 99.96.92 instead of 65.63.62 (samples 1 to 3 stay 112.111.108; the clear, the opaque pass
  and every queue write are the same each frame). Four glass faces cover the pixel, in draw order: the back face of
  block (22, 16, 10) on samples 2 and 3, the top face of that block on sample 0 alone, the back face of block
  (21, 16, 10) on sample 1 and the front face of block 21 on all four. 99.96.92 is, to within rounding in all three
  channels, the top face blended over the back face's colour (121.118.111) instead of over the clear colour: sample 0
  takes the destination of samples 2 and 3, which no per-sample blend can do. Each face alone, and the four together
  (as their own draws), drew the same samples 1000 times in 1000; the whole translucent layer (55 quads, as one draw
  or as 55) gave the wrong sample 0 in 7 and 8 frames of 1000. One frame of the view recorded (every WebGPU object
  with its descriptor, shader text and bytes, and the frame's calls) and replayed on a fresh device with no Margo code
  gave it in 4 of 1000 frames, and in 8 of 1000 with the opaque pass's draws left out, so it needs no Margo code and
  no opaque content. A synthetic page (in every pixel one blended triangle on samples 2 and 3, then one on sample 0)
  stayed exact on the Arc in 9 layouts and orders; what more of the real layer it needs is not known.
- **Repro of the Arc case:** `node scripts/gpu-lock.mjs run --owner=<you> -- node
  packages/voxel/tests/render-browser-check.mjs --replay=1000` records the still view's frame
  (`scripts/support/webgpu-trace.js`) and replays it in `scripts/support/webgpu-replay.html` under CPU load; it fails
  when any replayed frame's samples at (101, 72) differ, after checking that the replay reproduces the live frame
  (`--skip=1` drops the opaque pass's draws). On the RTX A6000 the same command shows NVIDIA's fault below (all four
  samples set to their average, about 1 frame in 300).
- **Khronos ToyCar and IridescenceLamp** (gltf-pro transmission, `examples/khronos-gallery.html?model=Name`, native
  WebGPU, 640x480, 2026-10-30): four captures of the still frame differ on 67 to 153 pixels by 1 of 255 (ToyCar, all
  on the windscreen) and on 0 to 18 pixels by up to 28 of 255 (IridescenceLamp, the glass rim over the base). The page
  draws every animation frame; two calls of `engine.render()` in a row already differ.
- **Cause: below Margo, in the GPU's 4x MSAA blending (found 2026-10-30, RTX A6000, Edge 156, Dawn D3D12 and D3D11).**
  A blended draw over a pixel whose samples hold different colours sometimes writes one value to all four samples,
  about the average of the four correct per-sample results, and which pixels get it changes from frame to frame (in
  4x4 and 8x8 pixel blocks along the blended mesh's own edges). Measured in the ToyCar frame: the command stream is
  the same each frame (pipelines, bind groups, buffers, the two `writeBuffer` calls bit for bit), and the
  multisampled colour copied at the start of the glass pass is the same each frame, sample for sample. After the
  transmission tint draw alone (a constant colour, blend `dst x src`) pixel (360, 88), before it
  `[5e5854, 5e5854, 6b8068, 6b8068]`, holds `[1c4619, 1c4619, 20661f, 20661f]` in one frame (dst x constant per
  sample, correct) and `[1e561c, 1e561c, 1e561c, 1e561c]` in the next. No input can make a per-sample blend do that.
  The same happens in plain WebGPU with no Margo code: `scripts/support/msaa-blend-repeat.html` (a clear pass, an
  opaque pass of flat-coloured triangles, a coarse mesh blended `dst x constant`, a resolve pass) gives 11 of 12
  frames different after the blended pass, with 0 samples different before it. Without the glass draws, at 1x, or
  with the blended pipelines' sample mask leaving out any one sample (`mask: 7`, 11, 13 or 14) every frame is the
  same, in the plain page and in both Khronos models; the mask 15 (all four samples) still differs. The voxel
  findings above fit it: the pixels are blended glass over edges whose samples differ, a zero destination factor
  hides it, `max` blending does not.
- **Repro:** `node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/msaa-blend-repeat-check.mjs` (plain WebGPU,
  prints the first changed pixel with its samples before and after the blended pass; exit 1 when frames differ),
  `--mask=7` for the comparison, `--khronos` to also capture ToyCar and IridescenceLamp four times each (after
  `npm run build:packages`).
- **Three GPUs, same repro, Edge 156.0.4314.50, 2026-10-30:** RTX A6000 (driver 32.0.16.1742): 29 of 30 frames
  differ; Intel Arc 140V (driver 32.0.101.8860): 0 of 30, with `--mask=7` 0 of 30, ToyCar and IridescenceLamp 0 pixels
  in three captures; AMD Radeon 680M (driver 32.0.21030.2001): 0 of 30, 0 of 30, 0 pixels. So the plain-page blend
  noise is NVIDIA's (hardware or driver), not Dawn's or Chromium's. The Arc's voxel pixel (101, 72) is a different
  fault of the same kind (one sample takes another's destination), traced above with its own replay repro.
- **Khronos LightsPunctualLamp, the same fault traced to the arithmetic (RTX A6000, driver 32.0.16.1742, Edge
  156.0.4314.50, 2026-10-31):** the still frame changes on 3 to 26 pixels by up to 40 of 255 (usually (292, 160-162) by
  3), so `visual:compat` fails when two native captures catch different frames. One still frame recorded (every object,
  shader and byte) and replayed 1000 times in a new browser with no Margo code gave 12 distinct frames, 40 of 1000 unlike
  the most common one, whose pixels equal the live page's on all 640x480. Margo's inputs are therefore out: every frame clears
  colour and depth, samples only fixed textures (the default transmission path has no scene snapshot or mip chain), and
  has no validation errors. Left-out draws, 300 frames each: no glass draws 0; tint draw only, 32 frames (4 pixels, max 1);
  additive glass draw only, 78 (4 pixels, max 26); all draws 23 to 34. The whole frame rewritten to 1x: 0 of 500. Blended
  pipelines with `mask: 7` or 14: 0 of 300; `mask: 15`: 19 of 300. Hiding the transmission primitive or the point lights
  was measured live before this trace: 0 changing pixels, and no change. At (292, 160) the opaque samples are
  `149.150.149 | 77.80.87 | 157.162.161 | 77.80.87`, whose average is 115.118.121. The additive glass draw adds 81.68.63
  on samples 0 and 2, giving the correct `230.218.212` and `238.230.224`; in the faulty frames both hold `196.186.184`,
  exactly the average plus the source. So the blend reads the four samples' average as its destination and still applies each
  sample's source. On the Dawn D3D11 adapter (`--adapter=d3d11`) this pixel held 200 of 200, while 6 of 200 frames differed
  elsewhere. Not measured on another GPU, and Chromium's software adapter is not available on this PC (Edge and Chrome both
  report no adapter), so that it is NVIDIA's alone rests on the plain page's three-GPU row above.
- **Repro of the lamp:** `node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/msaa-blend-repeat-check.mjs
  --replay=LightsPunctualLamp --pixel=292,160 --replay-frames=1000` (after `npm run build:packages`); `--replay-mask=7`
  for the comparison.
- **Earlier notes on the voxel case:** every differing pixel is seen through
  the glass wall, along glass and terrain edges (pixels whose samples hold more than one surface). Between the frames
  nothing that Margo hands the GPU changes: no buffer write but the frame uniform and indirect arguments, bit for bit
  the same each frame; the glass quads in the same order. The frames stay identical at 1x, without the glass, with the
  glass drawn unblended, with blending on but the destination factor zero, with the glass drawn in the opaque pass,
  without core's mid-frame resolve and with Dawn's D3D12 render-pass toggle off; they still differ with `max`
  blending, which does not depend on order. Mesh arrival order is not involved: 168 permutations of the mesh replies
  drew the same pixels on a quiet machine.
- **What the checks do about it (Scott, 2026-10-26):** the voxel GPU checks allow a difference of at most 1 in 8 bits
  (1 half-float ulp on the rgba16float HDR scene) on views that blend a translucent layer at 4x MSAA, and nowhere else:
  1x views, views with no translucent layer, every other check and every other package stay exact. The rule is the named
  constant `BLENDED_4X_MAX_CHANNEL_DIFF` in `packages/voxel/tests/blend-tolerance.js`, unit-tested
  (`blend-tolerance.test.js`: 1 passes, 2 fails). The GPU check shows it cannot hide an ordering bug: the same two
  translucent panes in the other order differ by up to 132 of 255 (`swapped layer order` step), and the mesh arrival
  order step stays a pixel comparison with that tolerance only. The check's output prints the exact count next to the
  tolerant one, and `--repeat` reports both (it still fails on any exact difference: it is the repro).
- **Needed to close:** the plain-WebGPU page sent to NVIDIA (it repeats on no other GPU tested) and the recorded voxel
  frame with its replay page sent to Intel (Scott decides both), and their fixes or explanations recorded here; then
  the voxel tolerance can go (the Arc's 9 of 255 is over it, so the voxel checks can fail now and then on that laptop,
  as `--repeat` does there), and ToyCar and
  IridescenceLamp get an exact repeat-capture check, and LightsPunctualLamp's recorded exact still frame
  (`scripts/support/visual-compat-expected.json`) can hold on this GPU. Margo has no correct way around it: leaving a sample out of the
  blend, or drawing a full-screen layer first to change the GPU's tile state, changes or adds work to hide the
  symptom.

### Cut-outs on materials meshes: passes the shadow fix did not reach

Found while fixing shadow cut-outs (2026-10-31). Each comes from reading the code; none has been run as a repro yet.

- **Picking:** `PBRModel.pickingPrimitives` (gltf-pro) binds `r.views[0]`, the default white, so a click on a materials
  mesh's cut-out hole still hits it. Repro: `new PbrMaterial({map, alphaTest: 0.5})`, pick through a transparent texel.
  Fix: use `castMask` there too.
- **Contact shadows:** `@margoengine/staging` samples `alphaTexture` at the raw UVs (no `alphaTransform`, glTF
  `KHR_texture_transform` included) and ignores `opacity`. Repro: a cut-out with `uvTransform` or an `alphaMap`.
- **TAA velocity:** `@margoengine/taa` ignores a caster's `opacity`, so an `alphaMap` hole writes the quad's velocity.
- **`vertexColors: false`:** the colour pass reads vertex alpha as 1, but the caster depth shaders still multiply it in.
  Repro: geometry with RGBA colours below `alphaTest`, `vertexColors: false`: drawn, yet casts nothing.

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

### Precise maths: cost against the WGSL builtins not measured

- **What:** compute's element-wise functions and the path tracer's panorama and fisheye rays use the precise f32
  functions (`packages/shared/precise-math.js`), and since `b6bea3e9` every step whose rounding matters takes its
  operands through `pmHide` (four hides in the precise divide where the old code had one, more work in `pow`). Their
  GPU cost against the builtins (`createCompute({ fastMath: true })`) has never been measured.
- **Needed to close:** a measured GPU time for both, recorded as an accepted difference in work with a like-for-like
  `fastMath` row, in [whitepaper/perf-history.md](whitepaper/perf-history.md).

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
- **Since item 53.2 (2026-10-29):** `DynamicInstances` (@margoengine/culling/dynamic) takes 48-byte rows and a bulk
  path (write `matrices`, then `update(from, to)`; a non-finite row draws nothing instead of throwing). Like for like
  with three's `setMatrixAt` (same CPU matrix maths per box, rows copied unchecked): 0.90 against 0.91 ms at 10,000,
  6.67 against 6.11 ms at 100,000 and 16.2 against 15.7 ms at 250,000 (three.js WebGPU; numbers in
  [whitepaper/boxes-vs-threejs.md](whitepaper/boxes-vs-threejs.md), "Moving instances on the GPU"). The checked
  `setMatrixAt` stays about 15% over three at 100,000, the validation cost.

### DynamicInstances: about 25-35% more GPU time than InstancedMesh at 100,000 and 250,000 moving boxes

- **What:** `boxes-100000` moving, every box in view: GPU 1.55 ms against three.js WebGPU `InstancedMesh` 1.26 ms;
  at 250,000, 3.26 against 2.45 ms (busy machine, diagnostic; run `20261030-010010-28e2c5b8-dev` and a stopped run before it).
- **Cause (not yet split per pass):** `DynamicInstances` runs a compute pass three does not (each row's 96-byte core
  record built, frustum-tested and compacted in order, about 300 bytes of GPU memory traffic per instance), and three
  draws its instances with culling off. In a partial view the cull pays back (the pixel check's close view drew 204 of
  576 boxes). Part of it is overhead with no reason: every row's record is written twice (`world` for shadows and
  picking, then `drawn`), also when nothing reads `world`.
- **Plan:** write `world` only while a shadow source or a pick needs it, scatter from the rows instead; then measure the
  passes one by one with the harness's timestamps and publish before and after.

The two entries below come from the three.js speed matrix ([whitepaper/perf-vs-threejs.md](whitepaper/perf-vs-threejs.md),
rows 10.11 and 11.3; run `20261026-165034`, busy machine, diagnostic). Their first causes are fixed (perf-history entry
26); what is left is different work.

### STL import still computes normals three's STLLoader leaves zero

- **What:** `p-stl`, a 204,800-triangle binary STL: the plain `parseSTL` 4.9 ms against three's `STLLoader` 2.8 ms
  (run `20261026-201722`, busy machine, diagnostic). `parseSTL` changed in perf-history entry 31.
- **Cause (measured, Node CPU profile of `parseSTL`):** both readers copy the file's floats into one non-indexed
  buffer (614,400 vertices). This file stores zero facet normals, as most writers do. three copies the zeros;
  `parseSTL` computes the flat normal of each such facet (`flatNormal`, about 1.3 ms of its time in Node), writes an
  identity index array and zero-fills a third array.
- **Status: accepted difference in work (Scott, 2026-10-26).** `parseSTL` computes flat face normals on ingestion so the
  mesh is render-ready; three's `STLLoader` copies the file's zero normals, which light wrongly until the user calls
  `computeVertexNormals()`. The full job is measured as `p-stl-normals` (run `20261026-211213`, diagnostic): three
  `STLLoader.parse` + `computeVertexNormals()` 8.7 ms, `parseSTL` 4.7 ms, so Margo is faster when both produce a
  lit mesh. The plain-copy `p-stl` gap (4.7 against 2.7 ms, 1.7x) stays listed.
- **Plan:** for `parseSTL`, the remaining gap is the computed normals, which are
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
  against three's WebGL 0.27 (run `20261027-032923`; 0.52 against 0.29 in run `20261027-103915`). The GPU half of this entry is fixed (perf-history entry 34:
  1.33 -> 0.19 ms, one dispatch per buffer page and pipeline instead of 200); what is left on the GPU is the 0.05 ms
  deform pass, an accepted difference in work recorded in the matrix row 12.5.
- **Cause (measured, browser CPU profile of 5,000 `p-morph` frames, 2026-10-27):** most of it is not the animation.
  About 55% of the busy frame time is gltf-pro deriving each of the 200 draws again every frame (`derive`,
  `derivation`, `draw`, `drawSegment`, `nodeRows`): MorphStressTest has two primitives, so its models never take the
  run's one-primitive short path (`joinRun`), and a plain glTF material has no steady path (the steady check in
  `derive` needs a `shading` record's version, which only materials-package materials carry), so every draw rebuilds
  its uniform rows and its pipeline key strings. The 100 Animations' own work (`setMorph`, validation, weight writes,
  `upload`, `deformAll`) is about a fifth. The one-upload-per-device plan below would only move that fifth.
- **Plan:** give `PBRMaterial` a version that its setters and `markDirty()` bump, so a plain glTF material takes the
  steady path when nothing changed (rows rewritten only for the node matrix, as for materials-package materials),
  and let a multi-primitive model join a run when each primitive could; then write the weights of every Animation of
  a device in one upload. Both are gltf-pro and animation changes, no core.

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

The entries below are speed-matrix rows diagnosed on 2026-10-27 (item 47 phase 2, round 4; busy machine, RTX A6000,
diagnostic). Their causes and the fixes that landed are in `bench/parity-causes.json` and perf-history entry 36.

### Raw meshes: native calls per draw

- **What:** `p-custom-shader`, 10,000 `RawMesh`es of one `RawShaderMaterial`: 21.3 ms CPU a frame against three's
  WebGL 7.6 (three's WebGPU backend 36.8; run `20261027-105724`).
- **Cause (measured, timing wrapper on the render-pass methods):** of about 2.1 us per mesh, about 1.7 us is the
  native encoding calls: its own object bind group, its vertex buffer, its index buffer and an indexed draw. The
  meshes share one geometry's arrays but each uploads and binds its own buffers.
- **Plan (shader package):** share GPU vertex and index buffers among raw meshes whose packed streams are byte-equal
  (counted per device, copy on write), so consecutive draws skip rebinding them, and keep the object blocks in one
  pooled uniform buffer bound with dynamic offsets.

### Motion blur needs TAA for velocity

- **What:** `p-motion-blur`: GPU 0.63 ms a frame against three's WebGPU 0.25 (CPU is faster, 2.3 against 3.2).
- **Cause (timestamps per pass):** `MotionBlur` reads TAA's velocity, Margo's only motion-vector source, so the frame
  also runs TAA's velocity and resolve passes (about 0.3 ms); the blur itself is about 0.27 ms.
- **Plan (taa package):** a velocity-only mode (the velocity pass without the history resolve) for effects that need
  motion vectors but no anti-aliasing.

### Rect area lights: main pass GPU time

- **What:** `p-rect-area`, 4 area lights on the 1,000-box yard: GPU 0.49 ms against three's WebGL 0.16 (CPU faster).
- **Cause (timestamps per pass):** all of it is the main pass; the clustered culling pass is 0.003 ms. Clustered
  lighting integrates each quad under the GGX LTC and the cosine with exact per-edge clipping to the horizon. Which
  part costs the time is not isolated yet.
- **Plan:** time the main pass with the area lights off and with the horizon clip replaced by the unclipped integral
  (a measurement only), then decide between a cheaper equal-looking integral and an accepted difference.

### Environment.create does work three's PMREM does not, and recomputes its BRDF LUT

- **What:** `p-pmrem`: 10.9 ms a call against three's 5.0 (run `20261027-105122`; 14.6 before the half-float fix).
- **Cause (browser CPU profile: 70% of the call idle, waiting for the GPU):** each call uploads the equirect, builds a
  source cube with mips, prefilters the specular levels, computes L2 SH and reads it back to the CPU, and computes a
  128 x 128 BRDF LUT; three's timed call reuses its uploaded texture and computes the specular levels only.
- **Plan:** the LUT depends only on its size and sample count: share one per device (counted, freed with the last
  environment). Then time the passes to state the rest as an accepted difference with its parts.

### First frame of 100 morphed copies

- **What:** `p-morph`'s first frame is 304 ms (three's WebGPU backend 294, WebGL 37; run `20261027-103915`); its build
  is 206 ms. Before perf-history entry 34 the build was 490 ms and the first frame 47.
- **Cause:** the per-device deformation setup and gltf-pro's render pipelines are created on the first frame, and
  WebGPU compiles pipelines there. A second cause, every copy compiling its own mip pipelines (200 shader modules),
  is fixed (entry 36).
- **Plan (gltf-pro and animation):** create the pipelines a loaded model will draw with
  (`createRenderPipelineAsync` / `createComputePipelineAsync`) while it loads, so the first frame finds them ready.

## Fixed 2026-10-31 (flaky root tests under load)

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| `SHUTDOWN_TIMEOUT` "still open: browser" on a busy machine (`tests/page-ready.test.js`, `tests/catalog.test.js`, `scripts/frame-alloc-browser.mjs`) | headless Edge shuts down on low-priority threads, which CPU-bound work starves: its graceful close took 68 to 146 s beside CPU hogs | `withBoundedClose` ends a Chromium-family browser's process tree before the close, 7 to 17 s on the same load; the 30 s budget is unchanged | `tests/browser-teardown.test.js` (a close that finishes only once the tree is ended; a real browser leaves no process) |

## Fixed 2026-10-31 (found by the WebGL2 demo comparison)

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| VFX: blended particles drew in a different order each frame (the gameplay sandbox still frame differed by 1 level on 41 to 57 pixels between two native captures, RTX A6000, Edge 156) | the update kernel took respawn tickets and draw-list places with `atomicAdd`, so the order of overlapping blended particles changed between runs | `33c403984` (dated 2026-10-30): four workgroup prefix-sum passes give births the lowest dead slots and compact the drawn particles in slot order | the order case of `packages/vfx/test/browser-check.mjs` (65,536 slots, 40,000 births, five frames, two runs; fails with the atomic build, 0 pixels differ with the fix) |

## Fixed 2026-10-31

All were found by `npm run modern:test:extensions` and the other `test:release` suites, which no check ran from about
2026-10-16. They run in `check:gpu-packages` now, and
`unrunReleaseGates` fails a suite that drops out again.

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| The packed-browser step of `modern:test:packages` missed its fixed 30 s page-load limit on a busy machine ("Packed browser failure: state null") | a fixed time against load: a cold dev server transforming every package took longer while other check:merge runs shared the CPU | the step waits on the dev server (`waitForRequestsIdle`) and then gives the page 10 s; a 10 minute hard limit fails a real hang naming the server state and page errors, and the browser and server close (`scripts/support/page-ready.js`) | `tests/page-ready.test.js` (holds the last module back in a real dev server: the fixed wait fails, the new wait passes) |
| `npm run dev:examples` refused every page (403) from a checkout reached through an 8.3 short path | Vite's file-serving allow list held the working directory as given and compared it with each file's real path | `dev:examples` runs `scripts/dev-examples.mjs`, which starts Vite in `realpathSync.native(process.cwd())`; no root Vite config, so every other root `vite` command is unchanged | `tests/dev-examples.test.js` (short-path cwd serves 200, a file outside the repository stays 403) |
| Taking one lighting effect out of a `VoxelRenderer` other than the last one added drew the clear colour for 8 to 21 frames (`draws` 0, RTX A6000, 3 ms frames) | a composition never drawn before had nothing compiled, and the pipelines with the removed effect cannot draw (its owner may dispose its resources) | once a composition is ready, those without each one of its effects compile a GPU call per frame and stay among those kept, the one without effects stays always, and while the wanted one is not compiled the largest compiled composition whose effects are all still added draws, which covers several effects leaving at once (`packages/voxel/src/render.ts`). The stand-in way was measured and refused: zeroed bindings draw every voxel black with fog taken out, 190921 black pixels with an environment, 1956 wrong with shadows, and the renderer cannot make a depth or cube texture of a kind it does not know | `packages/voxel/tests/render.test.js` "addLighting: the frame right after" and the three after it, `render-lighting-browser-check.mjs` effectRemoval (either effect, disposed at once, 0 pixels off the settled frame) and severalRemoved (two of three leaving in one frame) |
| `modern:test:extensions` sat silent until the 30 min GPU lock limit | Chromium (Edge 156, RTX A6000) leaves a `getCompilationInfo()` asked once the device is idle pending until another GPU request runs; `material-extension-tests.js` asked for 41 modules then, inside a `page.evaluate` with no time limit, and the eight suites ran in one process with no limit | the WGSL guard asks every module at creation and answers later calls with that (`scripts/support/wgsl-guard.js`); each suite runs alone under `runLimited` (`scripts/modern-extension-suite.mjs`); engine source must ask at creation | `tests/wgsl-guard.test.js`, `tests/modern-extension-suite.test.js`, `tests/compilation-info-at-creation.test.js` |
| IOR 1 transmission (materials) drew a 13-step highlight over the background | since `dc883a59` the host keeps reflections under extension transmission, but its F0 stayed 0.04 whatever `KHR_materials_ior` said | the extension slot takes an `ior` expression and the host sets `s.f0` from it (gltf-pro); transmission and node transmission pass it (materials) | `packages/materials/tests/transmission-ior.test.js`, `scripts/materials-transmission-tests.js` |
| Transmission with a sheen or specular lobe drew about 148 steps of white on a fully transmissive surface | the lobes recompute diffuse light at full strength, ignoring the transmitted share `s.tr` | lobes composed over transmission scale their diffuse by 1 - `s.tr`; `install` composes transmission first (materials) | same two |
| The thin-glass sightline and volume refraction checks compared bytes, which IOR-dependent reflection and transmission (`dd13beb9`) change | the checks measured lighting, not where the background lies | they compare the red/green layout of the background | `scripts/materials-transmission-tests.js` |
| `gltf-ktx2-production-tests.js` and `gltf-compression-browser-tests.js` could not build | the `closeAll` codemod put its import into the source of the generated consumer page (bug 70 again; that guard read only `.mjs`) | the import moved to the script | `tests/undeclared-names.test.js` now reads `scripts/**/*.js` |
| Half metal glass lost light: the transmitted share took the mixed F0 (`mix(dielectric, base, metal)`) on top of `1 - metal`, so white half metal at IOR 1.5 passed 0.24 where glTF's `mix(dielectric_brdf, metal_brdf, metallic)` gives 0.48, and reflected plus transmitted came to 0.76. With a specular lobe in play it read 0.48, so the value jumped at specular 1 | The share was written after the sample implementation's `f0 = mix(0.04, base, metal)`, which is right for reflection and takes this light a second time | `materialTransmissionWeight`, `materialLobesTransmitted` and the `Transmission` pass subtract the dielectric's own Fresnel | `packages/materials/tests/transmission-shader.test.js`, `transmission-layers.test.js` |
| Over transmission, sheen, specular and clearcoat did not touch the transmitted light (materials `install`): a white glass quad read 0.96 of the background whatever the lobes said, against the Khronos numbers 1.0 (specular 0), 0.92 (specular colour [2,1,1]), 0 (colour [25,25,25]), 0.42 (white sheen, roughness 0.5, 75 degrees), 0.54 (clearcoat 1, 75 degrees). Native tint path (no install): 1.0 for all of them | the transmission weight knew only the IOR's Fresnel, and the native tint was a per-material constant; glTF puts transmitted light in `fresnel_mix`'s base, under sheen and clearcoat | lobes set the transmitted share `materialLobesTransmitted`, the coat its `materialCoatKeep`, and the share is applied in linear light (materials); `margoTintShare` computes the same from the material's factors (gltf-pro) | `packages/materials/tests/transmission-layers.test.js`, `scripts/materials-transmission-tests.js` "layeredShare" |
| Suite checks had gone stale against deliberate changes: a pinned shader hash, "New lobes bypassed transmission" (exact pixels, from before reflections stayed over transmission, `dc883a59`), `dynamicDraws === 4` and `staticDraws === 8` (undeformed casters cache automatically), one PBR compile per eye (pipelines are per device), exact error messages (coded errors with links), a lazy gltf chunk (the stage root has no `import()` since 2026-10-27), `engine.recovery` (private, mangled in dist, so the device loss race counted zero recovery frames) | no check ran them | each now states today's contract, as strictly: the shader against its source, lobes byte-exact on the unlit transmitted background plus a reflection check when lit, draws per cascade, the shared compile, the coded messages, no optional package anywhere in the quickstart bundle, frames between the loss and the new device | the suites, in `check:gpu-packages` |
| Scene 05 of the biome scenes seemed to change colour and show sky bands above about 1.4 million objects; no engine fault: sky bytes are identical at 1,357,722, 1,387,928 and 1,429,018 objects, and at 2,028,410 no errors and every buffer stays under 13 MB | the tool that reads a picture to a model re-encodes a file over 3,932,160 bytes (5 MiB of base64) with a reduced palette; the same pixels pass true at 3,932,160 bytes and bands appear at 3,932,161; a 1920x1080 frame sits right at that size, so object count only moved the file size | `scripts/review-png.mjs` rewrites a shot losslessly under the limit and stops with `REVIEW_PNG_TOO_LARGE` if it cannot; judge shots from its output or by their numbers | `tests/review-png.test.js` |

## Plaza (voxel-net) fixed 2026-10-31

Three entries were open on the Plaza branches and did not come across when they landed on main; the findings are in
[voxel-net-capacity-2026-10-31.md](voxel-net-capacity-2026-10-31.md) ("Bugs found by this run" and "Old connections").

| Bug | Cause | Fix | Regression test |
| --- | --- | --- | --- |
| A player flying onto new ground was closed with 1008 "too many messages": 38 of 150 bots on the real server, 18 to 28 of 150 locally at the same generator speed | the server holds a client's inputs until the chunks around it exist, while the client runs ahead on chunks it was sent; the 256 message queue limit (12.8 s) counted the server's own backlog against the player, and a wait has no upper bound under load | `5614fb925`: while held, inputs past 256 fold into the last one (at most 60 steps are banked after a wait, the rest only count), and the chunks that hold a player go to the front of the generator queue; over 64 messages a second during a wait, and 256 in a tick outside one, still close the player | `packages/voxel-net/tests/held-inputs.test.js` |
| Plaza connections were closed after about 15 minutes (first cut at 1,073 s of age: 66 of 100 bots through the CDN, 0 of 40 past it) | not the game or the home line: the first FIN comes from the CDN proxy, and a plain echo server with no Margo code is cut the same way | protocol 4: the server parks a dropped player for 30 s and takes it back on a token, and `connectVoxelNet` and `VoxelBot` resume in place on their own | `packages/voxel-net/tests/resume.test.js`, `resume-client.test.js`, `resume-crowd.test.js` |
| 1006 closes with no cause on old connections | the same CDN proxy cut as the row above | the same resume; the page plays on through the close | the same tests. Not explained: the one `client-silent` close in the capacity run, which `/metrics` counts as a park of its own kind |

## Fixed 2026-10-26 to 10-28

Each is described with its cause and guard in
[whitepaper/perf-history.md](whitepaper/perf-history.md#what-our-checks-caught-and-what-we-got-wrong-2026-10-26-to-10-28).

| Bug | Fix | Regression test |
| --- | --- | --- |
| Precise maths changed by compilers that reassociate (AMD Radeon 680M, Intel UHD with Mesa) | `b6bea3e9`, `baa66526` | `tests/precise-math.test.js`, `packages/compute/tests/maths.test.js`, compute `test:browser:reassociate` and `test:browser:sweep` |
| `math-consolidation` proof digests differed between Node 22 and Node 26 | `ab27353f` | `tests/proofs-golden.test.js` |
| Repository and package Node minimums were one number | `6c289ed9` | `tests/engines.test.js` |
| VoxelRenderer drew nothing after the last added effect was removed; a replaced clustered light threw | `baa66526` | `packages/voxel/tests/render.test.js`, `render-lighting-browser-check.mjs` |
| Flaky under load: lod heap probe, catalog clipboard | `6d08b0af` | `packages/lod/test/lod.test.js`, `tests/catalog.test.js` |
| Flaky under load: quiet-server timeout | `3a59aa55` | `tests/server-url.test.js` |
| Flaky under load: controls walk step per frame | `7714e84e`, `109ec352` | `packages/controls/tests/walk.test.js` |
| Browser suites shared one Vite dependency cache | `7ab8cd13` | `tests/vite-cache-isolation.test.js` |
| GPU suite waited silently for a fixed port | `6ddd733b` | `tests/browser-port-wait.test.js` |
| Headless Edge used the integrated AMD GPU with Remote Desktop disconnected | `85c96a55` | `tests/gpu-adapter.test.js`, `tests/browser-selection.test.js` |
| A GPU reset left a page waiting 30 to 120 s with no cause named (the reset itself is still open, above) | `49dca9dd`, `51d8786a` | `tests/device-loss-guard.test.js`, `tests/driver-resets.test.js` |
| netcode `openWebSocket` hung on a refused connection on Node 22 | `7f0dd465` | `packages/netcode/tests/transports.test.js` |
| Data after a compressed stream accepted on Node 22 (fbx, loaders ZIP, splats SOG, voxel codec) | `0687e6ec` | `tests/trailing-data.test.js` |
| Audit F01, F02, F05: margo-convert read, deleted or overwrote files outside their folder | `4bc89574` | `tests/margo-convert-paths.test.js` |
| Audit F06, F07: `allowedURLs` matched by prefix; redirects were not rechecked | `c6e7623c` | `tests/security.test.js`, `packages/gltf-pro/tests/progressive.test.js` |
| Audit F04, F17: OBJ material libraries fetched from any host with the caller's options, no total budget | `b96f5f40` | `packages/loaders/tests/mtl.test.js` |
| Audit F11, F12: netcode room joinable before `onCreate`; failing hooks left clients hanging | `158076f1` | `packages/netcode/tests/rooms.test.js` |
| Audit F18, F19: WebSocket control frames counted against the message limit; close reasons cut by characters | `6bebf878` | `packages/netcode/tests/transports.test.js` |
| Audit F14, F15: voxel-net dropped a hello sent with the upgrade; failed chunks were never retried | `8c8b51a0` | `packages/voxel-net/tests/websocket.test.js`, `server.test.js` |
| Audit F03, F13, F16: voxel-net had no authentication, no cap before the hello and no bound on edited chunks | `ddc5c5ff` | `packages/voxel-net/tests/limits.test.js` |
| Audit E-01 (bug 61): partial-view clears drew black at 4x MSAA on Intel Arc 140V (D3D12) because the colour came only from the blend constant | `64034d95` | `tests/clear-draw.test.js` |
