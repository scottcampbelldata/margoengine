# Build record

This file records every finished batch of work on Margo Engine: what each batch was for, what landed, which bugs it
found, how it was proved and what is still unproved. Scott directs AI agents to build and test this engine; no section
below describes hand-written code. Agents wrote the code and the tests, and an agent pushed each commit after its
checks, with the slips listed in the sections below.

Read it with its sources: [claims.md](claims.md) holds each claim and its proof, [perf-history.md](perf-history.md) each
measured speed result, [../limits.md](../limits.md) each limit and [../known-bugs.md](../known-bugs.md) each open defect.
Where this file and one of those differ, the page that owns the claim wins.

How to read a section:

- **Status.** DONE: the job is on `main`. DONE, GAP OPEN: the job landed, and what is left stays open in known-bugs.md.
  OPEN: rechecked, not closed. SKIPPED: the job needed no new work, for the reason given. PARKED: the job moved to the
  end of its queue and is not done.
- **Timings.** Every timing taken since 2026-11-05 is diagnostic, because other jobs shared the machine. None is a
  published speed result until a quiet run repeats it on the final code. A few runs passed the bench tool's quiet gate
  when they were taken, and those sections say so; they wait for the same rerun.
- **Proof.** "Real GPU" means a browser check on real WebGPU, on an NVIDIA RTX A6000 unless a section names another GPU.
  "CPU tests" means Node tests with no GPU. "Synthetic" means simulated events or stand-in objects, with no real device.
- **Gate.** Each push had to pass `npm run lint`, `npm run hygiene`, `npm run verify` and the changed package's tests,
  and its GPU test if it has one. When `main` moved during a run, the rule allowed a rebase with a shorter rerun, so
  many commits did not rerun `verify` on their final rebased tree. Sections name the cases that matter and the slips
  that reached `main`.

Open for the whole run: 16 of 81 visual views fail against baselines recorded on 2026-10-31. Three deliberate look
changes caused them, two of them from batch 1, and no new baseline has been approved (known-bugs.md). Nothing here has
been run in Safari itself or in Firefox.

## Batches

Batches 1 to 3 are phase 1. Batches 19 and 21 are partly done, each with one job parked.

