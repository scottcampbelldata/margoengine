# Reproducing Margo's numbers

## Batch 134 prebuilt Basis targets (partial)

The [record](results/batch-134-prebuilt-baseline.json) pins each input URL/hash,
both opaque wrapper hashes, the Wasm hash and per-file/per-target results.
Use the built static-embind wrapper and its unchanged Wasm from an outside
folder; never inspect either implementation. The retained vendor pass is a
control, not the shipped timing target. Decode every mip, layer and face.
For warm controls, create one module per file/target, record its first call,
then alternate A/B order for three rounds, taking each side's minimum of two
complete transcodes. For cold controls, use a fresh initialized module for
every trial with the same round/order/minimum design. Verify every output's
hash after its timer. A/B are identical prebuilts until a replacement exists.

Measure memory in a fresh process for each file/target, retaining only that
pair's complete output; record process peak RSS and Wasm high-water bytes.
Use seven more fresh processes for compile/instantiate/startup, keeping
instrumented phases separate from natural per-target startup. Gzip assets
at level 9. All current timing data is a loaded-machine diagnostic.
Original harnesses, complete trial arrays and per-image hashes are retained
in lane M's private `batch-134/measure` folder; a portable public runner and
complete source-quality/licensing evidence remain work for the later jobs.

## Real-data scientific demos (2026-11-10)

Pull Git LFS assets and build packages, then run the sciviz unit and browser tests:

```sh
git lfs pull
npm run build:packages
npm test --workspace @margoengine/sciviz
node scripts/gpu-lock.mjs run --owner=sciviz-real-data --max=12 --wait-max=5 -- node packages/sciviz/tests/demos-browser.mjs
```

The runner checks all three real-data demos and four retained synthetic test pages on WebGPU and forced WebGL2,
at 1440 x 900 and 390 x 844, exercises controls and exports, checks rendered structure and selected histogram
counts, and observes live frames during trace updates. Results and screenshots are under
`test-results/sciviz-demos/`. Source data, exact reduction, hashes, projection and subset biases are recorded in
`examples/assets/sciviz/README.md` and adjacent JSON manifests. This is functional evidence, not a speed measurement.

## Five executable README repairs (2026-11-09)

After `npm run build:packages`, run
`node scripts/gpu-lock.mjs run --owner=codex-readme5 --max=15 -- npm run check:readme-run -- --packages=react,stage,text,worker`.
The scoped result is 40/40, zero failures. React's standalone picking test receives the same selected browser/GPU
launch environment as the page harness. It serves its own scene on a free port, waits for frames, clicks the box
and waits for the React state update. A driver that cannot finish fails at its deadline.

Regenerate the atlas with
`node scripts/gpu-lock.mjs run --owner=codex-readme5 --max=3 -- node packages/text/scripts/make-readme-atlas.mjs`.
This uses the pinned Source Sans 3 TTF and Margo's SDF code, not an outside atlas generator. The generated
JSON and PNG live together under packages/text/tests/fixtures/fonts/readme. Run `npm test --workspace @margoengine/text`
for all ASCII glyphs and `npm run test:browser --workspace @margoengine/text` under the GPU lock for JSON/PNG fetch
and actual Hello rendering. The fixture notice records the source and OFL; no font implementation is copied.

## Poisson placement work count (batch 68, job 1)

Run `npm test --workspace @margoengine/procedural` for the seeded 3,000-candidate float64 all-pairs comparison:
3,329 hash distance tests versus 3,445,553 all-pairs tests, exactly the same accepted coordinates. This is a work
count, not a wall-clock speed claim. `npm run test:poisson-kernel --workspace @margoengine/procedural` runs the
native Rust tests; `npm run build:poisson --workspace @margoengine/procedural` rebuilds the committed Wasm.
Run `node scripts/gpu-lock.mjs run --owner=codex-68 --max=10 --wait-max=10 -- npm run test:gpu --workspace @margoengine/procedural`
for real production-browser WebGPU/WebGL2 value, lazy-asset, non-root-base and device/context-loss checks.
Only synthetic geometric inputs are proven; authored mesh placement and spectral/speed quality are unmeasured.

Every public number should come from one of the commands below. Run them from the repository root on the commit you
want to check. Status of each claim and which command backs it: [claims.md](claims.md).

## Setup (once)

```sh
git clone https://github.com/scottcampbelldata/margoengine.git && cd margoengine
npm ci                     # Node 24.18+; installs three@0.186.1, Vite, Playwright and the test tooling
npx playwright install msedge   # or set MARGO_BROWSER=chrome, or webkit on macOS; the real-GPU scripts default to Edge
npm run build:packages     # every package, size gates, catalog (no Rust toolchain needed; the Wasm is checked in)
```

## Everything in one command

```sh
npm run bench                  # every suite: size, startup, render, objects, scaling, math, glTF, loaders, assemblies,
                               # voxel, physics, memory, React (quiet-machine gate, GPU lock, 5 runs per case)
npm run bench -- features      # also every per-feature real-GPU script below (about an hour)
npm run bench -- --list        # the suites and cases
npm run proofs -- --current    # the recorded-GPU-call proofs
```

`npm run bench` is the one benchmark tool ([docs/benchmarking.md](../benchmarking.md)). Each run writes
`benchmarks/runs/<id>.json` with its Markdown and HTML report. The JSON records the commit, machine, GPU and driver,
browser and the gate's readings. `--record` keeps a committed copy in `benchmarks/records/`. The `features` suite
copies what each script writes to `benchmarks/runs/<id>/features/` and restores the committed results, so a run never
changes them.

## Whitepaper timing run (pending: needs a quiet PC)

No timing number is whitepaper data yet. The tool has only been smoke-tested (labelled "smoke", not for
publication). When the machine is quiet (no other apps, no builds, on AC power), run
this once on the release commit:

```sh
npm run build:packages
npm run bench -- --label=official --record
npm run bench -- features
```

