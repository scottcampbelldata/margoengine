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

### 4. AssemblyBVH rebuild at 7,560 parts

- **Loss:** a rebuild took 1,399.9248 ms.
  - Node v24.15.0 with a fake renderer, on AC power.
  - Source: `examples/package-benchmarks/proofs/results/machinery-cad.json`, `baselineMs`.
  - The first record, in `7419fd44`, had 801.6726 ms (no AC note).
- **Cause:** the BVH flattened every instanced triangle into world space and built one Wasm BVH over all of them.
  - Every transform change needed a full rebuild.
  - Assemblies above 1,000,000 instanced triangles were refused.
- **Trade-off:** there is now one local-space BVH per distinct geometry, with a per-part bounding-sphere pass.
  Raycasts at this size are about 2x slower, per [cad-performance.md](../cad-performance.md).
- **Fix:** `7419fd44` two-level assembly BVH; re-measured on AC in `1c3e8757`.
- **After:**
  - 3.4799 ms, a speed-up of 402.289x (same file, `candidateMs`).
  - The first record had 2.1594 ms (371.248x).
  - At 89,883 parts: rebuild 40.795 ms, raycast 0.595 ms.
- **Rerun:** `node examples/package-benchmarks/proofs/machinery-cad.proof.js` (also run by `npm run proofs`).
- **Guard:** `examples/package-benchmarks/proofs/machinery-cad.proof.js` and `tests/modern-machinery-runtime.test.js`.

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
  demo builds dropped about 7.79 MB of CAD code each (commit message).
- **After:** 14/14 pages pass (same message). The current record is
  `examples/package-benchmarks/results/csp-check.json`.
- **Rerun:** `node scripts/csp-check.mjs`.
- **Guard:** `tests/no-eval-workers.test.js`.

## Open losses

These are measured but not fixed. Each is tracked in [known-bugs.md](../known-bugs.md#performance-losses-still-open).

- **three.js `InstancedMesh` beats Margo's instanced paths on static boxes.**
  - Source: [boxes-vs-threejs.md](boxes-vs-threejs.md), "Instanced <-> instanced";
    `examples/package-benchmarks/results/vs-threejs-boxes-pairs.json` (diagnostic, busy machine, Arc 140V).
  - At 10k boxes: three.js WebGL2 `InstancedMesh` reached 645 FPS, Margo `createInstancedMesh` 212 FPS and
    `CulledInstances` 270 FPS.
  - Neither Margo instanced path gets core's culled pipeline: `createInstancedMesh` uses gltf-pro's heavier PBR shader,
    and `CulledInstances` draws with culling off plus the `discard`.
  - [claims.md](claims.md) records that there is no publishable result yet. Work is in progress.
- **Moving `CulledInstances`.** `setTransform` makes one 64-byte write per part: 187 ms CPU per frame for 10,000 moving
  boxes (same source, diagnostic).
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
