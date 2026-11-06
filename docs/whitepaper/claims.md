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
Ryzen 9 9950X and an NVIDIA RTX A6000, and say so. On Apple silicon, only the results that name an Apple M6 Mac mini. Nothing has been measured on Android, in Firefox
or in Safari. [docs/limits.md](../limits.md) lists what is untested.

## Headline numbers

| Claim | Where | Evidence | Command | Status |
| --- | --- | --- | --- | --- |
| Core + stage is 22,815 B gzip (56,578 B raw), Wasm kernel and WebGPU backend included | README, site, docs/limits.md | `examples/package-benchmarks/results/entry-sizes.json` at the core cleanup landing (2026-10-30) | `npm run build:packages && npm run measure:size` | PROVEN |
| The build fails at 25,000 B gzip for core + stage | README, site | `scripts/core-budget.js`, run by `build:packages` and `measure:size` | `npm run build:packages` | PROVEN |
| Every other package is optional and has its own size | README | `entry-sizes.json` (every exports entry and worker) | `npm run build:site` | PROVEN |
| An engine starts with 1,024 entity slots and doubles up to 8,388,608 | site | `packages/core/src/kernel.ts`; `tests/core-dirty-transforms.test.js` (1,000,000 entities) | `npm test` | PROVEN |
| Relocated (2026-10-29). | - | - | - | relocated |
| Speed compared with three.js | nowhere | No claim is made. See below. | - | no claim |

## Whitepapers

`site/whitepaper/engine.html` and `site/whitepaper/voxel.html` state each figure next to its source file, hardware
and commit.

| Page | Figures | Evidence | Status |
| --- | --- | --- | --- |
| engine | Core 21,431 B (52,756 raw), core + stage 22,815 B (56,578 raw), 2,185 B under the gate | `entry-sizes.json` at the item 53.2 dynamic instances landing (2026-10-29, dirty: false) | PROVEN |
| engine | 100 packages (none published to npm yet); `npm i margoengine`; kit sizes (game 307,012, viz 277,396, web 155,058 B) | `docs/catalog.json`; `docs/guides/kits.md`, re-measured by `tests/umbrella.test.js` (fails on a 3% move) | PROVEN |
| engine | Starter first frames: web 788, react 835, viz 968, game 1,308 ms (vite dev, packages linked, one run each, RTX A6000 PC) | `examples/package-benchmarks/results/starters-first-frame.json` (`tools/create-margo/test/browser-check.mjs`) | PROVEN (dated, one run) |
| engine | 6,498 tests, 6,496 pass, 2 skipped (Node 26.12, `01836c27`) | `examples/package-benchmarks/results/test-count.json` | PROVEN |
| engine | Section 10 (what the checks caught): figures quoted from fix commits (`b6bea3e9`, `baa66526`, `ab27353f`, `6d08b0af`, `3a59aa55`, `7714e84e`, `109ec352`, `7ab8cd13`, `6ddd733b`, `85c96a55`, `49dca9dd`, `51d8786a`, `a4fca9be`, `7f0dd465`, `0687e6ec`, `86ed9107`) and `docs/known-bugs.md` | [perf-history.md](perf-history.md) entries 37 to 44 | PROVEN (each from its commit message) |
| engine | Section 10: Linux run (42 of 43 suites started, 38 passed, 3 stopped at 82 C) at `b92998d6`; AMD 680M sweep at `650291de` | run logs on the machines that ran them, not committed | dated run log, not committed |
| engine | Section 10: outside audit of `74a01810` (20 findings, verify 6,344 of 6,346 with 2 skipped, 36 fuzz targets, Arc 140V 4x MSAA 4 of 450 frames up to 9 of 255) | the auditor's report (private: it holds details of unfixed findings) | external report, dated |
| engine | Section 10: 16 of the audit's 20 findings fixed, by class, with regression tests | `4bc89574`, `c6e7623c`, `b96f5f40`, `158076f1`, `6bebf878`, `8c8b51a0`, `ddc5c5ff` and the tests they add | PROVEN (each test fails without its fix, per its commit) |
| engine | Parity 153 / 4 / 4 of 161 three.js rows | `docs/three-parity-matrix.md` | PROVEN |
| engine | Views and scenes: +867 B gzip | `docs/multi-view-roadmap.md` size table (21,343 -> 22,210 B) | PROVEN (dated) |
| engine | Voxel multiplayer: 900 spread / 350 crowded at 20 ticks per second | `packages/voxel-net/bench/results.json`, `docs/voxel-net-capacity-2026-10-21.md` | PROVEN |
| engine | 62 visual views, 4 captures each | `tests/visual/profiles/nvidia-ampere-msedge-156` | PROVEN |
| engine | About 88% of browsers support WebGPU (85.8% full + 2.02% partial) | external: caniuse.com/webgpu, StatCounter data for September 2026, read 2026-10-24 | external source, dated |
| engine | Retired (2026-10-29). | - | retired |
| engine | Kernel scaling, culling, large coordinates, design envelope | `results-scale-node.json`, `large-coordinates-gpu.json`, the LIM rows below | PROVEN (dated) |
| engine | 49 proofs, 20 ongoing | `proofs/*.proof.js` and the `ongoing` list in `proofs/run.mjs` | PROVEN (file counts) |
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
- Frame time gained by `optimizeMesh`. Its tests measure cache misses on a simulated cache and overdraw on a software
  depth buffer; no GPU run is recorded.
- glTF export timing for the test model: measured once on a busy machine (`results/exporters-model.json`), so it is
  not quoted.

## Design envelope (`docs/limits.md`)