The gate refuses battery power and waits for a quiet CPU and GPU. Any case whose runs spread more than 10% makes the
run invalid. An official label on an invalid run stays invalid. The head-to-head with three.js and other engines runs
the same scenes from `C:DevelopmentProjectsengine-bench` (`--engines=all`, see docs/benchmarking.md "Comparing
engines").

## The five-minute quickstart

The launch claim is that a developer builds a textured, lit scene with shadows and picking in under five minutes by
copy-pasting the README. `npm run check:quickstart` measures the machine part and asserts the result in a real browser:

```sh
npm run check:quickstart                                   # route 2: an own project from local tarballs
npm run publish:rehearsal                                  # the one-line install from a stand-in registry; publishes nothing
node scripts/quickstart-timing.mjs --route=1 --keep --dir=<folder>   # route 1 (the clone's page); keep the folder
```

It clones this checkout (uncommitted work laid over it) into a temp folder with a cold npm cache, then does what the
README says line by line: `npm ci`, `npm run pack:packages`, a new project, `npm install <tarballs> vite`,
`index.html` and `main.ts` extracted from the README text itself (never retyped), `npx vite`, and the page in headless
Edge under one shared GPU slot. The browser asserts, from pixels and handlers:

- a first frame with content, and sharp checker edges on the floor (none in the same scene without the texture);
- a shadow beside the ball, darker than the same scene without `shadows.add`, also on the shipped page;
- a click on the ball and on the crate fires the page's pick handler (waited for) and draws the outline, and an orbit
  drag changes the picture without picking;
- a console with no warning or error (one recorded Chrome-on-Windows warning is reported, see known-bugs.md);
- the messages shown with no `navigator.gpu` and with an adapter request that answers null.

It writes `test-results/quickstart-timing.json` (timeline, sizes, notes) and the pictures in
`test-results/quickstart-timing/`. The three reference pages open one at a time beside the shipped page, and each is
closed once its picture is taken: on an Intel Arc 140V the 4th WebGPU page alive at once in one browser process never
finished starting. A page that is not ready in time leaves `failed-<page>.png` and `failed-<page>.json` there
(visibility, canvas sizes, animation frames per second, what the page logged) before the check fails. It fails over
300 s from the first command to the verified interactive frame, and ends every process it started at a hard limit of
900 s. It is a step of `check:merge`, so the nightly full run has it too.
Not measured: reading the page and copying the two files, and anything after the first interactive frame. The install
route is a clone because 1.0.0 is not on npm yet.

## Rules for real-GPU numbers

- A quiet machine: on an integrated GPU the CPU and GPU share one power budget, so a build or test running at the same
  time changes the GPU numbers too.

- AC power before and after (`(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline`
  on Windows). The scripts check it and refuse or flag battery runs; on battery Windows throttles CPU and GPU.
- One GPU job at a time: the scripts take `test-results/gpu.lock` in the main checkout (they wait while another run
  holds it). Close other GPU apps; on an integrated GPU even a browser tab changes the result.
- Headless Edge/Chrome with `--disable-gpu-vsync --disable-frame-rate-limit`, so FPS is throughput, not the display.
- Medians of alternating rounds; compare A/B only within one run (clocks drift between runs).

## Commands by claim area

| Area | Command | GPU | Output | Notes |
| --- | --- | --- | --- | --- |
| Core + stage gzip (CI gate, < 25,000 B) | `npm run measure:size` | no | console | Also enforced by `npm run build:packages`. |
| meshopt, TypeScript against Wasm SIMD | `node packages/decoders/scripts/meshopt-simd-bench.mjs <file.glb>` (after `npm run build --workspace packages/decoders`) | no | console | Any glTF binary compressed by gltfpack; perf-history entry 75. |
| Own physics step profile and harness bars, native (Lane Q tuning) | `cargo run --locked --release --manifest-path packages/physics/kernel/Cargo.toml --example profile -- [pyramid\|cubes1000\|cubes5000\|cubes1000-awake\|cubes5000-awake\|chain\|grid\|all] [default\|equal]`; `... --example bars` | no | console | `profile` times each phase of `World::step` and counts awake bodies, pairs, solved pairs and points per step; a twin world stepped by `World::step` must end hash-equal, so the profile cannot time a different step. `bars` gives the bounce, pyramid and heavy-on-light numbers of `physics-refs/js/margo-next/margo3d.mjs` at both settings; native and Wasm agree bit for bit, so they are the harness's numbers. Timings are hints on a loaded machine (`docs/work-lists/busy-retests.md`). |
| Own physics separating axis test against every axis (LIM-369) | `npm run test:physics-kernel` | no | no | under a minute |
| Flock of 1,000 against Yuka (perf history entry 93) | `node packages/behavior/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/behavior` | no | console | Yuka 0.7.8 is installed outside the repository under engine-bench `batch-167` (`MARGO_ENGINE_BENCH` overrides the folder). Paired turns, per-round minimum. Busy-machine numbers are diagnostic. |
| Navmesh build and path length against recast-navigation (perf history entry 94) | `node packages/navmesh/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/navmesh` | no | console | recast-navigation 0.44.0 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The open-floor length and the gapped hole check are `node --test packages/navmesh/test/path-length.test.js`. |
| 100,000 entities against bitECS (perf history entry 95) | `node packages/ecs/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/ecs` | no | console | bitECS 0.4.0 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. Both checksums are `n = 100000`, `sum = 5000050000`. |
| 10,000 transitions against XState (perf history entry 96) | `node packages/fsm/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/fsm` | no | console | XState 5.33.4 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. Both machines end in state `a`. |
| 10,000 tweens against tween.js (perf history entry 97) | `node packages/tween/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/tween` | no | console | tween.js 25.0.0 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The linear halfway rule is `node --test packages/tween/test/linear-oracle.test.js`. |
| Rollback resimulation (perf history entry 98) | `node packages/netcode/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/netcode` | no | console | No JavaScript rival (GGPO is C++, Colyseus is not rollback). Paired turns, per-round minimum of 180 frames. Busy-machine numbers are diagnostic. |
| Save migration fuzz (perf history entry 99) | `node packages/save/scripts/fuzz-roundtrip.mjs` after `npm run build --workspace @margoengine/save` | no | console | No rival package. Seed 167, 200 documents. The regression test is `node --test packages/save/tests/migration-fuzz.test.js`. Busy-machine numbers are diagnostic. |
| matmul-256, fft-65536 and a sum of 1,048,576 against TensorFlow.js (perf history entry 100) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/compute/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/compute` | yes | console | TensorFlow.js 4.22.0 and tfjs-backend-webgpu 4.22.0 are installed outside the repository under engine-bench `batch-167`. Node 26.12 has no WebGPU, so both run in one headless page, taking turns. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The NumPy oracle is `node --test packages/compute/tests/numpy-oracle.test.js`. |
| volume-64 against VTK.js (perf history entry 102) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/sciviz/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/sciviz` | yes | console | VTK.js 38.0.5 is installed outside the repository under engine-bench `batch-167`. One headless page, taking turns. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The field is `node --test packages/sciviz/tests/volume-field.test.js`. |
| Truck 7k prefix against GaussianSplats3D (perf history entry 103) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/splats/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/splats` | yes | console | GaussianSplats3D 0.4.7 and three 0.170.0 are installed outside the repository under engine-bench `batch-168`. The truck ply, the `000001` JPEG and `cameras.json` stay in that folder's `data` (not in this repo). The bench writes `truck-7k-fit.ply` there, the first 699,050 vertices. One headless page, taking turns. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The fit count is `node --test packages/splats/test/storage-fit.test.js` and the pose maths are `node --test packages/splats/test/paper-camera.test.js`. |
| Quadtree screen-space error against 3DTilesRendererJS (perf history entry 104) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/tiles/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/tiles` | yes | console | 3DTilesRendererJS 0.4.21 and three 0.170.0 are installed outside the repository under engine-bench `batch-168`. The quadtree is built in the process (5,461 tiles, one shared GLB). One headless page. The rival's `errorTarget` is set to 16. Paired turns, per-round minimum, after loads settle. Busy-machine numbers are diagnostic. The Margo set is `node --test packages/tiles/tests/sse-scene.test.js`. |
| 10 million points against potree-core (perf history entry 105) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/points/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/points` | yes | console | potree-core 2.0.17 and three 0.170.0 are installed outside the repository under engine-bench `batch-168`. The bench writes `data/points-10m` there (metadata.json, hierarchy.bin, octree.bin, 200,000,000 bytes of points) and does not commit it. One headless page. Both budgets are 10,000,000. Paired turns, per-round minimum, after the leaf has loaded. Busy-machine numbers are diagnostic. The grid is `node --test packages/points/tests/points-10m.test.js`. |
| Cornell box irradiance against Cycles (perf history entry 108) | `node packages/lightmap/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/lightmap` | no | console | Blender 5.3.0 Beta is `C:\blender\blender.exe` (`MARGO_BLENDER` overrides it). Cycles bakes on the CPU. The bench writes `data/cornell` under engine-bench `batch-168` (`MARGO_ENGINE_BENCH` overrides the folder) and does not commit it. 128 samples, `diffuse_bounces` 2. The snaps and the direct integral are `node --test packages/lightmap/tests/cornell-box.test.js`. |
| Own physics GJK and expanding polytope against brute force (LIM-372) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics replay, Node, native, Chromium and Firefox (LIM-366) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` and `npm run test:replay --workspace @margoengine/physics` | no | `packages/physics/test-results/replay-browsers.json` | Install Firefox once with `node node_modules/@playwright/test/cli.js install firefox`. `REPLAY_FIREFOX` names a `firefox.exe` where Playwright's own will not start. |
| Own 2D physics in Wasm: the pinned bits on WebGPU and WebGL2 pages, and the 100-row pyramid against Rapier 2D's Wasm and Box2D v3's Wasm (perf history entries 88 and 89) | `npm run check:rust-kernels -- --packages=physics2d` (Node), then `node scripts/physics2d-kernel-browsers.mjs` (`npm run test:physics2d-kernel-browsers` is its check:merge form: the default browser, bits only; `REPLAY_FIREFOX` names a Firefox copy on a PC that will not start Playwright's from the home folder). Box2D v3 joins when `BOX2D_WASM` names its build, made outside the repository as a black box: clone the official emsdk (`git clone https://github.com/emscripten-core/emsdk`, then `python emsdk.py install latest` and `python emsdk.py activate latest`; Emscripten 7.0.0 here), configure Box2D v3.2.0's own CMake project under `emcmake` with `-DCMAKE_BUILD_TYPE=Release -DBOX2D_SAMPLES=OFF -DBOX2D_UNIT_TESTS=OFF -DBOX2D_BENCHMARKS=OFF -DBOX2D_VALIDATE=OFF` (its Emscripten defaults add `-pthread -msimd128 -msse2 -ffp-contract=off`), build it, and link a harness on its public API that exports `bench_pyramid(rows)`, `bench_step()` and `bench_top_y()` with `emcc -O3 -pthread -msimd128 -msse2 -sMODULARIZE -sEXPORT_ES6 -sINITIAL_MEMORY=268435456` (physics-refs `wasm/box2d3/build.sh` and `pyramid.c`) | yes (WebGPU pages, takes the GPU lock) | `test-results/physics2d-kernel-browsers.json` | about a minute; timings are paired in one page, busy-machine numbers are diagnostic |
| Own 2D physics against Box2D v3 natively, eight lanes and four (perf history entry 91) | Margo: `cargo test --release --manifest-path packages/physics2d/kernel/Cargo.toml --test bits -- --ignored --nocapture step_time` (the four-lane solve, SSE2). Box2D v3.2.0, built outside the repository as a black box: physics-refs `native/box2d3/profile.cpp` (its own per-phase profile through the public API) built by `native/scripts/native-build.bat` (Box2D's defaults: its contact file at `/arch:AVX2`, eight lanes on an AVX2 CPU) and by `native/scripts/native-build-sse2.bat` (`-DREFS_BOX2D_SSE2=ON` into `native/build-sse2`: the harness file `box2d3/no_avx2.c` answers 4 to Box2D's SIMD width query and false to `b2IsAVX2Available`, so the four-lane SSE2 solve runs, and says so on stderr); run the builds in turns | no | printed | under a minute; busy-machine numbers are diagnostic |
| Own physics contact ids and warm start (LIM-376) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics manifold reduction and persistence (LIM-380) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics contact solver against mechanics (LIM-381) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics joints against mechanics (LIM-399) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics cone joints and limits (LIM-402) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics spherical motors (LIM-405) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics rope and spring joints (LIM-422) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics contact forces (LIM-423) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics events and filters (LIM-425) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics joint stability (LIM-416) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics convex decomposition against Rapier (LIM-514) | `npm run build --workspace @margoengine/physics`, then `node packages/physics/scripts/decomposition-vs-rapier.mjs` (add `--greedy` for the paper's one-step baseline, the like-for-like row); `node --test packages/physics/tests/next-decomposition.test.js` | no | console table | about a minute; times need a quiet PC |
| Margo vs other engines, bundle size | `npm run bench -- size --engines=all` | no | `benchmarks/runs/<id>.json` | Each engine's smallest lit-box app from engine-bench (`sizeEntry`) vs Margo's whole core + stage, all built with the size gate's output options. The last three.js measurement stays in `results/threejs-size.json`. |
| Potree reader on real folders | Fetch a folder (`git clone` or `curl`), then `node packages/points/tests/potree-check.mjs <folder URL or path>` (after `build:packages`). Folders used 2026-11-06: `pointclouds/lion_takanawa`, `lion_takanawa_normals`, `lion_takanawa_las`, `lion_takanawa_laz`, `vol_total` of github.com/potree/potree (branch develop), `pointclouds/potree2.0/lion` of github.com/iTowns/iTowns2-sample-data (BROTLI, CC BY-NC-SA, not in this repository), `example/data/pump` of github.com/tentone/potree-core | no | console, one JSON line | Exit 0 when every point lies in its node and counts match. Results: 272,768, 341,989, 341,989, 341,989, 498,868, 3,954,696 and 1,213,990 points, none outside. |
| Every package entry and worker, min+gzip | `node examples/package-benchmarks/entry-sizes.mjs` (after `build:packages`) | no | `results/entry-sizes.json` | build-modern's method, other packages external; also feeds the Gzip column of `docs/api-surface.md`. |
| Eager JS per demo | `npm run bench -- size --cases=demo-` | no | `benchmarks/runs/<id>.json` | Builds each demo with Vite. |
| Per-package min+gzip | `node examples/package-benchmarks/proofs/size.js` | no | `proofs/results/sizes.json` | |
| VFX entry sizes | `node examples/package-benchmarks/vfx-size.mjs` | no | `results/vfx-size.json` | |
| Package optimization proofs (same GPU calls / same output, faster) | `node examples/package-benchmarks/proofs/<name>.proof.js [ref]` | no (recording mock GPU) | `proofs/results/<name>.json` | Each builds a baseline ref; some default refs no longer build (see claims.md). |
| Kernel tick in Node | `npm run bench -- parts --cases=kernel` (or `node examples/package-benchmarks/parts/kernel-node.mjs`) | no | `benchmarks/runs/<id>.json` (`parts/results-kernel-node.json`) | |
| glTF export: validator errors and export time | `node examples/package-benchmarks/exporters-model.mjs` | no | `results/exporters-model.json` | Khronos glTF-Validator from node_modules; the timing needs the quiet PC. |
| Textured instancing, encoding CPU | `node examples/package-benchmarks/textured-instancing.mjs` | no (mock) | `results/textured-instancing.json` | Mock GPU: CPU encoding only, not frame rate. |
| Precise maths against the builtins, in the bench tool | `npm run bench -- compute --cases=compute-elementwise --runs=3` and `npm run bench -- tracer --runs=3` | yes | `benchmarks/runs/<id>.json` | perf-history entry 71. The record is the `precise-math-gpu.mjs` row. |
| **Margo vs other engines, same scenes** | `npm run bench -- render objects scaling --engines=all` | yes | `benchmarks/runs/<id>.json`, screenshots in `benchmarks/runs/<id>/` | Scenes in `bench/scenes/catalog.js`; other engines' implementations live in engine-bench. Earlier results: `results/vs-threejs-*.json`. |
| GPU culling | `node examples/package-benchmarks/parts/culling.mjs --check --label=<name>` | yes | `parts/results-<name>.json` | |
| Post stack per effect, SSAO + IBL | `node examples/package-benchmarks/gates/post-stack.mjs` | yes | `results/gates-post-stack.json` | |
| DOF before/after | `node examples/package-benchmarks/gates/dof.mjs --baseline=5b9dbbd` | yes | `results/gates-dof.json` | Builds the baseline. |
| Loaders + memory cycles | `node examples/package-benchmarks/gates/memory.mjs` | yes | `results/gates-memory.json` | |
| Native glass tint draw cost | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/tint-pass-gpu.mjs` | yes | `results/tint-pass-gpu.json` | Patches the served gltf-pro build for its comparison arms; fails if an arm leaves the frame unchanged. About 10 minutes. |
| Precise maths against the WGSL builtins | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/precise-math-gpu.mjs` | yes | `results/precise-math-gpu.json` | Compute functions and path tracer lenses. |
| Growable ECS worlds against fixed ones | `node examples/package-benchmarks/ecs-growable.mjs` | no | console | |
| Workgroup sizes of the compute package's own kernels | `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/compute/tests/compute-browser.mjs`, line `tuneCompute, 16M elements` | no | console | perf-history entry 77 |
| Subgroup kernels against the default compute kernels | `node examples/package-benchmarks/compute-subgroups.mjs` | yes | `examples/package-benchmarks/results/compute-subgroups.json` | |
| Shadow shimmer | `node examples/package-benchmarks/shadow-shimmer.mjs` | yes | `results/shadow-shimmer.json` | |
| Textured instancing on GPU | `node examples/package-benchmarks/textured-instancing-gpu.mjs` | yes | `results/textured-instancing-gpu.json` | |
| Atlas + VAT | `node examples/package-benchmarks/atlas-vat/check.mjs` | yes | `test-results/atlas-vat-check.json` | Result is not committed today. |
| Workers / OffscreenCanvas | `node examples/package-benchmarks/workers/run.mjs` | yes | `results/workers.json` | Edge and Chrome. |
| VFX 100k/1M particles | `node examples/package-benchmarks/vfx-gpu.mjs --a=<dist> --b=packages/vfx/dist` | yes | `results/vfx-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Not in the features suite. |
| Scatter cull, atomic against ordered (LIM-034) | `node examples/package-benchmarks/scatter-cull-gpu.mjs --a=test-results/scatter-base --b=packages/scatter/dist` | yes | `results/scatter-cull-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Asserts both builds hold the same instances. |
| Island demo with VFX | `node examples/package-benchmarks/vfx-island.mjs --variants=...` | yes | `results/vfx-island-*.json` | Needs variant builds. Not in the features suite. |
| Pipeline toggles | `node examples/package-benchmarks/pipeline-toggles/toggle.mjs [stall|pixels|gpu|override]` | yes | `results/pipeline-toggles.json` | Not in the features suite (needs `old-gltf.mjs` first for `pixproof`). |
| Every real-browser test | `node examples/package-benchmarks/gates/run-browser-tests.mjs` | yes | `results/gates-browser-tests.json` | 41 scripts; `modern-hardware-gpu-tests.js` needs `GPU_VENDOR` and a discrete GPU. |
| Light-tier pace and GPU reading (LIM-077) | `npm test --workspace @margoengine/quality` | no | console | A physical 100 Hz display shows it live: the voxel sandbox's HUD with `?seed=1`. |
| Bulk transform writes against setters | `node packages/scene/scripts/bulk-bench.mjs 10000` | no | console | CPU only; build the package first. |
| Engine bridge sync, four cases (perf-history entry 74) | `npm run build --workspace packages/ecs`, then `node packages/ecs/scripts/bridge-bench.mjs` | no | console | CPU only. |
| Every three.js parity row (perf-vs-threejs) | `npm run build:packages`, then `npm run bench:parity` | yes | `docs/whitepaper/perf-vs-threejs.md`, `.json` | The ledger keeps every run. The numbers below are diagnostic until a quiet run. |
| One parity row (perf-history entries 56 to 60, 63, 65 to 69) | `node bench/cli.mjs parity --cases=<scene> --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` | yes for frame scenes | `benchmarks/runs/<id>.json` | Scenes: `p-morph`, `p-morph-compiled`, `p-stl`, `p-stl-normals`, `p-skeleton-clone`, `p-gpu-pick`, `p-gpu-pick-batch`, `helmet`, `p-motion-blur`, `p-motion-blur-velocity`, `p-custom-shader`, `p-rect-area`, `p-pmrem`, `p-pmrem-refresh`, `p-export-usdz`. Each entry names its own engines and runs. |
| Instanced and moving boxes against three.js (entries 50, 51, 53, 54) | `npm run bench -- instanced --engines=margo,three-webgl,three-webgpu --runs=3` and `npm run bench -- dynamic --engines=margo,three-webgpu --runs=3` | yes | `benchmarks/runs/<id>.json` | |
| Polygon offsets (entry 52) | `npm run build` in `packages/geometry`, then `node packages/geometry/scripts/polygon-bench.mjs` | no | console | |
| Not repeatable by a script yet | - | - | - | The `Spring` timing (entry 55), the WebGL2 CPU tier's interpreter (entry 72) and the path tracer on the layer (entry 73). Each is on the re-measure list. |
| WebP and DDS against outside decoders (LIM-285) | `npm run build:packages`, then `node packages/decoders/scripts/test-real-textures.mjs <empty folder>`: downloads the files of `packages/decoders/tests/real-files/manifest.json`, checks each SHA-256, and compares with the planes dwebp 1.4.0 wrote and with Pillow's PNGs | no | prints the counts, exit 1 on any difference |
| Held textures in Blender (LIM-285) | In Node serve a Khronos glTF-Sample-Assets model folder over HTTP, `loadGLTF(engine, url, {ktx2: nodeKTX2, maxDownloadBytes: 2 ** 29})`, `exportOBJ(engine, {materials: true, textures: true})`, `await writeTextures(result)`, write the files. In Blender `wm.obj_import`, then compare each material's image with the model's source image at `Non-Color`, per channel | no | largest and mean difference of 255 |
| OBJ, STL and PLY of loaded models in Blender (LIM-277) | On a real page `loadGLTF` a GLB, then `exportSTL(engine)`, `exportPLY(engine, { binary: true })` and `exportOBJ(engine, { materials: true, textures: true, mtlName: 'tex.mtl' })`. In `blender --background --factory-startup` read the source with `import_scene.gltf(guess_original_bind_pose=False)` and the others with `wm.stl_import`, `wm.ply_import` and `wm.obj_import(forward_axis='NEGATIVE_Z', up_axis='Y')`, leaving out the glTF importer's `glTF_not_exported` collection, and compare world bounds. Use models with no clips: a source with clips imports posed. For the OBJ, connect each material's base colour to an emission surface, multiply `map_Kd` by `Kd` decoded from sRGB, draw source and OBJ with Cycles from one orthographic camera and compare pixels | no | console | Blender is run by hand. |
| COLLADA in Godot and SceneKit (LIM-284) | On a real page `loadGLTF` a GLB and `exportDAE(engine)`. Put the file in an empty Godot 4.7 project, run `--headless --import`, then load it from a script and add up `surface_get_array_index_len`: robot-expressive gives 9,711 and no `Multiple instance_*` error. On a Mac open it with `SCNScene(url:)` and count `geometry.elements`: 19 groups in 14 geometries. | Godot 4.7.2, macOS 27 SceneKit |
| `decodePNG` on PngSuite (LIM-093) | `npm test --workspace packages/headless`: each file's pixels hash to what `packages/headless/tests/fixtures/pngsuite/chromium.json` holds. To remake that file, load each PNG in Chromium with `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`, upload it to a WebGL2 texture and `readPixels` | no | console | Reading through WebGL keeps alpha unpremultiplied, which a 2D canvas does not. |
| Compressed GLB in Blender and Godot (LIM-243, LIM-250, LIM-258, LIM-262) | In Node run `compressDraco`, `compressMeshopt`, `optimizeGLB` and `compressTextures` on Fox, robot-expressive, RiggedFigure, MorphStressTest, flight-helmet, scifi-helmet, NegativeScaleTest, OrientationTest, ToyCar and Lantern. In `blender --background` import each with `bpy.ops.import_scene.gltf`, then compare meshes, triangles, materials, images, bones, clips and world bounds with the source. Put the files in an empty Godot 4.7 project, run `--headless --import`, then add up `surface_get_array_index_len` from a script and compare with the source | no | console | Godot has no Draco or meshopt support and refuses those files. Blender has no `KHR_texture_basisu`. Run by hand, 2026-11-06, Blender 5.3 and Godot 4.7.2. |
| Blender add-on in real Blender (LIM-287) | `MARGO_BLENDER=<path to blender> npm run modern:test:blender` after `npm run build:packages` | yes | console, `test-results/blender/` | Not in the checks: Scott has not cleared Blender for them. Run by hand, 2026-11-06, Blender 5.3 and an RTX A6000. |
| USDZ on real models against Apple's tools (LIM-253) | Export with `exportUSDZ`, then on a Mac `usdchecker --arkit model.usdz` and `usdcat --flatten model.usdz -o flat.usda`; take each `Mesh_<i>`'s points through its `xformOp:transform` and compare with the source nodes | no | console | By hand, on a Mac. |
| USDZ in Blender and Quick Look (LIM-095, LIM-253) | `exportUSDZ(bytes)` each GLB. `blender --background --factory-startup --python tools/real-proof/blender_report.py -- out.json a.glb a.usdz` for source and file, then `node tools/real-proof/glb_bounds.mjs a.glb` where the two disagree: Blender's rest pose drops bone scale (robot-expressive) and its GLB import leaves a model at a clip's first frame (CommercialRefrigerator, door ajar). On a Mac `usdcat --flatten` and count Mesh prims; `tools/real-proof/quicklook_thumbnails.swift`, one file at a time | no | console, PNG | By hand, 2026-11-06. Thumbnails are read by eye. |
| Cloud saves on Apache (LIM-418) | Run Apache with `mod_dav` and `mod_dav_fs`, `Dav On` on a folder, on a local port, then `node packages/save/tests/apache-check.mjs http://127.0.0.1:<port>/<folder>` after `npm run build --workspace @margoengine/save` | no | console | By hand, 2026-11-07, Apache 2.4.67 on macOS. |
| Safe writes on POSIX disks (LIM-414) | On macOS or Linux, `node --test packages/save/tests/file-storage.test.js packages/save/tests/safe.test.js` after a build | no | console | By hand, 2026-11-07, macOS APFS and Linux ext4; `npm test` holds the same tests on the machine it runs on. |
| Safari on a Mac (LIM-026, LIM-233) | `tools/real-proof/README.md`, `safari/`: the same `dist` in Safari and in Edge, then compare the pictures the page posts | no | `report.json` | By hand, 2026-11-06, Safari 27.2 on an Apple M6 and Edge 156 on an RTX A6000. |
| EXR in Blender (LIM-094) | In Node `encodeEXR` a 17 by 9 float image with values to 1,000 and alpha, `half` and `float`. In `blender --background` load each with `bpy.data.images.load`, set `alpha_mode = 'CHANNEL_PACKED'`, `reload()`, and compare `image.pixels`, whose rows run bottom up | no | console | Without `CHANNEL_PACKED` Blender multiplies colour by alpha. |
| Real files in Blender (LIM-208) | `REAL_FILES_ONLY=ply,stl,obj,usd npm run test:real-files -w @margoengine/loaders`, then `tools/real-proof/blender_report.py` on what it downloaded and compare bounds; OBJ and USD turn Y up to Z up | no | console | Spider_ascii.stl: Blender merges 56 of the file's 1,368 triangles, the reader keeps them. |
| State machines against Sismic (parallel regions and what follows) | `python -m venv <folder>`, `<folder>/Scripts/python -m pip install sismic==1.6.14`, `npm run build --workspace @margoengine/fsm`, then `MARGO_SISMIC_PYTHON=<folder>/Scripts/python npm run test:outside --workspace @margoengine/fsm` | no | prints charts, steps, moves and differences; rewrites `packages/fsm/test/outside/traces.json` | Exit 1 on any difference. `npm test` replays the recorded traces with no Python. |
| Meshopt export on real models against outside tools | `compressMeshopt` a GLB, then `gltfpack -i out.glb -o back.glb -noq` and `gltf-transform inspect out.glb`; decode each stream with the `meshoptimizer` package's `MeshoptDecoder.decodeGltfBuffer` and run the Khronos validator on the result | no | console | By hand; no script in the repository. |
| GLB optimize on real models against outside tools | `optimizeGLB` a GLB with its defaults and with `{ simplify: 0.5, lods: [0.5, 0.25] }`, run the Khronos validator on input and output, then `gltfpack -i out.glb -o back.glb -noq` and `gltf-transform inspect out.glb`; compare the triangles of each node, corner by corner, and each level's vertices with the source's | no | console | By hand; no script in the repository. |
| USDZ real size on real models (LIM-265) | `exportAnimatedUSDZ` each clip and read `size` and `bounds`; compare `bounds` with glTF maths at every frame, node transforms and skinning applied, weights normalized. On a Mac, load the file with RealityKit's `Entity(contentsOf:)` and read `visualBounds(relativeTo: nil)`, and render with `usdrecord --sessionLayer cam.usda --camera Cam -f <frame>` through one fixed camera to compare a file before and after a change. On an iPhone, open the file in AR Quick Look, place it on a floor and check it stands in view at about 2 m and moves with a drag | no | console | By hand; no script in the repository. RealityKit's bounds do not run the skeleton, so they read the rest points. Only the phone shows placement, clipping and moving. |
| USDZ animation on real models against Apple's tools | `exportAnimatedUSDZ` each clip of a rigged GLB, then on a Mac `usdchecker --arkit out.usdz` and `usdcat --flatten out.usdz -o flat.usda`; evaluate the flattened skeleton and Xforms by UsdSkel's rules at a few frames and compare the world bounds with glTF's skinning maths; load it in ModelIO, SceneKit and RealityKit | no | console | By hand; no script in the repository. |
| USD composition against OpenUSD (LIM-303) | Run `packages/usdz/tests/oracle/truth.py` inside Blender's Python on a list of files, for example `blender --background --factory-startup --python packages/usdz/tests/oracle/truth.py -- list.txt truth.json`, then open each file with `composition()` and compare meshes, world bounds, triangle counts and bound materials. `tests/oracle/generate-stages.py` writes stress stages. |
| UsdSkel against OpenUSD (LIM-310) | `packages/usdz/tests/oracle/skel-truth.py` inside Blender's Python on a list of files gives each mesh's points at five times through `UsdSkel.Cache`, `SkinningQuery` and `BlendShapeQuery`. Parse the same file with `skeletons()`, pose it by plain glTF rules (`packages/usdz/tests/pose.js`) and compare point by point. Apple's and Pixar's samples are read from a local download. | yes |
| Time samples against OpenUSD (LIM-315) | `packages/usdz/tests/oracle/anim-truth.py` inside Blender's Python on a list of files gives each moving prim's world matrix and visibility at several times through `UsdGeom.XformCache` and `ComputeVisibility`. Parse the same file with `animation()`, pose it by plain glTF rules (`packages/usdz/tests/pose.js`) and compare matrix by matrix. The usd-wg files are at commit 091bb5c6; Pixar's are read from a local download. | yes |
| Subdivision against Blender (LIM-319) | `packages/usdz/tests/oracle/subdiv-truth.py` (points) and `subdiv-uv-truth.py` (face-varying values, in the mode each mesh authors) run inside Blender 5.3 on a list of files and give refined points and corners through its Subdivision Surface modifier, with `use_limit_surface` off. `subdiv-faces.py` writes the stand-in stage and its truth in all six modes. Parse the same files with `subdivision({level:2})` and pair corners by nearest point, not by a rounded key. Real meshes of the Kitchen Set, OpenChessSet, usd-wg assets and HumanFemale are read locally; two usd-wg files are committed. |
| Lights and cameras against OpenUSD (LIM-320) | `packages/usdz/tests/oracle/lux-truth.py` inside Blender's Python gives each light's and camera's world matrix through `UsdGeom.XformCache`, each camera's frustum through `Gf.Camera`, and `UsdLux.BlackbodyTemperatureAsRgb`. Parse the same stages with `lights()` and compare node world matrices under the root node. The 55 real stages are the files of the usd-wg assets that hold lights or cameras, read locally. |
| Reset transform stacks against OpenUSD (LIM-324) | `packages/usdz/tests/oracle/reset-truth.py` inside Blender's Python writes the stand-in stage and what OpenUSD computes for it into `tests/fixtures/xform/`; `node --test packages/usdz/tests/reset.test.js` compares. |
| MaterialX in USD against OpenUSD (LIM-331) | `packages/usdz/tests/oracle/materialx-truth.py` inside Blender's Python writes what `UsdShade` reads from each material, with the shader registry's defaults, to `tests/fixtures/materialx/openusd.json`; `node --test packages/usdz/tests/materialx.test.js` compares. 53 of the 58 materials are in stored files; the two large stages, `StandardShaderBall/layers/shaderball.usda` and `MaterialXTest/basicTextured_flatten.usda` of the usd-wg assets, are read when copied beside them. `npm run modern:test:usdz:browser` compiles the networks on the GPU. |
| 3MF on real models against a slicer and Windows | `export3MF` a GLB, then `prusa-slicer-console --info out.3mf` and `prusa-slicer-console --support-material --export-gcode --merge --scale-to-fit 150,150,150 --center 100,100 --output out.gcode out.3mf` (without `--support-material` for the 22 of 26); for a print-ready model, read https://github.com/CreativeTools/3DBenchy `Single-part/3DBenchy.stl` with `parseSTL`, `export3MF` it with `upAxis: 'z'`, and slice both with `--export-gcode --center 100,100`, comparing layers and filament; load it with `Windows.Graphics.Printing3D.Printing3D3MFPackage` and compare unit, triangles, items and colours with the file written | no | console | By hand; no script in the repository. |
| FBX cameras and lights from Blender | `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-shot.py -- <folder>` writes the two FBX files and Blender's own numbers as JSON; `node --test packages/fbx/test/scene-extras.test.js` compares them after `npm run build --workspace @margoengine/fbx` | no | console | Blender is run by hand; the fixtures and its numbers are checked in. |
| FBX UV sets and colour layers from Blender | `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-layers.py -- <folder>` writes the FBX and Blender's own values as JSON; `node --test packages/fbx/test/layers-option.test.js` compares them after `npm run build --workspace @margoengine/fbx` | no | console | Blender is run by hand; the fixture and its values are checked in. |
| FBX inherit types against Maya | `node --test packages/fbx/test/inherit.test.js` after `npm run build --workspace @margoengine/fbx` compares a converted rig, posed by plain glTF rules with its skin, with the eight OBJ frames Maya wrote (`packages/fbx/test/fixtures/real/`) | no | console | Sources and sums in that folder's NOTICE.md. |
| FBX animation layers against Maya | `node --test packages/fbx/test/layers.test.js` after `npm run build --workspace @margoengine/fbx` compares a converted clip, posed by plain glTF rules, with the OBJ frame Maya wrote (`packages/fbx/test/fixtures/real/`) | no | console | Sources and sums in that folder's NOTICE.md. |
| FBX PBR materials from Max and Maya | `node --test packages/fbx/test/pbr.test.js` after `npm run build --workspace @margoengine/fbx` reads real 3ds Max and Maya files. |
| FBX curves and deformers against Max and Maya | `node --test packages/fbx/test/curves.test.js packages/fbx/test/deformers.test.js` after `npm run build --workspace @margoengine/fbx` reads real files and Maya's OBJ frames. |
| FBX camera and light export in Blender | Write a scene with `exportFBX`, then `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-read-export.py -- /absolute/file.fbx /absolute/out.json` and compare the JSON with the scene, Blender's axes being x, -z, y. |
| WebTransport in a real browser against a real HTTP/3 server | `python -m venv <folder>`, `<folder>/Scripts/python -m pip install aioquic==1.7.2`, `npm run build --workspace @margoengine/netcode`, then `node packages/netcode/tests/webtransport-proof/proof.mjs <folder>/Scripts/python`. It starts `server.py`, opens the built `openWebTransport` in Playwright's Chromium, and prints each message and `proof passed` | no | console | By hand, 2026-11-07 |
| Unit tests, API snapshots, size gate | `npm run verify` | no | console | `npm run verify:full` adds packed-package and interop suites. |

## A second machine

On a discrete-GPU desktop or a Mac: the setup above, then `npm run bench` and `npm run bench -- features`, and
keep the `benchmarks/runs/` folder. On Linux or macOS the AC check returns `null` (recorded, not enforced). Set
`MARGO_BROWSER=chrome` where Edge is not installed. On macOS, `MARGO_BROWSER=webkit` runs the browser suites in Playwright's
WebKit build, which has WebGPU there (`npx playwright install webkit`). That is not Safari. Phones are not scripted yet.

## Own 2D four-pair narrow phase (perf history entry 92)

The Rust kernel's batch API has a runnable doctest in `kernel/src/manifold/four.rs`; the package's JavaScript
Rapier facade is unchanged. From the repository root, with cargo on PATH:

```sh
npm run test:physics2d-kernel
npm run check:rust-kernels -- --packages=physics2d
cargo test --locked --release --manifest-path packages/physics2d/kernel/Cargo.toml --test manifold_exact -- --ignored --nocapture narrow_ab
```

The ignored benchmark compares current scalar collision and four-pair collision on the identical 14,950-pair
pyramid snapshot, checks every output bit first, alternates first position per visit, and prints the minimum of
five visits per round for 30 rounds. The normal exactness tests still compare both paths with the untouched kept
reference. For a whole-step Wasm A/B, build the baseline and new `kernel/wasm-check/Cargo.toml` with `--locked
--release --target wasm32-unknown-unknown` and `RUSTFLAGS=-C target-feature=+simd128`, keeping the two modules.
Instantiate both in one Node process, require every `check(i)` to return zero, then in each of 24 rounds create a
100-row pyramid, settle 60 steps and take the minimum of the next 40; alternate which module goes first each round.
Lane P's local driver is `.lane/p/ab-wasm.mjs old.wasm new.wasm 24`. The committed
[record](results/physics2d-four-pairs-20261108.json) contains every round and the separate phase-probe rows.

For the browser comparison set `BOX2D_WASM` to the existing external `box2d3-pyramid.mjs` black box,
`REPLAY_FIREFOX` if needed, and `MARGO_GPU_EXCLUSIVE=1`; run
`node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=12` before and after, preserving
the JSON report from each run. Edge WebGPU/WebGL2 and Firefox WebGL2 passed the pinned bits here; Firefox WebGPU
has no adapter and remains unrun. All timings are diagnostic on the loaded SCOTT-DEV machine; a quiet rerun is
required for release numbers. The target 0.35 ms narrow phase and the Box2D speed gap remain open.

## Own 2D certified faces and solver study (perf history entry 101)

The existing kernel doctest and package examples remain runnable. From the root, with cargo on PATH:

~~~sh
npm test --workspace @margoengine/physics2d
npm run test:physics2d-kernel
npm run check:rust-kernels
npm run check:readme-run -- --packages=physics,physics2d
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --lib -- --nocapture
~~~

The last command prints `FACE_INTERVAL_TOTAL` for frames 60–99; the ordinary parallel unit test asserts positive
whole-window work reduction. Interpret the bound as `32*hits - 2*attempts` squared-distance candidates, not saved
sqrt calls. `tests/manifold_exact.rs` compares all fields against the unchanged kept reference, including the
new nextafter thresholds and public mutations. `tests/common.rs` checks IEEE lane equality, including NaN and zeros.

Build `kernel/wasm-check/Cargo.toml` at baseline `7fd5a9547` and current using `--locked --release --target
wasm32-unknown-unknown` with `RUSTFLAGS=-C target-feature=+simd128`; retain each module in your own worktree.
Use the same one-process 24-round A/B procedure described for entry 92, require the original three hashes and
5,050 awake bodies, settle 60 and take the minimum of 40 steps in every round, alternating old/new first.
For three variants rotate all six permutations equally. Lane P's retained driver is `.lane/p/metadata-ab.mjs`.

For browsers set `BOX2D_WASM` to the existing external black box and `REPLAY_FIREFOX` if needed, then:

~~~sh
node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=12
~~~

Set `MARGO_GPU_EXCLUSIVE=1` for that timing run. Preserve `test-results/physics2d-kernel-browsers.json` before and
after. Firefox WebGPU without an adapter remains unrun. All raw rounds and acceptance outcomes are in
[the record](results/physics2d-certified-faces-20261108.json); failed solver sources remain isolated in Lane P,
with paths and formulas in the [study](../architecture/physics2d-solver-study.md). They are not production options.
The 1:1000 contact extension is a new failing baseline diagnostic, not a passed bar. Existing 1:1000 joints and
3D CCD run in the full Rust gate. Loaded timings are diagnostic; no Box2D parity or release speed is claimed.

## Own 2D input validation

The public direct solver boundary is covered by
`cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test solver_input`.
On bf40, the count-three direct-call regression panics at `solver.rs:371`; current callers receive the
coded parameter error. Related tests cover handles, ownership, finite inputs, derived overflow, recovery
and valid direct-call results. `World::step` retains one preflight and its original output/sleep scans.

From the repository root, with cargo on PATH, run the checked raw Rust API regressions, complete retained-reference
collision comparisons, valid native hashes and the existing collision doctest:

```sh
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test input -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test rotation_input --test contact_metric_input -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test point_velocity_input -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test manifold
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test manifold_exact -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test bits -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --doc
npm run test:physics2d-kernel
npm run check:rust-kernels -- --packages=physics2d
npm run check:readme-run -- --packages=physics2d
```

Use the repository's hard process-tree timeout runner for these commands; a hang is a failure. The input suite
covers nonfinite definitions/current state, checked material domains, positive mass/inertia underflow, derived
overflow, invalid handles and transactional body/shape/whole-chain creation.
The directed input cases also reproduce the formerly panicking MAX-density effective reciprocal and finite
`1e20` friction-product overflow, check negative used normal caches and staged origin rollback, and exercise
both scalar and SIMD contact modes. The original closing-speed overflow already returned an error; its case
guards that behavior without claiming a newly reproduced panic.
`rotation_input` covers huge/subnormal finite pairs, large finite angular velocity at one substep, nonfinite
integration arithmetic and zero stored body rotation. `contact_metric_input` uses two fixed-rotation unit boxes
of density `4e-39`: each inverse mass is finite, but their sum overflows. The pre-edge input implementation
accepted that step without collision response. All five strengthened tests fail on the retained first input
implementation (`.lane/p/rotation-baseline`, archived from `f8d812a6330c4cf05fb1153e21246cccc670dd71`);
the final normalization/setup guards must pass them. Logs retain the initial four-substep rotation test's false
negative: zero and identity alternated, so the regression was strengthened to inspect a single substep.
An API-independent four-case behavioral extraction also compiles on verified `47f81f909`: all four fail at
runtime there and the identical extraction passes against current code. It checks finite-pair direction,
single-substep dynamic/kinematic rotation, refusal before a zero-rotation step advances, and pair-metric overflow
before interpenetration. Baseline/green logs and provenance are retained under `.lane/p/verified_main_rotation_metric_*`.
`point_velocity_input` covers the separate derived contact-velocity overflow. Checked circle construction,
finite individual inverse metrics and a real floor contact all succeed; `omega*radius` then overflows, so the
step must return `ArithmeticOverflow`. The pre-guard diagnostic returned success in all four scalar/SIMD/radius
cases (`.lane/p/point-velocity-probe`), despite NaN normal approach. The row builder now refuses it before a NaN
comparison can invent zero response.
`manifold_exact` includes scalar and four-pair nonfinite cutoff/pose refusal, missing-candidate and finite-overflow
cases alongside the unchanged
whole-field reference comparisons. The ordinary full kernel run also exercises the independent geometry cases
and current public-array/handle preflight. The three Wasm `check(i)` calls first run invalid-input checks and then
compare the unchanged production hashes:

```text
9ffefc83c3a99be4
95a47530df180011
9acb68471fbe6ba0
```

For the behavioral before/after proof, `nonfinite_body_creation_does_not_publish_a_body` and
`invalid_density_does_not_publish_a_shape_or_nonfinite_centre` in `kernel/tests/input.rs` deliberately use
assertions that also compile against the former infallible API. Copy these two tests into `tests/input_repro.rs`
of an isolated copy of `47f81f9090eb9cdec62247d2c315a2e33e9472bb`, retaining its own shared kernel-common package.
Lane P retained that copy under `.lane/p/input-baseline` and ran:

```sh
cargo test --locked --manifest-path .lane/p/input-baseline/packages/physics2d/kernel/Cargo.toml --test input_repro -- --nocapture
```

That baseline command is **expected red**: both `nonfinite_body_creation_does_not_publish_a_body` and
`invalid_density_does_not_publish_a_shape_or_nonfinite_centre` fail (0 passed, 2 failed, exit 101), with no timeout;
the retained log is `.lane/p/input-baseline.log`. The current checked API must pass them. Do not change the
baseline assertions to accommodate its unsafe publication behavior.

The actual collision panic reproduction on that commit combines a NaN pose and NaN speculative cutoff; the
literal review call with a finite cutoff returns empty here. Preserve this distinction when reproducing the
zero-hit-mask/absent-candidate bug. The fixed public call returns `PhysicsError::NotFinite`; internal guards also
refuse missing candidates or unrepresentable arithmetic before an index is used. These commands document the
checks, not a claim that final landing gates have already run. No speed comparison or hash re-pin accompanies
this input fix. The separate support correction below deliberately changes the mixed pin; CCD stays with T-11 / 127.y.

## Own 2D sustained support

The required native 1:1000 test in `kernel/tests/world.rs` is an exact extension of the 1:100 fixture: top mass 1000,
matching column loads/inverse mass, and name/output label change. The 3% sag, 1e-4 m top drift, 0.01 m final movement
from the one-second sample and sleep-by-end predicates are unchanged. It fails at runtime on verified 47f81f909 with
1.186208290 m sag versus 0.518550736 m and 92.105 mm creep; current sag is 0.518550681 m, creep 0, asleep at 0.8833334 s.
No named original physical test is removed or weakened.

Run each command with a hard process-tree deadline (the complete Rust gate supplies one):

~~~sh
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --lib -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test world --test chain --test joints -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test support_domains --test support_joint_interaction --test support_numeric -- --nocapture
npm run test:physics2d-kernel
npm run check:rust-kernels
node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=0
~~~

The private per-visit SIMD shadow additionally runs original fixtures and production pins, with no copied
ignored timing test. The ordinary ignored native timing test remains a separate paired benchmark.
Lane P's instrumented collector uses the same 67 assertion-body digests as the post-input control, with 29 cases
per mode and strict missing/duplicate/failure checks. It recognizes the shipped mandatory 1:1000 test instead
of adding a duplicate; CCD is explicitly outside its scope. Pre-input 7fd5a9547 differs only by the necessary
`world.angle(slider).unwrap()` API migration in one numeric assertion; the other 66 bodies are byte-identical.
Current final source must pass all 29; a per-point experiment is not accepted from a partial matrix.

Wasm `check(0)` additionally runs the same 1:100 and 1:1000 sag/x-drift/creep/sleep predicates in
`kernel/wasm-check/src/support_bars.rs`, including the native fixture's 599-step truncation and snapshot
before step 60. Failure returns code 4. `checks()` remains three; pinned scenes and benchmark workloads are
unchanged. Native diagnostics exercise actual scalar and SIMD paths; the shipped Wasm build always uses
SIMD, including when its stored `contact_lanes` setting is false. Native and Wasm stack metrics agree.
On the archived input-fixed main `147c6d33a`, adding only this new checker/helper makes the official Node
Wasm gate fail `check(0)` with code 4 while all three original scene hashes remain unchanged. Its 1:1000 sag
is 1.186208290 m and creep 92.105 mm. This independently isolates the previously missing accuracy bar from
the deliberate mixed-scene re-pin. Lane P retains source provenance and red/green modules in
`.lane/p/support-wasm-final/handoff.json`.

The deliberately accepted scene pins are:

~~~text
pyramid:   9ffefc83c3a99be4
joint grid: 95a47530df180011
mixed:     92db6847c4e919d4   (previous: 9acb68471fbe6ba0)
~~~

This is a result-changing correctness baseline. The commit names the mixed re-pin and its reason, and runs
scalar/SIMD, shipped simd128 Node Wasm and available browser-bit paths. Firefox WebGPU without an adapter is
unrun. No prior speed result is transplanted onto this baseline. Future timings must use paired A/B with the
same scene/work and disclose the cost of support planning/correction; no speed claim accompanies this fix.

For the separate constitutive bending analysis, run `kernel/examples/support_bending.rs` using the
[documented 180-second process-tree wrapper](../architecture/physics2d-support-bending.md). It never steps the
solver. Exit 0 confirms its contact/force domain and prints the directional derivative, not a passing solver
instability condition. The proof states the nonlinear/f32/discrete-trajectory limits. CCD remains T-11 / 127.y.

## Extruded text repair, LIM-587 (2026-11-08)

Run `npm test --workspace @margoengine/text`, then `npm run check:text-extrude`. These cover hostile/malformed
font inputs, every Type 2 curve family and shared subroutine state, quadratic midpoints, raw-point/scaled-offset
composites, nonzero overlaps, complete hole caps, outward volume, closed bevels, small text and the README example.
The Source Sans 3 assets and licence live in `packages/text/tests/fixtures/fonts/`. The all-glyph test checks all
2,478 glyph indices in each TTF/OTF, including nine empty glyphs. To regenerate the independent frozen cubic
controls on Windows, run `python packages/text/tests/generate-outline-reference.py`; its head-table assertion
rejects a substituted system face. Portable Node tests compare ten glyphs per format with independent de Casteljau
sampling and an analytic chord-error bound. No speed comparison is claimed.

For both WebGPU and the native WebGL2 mesh output assertion:

~~~sh
node scripts/gpu-lock.mjs run --owner=codex-extrude --max=10 --wait-max=5 -- node packages/text/scripts/test-browser.js
node scripts/gpu-lock.mjs run --owner=codex-extrude --max=10 --wait-max=5 -- npm run check:readme-run -- --packages=text
~~~

The browser report includes orange pixel count and hidden orange pixel count for WebGL2; calling render alone is
not a pass. CPU work has no benchmark here. Entry-size comparisons bundle the entry in isolation with Vite,
ES2022 minification and `compactOutput` from `scripts/measure-size.js`, then zlib default gzip. Include the shared
error helper on both sides; do not compare a standalone bundle to a split dist file.

## Own 2D retained planner buffers (perf history entry 106)

The [raw record](results/physics2d-planner-reuse-20261108.json) separates the cost of the preceding correctness
fix, the rejected nested-capacity trial, the accepted flat-buffer work reduction, and the rejected point-normal
replacement. Its browser rows are loaded-machine diagnostics. No benchmark source, scene, visit count, tolerance or
current pin is changed to obtain a speed result.

The committed native allocation probe includes the unchanged production `tests/support/bits_scenes.rs` scene.
Run it through the existing process-tree wrapper, with cargo on PATH:

~~~sh
node --input-type=module -e "import {runLimited} from './scripts/support/run-limited.mjs'; const r=await runLimited('cargo run --locked --release --manifest-path packages/physics2d/kernel/Cargo.toml --example planner_allocations',{cwd:process.cwd(),limitMs:180000,label:'2D planner allocations'}); if(!r.ok)throw new Error(JSON.stringify(r));"
~~~

For the allocation control, archive own commit `0b12da14aea0bc8a4c66f6ede58e8d3443f52259` into a new uniquely
named folder under this worktree's `.lane/`, preserving `packages/physics2d` and `packages/physics/kernel-common`.
Copy only the current `planner_allocations.rs` example into its kernel examples directory, then run the identical
bounded command with that archived manifest path. Both kernels retain their own opt-level 3, fat-LTO,
codegen-units 1 release profile. Lane P's retained controls are under `.lane/p/speed-plan-reuse/control`.

Only each single-threaded `World::step` is inside the enabled allocator interval. Frames 60 through 99 must each
print `WORK_FRAME <frame> 14950 119600 8 0 5050`, and both final rounded pose/velocity fingerprints must be
`a9134ec059727110`. Allocation/reallocation calls are 397,600 versus 200 across those 40 steps; requested bytes
are 77,114,920 versus 44,673,280. A reallocation counts its entire new requested size and old freed layout, not
copied bytes or peak/net resident memory. The allocation count is diagnostic, not a physical accuracy threshold.

The native unit suite also checks current topology rebuilds, fresh-versus-retained full-world results, multiple
component shrink/regrow, and fixed-V/E migrating hub/path storage. Run `npm run test:physics2d-kernel` and the
full `npm run check:rust-kernels`; the shipped Wasm still checks the mandatory contact-stack predicates and all
three current pins. No further pin changes accompany storage reuse.

For paired timing, build both own source snapshots with shipped `-C target-feature=+simd128`. Instantiate both
modules in one process, check each full explicit three-pin array, then alternate which runs first across 24
rounds. Recreate the unchanged 100-row world for every sample, settle 60 steps and take the minimum of 40 steps;
every settling/timed visit returns 5,050 awake bodies. Retain every round, order, difference, ratio, median, IQR
and spread. The exact local driver and immutable modules are under `.lane/p/speed-plan-reuse-flat-ab-v1`.
Do not overwrite the original evidence when reproducing it.

Use `BOX2D_WASM` with the existing external black-box build and `REPLAY_FIREFOX` as documented above, then run
`node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=12` under the exclusive GPU lease
and a hard 600-second process-tree limit. Preserve original scene and engine order. The before/after browser
sessions have different load and do not establish a controlled speed gain. Firefox WebGPU without an adapter
is unrun; owned-2D CCD remains separate T-11 / 127.y. Quiet release reruns are still required.

## Own 2D finite certificates (perf history entry 107)

The [IEEE proof](../architecture/physics2d-finite-certificates.md) identifies the two removed predicates and
the precise private caller contract. All arithmetic, settings, scene/work counts, physical predicates and
three pins remain unchanged. The [raw record](results/physics2d-finite-certificates-20261108.json) includes
the complete compiler inventories, source/compiler identities, decoded static relocations and every round.

Run the native and shipped Wasm checks with their existing hard limits:

~~~sh
npm run test:physics2d-kernel
npm run check:rust-kernels
~~~

The new private controls in `solver/wide_certificate_tests.rs` compare old and reduced certificate masks
after evaluating the actual caller expressions. They include partial live masks, four block answer forms,
both biased states, signed zeros, subnormals, extreme values, infinity and NaN bit patterns. The separate
retained-guard case covers finite-operand sum overflow, an infinite raw diagonal, used invalid soft state
and unused invalid soft state. Current physical tests and pins are not rewritten for this comparison.

For compiler reproduction, archive main `119d55a9a` and the entry-107 implementation into separate new own
worktree subdirectories, preserving the physics2d kernel/checker and shared kernel-common paths. Use the
same rustc 1.99.0 / LLVM 23.1.1 and Cargo release profiles on both. Build shipped simd128 checker modules
with `-C target-feature=+simd128`; use separate target directories and hard 180-second process-tree limits.
Native assembly/IR is emitted by `cargo rustc --locked --release --lib --manifest-path <kernel>/Cargo.toml -- --emit=asm,llvm-ir`
under the same bounded wrapper described for the allocation probe. Decode Wasm with Binaryen 132
`readBinary`/`emitText` only: do not optimize or rewrite the module before counting. The recorded function
index $111 and exact SHA-256 identities identify this compiler output, not a stable public function number.
Static opcode totals across branches are not dynamic instructions or CPU micro-ops.

Compare embedded filename/panic records and static address changes as well as code when source paths differ.
The named frozen flat control and rebuilt control have text-identical hot function $111; two other changed
constants reference the same decoded panic Location and string. The shorter live source paths relocate data
and BSS throughout code. These observations establish the named provenance without asserting raw binary
identity or performance independence from layout.

For timing, use the entry-106 unchanged-scene protocol: explicit full three-pin arrays, 24 alternating one-process
rounds, 60 settling steps and minimum of 40 steps, checking 5,050 awake bodies on every visit. The retained
driver/modules are `.lane/p/speed-cert-trim-ab-v1`; browser/rival 12-round outputs and statistics are
`.lane/p/speed-cert-trim-browser-v1`. Use new output paths rather than overwriting those records. The paired
ratio median 1.0001 and 12/24 faster establish no timing gain. CCD remains T-11 / 127.y; quiet release reruns
remain necessary, while current work continues without waiting for a quiet machine.


### Batch 168 OIT (perf history 109)

`node scripts/gpu-lock.mjs run --exclusive --max=6 --wait-max=2 --owner=codex-168 -- node packages/oit/scripts/rival-bench.mjs`
after building packages. External `engine-bench/batch-168/node_modules/@babylonjs/core` is version 8.33.0.
If absent, install with `npm install --prefix C:\Development\Projects\engine-bench\batch-168 @babylonjs/core@8.33.0`.
`MARGO_ENGINE_BENCH` overrides the engine-bench parent. The rival stays external. Oracle:
`node --test packages/oit/test/oit-reference.test.js`. Seven alternating rounds, per-round minimum;
busy-machine frame-plus-completion timings, not GPU-only timings. [Raw result](results/batch-168-oit.json).


### Batch 168 sky (perf history 110)

Create an external Python 3.12 venv:
`py -3.12 -m venv C:\Development\Projects\engine-bench\batch-168\mitsuba-venv`, then
`C:\Development\Projects\engine-bench\batch-168\mitsuba-venv\Scripts\python.exe -m pip install mitsuba==3.9.1`.
After building packages run
`node scripts/gpu-lock.mjs run --max=3 --wait-max=1 --owner=codex-168 -- node packages/sky/scripts/rival-bench.mjs`.
`MARGO_ENGINE_BENCH` overrides engine-bench; `MARGO_MITSUBA_PYTHON` overrides the interpreter.
Inputs and outputs stay in external batch-168/data/sunsky. scalar_rgb needs no LLVM vectorization;
this install reports an LLVM initialization warning but evaluates the scalar model successfully.
No timing is measured. [Per-case result](results/batch-168-sky.json).


### Batch 168 staging (perf history 111)

After building packages run
`node scripts/gpu-lock.mjs run --max=3 --wait-max=1 --owner=codex-168 -- node packages/staging/scripts/rival-bench.mjs`.
No external renderer installation is needed: a clean-room cosine ray tracer has an independent analytic
projected-solid-angle oracle (`node --test packages/staging/test/contact-reference.test.js`).
The actual canvas goes to ignored `test-results/staging-ray-reference.png`; all defaults are retained.
15,472 exposed-ground pixels, 4096 rays per pixel; no timing comparison. [Result](results/batch-168-staging.json).


### Batch 168 independent OIT path tracer

`node scripts/gpu-lock.mjs run --exclusive --max=6 --wait-max=1 --owner=codex-168 -- node scripts/rival-oit-cycles.mjs`
uses Blender 5.3.0 Beta at `C:\blender\blender.exe` (`MARGO_BLENDER` overrides), CPU, four threads,
1024 samples and seed 168. External Babylon setup is the same as entry 109. Inputs/EXR/float RGB and
both engine images stay under external engine-bench/batch-168/data/oit-cycles; `MARGO_ENGINE_BENCH`
overrides the parent folder. Hard Blender limit 240 s. The page is used for pictures; its extra timing
values are not collected or published here. [Retained result](results/batch-168-oit-cycles.json).

## Own 2D frame preparation (perf history entry 112)

The [proof](../architecture/physics2d-frame-preparation.md) states the same-stack bounds and monotone
eligibility contracts. The [raw record](results/physics2d-frame-preparation-20261108.json) retains the
compiler inventories/CFG excerpts, constituent and combined source identities, full acceptance and
all paired/browser rounds. Archive own baseline fc88da420 and the implementation into new own worktree
subdirectories, preserving physics2d kernel/README and shared kernel-common paths. Do not overwrite the
original evidence. Build matched shipped Wasm with unchanged Cargo release profiles, rustc 1.99.0 /
LLVM 23.1.1 and -C target-feature=+simd128 in separate target directories, hard 180-second process-tree
limits. Native LLVM/assembly uses cargo rustc --locked --release --lib -- --emit=asm,llvm-ir with the
same bounded wrapper. Static callee inventories and release control flow are distinct from test counters.

Run the existing native/package/full Rust gates with their hard deadlines. The private world_bounds_tests
compares checked/helper/original bounds and preserves malformed public/mutable input plus derived overflow.
The private planner_laziness_tests compares a verbatim eager reference, full traversal/workspace/Plan bits,
disconnected and retained transitions, and the unchanged 100-row frames 60 through 99. The actual
382,554-to-zero calls retain 1,192,000 edge traversals; no dynamic instruction ratio is inferred.

The complete-step [portable profile bundle](results/physics2d-step-profile-20261108/README.md) needs no
existing ignored lane files or Git metadata. Its README gives stage-only, matched-build and bounded
exclusive-profile commands against a source archive of fc88da420. All 51 original inputs are checked
modulo EOL; exact instrumentation and own harness/diagnostic sources, original failure and raw real-step
vectors are included. It uses 17 non-overlapping phases, 39 verified clock calls, raw outer/inner
residuals and approximate calibration. Phase shares include adjacent setup and cannot be converted
into a sum of marginal minima; 99.29%-busy absolute profile times do not replace rival benchmark rows.

For performance use the entry-106 unchanged-scene protocol: one process, 24 alternating rounds, explicit
three-pin arrays, 60 settling steps and minima of 40 steps, checking 5,050 awake after every visit. The
frozen driver/modules are .lane/p/frame-preparation-v2-ab-v1; use a new output path when reproducing.
Browser/rival rows use the original scene and black-box engines under an exclusive lease, 12 rounds,
hard 600-second process-tree deadline, with current full hash and awake assertions outside each timer.
The copied harness/provenance is .lane/p/frame-preparation-v2-browser-v1. Separate browser sessions
have changing load; the paired advantage belongs to the combination. Quiet release reruns remain
required. Box2D parity is open and owned-2D CCD stays T-11 / 127.y.

### Pixel batch 102 review fixes

Retained native/compatibility hardware and readback evidence: [pixel-review102.json](results/pixel-review102.json).

After `npm run build:packages`, run `npm test --workspace @margoengine/pixel` for pipeline identity, scene/resource ownership, scissor intersections, huge cycle shifts, overflow errors and the architecture evidence check. Run `node scripts/gpu-lock.mjs run --owner=codex-pixel --max=12 --wait-max=2 -- npm run test:gpu --workspace @margoengine/pixel` for all five pixel GPU harnesses, including shared format/disposal/scissor regressions and the 154-size exact CRT/nearest sweep. Repeat with environment `MARGO_COMPAT=1` for the WebGL2 layer. Each CRT all-off sample is checked byte for byte against rational nearest and PixelScale, including exact boundaries; no sample is skipped. GPU result files are `test-results/pixel-browser.json`, `palette-browser.json`, `render3d-browser.json`, `pixel-scale-browser.json` and `pixel-crt-browser.json`; native and compatibility runs overwrite those local files, so retain copies between runs. No speed measurement is claimed.


## Batch 160 metallic-roughness

Build packages first. Set MARGO_ENGINE_BENCH to the outside engine-bench folder if it is not
C:/Development/Projects/engine-bench. No third-party renderer source is read or imported into Margo.

~~~sh
node scripts/reference-rendering/fetch-assets.mjs
node scripts/gpu-lock.mjs run --owner=codex-160 --max=5 --wait-max=5 -- node scripts/reference-rendering/run.mjs --capture-reference
node scripts/gpu-lock.mjs run --owner=codex-160 --max=5 --wait-max=5 -- node scripts/reference-rendering/run.mjs
node scripts/gpu-lock.mjs run --owner=codex-160 --max=5 --wait-max=5 -- node scripts/reference-rendering/run.mjs --compat
node --test --test-timeout=30000 tests/reference-rendering.test.js
~~~

The first GPU command operates the hosted Sample Viewer through its public controls, selects the embedded camera,
turns IBL and environment background off, keeps punctual lighting on and exposure 1, selects Khronos PBR Neutral,
sets black background, and downloads its PNG. This avoids including the UI toggle button in a canvas screenshot.
Reference images, original asset/legal notice, matched GLB and viewer metadata stay under
engine-bench/batch-160. The model is pinned at glTF-Sample-Assets commit
8f492390ddc7a2ae221a1369ef560589cf8c70fb; source, scene and PNG hashes are in the raw result.
The viewer's deployed JS resource identifier is recorded as provenance, never read as source. A changed viewer
picture fails the reference hash check; do not replace its baseline to pass. Recover the frozen PNG from the
recorded outside folder for the exact historical comparison. Remote deployment changes are not a Margo regression.

The scene preserves all materials/geometry and original roots, adding a 1000x root scale, a 35-degree camera
at [12,9,18] looking at [3,3,-1.5], and a white directional irradiance 3 from normalized [0.4,0.7,0.6].
Both renderers use 512 x 512, DPR 1 and 4x MSAA. Error counts every RGB channel of every pixel including
background, text and silhouettes, after the same display transform. No crop, registration, fitted exposure,
per-material exclusion or path-tracer claim is made. Foreground is the union of all nonblack pixels.
The compatibility run installs Margo's WebGL2 compatibility device; native WebGL2 is independently asserted
to reject PBR with code unsupported. This job does not rerun batch 168 OIT, sky, staging or lightmap.
--measure is for collecting a new scene before establishing its budget, not accepting a failed existing test.

### Batch 160 clearcoat

Use the job 1 commands with `--case=clearcoat`, including the asset downloader and both backend
runs. New camera/scale settings are in scripts/reference-rendering/cases.mjs. The complete original
scene, geometry, material factors and textures are preserved. All 27 primitives load; 19 draws are submitted. The camera is [-1.5, 0.3, 25] looking at
[-1.5, 0.3, 0], 35 degrees; scale 1, sun [0.4, 0.7, 0.6], intensity 3, IBL off, background black.
Frozen reference 49a82f5e1990209481b28f3bf64afc390e407e2eb9ab3571cb904a28ab4bdd09.
The recorded outside legal README credits Ed Mackey / Analytical Graphics, Inc. under CC-BY-4.0.
`--measure` now refuses an established result file, preventing accidental budget replacement.
See [the skip audit](../work-lists/batch-160-skips.md) for all 14 former missing-data skips and setup.

### Batch 160 sheen

Use the metallic-roughness commands with `--case=sheen`, including fetch, capture and both
backend comparisons. This is Khronos SheenTestGrid (the sample asset name, rather than the
plan's shorthand SheenTest), pinned at 8f492390ddc7a2ae221a1369ef560589cf8c70fb.
The legal README credits Eric Chadwick, 2023, CC0-1.0. Every source primitive and material
is preserved. Camera [-0.18, 0, 1.8] targets [-0.18, 0, 0], 35 degrees, near .01, far 100,
scale 1; the same sun as job 1. Frozen reference PNG SHA-256: 240715ff0a53416190448056a5aa7eeb767a0d7b2f52aa0a0a77e4ca17dc529a.
The default gltf-pro physical path is measured; shared/sheen.js is also used by materials.
No standalone material or IBL equivalence follows from this direct-light picture.

## Batch 99 emissive resampling accuracy

After `npm run build:packages`, run `node scripts/gpu-lock.mjs run --owner=restir-proof --max=10 --wait-max=10 -- npm run test:gpu:restir --workspace packages/voxel-pathtracer`.
The generated scene contains 1,024 contiguous emissive ceiling voxels, a white floor and a fixed orthographic camera.
The unchanged 16 x 16 image, seed 17, 32 samples and 8 candidates must have less than half the original tracer's
squared RGB error against its 8,192-sample seed-987 reference. The score sums all 768 channel errors; it is not MSE.
The driver also checks baseline identity at one candidate, finite values at 64, coloured and occluded emission,
absorbing half-block media, camera and delta emission, empty scenes, native WebGL2 refusal, compatibility rendering,
disposal and real device restoration. Output: `test-results/voxel-pathtracer-restir.json`.
The accuracy result is from generated geometry on one RTX A6000 and Edge 157. No quiet-machine speed result is claimed.

### Batch 77 painterly pixels

Build packages, then run `npm test --workspace @margoengine/creative` and
`node scripts/gpu-lock.mjs run --owner=codex-77 -- npm run test:gpu:paint --workspace @margoengine/creative`.
The GPU script reads every tested pixel against the independent CPU reference (double-precision squared
deviations), asserts exact alpha/bypass and one-code RGB error, tests BGRA/MSAA, separate views, real device
replacement and real Engine/PostStack integration. Generated stand-ins only; no timing or aesthetic judgement.

### Consolidated WebGL2 entries

After `npm run build:packages`, run
`node scripts/gpu-lock.mjs run --owner=webgl-merge --max=20 --wait-max=20 -- node packages/webgl2-compat/test/preview-browser-check.mjs`.
The result is `test-results/webgl2-preview-browser.json`: picks, context recovery,
native WebGPU isolation and preview-to-full-device escalation.
### Browser shutdown control-flow regressions

Run `node --experimental-test-module-mocks --test --test-timeout=120000 tests/browser-teardown.test.js tests/browser-selection.test.js tests/gltf-pro-materials-lifecycle.test.js tests/shutdown.test.js`. The Windows ownership fixtures are injected on every platform; a separate control retains the POSIX driver route. `node --test --test-timeout=180000 tests/catalog.test.js` checks the actual catalog lifecycle after the package build. Material GPU validation uses the usual GPU lock and `node scripts/gltf-pro-materials-gpu-check.js`. Production shutdown stays at 30,000 ms; the larger command limits cover the complete tests, not a longer teardown.

### Audio review regressions (2026-11-09)

Run npm test --workspace @margoengine/audio for suspended/resumed live-context stand-ins, quantized audio clocks with monotonic frame time, source-kind detachment, pooled/event authored pitch, disposed occlusion, missing engines and evidence wording. Run node scripts/gpu-lock.mjs run --owner=audio-review --max=12 --wait-max=2 -- npm run test:browser --workspace @margoengine/audio for native WebGPU and both WebGL2 routes. The browser harness also uses a real AudioContext with controlled 60 Hz frame and 10.667 ms audio clocks, and OfflineAudioContext fractional-loop markers at 130 bpm: one hour at 8 kHz, 300 s each at 44.1/48 kHz. Every loop is checked against its original fractional-sample grid; the allowed crossing interpolation error is 1.5 frames, not a per-loop allowance. Result: results/audio-review-20261109.json. No speed measurement or device-output proof.

## Batch 99 caustic guiding accuracy

After `npm run build:packages`, run `node scripts/gpu-lock.mjs run --owner=guiding-proof --max=10 --wait-max=10 -- npm run test:gpu:guiding --workspace packages/voxel-pathtracer`.
The fixed generated scene has a one-voxel smooth glass block above a white ground plane and a one-voxel emissive lamp
above the glass. The orthographic camera is below the block. At 16 x 16, seed 17 and 64 samples, the default guide
must have less than half the original tracer's squared RGB error against its 16,384-sample seed-987 guided reference.
The score sums 768 channel errors; it is not MSE. Separate 4,096-sample original-tracer images check converged energy,
coloured absorption and overlapping bounds. A unit environment furnace supplies an independent analytic value.
The driver also checks zero-strength and empty-table identity, finite inside/huge bounds, empty black scenes,
native WebGL2 refusal, WebGL2 compatibility values, disposal and real device restoration.
Output: `test-results/voxel-pathtracer-guiding.json`. Generated stand-ins, one GPU/browser; no timing claim.
The initial cone proposal scored 304.785742 against 345.995718, the tighter cone 224.264648 against 350.006292,
and the box proposal with unmodified roulette 241.098699 against 350.533552. All failed the unchanged 2x bar.
The default throughput heuristic was terminating successful guided paths at the glass exit; correcting its
survival heuristic removes that cause without changing the scene, sample count or threshold.

## Scatter tile capacity boundaries (batch 77 review)

After `npm run build:packages`, run `node --test --test-timeout=60000 packages/scatter/test/tiles-budget.test.js`
and `node scripts/gpu-lock.mjs run --owner=codex-77fix --max=5 -- node packages/scatter/test/grass-tiles.browser.mjs`.
The latter already runs in check:merge through scatter's `test:browser:grass-tiles` script. Each boundary fixture
starts with fresh one-instance rings and 64 generated packed records; compare counts and capacities with
[the recorded before/after result](results/scatter-tile-budget-20261109.json). The parent loses records in all five
allocation regressions; controls, hard transitions, fades, outside rejection and the explicit cap remain checked.
This is correctness evidence on one GPU, not a performance benchmark.

### Batch 69 WFC heap and chunks

Run npm test --workspace @margoengine/wfc for exhaustive local relations, linear validation work, 192x192 heap updates, 256x256 chunk coverage and all-axis seams. Run node packages/wfc/test/heap-bench.mjs --record with a hard timeout to reproduce paired/interleaved CPU measurements and output hashes; --record replaces only this machine-specific batch file. Current results are loaded-machine diagnostics, with no release speed promise. Rebuild the feature artifact with node packages/wfc/scripts/build-wasm.mjs (Rust wasm32-unknown-unknown, SIMD enabled by the script), then run both library builds and the WFC browser test for module-relative asset loading.

### Batch 69 WFC worker solving

Build packages, then npm test --workspace @margoengine/wfc. Actual shipped classic scripts run on worker threads for TS/SIMD parity, pins, weighted/wide fallback and solver errors, beside transport lifecycle tests. Run node scripts/gpu-lock.mjs run --owner=codex-69 --max=8 -- node packages/wfc/test/browser-check.mjs --record for the device record. It solves 512x512 with both implementations beside real WebGPU and WebGL2 render loops, requires positive in-flight work plus rendered frames, compares synchronous seeded output and aborts a second active solve. npm run check:readme-run -- --packages=wfc executes the browser example. Generated rules are stand-ins; frame counts demonstrate scheduling, not a speed or frame-time claim.

### Batch 76 custom transitions

Build packages, run npm test --workspace @margoengine/transitions, then node scripts/gpu-lock.mjs run --owner=codex-76 --max=10 --wait-max=30 -- npm run test:gpu --workspace @margoengine/transitions. The browser harness uses generated solid-color stand-ins and reads every tested output pixel. Expected values come from exact endpoints and the supplied p*p weight, within one UNORM code. Both 1x and 4x captures include resize and replacement-device redraw; actual WebGL2 must give coded linked unsupported. Invalid WGSL is deliberately labelled for the compile guard; incompatible bindings reject before attachment. npm run check:readme-run -- --packages=transitions runs both examples. No timing comparison was made.

## Missing format proofs

After npm run build:packages, run in PowerShell:

```powershell
$env:REAL_FILES_ONLY='pts-pdal,xyz-openbabel,mpd-robotic-arm,amf-zipped-slic3r,amf-rook'
npm run test:real-files -w @margoengine/loaders
```

The script fetches pinned standard assets with SHA-256 checks; REAL_FILES_DIR chooses an external cache if desired.
The MPD needs the 146,853,687-byte library archive plus four CC-BY-4.0 sticker parts. All sources/licences are in
packages/loaders/tests/real-files/manifest.json. The result record is missing-format-proofs-20261109.json.
These rows need no outside implementation runtime or GPU. Coordinate checks retain 1e-6 for AMF; XYZ compares float32
values exactly. Re-run packages/loaders/tests/amf-reference.test.js for translated/nested-build oracle regressions.

For the Windows README tool proof, run node scripts/fetch-readme-assets.mjs --ffmpeg after the build. Set
MARGO_README_FFMPEG to the emitted cache/ffmpeg/bin/ffmpeg.exe, then run npm run check:readme-run -- --packages=headless.
Only that example child receives the tool directory in PATH. The optional build is FFmpeg 8.1.2 GPL-3.0 from Gyan,
publisher archive SHA-256 db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec. No tool binary ships.

## Batch 99 multiple-scattering tracer sky

Build packages, then run `node scripts/gpu-lock.mjs run --owner=codex-99 -- node packages/voxel-pathtracer/tests/sky-browser.mjs`
with a 10-minute hard limit. It runs native WebGPU and WebGL2 compatibility and writes
`test-results/voxel-pathtracer-sky.json`; the committed record is `results/batch-99-sky-20261109.json`.
Generated 32x16 maps compare higher orders on/off, Earth/no ozone, low sun and vacuum with Lambert ground;
128x64 maps check stable integrated procedural stars. Independent constants are zero in vacuum and
sun illuminance times albedo divided by pi on the planet. Empty-scene tracing reproduces RGB [0.1, 0.2, 0.3] within
1e-5, and sky plus sun illuminate a diffuse receiver. Lifecycle runs the normal traced scene with a baked map,
destroys/restores the real native device and requires an identical converged image and raster restoration on
disposal. Unit tests in `packages/voxel-pathtracer/tests/sky-environment.test.js` inject pipeline/readback failures
and cancellation while each waits. No wall-time performance result or outside-renderer radiometric parity is claimed.

### WFC batch 69 review regressions

Run npm test --workspace @margoengine/wfc after building. The overlapping extraction subprocess has a 128 MiB heap,
a 30-second hard timeout and a finite 512x512 sample; it must throw RangeError instead of exhausting the process.
inputs.test.js, loading.test.js, sockets.test.js and worker.test.js exercise the other review findings and their
related input/error classes. All run in verify/check:merge. Run node scripts/gpu-lock.mjs run --owner=codex-69fix
--max=8 --wait-max=8 -- npm run test:gpu --workspace @margoengine/wfc for both real browser backends, and the same
lock wrapper around npm run check:readme-run -- --packages=wfc. No measured-speed rerun is needed: output algorithms,
work counts, benchmark scenes and the Rust artifact are unchanged.

### Scatter LOD representation cross-check

Run npm test --workspace @margoengine/scatter; tiles-budget.test.js covers float64-to-f32 collapse and the existing
inclusive capacity fixtures. After the package build, run the scatter browser scripts through
node scripts/gpu-lock.mjs run --owner=codex-69fix --max=15 --wait-max=8 --
node scripts/gpu-package-tests.mjs --no-build --only=scatter --serial.
The ordered compaction, per-ring caps and conservative tile-distance arithmetic are unchanged.

### Batch 76 mask wipes

Run the same transitions unit, GPU-lock and README commands as job 1. The GPU suite also creates a 2x2 four-grey ImageData and ImageBitmap, checks 1344 pixels across hard/soft thresholds at 1x/4x, resizes through odd 5x7 and 7x3 captures and replaces a real device. A double-precision threshold oracle is independent of the integer WGSL addressing. Endpoints are byte-exact; blended channels allow one UNORM code. The fixtures are stand-ins. Native WebGL2 must refuse with linked unsupported. No performance comparison was made.

### BSP dungeon layouts (batch 68 job 3)

Run `npm run test:dungeon-kernel --workspace @margoengine/procedural` for native Rust tests,
`npm run build:dungeon --workspace @margoengine/procedural` to reproduce the checked-in Wasm,
then `npm test --workspace @margoengine/procedural`. The dungeon tests independently flood-fill generated
grids, verify rooms and tree links, cover 256 seeded thin/small layouts plus the maximum grid, and compare
direct raster writes against a full-grid membership oracle with exactly matching cells. The emitted
`dungeonWork` counts are diagnostic work counts, not wall-time speed results.
Run `node scripts/gpu-lock.mjs run --owner=codex-68 --max=10 --wait-max=10 -- npm run test:gpu --workspace @margoengine/procedural`
for a production consumer under /sampling/: both independent lazy Wasm assets, no asset fetch on import,
native WebGPU and WebGL2 values, real loss events and disposal. Generated maps only (STAND-IN, LIM-628).

### Material KTX2 and E57 README inputs

Run node scripts/fetch-readme-assets.mjs, then npm run check:readme-run -- --packages=materials,points
after npm run build:packages. The two KTX2 aliases use the existing 2D and cube KTX-Software
fixtures; /scans/plant-room.e57 serves the complete outside CC0 two-station room, not a
plant survey. Source/hash/size live in scripts/fetch-readme-assets.mjs; bytes stay in the
shared README cache. The recorded result is 45/47, two retained other-cause failures.

### Batch 56 job 1: projected HDR floor and contact composition

After building packages, run
`node scripts/gpu-lock.mjs run --owner=codex-56 --max=5 --wait-max=4 -- node packages/staging/test/ground-browser.mjs`
and the same command with `--compat` appended. Both read the existing licensed BrightRings EXR,
compare shadow-on/off pixels, assert unchanged product/outside pixels, destroy and replace an actual
device, remove the caster and dispose the scene. The product geometry is a stand-in. The README's
order 0.25 is essential: a backdrop at its default order 1 covers a depth-read-only contact plane at 0.5.
No new projection or shadow algorithm, physical HDR-shadow claim or timing measurement is added.

### Batch 76 two live scenes

Run transitions unit tests and the package GPU suite through gpu-lock as for jobs 1 and 2. live-browser.js uses two real Engine scenes, whose update plugins change generated backgrounds. It changes both colors at fixed progress and reads every output pixel, 374 total across 1x/4x, with exact endpoints and at most one UNORM code for blends. It resizes 8x4 to 7x3 and 5x7, destroys a real device, awaits engine recovery and proves progress continues. It also renders to canvas, disposes twice and renders a borrowed scene afterward. Native WebGL2 must give linked unsupported. Results are in results/batch-76-live.json, stand-in correctness, not performance.

### Real AVC B-frame edited timestamps

Run node scripts/reference-rendering/fetch-skip-assets.mjs, build the packages, then run
npm test --workspace @margoengine/video for the complete independent packet/timestamp
oracle and rounding regressions. Run node scripts/gpu-lock.mjs run --owner=codex-missing
--max=10 -- npm run test:gpu --workspace @margoengine/video for all five browser checks,
including every real frame. The CC0 MDN flower clip stays in the shared outside cache.
Its URL/SHA-256/size are in scripts/support/external-test-assets.json. The committed
packages/video/test/flower-ffprobe.json comes only from FFprobe 8.1.2 JSON output:
node packages/video/scripts/flower-reference.mjs <path-to-ffprobe-8.1.2> regenerates it.
This FFprobe binary was extracted from the already publisher-hash-checked outside GPL
FFmpeg 8.1.2 archive. Neither movie nor tools ship. The reference feeds independent
packet offsets/config/PTS to the same browser WebCodecs decoder; hashes are exact,
not a perceptual tolerance or an independent decoder comparison.

### Batch 160 anisotropy and iridescence, job 6

Run fetch-assets.mjs and the existing viewer capture/run commands with --case=anisotropy and --case=iridescence, including --compat. Pinned original sources are SHA-256 checked; iridescence has no source GLB, so pack.mjs embeds its original buffer and guides.png in an aligned GLB. It preserves all authored nodes, materials, accessors, indices and bytes; no remeshing or baked material changes. Tests exercise multiple buffers/images and nonmutation. cases.mjs documents cameras, source/packed hashes and CC0 authors. All pixels at 512 x 512, same white sun as job 1, no IBL/exposure fitting. Frozen references cannot be replaced with --measure. Batch 168 sky/OIT/staging/lightmap results are reused, not repeated.

## Batch 99 heterogeneous RGB media

Build packages, then run `node scripts/gpu-lock.mjs run --owner=media-proof -- node packages/voxel-pathtracer/tests/media-browser.mjs`.
Run `node --test --test-timeout=180000 packages/voxel-pathtracer/tests/media.test.js` for hostile coefficients,
atomic replacement, input ownership, optionality and fake-device restoration. The browser driver first
checks root physical path length, then RGB absorption/emission/shadows, clear and extreme channels and
conservative scattering on native WebGPU and compatibility. It finally destroys and restores a real
native device and checks the converged frame and disabled/disposed raster exactly. Generated fixtures
are stand-ins for analytic optical media, not outside production assets or rival renders.

### Batch 160 environment IBL, job 7

Fetch the pinned job 1 asset with node scripts/reference-rendering/fetch-assets.mjs. References and binaries stay under engine-bench. In an outside Python venv install mitsuba==3.9.1 and numpy==2.5.4; set MARGO_MITSUBA_PYTHON to its python executable (default is engine-bench/batch-168/mitsuba-venv/Scripts/python.exe). Run node scripts/gpu-lock.mjs run --owner=codex-160 --max=25 -- node scripts/reference-rendering/environment.mjs --capture-reference, then the same harness without --capture-reference and with --compat. The public Python adapter renders fixed-seed scalar_rgb direct/full images into a candidate directory; both raw and display hashes must match before any frozen artifact changes. Unchanged copies are retained outside, never committed. --measure refuses any existing budget. Root tests: node --test --test-timeout=120000 tests/reference-environment.test.js. All pixels, no crop, denoise, fitted exposure or new tone curve. Constant furnace only; use the existing batch 168 harness for sky/OIT/staging/lightmap evidence.

### Batch 160 Cornell lights, job 8

Use the outside Mitsuba venv documented for job 7. Run node scripts/gpu-lock.mjs run --owner=codex-160 --max=25 -- node scripts/reference-rendering/cornell.mjs --capture-reference and add --point for the independent point-light scene. Then run both cases without --capture-reference, each with and without --compat. Native WebGL2 is explicitly refused before the measured compatibility path. Raw RGB/EXR/PNG artifacts remain in engine-bench/batch-160/clustered and clustered-point; raw/display hashes protect recapture. --measure cannot replace any established budget. Tests: node --test --test-timeout=120000 tests/reference-cornell.test.js. cornell-scene.mjs reuses packages/lightmap/scripts/cornell-box.mjs directly; all 15 quads, reflectance, winding and Float32 snap match batch 168. Only direct-light pictures are new; the existing lightmap-bake result is reused. Both unshadowed controls and default LocalShadows are compared with the same hard-visibility reference, with no fitted exposure or crop. Point finite-range attenuation is an explicit model difference, not fitted into the reference.

### Space colonisation trees (batch 68 job 4)

Run `npm run test:trees-kernel --workspace @margoengine/procedural`,
`npm run build:trees --workspace @margoengine/procedural`, then
`npm test --workspace @margoengine/procedural`. The trees tests check generated and custom clouds,
graph and length invariants, extreme bounds, owned output, abort/dispose and an exhaustive assignment
oracle. Work counts compare distance tests, not elapsed time or language speed. Run
`node scripts/gpu-lock.mjs run --owner=codex-68 --max=10 --wait-max=10 -- npm run test:gpu --workspace @margoengine/procedural`
for the production consumer under /sampling/, independent lazy assets, exact backend values and real
device/context loss. All inputs are generated stand-ins (LIM-631).

`node --test packages/procedural/test/loading.test.js` checks the shared loading failure and abort
contract, including missing TEMP paths, malformed modules, simulated transport/CSP failures and exact
caller cancellation reasons. Four cases fail without the owning loader correction.

### Batch 56 job 2: accumulated shadows

Build packages, then run `node --test --test-timeout=240000 packages/staging/test/*.test.js`.
Run `node scripts/gpu-lock.mjs run --owner=codex-56 --max=10 --wait-max=40 -- node packages/staging/test/accumulate-browser.mjs`
and append `--compat` for the WebGL2 compatibility layer. Both runs compare all texels against an
independent ray-plane rectangle oracle on the Direct3D raster grid, test sharp contact and increasing
penumbrae, exact maximum integer sums, stable completed history, empty scenes, resize/removal,
actual device loss/replacement, linked native fallback refusal, scene-owned disposal, PBR casters and
coexistence with the contact receiver.
The first draft oracle omitted the mandated eight-bit vertex snapping and failed boundary sums;
the corrected oracle retains exact equality at every texel and has independent snapping/tie regressions.
The fallback fixture initially omitted its preview renderer, then imported it from the wrong entry;
both setup errors were corrected before the successful complete runs. No failed step was ignored.
No benchmark or physical-lighting comparison was performed.

### Batch 56 job 3: studio rig reuse

Build packages. Run `node --test --test-timeout=120000 packages/environment/tests/studio.test.js`.
Under the GPU lock with owner codex-56, max 20 minutes and wait-max 40 minutes, run
`node packages/environment/scripts/test-browser.js --page=studio` and again with `--compat`.
Run `node packages/staging/test/ground-browser.mjs --studio` on both paths too. The studio value
oracle checks all four softboxes' source directions, SH and irradiance ordering; staging checks off/on
contact pixels, unchanged product/outside pixels, removal, disposal and real replacement-device
recovery. [Frozen evidence](results/batch-56-rigs.json). No external assets or speed comparison.

### Batch 68 job 5: sharp SDF models

`npm run test:sdf-kernel --workspace @margoengine/procedural` runs the native QEF
rank, rotated-plane, anisotropic and shared-root controls. `npm test --workspace
@margoengine/procedural` reads the actual Khronos Box.glb position accessor and
asserts every reference corner, planar surface, outward winding, closed edges and
volume. The committed small standard fixture has a pinned SHA-256 and attribution
in test/fixtures/sdf/NOTICE.md. Other controls are generated stand-ins.
`npm run test:gpu --workspace @margoengine/procedural` checks identical geometry
values on real WebGPU and WebGL2 before and after loss, disposal and independent
lazy loading. `cellEdgeUses == 4 * edgeSolves` proves shared-root work reduction;
there is no elapsed-time or SIMD speed claim (LIM-632).

### Outside-tool supplied mip chains

After `git lfs pull` and `npm run build:packages`, run:

```sh
node scripts/gpu-lock.mjs run --owner=mips-proof -- node packages/materials/test/features-browser.mjs mips
```

The required unmodified KTX-Software-CTS file fails on missing/LFS/changed bytes. Its
notice pins the public URL revision, size, licence and hash. The test splits seven
layers into 2D chains, uploads through materials/mips, and hashes every texel from
a compute textureLoad/pack4x8unorm read using a linear view. Expected hashes come
from independent `ktx extract --raw --all`, not Margo's decoded data. All 35 images
(9,548 texel bytes) must match. Solid-colour conformance only; no quality or timing
claim. Durable record: `results/mips-real-tool-20261109.json`.

### Batch 76 independent review corrections

Run npm test --workspace @margoengine/transitions, then node scripts/gpu-lock.mjs run --owner=codex-76fix --max=8 --wait-max=10 -- node packages/transitions/scripts/test-gpu.mjs. The runner includes viewport-browser.js: compare patterned 8x4 captures with a no-transition baseline inside the right-half viewport and throughout a stacked inset/scissor target, for four built-in kinds/custom/mask at idle/0/0.5/1, 1x/4x. Original code fails at wipe idle 1x pixel 4,0 red (0 versus 127). The live integer-format regression fails against the original code because rgba8uint does not throw. Live real-device tests check integer/depth/non-resolvable float refusal with unchanged source updates/progress and accept baseline float/normalized formats. Additional resource-interface probes compile only; the costly-loop shader is never dispatched. Run node --test --test-timeout=60000 packages/scatter/test/*.test.js for the ring/f32/capacity audit's existing regression suite. Evidence is correctness on generated inputs, not throughput or hostile-shader execution safety.

### Static USDZ README input

Run `node scripts/fetch-readme-assets.mjs` (or the required external downloader),
then `npm run check:readme-run -- --packages=usdz` and
`node --test --test-timeout=120000 tests/readme-assets.test.js`. The /model.usdz
alias requires the published Blender BoxTextured conversion, including its PNG.
Its 8,080-byte SHA-256 and licence are in scripts/support/external-test-assets.json.
Missing/LFS/changed bytes fail with the external fetch command. The regression
asserts 36 expanded vertices and 12 triangles, not a visual-quality metric. The
composition example's separate known exception remains.

### Splat README inputs

After building/restoring fixtures, run:

```sh
node --test --test-timeout=120000 tests/readme-assets.test.js
npm run check:readme-run -- --packages=splats
```

All 14 examples must execute. Regenerate the local
real-excerpt .splat with `node packages/splats/scripts/make-readme-splat.mjs`;
its 268,320 bytes and SHA-256 are in the fixture notice. This is not an outside
.splat oracle. Full SPZ capture proofs retain their separate required shared inputs.

### Batch 56 viewer numeric safety

Build packages, run the stage package tests, then run scripts/stage-viewer-gpu-check.js through
the GPU lock (owner codex-56). Append --compat for the compatibility path. Extreme periods are
Number.MIN_VALUE, -1e-309 and Number.MAX_VALUE, with a visible real helmet and no GPU errors.
The CPU test includes both signs and huge finite deltas; old code produces nonfinite coordinates.

### Batch 56 audit: physical sampler pressure

After building packages, run the gltf-pro tests and scripts/stage-viewer-gpu-check.js through the
GPU lock, on native WebGPU and with --compat. The same real FlightHelmet file, including its
transmission-factor lens, uses IBL plus a floor shadow. Before the repair ANGLE reported fragment
texture image units exceeding MAX_TEXTURE_IMAGE_UNITS(16), the frame loop stopped and the
turntable assertion failed. The same unchanged assertions pass after unused physical maps are
replaced by exact fallback constants and omitted from the bind group.

### Batch 56 audit: mandatory direct glTF GPU inputs

Run node scripts/support/external-test-assets.mjs, then run the gltf-pro test:extensions:browser
script through the GPU lock. No environment override is required for the normal shared cache.
For a missing or changed input, use the named fetch-skip-assets recovery command. The four cases
now actually consume their validated files. Run tests/external-test-assets.test.js for the cache
failure regressions and the direct-harness contract checked by verify/check:merge.

### Batch 56 job 4: existing product viewer

Build packages; run npm test --workspace @margoengine/stage and the staging package tests. Through
the GPU lock with owner codex-56, run scripts/stage-viewer-gpu-check.js and append --compat for
the compatibility layer, or run gltf-pro's test:gpu:viewer script for both. The licensed real
FlightHelmet is the existing mobile GLB fixture. The tests assert product coverage, ground pixels,
orbit radius/height/target, rollback, extreme finite periods, disposal and actual device replacement
restoring the whole frame exactly. Raw reports are test-results/stage-viewer.json and
stage-viewer-compat.json; the committed batch-56-frame.json preserves both devices and values.

### Batch 99 mixed triangle geometry

Build with npm run build:mesh --workspace @margoengine/voxel-pathtracer, then npm run build:packages. Run npm run test:mesh-kernel --workspace @margoengine/voxel-pathtracer and the voxel-pathtracer package tests. Run node scripts/gpu-lock.mjs run --owner=codex-99 --max=10 --wait-max=5 -- npm run test:gpu:mesh --workspace @margoengine/voxel-pathtracer for native and compatibility analytic paths, predicate arithmetic, device replacement and raster restoration. The generated-scene record is results/batch-99-mesh-20261109.json. No downloaded reference asset is involved.

node packages/voxel-pathtracer/tests/mesh-build-ab.mjs runs the CPU-only scalar/Rust paired diagnostic and writes test-results/voxel-pathtracer-mesh-build-ab.json. Both builders emit the same 524,284 words for 16,384 triangles; every timed output is compared byte for byte. Alternating rounds use per-round minima. This is a loaded-machine implementation diagnostic, not a quiet release or rival benchmark.

### Batch 68 job 6: tileable GPU textures

`npm test --workspace @margoengine/procedural` runs hostile settings and the
allocation, shader-error, queue-failure, cancellation/disposal/loss controls on
stand-ins. `npm run test:gpu --workspace @margoengine/procedural` compiles the
actual shader and asserts 44,415 numerical channel values, full-period identity,
one-texel phase shifts across both edges, real loss, in-flight cancellation and
disposal, fresh-device baking and linked native WebGL2 refusal. One RGBA8 step is
the comparison bound; no time budget or numerical tolerance was loosened.
For the external structural reference, download the PDF identified and hashed in
packages/procedural/test/fixtures/textures/structural-reference.json. The fourth
embedded raster on PDF page2 is Figure1(d), 256-square. At y38 joint centres are
34.5,122.5,210.5; at y68 they are83.5,172.5. The pitch88 and nearest offset39 are
our measurements with two source pixels uncertainty. The GPU repeats this supplied
stagger and compares measured output joints within source and raster quantization.
This proves calibrated structure only, not image reconstruction or colour/wood/rust
quality. Other controls remain generated stand-ins (LIM-639). No speed measured.

### Batch 160: independent raw blend repeat regression

From this checkout, after npm ci, run through the shared GPU lock:

```sh
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat.mjs --api=webgpu
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat.mjs --api=webgl2
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat-node.mjs --backend=d3d12
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat-node.mjs --backend=d3d11
```

The browser commands render 200 frames per process, in two fresh processes. Each
command requires one unique full RGBA byte hash, records all hashes and every
changed pixel per distinct image, and exits nonzero on variation. Browser work
has a 120-second deadline per process. Node uses the existing webgpu 0.6.2 development
dependency and the exact same checked-in draw program, with a 120-second deadline.
The commands currently fail on NVIDIA 617.42. This is preserved failing evidence.

For controls, pass --samples=1 to each browser command, or set MARGO_GPU=amd in
the child environment and retain four samples. The Node control uses --vendor=amd
with --backend=d3d12. Vendor controls compare repeats within one adapter, not bytes
between adapters. --frames=2..4096 and browser --processes=1..16 control the capture
counts without changing the exact assertion.

The pinned CC0 IORTestGrid GLB is reused from the outside batch-160 cache, or fetched
from its pinned standard-asset URL if missing. Changed bytes fail SHA-256 validation;
concurrent downloads publish atomically. Source/legal details are in
scripts/reference-rendering/NOTICE.md. Reports stay outside under
engine-bench/batch-160/determinism; the committed summary is
results/batch-160-determinism.json. No renderer or driver implementation is read.

Full-scene reproductions still live on batch-160-job5-parked:
GPU-locked scripts/reference-rendering/repeat.mjs --case=ior, and
--case=volume --compat. Both compare 24 complete-scene frames with unchanged inputs
and budgets. Volume full-Cycles absolute error still spans 13,792,000..13,792,003
against 13,792,000; native IOR spans 2,423,418..2,423,421 against 2,423,418. AMD repeats
are stable but its IOR absolute error is 2,424,918, so changing adapter does not
satisfy the original gate. Both jobs remain parked until repaired.

## Batch 65 roads

Generated stand-in geometry and networks; no external asset is needed. In a built checkout run:

```sh
npm run build:packages
node --test --test-timeout=180000 packages/road/test/*.test.js
node scripts/gpu-lock.mjs run --owner=road-proof --max=8 --wait-max=10 -- npm run test:gpu --workspace @margoengine/road
npm run check:readme-run -- --packages=road
npm run measure:size
```

The browser proof uses native WebGPU and forced real WebGL2 compatibility. It checks pixels and navigation values, exact rendered geometry after reboot, explicit graph/context reconstruction and disposal. CPU graph tests force createCompute({backend:'cpu'}). All generated outputs are stand-ins. No surveyed-road, traffic-model, highway compliance, other-hardware or speed claim follows from these checks.

### Batch 99 spectral and lens effects

After npm run build:packages, run the voxel-pathtracer package tests. Through scripts/gpu-lock.mjs
with owner codex-99 and a ten-minute limit, run npm run test:gpu:spectral --workspace
@margoengine/voxel-pathtracer. This runs native WebGPU and WebGL2 compatibility analytic values:
equal-energy colour, one glass interface, a closed slab, glass and lens furnaces, finite-slab disk
coverage at three wavelengths, and extreme finite lens settings. All scenes are generated stand-ins.
Run node packages/voxel-pathtracer/tests/browser-check.mjs --spectral --report=spectral-snell dispersion
viewport through the same GPU lock for the unchanged analytic Snell and actual device-replacement
and raster-restoration assertions. No external spectral asset, reference renderer or speed claim.
The committed reports are results/batch-99-spectral-20261109.json and the matching Snell/lifecycle record.

### Batch 68 job 7: building shape grammar

Run procedural test, test:buildings-kernel and GPU-locked test:gpu. The JS test
compares floor/bay coverage, material areas, normals and shell volume with analytic
oracles; a per-vertex sine/cosine transform is coordinate-identical to the shared
scope while doing2 trig calls per vertex instead of2 per model. This is a work count,
not elapsed time. Download the CityJSON tutorial sample linked and SHA-256 pinned
in packages/procedural/test/fixtures/buildings/reference.json. Dequantize referenced
vertices by scale/translate, take min/max on each axis and build envelope rectangles
with those dimensions and one floor of the measured height. This proves envelopes
only: source polygon/facade reconstruction is not asserted. Generated controls are
STAND-IN. Browser harness serves a nonroot base, checks lazy assets and exact values
on real WebGPU/WebGL2 contexts before/after loss and idempotent disposal (LIM-640).

For the limited real facade check, download the CMP base archive in
packages/procedural/test/fixtures/buildings/facade-reference.json, verify all three
SHA-256 values and select window annotation ordinals0,6,1,7 from cmp_b0001.xml.
Multiply normalized X by543 and Y by1024. Average horizontal centre differences,
window widths and each row's window heights; use the measured vertical centre
pitch to derive a common window-height ratio and the two floor heights. Apply
those recorded rules and compare all16 bounds, fixed2-source-pixel bar. The model
agrees within1.88928 pixels. The first equal-floor calibration missed at2.12608;
using the measured unequal floors resolves its cause without changing the bar.
This is calibrated layout reproduction of four windows, not inference/reconstruction
of the whole facade. No original CMP photo or XML ships.


### Complete Node Basis glTF README (2026-11-09)

Build packages, then run node scripts/reference-rendering/fetch-skip-assets.mjs.
The existing required manifest includes the complete CC0 FlightHelmet Basis model
under helmet/ in the external cache. Run node --test tests/readme-assets.test.js
tests/run-readme-examples.test.js packages/decoders/tests/readme-node.test.js.
Through node scripts/gpu-lock.mjs run --owner=codex-missing --max=5 --, run
node packages/decoders/scripts/test-node-gltf.mjs. It executes the README's original
Node setup/load, checks texture/mip/geometry totals and GPU validation, then reads
the rendered model. Raw result: packages/decoders/test-results/node-gltf/result.json.
Run npm run check:readme-run -- --packages=decoders to execute all 17 examples.
Use MARGO_RESULT_CACHE=off for the verification run. No browser substitute or
independent Basis decoder is involved; the proof is complete-asset integration.


### P20 complete VTK big-endian horse (2026-11-09)

Build packages; fetch with node scripts/reference-rendering/fetch-skip-assets.mjs, then run node --test packages/loaders/tests/ply-outside.test.js. The complete unmodified horse and both licence files are under ply-horse/ in the shared external cache. Source URLs, sizes and SHA-256 values are in scripts/support/external-test-assets.json.

The independent oracle uses Python 3.13, python-plyfile 1.1.3 and NumPy 2.3.4 installed in an outside environment. Run python packages/loaders/scripts/ply-reference.py <external-cache>/ply-horse/horse.ply <output.json>, then compare it with packages/loaders/tests/fixtures/horse-oracle.json. It reads the original file without re-encoding it and records every position/color/index hash. Python is needed to regenerate that oracle, not to run the required Node regression.

For the existing outside-file harness, select REAL_FILES_ONLY=ply-big-endian-vtk and set REAL_FILES_DIR to an outside directory before node packages/loaders/scripts/test-real-files.mjs. REAL_FILES_RENDER=1 adds the real-GPU blank-frame check; run it through the shared GPU lock. The horse contains white RGB and confidence, with no authored normals/UVs. No visual-quality or speed comparison is implied.

### Batch 56 job 5: idle triangle product still

Build packages, then run staging's package tests. Under the codex-56 GPU lock run
node packages/staging/test/pathtrace-browser.mjs. It runs native and compatibility (ANGLE Vulkan
on Windows), the existing licensed examples/assets/flight-helmet-mobile.glb, 20,734 triangles.
Palette material intentionally replaces the authored material. It measures 8/64-sample image error
against a 512-sample reference and asserts each emission hit against [2,1,0.5], plus camera/idle
pixel identity, empty/invalid/cancelled updates, capture, disposal and a real replacement device.
Compositor screenshots establish displayed pixels. Raw report: test-results/staging-pathtrace.json;
committed scope/device/value evidence: results/batch-56-pathtrace.json. No speed result.

## Sciviz asynchronous update and replacement regression checks (2026-11-10)

From a built checkout, run:

```sh
npm test --workspace @margoengine/sciviz
node scripts/gpu-lock.mjs run --owner=sciviz-updates --max=15 --wait-max=10 -- npm run test:browser --workspace @margoengine/sciviz
npm run check:readme-run -- --packages=sciviz
npm run measure:size
```

The unit suite holds extraction and frame completions to check atomic publication, request ordering, aborts,
failures and disposal. It also distinguishes single-slice dimensions from mismatched value counts.
The browser suite checks actual overlapping isosurfaces, bricked time steps and trace replacement on native
WebGPU and forced WebGL2. Results are written to `test-results/sciviz-browser.json`,
`test-results/bricks-browser.json` and `test-results/sciviz-entries.json`. No speed claim follows.

## Batch 56 job 6: oriented staging receivers

After build:packages, run node scripts/gpu-lock.mjs run --owner=codex-56 -- node packages/staging/test/orientation-browser.mjs, then the same command with --compat. --record writes the two committed evidence records under examples/package-benchmarks/results. npm test --workspace @margoengine/staging runs the independent CPU projection/fit/extreme-direction regressions. The real-product case loads the already licensed examples/assets/flight-helmet-mobile.glb; no generated model substitutes for it. Screenshots are compositor screenshots. Native preview refusal is also asserted on a real WebGL2 context.

### Batch 65 review corrections

After a package build, run the exact four review inputs and shared periodic consumers:

```sh
npm run check:road-invariants
node --test --test-timeout=120000 packages/road/test/*.test.js packages/splines/test/*.test.js packages/geometry/tests/*.test.js
node scripts/gpu-lock.mjs run --owner=codex-65fix --max=10 --wait-max=5 -- npm run test:gpu --workspace @margoengine/road
node scripts/gpu-lock.mjs run --owner=codex-65fix --max=10 --wait-max=5 -- npm run test:gpu --workspace @margoengine/geometry
node scripts/gpu-lock.mjs run --owner=codex-65fix --max=10 --wait-max=5 -- npm run check:readme-run -- --packages=road,splines,geometry
npm run lint
npm run hygiene
npm run verify
```

The review and corrective logs are local worktree evidence under test-results/review65 and test-results/fixes65. The committed result record is results/batch-65-review-fixes-20261109.json. The original repair implementation succeeds with area 80 and all Y values zero for the hill input; the regression now requires coded unsupported. All six new regression tests fail on the original implementation (the repair baseline was also probed directly). No performance measurement is claimed.

### Batch 68 caves

Build: npm run build:caves --workspace @margoengine/procedural (Rust wasm32 target).
Run npm run test:caves-kernel --workspace @margoengine/procedural, then npm test
--workspace @margoengine/procedural. GPU values/loss: use the required GPU lock
around npm run test:gpu --workspace @margoengine/procedural. The caves browser
test checks a seeded 2D cave, a seeded 3D island volume and real Natural Earth
Madagascar land. reference.json pins the source URL, public-domain terms, original
length/hash, extent and cell-centre resolution. caves-reference.js independently
parses/rasterizes that data and applies scalar synchronous rules. Every output
cell must match, including before/after loss and fresh instances on both APIs.
Native tests compare every threshold on asymmetric grids and prove the exact
read-count formulas in perf-history.md; tiny grids choose direct reads. No fixed
runtime/speed threshold, connectivity or real 3D geology is claimed.
