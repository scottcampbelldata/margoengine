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
- **Needed to close:** the `compute-browser.json` precise-maths results from an Intel PC (steps in
  `private/handoffs/intel-recheck.md`), then this entry removed or turned into the cause found.

### Linux (Intel UHD, Mesa): three GPU suites not finished

- **What:** on the Ubuntu test server (Intel N100 with Intel UHD, Chromium on Mesa's Vulkan driver, Node 24, main
  b92998d6, 2026-10-28) 42 of the 43 package GPU suites were started, one at a time, and 38 passed. The voxel, voxel
  path tracer and root browser suites were stopped by the heat watchdog at 82 C before they finished, so they have no
  Linux result yet. The text failure of the same run is the colour emoji entry below.
- **Needed to close:** those three suites run to the end on Linux, on a machine that stays cool under a long GPU
  run, and the results recorded here.

## Open defects

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


### BiomeView: a world or placement change while a tile waits to be copied in can leave the old tile drawn

- **Repro:** on a `BiomeView` with workers, paint or edit a rectangle (or change the placement) in the short time a
  tile of that rectangle has arrived but is not yet copied in (it waits in the view's frame work, a few frames at
  most, longer when many tiles are queued). Objects: the old placement is put on the GPU and the tile is not placed
  again, so the edit does not show there until the tile leaves range and comes back. Terrain: the tile is made again,
  but when the old copy waits longer than the new tile takes to make, the old copy lands last.
- **Cause:** `#dirty` in `packages/biomes/src/view.ts` drops jobs on their way and prefetched tiles, and places held
  object tiles again, but it does not look at tiles that already arrived and wait in `#arrived`.
- **Fix needed:** in `#dirty`, drop the waiting steps of the tiles in the rectangle and make them again (objects too
  when they were not yet held); with a browser check that edits while a tile waits (no frames drawn, so it waits for
  the drain timer) and compares the drawn tile with a fresh view of the edited world.

### VoxelRenderer draws nothing for a few frames after an effect is taken out of the middle

- **Repro:** add two lighting effects to a `VoxelRenderer` (`shadows.add(voxels)`, then `clustered.add(voxels)`), let
  both compile, then call the shadows remover: `voxels.stats.compiling` is true and `draws` 0 until the composition
  with the clustered light alone has compiled (about 2 frames on an Intel UHD, 1 on an RTX A6000), so the clear colour
  shows through for those frames.
- **Cause:** the pipelines with the removed effect cannot keep drawing (they bind its resources, which its owner may
  dispose right away), and a composition never drawn before has nothing compiled. Since bug 29 the last four
  compositions stay compiled, so taking effects out in the reverse order they were added, or putting one back, draws
  at once (`packages/voxel/tests/render.test.js` "addLighting", `render-lighting-browser-check.mjs` clustered).
- **Fix needed:** draw with the remaining effects' last pipelines and a neutral stand-in for the removed effect's
  bindings while the new composition compiles, or compile the compositions without each effect ahead of time; either
  with a check that the frame right after an out-of-order removal is drawn.

### The packed-browser step of `modern:test:packages` can miss its 30 s page-load limit on a busy machine

- **What:** `scripts/modern-package-tests.js` (`packedBrowser`) waits 30 s for `window.modern` after the first page load,
  and a cold dev server transforming every package can exceed that when several agents share the CPU and GPU.
- **Repro:** run `npm run check:merge` while other check:merge runs are active; seen once on 2026-10-27 ("Packed browser
  failure: state null", `page.waitForFunction` timeout), and the same step passed on a rerun with the machine quieter.
- **Cause:** a fixed timeout against load, not a wrong result. Fix: wait on the dev server's readiness (as `listenWhenFree`
  and the pipeline-ready helper do) instead of a fixed time, and add a test that holds the load back.

### `npm run dev:examples` refuses every page from a checkout reached through an 8.3 short path

- **Repro (Windows):** open a terminal in the repository through its short name (`cd C:\DEVELO~1\Projects\MARGOE~1`,
  or any clone under `os.tmpdir()`, which is `C:\Users\\...` on this PC), run `npm run dev:examples` and open
  any page, for example `/packages/netcode/examples/arena/`: Vite answers 403 "outside of Vite serving allow list".
  The same command from the long path serves 200 (measured with both paths on the same worktree).
- **Cause:** with no Vite config at the repository root, Vite's file-serving allow list holds the working directory
  as given (the short name) and compares it with each file's real long path, so no file matches.
- **Fix needed:** a root `server.fs.allow` built from `realpathSync.native(process.cwd())` (a root `vite.config.js`, or
  the same option passed by a small `dev:examples` wrapper), with a check that serves a page from a short-path cwd.
  Not done in the netcode landing because a root Vite config changes every root `vite` command; the arena test runs
  the README command from the canonical path meanwhile (`packages/netcode/tests/arena.test.js`).

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