| ID | Claim | Evidence | Command | Status | Note |
| --- | --- | --- | --- | --- | --- |
| LIM-001 | "core plus the stage facade is 22,815 B gzip"; the build fails at 25,000 bytes (docs/limits.md, intro) | `examples/package-benchmarks/results/entry-sizes.json` (`coreStage.gzip` 22522, at the commit the record names); `scripts/core-budget.js` (`CORE_STAGE_GZIP_LIMIT`) | `npm run build:packages && npm run measure:size` | PROVEN | The figure moves a little with most changes to core; the record names its commit. |
| LIM-002 | Entities: "8,388,608 slots (2^23)", starts at `capacity` (default 1,024) and doubles; `RangeError: Capacity` / `Capacity: 1..8388608`; a failed growth leaves the store as it was (docs/limits.md, Scale) | `packages/core/src/kernel.ts` (`create`, `grow`), `engine.ts` `createMesh` and `Engine.create` (`capacity ?? 1024`); `tests/core-dirty-transforms.test.js` asserts `/Capacity/` at 2^23 + 1 and growth from 1,024 (in verify) | `node --test tests/core-dirty-transforms.test.js` | PROVEN | See also S-04. |
| LIM-003 | "352.1 B of kernel memory per slot at 1,048,576 slots (351 B by layout)" (docs/limits.md, Scale) | `examples/package-benchmarks/parts/results-scale-node.json` (`kernelBytesPerSlot` 352.1 at 1,000,012 entities; Node 24, AC, quiet-gated at 8% CPU, not diagnostic); layout in `packages/kernel/src/lib.rs` (86 float columns + 7 flag bytes) | `node --expose-gc examples/package-benchmarks/parts/scale-node.mjs` | PROVEN | - |
| LIM-004 | "a static kernel tick costs 3.3 ms at 100,006 entities, 20.2 ms at 499,992 and 41.5 ms at 1,000,012"; "about 41 ns per entity per frame even when nothing moves"; above 1,048,576 slots "not measured" (docs/limits.md, Scale) | Same JSON (`tickStaticMs` 3.328 / 20.153 / 41.461); 41.461 ms / 1,000,012 = 41 ns | same | PROVEN | Node CPU timings, same Wasm as the browser, fake renderer. |
| LIM-005 | `CulledInstances`: "0.41-0.55 ms CPU per frame at 89,883 parts, flat in part count"; "parts lose picking, hierarchy and section caps" (docs/limits.md, Scale) | `examples/package-benchmarks/parts/results-culling.json` (Arc, AC, lock); `packages/culling/README.md` Limits | `node examples/package-benchmarks/parts/culling.mjs` | PROVEN | CPU of `engine.render` with the GPU idle. |
| LIM-006 | `CulledMeshes` "GPU-culls parts that must stay core meshes ... removes GPU work, not the kernel tick" (docs/limits.md, Scale) | `packages/culling/test/culling.test.js` (CulledMeshes redirect test, in verify) | `node --test packages/culling/test/culling.test.js` | PROVEN | Descriptive; no number. The real-GPU pixel check (`parts/culled-meshes.mjs`) commits no result, so the page does not quote it. |
| LIM-007 | Default 100,000 glTF nodes and `.margo` nodes; the quoted `(100001 > 100000; raise the maxNodes option)` errors; `maxNodes` option up to 8,388,608 (docs/limits.md, Scale) | `packages/shared/limits.js` (`countLimit`, `checkCount`), used by `packages/gltf/src/index.ts`, `packages/gltf-pro/src/asset.ts` and `packages/blender/src/index.ts`; `tests/count-limits.test.js` (in verify) | `node --test tests/count-limits.test.js` | PROVEN | Load time and memory past 100,000 not claimed. |
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
| LIM-018 | Retired (2026-10-29). | - | - | retired | - |
| LIM-020 | gltf-pro `maxDownloadBytes` "default 64 MiB", decoded data "4x that (256 MiB by default)", light loader "64 MiB"; ABeautifulGame "528 MiB" decoded, loads with 160 MiB; the quoted errors (docs/limits.md, Assets) | `packages/gltf-pro/src/asset.ts` (`assetLimit`, `budget`), `packages/gltf/src/index.ts` (`limit`), `packages/shared/loading.js` (`${label} byte budget exceeded`), `tests/modern-support.test.js`; conveyor: `packages/gltf-pro/tests/accessors.test.js` ("the 62 MB conveyor GLB parses", passed in verify on `96daac7` with the LFS file checked out) | `node --test packages/gltf-pro/tests/accessors.test.js` | PROVEN | Updated 2026-10-17: the page now states the code's default (`assetLimit` = 64 MiB at `ac0ffc6`, budgets 4x) and its error messages; it used to say 128 MiB. ABeautifulGame: 33 images of 2048x2048 = 553,648,128 B RGBA8, loads in the gallery view `khronos-ABeautifulGame-model` with 160 MiB. |
| LIM-021 | gltf-pro "up to 1,000,000 vertices per primitive", light loader "1,000,000 vertices in total"; "1,000,002 indices decode, 1,000,002 vertices are refused"; quoted errors (docs/limits.md, Assets) | `packages/gltf-pro/src/pack.ts`, `index.ts`; `packages/gltf/src/index.ts` (`glTF exceeds one million vertices`); `accessors.test.js` asserts both (in verify) | `node --test packages/gltf-pro/tests/accessors.test.js` | PROVEN | - |
| LIM-022 | `Error: WebGPU unavailable` / `adapter unavailable` / `WebGPU required`; `@margoengine/webgl` "2,156 B gzip", flat-shaded core meshes, one light, no textures or effects (docs/limits.md, Platform) | `packages/core/src/engine.ts`, `renderer.ts`; `packages/webgl/test/webgl.test.js` (in verify); webgl README; `entry-sizes.json` (`webgl/.` 2156); real-browser WebGL2 checks in `results/gates-browser-tests.json` | `node --test packages/webgl/test/webgl.test.js` | PROVEN | - |
| LIM-023 | CSP: core needs `'wasm-unsafe-eval'`; the standard WebGPU path and the other WebGL2 tiers need no `'unsafe-eval'`, workers included, while the optional WebGL2 CPU compute tier builds code with `new Function` and needs it or is refused (packages/webgl2-compat/README.md); no COOP/COEP; "zero violations on Edge, one policy on the page and every worker" (docs/limits.md, Platform) | `results/csp-check.json`, `results/csp-check-negative.json`, `tests/no-eval-workers.test.js` | `node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/csp-check.mjs` | PROVEN | Chromium only (said on the page). |
| LIM-024 | Without `'wasm-unsafe-eval'`: "Compiling or instantiating WebAssembly module violates the following Content Security policy directive" (docs/limits.md, Platform) | `results/csp-check-negative.json` (the `script-src 'self'` run's page error carries the string) | `CSP_OVERRIDE="<policy>" node scripts/csp-check.mjs harness` | PROVEN | Chromium's wording; other browsers word it differently. The former second string ("Evaluating a string as JavaScript ...") no longer applies: no shipped file evaluates strings. |
| LIM-025 | "Every committed real-GPU result comes from one machine"; iPhone "run by hand ... no scripted run or committed result"; S23 report "unresolved"; untested list (docs/limits.md, Platform) | Every real-GPU result JSON names the same adapter; the iPhone run was by hand and is not committed | - | PROVEN | A statement of absence: no phone numbers are quoted on the page. |
| LIM-026 | Browsers: Edge 155 verified, automated; iPhone Safari by hand only; Firefox and macOS Safari not verified (docs/limits.md, Platform) | Every real-GPU result JSON names chromium 155 / Edge; `results/csp-check.json` | - | PROVEN | - |
| LIM-027 | Relocated (2026-10-29). | - | - | relocated | - |
| LIM-028 | Light probes: one volume of at most 4,096 L1/L2 probes (64 per axis), at most 16 reflection probes; bake "114-121 ms" for 8 volume probes + one 128 px reflection probe (diagnostic); volume SH "within 1.7% of DC"; the four quoted errors; "10,845 B gzip" (docs/limits.md, Rendering) | `packages/environment/src/probes.ts` (`MAX_VOLUME_PROBES`, `MAX_REFLECTION_PROBES`, messages); `packages/environment/tests/probes.test.js` (in verify); `results/probes-gpu.json` (`volume[].maxCoefficientErrorOfDC` <= 0.0171, `bakeTimings` 114.7 / 121.3 / 113.6; quiet gate passed, other jobs running); `entry-sizes.json` (`environment/./probes` 10845) | `node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/probes-gpu.mjs --bench` | PROVEN | Timings labelled diagnostic on the page (busy machine). |
| LIM-029 | Decals: 4,096 per `setDecals`, colour only; "1.64 ms without, 1.64 / 1.97 / 6.36 ms with 1 / 16 / 256" decals at 1280 × 720 4x (diagnostic); the quoted error; "4,118 B gzip" (docs/limits.md, Rendering) | `packages/post/src/decals.ts` (`MAX_DECALS`); `packages/post/test/decals.test.js` (in verify; asserts the error); `results/decals-gpu.json` (`timings`; quiet gate passed, other jobs running); `entry-sizes.json` (`post/./decals` 4118) | `node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/decals-gpu.mjs --bench` | PROVEN | Timings labelled diagnostic on the page. |
| LIM-030 | Malformed and hostile files: every parser ends in a result or its own error; gltf-pro nesting 256 levels; EXR chunk 256 MiB and chunk capacity; Draco/KTX2 decode limit 10 s + 4 s per MiB; the four quoted errors (docs/limits.md, Assets) | `packages/gltf-pro/src/asset.ts` (`parseJSON`, `checkDocument`), `packages/environment/src/exr.ts`, `packages/decoders/src/pool.ts` (`jobTimeout`, `WorkerPool.watch`); `tests/fuzz-formats-regressions.test.js`, `packages/decoders/tests/decoders.test.js`, `packages/gltf-pro/tests/progressive.test.js` (in verify; assert the errors); `npm run fuzz` for longer campaigns | `npm run fuzz -- --target=gltf,gltf-pro,gltf-pro/worker,gltf-pro/ktx2,gltf-pro/progressive,margo,decoders/meshopt,decoders/draco,decoders/ktx2,environment/hdr,environment/exr,environment/ultrahdr,fbx`; `node --test tests/fuzz-formats-regressions.test.js` | PROVEN | Decode times are not claimed. |
| LIM-031 | Frame allocation: per steady-state frame 340 B (was 1,428), 292 B (was 1,076), 860 B (was 26,920) and 1,528 B (was 5,116) for the basic, instanced, shadowed and post scenes; "Not 0 B": 16 B per returned WebGPU object and a boxed frame time; the frame-resources view set (about 120 B in post), the SSAO scene walk and the fixture setters are measured and left (docs/limits.md, Scale) | `scripts/frame-alloc-browser.mjs` (`FLOORS`, the method in its header; fails over a floor); `tests/frame-alloc.test.js` (in verify: the Node core frame stays under 256 B, shadows add under 512 B, the probe notices allocation; V8 middle-tier probes: core 780 B, shadows add 620 B, cascade fit 128 B on V8 14 and newer, 780, 1,120 and 256 B on V8 13 (Node 24), whose Maglev boxes every Math.sqrt call; `npm run test:frame-alloc:nodes` runs them on every Node found); before figures measured at the parent commit with the same script; RTX A6000, Edge 156 | `node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/frame-alloc-browser.mjs` | PROVEN | Medians only; the mean also carries timer and idle-task frames and is reported, not gated. The 16 B wrappers were measured per call with the sampling heap profile (`--profile`). |
| LIM-032 | Moving transforms per frame: 14,500 meshes set position.y and rotation.y every frame within 4 ms of CPU (a quarter of a 60 Hz frame), the lowest of three runs (14,500, 16,000, 17,700) on a Ryzen 9 9950X, Node v26.12.0, stand-in GPU device (docs/limits.md, Scale) | `examples/package-benchmarks/transforms-budget.mjs` (method in its header); record `examples/package-benchmarks/results/transforms-budget.json` | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/transforms-budget.mjs --out=<file>` | PROVEN | CPU work only (no GPU time); the figure moves with the CPU and with other load, so it is the lowest of repeated runs, not a promise for other machines. |
| LIM-033 | Biome streaming: the flythrough limits (0.3 ms to the slowest 1 percent, 1 ms to the worst frame), `budget` 0.25 ms; per tile job 2.1 MB of fresh arrays for a placed tile (24.0 MB before) and 0.2 MB for a view tile (4.6 MB before); RTX A6000 p99 +0.20 / worst +0.00 ms, 2 of 111 tiles late, latency p99 337 to 348 ms; Ryzen 7 7735HS / Radeon 680M laptop, three cool runs at the landed code: p99 +0.1 / +0.0 / -0.3 ms, worst +0.3 / +0.9 / +0.6 ms; with the still-camera plan 30 frames after the last plan (no plan right after a plan), three cool runs: p99 +0.1 / +0.1 / +0.2 ms, worst +0.8 / +0.8 / +0.3 ms; landed code b8210cd3, three runs: 2 of 3 pass (run 1 p99 +0.1 / worst +0.6 ms; run 2 p99 +0.1 / worst +1.0 ms, at the limit; run 3 fails, p99 +0.4 ms against 0.3, worst +0.4 ms), plan, send and packing lines clean in all; 8 of 9 laptop runs of this code pass, the miss is 0.1 ms (one timer step) over the p99 limit in a run with fewer streamed frames (703 to 1,083 against about 1,150 to 1,200); RTX A6000 p99 +0.10 to +0.20 ms; limits not loosened; view entry 7,514 B gzip, up to 7,516 B accepted by Scott 2026-10-29 (docs/limits.md, Scale) | `packages/biomes/tests/flythrough-check.mjs` (`P99_LIMIT`, `MAX_LIMIT` in `flythrough-limits.mjs`); `packages/biomes/tests/tile-memory.test.js` (fails over 4 MB per placed tile or 0.5 MB per view tile); `scripts/quality/baselines/sizes.json` (history entry); RTX A6000 desktop, Edge 156, 2026-10-29; the APU figures from the coordinator's Ryzen 7 7735HS / Radeon 680M runs | `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/biomes/tests/flythrough-check.mjs`; `node --test packages/biomes/tests/tile-memory.test.js` | PROVEN | The APU result files stay on that machine; the check runs there by hand. Worst-frame margin there is small (+0.9 ms in one run against 1 ms), and its prefetched baseline varies from run to run. Late tiles and latency are from one flight pair on the desktop. |
| LIM-034 | Scatter cull in candidate order: distribute pass 0.012 / 0.044 / 0.049 ms atomic against 0.046 / 0.091 / 0.222 ms ordered at 10,000 / 110,000 / 1,000,000 candidates on the RTX A6000, 0.011 / 0.111 / 0.485 against 0.043 / 0.231 / 1.050 ms on an Apple M6; LOD draw unchanged; about 58 B more per candidate; still 4x MSAA frames bit-identical on both GPUs (docs/limits.md, Rendering) | `examples/package-benchmarks/results/scatter-cull-gpu-a6000.json`, `scatter-cull-gpu-m6.json` (`summary`, `parity.same`); `packages/scatter/test/order.test.js` (in verify); `packages/scatter/test/repeat.browser.mjs` | `node examples/package-benchmarks/scatter-cull-gpu.mjs --a=test-results/scatter-base --b=packages/scatter/dist` (baseline build in its header); `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/scatter/test/repeat.browser.mjs` | PROVEN | Medians of 8 alternating rounds of 20 frames; the M6 run was over ssh without the GPU lock and with no AC check (a desktop). |
| LIM-035 | Native glass tint draw: "0.52 ms", "0.33 ms", "0.39 ms" (four maps, one layer), 4.46 / 2.56 / 3.47 ms (16 layers), 6.88 / 3.41 / 4.65 ms (eight maps), 3.41 against 2.69 ms (no maps), 17 to 57 percent, 0.03 to 0.2 ms per million glass pixels at 1920 × 1080 4x (docs/limits.md, Rendering) | `results/tint-pass-gpu.json` (`rows`; quiet gate passed); `examples/package-benchmarks/tint-pass.html` | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/tint-pass-gpu.mjs` | PROVEN | One machine, sun light only; perf-history entry 47. |
| LIM-036 | NURBS: `tessellate` halves a span at most 12 times; no trimming, knot insertion or degree elevation; a full `nurbsCircle` stays at its radius to 1e-12 at every parameter (docs/limits.md, Geometry) | `packages/geometry/tests/nurbs.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-037 | Mesh sampler: independent draws, no minimum spacing; vertex weights linear across each triangle (docs/limits.md, Geometry) | `packages/geometry/tests/sample.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-038 | Mesh optimisation: under 0.8 cache misses per triangle from shuffled grids, spheres and knots on a 16-vertex first-in first-out cache; over 40 percent less overdraw on nested shells with the miss ratio within 6 percent (docs/limits.md, Geometry) | `packages/geometry/tests/optimize.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-039 | Precise maths against the WGSL builtins: 1.0 to 1.8 times for one call per element, `tan` 2.3 times, `pow` 3.0 times (2.19 against 0.72 ms), path tracer rays 1% to 7% of a traced sample | `results/precise-math-gpu.json` (`compute`, `tracer`; quiet gate passed) | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/precise-math-gpu.mjs` | PROVEN | One machine; ratios under about 1.6 are not firm (timer tick 0.066 ms); perf-history entry 48. |
| LIM-040 | Curve bending: frames sampled `segments` times, default 256; only vertices move; a shape wider than a bend radius folds (docs/limits.md, Geometry) | `packages/geometry/tests/flow.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-041 | Extrusion UV generators: called once per triangle corner; wall `u` measured on the outline before the bevel (docs/limits.md, Geometry) | `packages/geometry/tests/extrude-uv.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-042 | Split tangents match Blender's MikkTSpace at every triangle corner, above 0.9995 by dot product with equal signs, on a mirrored sheet and an exported glTF (docs/limits.md, Geometry) | `packages/geometry/tests/tangent-split.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-043 | Baked skin: four joints per vertex, linear blending, Float32 output (docs/limits.md, Geometry) | `packages/geometry/tests/mesh-utils.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-044 | Delaunay triangulation: exact predicates, no added points, crossing constraints refused; smallest angle never worse than triangulateShape on the same points (docs/limits.md, Geometry) | `packages/geometry/tests/delaunay.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-045 | Line3 and Triangle: segment distance matches a sampled reference on 1,000 seeded pairs (a quarter nearly parallel), closest point never beaten by a grid search on 500 seeded triangles, `intersectsBox` equals polygon clipping on 5,000 seeded pairs, degenerate input gives no NaN (docs/limits.md, Geometry) | `packages/math/test/line3-triangle.test.js` | `npm test --workspace packages/math` | PROVEN | |
| LIM-046 | Polygon booleans and offsets: every sampled point matches the operation and true distance; no result edges cross, at scales from 2^-500 to 2^500 (docs/limits.md, Geometry) | `packages/geometry/tests/polygon.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-047 | Project and unproject: core cameras on both depth conventions, an orthographic hook, 2,000 seeded round trips within 1e-6 relative, null behind the camera (docs/limits.md, Geometry) | `packages/math/test/project.test.js` | `npm test --workspace packages/math` | PROVEN | |
| LIM-048 | SH3: basis orthonormal over the sphere within 1e-3, irradiance matches a numerically integrated clamped cosine within 2e-3, a distant light gives exactly 17/16 and 1/16 (docs/limits.md, Geometry) | `packages/math/test/sh.test.js` | `npm test --workspace packages/math` | PROVEN | |
| LIM-049 | Sweep and loft: volumes match closed forms, solids are closed and face out, smooth lofts pass through every section (docs/limits.md, Geometry) | `packages/geometry/tests/sweep.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-050 | Capsule: box, OBB, triangle and capsule tests match the exact point distance minimised along the axis on 6,500 seeded pairs; pushOutOfTriangle always resolves the overlap on 2,000 pairs; ray entries match sphere tracing on 2,000 rays within 1e-6 (docs/limits.md, Geometry) | `packages/math/test/capsule.test.js` | `npm test --workspace packages/math` | PROVEN | |
| LIM-051 | Tessellation: no edge stays over the limit, the surface does not change, and meshes stay closed across seams and after displacement (docs/limits.md, Geometry) | `packages/geometry/tests/tessellate.test.js` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-052 | GPU geometry: generated vertices match closed forms and the curve through their points on a real GPU, with triangles facing their normals, and survive a replaced vertex buffer and a lost device (docs/limits.md, Geometry) | `packages/geometry/tests/gpu.test.js`, `packages/geometry/tests/gpu-check.mjs` | `npm test --workspace packages/geometry` | PROVEN | |
| LIM-053 | A package's frame is one colour render pass, unchanged bit for bit in opaque scenes (docs/limits.md, Rendering) | `packages/culling/test/gpu/last-pass-check.mjs`, `tests/modern-msaa.test.js` | `npm run test:gpu --workspace packages/culling` | PROVEN | RTX A6000 only |
| LIM-054 | OBB: intersectsOBB touches and separates on each of its 15 axes alone and matches polygon clipping on 1,000 seeded pairs; intersectRay finds the nearest entry within 1e-9 relative (docs/limits.md, Geometry) | `packages/math/test/obb.test.js` | `npm test --workspace packages/math` | PROVEN | |
| LIM-055 | Colour conversion: sRGB red gives the published Display P3 value within 1e-4, all 16 pairs of the four named spaces round trip within 1e-12 and match `Color`, and P3 green keeps its negative sRGB channels (docs/limits.md, Geometry) | `packages/math/test/color-space.test.js` | `npm test --workspace packages/math` | PROVEN | |
| LIM-056 | Scheduler: stable order from before and after, cycles and missing names refused by name, one run per paid fixed step with the remainder carried, at most maxSteps with the rest reported as dropped (docs/limits.md, Entities) | `packages/ecs/test/schedule.test.js` | `npm test --workspace packages/ecs` | PROVEN | |
| LIM-057 | Change detection: net added, changed and removed lists equal a snapshot diff of the window over 500 seeded rounds of mixed work with slot reuse, and each tracker keeps its own window (docs/limits.md, Entities) | `packages/ecs/test/changes.test.js` | `npm test --workspace packages/ecs` | PROVEN | |
| LIM-058 | Query filters and tags: results equal a filter over every entity on 200 seeded scenes, and forEach survives structural changes made while it runs (docs/limits.md, Entities) | `packages/ecs/test/query.test.js` | `npm test --workspace packages/ecs` | PROVEN | |
| LIM-059 | Engine bridge: a real engine and transform kernel get position, quaternion and scale from one sync, also after the store grows; disposed meshes are reported, and their reused slot is not written (docs/limits.md, Entities) | `packages/ecs/test/engine.test.js` | `npm test --workspace packages/ecs` | PROVEN | |
| LIM-060 | Exact booleans: offsets from 1e-3 down to one unit in the last place, turns down to 3e-16 radians and 60 seeded rotated pairs give closed valid meshes whose union, intersection and difference volumes agree within 1e-6 (1,500 further seeded rounds measured a worst error of 2.7e-9) (docs/limits.md, Geometry) | `packages/mesh-edit/tests/boolean-exact.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-061 | Modifier stack: mirror, array, solidify, screw and lattice give the closed-form volumes within 1e-9, closed manifold edges and repeatable IDs, and the stack re-runs on a new base and reuses earlier stages (docs/limits.md, Geometry) | `packages/mesh-edit/tests/modifiers.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-062 | Smoothing: Taubin halves the noise of a noisy sphere over 20 passes with its volume within 2% while Laplacian shrinks it, and selected and open-edge vertices obey their limits (docs/limits.md, Geometry) | `packages/mesh-edit/tests/smooth.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-063 | Remeshing: isotropic remeshing at least halves the spread of edge lengths on an uneven sphere with vertices within 0.02 of its surface, a cube keeps its volume within 1e-9 with every corner and crease, and voxel remeshing gives a closed surface with volume within 3% (docs/limits.md, Geometry) | `packages/mesh-edit/tests/remesh.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-064 | Sculpting: draw, inflate, smooth, grab and crease move the surface as specified inside the brush only, symmetry matches within 1e-12, dynamic topology keeps a closed sphere closed under a long pull, and undo and redo restore shape and triangle count (docs/limits.md, Geometry) | `packages/mesh-edit/tests/sculpt.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-065 | Hole filling: removed cube faces come back closed with volume within 1e-12, faces around a hole do not change, and a sphere's filled cap stays within 0.08 of the sphere with fairing lifting it above the plain fill (docs/limits.md, Geometry) | `packages/mesh-edit/tests/holes.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-066 | Relationships: pairs equal a plain list of pairs over 5,000 seeded steps with destroys, a 100,000 deep cascade does not overflow the stack, and a loop across two cascading relations frees each slot once (docs/limits.md, Entities) | `packages/ecs/test/relations.test.js` | `npm test --workspace packages/ecs` | PROVEN | |
| LIM-067 | High-to-low baking: flat surfaces bake (128, 128, 255), a 0.5 slope bakes its tilt within 2 of 255 in X and in glTF green, a bump lands at its own texels, and occlusion repeats exactly by seed (docs/limits.md, Geometry) | `packages/mesh-edit/tests/bake.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-068 | Vertex groups: weights follow extrude, subdivide, delete and weld through each edit's vertex map, created vertices take their neighbors' mean, and skin attributes sum to 1 per vertex with the strongest joints first (docs/limits.md, Geometry) | `packages/mesh-edit/tests/weights.test.js` | `npm test --workspace @margoengine/mesh-edit` | PROVEN | |
| LIM-069 | Growable worlds: ids, rows and array references survive growth, seeded work over 20,000 steps matches a plain model, and a loop runs about twice as long as on a fixed World (docs/limits.md, Entities) | `packages/ecs/test/growable.test.js`, `examples/package-benchmarks/ecs-growable.mjs` | `npm test --workspace packages/ecs` | PROVEN | |
| LIM-070 | Closest point and frames: the result is no farther than a 20,000-sample brute-force scan over 40 seeded queries, ends clamp, frames stay orthonormal with consecutive normals within 0.99 dot on a curve through the up axis, and a quarter-turn roll turns the normal onto the binormal (docs/limits.md, Geometry) | `packages/splines/test/features.test.js` | `npm test --workspace @margoengine/splines` | PROVEN | |
| LIM-071 | Knot paths: inserting a knot keeps the curve within 1e-6 and its length within 1e-6, split paths share their cut knot, linear knots make straight segments and closed paths wrap (docs/limits.md, Geometry) | `packages/splines/test/features.test.js` | `npm test --workspace @margoengine/splines` | PROVEN | |
| LIM-072 | Place and deform: instances sit at exact arc spacing on right-handed orthonormal bases, and a bar bent onto a quarter circle keeps its radius within 0.02 of the circle (docs/limits.md, Geometry) | `packages/splines/test/features.test.js` | `npm test --workspace @margoengine/splines` | PROVEN | |
| LIM-073 | Spline fitting: every input point lands within the tolerance of the fit, one cubic's samples fit back to one piece, and B-spline and Kochanek-Bartels curves are continuous, clamped and interpolating as defined (docs/limits.md, Geometry) | `packages/splines/test/features.test.js` | `npm test --workspace @margoengine/splines` | PROVEN | |
| LIM-074 | Subgroup kernels: integer results, orders and stable sorts equal the default kernels at every boundary size on subgroup sizes 32 and 4, and sort takes 7.0 against 11.9 ms on 16,777,216 values on an RTX A6000 (docs/limits.md, Rendering) | `packages/compute/tests/compute-subgroups-browser.js`, `results/compute-subgroups.json` | `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/compute/tests/compute-browser.mjs`; `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/compute-subgroups.mjs` | PROVEN | Timings are diagnostic until a quiet run; one GPU plus SwiftShader; perf-history entry 62. |
| LIM-075 | Raw mesh buffers: meshes with equal bytes hold one buffer and a run binds it once; a write copies it for that mesh only, the other meshes keep drawing the old bytes, and it is freed with its last mesh (docs/limits.md, Rendering) | `packages/shader/test/raw.test.js`, `packages/shader/test/browser-check.mjs` | `npm run test:gpu --workspace packages/shader` | PROVEN | RTX A6000 only |
| LIM-076 | Depth-writing lines: the nearer of two crossing lines wins in either draw order, dash gaps and clipped parts write nothing, a later pass respects the depth and the edge keeps its ramp (docs/limits.md, Rendering) | `packages/lines/tests/depth-write.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-077 | Light-tier pace: an even rate of at least 60 FPS on every display from 60 to 240 Hz, through jitter and whole-millisecond timestamps (docs/limits.md, Platform) | `packages/quality/test/quality.test.js` | `npm test --workspace @margoengine/quality` | PROVEN | A physical 100 Hz panel is not yet measured |
| LIM-078 | TAA velocityOnly: a moving box blurs through MotionBlur at 4x MSAA, stays sharp with the blur off, and a still view keeps its bytes from frame to frame; no history textures or resolve pass exist (docs/limits.md, Rendering) | `packages/taa/test/velocity.test.js`, `packages/taa/test/velocity-only-browser.mjs` | `npm run test:gpu --workspace packages/taa` | PROVEN | RTX A6000 only |
| LIM-079 | Neural networks: every layer's values match its definition and its gradients match central differences on the CPU backend, a convolutional network and a causal attention block give the same outputs and gradients on WebGPU within 1e-4, convolution gradients repeat exactly, and a training step leaves nothing allocated (docs/limits.md, Rendering) | `packages/compute/tests/nn.test.js`, `packages/compute/tests/compute-nn-browser.js` | `npm test --workspace packages/compute`; `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/compute/tests/compute-browser.mjs` | PROVEN | Speed is not measured. |
| LIM-080 | Graph algorithms: `bfs`, `shortestPaths` and `connectedComponents` match sequential references exactly on random graphs on the CPU backend and on WebGPU at 50,000 to 200,000 vertices, negative edges included, a reachable negative cycle is reported and an unreachable one is not, and nothing stays allocated (docs/limits.md, Rendering) | `packages/compute/tests/graph.test.js`, `packages/compute/tests/compute-graph-browser.js` | `npm test --workspace packages/compute`; `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/compute/tests/compute-browser.mjs` | PROVEN | Speed is not measured. |
| LIM-081 | GPU picking of lines: one pick answers the nearest of lines and meshes, names the segment, honours visibility, clipping planes and `onTop`, and `engine.pick` and `pickMany` agree (docs/limits.md, Rendering) | `packages/lines/tests/pick.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-082 | Workgroup autotuning: the median-fastest candidate wins, with sizes over the device's limits dropped, the size is compiled and gives correct results on WebGPU, a known result runs nothing, and a store carries it to a new context on the same adapter only (docs/limits.md, Rendering) | `packages/compute/tests/autotune.test.js`, `packages/compute/tests/compute-autotune-browser.js` | `npm test --workspace packages/compute`; `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/compute/tests/compute-browser.mjs` | PROVEN | Makes no claim about how much faster a tuned size is. |
| LIM-083 | Trails: points run head first, the far end is cut exactly at the age or length limit at zero opacity, a stopped target fades out, and a real GPU draws the width and opacity falling along it (docs/limits.md, Rendering) | `packages/lines/tests/trail.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-084 | Massive line batches: two million segments are one draw at exact pixel and world widths, depth tested, with partial uploads, and a batch past `maxBufferSize` is one draw per buffer (docs/limits.md, Rendering) | `packages/lines/tests/batch.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-085 | Hidden lines: on a real GPU an edge on a surface draws solid while an edge behind it draws dashed or faded, and a hidden line follows its source (docs/limits.md, Rendering) | `packages/lines/tests/hidden.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-086 | Alpha to coverage on lines: on a real GPU with MSAA a translucent line replaces samples instead of blending, a depth-writing line is one draw, and without MSAA it blends (docs/limits.md, Rendering) | `packages/lines/tests/alpha-coverage.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-087 | Video output: frames rendered on a real GPU, encoded by a browser's VideoEncoder and written by Margo's WebM and MP4 writers play back in a browser's own decoder with the right size, length and picture at each sampled time; the writers' tables find every sample, cues and seek entries land on their elements, a WebM cluster splits before a block offset can wrap, and `encodeWithFFmpeg` pipes every frame in order (docs/limits.md, Rendering) | `packages/headless/tests/video.test.js`, `packages/headless/tests/browser-check.mjs` | `npm test --workspace packages/headless`; `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/headless/tests/browser-check.mjs` |
| LIM-088 | Filled helpers: on a real GPU a solid arrow head fills and hides what is behind it, and a translucent plane tints what is under it and obeys clipping planes (docs/limits.md, Rendering) | `packages/lines/tests/fill.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-089 | Rect area lights: a quad with nothing to clip gives the clipped sum bit for bit, the GPU stays within 3/255 of the CPU mirror and within 20% of brute-force quadrature, and all 11 check frames are byte-equal with the early returns (docs/limits.md, Rendering) | `packages/clustered/test/ltc-edge.test.js`, `examples/package-benchmarks/area-lights-gpu.mjs` | `npm run test:gpu:area --workspace packages/clustered` | PROVEN | RTX A6000 only |
| LIM-090 | Environment BRDF LUT: environments of one device with the same size and sample count fill one LUT, freed with the last of them, overlapping creates included; it outlives its first holder and equals a fresh fill (docs/limits.md, Rendering) | `packages/environment/tests/brdf-share.test.js`, `packages/environment/tests/environment-browser.js` | `npm run test:browser --workspace packages/environment` | PROVEN | RTX A6000 only |
| LIM-091 | Headless stage: the same scene with a lazily loaded feature, through `createStage` on a page and `createHeadlessStage`, gives the same picture on a real GPU at the visual check's limits, `fit` included in a non-square image; stages share their globals until the last is disposed (docs/limits.md, Platform) | `packages/headless/tests/stage.test.js`, `packages/headless/tests/browser-check.mjs` | `npm test --workspace packages/headless`; `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/headless/tests/browser-check.mjs` | PROVEN | Proven on a browser's WebGPU through the stand-in canvas. No Node WebGPU binding is in the repository, so Node itself is not run here. |
| LIM-092 | Dash caps: on a real GPU each dash ends butt, square or round half the line width past its length, and a near-zero dash with round ends is a dot (docs/limits.md, Rendering) | `packages/lines/tests/dash-cap.test.js`, `packages/lines/tests/features-browser.js` | `npm test --workspace @margoengine/lines`, `npm run test:browser --workspace @margoengine/lines` | PROVEN | |
| LIM-093 | Image comparison: SSIM matches the published formula on hand-worked cases and is 1 for identical images; pixelDiff compares premultiplied colour; decodePNG reads every colour type, depth and row filter (docs/limits.md, Platform) | `packages/headless/tests/compare.test.js` | `npm test --workspace packages/headless` | PROVEN | Makes no claim about how closely SSIM follows what a person sees. |
| LIM-094 | Output formats: JPEG and lossless WebP files decode in the browser's own decoders (lossless bit for bit, with alpha and odd sizes), and an EXR of the linear scene capture carries values over 1 and reads back exactly (docs/limits.md, Platform) | `packages/headless/tests/formats.test.js`, `packages/headless/tests/browser-check.mjs` | `npm test --workspace packages/headless`, `npm run test:gpu --workspace packages/headless` | PROVEN | Makes no claim about JPEG or lossy WebP size against other encoders. |
| LIM-095 | USDZ shared geometry: a geometry two or more nodes draw is written once, nodes keep their own transform and material, and both USD readers load the same world geometry as separate meshes (docs/limits.md, Rendering) | `packages/exporters/tests/usdz-shared.test.js` | `npm test --workspace packages/exporters` | PROVEN | - |
| LIM-096 | Adaptive point size: a point takes its size from the density of the drawn nodes where it lies, shrinks as children draw, grows back when they stop, and closes the holes of a sparse sample on a real GPU (docs/limits.md, Rendering) | `packages/points/tests/adaptive-size.test.js`, `packages/points/tests/features-browser.js` | `npm test --workspace @margoengine/points`, `npm run test:browser --workspace @margoengine/points` | PROVEN | |
| LIM-097 | Surfels: on a real GPU at 1x and 4x MSAA discs close a jittered surface, blend colours across a seam, keep a near surface over a far one, honour clipping planes and share depth with meshes (docs/limits.md, Rendering) | `packages/points/tests/surfels.test.js`, `packages/points/tests/features-browser.js` | `npm test --workspace @margoengine/points`, `npm run test:browser --workspace @margoengine/points` | PROVEN | |
| LIM-098 | View offset: a frustum built for the full image and shown one tile at a time gives the same pixel positions and depth as the full render, in both modes and both depth conventions, with fractional offsets for jitter; culling follows the tile (docs/limits.md, Rendering) | `packages/cameras/test/view-offset.test.js`, `packages/cameras/test/browser-check.mjs` | `npm test --workspace @margoengine/cameras`, `npm run test:gpu --workspace @margoengine/cameras` | PROVEN | Matrices in the unit test; one real-GPU render of the right half of an image; screen-space passes that read neighbouring pixels are not claimed to match across tile edges. |
| LIM-099 | Focal length: the vertical field of view of a lens matches 2·atan(sensor / 2f) and the camera makers' printed angles for 24 to 85 mm, `fovToLens` inverts it for every sensor fit over 500 seeded lenses, and a projection with a focal length draws the lens's frustum edge at the image edge in both modes (docs/limits.md, Rendering) | `packages/cameras/test/lens.test.js` | `npm test --workspace @margoengine/cameras` | PROVEN | Pinhole model only: no distortion or sensor shift. |
| LIM-100 | Potree folders: 2.0 and 1.x folders written from the public format descriptions give back every point and colour, follow proxy and hierarchy files, refuse what is not read by name, and draw through OctreeCloud on a real GPU (docs/limits.md, Rendering) | `packages/points/tests/potree.test.js`, `packages/points/tests/features-browser.js` | `npm test --workspace @margoengine/points`, `npm run test:browser --workspace @margoengine/points` | PROVEN | Not yet checked against files from PotreeConverter. |
| LIM-101 | Rendering in a worker: core, a control package and the WebGL2 fallback run on a transferred canvas with no core change, size and `pick` follow the page's CSS pixels, forwarded drags and the wheel reach the controls, the page shows the pixels, and each thread keeps running while the other is stuck (docs/limits.md, Platform) | `packages/worker/tests/worker.test.js`, `packages/worker/tests/browser-check.mjs` | `npm test --workspace @margoengine/worker`, `npm run test:gpu --workspace @margoengine/worker` | PROVEN | Chromium, RTX A6000 |
| LIM-102 | Off-axis and oblique: a point on the screen plane shows at the same place for any eye position and screen pose, on both depth conventions and on a real GPU, and an oblique near plane reaches the near depth on the plane, clips behind it, keeps the x, y and w rows, and is the culling near plane, for perspective and orthographic cameras (docs/limits.md, Rendering) | `packages/cameras/test/offaxis.test.js`, `packages/cameras/test/browser-check.mjs` | `npm test --workspace @margoengine/cameras`, `npm run test:gpu --workspace @margoengine/cameras` | PROVEN | Makes no claim about depth precision near edge-on planes; it is not measured. |
| LIM-103 | Octrees under a moving transform: `matrix` and `attach(mesh)` place every node, selection and adaptive size follow the transform, and the placed tree draws where it was put on a real GPU (docs/limits.md, Rendering) | `packages/points/tests/octree.test.js`, `packages/points/tests/features-browser.js` | `npm test` and `npm run test:browser` in `packages/points` | PROVEN | Selection in cloud space; stretch is the longest matrix axis. |
| LIM-104 | Scene graph helpers: world position, rotation and scale agree with the Wasm kernel's matrix under moved, turned, mirrored and unevenly scaled parents, before any frame and after a write; `lookAt` points +Z at the target under any parent; `traverse` survives a visitor that disposes meshes (docs/limits.md, Entities) | `packages/scene/tests/scene.test.js` | `npm test --workspace @margoengine/scene` | PROVEN | |
| LIM-105 | Physical exposure: exposure value matches log2(N² / t) at ISO 100 (f/1 for 1 s is 0, sunny 16 about 15); a stop of aperture, shutter time or ISO each moves the exposure by exactly 1; the depth of field matches the textbook 50 mm f/8 case; the blur disc equals the circle of confusion exactly at the near and far limits over 200 seeded lenses; and `apply` writes the same camera to the real DOF, MotionBlur, Tonemap and Bloom options (docs/limits.md, Rendering) | `packages/cameras/test/physical.test.js` | `npm test --workspace @margoengine/cameras` | PROVEN | Makes no claim about photometric accuracy: exposure is relative to a reference. |
| LIM-106 | GPU picking of points: a pick returns the cloud, point and world position, meshes in front block it, and clipping planes apply, on a real GPU (docs/limits.md, Rendering) | `packages/points/tests/pick.test.js`, `packages/points/tests/features-browser.js` | `npm test` and `npm run test:browser` in `packages/points` | PROVEN | Draws what the view drew, one ID range a cloud. |
| LIM-107 | Wide-angle projections: Panini with distance 0 is the rectilinear picture, each fisheye law puts an angle at its radius, verticals stay vertical in Panini, output and source maps are inverses in every mode over 500 seeded points, the crop is the largest zoom with no pixel outside the source, and on a real GPU the shader lands boxes at the columns the CPU map predicts for Panini, equidistant and stereographic (docs/limits.md, Rendering) | `packages/cameras/test/panini.test.js`, `packages/cameras/test/browser-check.mjs` | `npm test --workspace @margoengine/cameras`, `npm run test:gpu --workspace @margoengine/cameras` | PROVEN | Makes no claim about image quality or cost; neither is measured. |
| LIM-108 | HDR point colours: `colorFormat: 'float'` keeps values above 1 through storage, reorder, updates, octree nodes and both point and surfel shaders, proved past the 8-bit clamp on a real GPU (docs/limits.md, Rendering) | `packages/points/tests/hdr-colors.test.js`, `packages/points/tests/features-browser.js` | `npm test` and `npm run test:browser` in `packages/points` | PROVEN | A material colour of 0.25 brings 4 to 1, where RGBA8 clamps first. |
| LIM-109 | WebGPU compatibility level: `allowCompatibilityAdapters` asks for the level only when the full level finds nothing; on a forced device core draws the same pixels as at the full level, pick hits and misses, a device restore stays at the level, materials run, and `Shadows`, `CulledInstances` and HDR `PostStack` fail as listed (docs/limits.md) | `packages/webgl2-compat/test/adapter.test.js`, `packages/webgl2-compat/test/adapter-browser.mjs` | `npm run test:gpu --workspace @margoengine/webgl2-compat` | PROVEN | |
| LIM-110 | Mipmaps on maps: uploaded maps get a full chain, and a fine map on small points and sprites reads as its linear average on a real GPU, where one without mips aliases (docs/limits.md, Rendering) | `packages/points/tests/mipmaps.test.js`, `packages/points/tests/features-browser.js` | `npm test` and `npm run test:browser` in `packages/points` | PROVEN | Level from point size or from uv derivatives. |
| LIM-111 | Bulk transform writes: `TransformWriter` gives bit for bit what `mesh.position.set`, `setQuaternion`, `mesh.rotation.set` and `mesh.scale.set` give, world matrices included; a bad value or a disposed mesh changes nothing (docs/limits.md, Entities) | `packages/scene/tests/bulk.test.js` | `npm test --workspace @margoengine/scene` | PROVEN | |
| LIM-112 | Roll in fly and trackball controls: off by default with `camera.up` untouched; Q and E turn the horizon at `rollSpeed` with the eye and view held, and a pure roll reports a change; yaw, pitch and movement follow the rolled frame; a pitch loop passes the vertical and returns; a trackball drag near the rim rolls with the scene following the pointer and a drag through the top passes the pole; the frame stays orthonormal after 400 mixed flight inputs and 1,000 random drags; the coast turns `up` the same at 30 and 60 fps (docs/limits.md, Entities) | `packages/controls/tests/roll.test.js` | `npm test --workspace @margoengine/controls` | PROVEN | |
| LIM-113 | Gizmo polish: with `flipAxes` the move and scale handles and plane squares point to the camera's side of each axis, flip only past a margin and hold during a drag, and a flipped arrow drags and scales the way the pointer goes; a move draws a line from start to the object, a turn sweeps an arc that ends under the pointer on axis and view rings, follows the snap and stops at a full turn; `occlude` tests read-only scene depth, and on a real GPU a wall hides the gizmo on WebGPU and WebGL2 (docs/limits.md, Entities) | `packages/controls/tests/gizmo-polish.test.js`, `packages/controls/scripts/test-browser.js` | `npm test --workspace @margoengine/controls`, `npm run test:browser --workspace @margoengine/controls` | PROVEN | |
| LIM-114 | Third-person camera: the arm keeps the attached view, a wall pulls it in within the frame with `probeRadius` of clearance, the camera stays inside a walled room through a full turn, the return eases out at 30 and 60 fps, a corridor wall beside the pivot does not collapse the arm, the subject, its children and `ignore` never stop it, and the spring settles identically at 30 and 60 fps (docs/limits.md, Entities) | `packages/controls/tests/third-person.test.js` | `npm test --workspace @margoengine/controls` | PROVEN | Makes no claim about CPU cost; it is not measured. |
| LIM-115 | DragControls rotate mode and groups: 100 px at 0.01 turns exactly one radian about the screen axis at right angles to the drag, in place, and the world turn holds under a rotated parent; a turn about a world axis keeps to it; group members move by one world step under their own parents and scales, swing about the grabbed origin, and one disposed mid-drag is left behind; `recursive` drags the child and `transformGroup` the listed parent (docs/limits.md, Entities) | `packages/controls/tests/drag-modes.test.js` | `npm test --workspace @margoengine/controls` | PROVEN | |
| LIM-116 | Orbit target radius and zoom: panning stops on the sphere around `cursor` with the view direction unchanged, slides along it, holds a floor, applies after `targetBounds` and works on `MapControls`; `zoom` writes the projection within `minZoom` and `maxZoom`; with `orthoZoom` a wheel doubling halves the view with the distance unchanged, the point under the pointer keeps its pixel with `zoomToCursor`, and dolly drags and pinch zoom too (docs/limits.md, Entities) | `packages/controls/tests/orbit-limits.test.js` | `npm test --workspace @margoengine/controls` | PROVEN | |
| LIM-117 | Pivot modes and multi-object editing: on the median, the active origin or each own origin, a quarter turn lands every object on its checked position and rotation; every object moves by one world step, also under a turned, scaled parent; `individual` with `local` moves and turns each along its own axes; scale spreads positions about the pivot and sizes each object; a child attached with its parent moves once; Escape and `reset` restore the set; a member disposed mid-drag drops out (docs/limits.md, Entities) | `packages/controls/tests/transform-many.test.js` | `npm test --workspace @margoengine/controls` | PROVEN | |
| LIM-118 | Arcball gizmo and shortcuts: the rings and outline lie on the ball the pointer drags, centred on the target, with the far halves dimmed, and draw on a real GPU; a double-click centres the point on the target plane or from `pick`, keeping turn and distance, and glides under damping; arrows turn by `keyRotateStep` the way they point, Shift pans, Q and E roll, + and - zoom a quarter doubling, Home resets, each following its enable flag (docs/limits.md, Entities) | `packages/controls/tests/arcball-keys.test.js`, `packages/controls/tests/controls-browser.js` | `npm test --workspace @margoengine/controls`, `npm run test:browser --workspace @margoengine/controls` | PROVEN | |
| LIM-119 | Moving platforms: a sliding deck carries the walker with no frame of lag and no creep once stopped; a lift at 3 m/s holds the feet on the floor up and down while walking adds up; a turntable swings the walker about its axis and turns the heading by the same angle; carrying goes through world matrices under a moving, scaled parent; a jump keeps the deck speed until the next landing; `carry: false`, a disposed floor and the dollhouse give no ride, and a static level holds bit for bit (docs/limits.md, Entities) | `packages/controls/tests/walk-platforms.test.js` | `npm test --workspace @margoengine/controls` | PROVEN | |
| LIM-120 | Stage XR button: `addXRButton` enters and leaves a session from a real click, shows a disabled button where a session cannot start, and shares one XR plugin per stage; no headset has run it (docs/limits.md, Platform) | `packages/stage/tests/xr.test.js`, `tests/modern-xr.ts` | `npm test --workspace @margoengine/stage`, `npm run modern:test:xr:browser` | PROVEN | |
| LIM-121 | GPU BVH traversal: rays traced in WGSL answer as the float64 CPU tree does, and rays at vertices and shared edges of a closed mesh never leak (docs/limits.md, Geometry) | `packages/bvh/tests/gpu.test.js`, `packages/bvh/tests/gpu-browser.js` | `npm test` and `npm run test:browser` in `packages/bvh` | PROVEN | 100,000 rays and 123,200 edge rays on the RTX A6000. |
| LIM-122 | Scene BVH: one top-level tree answers what `intersectEngine` answers, in the same order, over meshes, model primitives, instances and pick proxies, refit or rebuilt as objects move (docs/limits.md, Geometry) | `packages/bvh/tests/scene.test.js` | `npm test` in `packages/bvh` | PROVEN | Compared ray by ray with `intersectEngine` over a city of 400 boxes. |
| LIM-123 | Point and sprite picking: one Raycaster call answers meshes, points within a pixel or world threshold and sprites, sorted by distance (docs/limits.md, Geometry) | `packages/bvh/tests/points.test.js` | `npm test` in `packages/bvh` | PROVEN | Thresholds checked just inside and just outside, near and far. |
| LIM-124 | Stage model viewer: `addViewer` loads a real glTF on real WebGPU, frames it, darkens the ground in 'contact' and 'cascaded' modes, turns the camera at a fixed height, distance and target, leaves no plugin or mesh after dispose, and reports no WebGPU error; failures and aborts leave nothing behind (docs/limits.md, Platform) | `packages/stage/tests/viewer.test.js`, `scripts/stage-viewer-gpu-check.js` | `npm test --workspace @margoengine/stage`, `npm run test:gpu --workspace packages/stage` | PROVEN | |
| LIM-125 | Mesh distance fields: a baked field matches the analytic distance of a sphere within 0.02 of its radius, negative inside, and a mesh with a hole keeps its inside (docs/limits.md, Geometry) | `packages/bvh/tests/sdf.test.js` | `npm test` in `packages/bvh` | PROVEN | Every sample of a 24 cubed grid compared with the analytic value. |
| LIM-126 | Inside test and mesh distance: winding numbers of closed meshes are whole and agree with ray parity, a hole leaves the inside inside, and mesh distance is never above what all vertices find (docs/limits.md, Geometry) | `packages/bvh/tests/inside.test.js` | `npm test` in `packages/bvh` | PROVEN | 400 random points against exact sums and ray parity; 60 poses against a brute force bound. |
| LIM-127 | Interactions: tap, hold, slow tap and double press start, perform and cancel at the stated times on a fake clock; one press ends once and never restarts until released; a rule on one binding ignores the action's other bindings and follows a rebind; analog input presses at the threshold and releases at three quarters of it; a press and release between two updates counts for one update on keys, mouse and touch buttons (docs/limits.md, Entities) | `packages/input/test/interactions.test.js` | `npm test --workspace @margoengine/input` | PROVEN | |
| LIM-128 | GPU build for deforming meshes: a tree built or refit on the GPU holds every triangle once inside boxes that nest, and rays through it match a float64 CPU tree of the same pose, with vertices the GPU wrote (docs/limits.md, Geometry) | `packages/bvh/tests/gpu-build.test.js`, `packages/bvh/tests/gpu-build-browser.js` | `npm test` and `npm run test:browser` in `packages/bvh` | PROVEN | Trees read back and walked node by node; lone, padded and coincident triangles included. |
| LIM-129 | Stage physics: `addBody` loads real Rapier on first use, a crate falls and rests on a floor to 0.02 m, one world per stage even for calls at once, a disposed world is replaced, and the collider is Rapier's cuboid, ball, convex hull or trimesh as the mesh calls for (docs/limits.md, Platform) | `packages/stage/tests/physics.test.js` | `npm test --workspace @margoengine/stage` | PROVEN | |
| LIM-130 | Alpha-masked picking: rays through a transparent texel land on what is behind, with `intersectEngine`, `intersectObjects`, `intersectModel`, `SceneBVH` and `firstHitOnly` (docs/limits.md, Geometry) | `packages/bvh/tests/alpha.test.js` | `npm test` in `packages/bvh` | PROVEN | Sampler checked for filtering, wrap, clamp and the cutoff boundary. |
| LIM-131 | Stage saved scenes: `addScene` loads URL, document, JSON text, bytes and gzip through the real save package into a real engine, with parents, prefabs and migrations; a bad model, a bad component, a throwing `onEntity`, an abort or a stage disposal leaves no mesh or model behind (docs/limits.md, Platform) | `packages/stage/tests/scene.test.js`, `scripts/stage-viewer-gpu-check.js` | `npm test --workspace @margoengine/stage`, `npm run test:gpu --workspace packages/stage` | PROVEN | |
| LIM-132 | Local players: each player reads only their own devices, on separate gamepads and on one keyboard through schemes; a press on a free device joins and is not read as pressed, nor is its key repeat; slots stay put and are reused; an unplugged gamepad is reported once, keeps its owner and returns; dispose leaves no listener (docs/limits.md, Entities) | `packages/input/test/players.test.js` | `npm test --workspace @margoengine/input` | PROVEN | |
| LIM-133 | Materials per part: on a real GPU, boxes that each hold their own colour, roughness, metalness and sidedness in four batches of `CulledParts` match the same boxes as core meshes with a material each, with 0 differing pixels, in frustum and occlusion culling, with and without shadows (docs/limits.md, Rendering) | `packages/culling/test/part-materials.test.js`, `packages/culling/test/gpu/parts-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim. |
| LIM-134 | Gyro aiming: rates integrate to radians in the screen's frame at all four screen angles, a gap in events cannot jump the aim, the deadzone and `enabled` drop what they should, calibration subtracts the resting error, steering reads tilt at 0 and 90 degree screen angles, across the wrap and holds neutral when flat, and actions read through control bindings (synthetic sensor events; no real device run) (docs/limits.md, Entities) | `packages/input/test/motion.test.js` | `npm test --workspace @margoengine/input` | PROVEN | |
| LIM-135 | Occlusion for core meshes: on a real GPU, 1,509 core meshes culled by `CulledMeshes` with `occlusion: true` match the same meshes drawn by core alone with 0 differing pixels through camera moves, hidden occluders and moved meshes, and fewer than 200 draw while a wall hides the crowd (docs/limits.md, Rendering) | `packages/culling/test/meshes-occlusion.test.js`, `packages/culling/test/gpu/meshes-occlusion-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim; the depth pass and pyramid are not timed here. |
| LIM-136 | GPU culling of models: on a real GPU, a materials instanced mesh culled by `CulledModels` matches the same mesh with every row drawn with 0 differing pixels, with and without shadows, through camera, row, count and root moves, and draws 393 of 1,600 rows close up (docs/limits.md, Rendering) | `packages/culling/test/models.test.js`, `packages/culling/test/gpu/models-cull-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim. Non-instanced primitives are not covered. |
| LIM-137 | First npm install: all 102 tarballs pass the audit, the 102 tarballs pack to 7,151,007 B, `npm install margoengine` from a stand-in registry gives 23,304,020 B of `node_modules`, every one of its 502 entries imports and type-checks with `skipLibCheck` off, and every `npm create margo` template installs and builds (docs/limits.md, Platform) | `scripts/publish-rehearsal.mjs`, `tests/publish-rehearsal.test.js` | `npm run publish:rehearsal` | PROVEN | |
| LIM-138 | Occluders that are not parts: on a real GPU, 576 `CulledParts` parts behind a core mesh, a materials mesh and a `Terrain` added with `addOccluder` match the same scene as core meshes with 0 differing pixels through camera moves, a hidden occluder, a moved one and a removed one, and 0 parts draw behind them (docs/limits.md, Rendering) | `packages/culling/test/occluders.test.js`, `packages/culling/test/gpu/occluders-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim. A loaded glTF takes the path of the materials mesh; no glTF file is in the check. |
| LIM-139 | Oriented box bounds: on a real GPU, 900 rotated rods under a plate seen from above draw 0 with `bounds: 'box'` against 900 with spheres, and both match the same scene as core meshes with 0 differing pixels through camera moves, a frustum edge and a moved part (docs/limits.md, Rendering) | `packages/culling/test/bounds.test.js`, `packages/culling/test/gpu/bounds-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim. Seen at an angle, a long part stays in: the limit row says why. |
| LIM-140 | Apple GPUs: centroid varyings of 40,000 blades move about 350 pixels by up to 4 levels on some frames, with every input bit-identical, and not at one sample a pixel (docs/limits.md, Rendering) | `packages/scatter/test/shadow-cull.browser.mjs` | `MARGO_BROWSER=chrome node packages/scatter/test/shadow-cull.browser.mjs` on a Mac: blades run at one sample a pixel and match exactly | PROVEN | |
| LIM-141 | Per-cascade caster culling: on a real GPU, `CascadeParts` and `CascadeInstances` with 1,600 casters and 3 cascades match the same scene drawing every caster in every cascade with 0 differing pixels through camera moves, hidden casters and a moved caster, and the nearest cascade keeps under half of them (docs/limits.md, Rendering) | `packages/culling/test/shadows-cull.test.js`, `packages/culling/test/gpu/shadows-cull-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim. |
| LIM-142 | Picking on the WebGL2 preview: `webglPicking` from `@margoengine/webgl/pick` makes `engine.pick` answer on real WebGL2 for CSS pixels, depth, faces, hidden meshes, views and layers, leaves the canvas unchanged, and core still refuses without it (docs/limits.md, Platform) | `packages/webgl/src/pick.ts`; `packages/webgl/test/browser-check.mjs`; `packages/webgl/test/pick.test.js` | `npm run test:gpu --workspace @margoengine/webgl` | PROVEN | Chromium only |
| LIM-143 | LOD in the cull pass: on a real GPU, 319 `LodInstances` over three levels match the same scene as core meshes with levels worked out on the CPU with 0 differing pixels through camera moves, hidden instances and a moved instance (docs/limits.md, Rendering) | `packages/culling/test/lod.test.js`, `packages/culling/test/gpu/lod-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim. Levels are picked by the first level's sphere. |
| LIM-144 | Context restore on the WebGL2 preview: with `webglRestore` from `@margoengine/webgl/restore`, a really lost context comes back with identical pixels and working picks, geometry added during the loss draws, each scene's plugins hear `onDeviceRestored`, and `engine.rebootDevice` works; without it core's refusal and the lost-context error stand (docs/limits.md, Platform) | `packages/webgl/src/restore.ts`; `packages/webgl/test/browser-check.mjs`; `packages/webgl/test/restore.test.js` | `npm run test:gpu --workspace @margoengine/webgl` | PROVEN | Chromium only |
| LIM-145 | Cluster culling: on a real GPU, a `MeshletMesh` of 36,864 triangles matches the same mesh drawn by core with 0 differing pixels through camera moves, a moved mesh and uneven scale, and keeps fewer triangles than it holds in every step (docs/limits.md, Rendering) | `packages/culling/test/meshlets.test.js`, `packages/culling/test/gpu/meshlets-check.mjs` | `npm test --workspace @margoengine/culling`, `npm run test:gpu --workspace @margoengine/culling` | PROVEN | Makes no speed claim. |
| LIM-146 | Automatic escalation: `autoEngine` from `@margoengine/webgl/auto` fetches neither WebGL2 package on WebGPU, stays on the preview for a scene it can draw without fetching the layer, and moves a scene whose package refuses the preview to the layer from `loadCompat`, which draws it; without `loadCompat` the refusal comes through (docs/limits.md, Platform) | `packages/webgl/src/auto.ts`; `packages/webgl/test/browser-check.mjs`; `packages/webgl/test/auto.test.js` | `npm run test:gpu --workspace @margoengine/webgl` | PROVEN | Chromium only |

**Clearcoat through `install` (2026-11-05).** The coat dims everything under it as KHR_materials_clearcoat defines, on opaque surfaces too. Clearcoat 1 keeps 0.96 of emission at normal incidence and 0.73 at n.v 0.25; proof in `scripts/materials-clearcoat-tests.js`, which fails on the unfixed shader.

**Cut-outs hold in every pass (2026-11-05).** A materials cut-out (`map` alpha, `alphaMap`, UV transform, `alphaTest`, `vertexColors: false`) now holds in picking, contact shadows, TAA velocity and virtual shadows as well as the other shadow maps; proof by GPU pixel and velocity reads in `packages/materials/test/cutout-passes-browser.mjs` and `packages/shadows/test/cutout-casters-browser.mjs`. `triplanar` is the exception. `displacementMap` and `clippingPlanes` hold in picking, contact shadows and TAA velocity too, by the same test.

**Transmission adds in linear light (2026-11-05).** Through `install` and `Transmission`, on display-encoded targets too; proof in `packages/materials/tests/transmission-shader.test.js`. gltf-pro's native two-draw glass still adds encoded values on a target with no PostStack ([known-bugs.md](../known-bugs.md)).

## Optimization proofs

Every `examples/package-benchmarks/proofs/*.proof.js` compares a baseline ref with a pinned candidate, the commit where
its claim was made, so later code cannot change the result: `node <proof>` (or `node <proof> <ref> <pin>`). `npm run
proofs` runs all of them pinned, two at a time. The ones marked "current" (the `ongoing` list in `proofs/run.mjs`) are
ongoing guarantees and are also checked against the working tree with `npm run proofs -- --current` (part of
`npm run verify`), from the ref given (the last intended change to their output). Pinned runs build the compared packages and packages/shared at
the pin; `@margoengine/core` (frozen), the proof scripts and their fixtures are today's (except core in the nine
proofs that call `coreAt(pin)`, "Pinned runs and the core of their time"), so mock-GPU timings recorded
before the core speed-ups (`0ed56b9`) re-run faster than recorded. The animator proof has no current run: it compares
every transform write bit for bit, and the animator has skipped unchanged writes since `f33e094` and reads
`options.speed` since `6a1c6bb`, so only its pinned run can match.

**Baselines: golden outputs, not commits (2026-10-27).** A fresh clone of main failed `npm run verify`: 14 of the 20
current proofs rebuilt their baselines with `git rev-parse` / `git show` on commits (`6a958e532`, `2d192a71`, `2cd81c1`,
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

**Intermittent browser-suite timeouts (bug 26, 2026-10-27).** modern:test:browser and its slow-compile run sometimes
failed with "page.waitForFunction: Timeout 30000ms exceeded" waiting for `window.modern`, in check:merge in two
worktrees, with no GPU reset in the window. Under load with another suite running it failed 3 times in about 24 runs.
Each time the page had loaded its modules within 0.5 s, the dev server had no request pending, and
`node_modules/.vite/deps/react_jsx-runtime.js` had answered 504 (Vite's "Outdated Optimize Dep"), so the module graph
never ran. Cause: an obsolete checkout setup linked the main checkout's `node_modules/.vite` into every isolated
checkout, so all their dev servers shared one dependency cache and one re-optimized what another was serving. Each
checkout now keeps its own tool caches; after the fix the same load ran 10 of 10, 8 of them beside another suite.

**Pinned runs and the core of their time (bug 6, 2026-10-27).** `npm run proofs` (pinned) failed nine proofs on a
checkout holding their commits: color-output, environment-volumetric, post-ssr, post-ssr-models, post-stack,
probes-decals and quality-presets ("story must exercise the GPU", "fog requires the standard core PBR shader"),
math-consolidation and water-ssr. None was retired; each now reproduces its recorded result:

- **The seven GPU-call proofs:** a pinned run built the old package sources at their claim commits but gave both
  sides today's `@margoengine/core` and its lit shader text. The old post, environment and tonemap sources patch that
  text by search and replace (environment at `366ebff`: `if (code === source) throw ... requires the standard core
  PBR shader`); core's later bug fixes and clean-room rewrites changed the text, so their stories threw on the first
  frame. When each claim was made, both sides ran on the core of the claim commit. They now call `coreAt(pin)`
  (`proofs/compare.js`) first: in a pinned run it builds core's src and packages/shared at the pin, returns its
  exports and shader text to the story, and every package built afterwards, baseline and candidate, imports that
  core instead of today's (Rollup asks `external` before any plugin, so core's ids are kept internal and resolved to
  the pinned build). In --current runs it returns today's core, so the golden outputs and their checks are unchanged.
  The pinned call counts are the recorded ones: color-output 6,174; environment-volumetric 70 root calls and 344/533
  isolated calls; post-ssr 9,269; post-ssr-models 30,858; post-stack 12,378; probes-decals 15 identical entry bundles,
  135 + 12,320 calls; quality-presets 292/1,141/757/720/408/360 per package. water-ssr and terrain-ssr call it too
  now that they are pinned (below): water and terrain import core's extension entry. `tests/proofs-pinned-core.test.js` checks, with HEAD as the pin, that a pinned bundle has no bare
  core import left and that `coreAt` refuses to come after a package was built (one story never mixes two cores).
- **math-consolidation:** today's script called `mat4.multiplyMatrices(a, b)` and `mat4.invertMatrix(m)` without
  `out`, which `@margoengine/math` defaults only since `f42270c7`; the pinned run builds math at `4eed254`, where `out`
  is required, so the call wrote into `undefined`. The claim's candidates at `4eed254` were bvh's and points' own
  adapters (they defaulted `out`), so the pinned run now calls those, as the claim did; --current keeps calling math.
  On 2026-10-29 its textual check of a since-removed package's vector copies left with that package; every taped
  digest and the current reference `2484971` are unchanged, so nothing was captured again.
- **water-ssr and terrain-ssr** passed no pin (`refs('6c20076d')`), so their "pinned" run compared the baseline with
  today's tree, and water's later intended changes (its foam textures, the ripple noise, above) made it fail. Both are
  pinned to `49f3e971`, the commit that added the capture hook: 2,762 and 6,458 calls, as recorded.

- **splats (found on the way):** its pinned timing failed under load (0.993x and 0.998x against a recorded 2.34x).
  Since `66d1cb30` the stand-in device (`gpu-recorder.js`) made 15 new closures for every `begin*Pass`, about 19 µs a
  frame that both sides paid: the 2,000-frame rounds took 43 ms instead of 3-8 ms, and the package's own saving
  vanished in it. Passes are still new objects, now sharing one set of methods; the rounds take 3.3 / 2.0 ms again
  (1.60x and 1.64x on Node 26.12) and the recorded calls are unchanged. `tests/proofs-pinned-core.test.js` checks it.

Only `--current` ran in any check, so the pinned failures went unnoticed for days. A full release validation runs
`npm run proofs` (pinned, about 4.5 minutes on the RTX A6000 PC: 50 pass, procedural-deps HISTORICAL as before) after
`check:merge:full`, alone on the selected GPU machine. It stays out of ordinary focused checks on purpose: about 40 pinned proofs time their claim's speed-up, and the smallest margins on
2026-10-27 were loaders 1.05x, bvh 1.07x and creative 1.08x, which a busy machine can erase. A clone without
the commits reports them HISTORICAL and passes.

**NaN payloads.** `geometry.proof.js` (pinned) failed at random on its degenerate-input case ("degenerate bounds"):
baseline and candidate both return NaN for the non-finite vertex, but V8 writes either x86's default NaN (sign bit
set) or the plain quiet NaN into a typed array depending on the code path and JIT tier, which ECMAScript allows
(SetValueInBuffer may store any NaN encoding). Its bit-for-bit comparison and the math tapes now compare NaN payloads
as one value (`canonicalNaN`); every other bit, -0 included, still counts.

| Proof | Pinned: baseline -> claim commit | Current: ref -> working tree |
| --- | --- | --- |
| animation | `59350fc` -> `f47ff3f` | - |
| animator, bvh, creative, decoders, ecs, exporters, geometry, gltf, gltf-pro, labels, loaders, navmesh, points, post, road, splats, splines, taa, terrain, text, wfc | `f05414a` -> `f47ff3f` | - |
| geometry-subdivide | `bdb7521` -> `96edc75` | - |
| animation-vat (measurement, no baseline) | gltf-pro + animation at `700838e` | - |
| materials-atlas (measurement, no baseline) | geometry + materials at `700838e` | - |
| binding-limit | `e017d50` -> `f8a36ca`: 3,812 calls without IBL, 4,556 with (384 mapped) | - |
| gltf-pro-lighting-hooks | `15c87f1` -> `cf2953e`: 4,556 calls; texture transform: `114130c` -> `7072190` | `6a958e532` |
| materials-uv-transform | `1970fda` -> `700838e`: 1,277 calls; texture transform: `114130c` -> `7072190` | `de20fb3c`: 1,085 calls |
| lines-perspective | `96edc75` -> `6da7f7e`: 946 calls | `2d192a71` (per-line clipping planes at `86063c47`: the style uniform grew from 128 to 224 bytes and the shader gained a world-position varying and a zero-count plane loop; then `clipIntersection` at `2d192a71` changed that loop to count the planes a point is behind. Unclipped lines' calls and writes changed on purpose both times) |
| math-consolidation | `2484971` -> `4eed254` (math built at the pin) | `2484971` |
| post-stack | `5b1fe66^` -> `5b1fe66`: 12,378 calls (creative `5b1fe66^` -> `3319317`) | `6a958e532` |
| selection-xray-off | `46f9484` -> `80d4cfb`: 10,586 calls | `b3ed8ac` |
| clustered-local-shadows | `0ed56b9` -> `590278e`: 482 calls, 8 params.z writes | `6a958e532` |
| clustered-area-lights | `67e0172` -> `dab9633`: 482 calls | `57250a49` |
| clustered-light-hooks | `6c20076d` -> `b4700864`: 482 calls without the directional, IES and projector entries and with each attached but empty | `57250a49` |
| environment-hemisphere | `6c20076d` -> `b4700864`: 53 shader texts (IBL, Fog, LightProbes on six core variants, gltf-pro's four shader kinds) and 23 calls without a HemisphereLight | `57250a49` |
| color-output | `7dcc958` -> `225b1d6`: 6,174 calls | `57250a49` |
| deformed-shadows | `38d448e` -> `282e751` | `667d1a26` |
| environment-volumetric | `7c47a09` -> `366ebff` | `2cd81c1`: 70 root calls; 344/533 isolated calls |
| oit-detached | `b803d56` -> `0e02ead`: 2,864 calls (2,964 until a later change replaced the story's transmission material with a plain BLEND one: transmission now draws twice by design) | `de20fb3c`: 2,392 calls |
| post-ssr | `7c47a09` -> `3cf1453`: 9,269 calls | `6a958e532`: 12,431 calls (AgX normalised for older refs, see below) |
| post-ssr-models | `3cf1453` -> `838ae6e`: 30,858 calls | `151aa744`: 37,182 calls |
| taa-velocity | `6c20076d` (before the `taa.velocity` getter) -> `e1a20e13` (the motion-blur commit): 16,923 calls at 1x and 4x, the getter read every frame | `8149bf4e` |
| terrain-ssr | `6c20076d` (before terrain's capture hook) -> `49f3e971` (the water/terrain SSR commit): terrain.proof.js's story, 6,458 calls in two of its three terrains | `6c20076d` |
| water-ssr | `6c20076d` (before water's capture hook) -> `49f3e971` (the water/terrain SSR commit): 2,762 calls in 3 stories | `268bfc625` |
| quality-presets | `96daac7` -> `01e5e35` | `6a958e532` |
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

**materials-uv-transform and oit-detached, advanced to `de20fb3c` on 2026-11-05 (empty groups in WebKit):** a gltf-pro material without textures or effects has an empty group, and WebKit gives an invalid layout for an empty group past the last one a shader uses, so its draw failed there. An empty group is now one group of an explicit empty layout per device, which changes these stories' bind group calls and nothing they draw. Materials with entries keep their calls.

**materials-uv-transform, advanced to `20a5e259` on 2026-11-05 (perf-history entry 50):** gltf-pro trims a pipeline to the vertex inputs its finished shader reads. The story's one material with no maps changes: of 1,085 calls, one shader module and one render pipeline differ, and every other call, binding and upload is as before. `packages/materials/test/vertex-inputs-browser.mjs` shows the pixels do not change.

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

**environment-hemisphere, advanced to `39c3bfe36` on 2026-11-05:** the physical and transmissive shaders' sun lobes take `margoDirectVisible` and gain `margoLit`, so their text differs; the standard and extended shaders, the hooks and the GPU calls are as before.

**environment-hemisphere, advanced to `a1f778bdc` on 2026-11-05:** the transmissive shader gains the surface tint functions, so its text differs; the lit draw is as before.

**clustered-area-lights, clustered-light-hooks, clustered-local-shadows, environment-hemisphere, gltf-pro-lighting-hooks, post-ssr-models and quality-presets, advanced to `6a958e532` on 2026-11-05:** the IBL, sky, probe, clustered and SSR shaders take the dielectric Fresnel ends as arguments, so their text differs. Plain materials pass 0.04 and 1, which give the old numbers; the calls, bindings and uploads are as before.

**environment-hemisphere, advanced to `8d18597ee` on 2026-11-05:** the physical shaders' direct light now scales F90 by the KHR_materials_specular weight and weights the base by one number, so their text differs; the hooks and everything else the proof compares are as before.

**environment-hemisphere, advanced to `b31bdb16a` on 2026-10-31:** without a hemisphere the proof's text differs in one place, the transmissive shader. `tintEntry` gained `margoTintShare`, because the light behind glass is in the base layer under specular, sheen and clearcoat (KHR_materials_transmission, KHR_materials_specular, KHR_materials_sheen, KHR_materials_clearcoat). No hemisphere path changed; a material without transmission emits the same text. `packages/materials/tests/transmission-layers.test.js` has the numbers.

**terrain-ssr, advanced to `ba7a0fc89` on 2026-10-30 (biome look plan L5, item 7):** the clipmap's outer rings
reach past the heightmap, where main drew a shelf of clamped edge heights to the horizon (and cast its shadows inward).
Terrain now discards fragments outside the heightmap rectangle, so with neither the SSR hook nor `roughness` 11 calls
per story differ from `6c20076d` (of 2,269, 1,311 and 4,189), every one a `createRenderPipeline` whose shader text
changed: the colour fragment and the capture entry start with the out-of-map
`discard`, and the depth-only shadow pipeline gains a fragment stage (`outside`, no colour targets) that does the same.
Call counts, bind groups, buffers and every buffer write are unchanged. The proof's stand-in device read
`d.fragment?.targets[0].format`, which threw on a fragment with no targets; it reads `targets[0]?.format` now.
`packages/terrain/test/edge.browser.mjs` checks the pixels on a real GPU (sky only past a corner) and
`packages/terrain/test/lighting.test.js` the shadow pipeline.

**water-ssr, advanced to `268bfc625` on 2026-11-01 (biome look plan 3, L11 and Scott's S6):** against `5cf53d7e6`, 12 of the 2,744 calls
differ, 4 in each of the 3 stories, every one the `createShaderModule` of the water surface (14,445 to 15,191 characters; 14,575
to 15,321 with the horizon). Call counts, pipelines, bind groups, buffers and every buffer write are unchanged. The text changes
for two reasons. S6 is deliberate and changes pixels with no option set: the shoreline term's foam cap goes from 0.08 to 0.35
(`SHORE_FOAM`), so views with a Water shore show more foam at the waterline (76.96 to 111.72 at the minimum channel in
`packages/biomes/tests/water-check.mjs`). The new `still` option adds its code behind `const STILL=false`, as `HORIZON` does: with
it false every added select returns the old value, so `still` off changes nothing else. A water without `still` or `fill` makes
no new GPU calls: no fill texture, no prefill pipeline, the same dispatches.

**water-ssr, advanced to `5cf53d7e6` on 2026-10-31 (biome look plan 3, A2, the horizon sea follows the camera):** the
horizon grid kept regular cells only near the origin, so a camera away from it saw no swell, and it ended in a square
10 km out that high cameras saw below the horizon. The frame uniform gains a `grid` vec4 (the camera position snapped
to a whole cell, added to the grid in the vertex shader when `horizon` is on), so in every story the frame uniform is
528 bytes instead of 512 (its `createBuffer` and every write of it) and the water shader texts (surface, capture,
coastal flow and spray, which share the frame struct) change; the story with `horizon: true` also writes the snapped
offset and a vertex buffer whose outer rows grow geometrically to 10 km and whose last row lies 10,000 km out. With
`horizon: false` the rendered pixels are unchanged (`packages/water/test/horizon.browser.mjs` compares the near field of
both grids on a real GPU).

**quality-presets, advanced to `33c403984` on 2026-10-30 (VFX repeatable particle order):** the VFX update kernel took
respawn tickets and draw-list places with `atomicAdd`, so which dead slots were born and the order of blended particles
changed from run to run. It now runs four small workgroup prefix-sum passes around the simulation, so births take the
lowest dead slots and the drawn particles are compacted in slot order (accepted difference in work, Scott 2026-10-30;
`docs/limits.md`, `docs/whitepaper/perf-history.md` section 6; regression test `packages/vfx/test/browser-check.mjs`,
the order case). The golden outputs were recaptured with `proofs/capture.mjs` at that commit; the proof's three comparisons (no preset,
preset against explicit options, explicit against none) still hold, and no other package's code changed.

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