| Batch | Package | Jobs | Done | Open | Skipped | Parked |
| --- | --- | --- | --- | --- | --- | --- |
| [1](#batch-1-fixes-part-1-of-3) | fixes | 5 | 5 | 0 | 0 | 0 |
| [2](#batch-2-fixes-part-2-of-3) | fixes | 5 | 3 | 2 | 0 | 0 |
| [3](#batch-3-fixes-part-3-of-3) | fixes | 1 | 1 | 0 | 0 | 0 |
| [4](#batch-4-speed-losses-part-1) | speed losses | 5 | 5 | 0 | 0 | 0 |
| [5](#batch-5-speed-losses-part-2) | speed losses | 5 | 5 | 0 | 0 | 0 |
| [6](#batch-6-speed-losses-part-3) | speed losses | 5 | 5 | 0 | 0 | 0 |
| [7](#batch-7-speed-losses-part-4) | speed losses | 1 | 1 | 0 | 0 | 0 |
| [8](#batch-8-math) | math | 6 | 6 | 0 | 0 | 0 |
| [9](#batch-9-ecs) | ecs | 6 | 6 | 0 | 0 | 0 |
| [10](#batch-10-compute) | compute | 5 | 4 | 0 | 1 | 0 |
| [11](#batch-11-headless) | headless | 4 | 4 | 0 | 0 | 0 |
| [12](#batch-12-cameras) | cameras | 5 | 5 | 0 | 0 | 0 |
| [13](#batch-13-controls) | controls | 8 | 8 | 0 | 0 | 0 |
| [14](#batch-14-input) | input | 5 | 5 | 0 | 0 | 0 |
| [15](#batch-15-stats) | stats | 4 | 4 | 0 | 0 | 0 |
| [16](#batch-16-quality) | quality | 4 | 3 | 0 | 1 | 0 |
| [17](#batch-17-core) | core | 5 | 4 | 0 | 1 | 0 |
| [18](#batch-18-stage) | stage | 4 | 4 | 0 | 0 | 0 |
| [19](#batch-19-margoengine-partly-done) | margoengine | 2 | 1 | 0 | 0 | 1 |
| [20](#batch-20-webgl) | webgl | 3 | 3 | 0 | 0 | 0 |
| [21](#batch-21-webgl2-compat-partly-done) | webgl2-compat | 6 | 4 | 0 | 1 | 1 |
| [22](#batch-22-geometry-part-1-of-2) | geometry | 8 | 8 | 0 | 0 | 0 |
| [23](#batch-23-geometry-part-2-of-2) | geometry | 4 | 4 | 0 | 0 | 0 |
| [24](#batch-24-mesh-edit) | mesh-edit | 8 | 8 | 0 | 0 | 0 |
| [25](#batch-25-splines) | splines | 6 | 6 | 0 | 0 | 0 |
| [26](#batch-26-lines) | lines | 8 | 8 | 0 | 0 | 0 |
| [27](#batch-27-points) | points | 7 | 7 | 0 | 0 | 0 |
| [28](#batch-28-bvh) | bvh | 7 | 7 | 0 | 0 | 0 |
| [29](#batch-29-culling) | culling | 8 | 8 | 0 | 0 | 0 |
| [30](#batch-30-lod) | lod | 7 | 7 | 0 | 0 | 0 |
| [31](#batch-31-shader-part-1-of-2) | shader | 8 | 8 | 0 | 0 | 0 |
| [32](#batch-32-shader-part-2-of-2) | shader | 4 | 4 | 0 | 0 | 0 |
| [38](#batch-38-gltf) | gltf | 6 | 6 | 0 | 0 | 0 |
| Total | | 175 | 167 | 2 | 4 | 2 |

## Batch 1: fixes (part 1 of 3)

The highest-priority open defects.

| # | Job | Status | Commit | Guard |
| --- | --- | --- | --- | --- |
| 1 | React development hints stayed off under the Vite dev server | DONE | `03d080b66` | `packages/react/tests/dev-mode-bundle.test.js`, `extras-browser.tsx` |
| 2 | Fourteen packages' own `npm test` missed test files | DONE | `68b55c2ed` | `tests/package-test-scripts.test.js` |
| 3 | Frame budget failed on the gameplay sandbox (WebGL2 layer, CPU tier) | DONE | `88a2ae178` | `packages/webgl2-compat/test/routes.test.js` |
| 4 | `KHR_materials_specular` weight did not scale Fresnel at grazing angles | DONE | `43b39e9df`, `63868c640` | material and environment tests in both commits |
| 5 | gltf-pro's native tint draw read factors, never maps | DONE | `6f0836ee3` | `packages/gltf-pro/tests/extensions.test.js` |

- **Bugs:** job 1 also found a reversed guard that left `DevTools` panels on in every production browser build. Job 3
  moved the VFX and scatter prefix counts and the sky's spherical-harmonics projection off the layer's CPU tier: median
  main-thread work a frame went from 3,748 ms to 2.9 ms, under the unchanged 50 ms budget (perf-history entry 45). Job 2
  put 44 more test files into the fourteen packages' own runs, all passing. `ffc9dd315` followed job 5: each dispersed
  ray now reads the blur level of its own IOR, and the check's references were corrected.
- **Proved:** real GPU and browser checks. Job 5's cost: 0.52 ms for four-map glass at 1080p, against 0.33 with no draw
  and 0.39 factors-only (quiet gate passed; LIM-035, perf-history entry 47).
- **Limits:** ambient diffuse under the specular extension keeps a per-channel share (docs/limits.md).
- **Unfinished:** jobs 4 and 5 are two of the three look changes behind the visual baseline row at the top of this file
  (8 of the 16 views). They recorded no new baselines.

## Batch 2: fixes (part 2 of 3)

Material lighting defects, a flaky timing test, and two rechecks of defects below or outside the engine.

| # | Job | Status | Commit | Guard |
| --- | --- | --- | --- | --- |
| 1 | Clearcoat did not dim the opaque base through materials `install` | DONE | `a94acb384`, `7d7cc404e` | `scripts/materials-clearcoat-tests.js`, `packages/materials/tests/clearcoat.test.js` |
| 2 | Display-encoded targets added transmitted and lit light in encoded values | DONE, GAP OPEN | `9cb07f246` | `packages/materials/tests/transmission-layers.test.js` |
| 3 | Findings of the outside audit (2026-10-28) | OPEN | `857a89f3a` | none yet |
| 4 | USDZ timing test failed when every core was busy | DONE | `ab61e0a1a`, `0cdcd0be2` | `packages/exporters/tests/exporters.test.js` |
| 5 | 4x MSAA blending is not repeatable | OPEN | `aec21cf81` | `scripts/msaa-blend-repeat-check.mjs` |

- **Bugs:** job 1's first fix broke the extension GPU suite, and a surface in full shadow also kept its coat and sheen
  sun highlights; `7d7cc404e` fixed both. Job 4's first fix failed later under bursty load, because a 3 ms control found
  quiet gaps a 20 ms export could not; `0cdcd0be2` times six controls per reading, with the budget of 10 unchanged.
- **Proved:** job 1 reads its values on a real GPU. Job 2 on `materials` `install` and `Transmission`: encoded 0.5 over
  encoded 0.5 reads 0.69, as linear light does, not 1.0.
- **Still open:** job 2's native two-draw glass path adds in encoded values; closing it needs a scene copy per glass
  draw or a core change, which is Scott's call. Job 3: audit finding F20 was not reproduced or identified, and the fuzz
  runs gave 0 findings; closing it needs the audit's F20 text. Job 5: the recheck still drew 29 of 30 frames differently
  with no Margo code at all, and 0 of 30 with `--mask=7`, so the fault is below the engine.

## Batch 3: fixes (part 3 of 3)

Materials cut-outs had reached only the shadow maps.

| # | Job | Status | Commit | Guard |
| --- | --- | --- | --- | --- |
| 1 | Cut-outs on materials meshes: passes the shadow fix did not reach | DONE | `214a946ba`, `09c987b49` | `packages/materials/test/cutout-passes-browser.mjs`, `packages/shadows/test/cutout-casters-browser.mjs`, `packages/selection/test/deformed.test.js` |

- **Bugs:** each gap reproduced on the GPU: a click through a hole hit the quad, contact shadows skipped `alphaTransform`
  and the opacity map, and TAA ignored the opacity map. Found on the way: `VirtualShadows` ignored the opacity map too
  and rebuilt such a caster every frame, and TAA threw on a plain materials mesh with no map. `09c987b49` then did the
  same for displacement and clipping planes.
- **Proved:** real GPU, including that opaque casters keep their shaders and draws (the `taa-velocity` proof still
  matches its recorded GPU calls).
- **Cost:** size budgets grew by 60 B (selection), 489 B (staging) and 311 B (taa), logged in the baseline.

## Batch 4: speed losses (part 1)

Five measured losses against three.js. All timings are diagnostic.

| # | Job | Status | Commit | Record |
| --- | --- | --- | --- | --- |
| 1 | Measure precise maths against the WGSL builtins | DONE | `4519e872d` | LIM-039, perf-history entry 48 |
| 2 | `createInstancedMesh` read vertex attributes its material did not use | DONE, GAP OPEN | `20a5e259a`, `ee720b6df` | perf-history entry 50 |
| 3 | A package's own render pass cost a fixed MSAA store and reload | DONE | `ba3a63639` | LIM-053, perf-history entry 51 |
| 4 | Moving instances spent twice three's CPU a frame | DONE, GAP OPEN | `eff7e778d`, `87cdbf396` | LIM-184, perf-history entries 53, 55 |
| 5 | `DynamicInstances` spent more GPU time than `InstancedMesh` | DONE, GAP OPEN | `8fc9f4bb3` | perf-history entry 54 |

- **Results:** job 1: 1.0 to 1.8 times the builtins, `tan` 2.3, `pow` 3.0, an accepted difference (quiet gate passed).
  `4cfb6a0a8` later changed `pow`, so its cost must be measured again. Job 2: 0.615 to 0.546 ms at 50,000 boxes, against
  three's WebGL2 0.469 and WebGPU 0.351; the cause of the rest is not found. Job 3: 1,000 boxes 0.039 to 0.024 ms,
  against three's WebGL2 0.031, bit identical in opaque scenes. Job 4: 10,000 moving boxes 1.14 to 0.92 ms
  (`CulledInstances` 1.47 to 1.10) against three's 0.63 and 0.90; the upload is the largest part left. Job 5: 2.76 to
  2.73 ms at 250,000 against three's 2.00; the traffic was not the main cost and the cause is not found.
- **Core change:** job 3 changed core with Scott's approval, because core owns the clear, the resolve target and the
  graph order. It prevents no engine failure. Core plus stage went from 22,522 B to 22,815 B gzip.
- **Bugs:** `ee720b6df`: job 2's tangent frame trim could match across structs and delete declarations. `d9a802aea`,
  landed right after job 5: under cadence a due cascade redrew static casters that had not been prepared
  (`packages/shadows/test/cache.test.js`).
- **Limits:** job 3 was measured on the RTX A6000 only, and the gain on tile-based GPUs is unmeasured. `Spring`'s 0.41 to
  0.28 ms was timed by hand and no committed script repeats it. `@margoengine/materials` keeps its bare fields.

## Batch 5: speed losses (part 2)

Five more losses. All timings are diagnostic, on a busy machine.

| # | Job | Status | Commit | Record |
| --- | --- | --- | --- | --- |
| 1 | STL import computes normals three's `STLLoader` leaves zero | DONE | `72eb4f5f5` | LIM-183, perf-history entry 57 |
| 2 | USDZ export wrote every mesh in world space | DONE, GAP OPEN | `4b63814c1` | LIM-095, perf-history entry 69 |
| 3 | Morph targets: CPU per Animation per frame | DONE, GAP OPEN | `ef9ce4606` | perf-history entry 58 |
| 4 | `cloneModel`: two engine-wide ticks per copy | DONE, GAP OPEN | `0d5a89967` | perf-history entry 59 |
| 5 | GPU picking waited for one readback per pick | DONE, GAP OPEN | `7a574a1b8` | LIM-180, perf-history entry 60 |

- **Results:** job 1: byte-identical output, 5.5 to 4.6 ms in Node; `p-stl` 4.5 ms against three's 3.5, and with normals
  on both sides 5.2 against 10.7, an accepted difference. Job 2: 16.0 to 4.4 ms against three's 3.2, and 2.46 MB to
  496 KB against 444 KB; the last 1.2 ms needs a quiet run. Job 3: 0.49 to 0.35 ms against three's 0.26. Job 4: 16.8 to
  14.3 ms against three's 8.1. Job 5: `Picking.pickMany` answers 100 points from one readback in 83 ms against 369, same
  hits; one `engine.pick` per point keeps its round trip, and three's WebGL takes 67 ms.
- **Bugs:** `5d447a5c9`: the USDZ reader refused our own vertex-coloured exports and loaded textured alpha as opaque
  (`packages/usdz/tests/usdz.test.js`).
- **Proved:** job 2 on Apple's tools, macOS 27.2: `usdchecker --arkit` passes, RealityKit gives the same seven models and
  bounds as a geometry per node, and the Quick Look thumbnails of the two files are byte-identical. It landed last, in
  the batch 6 run, because it waited for that Apple check. Job 5: real GPU, the same 27 hits as 100 `engine.pick` calls.
- **Limits:** Quick Look draws vertex-coloured meshes flat grey (known-bugs.md). The textured kit has not been compared
  with the engine twins or opened on an iPhone or iPad. Job 4's remaining tick needs a core kernel change or cheaper
  node creation.
- **Size:** the selection budget went from 19,726 B to 20,446 B for `pickMany`, with the reason logged. That raise led to
  Scott's rule of 2026-11-05: a package size budget may rise if documented and justified; test tolerances and time
  budgets may not.

## Batch 6: speed losses (part 3)

GPU-side losses. All timings are diagnostic, on a busy RTX A6000.

| # | Job | Status | Commit | Record |
| --- | --- | --- | --- | --- |
| 1 | SciFiHelmet: default soft shadows cost GPU time | DONE | `68f2a9532` | perf-history entry 63 |
| 2 | Raw meshes: native calls per draw | DONE | `bf87f7c89` | LIM-075, perf-history entry 66 |
| 3 | Motion blur needs TAA for velocity | DONE, GAP OPEN | `5f5e2727c` | LIM-078, perf-history entry 65 |
| 4 | Rect area lights: main pass GPU time | DONE | `bdb81ca80` | LIM-089, perf-history entry 67 |
| 5 | `Environment.create` does work PMREM does not, and recomputes its BRDF LUT | DONE | `66007c870` | LIM-090, perf-history entry 68 |

- **Results:** job 1 changed no code: 0.33 ms against three's 0.08 and 0.07 is an accepted difference, because three
  draws one map with one fixed filter; like for like it is 0.074 against 0.085 and 0.068. The planned cheaper filter
  changes the image, so it was not taken. Job 2: 22.5 to 3.4 ms CPU, image SSIM 0.997 against three; the drop is larger
  than the calls saved explain, and why is unmeasured. Job 3: new `velocityOnly` option, 0.63 to 0.48 ms; three's WebGPU
  read 0.25 in the ledger and 0.66 in that busy run, so the verdict waits. Job 4: 0.47 to 0.38 ms, byte-equal frames,
  against three's WebGL 0.15 and WebGPU 0.35; the rest is the exact edge term, kept because the fitted term is 1.5e-4 off
  and wrong across the horizon. Job 5: `p-pmrem` 9.8 ms against three's 5.2, the saving within noise; the like-for-like
  scene `p-pmrem-refresh` takes 4.1 ms.
- **Bugs:** `area-lights-gpu.mjs` had drifted from core's display curve since 2026-10-17 and nothing ran it, so it failed
  unseen; it now runs in the package's GPU tests. Two runs each took perf-history entry 64: `a58488078` moved one and
  made the `public-truth` check refuse a repeated number.
- **Still open:** `p-motion-blur`'s image has never matched three's (SSIM 0.656, delta E 13.2), cause unknown.

## Batch 7: speed losses (part 4)

The first frame of 100 morphed copies.

| # | Job | Status | Commit | Record |
| --- | --- | --- | --- | --- |
| 1 | First frame of 100 morphed copies | DONE, GAP OPEN | `c8b23235c`, `e7081c830` | LIM-181, LIM-182, perf-history entries 49, 56 |

- **Results:** the wait was GPU work, not pipelines: each copy uploaded and mipped its own textures. Copies now share one
  texture per device, image and format (7 textures for 100 copies, not 700), with the same pixels byte for byte; first
  frame 249 ms to between 133 and 187. `PBRModel.compile()` then moved the pipeline compile into the build: first frame
  17 ms, but build plus first frame is 125 to 143 ms against 154 without it, three's WebGL 54 and WebGPU 217. The real
  saving is 11 to 29 ms.
- **Core change:** `Engine.renderTarget`, one read-only getter, 44 B gzip, Scott's exception of 2026-11-05. It prevents no
  engine failure.
- **Follow-up:** `1342d03dc` shares the bind-pose vertices between copies (LIM-179). This file holds no number for its
  effect on build plus first frame.

## Batch 8: math

New optional types in `@margoengine/math`, written from public definitions.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Oriented bounding boxes | DONE | `99e86ee49`, docs `5d8fa1af1` | `@margoengine/math/obb` | LIM-054 |
| 2 | Line3, Triangle and Cylindrical | DONE | `f47864ae7` | `/line3`, `/triangle`, `/cylindrical` | LIM-045 |
| 3 | Project and unproject | DONE | `b8548b4b1` | `/project` | LIM-047 |
| 4 | Colour management | DONE | `348d87e78` | `/color-space` | LIM-055 |
| 5 | Spherical harmonics | DONE | `e958a3b04` | `/sh` | LIM-048 |
| 6 | Capsule | DONE | `2efa3cca1` | `/capsule` | LIM-050 |

- **Bugs:** `9ecf7ea9e`: `color()` found Object's `constructor` in its table of colour spaces and parsed the name as
  linear sRGB instead of throwing (`packages/math/test/color-p3.test.js`).
- **Proved:** CPU tests only, against independent references: 1,000 seeded box pairs against polygon clipping, 5,000
  triangle and box pairs, 2,000 seeded project round trips, 6,500 capsule pairs against the exact point distance.
- **Limits:** spherical harmonics are CPU only with no rotation of a coefficient set. Colour conversion has four named
  spaces and D65 white.

## Batch 9: ecs

Systems, queries and relations for `@margoengine/ecs`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Systems and scheduler | DONE | `0b8bfae69` | `@margoengine/ecs/schedule` | LIM-056 |
| 2 | Change detection | DONE | `d462f554a` | `/changes` | LIM-057 |
| 3 | Query filters and tags | DONE | `406af9caf` | `/query` | LIM-058 |
| 4 | Engine bridge | DONE | `f48e5ddfb` | `/engine` | LIM-059 |
| 5 | Relationships | DONE | `6f5405594` | `/relations` | LIM-066 |
| 6 | Growable worlds | DONE | `f1d096012` | `/growable` | LIM-069 |

- **Proved:** CPU tests against plain references over seeded work: 500 rounds for change detection, 200 scenes for
  queries, 5,000 steps for relations with a 100,000-deep cascade, 20,000 steps for growth. The bridge ran on a real
  engine and transform kernel.
- **Limits:** a direct write to `fields` is invisible to `ChangeTracker` until `touch`. The bridge goes one way, component
  to mesh. A loop on a `GrowableWorld` takes about twice as long as on a fixed `World`: ratio 2.02 to 2.09, three runs on
  a busy machine, published as an accepted difference (perf-history entry 61), with a quiet rerun owed.
- **Gate:** jobs 5 and 6 reran hygiene, the API check and the package tests after their rebases, not a second `verify`.

## Batch 10: compute

More of `@margoengine/compute`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Subgroup operations | DONE | `6a92dd0bc` | `@margoengine/compute/subgroups` | LIM-074 |
| 2 | Measured fast maths | SKIPPED: already on main as batch 4 job 1 (`4519e872d`) | none | none | LIM-039 |
| 3 | Neural network layers | DONE | `0fa35a438` | `/nn` | LIM-079 |
| 4 | Graph algorithms | DONE | `e3f1b43d3` | `/graph` | LIM-080 |
| 5 | Workgroup autotuning | DONE | `8d5c85add` | `/autotune` | LIM-082 |

- **Proved:** real GPU. Subgroup kernels equal the default kernels at subgroup sizes 32 (RTX A6000) and 4 (SwiftShader).
  Network gradients match central differences on the CPU backend. Graph results match sequential references exactly at
  50,000 to 200,000 vertices on WebGPU.
- **Limits:** network and graph speed are not measured. Autotuning makes no claim of a speed-up: on the busy A6000 every
  size read about the same, and Chrome rounds GPU timestamps to steps of 0.066 ms. Subgroups, diagnostic: sort 11.9
  to 7.0 ms, sum 1.3 times faster, no gain on cumsum. Subgroup sizes other than 32 and 4 are untested.
- **Slip that reached main:** a faulty renumber step in job 3's rebase moved the title of claims.md below its table and
  left a second LIM-075. `094bc06ab` repaired it and added `tests/claims-file.test.js`, which later landings ran too.

## Batch 11: headless

Rendering with no page, and files out of it.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Image sequence and video output | DONE | `189e5f5cc` | `@margoengine/headless/video`, `/ffmpeg` | LIM-087 |
| 2 | Stage without a page | DONE | `1eb3b58f4` | `/stage` | LIM-091 |
| 3 | Image comparison helpers | DONE | `9ffb221c9` | `/compare` | LIM-093 |
| 4 | More output formats | DONE | `8abc7fe60` | `/formats` | LIM-094 |

- **Proved:** real GPU. WebM and MP4 play back through a browser's decoder and are compared with the rendered frame.
  JPEG and lossless WebP decode in the browser's own decoders, lossless bit for bit. An EXR of the linear scene capture
  reads back through `parseEXR`. `createHeadlessStage` gives the picture of `createStage` on a page.
- **Limits:** Node itself was not run: no WebGPU binding is in the repository, so the headless stage is proved through a
  browser's WebGPU on a stand-in canvas. The real ffmpeg read our WebM and ran the VP9 arguments, while raw-video input
  and the H.264 arguments ran only against a stand-in program. The encoders are plain, so files are larger than an
  optimized encoder's, and sizes were not compared.
- **Bugs:** `6b73a37f3` changed a garbage window test that read -168.736 B once on a loaded machine. Its limits stayed.
  The cause is the likely one, not a proven one: the value did not come back in 100 runs.
- **Gate:** job 1's landing script still pointed at the previous batch's package, so its package and GPU steps tested
  the wrong package. `npm run verify` did run the headless tests, and the GPU check passed by hand before the landing and
  again on the same code in job 2's runs.

## Batch 12: cameras

Lens and projection work in `@margoengine/cameras`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | View offset | DONE | `9850d0f39` | none (`setViewOffset`, `tileOffsets`) | LIM-098 |
| 2 | Focal length and film gauge | DONE | `2206d01bd` | none (`lensToFov`, `fovToLens`, `focalLength`) | LIM-099 |
| 3 | Off-axis and oblique projection | DONE | `6bae86549` | `@margoengine/cameras/offaxis` | LIM-102 |
| 4 | Physical exposure | DONE | `2144e9654` | `/physical` | LIM-105 |
| 5 | Panini and fisheye | DONE | `bff096c5b` | `/panini` | LIM-107 |

- **Bugs:** `8ea369bb2`: after `dispose()` the lens sync from job 2 still ran and threw every frame. Job 3's GPU check
  caught it (`packages/cameras/test/lens.test.js`).
- **Proved:** CPU tests against closed forms, and real GPU cases for view offset, off-axis, oblique and wide angle.
- **Limits:** pinhole model only. Exposure is relative, with no photometric claim. Depth precision of an oblique near
  plane close to edge-on is not measured. Per-frame cost of tiled rendering and of the `WideAngle` pass is not timed.
  Effects that read the whole image see only the tile. `@margoengine/post` is a new optional peer, not tested in a clean
  install.
- **Slip that reached main:** job 3 was pushed with no gate over two failing umbrella tests. The cause was a missing
  workspace link in that worktree, not a code fault; `verify` then passed on the pushed code.

## Batch 13: controls

Eight additions to `@margoengine/controls`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Roll in fly and trackball controls | DONE | `976b10e52` | `@margoengine/controls/fly`, `/trackball` | LIM-112 |
| 2 | Gizmo polish | DONE | `e98c4b4a1` | none (`flipAxes`, `showDelta`, `occlude`) | LIM-113 |
| 3 | Third-person camera with collision | DONE | `10c13537f` | `/third-person` | LIM-114 |
| 4 | DragControls rotate mode and groups | DONE | `3a03444c0` | none | LIM-115 |
| 5 | Orbit target radius limits and zoom | DONE | `f2a0b5221` | none | LIM-116 |
| 6 | Pivot modes and multi-object editing | DONE | `b7b27ae6a` | none (`attachMany`, `pivot`) | LIM-117 |
| 7 | Arcball gizmo and shortcuts | DONE | `8bd7e118e` | none (`ArcballGizmo`, `listenToKeyEvents`) | LIM-118 |
| 8 | Moving platforms for the walker | DONE | `7add6a802` | none (`carry`) | LIM-119 |

The commit bodies of jobs 1 to 4 name older LIM numbers, which moved on rebase. The table holds the current ones.

- **Proved:** CPU tests with synthetic events on real core objects, and browser checks for the gizmo and the arcball.
- **Limits:** `carry` is on by default and adds one transform pass per update even on static levels; that cost is not
  measured. The third-person arm is nine rays, so a thin object can slip through, and its CPU cost is not measured. Gizmo
  occlusion hides the drawing only, so a hidden handle can still be grabbed.
- **Gate:** the first landing of jobs 1 to 4 failed `verify` on duplicate claim rows left by a rebase script. Nothing was
  pushed; the script was fixed and the jobs landed.

## Batch 14: input

Rules, players and devices for `@margoengine/input`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Interactions | DONE | `5aa60a45c` | `@margoengine/input/interactions` | LIM-127 |
| 2 | Local multiplayer | DONE | `52db265c1` | `/players` | LIM-132 |
| 3 | Gyro aiming | DONE | `8f1a96d00` | `/motion` | LIM-134 |
| 4 | Recording and replay | DONE | `bb1cab5ff` | `/replay` | LIM-148 |
| 5 | Pen pressure and tilt | DONE | `52dc5fd80` | `/pen` | LIM-149 |

- **Bugs:** in job 1's commit, a press and release between two updates was lost on keys, mouse and touch buttons, and a
  key repeat counted as a new press after a blur reset (`packages/input/test/interactions.test.js`). `9f8c8a24d`: `verify`
  stopped with `EPERM` when two runs pruned the shared result cache at once (`tests/result-cache.test.js`). That commit
  left conflict markers in known-bugs.md, removed in `3f71b2d49`, with `tests/conflict-markers.test.js` added.
- **Proved:** synthetic only. CPU tests on a fake clock and simulated devices. A seeded 400-tick session replays with every
  state equal on every tick.
- **Limits:** gyro and pen have never run on a real device: they are tested with synthetic events. A gamepad press shorter
  than one update can be missed, because gamepads are polled. A browser merges all keyboards into one.
- **Gate:** main moved twice during job 4's checks, so the landing script was changed to rerun the package and claims
  tests after a move and the full checks only if the move touched what the change uses. Jobs 4 and 5 may have skipped a
  full `verify` on their last rebased tree.

## Batch 15: stats

Tools for seeing what a running engine costs.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Pipeline compile tracking | DONE | `4ed7b1257` | `@margoengine/stats/compile` | LIM-153 |
| 2 | CPU phase breakdown | DONE | `d4153c5b7` | `/phases` | LIM-156 |
| 3 | Leak alerts | DONE | `34052b345` | `/leaks` | LIM-159 |
| 4 | Field telemetry | DONE | `f13759f6a` | `/beacon` | LIM-160 |

- **Bugs:** `textureBytes` counted `etc2-rgba8` formats as 8 bytes per block instead of 16, and read every ASTC format as
  4x4 blocks, so `astc-8x8` came out four times too large (`packages/stats/test/report.test.js`).
- **Proved:** CPU tests plus `scripts/test-stats-browser.mjs`, which runs all four entries on the real A6000 and engine.
  Percentiles stay within 4.6% of exact.
- **Limits:** compile times are CPU time around each call, and browsers compile in another process, so a stall can land
  later. The frustum test runs inside the one Wasm kernel call, so it is timed in `tick`. The per-frame cost of the
  wrappers is not measured.
- **Gate:** job 3's first landing failed the API gate on an error message that named no fix. Nothing was pushed.

## Batch 16: quality

Quality scaling, measured rather than guessed.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Upscaling | SKIPPED: `TAAUpscale` in `@margoengine/taa/upscale` already covers it; the parity docs wrongly listed it as missing and job 2's commit corrected them | none | none | none |
| 2 | Supersampling | DONE | `7abffd992` | `@margoengine/quality/ssaa` | LIM-165 |
| 3 | Feature scaling | DONE | `8933426cd` | `/features` | LIM-168 |
| 4 | Battery and thermal awareness | DONE | `30c31efe4` | `/power` | LIM-176 |

- **Bugs:** two in job 4's new code before it landed, both with tests: `hot` cleared itself right after a step down, and
  one unplug reported twice.
- **Proved:** real GPU for supersampling (64 samples read at least 34 dB against a reference drawn 8 times larger) and for
  feature scaling, where real `SSAO` and `Shadows` ran through every level.
- **Limits:** `FrameDrift` is proved only on modelled frame costs, not on a machine really throttling. Feature savings
  were measured only on a light test scene with other jobs running. Battery status and CPU pressure are Chromium only.

## Batch 17: core

Work asked of core. The four jobs built here changed no core source; job 3 had already landed in core.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Rendering in a worker on an OffscreenCanvas | DONE | `ac2f6c5ba`, `2aed3264b` | `@margoengine/worker` | LIM-101 |
| 2 | Scene graph conveniences | DONE | `e9b71d40e` | `@margoengine/scene` | LIM-104 |
| 3 | Packages draw inside core's main pass | SKIPPED: already on main as batch 4 job 3 (`ba3a63639`) | none | none | LIM-053 |
| 4 | WebGPU compatibility mode adapters | DONE | `ea6137ab1` | `@margoengine/webgl2-compat/adapter` | LIM-109 |
| 5 | Bulk transform writes | DONE | `94dea70ca` | `@margoengine/scene/bulk` | LIM-111 |

- **Bugs:** job 4: on a compatibility device core's pick pipeline was refused, so pick returned the first mesh for every
  point, and the draft check missed it because it never picked off a mesh; the adapter now rewrites `@interpolate(flat)`
  and the check tests a hit and a miss. `2aed3264b`: `attach` was typed so the README example failed to compile, and
  package tests now type-check README examples as written. `f18b0683e`: `verify` ended with `ENOENT` when another run
  pruned the shared result cache.
- **Proved:** job 1 on a real GPU in Chromium, with each thread running while the other is stuck. Job 2 against the Wasm
  kernel's matrix. Job 5 bit for bit against the setters (diagnostic at 10,000 meshes: positions 0.12 ms against 0.59).
  Job 4 only on a forced device on the RTX A6000.
- **Limits:** job 4 has not run on a real OpenGL ES or Direct3D 11 class GPU, and the forced device takes this GPU's
  limits, so the run proves the level's validation, not an older GPU's limits. `Shadows`, `CulledInstances` and an HDR
  `PostStack` stop at their first frame on the level (known-bugs.md). Firefox and Safari have not run the worker.

## Batch 18: stage

One-call features on the stage, each in its own entry, with the stage root and core unchanged.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Enter VR and AR button | DONE | `cce8dda5d` | `@margoengine/stage/xr` | LIM-120 |
| 2 | Model viewer preset | DONE | `7cd671d99` | `/viewer` | LIM-124 |
| 3 | Physics in one call | DONE | `774a89706` | `/physics` | LIM-129 |
| 4 | Load a saved scene document | DONE | `a2608079f` | `/scene` | LIM-131 |

- **Bugs:** `ColorBackground`, `ImageBackground` and `EnvironmentBackground` stayed registered after `dispose()`, so a
  replacement could not attach (`packages/environment/tests/transparent.test.js`). `@margoengine/staging` used
  `@margoengine/math` without declaring it, so a parallel build could fail; `tests/package-order.test.js` now checks every
  package. Before landing, the physics draft treated any mesh with its vertices on box corners as a box.
- **Proved:** job 1 on real WebGPU with a simulated session; no headset has run it. Job 2 on real WebGPU with a real glTF.
  Job 3 with real Rapier and a real engine on a stand-in renderer, not in a browser. Job 4 with the real save package;
  a real-WebGPU check loads a real model under a moved parent.
- **Limits:** the viewer's lamp, shadow and floor values were picked by eye on one model, and a cascaded floor shows a
  faint horizon line. Saved scenes load one copy of a model per entity. The viewer's GPU check last ran before job 4's
  final rebase.

## Batch 19: margoengine (partly done)

The umbrella package.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Published on npm | PARKED: nothing is published; the preparation landed and the release waits for Scott | `f960906f9` (preparation) | none | LIM-137 |
| 2 | Unrequested Wasm in builds | DONE | `ff90665d1` | `margoengine/react/gltf-pro`, `/fbx`, `/animation`, `/materials` | none |

- **Bugs:** a page with one `Canvas` emitted 719,753 B of Draco and Basis Wasm it never asked for, because Vite copies a
  `new URL` file when it reads a module, before tree-shaking. Those bindings moved to their own entries. `FloatingOrigin`,
  `OctreeCloud` and `TilesRenderer` had published types that failed with `skipLibCheck` off
  (`tests/plugin-interface.test.js`).
- **Proved:** `npm run publish:rehearsal` against a stand-in registry on 127.0.0.1 that refuses every write: all 102
  tarballs audited, `npm install margoengine` in a clean project, all 502 entries imported and type-checked, every
  `npm create margo` template built. It ran at `f960906f9` only: not after job 2 or the batches since, so its counts and
  byte sizes are dated.
- **Limits:** `margoengine/game`, `/web` and `/viz` still hold `loadGLTF` and so still emit those files. The first release
  needs the npm organization, a public repository for provenance, and the release steps in docs/releasing.md.

## Batch 20: webgl

The WebGL2 preview path.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Picking on the preview path | DONE | `f8d478366` | `@margoengine/webgl/pick` | LIM-142 |
| 2 | Device restore on the preview path | DONE | `131d30ca8` | `/restore` | LIM-144 |
| 3 | Automatic escalation to the compatibility layer | DONE | `c1e669bcb` | `/auto` | LIM-146 |

- **Proved:** real WebGL2 in a browser (`packages/webgl/test/browser-check.mjs`). A real `WEBGL_lose_context` loss came back
  with identical pixels. Chromium only.
- **Limits:** core refuses `engine.pick` and `engine.rebootDevice` on other renderers before any plugin hook, so the
  plugins replace those methods on that one engine. Escalating replaces the canvas and runs `setup` twice, so listeners on
  the old element do not carry over. The React `Canvas` still ignores `onClick` and hover on the preview (known-bugs.md).
  Firefox and Safari have not been run.
- **Gate:** job 3's first version named the layer's package, and the layer's isolation test failed in `verify`. Nothing
  was pushed. The test stayed as it was, and the app now passes the import as `loadCompat`.
- **Size:** the preview is now 3,407 B gzip; `c8c3db7a6` brought its documented figures into line with the size record.

## Batch 21: webgl2-compat (partly done)

The WebGL2 compatibility layer.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | XR on the WebGL2 layer | DONE | `efa163dd5` | `@margoengine/webgl2-compat/xr` | LIM-151 |
| 2 | GPU routes for atomic kernels | SKIPPED: already on main as batch 1 job 3 (`88a2ae178`); `ScatterTiles` keeps the generic tiers | none | none | none |
| 3 | CPU compute tier without eval | DONE | `3c21e0044` | none (lazy chunk) | LIM-155 |
| 4 | Voxel path tracer route | DONE | `3303ffa9c` | none (route in `voxel-pathtracer`) | LIM-162 |
| 5 | Integrated GPU frame budget record | PARKED: a timed record needs a quiet machine and everything built | none | none | none |
| 6 | Smaller base download | DONE | `830b7f8ae` | none (lazy chunk) | LIM-164 |

- **Bugs:** `createComputePipelineAsync` on the layer waited for the link on the main thread, so a large kernel froze the
  page while ANGLE's Direct3D compiler ran. It now polls, and `compute-browser.mjs` checks it.
- **Proved:** job 1 with stand-ins for `navigator.xr`, `XRGPUBinding` and `XRWebGLLayer`: no pixel differs from native in
  either eye, Chromium, RTX A6000; no headset or phone has run it. Job 3: all 372 buffer-only corpus kernels leave the same
  memory as compiled ones, and every compute case reruns under a real policy header. Job 4: the suite passes on ANGLE
  Vulkan. Job 6: base 72,354 B to 70,274 B gzip, under the 73,000 B limit.
- **Limits:** on ANGLE Direct3D 11, the Windows default, `trace` had not compiled after 20 minutes, with the page drawing
  throughout. Diagnostic: the interpreter is 13.5 to 41.2 times slower than compiled kernels, and a 1500 x 1100 render
  took 6.4 s on the layer against 2.3 s native, both accepted differences (perf-history entries 72, 73). Neither timing has
  a committed script.

## Batch 22: geometry (part 1 of 2)

Curves, sampling and mesh tools in `@margoengine/geometry`. All CPU work, written from published methods.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | NURBS curves and surfaces | DONE | `55cf87e54` | `@margoengine/geometry/nurbs` | LIM-036 |
| 2 | Mesh surface sampler | DONE | `61bab5d9b` | `/sample` | LIM-037 |
| 3 | GPU-friendly mesh optimisation | DONE | `d99592c7b` | `/optimize` | LIM-038 |
| 4 | Bend geometry along a curve | DONE | `96dbf6b57` | `/flow` | LIM-040 |
| 5 | Extrusion UV generator | DONE | `0270a04d1` | none (`uvGenerator`, `worldUVs`) | LIM-041 |
| 6 | Seam-splitting MikkTSpace tangents | DONE | `e4e5653da` | none (`splitTangents`) | LIM-042 |
| 7 | More geometry utilities | DONE | `9afedda37` | none | LIM-043 |
| 8 | Constrained Delaunay triangulation | DONE | `3730d4921` | `/delaunay` | LIM-044 |

- **Proved:** CPU tests. Split tangents match Blender's corner by corner, above 0.9995 by dot product, on a mirrored sheet
  and an exported glTF. Delaunay decides every test with exact predicates.
- **Limits:** NURBS has no trimming, knot insertion or degree elevation. Split tangents follow the published grouping and
  are not a port of the reference library. `optimizeMesh` is proved on a simulated cache and a software depth buffer, with
  shuffled meshes going from 3 cache misses per triangle to under 0.8. The frame time it saves is not measured.

## Batch 23: geometry (part 2 of 2)

Polygon work, solids from profiles, and geometry made on the GPU.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | 2D polygon booleans and offsets | DONE | `7441d5a29` | `@margoengine/geometry/polygon` | LIM-046 |
| 2 | Sweep and loft | DONE | `5d47b153b` | `/sweep` | LIM-049 |
| 3 | Tessellate by edge length | DONE | `6d2178556` | `/tessellate` | LIM-051 |
| 4 | GPU geometry generation | DONE | `33b78ff77` | `/gpu` | LIM-052 |

- **Proved:** polygon results hold at scales from 2^-500 to 2^500, sweep and loft volumes match closed forms, and
  generated vertices match closed forms on a real GPU. The polygon offset method changed from one that took 59 s to one
  that takes 1.9 s, with the same result (perf-history entry 52).
- **Limits:** points go onto one grid of about 2^26 steps, so parts under two steps wide are dropped. A loft has no holes in
  its sections. GPU geometry is WebGPU only, and its speed is not measured.

## Batch 24: mesh-edit

Modelling tools in `@margoengine/mesh-edit`. All CPU work.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Exact robust booleans | DONE | `71346e1e2` | `@margoengine/mesh-edit/boolean-exact` | LIM-060 |
| 2 | Modifier stack | DONE | `288fced0b` | `/modifiers` | LIM-061 |
| 3 | Smooth and relax | DONE | `62e44bced` | none (in `/modeling`) | LIM-062 |
| 4 | Remeshing | DONE | `4c55d3146` | `/remesh` | LIM-063 |
| 5 | Sculpt brushes | DONE | `bc3ace8c4` | `/sculpt` | LIM-064 |
| 6 | Hole filling | DONE | `295364d56` | none (in `/modeling`) | LIM-065 |
| 7 | High-to-low baking | DONE | `44e675faa` | `/bake` | LIM-067 |
| 8 | Vertex groups and weight painting | DONE | `7644f7b45` | `/weights` | LIM-068 |

- **Bugs:** `assertSolid`'s volume check under- and overflowed at very small and very large scales in `boolean.ts`. It now
  measures at unit size (job 1's commit).
- **Proved:** CPU tests. Exact booleans give closed valid meshes for offsets down to one unit in the last place, turns down
  to 3e-16 radians and 60 seeded rotated pairs. Modifiers match closed-form volumes within 1e-9.
- **Limits:** see docs/limits.md for each. A boolean is measured at 0.8 s on 1,728 faces. Each sculpt `pick` tests every
  triangle. Baking takes one ray per texel, on the calling thread.
- **Gate:** jobs 7 and 8 were rebased after `verify`, and reran the package tests, hygiene and the API check, not `verify`.

## Batch 25: splines

More of `@margoengine/splines`. All CPU work.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Closest point on spline | DONE | `8521bbfa2` | `@margoengine/splines/closest` | LIM-070 |
| 2 | Stable frames and roll | DONE | `8521bbfa2` | `/frames` | LIM-070 |
| 3 | Place and deform along splines | DONE | `8521bbfa2` | `/mesh` | LIM-072 |
| 4 | Knot editing | DONE | `8521bbfa2` | `/knots` | LIM-071 |
| 5 | More curve types | DONE | `8521bbfa2` | none (root `kind`) | LIM-073 |
| 6 | Fit a spline to points | DONE | `8521bbfa2` | `/fit` | LIM-073 |

- **Proved:** CPU tests. Closest point is no farther than a 20,000-sample brute-force scan over 40 seeded queries. Every
  input point lands within the fit's tolerance.
- **Limits:** the closest-point search can confuse passes closer together than one sample. A fit can use a piece or two
  more than the fewest possible.
- **Slip that reached main:** this batch landed as one commit, not one per job, and `d90dee3ab`, the first half of the same
  work, reached `main` just before it without its own gate. `8521bbfa2` passed lint, hygiene and `verify`.

## Batch 26: lines

Additions to `@margoengine/lines`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Depth writing | DONE | `ce45393d0` | none (`depthWrite`) | LIM-076 |
| 2 | Lines in GPU picking | DONE | `5a1c13e18` | `@margoengine/lines/pick` | LIM-081 |
| 3 | Trails and ribbons | DONE | `8f4ccf8c8` | `/trail` | LIM-083 |
| 4 | Massive line batches | DONE | `400b052f7` | `/batch` | LIM-084 |
| 5 | Hidden-line display | DONE | `f09549b11` | `/hidden` | LIM-085 |
| 6 | Alpha to coverage on lines | DONE | `72aced94b` | none (`alphaToCoverage`) | LIM-086 |
| 7 | Filled helper shapes | DONE | `f18b96c16` | none (`solidHead`, `fillOpacity`) | LIM-088 |
| 8 | Caps on every dash | DONE | `09f074c66` | none (`dashCap`) | LIM-092 |

- **Proved:** real GPU, with browser checks at 1 and 4 samples. Two million segments draw as one draw at exact pixel and
  world widths.
- **Limits:** `LineBatch` has no timed speed number against `Line`. It has no joins, round caps, dashes, fog, clipping planes,
  depth writing or picking. A trail faces the camera, so it cannot lie flat on the ground.
- **Gate:** `c50f4be0d` removed claim rows a rebase had repeated on `main`. Job 7's growth moved `margoengine/viz` more than
  3% past the figure in docs/guides/kits.md, so the figure was updated to the measured 289,055 B, with the tolerance
  unchanged.

## Batch 27: points

Additions to `@margoengine/points`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Adaptive point size | DONE | `9881f6528` | none (in `/octree`) | LIM-096 |
| 2 | High-quality splat rendering | DONE | `9d4a927e1` | `@margoengine/points/surfels` | LIM-097 |
| 3 | Potree format reading | DONE | `c05054ab5` | `/potree` | LIM-100 |
| 4 | Octrees under a moving transform | DONE | `729afb2ef` | none (in `/octree`) | LIM-103 |
| 5 | Occlusion-aware GPU picking | DONE | `b60bef692` | `/pick` | LIM-106 |
| 6 | HDR point colours | DONE | `4e27459ee` | none (`colorFormat`) | LIM-108 |
| 7 | Mipmapped point textures | DONE | `1923549fc` | none (`mipmaps`) | LIM-110 |

- **Bugs:** `reorder` left normals in the old order while every other array moved (job 2's commit,
  `packages/points/tests/surfels.test.js`). `3772b0bc1` fixed an `EPERM` race in `tests/gpu-test-limit.test.js`.
- **Proved:** real GPU for size, surfels, picking, HDR and mips.
- **Limits:** Potree folders are written from the public format descriptions and have not been checked against files from
  PotreeConverter. `BROTLI` and older versions throw `unsupported`. Surfels are WebGPU only. No speed was measured.
- **Gate:** job 5's first push failed while its script reported success, because a pipe hid the exit code. Nothing reached
  `main` from it. Later scripts pass exit codes through pipes. Job 5 may carry a few of job 6's API records, because its
  push ran the API report against job 6's built output.

## Batch 28: bvh

Ray queries in `@margoengine/bvh`.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | GPU BVH traversal | DONE | `a2bad6f98` | `@margoengine/bvh/gpu` | LIM-121 |
| 2 | Scene-level BVH | DONE | `b3133e875` | `/scene` | LIM-122 |
| 3 | Raycast points and sprites | DONE | `cefe31618` | `/points` | LIM-123 |
| 4 | Mesh distance fields | DONE | `e7a273eae` | `/sdf` | LIM-125 |
| 5 | Inside test and mesh distance | DONE | `6caa52aad` | `/inside` | LIM-126 |
| 6 | GPU build for deforming meshes | DONE | `018853730` | `/gpu-build` | LIM-128 |
| 7 | Alpha-mask aware raycasts | DONE | `030cd54d6` | `/alpha` | LIM-130 |

- **Bugs:** caught before landing: a half-float rounding error in `toTexture`, `bakeSDF` accepting a resolution of 1, and a
  race in the bounds climb where a parent could read a child mid-write.
- **Proved:** real GPU for jobs 1, 4 and 6. 100,000 rays match the float64 CPU tree, and 123,200 rays at vertices and shared
  edges never leak. Scene answers match `intersectEngine` ray by ray over a city of 400 boxes.
- **Limits:** the GPU paths are WebGPU only and take float32 queries. The tree for job 1 is built on the CPU. The winding
  estimate stays under 0.03 at the default accuracy. Diagnostic only: 100,000 rays took 20 ms with upload and readback
  against 167 ms on the CPU. There is no quiet measurement yet.

## Batch 29: culling

Compute culling for every kind of drawable. The picture must equal core's, so culling changes only the work.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Many materials per batch | DONE | `b589d7449` | none (in `/parts`) | LIM-133 |
| 2 | Occlusion for core meshes | DONE | `d70e01d20` | none (root) | LIM-135 |
| 3 | GPU culling for glTF and materials meshes | DONE | `a4975febf` | `@margoengine/culling/models` | LIM-136 |
| 4 | Any geometry as occluder | DONE | `fcf680b13` | none (root) | LIM-138 |
| 5 | Tighter bounds | DONE | `c83f18da1` | none (root, `bounds: 'box'`) | LIM-139 |
| 6 | Per-cascade shadow culling | DONE | `70a238ecb` | `/shadows` | LIM-141 |
| 7 | LOD selection in the cull pass | DONE | `3283f76a9` | `/lod` | LIM-143 |
| 8 | Meshlet culling | DONE | `b04d74615` | `/meshlets` | LIM-145 |

- **Bugs:** caught before landing: job 8's perspective check read only one matrix element, which turned the cone test off
  when looking along x (regression test added). Job 5's bounds layout broke an existing test, so boxes now sit after the
  unchanged sphere layout.
- **Proved:** real GPU, 0 differing pixels against core. 900 rods under a plate draw 0 with `bounds: 'box'` against 900 by
  sphere. 1,509 core meshes match core alone with occlusion on.
- **Limits:** no timed number was taken for any job, and no speed is claimed. `CulledModels` covers instanced primitives only.
  `LodInstances` casts no shadows. `MeshletMesh` is one mesh with one matrix and no Hi-Z per cluster. On the WebGL2 layer the
  whole mesh or every instance draws. A long part behind a slanted surface stays in.
- **Decision reversed:** job 8 reverses the decision of 2026-10-31 that meshlets were out of scope for v1.0.0. docs/limits.md
  and the parity files were updated.

## Batch 30: lod

Level of detail end to end.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Full attributes in generated levels | DONE | `442118104` | none | LIM-147 |
| 2 | autoLOD for loaded models | DONE | `0d128071b` | none | LIM-150 |
| 3 | Dithered cross-fade between levels | DONE | `2c840ee70` | `@margoengine/lod/fade` | LIM-152 |
| 4 | Fuller imposters | DONE | `67c362b62` | none | LIM-154 |
| 5 | Streamed levels | DONE | `f4bca4d62` | `/stream` | LIM-157 |
| 6 | Moving sources in merged levels | DONE | `473aa772e` | none (`HierarchicalLOD.update`, `follow`) | LIM-158 |
| 7 | Selection outlines on imposters | DONE | `cfcc8993e` | none (`drawSelectionMask`) | LIM-161 |

- **Bugs:** job 1: wrong normals on imposter subassembly parts and far meshes (`packages/lod/test/auto.test.js`). Job 2:
  gltf-pro's quantized tangents failed the prepared geometry check, and tiny parts were lost from levels. Job 7: imposter
  pixels with alpha 0 could pass the dither, had no depth and showed through any wall; the `hidden` assertion in
  `packages/lod/test/imposter-outline-check.mjs` failed before the fix. That fix sits in a `feat` commit under the
  one-commit-per-job rule.
- **Proved:** real GPU checks, including a real multi-primitive textured model. Job 5 fetches levels over HTTP. Job 6 is CPU
  tests.
- **Limits:** skinned and morphed models are refused. Cross-fades are WebGPU only and instant to or from an imposter. Other
  GPUs have not run these, and the cost per cascade of imposter shadows is not measured. The imposter shadow bind group is
  rebuilt every frame.

## Batch 31: shader (part 1 of 2)

Node graphs gain what used to need hand-written WGSL: statements, the full compute model, lighting, deformation and extra
outputs.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Statement-level control flow | DONE | `c9010cf77` | none (root) | LIM-167 |
| 2 | Compute that writes textures | DONE | `5ad6bf901` | `@margoengine/shader/compute-texture` | LIM-170 |
| 3 | Full compute model | DONE | `182621112` | none (`ComputePass` options) | LIM-171 |
| 4 | Light, shadow and environment nodes | DONE | `6bb63f66b` | `/lighting` | LIM-173 |
| 5 | Node output in every pass | DONE | `b1ddc626c` | none (per-pass variants) | LIM-177 |
| 6 | Missing input nodes | DONE | `6b7de8319` | none (root) | LIM-186 |
| 7 | Skinning and morph nodes | DONE | `ba3c339bd` | `/deform` | LIM-188 |
| 8 | MRT outputs and scene pass nodes | DONE | this commit | `/pass` | LIM-192 |

- **Bugs:** jobs 1 to 3: a store the body made and did not return was lost, two writes in one body read inline so the second
  saw the first, and storage reads kept in a `let` survived statements that wrote the buffer
  (`packages/shader/test/control.test.js`, `compute-model.test.js`). Job 5: `instancedShader`'s normal anchor missed
  `margoNormal` (`packages/shader/test/passes.test.js`). Job 6: gltf-pro's `vertexInputs` dropped every `@builtin` field when it trimmed attributes
  (`packages/gltf-pro/tests/vertex-inputs.test.js`), and a mesh without tangents gave a NaN from `normalize(0)`. Caught
  before landing in job 8: `previous` was written after the draws, which gave zero velocity because uniforms upload ahead
  of the frame's commands, and the `color` output held display-encoded light on an encoded canvas. Undoing either fix fails
  `packages/shader/test/pass-check.mjs`. These fixes sit in `feat` commits under the one-commit-per-job rule.
- **Proved:** real GPU checks for all eight jobs, one `*-check.mjs` per job, with `browser-check.mjs` for job 1. Job 7
  compares each deformation with the same mesh deformed on the CPU, lit, under a slanted bone turn; the first draft turned
  bones about z only, which leaves a plane's normals alone, so its normal rows proved nothing until the pose changed. Job 8
  reads pixels back, and the expected velocity was worked out by hand. `instanceIndex` now works in a NodeMaterial, so its
  old refusal test moved to `globalId`: a feature change, not a loosened check.
- **Limits:** TAA velocity does not follow `positionNode` or `discard()`, and CPU raycasts and BVH picking see the bind pose
  of a mesh skinned in the graph. A mesh without tangents gets a fixed frame. Scene passes draw opaque and masked gltf-pro
  surfaces only, draw each model a second time, are single-sampled, and hold one capture hook per model, so a model cannot
  also be in `SSR`. `velocity()` covers camera motion unless a mesh passes its previous position.
- **Unmeasured:** no timing was taken in this batch, so the cost of 16 storage reads per vertex per pass against
  `@margoengine/animation`'s one compute pass, and of a scene pass's second draw, are unknown. `ScenePass` has no multi-view
  check, compute passes have no WebGL2 check, and no other GPU has run these.
- **Gate:** the whole-package budget in `shader.test.js` went from 12,500 to 18,500 B and the minimal NodeMaterial one from
  6,500 to 8,700 B over jobs 1 to 6, each raise documented in its commit (17,918 and 8,427 B measured at job 6); jobs 7 and 8
  are new entries. Job 6's first ship was stopped after a wrong `EXTRA_GPU`, and its next failed on quality duplicates, fixed
  by `packages/shared/white-texture.js`, now used by materials too. Job 8's first ship failed `verify` on a `ScenePass` with no
  `[Symbol.dispose]()`. Nothing failed reached `main`. A job whose last rebase
  moved `main` reran the package, API, quality, claims and quick GPU checks, not `verify`; jobs 7 and 8 were two.

## Batch 32: shader (part 2 of 2)

The node library reaches what shader authors reach for first, raw WGSL joins the rest of the engine, and compute graphs can use
the hardware's optional features.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Utility node library | DONE | `4fcb44bab` | `@margoengine/shader/utils` | LIM-198 |
| 2 | Worley and 4D noise on the GPU | DONE | `1bff33a73` | none (`/noise`) | LIM-200 |
| 3 | Raw meshes as full citizens | DONE | `b5a22bb16` | none (`/raw`, with `RawPicking`) | LIM-204 |
| 4 | Subgroups and f16 fast paths | DONE | this commit | `/subgroups` | LIM-206 |

- **Bugs:** all caught before landing, so each sits in its job's `feat` commit. Job 1: `parallaxUV` first took its derivatives
  inside the loop, which WGSL refuses as non-uniform (`parallaxRamp` in `packages/shader/test/utils-check.mjs`), and
  `equirectUV` gave `atan2(0, 0)` at the poles, now the middle column (`utils.test.js`). Job 3: a shadow pipeline that kept the
  material's back-face cull lost a caster the light saw from behind (`raw.test.js`, `shadow` in `raw-check.mjs`).
- **Proved:** a real GPU check per job. Job 1 runs the maths nodes over random inputs against formulas written out in
  JavaScript and reads surface nodes back against slopes worked out by hand. Job 2 compares each noise with its CPU twin and
  with a brute-force search of every cell within three, so the search radius is proved too. Job 3 reads pixels, buffers, picks
  and counters back; a normal turned into the wall darkens SSAO's open wall from 240 to 217, which shows the shader's normals
  are what SSAO reads. Job 4 runs one graph on two devices of one adapter, checks every operation against the lanes the hardware
  reported, and proves the one-lane form gives the same totals.
- **Limits:** raw meshes cast into `Shadows` only, a raw pick names the mesh and ignores `discard`, and SSR, GTAO, SSGI, TAA
  velocity and scene passes see only their depth. `frustumCulled` is on by default, so a vertex shader that moves points outside
  the sphere of `position` needs `bounds` or `frustumCulled: false`. Subgroups and f16 run in compute passes only, a pass using
  subgroups runs whole workgroups, and the f32 fallback keeps more precision than f16.
- **Unmeasured:** no timing was taken in this batch, so the speed of subgroup reductions and f16 against the plain forms is
  unknown and no speed is claimed. `voronoi3` walks all 27 cells per pixel; its cost is queued for the quiet speed pass. Only an
  RTX A6000 has run these, so subgroup sizes other than 32 are unproved in this package.
- **Gate:** the whole-package budget in `shader.test.js` stayed at 18,500 B and the minimal one at 8,700 B (18,012 and 8,485 B
  measured at job 4): jobs 1 and 4 are new entries, and job 4 added a few lines to the root (`f16` in the type tables, two
  compute inputs). The raw entry grew from
  10.1 to 13.2 kB, recorded with its reason in the size gate. `noise-check` split its passes when job 2 took it past the 8
  storage buffers a stage binds by default. Job 3's first ship failed `verify`: `tests/compilation-info-at-creation.test.js`
  wants the request a few lines from `createShaderModule`, and the new module call had pushed it away. Nothing failed reached
  `main`.

## Batch 38: gltf

The light glTF loader takes more files without growing its root.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Quantized and normalized accessors | DONE | `70e95b8e6` | `@margoengine/gltf/quantized` | LIM-163 |
| 2 | Base colour texture and alpha mask | DONE | `d9d654f4d` | `/textured` | LIM-166 |
| 3 | Meshopt buffers through an optional hook | DONE | `ffc22b634` | `/meshopt` | LIM-169 |
| 4 | GPU instancing extension | DONE | `aa51781c5` | `/instancing` | LIM-172 |
| 5 | Automatic upgrade to gltf-pro | DONE | `ad62cfe1d` | `/auto` | LIM-174 |
| 6 | Cameras and punctual lights as data | DONE | `52273e0a7` | `/scene-data` | LIM-175 |

- **Bugs:** caught before landing: a `BLEND` material with a texture was turned opaque, and after a device restore the mipmap
  cache kept a sampler from the old device. `0cdcd0be2` fixed the flaky USDZ timing test that failed job 4's `verify`.
- **Proved:** real GPU for jobs 2, 4 and 5, with one core draw for all instances and a refused file drawn through the real
  gltf-pro. Job 3 runs the real decoder. Jobs 1 and 6 are CPU tests.
- **Limits:** textures are WebGPU only, and a cut-out picks and casts as solid. Quantized files shrink on the wire, not on the
  GPU. `loadAuto` moves to gltf-pro only on an `unsupported` refusal, so a file over a light limit rejects with that limit. A
  file with no mesh is refused.
- **Gate:** job 2 failed the gate twice before it passed, on error messages with no fix text, then on a missing corpus entry
  and an unmarked fixed wait. Nothing failed reached `main`. After their last rebases jobs 2, 3 and 4 reran the package,
  corpus and claims tests, not `verify`.

## Batch 39: loaders (part 1 of 2)

More file formats, each in its own optional entry of `@margoengine/loaders`, so an app pays only for what it imports.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | NRRD volumes | DONE | `1d10590f7` | `@margoengine/loaders/nrrd` | LIM-178 |
| 2 | LDraw brick models | DONE | `a17a0cc13` | `/ldraw` | LIM-185 |
| 3 | 3MF textures and colour groups | DONE | `f8707ef1e` | `/threemf-materials` | LIM-187 |
| 4 | VTK XML | DONE | `87140c29b` | `/vtk-xml` | LIM-190 |
| 5 | Rhino 3DM through a caller-owned runtime | DONE | `798ea6038` | `/3dm` | LIM-193 |
| 6 | 3DS, LWO, AMF, MD2, PDB, TDS and KMZ | DONE | `4e3839d52` | `/3ds`, `/lwo`, `/amf`, `/md2`, `/pdb`, `/tds`, `/kmz` | LIM-195 |
| 7 | NURBS curves and surfaces | DONE | `92388e3ed` | `/nurbs` | LIM-196 |
| 8 | LAS, and LAZ through a hook | DONE | this commit | `/las` | LIM-197 |

- **Rule:** before job 5, `3f2ab19ee` replaced the no-CAD rule in `AGENTS.md` with Scott's ruling of 2026-11-06. No entry of the banned list changed, and the rule spells the kernel's name out, because its short form is one of those terms.
- **Bugs:** caught before landing, each with a test in the entry's own file: an LDraw `color` option of 16 or 24 recursed without end and is now a `range` error (`ldraw.test.js`), and NRRD read the wrong bytes from a pooled Node `Buffer` (`nrrd.test.js`).
- **Proved:** CPU tests on files the tests build, with known answers: exact rational circles and spheres for NURBS, handedness and seams for LWO, every point format for LAS. No job touched a GPU path; the loaders GPU test still ran before each push. `parse3MF` keeps its welded output, and its existing tests passed on the hooks job 3 added.
- **Limits:** no file from a real tool was read. Job 5 ran against a stand-in with rhino3dm's shape, because adding the real module needed a download Scott had not then approved. Job 8's LAZ path ran against a stand-in decompressor, though `@margoengine/points/laz` and a real USGS tile were already in the repository: the job missed them and built a second reader, which the LAZ section at the end of this record removed. TDS is the 3DS reader under its other name. 3DM reads saved render meshes only, and NURBS has no trims, topology or boolean operations. No speed was measured.
- **Gate:** job 2 failed `verify` once, when the helper's scratch build under `.lane` changed during the wall-budget scan. The scratch build was removed, and the job then passed. Nothing failed reached `main`.

## Batch 40: loaders (part 2 of 2)

The last two jobs on the loaders list, each in its own optional entry, and one fix to `verify` itself.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | OpenVDB sparse volumes | DONE, GAP OPEN | `5ad2181d1` | `@margoengine/loaders/vdb` | LIM-202 |
| 2 | MaterialX and Lottie | DONE, GAP OPEN | `2b8b9fea3` | `/materialx`, `/lottie` | LIM-205 |

- **Fix first:** `294a0c12c` made `check-wall-budgets` and `check-fixed-waits` read tracked files only. Both walked the disk, so a scratch build in a git-ignored folder failed `verify`, as it did in batch 39 job 2. On the tree at the fix, the list lost the 21 ignored `.lane` files and nothing else. Regression tests: the ignored-file tests in `tests/check-wall-budgets.test.js` and `tests/check-fixed-waits.test.js`, which failed without the fix.
- **Bugs:** one, caught before landing: a Lottie trim placed its cut by the curve parameter, not by length, so 25 to 75 percent of a straight line came out as 15.6 to 84.4. It now measures along the curve (`lottie.test.js`, "a trim measures length along a curve").
- **Proved:** CPU tests on files and documents the tests write. The MaterialX test compiles a graph with every lobe through `nodeMaterial()`, and one real ambientCG `.mtlx` kept outside the repository converted with only its opacity skipped. The loaders browser test draws a Lottie frame on a real canvas, checks two pixels and uploads it as a texture on real WebGPU.
- **Limits:** no `.vdb` from OpenVDB was read, and no public byte-level specification exists, so the reader and the test's writer share one reading of the format. NanoVDB is not read, which the job allowed. No Lottie file from After Effects was read, and no output was compared with a reference player or MaterialX viewer. The three gaps are in known-bugs.md. The format details came from the agent's general knowledge, with no other project's source open (clean-room.md, LF26, LF29, LF30, LF32).
- **Gate:** every commit passed `lint`, `hygiene`, `verify`, the loaders tests and both loaders browser tests before its push. Job 2 failed `verify` once, because Lottie carried its own hex colour parser; it now uses `hexColor` from `@margoengine/math/color`, and MaterialX uses `SRGBToLinear` from the same entry. Nothing failed reached `main`. No speed was measured.
## Batch 81: animation

Crowds of animated characters got cheaper and more varied, and baked simulations from DCC tools can now play as they stream.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Clones share GPU buffers | DONE | `1342d03dc` | none, `skeleton-utils` clone path | LIM-182 |
| 2 | GPU morph evaluation | DONE | `4bdfaed07` | `@margoengine/animation/morph-gpu` | LIM-189 |
| 3 | Animation LOD | DONE | `9b6ea1d16` | `/lod` | LIM-191 |
| 4 | Subclip and make-additive | DONE | `b04f2eea4` | `/clip-utils` | LIM-194 |
| 5 | Cheaper clone ticks | DONE | `1a61c13b0` | none, `cloneModel` and gltf-pro `adoptStaticBatches` | LIM-199 |
| 6 | Dual quaternion skinning | DONE | `8a7fce1de` | `/dqs` | LIM-201 |
| 7 | Bone-texture GPU instancing | DONE | `651cb62ae` | `/instanced-skin` | LIM-203 |
| 8 | Geometry cache playback | DONE | `b09c5e2d5` | `/geometry-cache` | LIM-207 |

- **Bugs:** a shared page held dead assets and arrays (`packages/animation/tests/batch.test.js`). A morph loop wrapped wrongly
  at an exact lap, off by 0.63 (`scripts/animation-morph-gpu-tests.js`, `tests/morph-gpu.test.js`). `PBRModel.compile()` read a
  root matrix not yet written as singular and compiled nothing (`packages/gltf-pro/tests/model-runs.test.js`). Caught before
  landing: unbounded thread counts, a cubic curve cut in its tangent (`tests/clip-utils.test.js`), a bad LOD README example,
  and in the geometry cache a reader that slept for good after a seek back, because the chunk on show counted against `ahead`,
  and a loop that waited for the network each lap (`tests/geometry-cache.test.js`).
- **Proved:** job 1 is bit for bit on a real GPU. Job 2 ran 5,040 GPU checks, worst 1.85e-6. Job 5 counts engine ticks. Job 6
  ran 28,512 GPU checks, worst 8.8e-7 on position and 2.1e-7 on normal, and a tube twisted 170 degrees keeps its radius at 1.000
  against 0.087 for the linear path. Job 7 ran the vertex stage's own function over 13,860 checks, worst 3.6e-7, and a member
  covers the same 829 pixels as the model, in one draw. Job 8 streamed 1,000 byte pieces to a GPU buffer over 18,240 checks,
  worst 7.5e-9, with one mesh swap as coverage grew from 1,437 to 5,525 pixels. Jobs 3 and 4 are CPU tests. All GPU runs were on
  the RTX A6000 only.
- **Limits:** no frame time was measured for jobs 2, 3, 6, 7 or 8, and each has a line in the quiet-pass list; `cloneModel`
  stays slower than three's clone (`docs/known-bugs.md`). LOD saves CPU only. Clip time is f32, and a cut curve is sampled at the
  clip's fps. Dual quaternions are for `Animation` only. A crowd has one material and no CPU culling, and its morph targets
  freeze at bake time. A geometry cache mixes on the CPU, uploads the whole mesh each changed frame, stops at 1,000,000 vertices
  a chunk, and rereads a URL from the start on a seek back and on each lap. No cache from a real DCC tool was played: the
  tests write their own files.
- **Gate:** job 1 failed once on a stale `llms-full.txt`, job 2 once on the heat-containment step, job 4 once on an error with
  no fix text, and job 5 on a stale anchor in `docs:links` and on kit sizes past `docs/guides/kits.md`, which were updated to the
  measured figures with the tolerance unchanged. Job 8 failed once on `tests/api-conventions.test.js`, because the player opened
  with `open` and not `attach`, and the API was renamed. Conflict markers once got amended into a local commit, and the landing stopped
  before the push. Nothing failed reached `main`. When `main` moved during a landing, the job reran its package and claims tests
  after the rebase, not `verify` or the GPU checks.
- **Slips:** the helper twice picked process ids by script name instead of by a recorded id; both were its own and no other
  lane was hit. It leaked 467 `tail` processes from a wait loop and killed them after checking their folder. It ran
  `npx` twice in a worktree against the rule, `--no-install` and `--version`, which fetched nothing. Job 5's commit carries an 845 line diff in
  `packages/gltf-pro/README.md` from normalized line endings.

## Batch 82: animator

Characters can now blend without a second pose, stay in step, fit any speed and direction, reach with the whole body, play by motion matching, use one clip for both sides, and lay a chain along a curve.

| # | Job | Status | Commit | New entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Inertialization | DONE | `be7fa7015` | `@margoengine/animator/inertialize` | LIM-209 |
| 2 | Sync groups and marker sync | DONE | `2d9790317` | `/sync` | LIM-210 |
| 3 | Stride, orientation and distance warping | DONE | `cdf0c53db` | `/warping` | LIM-211 |
| 4 | Full-body IK | DONE | `8d4394bf8` | `/fbik` | LIM-212 |
| 5 | Motion matching | DONE | `316cf17e2` | `/motion-matching` | LIM-213 |
| 6 | Runtime pose mirroring | DONE | `68258c7ca` | `/mirror` | LIM-214 |
| 7 | Spline IK | DONE | this commit | `/spline-ik` | LIM-215 |

- **Bugs:** none reached `main`; each was caught before landing and has a test in its job's file. A state's clip time used the new state's clock during a crossfade, so bones jumped (`tests/modern-animator-sync.test.js`). In full-body IK a leg as straight as the clip drew the pelvis down with no target at all, a far target threw the feet 2.7 m off the ground, and a straight arm's elbow bent along the reach, a 119 mm jump in a frame (`tests/modern-animator-fbik.test.js`). In spline IK a chain jumped 0.42 as the curve's end passed a joint, so the curve now carries on along its last tangent (`tests/modern-animator-spline-ik.test.js`). Motion matching's first weights kept a character idling while it moved, so the path now counts most (`tests/modern-animator-motion-matching.test.js`).
- **Proved:** on real files: inertialization and sync on Fox.glb's clips, full-body IK on RiggedFigure.glb (hand within 2 mm of a point for 30 frames, both feet within 2 mm of their animated steps), mirroring on Fox.glb and RiggedFigure.glb (within twice each file's own rest asymmetry), spline IK on Fox.glb's tail during its walk, and motion matching picking Fox.glb's Survey, Walk and Run by speed. On stand-ins: warping holds a planted foot under 2 mm from 0.3 to 1.4 m/s and at 45, 60 and 90 degrees, under 6 mm at 3 m/s, against over 100 mm without it. Motion matching's search equals comparing every row on 600 random queries, and across 6 speed changes no joint moves over 150 mm a frame, against 250 mm with the blend off. All CPU tests.
- **Limits:** LIM-211 and LIM-213 read PROVEN (STAND-IN): warping's foot figures are on a stand-in walk, and no motion capture set has been run through motion matching, whose Fox.glb clips play in place with speeds labelled by hand. No frame time was measured for jobs 3 to 7, and jobs 4, 5 and 7 have quiet-pass lines. Inertialization's speed is a shared-machine diagnostic: 14.5 to 17.1 us a frame on 58 bones during a fade, against 16.5 to 21.5 for a crossfade. Full-body IK's balance is static and has no memory of the last frame. `rigging` already peers on `animator`, so `animator` cannot import `solvePoseIK` or `solveFABRIK`: full-body IK finishes limbs with `solveTwoBoneIK`, and its torso solve is new. Spline IK reuses `Spline` and `SplineFrames`, and `@margoengine/splines` joined the external list in `scripts/build-modern.js`, so it is not bundled into `animator`.
- **Gate:** job 1 failed once in its package test, on a relative path to Fox.glb from the package folder. Jobs 1 and 2 failed once on `quality api`, on error messages with no fix, and landed in one push. Jobs 6 and 7 failed once on `tests/package-lock-sync.test.js`, because the lock file lacked the new splines peer, and landed in one push. Nothing failed reached `main`. When `main` moved during a landing, the job reran its package and claims tests after the rebase, not `verify`.
- **Slips:** the helper edited no tracked file during a landing, after the first drafts moved to `.lane/next/`. It wrote a test fixture wrongly in job 6, which a failing test showed and the fixture was fixed; the code did not change. A chained command ran job 7's docs script during a stopped rebase; the rebase was aborted and the step redone, and nothing from it landed. It ran `git stash list` once in the worktree, read only, against the rule that bars `git stash` there.

## Real files: every loader on a file from a real tool

Batch 39 proved its formats on files the tests built. A file built by the same mind as the reader repeats its mistakes, so Scott approved downloading a public file for every loader (2026-11-06).

| # | Job | Status | Commit | Claim |
| --- | --- | --- | --- | --- |
| 1 | Manifest of 82 files, opt-in runner, GPU pictures | DONE | this commit | LIM-208 |
| 2 | Ten bugs the files found | DONE | one `fix` commit each, just before this one | LIM-208 |

- **Bugs:** 10 fixes, in `docs/known-bugs.md` under Fixed 2026-11-06. Two were in Margo's own LAZ decoder, whose test encoder held the same mistakes, so its round trips could never see them: only real files could. Two were in `parse3DM`, whose stand-in lacked what the real runtime has. One test had pinned a wrong value: G-code filament, 9 where the net length is 6.
- **Proved:** 82 files, 82 passed: 76 read and checked, 6 refused as documented. Every file with more than one point of geometry was drawn on the GPU with no blank picture, 65 pictures, 2 of them through `/render`. LAZ records equal laz-perf byte for byte in formats 3, 6 and 8, and equal their LAS twins in format 3. NURBS curves equal rhino3dm, difference 0, on 3 curves. Each regression test was run against the old source and failed.
- **Limits:** one or two files a format is a sample, not a survey. Variants with no real file, and every refusal, are in `docs/limits.md`. LASzip 1.x's compressor is refused. The licences are mostly BSD, MIT and Apache files from test folders, treated as explicit permission; one, McNeel's `RhinoLogo.3dm`, has only a sample-file statement. The third-party runtimes stayed in a scratch folder, through the caller-owned hooks, with their source unread.
- **Gate:** lint, hygiene, verify, the loaders and points tests and `tests/claims-file.test.js`, from one script gated on exit codes. The run itself is opt-in, as it needs the network and a GPU.

## Lane G: closing the audit's gaps

An audit of the finished batches against their job text listed 70 gaps for the Hacker News launch. Lane G closes them one at a time, worst first (Scott, 2026-11-06). Gaps that need a device no machine here has stay parked in `docs/known-bugs.md`.

| Gap | Job | Status | Commit | Claim |
| --- | --- | --- | --- | --- |
| C20 | Claims read PROVEN on stand-in proof: seven now read PROVEN (STAND-IN) and say what stood in; LIM-193 and LIM-197 name the real run in LIM-208 | DONE | `28bf8fb66` | LIM-091, 109, 120, 129, 134, 149, 151, 193, 197 |
| B9 | MeshBridge.sync writes through TransformWriter, one write per group for each run of changed rows | DONE | `e1daa8a3e` | - |
| B17 | engine.onFrame callbacks run on a headless stage's step | DONE | this commit | - |

## LAZ: one LAS reader, and every point format on a real file

Batch 39 built a second LAS reader with a hook and said no decoder existed, while `@margoengine/points/laz` and a real USGS tile sat in the repository. This job (Lane B item 12a) made one reader of the two, closed what was really left of LAZ, and corrected the false statements.

| # | Job | Status | Commit | Entry | Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | `loaders/las` over `points/las`, `.laz` with no hook, decoder lazy | DONE | this commit | `/las` | LIM-197 |
| 2 | USGS tile through `loaders/las`, every field | DONE | this commit | `/las` | LIM-197 |
| 3 | Waveform formats 4, 5, 9, 10, compressors 0 and 1, `lasWaveform`, real files for every format | DONE | this commit | `points/las`, `points/laz` | LIM-197, LIM-208 |
| 4 | False statements corrected | DONE | this commit | docs | LIM-197 |

- **Bugs:** 5 fixes, in `docs/known-bugs.md` under Fixed 2026-11-06. The worst: formats 7 to 10 failed on any file whose scanner channel switches, a mistake the test encoder shared. LASzip's behaviour there is not in the specification; it was found by comparing with LASzip as a black box, with no source read. A real file with a wrong header box also lost 16 m of precision, found only because the real-files check compares bounds.
- **Proved:** every record and field equal to LASzip and lazrs: format 0 `point10.laz`, 1 `point-time.laz`, 2 `point-color.laz`, 3 `point-time-color.laz`, 6 the USGS tile, 7 `simple.copc.laz`, 8 `append-bug.laz`, 10 `fullwave.laz` (a real YellowScan file). Real LAS: formats 0 to 4, each LAZ of formats 0 to 3 giving the same cloud as its LAS twin. The real-files run has 91 rows; its 22 LAS and LAZ rows passed, and records equal laz-perf in formats 0, 1, 2, 3, 6, 7, 8. `lasWaveform` read all 10,750 waves of the real `fullwave.wdp`, the peak at the point's location in 7,167; the others are later returns of the same pulse. A one-off local file of 110,000 points in 3 chunks with channels, written by LASzip, also matched.
- **Limits:** formats 4, 5 and 9 and the channel samples are real points that LASzip compressed, because no public file was found: LASzip wrote them, Margo did not. Compressor 0, compressor 1 with version 2 items and chunk size 0 are stand-in proof, on the test encoder, because no tool here writes them. LAZ item version 1 stays refused: neither the LAZ specification 1.4 R1 nor the LASzip paper describes it, and real samples of it exist. The LAStools sample files matched too but have no clear licence, so they are not committed.
- **Unmeasured:** no speed was measured, and no file larger than the 697,721 points of `las_with_several_extra_byte_bloc.laz` was read.
- **Gate:** lint, hygiene, verify, the points and loaders tests and browser tests and `tests/claims-file.test.js`, the push from one script gated on exit codes. Verify failed three times first, each fixed before the push: the `sizes` and `duplicates` gates, which led to dropping two value re-exports from `loaders/las` and holding `points/las` as a base and a lazy part; `tests/dist-dynamic-imports.test.js`, as `points/copc` imported the decoder statically, now `import()`; and the `points/copc` budget after that move. Budgets of `points/las`, `/laz` and `/copc` grew, with the reason in `scripts/quality/baselines/sizes.json` and the figures in `docs/limits.md`. Nothing failed reached `main`.
| C20 | Claims read PROVEN on stand-in proof: seven now read PROVEN (STAND-IN) and say what stood in; LIM-193 and LIM-197 name the real run in LIM-208 | DONE | `e4d931a4c` | LIM-091, 109, 120, 129, 134, 149, 151, 193, 197 |
| B8 | loadAuto moves on a limit only the light loader has, and gltf-pro keeps a file's instances | DONE | this commit | LIM-174 |
