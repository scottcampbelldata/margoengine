# Reproducing Margo's numbers

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
