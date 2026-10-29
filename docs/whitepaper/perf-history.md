# Performance history: losses, causes and fixes

This page lists every performance loss and every significant bug that Margo's checks caught and that was then fixed.
Each entry gives:

- **Loss:** what was measured first.
- **Cause:** why it happened, and the trade-off.
- **Fix:** the commit.
- **After:** the number once fixed.
- **Rerun:** the command that repeats the measurement or check.
- **Guard:** the test or check that now stops it coming back.

Rules for this page:

- Every number is quoted from a committed result file or a commit message, and its source is named. Commit hashes are
  those on `main`.
- Where a number was never recorded, the entry says **not recorded** and goes on the
  [re-measure list](#re-measure-in-the-quiet-machine-run) below. No number here is estimated.
- **Diagnostic** marks a number taken on a busy machine, or in a run its own record calls a smoke or diagnostic run.
  Such numbers show a direction, not engine performance.

Machines named in the records:

- an Intel Core Ultra 7 258V laptop with an Intel Arc 140V GPU;
- an NVIDIA RTX A6000 desktop.

Both ran Windows 11 and Edge 155 ([claims.md](claims.md) has the full setup). Losses that are still open are listed in
[Open losses](#open-losses), which links to [known-bugs.md](../known-bugs.md).

## Rendering and CPU speed

### 1. Shadow casters: one draw per caster per cascade

- **Loss:** CPU time per frame grew linearly with the number of casters.
  - 7.2 ms at 1,000 casters; 121 ms at 10,000 (diagnostic).
  - Measured at `f639b02e` with `npm run bench`, shadows scene.
  - Source: the `e5737135` commit message, which calls the run a smoke run with another session running at the same
    time.
  - Machine: not recorded.
- **Cause:** every core-mesh caster was its own draw, with its own uniform upload, in each of the 4 cascades. A moving
  camera redraws the cached shadow map every frame.
- **Trade-off:**
  - Only groups of 8 or more plain casters that share one geometry are batched. Casters with an alpha mask,
    displacement, instances, section planes or line lists keep their own draws.
  - The shadows entry grows 457 B gzip.
- **Fix:** `e5737135` perf(shadows): batch core casters that share a geometry into one instanced draw.
- **After:** same run and source (diagnostic).

  | Casters | CPU ms per frame | GPU ms per frame |
  | --- | --- | --- |
  | 400 | 1.6 -> 0.38 | not recorded |
  | 1,000 | 7.2 -> 0.87 | 1.09 -> 0.43 |
  | 5,000 | 59 -> 4.7 | not recorded |
  | 10,000 | 121 -> 11 | 8.9 -> 1.3 |

  Shadow coverage in the screenshots is the same before and after.
- **Rerun:** `npm run bench:scaling` (shadows cases at 400, 5,000 and 10,000 casters in `bench/scenes/catalog.js`).
- **Guard:** `packages/shadows/test/batch.test.js`. 1,000 casters make 4 instanced draws (one per cascade) and one
  matrix upload; groups under 8 stay separate; hidden casters and disposal are covered.

### 2. Back-face culling in core (option B)

- **Loss:** core never culled back faces in the pipeline. A shader `discard` handled single-sided materials instead,
  which turns off early depth testing.
  - GPU ms per frame for boxes 1k / 10k / 50k, from `examples/package-benchmarks/results/vs-threejs-boxes-diag2.json`
    (committed in `ca8b9793`; diagnostic, busy machine; Arc 140V, Edge 155, 1280x720, 4x MSAA):
    - Margo double-sided: 1.67 / 5.38 / 14.51
    - Margo single-sided: 1.15 / 3.80 / 9.89
  - The first smoke test recorded no timings.
- **Cause:** [boxes-vs-threejs.md](boxes-vs-threejs.md) splits the cost into two parts:
  - the `discard` instruction alone: 1.7x / 1.7x / 1.4x;
  - rasterizing back faces: another 1.6x / 1.9x / 1.7x.

  The comparison harness also had a fairness bug: it drew double-sided Margo against single-sided three.js. `ca8b9793`
  fixed that.
- **Trade-off:**
  - Core + stage grew 19,577 -> 19,793 B gzip (+216).
  - Only batches where every drawn instance is single-sided and unmirrored are culled. Package shader variants keep the
    `discard`.
- **Fix:**
  - `5ab3ce95` Core: per-batch back-face culling (option B).
  - `e40e3bec` proof that culling changes no pixel.
  - `75659a9d` re-run.
- **After:** `margo+nocull` -> `margo`, from `examples/package-benchmarks/results/vs-threejs-boxes-pairs.json` and
  [boxes-vs-threejs.md](boxes-vs-threejs.md) (diagnostic, busy machine, Arc 140V):

  | Boxes | GPU ms per frame | FPS |
  | --- | --- | --- |
  | 1k | 1.64 -> 0.46 (3.6x) | 448 -> 788 |
  | 10k | 5.00 -> 1.80 (2.8x) | 189 -> 326 |
  | 50k | 10.87 -> 6.00 (1.8x) | 75 -> 101 |
  | 10k moving | 5.30 -> 1.79 (3.0x) | 145 -> 155 |

  [claims.md](claims.md) (PKG-109) makes no claim from these numbers.
- **Rerun:**
  - Pixels: `node examples/package-benchmarks/cad/cull-pixels.mjs` under the GPU lock. It recorded 0 of 153,600 pixels
    different in 13 steps.
  - Speed: the comparison harness was removed under the clean-room rule. Re-running it needs a checkout from before
    2026-10-24.
- **Guard:**
  - `tests/core-material-setters.test.js`: a geometry batch draws back-culled only while every drawn instance is
    single-sided and unmirrored.
  - `examples/package-benchmarks/cad/cull-pixels.mjs`.

### 3. CAD, 10k single-sided parts

- **Loss:** 4.04 ms GPU per frame without culling.
  - Source: `examples/package-benchmarks/results/vs-threejs-cad-pairs.json`, `cad-10000`, `margo+nocull`.
  - Diagnostic, busy machine; Arc 140V, Edge 155.
- **Cause:** the same as entry 2.
- **Fix:** `5ab3ce95`.
- **After:** 2.15 ms (same file, `margo`; diagnostic).
  - At 50k parts there is no gain: 11.44 -> 12.00 ms, because that scene is geometry-bound.
  - Double-sided CAD scenes are unchanged.
- **Rerun and guard:** as entry 2.

### 4. Retired (2026-10-29)

The code this entry measured is no longer part of Margo Engine, so its cases are not run. Removing a package is not a speed change.

### 5. gltf-pro plain materials lost early depth testing again

- **Loss:** on a full-screen DamagedHelmet, 0.852 ms GPU per frame with the unreachable `discard`, against 0.524 ms
  without it.
  - Source: `examples/package-benchmarks/results/pipeline-toggles.json` (medians); Arc 140V, Edge.
  - The pipeline consolidation brought the 0.852 ms path back. That was found by proof triage and reading the code, not
    by a new timing.
- **Cause:** the consolidation set up the face and alpha tests at compile time only for instanced and MASK materials.
  Every plain opaque or blended material therefore compiled with a runtime `discard` that can never run, and that
  turned off early depth testing.
- **Fix:** `b78a5ab4` perf(gltf-pro): plain materials compile without discard again.
- **After:** **not recorded.** The fix restores the 0.524 ms configuration, but no timing was taken after it.
- **Rerun:** `node examples/package-benchmarks/pipeline-toggles/toggle.mjs gpu`.
- **Guard:** the GPU-call proofs `oit-detached`, `gltf-pro-lighting-hooks` and `materials-uv-transform`
  (`npm run proofs -- --current`). They record the compile-time constants of each pipeline.

### 6. VFX, one million particles

- **Loss:** 5.00 ms GPU per frame to simulate and draw 1M particles at 1x MSAA, and 5.12 ms at 4x.
  - Source: the `763c88fb` commit message and `examples/package-benchmarks/results/vfx-gpu-final-island.json`.
  - Arc 140V, Edge 155, AC power.
- **Cause:** a four-vertex quad per particle, every particle drawn, and full-buffer updates.
- **Fix:** `763c88fb` vfx: halve particle GPU time. It draws one triangle per billboard, culls particles outside the
  view in compute, and splits particle data so per-frame updates write less.
- **Trade-off:** the vfx base entry grew from 5,311 to 5,709 B min+gzip.
- **After:** 2.46 ms (1x) and 2.40 ms (4x), same sources.
- **Rerun:** `node examples/package-benchmarks/vfx-gpu.mjs --a=test-results/vfx-base --b=packages/vfx/dist`.
- **Guard:** `packages/vfx/test/traces.js` with its `fixtures/traces.json`.

### 7. Voxel sandbox world fill

- **Loss:** at render distance 16 the world took 8.8–9.2 s to fill (`71f5c376` message; RTX A6000, quiet-gated).
- **Cause:** while the world filled, the sandbox joined only 0.5 ms of chunks per frame. That caused about 20,433
  remeshes for 2,435 meshed chunks.
- **Trade-off:** fill frames cost more (p95 11.1 ms at distance 16).
- **Fix:** `71f5c376` perf(voxel-sandbox): render distance 16 fills in 3.6 s.
- **After:** 3.59–3.67 s over 3 loads; render distance 8 takes 1.06–1.22 s (was 2.45–2.50 s).
  - Sources: `examples/voxel-sandbox/README.md` and `examples/package-benchmarks/results/voxel-sandbox-bench.json`.
- **Rerun:** `node examples/voxel-sandbox/bench.mjs --distances=8,16 --loads=3`.
- **Guard:** none beyond the benchmark.

### 8. Kernel snapshot compare at 100k entities

- **Loss:** 3.65 ms per frame (`aa9e8eb4` message, "in its benchmark").
  - Machine and result file: not recorded.
- **Cause:** each mutable snapshot lane was compared one value at a time.
- **Fix:** `aa9e8eb4` perf(kernel): SIMD snapshot compare and unchecked column accessors. The embedded Wasm went from
  7,092 to 4,580 base64 characters.
- **After:** 2.94 ms (same message). Machine not recorded.
- **Rerun:** not recorded.
- **Guard:** not recorded beyond the kernel's own tests.

### 9. Packages loading code they never use (static leaks)

- **Loss:** startup gzip of each entry, including what bundlers pulled in:
  - gltf-pro 525,254 B;
  - materials 577,486 B;
  - fbx/worker 553,075 B.

  Source: `120b8361` message.
- **Cause:** gltf-pro imported two helpers statically from the decoders root while also loading decoders on demand. So
  bundlers folded all of decoders into every gltf-pro user's startup.
- **Fix:** `120b8361` perf: entries load only what they import (static leaks 78 -> 28). New small entries were added
  with the same names as their roots, such as `decoders/texture` and `gltf-pro/coordinates`.
- **After:** gltf-pro 49,465 B, materials 102,178 B, fbx/worker 44,092 B (same message).
- **Rerun:** `npm run quality` (sizes gate).
- **Guard:** the leak items in `scripts/quality/baselines/sizes.json`, checked by `scripts/quality-gate.mjs` in CI.

### 21. Materials meshes: one render pass per mesh

- **Loss:** 10,000 `@margoengine/materials` meshes (`UnlitMaterial`, the speed-matrix scene `p-unlit`) cost **166.2 ms**
  of CPU per frame in Margo against **6.3 ms** in three.js WebGL, with matching images. Diagnostic, busy machine
  (RTX A6000, Edge 156 headless): `npm run bench -- parity --cases=p-unlit --engines=margo,three-webgl-parity --runs=3
  --no-gate` on `1ff80aff`, run `20261025-232359-1ff80aff-dev` (`benchmarks/runs/`, not committed). The first speed-matrix
  ledger run records its own first numbers; this entry keeps these.
- **Cause:** every materials mesh is a gltf-pro `PBRModel`, and each model's `draw()` began and ended its own render
  pass. A wrapper around the WebGPU calls counted 620,124 `beginRenderPass` calls in 62 frames, one per mesh per
  frame; each pass stores and reloads the 4x multisampled colour and depth. The materials package's comment said "one
  pass per engine", which was the intent.
- **Fix:** `PBRDrawRun` in gltf-pro: draws given the same run continue one pass (a blended primitive still ends the
  pass around itself); the materials queue passes one run per frame. The queue's per-frame staleness check also
  allocated two closures per mesh; it is now a loop.
- **After (diagnostic):** 166 -> about 80-97 ms per frame (profile script, busy machine, 3 runs 93.6, 91.2, 97.3 ms;
  the bench tool could not take the GPU lock for hours). Still 13-15 times three.js: the cost left is per-mesh work
  (one `queue.writeBuffer`, three `setBindGroup`, `setPipeline` and two buffer binds per mesh, plus about 3 us of
  JavaScript per mesh), then listed in known-bugs.md; entries 22 and 23 have what came next.
- **Rerun:** `npm run bench -- parity --cases=p-unlit --engines=margo,three-webgl-parity --runs=3`.
- **Guard:** `packages/materials/tests/shared-pass.test.js` (10 meshes, one pass; a blended mesh keeps its own).

### 22. Materials meshes: per-mesh draw work

- **Loss:** after entry 21, 10,000 `@margoengine/materials` meshes still cost about 80-97 ms of CPU per frame
  (profile script) against three.js WebGL's 6.3 ms (`p-unlit`; entry 21 keeps the 166.2 ms first result). The other
  materials scenes of the speed matrix were as far behind ([perf-vs-threejs.md](perf-vs-threejs.md), first run).
- **Causes, measured** (CPU profiles of the bench page and of a mock-device frame of the same meshes; wrapper counts of
  WebGPU calls):
  1. a `queue.writeBuffer` per mesh, 10,000 a frame (about 8 ms);
  2. each draw derived its shader text, searched a pipeline history and ran every shading and lighting callback, and
     every mesh owned its own pipelines (10,001 shader modules at build);
  3. each draw's uniform held the camera rows, so a moving camera changed every mesh's block: about 10 MB uploaded per
     frame, and compared and copied on the CPU;
  4. a draw call per mesh: `setPipeline`, three `setBindGroup`, two buffer binds and `drawIndexed`, plus the `draw()`
     set-up for every mesh;
  5. per-frame text work: a regular expression over the core shader per draw (`sectionState`), the physical-maps
     specialization (28% of the 400-sphere physical frame) and a scan of each finished shader;
  6. the materials queue walked every mesh once for its phase check and again to draw it, and found each draw's batch
     through a `Map`;
  7. a blended mesh ended and began the render pass around itself, so 2,000 transparent meshes were 2,000 passes.
- **Fixes** (one commit each): a per-device uniform arena, one upload per frame (`uniform-arena.ts`); one derivation per
  material record per frame and device-wide pipelines (`draw-memo.ts`); a 192-byte view block shared by every draw of a
  view (`view-uniform.ts`); a run draws meshes of one material record and geometry as one instanced draw, rows written
  only where a mesh moved (`draw-batch.ts`), through a short path in `draw()`; caches for the section binding, the
  physical-maps shader and the model-row scan; the phase check beside each draw; the batch kept on its derivation; a
  run's blended draws continue its pass.
- **Image:** the same picture: SSIM and delta E against three.js as in the first run for every scene (for example
  `p-unlit` 0.997 / 0.34, `p-transparency` 0.983 / 2.44, `p-blending` 1 / 0).
- **After (diagnostic, busy machine, RTX A6000, 3 runs each; runs `20261026-071108`, `20261026-073905` and
  `20261026-080031`, rows in [perf-vs-threejs.md](perf-vs-threejs.md)):** Margo against the faster three.js backend,
  CPU ms per frame.

  | Scene | Margo | three.js |
  | --- | --- | --- |
  | `p-unlit` (10,000) | 4.94 | 6.52 |
  | `p-lambert` | 7.37 | 7.56 |
  | `p-phong` | 5.22 | 7.65 |
  | `p-toon` | 4.60 | 7.53 |
  | `p-matcap` | 4.83 | 7.29 |
  | `p-normal-material` | 3.31 | 7.02 |
  | `p-depth-material` | 3.37 | 5.74 |
  | `p-double-sided` | 4.37 | 7.20 |
  | `p-alpha-test` | 1.17 | 2.58 |
  | `p-physical` | 0.29 | 0.39 |
  | `p-clipping` | 6.60 | 9.00 |
  | `p-attributes` | 4.70 | 8.20 |
  | `p-maps` | 0.27 | 0.77 |
  | `p-transmission` | 0.46 | 0.98 |
  | `p-shadow-catcher` | 0.93 | 1.67 |
  | `p-wireframe` | 1.48 | 0.66 (slower) |
  | `p-transparency` (2,000) | 4.08 (was 12.5 before the pass fix) | 1.70 (slower) |
  | `p-blending` (2,000) | 5.75 (was 16.7) | 1.33 (slower) |
  | `p-uv-transform` (4,096 materials) | 63.6 | 6.31 (slower) |

  Entry 23 fixed three of the four slower scenes; `p-uv-transform` is still open.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity
  --cases=p-unlit,p-lambert,p-phong,p-toon,p-matcap,p-normal-material,p-depth-material,p-double-sided,p-alpha-test,p-physical,p-clipping,p-attributes,p-maps,p-transmission,p-shadow-catcher,p-wireframe,p-transparency,p-blending,p-uv-transform
  --runs=3`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `packages/materials/tests/shared-derivation.test.js` (one derivation, one instanced draw for 20 meshes,
  instance rows in mesh order, a moved mesh uploads 96 bytes, a moving camera 192), `shared-pass.test.js` (one pass,
  blended meshes included; a phase change draws each mesh once, in its new phase), `physical-maps-cache.test.js`,
  `tests/gltf-pro-uniform-writers.test.js`, `packages/gltf-pro/tests/views.test.js` (two views keep their cameras at
  submit).

### 23. Materials meshes: wireframe, blended and one-material-each scenes

- **Loss:** after entry 22, four materials scenes of the speed matrix were still slower than three.js (CPU ms per
  frame against the faster three.js backend): `p-uv-transform` 63.6 against 6.31, `p-blending` 5.75 against 1.33,
  `p-transparency` 4.08 against 1.70, `p-wireframe` 1.48 against 0.66.
- **Causes, measured** (mock-device CPU profiles of each scene, an unminified build for line ticks; GPU runs):
  1. wireframe meshes never joined an instanced batch: 512 spheres were 512 draws;
  2. blended meshes never batched (they draw back to front), so 2,000 transparent boxes or additive quads were 2,000
     draws of about 2 us of JavaScript each;
  3. a derivation was reused only within a frame: each of the 4,096 `p-uv-transform` materials composed its shader,
     feature key and pipeline key again every frame, and derived twice per mesh (a batch-only pass, then its own draw);
  4. materials records (one per Material) redefined gltf-pro's data properties as accessors with new closures each, so
     every record had a dictionary shape of its own and gltf-pro's reads of 4,096 records missed every inline cache;
  5. every draw inverted its node matrix again, moved or not;
  6. batching wireframes cost GPU time (0.73 to 0.85 ms): a closed mesh listed every shared edge twice (a b, b c, c a
     per triangle), twice the vertex and line work for the same picture.
- **Fixes:** wireframe meshes batch as line-list instanced draws; a blended draw joins the batch drawn last (so a batch
  is a run of consecutive draws, which rasterize in order), and draws of materials that differ only in base colour fold
  into it with their colours as instance tints, after a check that the pipelines and group 2 bindings are the same and
  that the shader reads the base colour only as the vertex colour's factor; a derivation keeps its shader and pipeline
  across frames while the record's `shading.shaderRevision` (new, from materials: the inputs of `shader()` and
  `lit()`), structure, shading object and render state are unchanged and no lighting effect patches the shader (rows
  and bindings are still read every frame), and a kept pipeline makes the first derivation of a frame complete;
  records are made in one `defineProperties` call from shared getters; the normal rows are kept per draw while its
  matrix is the same; the edge list holds each edge once; the blended sort compares squared distances.
- **Image:** the same SSIM and delta E against three.js as before: `p-transparency` 0.983 / 2.44, `p-blending` 1 / 0,
  `p-wireframe` 0.988 / 0.9, `p-uv-transform` 0.994 / 1.09.
- **After (diagnostic, busy machine, RTX A6000; runs `20261026-105135` (5 runs) and, for `p-wireframe` after the
  edge fix, `20261026-110621` (5 runs); rows in [perf-vs-threejs.md](perf-vs-threejs.md)):** Margo against the faster
  three.js backend, CPU / GPU ms per frame.

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-transparency` (2,000) | 4.08 / 0.11 | 0.90 / 0.05 | 1.65 / 0.62 (WebGPU) |
  | `p-blending` (2,000) | 5.75 / 0.94 | 1.30 / 0.07 | 1.38 / 0.57 (WebGL) |
  | `p-wireframe` (512) | 1.48 / 0.73 | 0.33 / 0.51 | 0.66 / 0.71 (WebGL) |
  | `p-uv-transform` (4,096 materials) | 63.6 / 4.60 | 41.7 / 4.64 (36.2 in run `20261026-104231`) | 6.00 / 6.41 (WebGL), slower |

  `p-blending`'s CPU is within the run's spread of three.js (the run is marked invalid for spread); its GPU time is an
  eighth. `p-uv-transform` was still about 7 times three.js; entry 24 fixed it.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity
  --cases=p-uv-transform,p-blending,p-transparency,p-wireframe --runs=5`, then
  `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `packages/materials/tests/steady-batches.test.js` (wireframe meshes as one line-list instanced draw;
  consecutive blended meshes as one draw, back to front; colour-only materials folded with their tints in sort order and
  live edits; another blending ends the batch; a steady material composes no shader while its bindings run and a flat
  shading edit composes one; record copies), `packages/gltf-pro/tests/wireframe.test.js` (each edge once).

### 24. Materials meshes: 4,096 materials, one each

- **Loss:** after entry 23, `p-uv-transform` (4,096 boxes, each with its own textured material and UV transform) took
  36.2-41.7 ms of CPU per frame against three.js WebGL's 5.9-6.0: the last scene of the speed matrix slower than
  three.js.
- **Causes, measured** (mock-device CPU profiles of the scene, 4,096 meshes: 37 ms a frame):
  1. every mesh was its own draw: a batch carried one uniform block, so materials that differ in more than the base
     colour never shared a draw (drawOwn, uniform compare, bind groups: about 6 us a mesh);
  2. every material read its rows through the record's getters and ran `bindings()` (texture lookups, a new entries
     list, the group 2 compare) every frame, about 3 us each, because nothing said whether it had changed;
  3. every material record still had a hidden class of its own: gltf-pro's placeholder record makes its `side`
     accessor per record, and the materials records copied it (entry 23 had replaced the other accessors);
  4. every live colour had its own hidden class too: its `set` was a new closure per colour.
- **Fixes:** a change stamp on `Material` (every setter, `setUVTransform`, `copy`, buffer releases, and a compare of the
  colour and factor arrays a caller may write in place) and on `Texture` (`update()`, options, `dispose()`, and
  `steady(device)`: no upload or sampler rebuild pending), reported to gltf-pro as the new optional
  `PBRMaterialShading.version`; while it and the draw context stay the same, a draw reuses the derivation whole (rows,
  pipeline, group 2) without reading the record or calling `bindings()`; complete derivations carry a draw group (one
  object per pipeline and group 2 resources), and draws of different material records of one group batch as rows
  batches, whose instances each read their own uniform block from an array of 64 KiB bindings (74 blocks each, one draw
  per binding, `firstInstance` at each binding's start); the record's `side` and the colours' `set` are shared
  functions. No core or stage bytes.
- **Bug found on the way:** a batch's group 0 was cached by pipeline and uniform only, but a batch state also serves
  other views (a view made anew each frame takes a free state; views with equal rows share one), so a second view could
  bind the first view's camera block. Group 0 is now cached by view block too.
- **Image:** the same SSIM and delta E against three.js as before: 0.994 / 1.09.
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-143425` (5 runs; marked invalid for spread: one GPU sample of 0.22 among 0.15s); row in [perf-vs-threejs.md](perf-vs-threejs.md)): CPU / GPU ms per frame.

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-uv-transform` (4,096 materials) | 41.7 / 4.64 (36.2 in run `20261026-104231`) | 2.87 / 0.15 | 6.53 / 5.46 (WebGL), faster |

  4,096 draws became 56. The mock-device profile went from 37 to about 3.6 ms a frame. The first version of the rows
  shader copied each instance's block into a private struct, which put its dynamically indexed UV rows in local memory:
  6.14 ms of GPU time (run `20261026-134031`); reading the uniform array directly gives 0.15.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity --cases=p-uv-transform
  --runs=5`, then `node bench/parity-report.mjs <run.json> --partial`; mock profile: `packages/materials/tests/
  material-version.test.js` builds the same kind of scene.
- **Guard:** `packages/materials/tests/material-version.test.js` (the version changes with every kind of edit and stays
  while nothing changes; NaN for materials with their own shader; a steady material binds nothing while in-place
  colours, texture updates and map swaps still show; 200 materials of one atlas draw as 3 draws of 74/74/52 with their
  own blocks and an edit uploads one block; different textures keep their own draws; records and colours keep one
  shape; a view made anew each frame binds its own camera; a material whose meshes all went binds new buffers),
  `packages/materials/tests/steady-batches.test.js` (a steady material composes no shader and runs no bindings).

### 25. HDR and EXR load: half floats converted one callback at a time

- **Loss:** speed matrix rows 9.1 and 9.2 (run `20261025-155040`): `p-hdr-load` 150 ms against three.js WebGPU 21.0,
  `p-exr-load` 221 ms against 27.1 (parse to linear floats, upload as `rgba16float`).
- **Causes, measured** (Node CPU profiles):
  1. `@margoengine/materials` converted a Float32Array for a half-float texture with `Uint16Array.from(data, toHalf)`:
     a callback per value, 160-170 ms for either image;
  2. `parseEXR` decoded each HALF texel with `halfToFloat` (a `2 ** n` each, 21 ms of BrightRings' 34) and unpredicted
     each ZIP chunk in three passes.
- **Fixes:** `1be3aca1`. Materials' `toHalfArray` uses the built-in `Float16Array` bulk conversion (the same
  round-to-nearest-even bits) where the runtime has it, else a plain loop; environment decodes HALF through a
  65,536-entry table built on first use (every half is exact in float32) and unpredicts in one pass. Trade-off: a
  256 KiB table once the first HALF channel is read. Output is bit-identical (all 22 EXR fixtures hash the same).
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-165034`, 3 runs): ms per call.

  | Scene | Before | After | three.js (WebGPU) |
  | --- | --- | --- | --- |
  | `p-hdr-load` | 150 | 16.95 | 20.3, faster |
  | `p-exr-load` | 221 | 19.6 | 25.9, faster |

- **Rerun:** `node bench/cli.mjs parity --cases=p-hdr-load,p-exr-load --engines=margo,three-webgpu-parity,three-webgl-parity
  --runs=3 --warmup=1 --no-compare --no-fail`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `packages/materials/test/texture-formats.test.js` (bulk conversion equals `toHalf` on a million random
  patterns on both paths, and 4M values convert in under 120 ms), `packages/environment/tests/environment.test.js` (the
  table equals `halfToFloat` for every pattern; BrightRings parses faster than the per-texel conversion alone).

### 26. STL import and USDZ export: pushes, needless fingerprints and the digit search

- **Loss:** speed matrix rows 10.11 and 11.3 (runs `20261025-161120`, `20261025-161539`): `p-stl` (204,800-triangle
  binary STL through the welded-parts path that has since been removed) 111 ms against three.js 2.69; `p-export-usdz` (1,000 boxes) 52.8 ms against 2.78.
- **Causes, measured** (Node CPU profiles):
  1. the STL reader and the corner weld grew JS arrays by `push` (1.8 million pushes; 63 ms);
  2. part deduplication fingerprinted every part, a sort of all its triangles plus a CRC, even
     when no other part had its triangle count and nothing could match: 40 ms for the one STL part;
  3. the exporters' `num()` tried `toPrecision(1..9)` for every number until one read back: 75% of `exportUSDZ`;
  4. CRC-32 ran a byte at a time (4 ms for the 2.5 MB archive).
- **Fixes:** `b30af0b8`. Typed arrays sized for the worst case (positions and normals stay float64, so `Geometry`
  rounds and bounds them as before); a part is fingerprinted only once a second part with its triangle count arrives;
  `num()` binary-searches the digit count (the read-back interval is symmetric except at powers of two, which still
  scan every count), returns integers directly and caches recent values; CRC-32 runs slicing-by-8. Output is
  bit-identical: the same welded geometry, a byte-identical archive. Trade-off: +500 B gzip on `exporters/usdz`.
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-165034`, 3 runs): ms per call.

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-stl` | 111 | 28.7 | 2.6, still slower |
  | `p-export-usdz` | 52.8 | 16.0 | 2.5, still slower |

  Both rows are still slower because the work differs (see [Open losses](#open-losses)).
- **Rerun:** `node bench/cli.mjs parity --cases=p-stl,p-export-usdz --engines=margo,three-webgpu-parity,three-webgl-parity
  --runs=3 --warmup=1 --no-compare --no-fail`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `packages/exporters/tests/exporters.test.js`
  (written numbers equal the old search on 60,000 edge and random Float32 values; a 1,000-box USDZ export takes less
  time than the old search over its numbers alone).

The video and canvas texture rows (6.5, 6.6, run `20261025-144617`: 10.7 and 15.2 ms of CPU per frame against 0.83
and 3.26) were the per-mesh cost of entries 21-24, not texture upload: run `20261026-165034` has them at 0.46 and 0.34
ms against 0.75 and 1.98, faster, with no change of their own.

### 27. Marching cubes and code-authored keyframes

- **Loss:** `p-marching-cubes` (16 metaballs on a 64^3 grid every frame) took 15.96 ms of CPU a frame against three.js
  WebGL's 3.33 (and 1.48 ms of GPU against 0.007: the 212x of the matrix); `p-keyframes` (1,000 code-authored tracks on
  1,000 bones at 600 times) took 420 ms against 32.8.
- **Causes, measured** (Node CPU profiles of the same work):
  1. marching cubes: the scene's density function summed all 16 balls at each of the 262,144 grid points (4.2 M terms;
     6.4 ms alone), where three.js's add-on writes each ball only into the cells it reaches. The extractor also
     allocated its sample and position grids and a 1.8 M-slot shared-vertex table (filled with -1) on every call, read
     eight corners per cube and looked the edge direction up with `indexOf`;
  2. keyframes: `Skeleton.index` was `names.indexOf`, run per track per call: quadratic in bones (about 390 of the
     420 ms). Then every `setPose` built its error label strings, and every track a pose object and a sample array.
- **Fixes:** `marchingCubes(field, options)` also takes the samples (`resolution[0] * [1] * [2]` numbers, x fastest),
  with normals from the grid's central-difference gradient mixed along each vertex's edge; it reads four new corners
  per cube (the other four are the previous cube's), skips cube rows whose four grid rows all lie on one side, and keeps
  its buffers between calls (the vertex table is reset slot by slot, in a `finally`; a call made from inside a density
  function gets its own). A density function's output is unchanged, bit for bit. The scene writes each ball into the
  samples within its reach. `Skeleton.index` is a `Map`; `applyKeyframeClip` binds a clip's tracks to a skeleton's
  bones once (per tracks array and skeleton, weakly held) and reuses one sample and pose object per path; a model target
  finds nodes in one name map per call instead of a search per track; `setPose` builds error text only when it throws,
  and its quaternion scratch is typed like the samples. No core or stage bytes; procedural grows 816 gzip bytes
  (baseline reason recorded).
- **Image:** `p-marching-cubes` 0.996 / 0.15 against three.js (0.996 / 0.14 before); `p-keyframes` gives the same
  checksum as three.js (1696.368), as before.
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-165655` (5 runs; marked invalid for three.js's spread);
  rows in [perf-vs-threejs.md](perf-vs-threejs.md)):

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-marching-cubes`, CPU / GPU ms a frame | 15.96 / 1.48 | 2.87 / 0.006 | 3.08 / 0.007 (WebGL), equal |
  | `p-keyframes`, ms a call | 420 | 30.3 | 32.4 (WebGL), equal |

  The GPU time of `p-marching-cubes` fell with the CPU time although nothing on the GPU side changed (each frame
  still uploads a new geometry of about the same size); what the first run's 1.48 ms measured was not isolated.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity
  --cases=p-marching-cubes,p-keyframes --runs=5`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `packages/procedural/test/procedural.test.js` (a sampled grid gives the function's surface, its normals
  within 14 degrees, and checks its length and values; the scratch is clean after a throw and inside a nested call),
  `packages/animation/tests/keyframes.test.js` (tracks bind to bones once per clip and skeleton, a new skeleton or clip
  binds again; `Skeleton.index` for prototype names; `setPose` error text).

### 28. Point-light shadows, TAA velocities, morphed and cloned models

- **Loss:** `p-point-shadows` (1,000 boxes, 4 shadowed point lights) 15.40 ms of CPU a frame against three.js WebGL's
  2.56; `p-taa` 5.41 against three.js WebGPU's 1.80; `p-morph` (100 morphed copies) 1.06 / 1.57 ms CPU / GPU against
  0.27 / 0.14; `p-skeleton-clone` (50 `cloneModel` copies a call) 84.5 ms against 8.1.
- **Causes, measured** (browser CPU profiles of each scene, timestamps per pass):
  1. LocalShadows drew every caster into every one of the 24 cube faces (24,000 draws a frame) and wrote every
     caster's block each frame (94% of the frame in its `render`);
  2. TAA's velocity pass began a render pass per mesh, a compute pass per PBR snapshot, and wrote each mesh's block
     every frame because the camera rows were in it;
  3. each gltf-pro model drew in its own render pass, each Animation deformed in its own compute pass, and every draw's
     derivation rebuilt its shader text (`compactTests`, `coordinateShader`), so the caches after it hashed new long
     strings per draw per frame;
  4. each `cloneModel` copy repacked its vertices from the shared accessors.
- **Fixes:** a caster's bounding sphere (core meshes: their geometry's; new optional `LocalShadowPrimitive.bounds`)
  is tested against each map's frustum planes, taken from that layer's own matrix, and a block is written only when
  its caster moved. TAA draws all object velocities in one render pass, takes all snapshots in one compute pass after
  it, and keeps the camera rows in one block a frame. gltf-pro models whose passes were added one right after another
  draw as one `PBRDrawRun` at the first one's pass; Animations of a frame graph deform in one compute pass; the two
  shader-text steps are memoised; packings are kept per asset and primitive. No core or stage bytes;
  `clustered/shadows` grows 338 and `taa` 188 gzip bytes (baseline reasons recorded).
- **Image:** the same SSIM and delta E against three.js as before: `p-point-shadows` 0.993 / 0.62, `p-morph` 0.99 /
  1.67, `p-taa` 0.641 / 2.86 (it differed before too: the TAA algorithms differ, and three's WebGL TAA cannot run with
  a moving camera).
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-180213` (5 runs; marked invalid for spread);
  rows in [perf-vs-threejs.md](perf-vs-threejs.md)):

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-point-shadows`, CPU / GPU ms a frame | 15.40 / 1.63 | 1.19 / 0.17 | 2.65 / 2.00 (WebGL), faster |
  | `p-taa`, CPU / GPU ms a frame | 5.41 / 1.41 | 0.56 / 0.12 | 1.73 / 0.24 (WebGPU), faster |
  | `p-morph`, CPU / GPU ms a frame | 1.06 / 1.57 | 0.51 / 1.32 | 0.26 / 0.15 (WebGL), slower |
  | `p-skeleton-clone`, ms a call | 84.5 | 63.6 | 7.9 (WebGL), slower |

  Still open, each in [known-bugs.md](../known-bugs.md#performance-losses-still-open): `p-morph`'s 100 compute
  dispatches run one after another (1.18 ms of its 1.32); `p-skeleton-clone` creates each copy's GPU buffers, textures
  and merged static parts and core `Engine.remove` unparents in quadratic time; `p-gpu-pick` builds a pick pipeline
  per call in core; `helmet`'s GPU time is not isolated yet.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity
  --cases=p-point-shadows,p-taa,p-morph,p-skeleton-clone --runs=5`, then `node bench/parity-report.mjs <run.json>
  --partial`.
- **Guard:** `packages/clustered/test/shadows.test.js` (a caster with bounds draws only into the faces it reaches),
  `tests/deep-render-taa-failures.test.js` (one velocity pass for four meshes; still meshes write no block),
  `packages/gltf-pro/tests/model-runs.test.js` (back-to-back models share one pass, a pass between splits them; copies
  share packed arrays), `tests/deep-interaction-animation-resources.test.js` (three Animations, one compute pass).

### 29. Core picking and removing meshes

- **Loss:** `p-gpu-pick` (100 `engine.pick` calls on the 10,000-box frame) 412 ms against three.js WebGL's 65;
  `p-skeleton-clone` 63.6 ms against 7.9 (entry 28).
- **Causes, measured** (browser CPU profiles of each scene):
  1. core `GPURenderer.pick` compiled a shader module and a render pipeline on every call, and rewrote every batch's
     whole instance buffer (960 KB for 10,000 boxes), then made the next frame upload it all again;
  2. core `Engine.remove` found a removed mesh's children by scanning the whole parent column (its capacity, 16,384
     slots in the scene) once per removed mesh: about 17 ms for the 3,700 meshes a call destroys.
