# Claims and evidence

This page lists the numbers and capability statements in the docs, the script or test that backs each one, and a
status. If a number in the README, on margoengine.com or in `docs/` is not here or in a committed result file,
treat it as unverified and open an issue.

Commands for rerunning everything are in [reproduce.md](reproduce.md). Every past performance loss and significant
bug the checks caught, with its cause, fix, after number and guard, is in [perf-history.md](perf-history.md).

Status:

- **PROVEN**: a committed script and a committed result (or a test that runs in `npm test`) support the exact
  wording. A dated statement ("measured at X, before Y") counts when its committed result supports it.
- **UNPROVEN**: the wording describes what the code does, but no committed result backs the number yet.

Unless a row says otherwise, real-GPU numbers come from one machine:

- ASUS Zenbook S 14, Intel Core Ultra 7 258V with an Intel Arc 140V integrated GPU (driver 32.0.101.8860), Windows 11.
- Headless Edge 155, vsync and the frame-rate cap off.
- AC power checked before and after, with a GPU lock held so no other benchmark runs at the same time.

Some newer results (the voxel sandbox and multiplayer, the create-margo starters) come from a desktop with an AMD
Ryzen 9 9950X and an NVIDIA RTX A6000, and say so. Nothing has been measured on Apple silicon, on Android, in Firefox
or in Safari. [docs/limits.md](../limits.md) lists what is untested.

## Headline numbers

| Claim | Where | Evidence | Command | Status |
| --- | --- | --- | --- | --- |
| Core + stage is 22,737 B gzip (57,590 B raw), Wasm kernel and WebGPU backend included | README, site, docs/limits.md | `examples/package-benchmarks/results/entry-sizes.json` at `454df8f3` | `npm run build:packages && npm run measure:size` | PROVEN |
| The build fails at 25,000 B gzip for core + stage | README, site | `scripts/core-budget.js`, run by `build:packages` and `measure:size` | `npm run build:packages` | PROVEN |
| Every other package is optional and has its own size | README | `entry-sizes.json` (every exports entry and worker) | `npm run build:site` | PROVEN |
| An engine starts with 1,024 entity slots and doubles up to 8,388,608 | site | `packages/core/src/kernel.ts`; `tests/core-dirty-transforms.test.js` (1,000,000 entities) | `npm test` | PROVEN |
| Meshes sharing a geometry draw in one instanced call per pass | site | `cad/results-*.json` (`drawCalls`) | `node examples/package-benchmarks/cad/run.mjs` | PROVEN |
| Speed compared with three.js | nowhere | No claim is made. See below. | - | no claim |

## Whitepapers

`site/whitepaper/engine.html` and `site/whitepaper/voxel.html` state each figure next to its source file, hardware
and commit.