- **Fixes:** pick pipelines share core's draw-variant cache (keyed by shader text; they count toward its 64
  variants), and a pick uploads only the range a frame would. Each mesh keeps the ids of its children, so a removal
  unparents only them. Both are core bug fixes: core grows 25 B gzip to 20,479 B (cap 20,480), core + stage to
  22,781 B.
- **Image:** unchanged (picking draws no image; the clone scene draws none either).
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-190630` (5 runs; marked invalid for the spread of
  three's WebGPU clone); rows in [perf-vs-threejs.md](perf-vs-threejs.md)):

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-gpu-pick`, ms a call | 412 | 325 | 61 (WebGL), 423 (WebGPU), slower |
  | `p-skeleton-clone`, ms a call | 63.6 | 47.9 | 8.0 (WebGL), slower |

  Still open, in [known-bugs.md](../known-bugs.md#performance-losses-still-open): each pick waits for its own GPU
  round trip (0.15 ms of JavaScript, about 3.1 ms waiting), one at a time by `engine.pick`'s contract, where three's
  WebGL readback is a synchronous `readPixels`; each clone still uploads its own GPU buffers and textures and merges
  its static parts.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity
  --cases=p-gpu-pick,p-skeleton-clone --runs=5`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `tests/deep-core-resources.test.js` (five picks compile one pipeline; a new pick shader text adds one and
  the 65th variant throws), `tests/core-remove-children.test.js` (removal unparents only current children, after
  reparenting and slot reuse; 30,000 removals at capacity 524,288 take under a second, about 3 s before).

### 30. SciFiHelmet's GPU time is its soft shadows

- **Loss:** `helmet` (SciFiHelmet on a floor, image-based lighting, a 2048 shadow map) 0.77 ms GPU a frame against
  three.js WebGL's 0.08 (run `20261025-170145`).
- **Cause, measured** (timestamps per pass, each feature switched off in turn; RTX A6000, diagnostic): the four
  shadow cascades take 0.05 ms, the core pass 0.28 and the model's pass 0.46. Without image-based lighting the passes
  are unchanged (0.28, 0.44); with `Shadows`' `'pcf'` filter they drop to 0.03 and 0.05; without shadows to 0.02 and
  0.04. So the cost is the default `'soft'` filter (PCSS: 16 blocker reads and 32 comparison taps per lit pixel),
  where three's side draws one PCFSoftShadowMap. Trade-off: PCSS penumbrae widen with blocker distance; PCF edges do
  not.
- **Fix:** none in the engine yet (plan in [known-bugs.md](../known-bugs.md#scifihelmet-default-soft-shadows-cost-the-gpu-time)).
  The `helmet` scene takes `filter` and `cascades` parameters (defaults unchanged: `'soft'`, 4), and row 9.3 also
  runs `helmet-filterpcf-cascades1`, Margo's setup closest to three's.
- **After** (diagnostic, busy machine; run `20261026-194330` (5 runs; marked invalid for the CPU spread of three's
  WebGL side); rows in [perf-vs-threejs.md](perf-vs-threejs.md)):

  | Scene | Margo CPU / GPU ms | three.js WebGL | three.js WebGPU |
  | --- | --- | --- | --- |
  | `helmet` (4 PCSS cascades) | 0.11 / 0.78 | 0.07 / 0.09 | 0.16 / 0.07 |
  | `helmet-filterpcf-cascades1` | 0.11 / 0.08 | 0.07 / 0.09 | 0.16 / 0.07 |

  Image against three.js WebGL: SSIM 0.981 / delta E 0.58 (default), 0.984 / 0.54 (matched).
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity
  --cases=helmet,helmet-filterpcf-cascades1 --runs=5`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `tests/bench.test.js` (the scene catalog and parity rows stay consistent).

### 31. STL import: a plain `parseSTL` for the like-for-like comparison

- **Loss:** `p-stl` (204,800-triangle binary STL) timed the welded-parts path at 28.7 ms against three.js's `STLLoader` at 2.6
  (entry 26). The cause left after entry 26 was different work, not a slow loop: that path welded corners (205,440
  vertices), computed face normals, built parts and created GPU meshes.
- **Change:** `parseSTL` in `@margoengine/loaders` (`d8cefa7b`), a plain reader like three's: binary and ASCII STL to
  typed arrays (3 vertices per triangle, the file's facet normals or flat normals where the file stores zero,
  VisCAM/SolidView colors if present), no weld unless `weld: true`, `AbortSignal`, coded errors. `p-stl` now times
  `parseSTL`.
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-201722`, 3 runs): ms per call.

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-stl` (`parseSTL`, plain) | 28.7 (welded-parts path) | 4.9 | 2.8, still 1.7x slower |

- **Accepted difference in work (Scott, 2026-10-26):** the `p-stl` gap is kept listed (4.7 against 2.7 ms, 1.7x) but
  accepted: `parseSTL` returns a render-ready mesh with flat face normals computed, while three's `STLLoader` copies the
  file's zero normals, which light wrongly until `computeVertexNormals()` is called. The scene `p-stl-normals` times the
  full job on both sides (run `20261026-211213`, diagnostic, 5 runs): three 8.7 ms (WebGPU build) / 8.7 (WebGL),
  `parseSTL` 4.7 ms, so Margo is about 1.9x faster.
- **What is left in `p-stl`:** `parseSTL` computes the flat normal of every facet whose stored normal is zero (this
  file's writer leaves them zero, as most do), about 1.3 ms in Node (the profile shows `flatNormal` as the largest
  share), where three copies the zeros; it also writes an identity index array and zero-fills a third array. It is
  not a loop to fix: returning usable normals is the behavior a user wants. See
  [known-bugs.md](../known-bugs.md#stl-import-still-computes-normals-threes-stlloader-leaves-zero).
- **Trade-off:** +1.9 KB gzip on the loaders root entry (a separate module; apps that do not import it pay nothing).
- **Rerun:** `node bench/cli.mjs parity --cases=p-stl --engines=margo,three-webgpu-parity,three-webgl-parity
  --runs=3 --warmup=1 --no-compare --no-fail`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `packages/loaders/tests/stl.test.js` (binary and ASCII give the same geometry, stored and computed
  normals, colors, weld, truncated and malformed input, limits, abort); the loaders `npm test` script now passes
  `--experimental-test-module-mocks` like `verify`, which `mtl-vectors.test.js` needs.

### 32. cloneModel copies share their GPU buffers and baked batches

- **Loss:** `p-skeleton-clone` (50 `cloneModel` copies of RobotExpressive a call, the previous 50 destroyed) 47.9 ms
  against three.js WebGL's 8.0 after entry 29.
- **Causes, measured** (browser CPU profile of the call): every copy created and filled its own GPU vertex and index
  buffers for arrays it already shared with the source (about 11 ms), re-baked its static parts into new arrays at the
  same pose (about 13 ms), and made a texture view and a sampler for every map slot of every primitive, native calls
  (about 10 ms with the bind groups).
- **Fixes:** gltf-pro counts vertex and index buffers per device, asset and array: a model of the same asset takes
  the buffer instead of uploading, writes one in place only while no other model holds it (`writeGeometry` gives it
  its own buffer otherwise), and the last holder retires it. Baked static batch arrays are reused for the same part
  arrays at the same root-relative poses (bit-equal, four poses per first part kept), so their buffers are shared too.
  Each texture has one default view and each sampler state one sampler per device. Models of different assets never
  share buffers. Trade-off: the first edit of a geometry buffer another copy holds uploads a new buffer. No core
  bytes.
- **Image:** no scene image (a task scene); the visual check covers gltf-pro's draws.
- **After** (diagnostic, busy machine, RTX A6000; run `20261026-203857`; rows in
  [perf-vs-threejs.md](perf-vs-threejs.md)):

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-skeleton-clone`, ms a call | 47.9 | 17.6 | 7.8 (WebGL), slower |

  Still open, in [known-bugs.md](../known-bugs.md#clonemodel-two-engine-wide-ticks-per-copy): `installBatches`
  runs two engine-wide kernel ticks per model, quadratic in the copies (about 6.5 ms), then per-copy uniforms and bind
  groups and core node creation.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity --cases=p-skeleton-clone
  --runs=5`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `packages/gltf-pro/tests/model-runs.test.js` (copies share vertex and index buffers, freed with the last
  one; a copy's edit leaves the shared buffer and later copies with the asset data; copies share baked batch arrays,
  another pose bakes anew; copies share samplers), `tests/modern-silent-render-drops.test.js` (eye renderers on one
  device share the static vertex buffer and free everything on disposal).

### 33. Audit of the item 47 speed work: same pixels, same bytes, both marching-cubes workloads

- **Pixels:** every parity case Margo runs (139) was rendered from the packages built at `82da467e` (before the
  item 47 commits) and at `83c79d15`, 60 frames at a fixed 1/60 s step, and the screenshots compared. 130 are
  byte-identical files (the dense marching cubes among them); six differ by at most one level in a channel
  (`p-alpha-test`, `p-canvas-texture`, `p-double-sided`, `p-matcap`, `p-phong`, `p-physical`); three differ in a few
  edge pixels, SSIM 1.0 and mean delta E 0.001 or less: `p-blending` (90 pixels, up to 29 levels, where neighbouring
  blended quads meet; traced in entry 35), `p-transparency` (up to 4 levels, entry 35) and `p-wireframe` (7 pixels, up
  to 8 levels; each edge is now drawn once, in one direction). The current build renders the same pixels on a second run, so these come from the changes, not
  from noise, and all sit far inside the matrix's tolerance (SSIM >= 0.9, mean delta E <= 6).
- **Bytes:** OBJ, STL and PLY (binary and ASCII), GLB and USDZ exports, EXR writing, all 32 EXR and HDR fixtures and
  the welded STL geometry hash the same before and after (`b30af0b8`, `1be3aca1`).
- **Marching cubes:** `4be0e7d2` also changed the scene, from summing every ball at every grid point to writing each
  ball only near it as three's add-on does, so `p-marching-cubes` compared two workloads. Row 17.11 now runs both,
  labelled: `p-marching-cubes-dense` (the original scene, its image byte-identical to the original's) and
  `p-marching-cubes-localized` (the add-on's work). Run `20261026-221004`, CPU ms per frame:

  | Scene | Margo | three.js (WebGL) |
  | --- | --- | --- |
  | `p-marching-cubes-dense` | 9.76 | 3.17 (three always runs its localized add-on) |
  | `p-marching-cubes-localized` | 2.90 | 3.17 |

- **Bug found:** the point-light shadow cull of `8149bf4e` took a caster's world radius from the longest column of its
  node matrix, which is short under shear (a rotated child of a non-uniformly scaled parent): such a caster near a
  cube-face edge or the light's range could lose its shadow in that face. `shared/sphere.js` `worldRadius` bounds the
  stretch through the Gershgorin bound of M^T M (exact for rotation and scale) plus a float32 pad; LocalShadows, the
  LOD imposter cull and gltf-pro's progressive load order use it. The `p-point-shadows` image is unchanged.
- **Labels:** the matrix names what each case of a multi-case row measures (`bench/scenes/parity.js` `LABELS`): helmet's
  default PCSS shadows beside the setup closest to three's, `p-stl` beside `p-stl-normals`, dense beside localized.
- **Guard:** `packages/clustered/test/shadows.test.js` (casters across face seams, on edges and corners, grazing the
  range, a centre outside one face's frustum overlapping the next, and 120 sheared casters, each checked against
  sampled sphere points), `tests/shared-sphere.test.js`, and `tests/bench.test.js` (row 17.11 keeps the dense case,
  every label names a case).

### 34. Every deformed primitive of a device in one dispatch

- **Loss:** `p-morph` (100 MorphStressTest copies, 8 weights each changing every frame) 0.51 / 1.31 ms CPU / GPU a
  frame against three.js WebGL's 0.27 / 0.15 after entry 28.
- **Cause, measured** (timestamps per pass): the compute pass was 1.18 of the 1.31 ms: 200 small dispatches (two
  primitives, 24 and 1,504 vertices, times 100 copies), each writing its own output buffer, run one after another.
- **Fix** (`00dde81a`): animation keeps every skinned or morphed primitive of a device in a few shared storage
  buffers (bind-pose source, deformed output on 256-byte offsets, morph deltas and skin influences once per asset
  primitive and shared by its clones, weights, bone palettes) and deforms them all with one dispatch per buffer page
  and pipeline (four or eight influences) from a per-workgroup work list; the per-vertex arithmetic is the
  per-primitive shader's, term for term. Every reader of `PBRPrimitive.deformed` takes the new `deformedOffset` (or a
  record's `vertexOffset`): gltf-pro draws, shadow casters, TAA velocity and snapshots, selection, picking and its CPU
  readback, the inspector. A buffer bound at offset 0 is bound with the same call as before, so the feature-off
  proofs are unchanged. Same work and same output: no copy back into per-primitive buffers, nothing moved out of the
  measured passes. Trade-off: about 2.8 KB more gzip on the animation root entry; buffers grow geometrically (old
  contents copied on the GPU), holes from disposed models are compacted on the next growth. Setup moved from the
  build to the first frame (build 490 -> 190 ms, first frame 47 -> 373 ms, together 27 ms more).
- **Image:** the same against three.js as before, SSIM 0.99, mean delta E 1.67; the deformed vertices are bit for bit
  those of the per-primitive path.
- **After** (diagnostic, busy machine, RTX A6000; before run `20261027-033656` at the parent `88e02fb2`, after run
  `20261027-032923`; rows in [perf-vs-threejs.md](perf-vs-threejs.md)):

  | Scene | Before | After | three.js |
  | --- | --- | --- | --- |
  | `p-morph`, CPU / GPU ms a frame | 0.51 / 1.33 | 0.52 / 0.19 | 0.27 / 0.15 (WebGL), slower |
  | `p-morph` GPU, deform pass | 1.18 | 0.05 | none (morphs in its vertex shader) |
  | `p-morph` GPU, draw pass (like for like with three's whole frame) | 0.14 | 0.14 | 0.15 |

  Accepted difference in work (rule 12): the 0.05 ms deform pass. Margo deforms each vertex (position, normal,
  tangent) once a frame into a buffer every reader shares (draws, shadow casters, TAA velocity, selection, picking and
  the CPU readback); three repeats the morph in every pass that draws the mesh and has no deformed geometry to pick or
  read back. The draw pass alone, the like-for-like part, is 0.14 against three's 0.15 for the whole frame.
  Still open, in [known-bugs.md](../known-bugs.md#morph-targets-cpu-per-animation-per-frame): the CPU time, 0.52
  against 0.27 ms, which the batching did not move.
- **Rerun:** `npm run bench -- parity --engines=margo,three-webgpu-parity,three-webgl-parity --cases=p-morph
  --runs=7`, then `node bench/parity-report.mjs <run.json> --partial`.
- **Guard:** `scripts/animation-batched-deformation-tests.js` (animation `test:gpu`, real GPU: every primitive bit for
  bit against the per-primitive shaders for random weights and poses while models with different vertex and target
  counts, skinned, morphed, skinned and morphed, four and eight influences are added, cloned and disposed; one
  dispatch per page and pipeline), `packages/animation/tests/batch.test.js` (offsets, growth, holes, compaction,
  shared deltas, release), `tests/deep-interaction-animation-resources.test.js` (one dispatch).

### 35. Blended pixels that moved in entry 33: same draws; the GPU stores some samples as their mean

- **What changed:** `p-blending` and `p-transparency` rendered with only the packages swapped (bench at the current
  commit, 1280 x 720, 4x MSAA), one commit at a time: `b953071e` (a run's blended draws continue its pass: one
  render pass instead of one per blended mesh) moved 80 `p-blending` pixels; `e2cb3815` (consecutive blended draws
  batch as instanced draws) moved 186 against the old image (up to 29 levels) and `p-transparency` (58 pixels, up to
  4 levels). A camera held still for every frame gives the same images.
- **The draws are the same.** A WebGPU capture shows one pipeline in both builds (bgra8unorm, 4x, `src-alpha` +
  `one`, depth write off, `greater-equal`, polygon offset 1, 1) and 2,000 quads, each once, farthest first, with its
  own matrix and colour (the guard below); only the pass boundaries (2,000 passes, then one) and, from `e2cb3815`,
  instancing differ. On SwiftShader (Chrome's CPU implementation of WebGPU) the instanced build and `b953071e` render
  `p-blending` byte for byte alike and `p-transparency` within 1 level at 2 pixels; the old build's 2,000 passes a
  frame did not finish there within the bench's 10 minutes.
- **The GPU, measured without Margo:** `scripts/gpu-blend-passes.mjs` draws 2,000 rectangles with edges inside pixels
  into the same targets (1280 x 720, 4x bgra8unorm, depth32float-stencil8, depth write off), split three ways, reads
  every stored sample back and compares it with the value WebGPU defines, computed on the CPU per sample. On the RTX
  A6000 (Edge) every split misses it, by up to 201 levels, and almost always the same way: a pixel's four samples
  hold one value, their mean, where the CPU's four differ (the pixel's resolved colour is right until a later draw
  blends onto the averaged samples). How many pixels this hits depends on the split, so moving the same draws between
  passes or into one instanced draw moves pixels:

  | Pixels collapsed to their mean | One pass per draw | One pass, a draw per rectangle | One instanced draw |
  | --- | --- | --- | --- |
  | Additive, D3D12 | 28,267 | 28,029 | 27,070 |
  | Additive, D3D11 | 28,267 | 26,186 | 18,986 |
  | Alpha (0.5, in order), D3D12 | 37,344 | 36,947 | 35,684 |
  | Alpha (0.5, in order), D3D11 | 37,344 | 34,339 | 24,727 |

  The engine images agree: the old build renders `p-blending` byte for byte alike on D3D12 and D3D11, the instanced
  build differs between the two backends at 1,795 pixels, which inputs alone cannot do.
- **Correction:** the CPU reference this entry first cited (old image within 2 levels at 185 of the 186 pixels) added
  colours read from single-quad pixels and is not exact: away from any edge it misses both images by more than 2
  levels at about 1,300 pixels each, so it cannot tell the two apart and is no longer cited.
- **Verdict:** no engine bug. The speed work sends the same draws in the same order; neither image is the spec's,
  because this GPU averages some pixels' samples, and the split only changes which. Restoring a pass per blended mesh
  would cost 2,000 passes a frame and still not give the spec's result, so the engine keeps one pass and instancing.
  The images stay within the matrix's tolerance (SSIM 1.0).
- **Rerun:** `node scripts/gpu-lock.mjs run --max=8 --owner=<you> -- node scripts/gpu-blend-passes.mjs` (add
  `--adapter=d3d11` for D3D11).
- **Guard:** `packages/materials/tests/steady-batches.test.js` ("the p-blending quads reach the GPU once each"): the
  scene's 2,000 additive quads in 16 colours, each exactly once, farthest first, with its own world matrix and colour
  and the scene's depth state; shifting the instance colours by one fails it.

### 36. Matrix rows round 4: yields, strings, allocations, serial decodes and per-copy pipelines

- **Loss:** rows the matrix still listed as "not diagnosed" (run `20261027-075302` at `46b4df25`, busy machine, RTX
  A6000, diagnostic). Each was profiled (browser CPU profiles of the bench page, Node profiles for the CPU-only
  tasks, timestamps per pass, a timing wrapper on render-pass methods, the harness's shader dump).
- **Causes and fixes** (same output: hashes of the bytes, geometry and GLB before and after are equal):
  1. `encodeEXR` yielded every 65,536 samples with `setTimeout`, clamped to 4 ms by the browser (128 yields); it now
     yields after about 10 ms of work (`scheduler.yield()` where present).
  2. `extrudeGeometry` pushed every corner into JS arrays with spreads and copied them; the triangulator keyed shared
     edges and pinch points by printing coordinates to strings. Arrays are presized; coordinates group by value.
  3. Environment's half-float upload used a bit loop; it now stores through `Float16Array` (same bits).
  4. The FBX pivot chain rebuilt its fixed matrices for every animation key and allocated every product; the fixed
     parts are made once per node and the products use scratch matrices, in the same order.
  5. gltf-pro decoded a model's images one after another; up to 8 now decode at once, results taken in image order.
     Every `cloneModel` copy also compiled its own mip pipelines (200 shader modules for `p-morph`'s 100 copies); they
     are now kept per device.
  6. Raw meshes rebuilt their normal matrix with temporary arrays every frame and re-bound the material group per
     draw; now only on change, and once per run of one material.
  7. Each Animation compared its whole bone palette with the uploaded one after the first difference; the
     comparison stops there.
- **After** (diagnostic, busy machine; runs `20261027-103915`, `-104327`, `-105122`, `-105432`, `-105724`; ms):

  | Scene | Before | After | three.js (WebGL / WebGPU) |
  | --- | --- | --- | --- |
  | `p-export-exr` | 680 | 44.6 | 154 / 153 (ZIP; Margo writes NONE, so it does less) |
  | `p-text` | 23.6 | 13.4 | 8.0 / 8.1 |
  | `p-fbx` | 12.6 | 5.8 | 4.7 / 4.4 |
  | `p-gltf-parse` | 88.7 | 46.3 | 34.0 / 33.0 |
  | `p-pmrem` | 14.6 | 10.9 | 5.0 / 5.4 |
  | `p-custom-shader`, CPU a frame | 28.8 | 21.3 | 7.6 / 36.8 |
  | `p-crossfade`, CPU a frame | 15.7 | 17.5 (noisy run; three's WebGL 7.7 -> 13.3 in the same run) | 13.3 / 22.9 |

- **Accepted differences (rule 12):** `p-text`'s remaining triangulation (quality-ordered ears and robustness for
  touching rings; no lower-quality Margo triangulator exists for a like-for-like row); `p-crossfade`'s 1.64 ms
  deform pass (vertices skinned once into a buffer every reader shares; the draw pass, 0.63 ms, is under three's
  whole WebGPU frame of 1.98), as row 12.5's.
- **Still open** (each in [known-bugs.md](../known-bugs.md#performance-losses-still-open)): raw meshes' native calls
  per draw, motion blur's dependency on TAA for velocity, the rect-area main pass, Environment's extra work and its
  per-environment BRDF LUT, `p-morph`'s per-draw derivation and first frame, and `p-gltf-animated` (3.4 against 1.3
  ms, not profiled into parts yet). `p-node-material` is no longer slower (0.98 against three's WebGPU 20.3 ms CPU,
  from the materials draw-path work).
- **Report tool:** the Feature JS column summed the gzip sizes of a run's scripts from the build folder at report
  time; every bench run rebuilds that folder with new hashed names, so missing files counted as 0, and three's
  `.mjs` chunks were never listed (its side was its 5 KB entry). Runs now record each script's gzip size
  (`info.scriptGzip`) and list `.mjs`; an unmeasurable sum is `n/a`. `p-morph`'s Feature JS is real code, not growth
  from a missing build: 117 KB was the run-time sum.
- **Rerun:** the `rerun` commands in `bench/parity-causes.json` (rows 2.5, 4.6, 9.3, 10.1, 10.8, 11.4, 12.2, 12.5).
- **Guard:** `packages/environment/tests/exr-write.test.js` (yields follow time; bytes do not depend on them),
  `packages/environment/tests/half-upload.test.js`, `packages/geometry/tests/extrude.test.js` (no per-triangle
  pushes), `packages/geometry/tests/triangulate.test.js` (-0 meets 0), `packages/fbx/test/geometry.test.js` (the
  cached chain equals the chain built by hand, bit for bit), `packages/gltf-pro/tests/async-images.test.js` (8 at
  once, in order, failures close every bitmap), `packages/gltf-pro/tests/model-runs.test.js` (one mip shader per
  device), `packages/shader/test/raw.test.js` (one material bind per run), `tests/bench-feature-bytes.test.js`.

## Size of the frozen core

### 10. Core grows from error handling, then shrinks

- **Loss:** core + stage went from 22,253 to 23,271 B gzip (`59e32ef7` message; record `8c59117c`: core 20,899 B). The
  growth had three parts:
  - a queue for overlapping `engine.pick` calls: +63 B;
  - 25 bare errors turned into coded `MargoError`s: +301 B;
  - 74 messages that name their fix: +653 B.

  Core went over its original 20 KiB core-only cap, which was raised to 21 KiB.
- **Cause:** long messages that explain the fix help developers, but they sit in the frozen, size-capped core.
- **Trade-off:** core messages are now short and link to an error page on margoengine.com, which holds the full text.
- **Fix:** `ef36e9ee` fix(core): short error messages linked to margoengine.com/errors.
- **After:**
  - The commit message gives 22,600 B gzip.
  - Record `667ea99d`: core + stage 22,636 B, core 20,322 B, back under the 20 KiB cap.
  - Current figure: `examples/package-benchmarks/results/entry-sizes.json`.
- **Rerun:** `npm run measure:size`.
- **Guard:**
  - `scripts/core-budget.js`: the 25,000 B gate, used by `measure-size.js`.
  - `tests/modern-core-budget.test.js`.
  - The 20 KiB core check in `scripts/build-modern.js`.
  - `tests/core-errors.test.js` and `tests/errors-page.test.js`.

### 11. Duplicate cleanup grew core, then was trimmed

- **Loss:** the first pass of the duplicate cleanup moved core's private copies onto shared helpers. Core + stage went
  from 22,253 to 22,403 B gzip, and core from 20,015 to 20,155 B (`1fda3719` message). Package root entries grew too.
- **Cause:** shared helpers are bundled into every package that uses them. So merging a copy saves nothing in a package
  that held only one copy, and each call adds a few bytes. In the frozen core, the shared GGX helper alone would have
  added 92 B.
- **Trade-off:** core keeps its own copies of five things, which are recorded as accepted duplicates in
  [HANDOFF](../HANDOFF.md):
  - the `#rrggbb` check;
  - the GGX text;
  - the view-rectangle check;
  - the mesh buffer layout;
  - the bind-group cache.
- **Fix:** `bfde407d` (pure-annotated tables so unused ones tree-shake) and `64c22378`. The second restored core and
  trimmed the shared helpers:
  - private-field inflater: same speed, identical output over 24,000 fuzz cases;
  - one mip generator;
  - environment probes no longer bundle the prefilter shader.
- **After:**
  - Core 20,015 B and core + stage 22,253 B, both unchanged.
  - The package root entries total 30 B less than before the cleanup.
  - The duplicates baseline went from 92 items (1,182 lines) to 4 (15 lines) (`1938d3e5`).
  - Sources: `docs/HANDOFF.md`, `scripts/quality/baselines/duplicates.json` and `sizes.json`.
- **Rerun:** `npm run quality`, then `npm run measure:size`.
- **Guard:** `scripts/quality/duplicates.js` with its baseline, the sizes gate, and `tests/quality-gate.test.js`.

## Bugs the checks caught

These entries have no timing. The loss is a feature that did not work.

### 12. Voxel path tracer: trace shader never compiled

- **Loss:** `5c75e38a` (slabs and stairs) left `d>vec3f(0.0)&(...)` in the octant walk. WGSL requires parentheses when a
  comparison is mixed with `&`, so `createShaderModule` failed and no path tracer pipeline could be built.
  - Found 41 minutes later by `packages/voxel-pathtracer/tests/browser-check.mjs`.
- **Cause:** the mock-GPU unit tests never compile WGSL, and `check:merge` did not compile the tracer's shaders.
- **Fix:**
  - `d10222cf` adds the parentheses.
  - `e9166140` closes the class of bug with a WGSL compile gate in `check:merge`. It compiles 180 distinct sources in
    1.7 s, and fails on the original line when that line is put back.
- **Rerun:** `npm run check:wgsl` and `npm run check:tracer`.
- **Guard:**
  - `scripts/check-wgsl.mjs`;
  - `scripts/support/wgsl-guard.js`, which fails any browser page whose WGSL has errors;
  - `packages/voxel-pathtracer/tests/browser-check.mjs`.

### 13. Iridescent materials failed to compile on a real GPU

- **Loss:** after the clean-room rewrite `dd13beb9`, every iridescent material failed to compile. The visual check
  caught it in the khronos-IridescenceLamp view.
- **Cause:** the thin-film phase compared a vector with a scalar base IOR.
- **Fix:** `8a0f78eb` thin-film phase compares the base IOR per channel. The view then changed by at most 1 level on
  0.00004 of its pixels.
- **Rerun:** `npm run check:wgsl`, `npm run visual:check`.
- **Guard:** the WGSL compile gate and the visual baselines.

### 14. React `<Environment>` did not compile on gltf-pro models (10 days)

- **Loss:** `<Environment src=...>` failed on every gltf-pro model with "cannot take the address of 'var iblBrdf' in
  handle address space".
  - It broke at `b1276ce5`, which moved the BRDF table to a storage buffer, and was fixed 10 days later.
  - React's browser test found it; that test was not part of `check:merge`.
- **Cause:** React kept its own copy of the environment package's IBL shader, and the copy fell out of step.
- **Fix:** `c28d4e90` fix(react): `<Environment>` lights models with the environment package's own IBL. About 30 lines
  of duplicated shader went.
- **After:** 50 WGSL modules in the React scene browser test, 0 errors; React suite 135/135.
- **Rerun:** `npm run test:browser --workspace @margoengine/react`.
- **Guard:**
  - `packages/react/tests/enhancements.test.js` and `packages/react/test/declarative.test.js`, which check that the
    model's IBL is the environment package's own;
  - the WGSL page guard.

### 15. Unreal precision export had never passed a real import

- **Loss:** the importer, moved from the MargoTile app in `6d695f61`, failed its first real Unreal Engine 5.8.4 run:
  "Native setting did not stick: override_pipelines".
  - Source: `examples/package-benchmarks/results/unreal-precision-import.json`, `before`.
- **Cause:**
  - The importer compared SoftObjectPath structs, which Python compares by identity, so the read-back never matched.
  - Two more UE 5.8 mismatches came to light behind it: Texture2D has no `compression_none`, and
    `get_material_used_textures` is empty under `-NullRHI`.
- **Fix:** `53dc6b6e` fix(exporters): Unreal precision importer passes a real UE 5.8 import.
- **After:** `"result": "PASS"` (same file, `after`).
  - This covers adapter storage only. Render, RHI, fresh-process and performance checks are still open.
  - The importer grew from 67,300 to 68,198 B.
- **Rerun:** not recorded. The fixture script named in the record is not in this repository.
- **Guard:** `packages/exporters/tests/precision-native.test.js` pins each of the three fixes.

### 16. Next.js apps could not build without Rapier

- **Loss:** `next build` failed with "Can't resolve '@dimforge/rapier3d-compat'" for any app that used
  `@margoengine/react`. The bundler matrix added in `b803742a` found it.
- **Cause:** React's root re-exported physics, and webpack, Turbopack and esbuild resolve every string-literal
  `import()` they reach, whether or not it is used. So Rapier was effectively a required install.
- **Trade-off:** physics moved to a subpath, `@margoengine/react/physics`, recorded in
  [renames-2026-10-24.md](../renames-2026-10-24.md).
- **Fix:** `f5051576` fix(react): physics only on `@margoengine/react/physics`, then `c2b4c191`, which runs the bundler
  matrix in `check:merge`.
- **After:** Next builds with webpack and with Turbopack without Rapier installed (`c2b4c191` message).
- **Rerun:** `npm run modern:test:bundlers`, after `npm run modern:test:packages`.
- **Guard:** `packages/react/tests/subpaths.test.js`, which fails if anything in the root entry's import graph names
  Rapier, and the bundler matrix.

### 17. Normal maps mirrored on models without tangents

- **Loss:** ToyCar, SheenChair, MaterialsVariantsShoe and DiffuseTransmissionTeacup rendered with mirrored normal maps.
  The proof triage found it.
- **Cause:** a regression from `70c73f64` in how the tangent frame is built when a model has no tangents.
- **Fix:** `20bc1db3` moves every user onto one helper, `packages/shared/tangent-frame.js`.
- **Rerun:** `npm run proofs -- --current`, `npm run visual:check`.
- **Guard:** the pinned shader fingerprints in `packages/gltf-pro/tests/physical-map-renderer.test.js`, and the gltf-pro
  proofs.

### 18. Fuzzing: unbounded allocations, including a zip bomb

- **Loss:** a 314-byte PLY file made the loader allocate 336 MiB, and ZIP entries had no ratio limit (`1316caaf`
  message).
- **Cause:** declared counts were trusted before the body was checked.
- **Fix:** `1316caaf`:
  - counts are checked against the body before allocating;
  - ZIP has a `maxRatio` limit (200x by default for entries over 1 MiB);
  - 3MF instances are capped at 100,000;
  - IFC syntax is checked before web-ifc.
- **After:** a clean run with seed 3 at 90 s per target found 0 issues.
- **Rerun:** `npm run fuzz`.
- **Guard:** `tests/fuzz-regressions.test.js`.

### 19. Prototype pollution through JSON keys

- **Loss:** `__proto__`, `constructor` and `prototype` keys in untrusted JSON could reach parsed results.
  - `splitGLB` still used plain `JSON.parse` on caller files after the main fix.
- **Fix:**
  - `d7b2bf88`: `parseJSON` drops those keys at every depth.
  - `890a1bad`: `splitGLB` uses it.
- **Rerun:** `node --test tests/security.test.js packages/exporters/tests/glb-append.test.js`.
- **Guard:** `tests/security.test.js` and `packages/exporters/tests/glb-append.test.js`.

### 20. Workers needed `'unsafe-eval'` in the Content Security Policy

- **Loss:** the decoder worker loaded its code with `eval`, and the embind glue used `new Function`. Pages with a strict
  CSP failed.
- **Fix:** `d000b1d9` loads decoder code with `importScripts` and replaces the generated wrappers with closures. Facade
  demo builds dropped about 7.79 MB of unused code each (commit message).
- **After:** 14/14 pages pass (same message). The current record is
  `examples/package-benchmarks/results/csp-check.json`.
- **Rerun:** `node scripts/csp-check.mjs`.
- **Guard:** `tests/no-eval-workers.test.js`.

## What our checks caught, and what we got wrong (2026-10-26 to 10-28)

In these three days the engine ran on more machines than before: a mini PC with an AMD Radeon 680M integrated GPU
(Windows, Edge and Chrome), a small Ubuntu server with an Intel UHD integrated GPU (Chromium on Mesa's Vulkan driver),
a second laptop used for an outside audit, and Node 22 beside Node 24 and 26. Most of what broke was in our own maths,
our tests or our machines, and several of our first explanations were wrong. Each entry gives:

- **Symptom:** what failed, and where.
- **Cause:** what was measured.
- **Fix:** the commit on `main`.
- **Guard:** the regression test that fails without the fix.
- **Rerun:** the command.
- **What we got wrong**, where we did.

Numbers come from the commit messages named, from `docs/known-bugs.md`, or, where marked **not committed**, from a run
log kept on the machine that ran it. Open items stay in [known-bugs.md](../known-bugs.md).

### 37. GPU shader compilers reassociated our precise maths

- **Symptom:** on the AMD Radeon 680M (D3D12, Edge and Chrome 156), `preciseLog1p(5.963922e-8)` returned 2^-23, which
  is 8,383,741 units in the last place (ulp) off; its bound is 2. The same code passed on an NVIDIA RTX A6000 and an
  Intel Arc 140V. On the Intel UHD (ADL-N) with Mesa on Linux, 14 of the 17 precise functions were out of bound.
- **Cause:** WGSL allows an implementation to reassociate floating-point operations (WGSL section 15.7.5). The precise
  functions in `packages/shared/precise-math.js` depend on error-free transforms such as `(a + b) - a`, which only work
  if the compiler keeps the order written. AMD's compiler folded `(1 + x) - 1` to `x`. Mesa also folded `(a + b) - a`,
  added constants first and factored `a c + b c`, which undid the correction in `preciseDiv`. A bitcast round trip does
  not stop this: the compilers see through it.
- **Fix:** `b6bea3e9`. `pmHide(v)` rebuilds a value from its bits with integer operations, which no compiler can fold,
  and every step whose rounding matters takes hidden operands. The values are unchanged, so the host-side mirror keeps
  its numbers. After: all 17 functions within bound on the Intel UHD (Mesa), the Radeon 680M and the RTX A6000; `log1p`
  worst 1.42 of 2 ulp, `pow` 4.5 of 5.
- **What we got wrong:** our stand-in for a reassociating compiler (`reassociateMath` in `scripts/browser.js`) only
  folded sums cancelled by their own operand, so it could not show the next case. An Intel UHD run taken before
  `b6bea3e9` had `preciseSin(3.907435372766365e27)` 1.46 ulp off (bound 1): Mesa had factored the old sine kernel
  `h + (l (1 - w/2) + (h w) p)` into `h (1 + w p)`. `baa66526` makes the stand-in also factor a sum by one of its own
  terms; with it the old code fails on NVIDIA too (sin 7,280 inputs over bound). The same commit found Mesa fusing
  `a + (b - a) * u` in compute's random uniform, which broke the README's promise of the same bits on every device; the
  product now goes through `pmHide`.
- **After (dense sweep, `baa66526`):** 573,720 inputs for sin, cos and tan and 298,646 extreme inputs for pow, 0 over
  bound on the Intel UHD and the RTX A6000. The pre-fix code on the Intel UHD: sin 1,791, cos 1,785, tan 642, pow
  147,647 over bound. The Radeon 680M sweep on main `650291de` was also 0 over bound (worst sin 0.743 of the bound, pow
  0.716; not committed).
- **Guard:** `tests/precise-math.test.js` and `packages/compute/tests/maths.test.js` run the WGSL through
  `reassociateMath` and fail if anything changes; `test:browser:reassociate` runs the GPU check with the folds applied,
  so the old code fails on any GPU; `test:browser:sweep` (0.5 s) runs in `check:merge` and the nightly run.
- **Rerun:** `npm run test:browser:sweep --workspace @margoengine/compute` and
  `npm run test:browser:reassociate --workspace @margoengine/compute`.
- **Still open:** what the extra work costs in the precise divide and `pow` is not measured
  ([known-bugs.md](../known-bugs.md#precise-maths-cost-against-the-wgsl-builtins-not-measured)).

### 38. A pinned proof failed on two machines because Node 22 and Node 26 compute `pow` differently

- **Symptom:** the `math-consolidation` proof passed on the main PC (Node 26.12, V8 14.6) and failed on the Ubuntu
  server and on a Windows mini PC, both on Node 22.22.1 (V8 12.4): 21 of 24 tape digests differed, although every call
  still matched its old copy.
- **Cause:** ECMAScript leaves the rounding of `**`, `Math.sin`, `Math.cos`, `Math.hypot` and the other approximated
  functions to the engine. V8 14.6 computes `**` with the C library's `pow` (`--use-std-math-pow`, on by default) and
  V8 12.4 uses its own, so `10 ** -5` differs, and so do 48 of the 256 bytes of the sRGB curve. The proof built its
  inputs with `10 ** x` and six tapes stored sRGB results. The engine code was correct.
- **Fix:** `ab27353f`. Inputs are built from exact operations only; during the proof, `sin`, `cos` and `hypot` come
  from versions built on `+ - * /`, `%` and `sqrt`; a taped call that uses another approximated `Math` function fails
  the proof. The golden digests were recaptured at the same reference, and a mismatch prints both hosts.
- **Guard:** `tests/proofs-golden.test.js`, including a replay under the other `pow` (`--no-use-std-math-pow` on Node
  26); CI runs it on Node 22.12.0 and 26.
- **Rerun:** `npm run proofs -- --current`, and `node --test tests/proofs-golden.test.js` on each Node.
- **What we got wrong:** the same hunt found that 14 test files use `using` declarations, which Node 22.22.1 cannot
  parse (106 to 110 unit tests failed). We first answered by declaring Node 24.18 for the repository (`6c289ed9`),
  which is right for contributors but left open what end users can run. Entry 41 settles that.

### 39. Flaky tests with one shared cause: timing that depends on machine load

Each of these passed alone and failed in a busy full run. In each, the fault was in the test or its harness.

- **lod, "per-frame selection allocates nothing":** read 5.9 MB of heap growth once in a full verify. The probe
  measured the shared test runner's heap, which other tests in the same process grow. Fix `6d08b0af`: the probe runs in
  a fresh process (`packages/lod/test/support/selection-heap-probe.mjs`), where the same 3,000-object loop grows by at
  most 30 KB, and a loop that does allocate is shown to fail it.
- **catalog, "searches, copies exact text":** failed on a clipboard mismatch under load. It read the Windows system
  clipboard, which every process and browser on the machine shares. Fix `6d08b0af`: a clipboard per page, and every
  step has a bounded limit (`tests/catalog.test.js`).
- **server-url, "a server that prints no URL in time fails":** its 300 ms limit started before the child process ran,
  and under eight-way load the child had not printed yet. Fix `3a59aa55`: the clock starts after the child's first
  line (`tests/server-url.test.js`).
- **controls walk, "no teleporting: 0.0715"** (limit 0.06 m): the check measured the eye's movement per frame, and the
  engine clamps one frame at 0.1 s, so a slow frame moves the eye further at the same walking speed. Fix `7714e84e`:
  the step is bounded per 1/60 s, and the page stalls one frame for 150 ms half-way up the stairs so the long-frame case
  runs every time (raw step 0.063 m, which the old check rejects; scaled step 0.039 m). Guard `109ec352`:
  `packages/controls/tests/walk.test.js` walks the house at 1/60, 25, 40 and 100 ms frames, and a 0.4 m jump still fails
  at every frame time.
- **The same class, two more causes found in these days:** browser suites that shared one Vite dependency cache, so one
  re-optimised it while another was loading (`7ab8cd13`: 3 of 30 page loads hung before, 0 of 40 rounds after; guard
  `tests/vite-cache-isolation.test.js`), and suites that waited silently for a fixed port held by another run
  (`6ddd733b`: the voxel path tracer's spec-math suite "needed 276 s", of which the check itself took about 5 s; guard
  `tests/browser-port-wait.test.js`).
- **What we got wrong:** we first blamed check timeouts on time spent queueing for the GPU lock. Measurement showed
  they were not lock waits: the causes were the fixed ports above and the GPU resets of entry 41.
- **Guard for the class:** `scripts/check-fixed-waits.mjs` (in `npm run verify`) fails on any new fixed frame count or
  sleep in a GPU or browser check unless it gives a reason; the existing ones are counted and the count only goes down.

### 40. Headless Edge picked the integrated AMD GPU when Remote Desktop was disconnected

- **Symptom:** after a reboot on 2026-10-27, headless Edge on the main PC (an NVIDIA RTX A6000 plus the AMD Radeon
  integrated GPU of its Ryzen 9 9950X) ran WebGPU on the AMD GPU. The visual check then looked for references for that
  GPU, which do not exist, so every `check:merge` failed there.
- **Cause:** Chromium's GPU process uses DXGI adapter 0, and WebGPU offers only that adapter. Windows lists first the
  adapter that carries the session's display output. While the Remote Desktop session was connected the A6000 carried
  it; while disconnected the order was AMD, A6000, then two software adapters. The check logs line up with the connect
  and disconnect times. `powerPreference`, `--force_high_performance_gpu`, `--use-webgpu-power-preference` and the
  Windows per-app graphics setting had no measured effect in the disconnected state.
- **Fix:** `85c96a55`. `scripts/lib/gpu-adapter.mjs` lists the DXGI adapters at launch (cached), skips software
  adapters and passes `--use-adapter-luid=<high>,<low>` in decimal for the hardware adapter with the most video memory.
  The LUID changes at every boot, so it is never hard-coded. `MARGO_GPU` and `MARGO_GPU_LUID` override it. The visual
  check prints the adapter it asked for and the one it ran on; a missing-reference message names the adapter, the
  committed profiles and the fix.
- **Guard:** `tests/gpu-adapter.test.js`, `tests/browser-selection.test.js`, `tests/visual-baselines.test.js`.
- **What we got wrong:** the first fix, `--force_high_performance_gpu`, passed a probe and then failed the next full
  check. We guessed the NVIDIA GPU was slow to wake under load; that was wrong. **Still unexplained:** before the
  reboot, checks got the A6000 overnight with the session disconnected.

### 41. NVIDIA driver resets during busy check runs: cause not found

- **Symptom:** the Windows System log on the main PC shows nine `nvlddmkm` event 153 entries on 2026-10-27 and 28
  (RTX A6000, driver 617.42, hardware-accelerated GPU scheduling on, Edge 156 headless), each while two or three
  `check:merge` runs shared the GPU. Each took the WebGPU device of one page, and a page asking for a device just then
  was refused ("D3D12 create command queue failed with E_OUTOFMEMORY" with 2 of 48 GB in use). The failing test was
  hit by the reset; it did not cause it. Before the fix, the page then waited out its ready timeout (120 s for a visual view, 30 s for
  a browser suite) with nothing naming the GPU, and one reset cost a whole `check:merge`.
- **What was measured:** event 153 is not the Windows GPU watchdog. A deliberate 3 s compute dispatch on the A6000 gives
  a WER `LiveKernelEvent` 141 report and a watchdog dump, and no event 153. The 141 reset is the worse one for
  correctness: WebGPU did not lose the device. `onSubmittedWorkDone` resolved at 2.3 s for a 3 s dispatch, and later
  dispatches and a new device worked, so the page got wrong results with no error. Only the event log shows it.
- **What we got wrong:** our first theory was the path tracer's long dispatches. We bounded them (`49dca9dd`: at most
  2^20 paths per dispatch, where a 4K frame was 8.3 million in one; same pixels, native4k frame time unchanged), which
  is right for slower GPUs, but two controlled exclusive runs gave 0 resets, and each reset hit one short page, not the
  long run. Also not the trigger, each tried under the GPU lock with a watcher sampling every second: killing the
  browser's GPU process mid-dispatch (15 times) or the whole browser tree (15 times), CDP `Browser.crashGpuProcess`
  beside a second busy browser (12 times), 300 device create and destroy cycles, 6 browsers dispatching back to back
  for 90 s, and long submissions against 2 or 3 other browsers.
- **Best evidence so far:** 8 of the 9 came while the Remote Desktop session was connected, when the A6000 also draws
  that session's desktop; 0 came in about 90 minutes of heavier load with it disconnected. The reset at 01:41:02 is the
  exception. **The cause is not found.**
- **Fix (to the checks, not the cause):** `49dca9dd` adds `scripts/support/device-loss.js`: a lost device fails the
  page's next wait at once. `51d8786a` adds `scripts/support/driver-resets.mjs`, which reads GPU driver resets from the
  Windows event log (NVIDIA, AMD and Intel driver errors, Display 4101, WER `LiveKernelEvent` 141 and 117), so the
  failure names the reset ("nvlddmkm event 153 at 01:21:49") or says that none was logged. A `check:gpu-packages`
  test, or any other `check:merge` step, that fails while the log shows a reset runs once more. The reset and the rerun
  are printed and kept as a receipt in `test-results/gpu-packages.json` and `test-results/check-merge.json`, and a
  second failure fails the check. A failure with no logged reset is never rerun. Since `6a8f7658`, a run that passed
  only through such a rerun says so: its summary ends with "PASSED WITH A DRIVER RESET" naming the step and the reset,
  and both result files carry `passedAfterDriverReset`.
- **Guard:** `tests/driver-resets.test.js`, `tests/device-loss-guard.test.js`, `tests/browser-startup.test.js`,
  `packages/voxel-pathtracer/tests/dispatch-budget.test.js`.
- **Not covered:** a watchdog reset that cuts work short and still lets a check pass is not rerun or reported by the
  checks; it shows only in the event log.
- **Next:** a day of checks with the Remote Desktop session disconnected, counting resets; if event 153 still comes, a
  newer NVIDIA driver, then a run with hardware-accelerated GPU scheduling off.

### 42. Node 22 for end users: shown to work, and two real bugs found

- **Decision (Scott, 2026-10-27):** people who use the packages must be able to run them on Node 22.12 or newer;
  contributors to the repository use Node 24.18.
- **Proof, `a4fca9be`:** on Node 22.12.0, `modern:test:packages --consumer` builds and packs every package, installs the
  tarballs into a clean project, type-checks the README examples, runs the consumer and the packed browser test, and the
  bundler matrix (Vite, webpack, Next.js with Turbopack and webpack, Rollup, esbuild) passes with Node 22.12.0 running
  the bundlers. `scripts/check-node-apis.mjs` parses every shipped source file and fails on a use of any of 33 APIs
  that Node 22.12 lacks (for example `Float16Array`, `Promise.try`, `RegExp.escape`) unless the code tests for it first.
  No unguarded use was found.
- **Unit tests, `86ed9107`:** the 47 packages whose code runs in Node have their tests run on Node 22.12.0 and the
  latest 22.x: 355 test files pass 5 of 5 runs on 22.12.0 (2,866 tests) and on 22.22.1 (2,873). The same files pass on
  24.18.0. On 22.12 seven splats tests skip with the reason given (their reference encoder, `node:zlib` zstd, arrives
  in 22.15). The React unit tests stay on Node 24: they depend on the timing of `node:test` module mocks.
- **Bug 1, `7f0dd465`:** netcode's `openWebSocket` hung forever on a refused connection on Node 22. Node 22's
  `WebSocket` fires only `error` and stays connecting, where browsers and Node 24 fire `error` then `close`, and
  `openWebSocket` settled only on `close`. It now rejects with code `failed` on `error` and closes the socket. Guard:
  `packages/netcode/tests/transports.test.js`.
- **Bug 2, `0687e6ec`:** data after the end of a compressed stream was accepted on Node 22. The Compression Streams
  standard says to reject it, and browsers and Node 24 do; Node 22.12.0 accepts it for `deflate` and `deflate-raw`,
  Node 22.22.1 for `deflate-raw`. So the FBX array reader, the ZIP reader in loaders (also used for TMX), the SOG ZIP
  reader in splats and the voxel chunk codec accepted malformed input there. `packages/shared/trailing-data.js` probes
  the runtime once per format and rejects such input where needed, for about 150 to 180 B gzip per affected entry.
  Guard: `tests/trailing-data.test.js` and the per-package tests named in the commit; fbx's own malformed-input test
  caught it.
- **Rerun:** `npm run test:node22` and `npm run check:node-apis` under Node 22.
- **Not done yet:** the new CI jobs have not run on GitHub; these results come from Windows. Linux on Node 22 has not
  been run.

### 43. Linux on a real Intel GPU

- **Setup:** an Ubuntu server with an Intel N100 and its Intel UHD GPU, Chromium on Mesa's Vulkan driver, Node 24.
- **First run (main `be072cdd`, 2026-10-27):** found the Mesa maths of entry 37 and a real engine bug. The voxel check
  "light removed should be dark" read a pixel that was exactly the clear colour: after an effect was removed,
  `VoxelRenderer` returned to a composition whose pipelines it had deleted and drew nothing while they compiled again
  (1 frame on the A6000, 2 on the Intel UHD). Fix `baa66526`: the last four compiled compositions are kept per target,
  and a composition is named by its effect objects, which also fixed a crash found on the way ("Clustered lighting is
  not attached" after one clustered light was replaced by another). Guard:
  `packages/voxel/tests/render-lighting-browser-check.mjs` and `packages/voxel/tests/render.test.js`. Removing an effect
  out of order still draws nothing for a frame or two ([known-bugs.md](../known-bugs.md#voxelrenderer-draws-nothing-for-a-few-frames-after-an-effect-is-taken-out-of-the-middle)).
- **Second run (main `b92998d6`, 2026-10-28, not committed):** of 43 package GPU suites, 42 were started, one at a time;
  38 passed. The text suite failed "Emoji not drawn in color": the server has no colour emoji font, and the test relies
  on one from the system ([known-bugs.md](../known-bugs.md#text-the-colour-emoji-check-needs-a-colour-emoji-font-on-the-machine)).
  The voxel, voxel path tracer and root browser suites were stopped by the heat watchdog at 82 C before they finished.
  **Those three have not been run on Linux;** they count as neither passes nor failures.
- **Why one at a time:** the server reached 94 to 96 C during a full `npm run verify` on 2026-10-27, so it runs no
  verify and no parallel GPU work.

### 44. An outside audit

- **What was done (2026-10-28, revision `74a01810`):** a source review, targeted canary tests on a second laptop
  (temporary files, mock fetches, fake sockets and loopback servers only; no public target and no production system),
  a full `npm run verify`, a short fuzz run and GPU checks (headless Edge 156, Intel Arc 140V).
- **Results:** 20 findings. `verify` passed: 6,344 of 6,346 tests, 0 failed, 2 skipped. The fuzz run covered 36
  targets. The audit also reproduced a known bug on a second GPU: the 4x MSAA blending variance, on the Arc 140V, 4
  frames of 450 differing at one pixel by up to 9 of 255
  ([known-bugs.md](../known-bugs.md#4x-msaa-blending-is-not-repeatable-rtx-a6000-under-cpu-load-and-intel-arc-140v)).
- **Evidence terms the audit used:** *reproduced* (a canary, fuzz case or GPU run showed the behaviour), *code
  confirmed* (the code path is there, no end-to-end trigger was run) and *project documented* (already in our
  known-bugs list).
- **Its stated limits:** the fuzz run was short (seconds per target); the live checks were local canaries only; there
  was no production test; and a passing verify does not show that there are no bugs.
- **Status on `main` (2026-10-28):** 16 of the 20 are fixed, each with a regression test that fails without the fix;
  1 (F20) is being fixed; 3 (F08, F09, F10) are limits the netcode room server does not have yet (netcode leaves
  authentication and network-level denial of service to the application), and proposals for them are with Scott. A
  finding is described here only once its fix is on `main`.
- **Fixed, by class:**
  - **Files outside their folder (F01, F02, F05), `4bc89574`.** margo-convert read a `.gltf`'s external buffer and
    image URIs relative to the model with no containment check, so `../`, absolute, drive and UNC paths and symlinks
    could pull files from outside the model's folder into the output; the stale-output cleanup deleted manifest paths
    joined to the output folder with no check; and the CLIs refused only an output string identical to the input, so
    `./file`, case aliases and links could overwrite it. Now `pipeline/paths.js` refuses any path that leaves its folder
    (lexically or through a link), a manifest naming such a path is treated as damaged and nothing it names is deleted,
    and `sameFile()` catches every alias. Guard: `tests/margo-convert-paths.test.js`.
  - **URL allowlist and redirects (F06, F07), `c6e7623c`.** An `allowedURLs` entry matched by string prefix, so
    `/assets` also allowed `/assets-other/`, and that branch skipped the encoded-separator check; and the final URL
    after a redirect was never checked for glTF buffers and images or FBX textures. Entries now match on a path
    boundary, encoded separators and dot segments are refused on both branches, and every redirect is checked against
    the same policy. Guard: `tests/security.test.js`, `packages/gltf-pro/tests/progressive.test.js`,
    `packages/fbx/test/loading-materials.test.js`.
  - **OBJ material libraries (F04, F17), `b96f5f40`.** `loadOBJ` fetched every `mtllib` named in the file with the
    caller's request options, so an absolute URL in an untrusted OBJ made a request to any host with the caller's
    headers and credentials, and the libraries had no total budget. Libraries and textures now resolve only inside the
    OBJ's folder or an `allowedURLs` entry, request options go only to the OBJ's own origin, and the libraries share a
    count and byte budget. Guard: `packages/loaders/tests/mtl.test.js`.
  - **Room set-up and failing hooks (F11, F12), `158076f1`.** A netcode room was joinable before its `onCreate`
    finished, and a throwing `onCreate`, `onJoin` or message handler left the connection hanging or escaped as an
    unhandled rejection. Rooms are now listed only after `onCreate`, and a failing hook closes that client with
    `CloseCode.error` and reaches `RoomServer.onerror`. Guard: `packages/netcode/tests/rooms.test.js`.
  - **WebSocket framing (F18, F19), `6bebf878`.** The Node WebSocket server counted control frames against a fragmented
    message's size limit, so a legal ping could close the connection, and both transports cut close reasons by
    characters, not UTF-8 bytes, so a multibyte reason made an oversized control frame. Guard:
    `packages/netcode/tests/transports.test.js`.
  - **voxel-net join (F14, F15), `8c8b51a0`.** A message that arrived in the same TCP write as the upgrade was dropped,
    so the player was cut after 10 s, and a chunk whose generation failed was never asked for again, so a player who
    did not move never spawned. Early messages are now kept and delivered in order, and failed chunks are retried, then
    reported with a close code naming the chunk. Guard: `packages/voxel-net/tests/websocket.test.js` and
    `server.test.js`.
  - **voxel-net server limits (F03, F13, F16), `ddc5c5ff`.** The voxel-net prototype had no authentication, gave every
    socket a client object and a timer before it checked the player cap, and kept every edited chunk in memory. It now
    caps connections that have not joined (in total and per address) before answering the upgrade, accepts only pages
    from its own host by default (a breaking default; `origins: '*'` restores the old one), runs an `authenticate` hook
    on the upgrade and the hello, and bounds edited chunks in memory, moving the least recently edited to a
    `VoxelEditStore`. Guard: `packages/voxel-net/tests/limits.test.js`.
- **What we got wrong:** our own security review and fuzzers had not found these.

## Open losses

These are measured but not fixed. Each is tracked in [known-bugs.md](../known-bugs.md#performance-losses-still-open).

- **three.js `InstancedMesh` against Margo's instanced paths: partly closed.**
  - Before: [boxes-vs-threejs.md](boxes-vs-threejs.md), "Instanced <-> instanced";
    `examples/package-benchmarks/results/vs-threejs-boxes-pairs.json` (diagnostic, busy machine, Arc 140V). At 10k
    boxes three.js WebGL2 `InstancedMesh` reached 645 FPS, Margo `createInstancedMesh` 212 FPS and `CulledInstances`
    270 FPS; moving `CulledInstances` took 187 ms CPU per frame for 10,000 boxes.
  - Causes and fixes (2026-10-25): `CulledInstances` drew with the pipeline that keeps the back-face discard (now
    core's back-culled variant), wrote two buffers per moved part (now one upload per frame) and computed bounding
    spheres on the CPU (now in the cull pass); a plain `Material` read ten textures per fragment (now none);
    `Quaternion.setFromEuler` is closed form.
  - After: [boxes-vs-threejs.md](boxes-vs-threejs.md), "Instanced: fixes and what is left" (RTX A6000, diagnostic;
    `benchmarks/records/20261025-073632-e166a074-dev.json` before, `20261025-104804-26e20b90-dev.json` after). At 50k
    static boxes `CulledInstances` reached 2,443 FPS and 0.300 ms GPU against three.js WebGL2's 2,024 FPS and 0.472 ms;
    moving `CulledInstances` (10k) went from 13.6 to 1.34 ms CPU per frame.
  - Rerun: `npm run bench -- instanced --engines=margo,three-webgl,three-webgpu --runs=3`.
  - Guard: `packages/culling/test/culling.test.js`, `packages/materials/test/materials.test.js`,
    `packages/math/test/euler-quaternion.test.js`, `packages/gltf-pro/tests/instancing.test.js`.
  - Still open: `createInstancedMesh` vertex fetch at 10k-50k, the 1k GPU cost of a package pass, and CPU for moving
    instances. Each is in [known-bugs.md](../known-bugs.md#performance-losses-still-open).
  - [claims.md](claims.md) records that there is no publishable result yet.
- **STL import and USDZ export against three.js: partly closed (entries 26 and 31).** `p-stl` (the plain `parseSTL`)
  4.7 ms against 2.7 (accepted difference in work, see entry 31; with three's `computeVertexNormals()` on both sides,
  `p-stl-normals`, Margo is 4.7 against 8.7 ms, faster): it computes the flat normals the file leaves zero, where three copies the zeros.
  `p-export-usdz` 16.0 ms against 2.5 (run `20261026-165034`, diagnostic): `exportUSDZ` writes every mesh in world
  space (2.46 MB) where three's archive is 444 KB. Causes and plans:
  [known-bugs.md](../known-bugs.md#stl-import-still-computes-normals-threes-stlloader-leaves-zero) and
  [the USDZ entry](../known-bugs.md#usdz-export-writes-every-mesh-in-world-space).
- **Galaxy S23 Ultra island demo.** A report of 3–5 FPS on that phone, with particles off making no difference.
  - Partial fixes: `909e384a`, and `1c627cdc` (scatter compiles the fade `discard` only when instances can fade).
  - No after number is recorded. The project has no S23 to test on.

## Re-measure in the quiet-machine run

These entries lack a recorded number, a named machine or a quiet run:

1. Shadow casters (entry 1): before and after on a named machine with nothing else running.
2. Back-face culling, boxes (entry 2): a quiet run instead of the diagnostic busy-machine numbers.
3. CAD 10k single-sided (entry 3): a quiet run.
4. gltf-pro plain materials (entry 5): the after time on DamagedHelmet.
5. Kernel snapshot compare (entry 8): before and after with the machine and a committed result.
6. three.js `InstancedMesh` against Margo instanced (open loss): a quiet run once the fix lands.
7. Galaxy S23 Ultra island (open loss): an after number, which needs the device.

[reproduce.md](reproduce.md) has the commands for the rest of the measured claims.