| Page | Figures | Evidence | Status |
| --- | --- | --- | --- |
| engine | Core 20,432 B, core + stage 22,737 B (57,590 raw), 2,263 B under the gate | `entry-sizes.json` at `454df8f3` (dirty: false) | PROVEN |
| engine | 79 packages; `npm i margoengine`; kit sizes (game 307,012, cad 201,527, viz 277,396, web 155,058 B) | `docs/catalog.json`; `docs/guides/kits.md`, re-measured by `tests/umbrella.test.js` (fails on a 3% move) | PROVEN |
| engine | Starter first frames: cad 533, web 788, react 835, viz 968, game 1,308 ms (vite dev, packages linked, one run each, RTX A6000 PC) | `examples/package-benchmarks/results/starters-first-frame.json` (`tools/create-margo/test/browser-check.mjs`) | PROVEN (dated, one run) |
| engine | 5,059 tests | `examples/package-benchmarks/results/test-count.json` | PROVEN |
| engine | Parity 153 / 4 / 4 of 161 three.js rows | `docs/three-parity-matrix.md` | PROVEN |
| engine | Views and scenes: +867 B gzip | `docs/multi-view-roadmap.md` size table (21,343 -> 22,210 B) | PROVEN (dated) |
| engine | Voxel multiplayer: 900 spread / 350 crowded at 20 ticks per second | `packages/voxel-net/bench/results.json`, `docs/voxel-net-capacity-2026-10-21.md` | PROVEN |
| engine | 62 visual views, 4 captures each | `tests/visual/profiles/nvidia-ampere-msedge-156` | PROVEN |
| engine | About 88% of browsers support WebGPU (85.8% full + 2.02% partial) | external: caniuse.com/webgpu, StatCounter data for September 2026, read 2026-10-24 | external source, dated |
| engine | The engine is Apache-2.0; STEP and IGES import uses OpenCascade (LGPL-2.1), shipped as separate files | `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, `packages/machinery/src/workers/OCCT-NOTICE.txt` | PROVEN |
| engine | Kernel scaling, CAD orbit before and after, culling, BVH picks, large coordinates, design envelope | `cad/results-*.json`, `results-scale-node.json`, `large-coordinates-gpu.json`, the LIM rows below | PROVEN (dated) |
| engine | 51 proofs, 20 ongoing | `proofs/*.proof.js` and the `ongoing` list in `proofs/run.mjs` | PROVEN (file counts) |
| engine | Speed against three.js or any other engine | None. The page makes no claim and quotes no comparison. | no claim |
| voxel | Path tracer GPU timings, denoiser error ratios, correctness checks, limits | `packages/voxel-pathtracer/README.md` (asserted in its browser checks, no committed result file) | UNPROVEN |
| voxel | Sandbox render distance, multiplayer capacity, package sizes | `voxel-sandbox-bench.json`, `packages/voxel-net/bench/results.json`, `entry-sizes.json` | PROVEN |
| voxel | Voxel Studio app tests, comparisons with other engines, native 4K timing | Margo Voxel Studio's own `docs/verification.md`; raw reports are not committed | UNPROVEN |
| voxel | MagicaVoxel pixel match | the Margo Voxel app repository's `docs/parity/magicavoxel-parity.md` (private); MagicaVoxel's renders are not committed. No speed comparison is published (MagicaVoxel was timed by stopwatch only) | UNPROVEN (said on the page) |

## Speed compared with three.js

There is no publishable result yet, so neither the docs nor the site claim Margo is faster than three.js.

Comparisons run through `npm run bench -- --engines=all`, with the other engines kept outside this repository in
engine-bench (see [docs/benchmarking.md](../benchmarking.md)). The scenes pair core meshes with three.js `Mesh` and
instanced meshes with three.js `InstancedMesh`, at 4x MSAA on both sides, with GPU timestamps on WebGPU and
`EXT_disjoint_timer_query_webgl2` on WebGL2.

The only runs so far were diagnostics on a busy machine (`results/vs-threejs-*.json`, discussed in
[boxes-vs-threejs.md](boxes-vs-threejs.md)). They are not results and are not quoted anywhere as a comparison.

The quiet-machine run, with an A/A run to show the noise floor, decides what gets published.

## Not yet backed by a committed result

These statements describe what the code does, and the docs word them that way, but no committed result file
backs them yet:

- Per-effect alpha behaviour on a transparent canvas (post and environment READMEs). The real-GPU script
  `transparent-canvas-gpu.mjs` asserts it but writes only images to the ignored `test-results/` folder.
- Results of the package browser tests quoted in several package READMEs (bvh, audio, labels, lines, text, points,
  environment, decoders, exporters, physics, controls). The scripts are committed and assert these results, but
  they run on a real GPU by hand, not in CI, and write no committed result.
- The Blender add-on export path. It is exercised only when `MARGO_BLENDER` is set, and no run is recorded.
- Allocation-free updates in tween, procedural and cinematic. The wording is read from the code; there is no heap
  test.
- Texture slot counts per material kind in the gltf-pro README, counted from shader source.
- The sky package's recorded traces, which must be re-recorded after the night sky and fog changes.
- Back-face culling GPU savings in docs/cad-performance.md, which describes a proposal measured on a branch that
  has not been merged.
- glTF export timing for the test model: measured once on a busy machine (`results/exporters-model.json`), so it is
  not quoted.

## Design envelope (`docs/limits.md`)

| ID | Claim | Evidence | Command | Status | Note |
| --- | --- | --- | --- | --- | --- |
| LIM-001 | "core plus the stage facade is 22,737 B gzip"; the build fails at 25,000 bytes (docs/limits.md, intro) | `examples/package-benchmarks/results/entry-sizes.json` at `454df8f3` (`coreStage.gzip` 22737); `scripts/core-budget.js` (`CORE_STAGE_GZIP_LIMIT`) | `npm run build:packages && npm run measure:size` | PROVEN | The figure moves a little with most changes to core; the record names its commit. |
| LIM-002 | Entities: "8,388,608 slots (2^23)", starts at `capacity` (default 1,024) and doubles; `RangeError: Capacity` / `Capacity: 1..8388608`; a failed growth leaves the store as it was (docs/limits.md, Scale) | `packages/core/src/kernel.ts` (`create`, `grow`), `engine.ts` `createMesh` and `Engine.create` (`capacity ?? 1024`); `tests/core-dirty-transforms.test.js` asserts `/Capacity/` at 2^23 + 1 and growth from 1,024 (in verify) | `node --test tests/core-dirty-transforms.test.js` | PROVEN | See also S-04. |
| LIM-003 | "352.1 B of kernel memory per slot at 1,048,576 slots (351 B by layout)" (docs/limits.md, Scale) | `examples/package-benchmarks/cad/results-scale-node.json` (`kernelBytesPerSlot` 352.1 at 1,000,012 entities; Node 24, AC, quiet-gated at 8% CPU, not diagnostic); layout in `packages/kernel/src/lib.rs` (86 float columns + 7 flag bytes) | `node --expose-gc examples/package-benchmarks/cad/scale-node.mjs` | PROVEN | - |
| LIM-004 | "a static kernel tick costs 3.3 ms at 100,006 entities, 20.2 ms at 499,992 and 41.5 ms at 1,000,012"; "about 41 ns per entity per frame even when nothing moves"; above 1,048,576 slots "not measured" (docs/limits.md, Scale) | Same JSON (`tickStaticMs` 3.328 / 20.153 / 41.461); 41.461 ms / 1,000,012 = 41 ns | same | PROVEN | Node CPU timings, same Wasm as the browser, fake renderer. |
| LIM-005 | `CulledInstances`: "0.41-0.55 ms CPU per frame at 89,883 parts, flat in part count"; "parts lose picking, hierarchy and section caps" (docs/limits.md, Scale) | `examples/package-benchmarks/cad/results-culling.json` (Arc, AC, lock; table in cad-performance.md); `packages/culling/README.md` Limits | `node examples/package-benchmarks/cad/culling.mjs` | PROVEN | CPU of `engine.render` with the GPU idle. |
| LIM-006 | `CulledMeshes` "GPU-culls parts that must stay core meshes ... removes GPU work, not the kernel tick" (docs/limits.md, Scale) | `packages/culling/test/culling.test.js` (CulledMeshes redirect test, in verify); cad-performance.md (1M parts need a stable kept set; the kernel tick still runs) | `node --test packages/culling/test/culling.test.js` | PROVEN | Descriptive; no number. The real-GPU pixel check (`cad/culled-meshes.mjs`) commits no result, so the page does not quote it. |
| LIM-007 | Default 100,000 glTF nodes, `.margo` nodes, OBJ parts and STEP/IGES meshes, `SurfacePhysics` parts/carriers; the quoted `(100001 > 100000; raise the maxNodes option)` errors; `maxNodes` / `maxParts` options up to 8,388,608 (docs/limits.md, Scale) | `packages/shared/limits.js` (`countLimit`, `checkCount`), used by `packages/gltf/src/index.ts`, `packages/gltf-pro/src/asset.ts`, `packages/blender/src/index.ts`, `packages/machinery/src/cad-parser.ts`, `workers/cad-worker.ts` and `surface.ts`; `tests/count-limits.test.js` (in verify) | `node --test tests/count-limits.test.js` | PROVEN | Load time and memory past 100,000 not claimed. |
| LIM-008 | "96 B per instance"; buffers must fit the device's `maxBufferSize`; core requests the WebGPU default; `RangeError: GPU buffer limit`; "Not measured" (docs/limits.md, Scale) | `packages/core/src/renderer.ts` (`upload`, `capacity*96`, `requestDevice` without `requiredLimits`) | `git grep -n "GPU buffer limit" -- packages/core/src` | PROVEN | Code facts only. |
| LIM-009 | "64 cached pipeline variants"; `RangeError: Shader limit: 64` (docs/limits.md, Scale) | `packages/core/src/renderer.ts` (`variants.size>=64`) | `git grep -n "Shader limit" -- packages/core/src` | PROVEN | - |
| LIM-010 | Core: one direction and one radiance plus a colourless scalar ambient; clustered "up to 1,024 point and spot lights" (`Expected at most 1,024 lights`); `@margoengine/clustered/area` "9,177 B gzip", "up to 64 rectangle area lights" (`Expected at most 64 area lights`), "unshadowed, no texture bindings" (docs/limits.md, Rendering) | threejs-parity.md AmbientLight/DirectionalLight rows (core `engine.ts`, `shaders.ts`); `packages/clustered/src/index.ts` (`lights.length>1024`); `packages/clustered/src/area.ts` (`MAX_AREA_LIGHTS=64`; LTC table in the lights' storage buffer); clustered README "Rectangle area lights" (no shadows, no texture or sampler); `test/area.test.js` (in verify); `results/area-lights-gpu.json`; `entry-sizes.json` (`clustered/./area` 9177) | `node examples/package-benchmarks/area-lights-gpu.mjs` | PROVEN | Area lights merged in `dab9633` (5l.f) while 5j was written. |
| LIM-011 | `@margoengine/clustered/shadows`: "shadows for up to 16 of them" (docs/limits.md, Rendering) | `MAX_LIGHTS=16` in the source; `results/local-shadows-gpu.json` | `node examples/package-benchmarks/local-shadows-gpu.mjs` | PROVEN | Frame times are not quoted: there is one run, made before the quiet-machine checks existed. |
| LIM-012 | 16 sampled textures and samplers; physical + shadows + IBL + local shadows "uses exactly 16"; standard "8 of 16"; the named `RangeError`; VolumetricFog, SSAO, clustered and area lights and light probes add none (docs/limits.md, Rendering) | gltf-pro README "Texture bindings" table; `packages/gltf-pro/tests/instancing.test.js:133` asserts the quoted message (in verify); environment README (volumetric adds none; light probes: one storage buffer, `packages/environment/tests/probes.test.js` asserts the bindings 20-24 + 26 with an environment and 26 alone without) | `node --test packages/gltf-pro/tests/instancing.test.js` | PROVEN | - |
| LIM-013 | float32: "core alone jitters 0.38 px at 1 km and 42 px at 100 km; at 6,000 km the part is not drawn"; plugin "0.019 px jitter at every distance up to 6,000 km", `engine.pick` hits at every distance (docs/limits.md, Rendering) | `examples/package-benchmarks/results/large-coordinates-gpu.json` (`jitterPx` 0.376 / 42.4 / null with 0 covered pixels; origin 0.0189; `pick` "flange"); Arc, Edge 155, 4x MSAA, AC, lock | `node examples/package-benchmarks/large-coordinates-gpu.mjs` | PROVEN | Pixel geometry, not timing. |
| LIM-014 | "specular shifts (2.8° at 100 km)"; `FloatingOrigin` "1,258 B gzip, 0 core bytes" (docs/limits.md, Rendering) | `results/large-coordinates.json` (eye error, CPU emulation); `results/entry-sizes.json` (`cameras/./origin` gzip 1258) | `node examples/package-benchmarks/large-coordinates.mjs` | PROVEN | - |
| LIM-015 | Sorted transparency: "13 steps with more than 1 % of covered pixels popping"; OIT "0 popping steps"; colour error "0.5 / 4.6 / 8.7 (0-255) for 1 / 2 / 4 layers"; `@margoengine/oit` "2,210 B gzip" (docs/limits.md, Rendering) | `results/oit-gpu.json` (2026-10-15, Arc, AC before/after: `stepsWithOver1PercentPopped` 13 vs 0 of 360; `errorVsAnalytic` 0.5 / 4.6 / 8.74); `entry-sizes.json` | `node examples/package-benchmarks/oit-gpu.mjs` | PROVEN | Deterministic image measurements; the OIT timings in its README are diagnostic and not quoted here. |
| LIM-016 | SSR: on-screen only; other custom shaders (water and terrain only when not added) reflected but do not reflect; "2.2-2.3 ms at 1280×720, 5.8-5.9 ms at 1920×1080" (worst-case glossy floor, quiet-gated); "8,529 B gzip"; off-screen reflections from reflection probes (docs/limits.md, Rendering) | `results/ssr-gpu.json` (`timingLabel` "after scripts/quiet-gate.mjs", commit 7c47a09, `ssrOwnMs` 2.297 / 2.219 / 5.822 / 5.927 at 4x/1x); post README Limits; `entry-sizes.json` (`post/./ssr` 8529, of which +85 B for the probe fallback); `results/probes-gpu.json` (`ssr.missesVsProbesAlone` p95 0, `ssr.hitsAboveWallAndProbe` p99 0) | `node examples/package-benchmarks/ssr-gpu.mjs` | PROVEN | Timed before model capture (838ae6e); with no model added the GPU calls are identical (`proofs/post-ssr-models.proof.js`, pinned `3cf1453` -> `838ae6e`, 30,858 calls; `--current` against `3cf1453`). Adding models costs more (README). |
| LIM-017 | Volumetric: "default 160 × 90 × 64", edges "about one froxel wide (8 × 8 px at 1280 × 720)"; "6,658 B gzip"; the quoted errors (docs/limits.md, Rendering) | `packages/environment/src/volumetric.ts` (default grid, `maxTextureDimension3D` check, fog-policy and depth errors); 1280/160 = 720/90 = 8; environment README Limits; `entry-sizes.json` (`environment/./volumetric` 6658); effects in `results/volumetric-gpu.json` | `git grep -n "throw new" -- packages/environment/src/volumetric.ts` | PROVEN | Edge width is by construction (grid geometry), not a measured blur width. |
| LIM-018 | OCCT "7,604,031 B `.wasm` (3,110,912 B gzip)"; 441,968 B STEP "1,403-1,715 ms"; caps "64 MiB input, 1,000,000 welded vertices, 3,000,000 indices"; `Invalid CAD input`, `CAD unique vertex limit`; "2-4 GB heap ... not measured" (docs/limits.md, Assets) | `cad/results-step.json`; `packages/machinery/src/cad-parser.ts` (`maxBytes`, `maxVertices`, `maxIndices`), `cad-async.ts`; heap bound stated in tools/margo-convert/README.md as a property of 32-bit Wasm | `node examples/package-benchmarks/cad/run.mjs --sizes=1000 --step` | PROVEN | Where OCCT runs out of heap is explicitly "not measured". |
| LIM-019 | `margo-convert`: `as1-oc-214.stp` "441,968 B becomes a 68,352 B GLB (25,579 B gzip), validator 0 errors" (docs/limits.md, Assets) | `results/margo-convert-diagnostic.json` (`inputBytes`, `glbBytes`, `glbGzip`, validator `errors: 0`); `tests/margo-convert.test.js` (in verify) | `node examples/package-benchmarks/margo-convert.mjs --diagnostic` | PROVEN | Sizes are deterministic; the file's timings are diagnostic (busy machine) and not quoted. |
| LIM-020 | gltf-pro `maxDownloadBytes` "default 64 MiB", decoded data "4x that (256 MiB by default)", light loader "64 MiB"; ABeautifulGame "528 MiB" decoded, loads with 160 MiB; the quoted errors (docs/limits.md, Assets) | `packages/gltf-pro/src/asset.ts` (`assetLimit`, `budget`), `packages/gltf/src/index.ts` (`limit`), `packages/shared/loading.js` (`${label} byte budget exceeded`), `tests/modern-support.test.js`; conveyor: `packages/gltf-pro/tests/accessors.test.js` ("the 62 MB conveyor GLB parses", passed in verify on `96daac7` with the LFS file checked out) | `node --test packages/gltf-pro/tests/accessors.test.js` | PROVEN | Updated 2026-10-17: the page now states the code's default (`assetLimit` = 64 MiB at `ac0ffc6`, budgets 4x) and its error messages; it used to say 128 MiB. ABeautifulGame: 33 images of 2048x2048 = 553,648,128 B RGBA8, loads in the gallery view `khronos-ABeautifulGame-model` with 160 MiB. |
| LIM-021 | gltf-pro "up to 1,000,000 vertices per primitive", light loader "1,000,000 vertices in total"; "1,000,002 indices decode, 1,000,002 vertices are refused"; quoted errors (docs/limits.md, Assets) | `packages/gltf-pro/src/pack.ts`, `index.ts`; `packages/gltf/src/index.ts` (`glTF exceeds one million vertices`); `accessors.test.js` asserts both (in verify) | `node --test packages/gltf-pro/tests/accessors.test.js` | PROVEN | - |
| LIM-022 | `Error: WebGPU unavailable` / `adapter unavailable` / `WebGPU required`; `@margoengine/webgl` "2,156 B gzip", flat-shaded core meshes, one light, no textures, effects or picking (docs/limits.md, Platform) | `packages/core/src/engine.ts`, `renderer.ts`; `packages/webgl/test/webgl.test.js` (in verify); webgl README; `entry-sizes.json` (`webgl/.` 2156); real-browser WebGL2 checks in `results/gates-browser-tests.json` | `node --test packages/webgl/test/webgl.test.js` | PROVEN | - |
| LIM-023 | CSP: core needs `'wasm-unsafe-eval'`; nothing needs `'unsafe-eval'`, workers included; no COOP/COEP; "zero violations on Edge, one policy on the page and every worker" (docs/limits.md, Platform) | `results/csp-check.json`, `results/csp-check-negative.json`, `tests/no-eval-workers.test.js` | `node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/csp-check.mjs` | PROVEN | Chromium only (said on the page). |
| LIM-024 | Without `'wasm-unsafe-eval'`: "Compiling or instantiating WebAssembly module violates the following Content Security policy directive" (docs/limits.md, Platform) | `results/csp-check-negative.json` (the `script-src 'self'` run's page error carries the string) | `CSP_OVERRIDE="<policy>" node scripts/csp-check.mjs harness` | PROVEN | Chromium's wording; other browsers word it differently. The former second string ("Evaluating a string as JavaScript ...") no longer applies: no shipped file evaluates strings. |
| LIM-025 | "Every committed real-GPU result comes from one machine"; iPhone "run by hand ... no scripted run or committed result"; S23 report "unresolved"; untested list (docs/limits.md, Platform) | Every real-GPU result JSON names the same adapter; the iPhone run was by hand and is not committed | - | PROVEN | A statement of absence: no phone numbers are quoted on the page. |
| LIM-026 | Browsers: Edge 155 verified, automated; iPhone Safari by hand only; Firefox and macOS Safari not verified (docs/limits.md, Platform) | Every real-GPU result JSON names chromium 155 / Edge; `results/csp-check.json` | - | PROVEN | - |
| LIM-027 | Entities escape hatch: "with `minRadius: 1.5` a 100,008-part orbit draws 11 % of the parts at 138 FPS (core: 29)" (docs/limits.md, Scale) | `examples/package-benchmarks/cad/results-5l-after-culled1.5.json` (fps 137.8, gpuDrawn 11,363) and `results-5l-before-orbit.json` (fps 29.3); Arc 140V, Edge, AC, quiet-gated, GPU lock | `node examples/package-benchmarks/cad/run.mjs --sizes=100000 --culled=1.5 --no-bvh --no-explode` | PROVEN | One session; a second session measured 28-30 FPS for core and 61-88 FPS with edges, see cad-performance.md. |
| LIM-028 | Light probes: one volume of at most 4,096 L1/L2 probes (64 per axis), at most 16 reflection probes; bake "114-121 ms" for 8 volume probes + one 128 px reflection probe (diagnostic); volume SH "within 1.7% of DC"; the four quoted errors; "10,845 B gzip" (docs/limits.md, Rendering) | `packages/environment/src/probes.ts` (`MAX_VOLUME_PROBES`, `MAX_REFLECTION_PROBES`, messages); `packages/environment/tests/probes.test.js` (in verify); `results/probes-gpu.json` (`volume[].maxCoefficientErrorOfDC` <= 0.0171, `bakeTimings` 114.7 / 121.3 / 113.6; quiet gate passed, other jobs running); `entry-sizes.json` (`environment/./probes` 10845) | `node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/probes-gpu.mjs --bench` | PROVEN | Timings labelled diagnostic on the page (busy machine). |
| LIM-029 | Decals: 4,096 per `setDecals`, colour only; "1.64 ms without, 1.64 / 1.97 / 6.36 ms with 1 / 16 / 256" decals at 1280 × 720 4x (diagnostic); the quoted error; "4,118 B gzip" (docs/limits.md, Rendering) | `packages/post/src/decals.ts` (`MAX_DECALS`); `packages/post/test/decals.test.js` (in verify; asserts the error); `results/decals-gpu.json` (`timings`; quiet gate passed, other jobs running); `entry-sizes.json` (`post/./decals` 4118) | `node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/decals-gpu.mjs --bench` | PROVEN | Timings labelled diagnostic on the page. |
| LIM-030 | Malformed and hostile files: every parser ends in a result or its own error; gltf-pro nesting 256 levels; EXR chunk 256 MiB and chunk capacity; Draco/KTX2 decode limit 10 s + 4 s per MiB; the four quoted errors (docs/limits.md, Assets) | `packages/gltf-pro/src/asset.ts` (`parseJSON`, `checkDocument`), `packages/environment/src/exr.ts`, `packages/decoders/src/pool.ts` (`jobTimeout`, `WorkerPool.watch`); `tests/fuzz-formats-regressions.test.js`, `packages/decoders/tests/decoders.test.js`, `packages/gltf-pro/tests/progressive.test.js` (in verify; assert the errors); `npm run fuzz` for longer campaigns | `npm run fuzz -- --target=gltf,gltf-pro,gltf-pro/worker,gltf-pro/ktx2,gltf-pro/progressive,margo,decoders/meshopt,decoders/draco,decoders/ktx2,environment/hdr,environment/exr,environment/ultrahdr,fbx`; `node --test tests/fuzz-formats-regressions.test.js` | PROVEN | Decode times are not claimed. |

## Optimization proofs

Every `examples/package-benchmarks/proofs/*.proof.js` compares a baseline ref with a pinned candidate, the commit where
its claim was made, so later code cannot change the result: `node <proof>` (or `node <proof> <ref> <pin>`). `npm run
proofs` runs all of them pinned, two at a time. The ones marked "current" (the `ongoing` list in `proofs/run.mjs`) are
ongoing guarantees and are also checked against the working tree with `npm run proofs -- --current` (part of
`npm run verify`), from the ref given (the last intended change to their output). Pinned runs build the compared packages and packages/shared at
the pin; `@margoengine/core` (frozen), the proof scripts and their fixtures are today's, so mock-GPU timings recorded
before the core speed-ups (`0ed56b9`) re-run faster than recorded. The animator proof has no current run: it compares
every transform write bit for bit, and the animator has skipped unchanged writes since `f33e094` and reads
`options.speed` since `6a1c6bb`, so only its pinned run can match.

**Baselines: golden outputs, not commits (2026-10-27).** A fresh clone of main failed `npm run verify`: 14 of the 20
current proofs rebuilt their baselines with `git rev-parse` / `git show` on commits (`57250a49`, `2d192a71`, `2cd81c1`,
`2484971`, `b3ed8ac`, `6c20076d`) that exist only in one checkout's pre-rewrite history, and the history scrub before
the repository goes public rewrites every commit id again. A current run now compares the working tree with golden
outputs in `proofs/baselines/` (`golden.js`) and reads nothing from Git: per proof, every value the baseline emitted
and the proof compares with (the GPU call logs with every buffer byte, shader texts, function results), stored
losslessly with its SHA-256 in `<proof>.json` and the values in `<proof>.json.gz`. Each was captured once by
`proofs/capture.mjs` on a checkout that holds the reference commit, only after the proof passed against it, so the
stored value is exactly what the reference emitted with today's core and fixtures, and the commit id stays in the
table above and in `<proof>.json` as documentation. No old package source is stored: only output, which the working
tree must still produce. No reference moved and no assertion changed, so every number in the table above stands.
Three proofs needed more than "store the baseline's value":

- **math-consolidation** calls the old copies directly, interleaved with today's math. Each old copy is taped
  (`tape`): at capture every call ran the copy and a stand-in, today's math called with the copy's signature, on
  copies of the same arguments (aliasing and shared buffers kept) and required the same result, error and every array
  argument afterwards (NaN payloads aside, below); the SHA-256 over all 24 tapes' effects is stored. A current run
  replays the stand-ins and must reproduce every digest. Its text comparisons between old copies are facts about
  `2484971` alone and are stored as such. The digests hold only exactly specified results (host-rounded maths, below).
- **post-stack**'s creative pair is historical in every mode (`5b1fe66^` -> `3319317`, both old); a current run reads
  its stored result (identical calls, with the count) instead of rebuilding both commits.
- **ignoreAgx**'s question "does the reference descend from `eaddd64`" is stored as a fact of the reference.

When a deliberate change alters what a current proof's feature-off path emits, advance its reference as before and
run `node examples/package-benchmarks/proofs/capture.mjs --only=<proof>` on a checkout with that commit; it stores the
new values and replays them from the store. Pinned runs still rebuild their commits from Git; in a clone without them
each such proof prints `HISTORICAL: <proof> is pinned to <commit>, a commit only in the pre-rewrite history` and exits
0, while in `--current` a HISTORICAL row is a failure. `npm run check:fresh-clone` (in `check:merge`, so in the
nightly full run) builds a history-free shallow clone of the working tree and runs `npm run verify` and the proofs in
it.

**Host-rounded maths (bug 17, 2026-10-27).** math-consolidation passed on the PC that captured it (Node 26.12, V8
14.6, Windows) and failed on Node 22.22.1 (V8 12.4) on Ubuntu (Intel N100) and on Windows (AMD Ryzen 7735HS): 21 of its
24 tape digests differed, while every call still matched its old copy when the copies were built from Git on Node 22.
Cause: ECMAScript specifies `+ - * /`, `%`, `Math.sqrt`, `Math.fround` and the integer and rounding functions exactly,
but leaves `**`, `Math.pow`, `Math.sin`, `Math.cos`, `Math.hypot` and the other "implementation-approximated"
functions to the engine. V8 14.6 computes `**` with the C library's pow (`--use-std-math-pow`, on by default), so on
Windows it differs from V8 12.4's own pow (`10 ** -5` is `0.00001` on one and `0.000009999999999999999` on the
other; the sRGB decode or encode of 48 of the 256 bytes differs in the last bit). The proof's inputs came from
`10 ** x`, so every tape saw other inputs, and six tapes stored sRGB results. The engine does not promise the same
last bit across JavaScript engines for these functions (as the procedural and netcode READMEs say); what it promises is
that `@margoengine/math` computes exactly what each replaced package copy computed, on the same engine. So the
engine's maths stays as it is and the proof's digests now hold only exactly specified results: the inputs are built
from exact operations; while the proof runs, Math.sin, Math.cos and Math.hypot are exact stand-ins written with
`+ - * /`, `%` and `Math.sqrt` (golden.js `exactMath`; the old copies and today's math both call them, so a different
expression still gives different bits), and a taped call that uses any other approximated Math function fails the
proof; the results that go through `**` (the sRGB curves in parseColor, srgbToLinear, encodeSrgb, toSrgb and
parseSplat) are stored in a canonical form (tape's `canonical`): each value is first checked to be exactly what the
old copies' own expression (pinned by new text facts) gives on the host running the proof, then recorded as that
expression or as the sRGB byte it decodes. The golden was captured again at the same reference (`2484971`, every call
still checked against the old copies) and `<proof>.json` now names the host it was captured on (`capturedOn`).
`tests/proofs-golden.test.js` replays the proof under the other pow (`--no-use-std-math-pow` on Node 26; Node 22 has
only V8's own) and fails without the fix; it passes on Node 22.22.1 (Windows x64 and Ubuntu x64) and Node 26.12
(Windows x64), and CI runs it on Node 22.12.0 and 26 (`node-compat` in `.github/workflows/ci.yml`). The 19 GPU-call
proofs were not affected: their stored values pass on both pows. They still include results of V8's own sin, cos and
tan (core's cameras), which were the same on every host checked; ARM builds have not been checked.

**NaN payloads.** `geometry.proof.js` (pinned) failed at random on its degenerate-input case ("degenerate bounds"):
baseline and candidate both return NaN for the non-finite vertex, but V8 writes either x86's default NaN (sign bit
set) or the plain quiet NaN into a typed array depending on the code path and JIT tier, which ECMAScript allows
(SetValueInBuffer may store any NaN encoding). Its bit-for-bit comparison and the math tapes now compare NaN payloads
as one value (`canonicalNaN`); every other bit, -0 included, still counts.

| Proof | Pinned: baseline -> claim commit | Current: ref -> working tree |
| --- | --- | --- |
| animation | `59350fc` -> `f47ff3f` | - |
| animator, bvh, creative, decoders, ecs, exporters, geometry, gltf, gltf-pro, labels, loaders, machinery, navmesh, points, post, road, splats, splines, taa, terrain, text, wfc | `f05414a` -> `f47ff3f` | - |
| geometry-subdivide | `bdb7521` -> `96edc75` | - |
| machinery-cad | `7d5a5dd` -> `deb4015` (needs AC power) | - |
| animation-vat (measurement, no baseline) | gltf-pro + animation at `700838e` | - |
| materials-atlas (measurement, no baseline) | geometry + materials at `700838e` | - |
| binding-limit | `e017d50` -> `f8a36ca`: 3,812 calls without IBL, 4,556 with (384 mapped) | - |
| gltf-pro-lighting-hooks | `15c87f1` -> `cf2953e`: 4,556 calls; texture transform: `114130c` -> `7072190` | `667d1a26` |
| materials-uv-transform | `1970fda` -> `700838e`: 1,277 calls; texture transform: `114130c` -> `7072190` | `641246d3`: 1,085 calls |
| lines-perspective | `96edc75` -> `6da7f7e`: 946 calls | `2d192a71` (per-line clipping planes at `86063c47`: the style uniform grew from 128 to 224 bytes and the shader gained a world-position varying and a zero-count plane loop; then `clipIntersection` at `2d192a71` changed that loop to count the planes a point is behind. Unclipped lines' calls and writes changed on purpose both times) |
| math-consolidation | `2484971` -> `4eed254` (math built at the pin) | `2484971` |
| post-stack | `5b1fe66^` -> `5b1fe66`: 12,378 calls (creative `5b1fe66^` -> `3319317`) | `57250a49` |
| selection-xray-off | `46f9484` -> `80d4cfb`: 10,586 calls | `b3ed8ac` |
| clustered-local-shadows | `0ed56b9` -> `590278e`: 482 calls, 8 params.z writes | `57250a49` |
| clustered-area-lights | `67e0172` -> `dab9633`: 482 calls | `57250a49` |
| clustered-light-hooks | `6c20076d` -> `b4700864`: 482 calls without the directional, IES and projector entries and with each attached but empty | `57250a49` |
| environment-hemisphere | `6c20076d` -> `b4700864`: 53 shader texts (IBL, Fog, LightProbes on six core variants, gltf-pro's four shader kinds) and 23 calls without a HemisphereLight | `57250a49` |
| color-output | `7dcc958` -> `225b1d6`: 6,174 calls | `57250a49` |
| deformed-shadows | `38d448e` -> `282e751` | `667d1a26` |
| environment-volumetric | `7c47a09` -> `366ebff` | `2cd81c1`: 70 root calls; 344/533 isolated calls |
| oit-detached | `b803d56` -> `0e02ead`: 2,864 calls (2,964 until a later change replaced the story's transmission material with a plain BLEND one: transmission now draws twice by design) | `641246d3`: 2,392 calls |
| post-ssr | `7c47a09` -> `3cf1453`: 9,269 calls | `151aa744`: 12,431 calls (AgX normalised for older refs, see below) |
| post-ssr-models | `3cf1453` -> `838ae6e`: 30,858 calls | `151aa744`: 37,182 calls |
| taa-velocity | `6c20076d` (before the `taa.velocity` getter) -> `e1a20e13` (the motion-blur commit): 16,923 calls at 1x and 4x, the getter read every frame | `8149bf4e` |
| terrain-ssr | `6c20076d` (before terrain's capture hook) -> the water/terrain SSR commit: terrain.proof.js's story, 6,458 calls in two of its three terrains | `6c20076d` |
| water-ssr | `6c20076d` (before water's capture hook) -> the water/terrain SSR commit: 2,762 calls in 3 stories | `57250a49` |
| quality-presets | `96daac7` -> `01e5e35` | `667d1a26` |
| post-ssao-perspective | `9c761d5` -> `9702e57`: 3,282 calls | - |
| probes-decals | `ecdcb31` -> `7d144fb`: 15 identical entry bundles, 135 + 12,320 calls | - |
| procedural-deps | HISTORICAL: `ed53ec5` -> `fff47af`; the baseline imports simplex-noise and isosurface, since removed from the lockfile, so the runner reports it instead of failing | - |

The only normalisation is `ignoreAgx(calls, ref)`: it blanks the `agx()` body only when the baseline predates `eaddd64`
(AgX re-derived on purpose). Re-running the current checks at the start of this work found one real bug, fixed:
`loopSubdivide` threw a bare TypeError on an index past the vertices (geometry.proof.js's degenerate case; now a named
RangeError). Every other difference was an intended later change (exporters' lazy chunks, SSAO's `a281ad2`/`9702e57`/
`e2cc4c5`, splats' orthographic shader `5cf148e`, later edits to the probes' sources).

The nine current references above were advanced to `b3ed8ac` on 2026-10-17 to reconcile already committed, intentional
changes. Each previous current reference was first compared with a candidate pinned to clean `b3ed8ac`, which reproduced
its failure before the render-state work. The earlier core change `6a57389` added ambient RGB to the
frame uniform and made SSAO preserve it; that changes the SSAO shader in the post-stack, post-ssr, post-ssr-models and
quality-presets stories, and the uniform declaration in selection. `2091f12` deliberately coalesced glTF draws, reused
shadow scratch data and changed upload ordering; later PBR uniform specialization and initialization also change the
lighting, transparency and texture-transform stories. `b326518` changed the texture-transform story's normal-frame
orientation and topology descriptors, and `95b4eae` added back-side-only model culling and its selection data. The
texture-transform harness now inlines lazy decoder imports into its single comparison module so modern lazy loading
does not prevent that proof from running.

Three current references were advanced to the rendered-source snapshot `2cd81c1` on 2026-10-17 after inspecting the
complete changed calls; historical baseline/claim pins and every assertion remain unchanged:

- **color-output:** `56ee987` (with `8199756`/`672973f`) unified PBR Neutral display/capture shaders and changed an implicit Tonemap curve from AgX to neutral (uniform float at byte 8: 0 -> 2); 7,734 calls across ten stories now match `2cd81c1`.
- **deformed-shadows:** `56ee987` changed VAT's three shader modules to PBR Neutral; the phone-shadow commits `a126213`/`43aa191` replaced fixed PCSS tables with a noise-rotated spiral, dithered cascade transitions and wrote the pixel scale at shadow-uniform byte 364; every other call and byte is unchanged (147 VAT calls and 319/351/391 shadow calls).
- **environment-volumetric:** `56ee987` changed Fog's mapped core line from Reinhard to PBR Neutral; the root's 70 calls differ only in that shader text, and VolumetricFog still leaves 344/533 external calls identical at 1x/4x with its original pass-count assertions.

The remaining seven current references were reconciled on 2026-10-17 after auditing every changed call against the
later intended fixes. Historical baseline/claim pins, assertions and the existing normalisations are unchanged.
`8199756` is their last display-shader output change; the two SSR stack proofs additionally need `de93aa5`:

- **gltf-pro-lighting-hooks, materials-uv-transform and oit-detached:** `ffd0f05` introduced the shared cotangent frame and corrected its bitangent direction. The lighting story also includes `9210036` IBL multiple-scattering compensation and the earlier phone-shadow shader changes. Texture-transform and transparency pipelines retain `ede41e8`'s zero face/alpha constants (`1fef1b3` only extracted that transform). The PBR Neutral/display hook changes end at `8199756`. Complete traces match that ref: 4,476, 1,321 and 2,732 calls respectively. `e47130d`'s coat/sheen environment hooks were reviewed too; these synchronous fixtures do not activate those physical-layer shaders, so the proof does not establish their visual correctness.
- **materials-uv-transform, advanced to `44592a3` on 2026-10-19:** `ffd0f05`'s bitangent direction is glTF's (B toward decreasing v), but materials meshes have three.js UV orientation and flipY uploads, so their normal maps without tangents shaded inverted (GPU-measured in `scripts/normal-map-orientation-gpu-check.js`). `44592a3` gives normal-mapped materials meshes `+b` through materials feature letter `n`. Against `8199756`, exactly one of the 1,321 calls differs: the normal-mapped box's shader module, by the one character `-b*scale` -> `b*scale`. Every other call, the glTF meshes and the four materials meshes without a normal map, is unchanged.
- **materials-uv-transform, advanced to `fd4d2156` on 2026-10-24 (duplicate cleanup):** gltf-pro and materials now make mip chains with one generator (`packages/shared/mipmaps.js`); each still keeps its own pipeline cache, so the call count is unchanged (1,321). Against `44592a3` only materials' own mip calls differ: its shader module text is the shared copy (the same WGSL, different whitespace) and its single-layer mip views drop the `format` field, which defaults to the texture's format. Every other call is byte-identical.
- **quality-presets:** `4a098bf` deliberately fills light/phone shadow and phone scatter options; explicit values still win. Its six proof readers also include `aa8e8e9`'s slot/frame particle seeds (respawn buffer 8 -> 4 bytes, frame uint at byte 216) and `73102bf`'s minimum-size billboards (projected-pixel scale at byte 92), plus the intended shadow pixel scale at byte 364 and display changes. All no-preset traces and preset/explicit comparisons pass against `8199756`; terrain/scatter are not readers in this proof.
- **post-stack:** `5c047b2` replaced the old two-dispatch Bloom with its downsample/upsample mip chain, bilinear sampler, Karis weighting, averaged strength and output dither. PBR Neutral capture/display and the implicit Tonemap curve also changed intentionally. Its 12 stories now match `8199756` at 14,610 calls; creative's historical `5b1fe66^` -> `3319317` pair is unchanged.
- **post-ssr and post-ssr-models:** the same Bloom/display changes apply, and `de93aa5` makes intermediate SSAO/SSR composites return linear colour instead of `toDisplay(c)`. Full traces match `de93aa5` at 12,431 and 37,182 calls. Relative to the earlier display snapshot, all other calls, resource descriptors and buffer bytes are unchanged. Bloom's HDR replacement was source-audited in that fix; these specific stacks place Bloom directly before FXAA and do not exercise a later HDR consumer of Bloom.
- **terrain/scatter varying allocation:** `957c58b` was checked separately because none of these seven proofs imports those packages. Core's locations 0-3 stay unchanged; terrainId changes 6 -> 4; scatter alone retains 4/5/6, while terrain plus translucent scatter now uses terrainId/emissive/occlusion/translucency at 4/5/6/7 instead of declaring location 6 twice. Complete generated shader diffs contain only those varying-number changes.

**color-output, post-stack, quality-presets and water-ssr, advanced to `780b785c` on 2026-10-24 :** each
changed call was inspected; historical baseline/claim pins and every assertion are unchanged. color-output and
post-stack: Tonemap's shader text only, from the clean-room AgX rewrite (`4a58b5d6`; the curve functions are
generated from one constant table and only the selected curve runs), with the same calls, bindings and uploads.
quality-presets: its volumetric story only (the SSAO, clustered and tonemap stories match): the fog shader subtracts
the view's origin so a fog view can sit anywhere on the canvas, and its bind groups are created by the per-view state
helper in a different order; uniform bytes are identical (`f30bfe1e`). water-ssr: water keeps its foam textures per
view (`f30bfe1e`), which changes when they are created and released.

**Eleven current references advanced to `57250a49` on 2026-10-24 (clean-room rewrites):** each failing proof was
re-run with every assertion reported (not stopped at the first), and every difference is shader text from a named
rewrite; call counts, descriptors, bindings and every buffer write are unchanged (4,476 / 1,321 / 2,732 / 14,610 /
7,734 calls as before).

- **clustered-area-lights, clustered-light-hooks, clustered-local-shadows:** 10 of 241 calls per story (shader
  modules only): the light loop's falloff and cone are now `packages/shared/light-terms.js`'s `legacyTerms` (window
  `clamp(1 - (d/range)^4, 0, 1)^2` over `max(d^2, 2^-12)` instead of `0.01`; the same Hermite cone, written with a
  `ramp` local and a 1e-6 instead of 1e-5 guard; `adff4e06`).
- **gltf-pro-lighting-hooks:** 75 of 2,238 calls per sample count: the shared cotangent frame
  (`shared/tangent-frame.js`, `adff4e06`; B = grad(-v) as before), one extra blank line after it, and the clustered
  falloff text above.
- **oit-detached:** 38 of 1,366 calls: the cotangent frame text only.
- **materials-uv-transform:** 7 of 1,321 calls: the cotangent frame text; on the normal-mapped materials box the
  feature edit is now `mat3x3f(gu*k,-gv*k,n)` (the same +b for bottom-left UVs, `69e926e7`); the matcap lookup is
  rewritten (view-space basis with a fallback when the eye looks straight along y, scale 0.49 instead of 0.495).
- **environment-hemisphere:** shader texts only: the cotangent frame; sheen's ambient uses the directional albedo
  `margoSheenAlbedo(n.v, roughness)` instead of the constant 0.157, the Charlie lobe is `margoSheenBRDF`, sheen
  roughness is clamped to 0.03-1 instead of floored at 0.07, and the sky term of the probes path reads the base normal
  `s.n` instead of the clearcoat normal (`adff4e06`).
- **color-output and post-stack:** 4 (2 for the Bloom stack) shader modules per story: the refitted ACES curve
  (`26cb6fc0`, see `packages/tonemap/NOTICE.md`); creative's pinned pair is unchanged.
- **quality-presets:** 2 calls in the volumetric story: VolumetricFog's 3D value noise now uses a PCG lattice hash
  and a second octave offset of (23.7, -11.3, 5.9) at x2.11 (`2d28deb2`); every other story matches.
- **water-ssr:** 4 calls in each of 3 stories: the ripple gradient noise is rewritten (PCG-hashed corner angles,
  explicit quintic-fade derivatives; `2d28deb2`).

**post-ssr and post-ssr-models, advanced to `151aa744` on 2026-10-25 (FXAA rebuilt clean room):** `151aa744`
changes only `packages/post/src/fxaa.ts`: the FXAA fragment shader is rewritten from Lottes' whitepaper (texel loads
for the 3x3 neighbourhood, its own contrast thresholds 0.15/0.05, a 10-step end search with an end threshold of a
quarter of the gradient, sub-pixel preset 0.75). Both stacks end in FXAA, so their FXAA shader module text differs
from `de93aa5`; the call counts are unchanged and the full traces match `151aa744` at 12,431 and 37,182 calls.

**materials-uv-transform, advanced to `c640305c` on 2026-10-25 (a material without maps reads no textures):** the
story's untextured materials box (`new Material({color: '#3080ff'})`) now draws materials' bare shader: its texture
reads are constant texels and gltf-pro creates none of its five default textures for it. Against `57250a49`, 1,321
-> 1,296 calls: 5 fewer textures, texture writes, views, samplers and destroys, and one new shader module (the bare
one); every other kind of call has the same count (84 draws, 110 uniform writes) and every earlier shader module is
still compiled. The full trace matches `c640305c` at 1,296 calls.

**materials-uv-transform, advanced to `1fafaf6a` on 2026-10-26 (materials meshes draw in one render pass):** the
materials queue now gives every mesh's `draw()` one `PBRDrawRun`, so consecutive opaque meshes continue one render pass
instead of each beginning and ending its own. Against `c640305c`, 1,296 -> 1,224 calls: 36 fewer `beginRenderPass`
and `pass.end` pairs; the 84 draws, 11 shader modules and 110 uniform writes are the same, in the same order, and every
shader module is unchanged. The full trace matches `1fafaf6a` at 1,224 calls.

**gltf-pro-lighting-hooks, oit-detached and materials-uv-transform, advanced to `b953071e` on 2026-10-26 (the materials
draw work, perf-history entry 22):** gltf-pro now writes every draw's uniform into one per-device arena uploaded once a
frame, shares a 192-byte view block between the draws of a view, shares pipelines device-wide and sets a pipeline,
bind group or buffer only when it changes, and a run's blended draws continue its render pass. Each proof passes
unchanged against the commit before this work on main (`c7a20964`, pinned run); against it the working tree differs
only in those calls, with the same draws and shader modules (first sample count of each story):
gltf-pro-lighting-hooks 2,238 -> 2,090 calls (buffers 18 -> 15, `writeBuffer` 177 -> 23, bind groups 258 -> 285,
`setPipeline` 168 -> 126, destroys 26 -> 23); oit-detached 1,366 -> 1,250 (buffers 18 -> 13, `writeBuffer` 114 -> 18,
bind groups 138 -> 141, `setPipeline` 102 -> 86, destroys 23 -> 18); materials-uv-transform 1,224 -> 1,117 (buffers
22 -> 16, `writeBuffer` 110 -> 39, render passes 52 -> 40, destroys 49 -> 43). The images are checked by the visual
check. The full traces match `b953071e`.

**materials-uv-transform, advanced to `e2cb3815` on 2026-10-26 (steady materials keep their shader, perf-history entry
23):** a draw whose material is unchanged keeps last frame's shader and pipeline, and that kept pipeline makes the
first derivation of a frame complete, so it runs the material's `bindings()` before the render pass begins rather
than inside it. Against `b953071e` the working tree makes the same 1,117 calls with the same arguments (the same 100
draws and shader modules, byte for byte); only 30 calls of frame 9 move: the texture `update()` upload and its mip
chain (`writeTexture`, views, the mip bind groups, passes and draws) now come before the beauty pass's
`beginRenderPass` instead of after it. Both orders upload before the frame's commands run. The full trace matches
`e2cb3815`.

**gltf-pro-lighting-hooks, oit-detached and materials-uv-transform, advanced to `641246d3` on 2026-10-26 (speed matrix
row 12.7, perf-history entry 32):** gltf-pro makes one default view per texture and one sampler per device and sampler
state, where it made one of each for every map slot of every primitive. Against the previous references the working
tree makes exactly those calls fewer and nothing else differs: with sampler and view calls left out and object ids
renumbered, every remaining call is identical, in the same order (first sample count of each story):
gltf-pro-lighting-hooks 2,090 -> 2,056 calls (samplers 23 -> 4, views 34 -> 19), oit-detached 1,250 -> 1,196 (samplers
31 -> 2, views 36 -> 11), materials-uv-transform 1,117 -> 1,085 (samplers 40 -> 11, views 69 -> 66). Bind groups bind
the shared view or sampler with the same descriptor in place of a fresh one. The full traces match `641246d3`.

**deformed-shadows, gltf-pro-lighting-hooks and quality-presets, advanced to `667d1a26` on 2026-10-27 (shadows bug fix):**
the soft filter's blocker search reached the cascade's near plane, `casterMargin` past the scene, and left the
animation guide's robot with bright dots in the head's shadow and a dotted ground-shadow edge (known bug closed; regression
test `packages/shadows/test/lit-faces-browser.mjs`). `Shadows` now reduces each changed map to each layer's nearest
depth and the search spans to it. The calls differ in exactly that, and only in the `Shadows` calls of each story: the
frame uniform is 384 bytes instead of 368 (`nearest:vec4f` appended to `ShadowFrame`), one 16-byte storage buffer, the
reduction's shader module, compute pipeline and bind group, and, after the depth passes of a frame whose map changed
under the default `'soft'` filter, a `writeBuffer` seeding the buffer with 1.0, one compute pass and a
`copyBufferToBuffer` into the uniform; object ids after the new buffer are renumbered. The receiver WGSL of `'soft'` reads
the nearest depth, takes its first search read at the receiver's texel and compares with `min(plane offset, 0)`;
`'pcf'` and `'hard'` receivers change only by the appended struct member. Against the old references the first
difference in each story is the uniform's size and the new buffer.

**taa-velocity, advanced to `8149bf4e` on 2026-10-26 (speed matrix row 13.7):** TAA's object velocities, a render pass per mesh before,
now draw in one render pass, the PBR snapshots in one compute pass after it, and the camera rows moved out of each
mesh's block into one camera block (binding 4) written once a frame, so a still mesh's block is written only when it
changes. The calls differ in exactly that: fewer eginRenderPass/eginComputePass/end calls, smaller object blocks
(160 or 192 bytes instead of 288 or 320) and fewer writeBuffer calls; the draws, pipelines' vertex and fragment
work and the velocity values are the same, and the parity screenshot matches three.js as before (SSIM 0.641, delta E
2.86, which differed already: the TAA algorithms differ).

**taa-velocity, advanced to `d41cdafd` on 2026-10-21:** a hygiene pass converted TAA's bare Errors.
The story records each thrown error as a `throw` entry (class and message), and exactly three per run changed: the
singular-camera frame now throws MargoError `'state'` (`Invalid TAA camera; give the camera a finite, invertible
projection`), and the two replaced-vertex-buffer frames throw TypeError with the same text. All 7,900 (1x) and 9,023
(4x) entries match `6c20076d` apart from those three; every GPU call, descriptor and buffer write is unchanged. The
pinned pair now names its claim commit `e1a20e13` instead of the working tree.

These current checks still compare every recorded call, descriptor, shader and buffer write exactly against the
committed reference, without normalizing away render-state changes. Pinned baseline/claim pairs are unchanged.
Assertions that the baseline predates fitted shadows, SSR, model capture or x-ray apply to pinned runs; current runs
retain the positive feature assertions, including fitted shadow ranges, SSR/model-capture APIs and x-ray-on differing
from x-ray-off within the candidate. No reference includes the new render-state feature.

Visual references now preserve hardware provenance. The original Intel/Edge files in `tests/visual` are unchanged;
NVIDIA/Ampere with Edge 155 selects `tests/visual/profiles/nvidia-ampere-msedge-155`. Its 55 views were captured four
times from the committed package, demo and asset sources at `b3ed8ac`, using only the updated capture harness and
desktop power probe. All 220 captures succeeded on AC power; 47 views were byte-identical across all four runs.
The [source audit](../../tests/visual/profiles/nvidia-ampere-msedge-155/source-audit.json) records the full commit/tree,
607 verified Git LFS asset hashes and matching default/high-performance adapters during and after capture.
The noise formula remains three times measured noise plus the existing fixed allowances. Profiles require matching
GPU/browser identities; new profiles require a complete repeated capture with clean rendered inputs. Individual
views retain their own source and environment provenance when a profile is partially refreshed.
The render-state candidate, including upstream kernel-column maintenance `ac2fdfa`, passes all 55 comparisons against
that NVIDIA reference with the new controls disabled. `npm run check:merge` reproduces the full build, proof and visual gate.

**Proof stories no longer record error text (DX pass B, 2026-10-26):** a "rejected frame" in the post, colour, taa,
splats, water and quality-presets stories used to note the thrown message, so rewording an error message (messages now
name their fix) changed the recorded calls. The stories note only that a throw happened (`gpu.note('throw')`), for
reference and candidate alike; GPU calls, bindings and uploads are unchanged.
