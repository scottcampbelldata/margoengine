# Deferred speed phase

- Batch 165 job 1, row 10.21 / p-cube-lut: Cube parsing work-count and byte-identity proof is built in packages/tonemap/tests/cube-workcount.test.js. Keep the existing scene, both rival backends and budgets for tonight's quiet rerun. See docs/whitepaper/batch-165-workcounts.md; the historical 2.61x loss is not replaced by a speed claim.

Scott's ruling, 2026-11-10: finish building before running speed work. The single
checked-in default is `scripts/speed-phase.json` (`deferred`). Verify, check:merge,
check:readme-run, direct benchmark entries and timing requests read this phase.
No benchmark or paired wall-clock A/B is run to validate this change.

`npm run test:speed -- --list` lists the named suite without running it.
`npm run test:speed` reports deferral in the build phase. Only after Scott ends
the build phase, set `MARGO_SPEED_PHASE=active` on a quiet machine and run the
whole suite. The inventory must pass before release, together with an empty
`busy-retests.md`. Each command has a hard process-tree limit; GPU holds retain
their separate 20-minute cap. External rival repositories/fixtures stay outside
Margo, and each command retains its existing prerequisite/options documentation.

Correctness, value/error checks, deterministic work counts (including byte,
allocation, draw, triangle and pass counts), clock semantics and timeout safety
remain live. Local CI per-commit duration history and its 1.5x jump flag remain
enabled. Protocol timeout bounds such as the 250-1500 ms forwarding timeout are
safety semantics, not a speed budget. Deferral is explicit, never `test.skip`,
never a replacement passing number, and never a raised budget.

## Retained cases and budgets

Batch 21 job 5: the integrated-GPU `visual:compat:budget` record remains owed,
explicitly deferred on 2026-11-10. Use the AMD Radeon 680M, all existing demos
and native/compat pairs, in chunks of 8. Preserve the existing failure predicate
(median main-thread work above 50 ms AND above twice native, with missing or
nonfinite measurements failing), and record GPU
identity, browser/ANGLE backend, commit, CPU load and every result. No run or
measurement is claimed during the build phase. Details: `busy-retests.md`,
"Batch 21 job 5: integrated GPU frame budget owed".

Batch 134 ETC2/EAC continuation retains cold/warm per-file/per-target timing,
startup, peak memory and final optional-entry proof for the quiet phase.
The initial unmasked EAC campaign was deliberately interrupted before its
900-second correctness cap to remove redundant work; it was not a completed
or passed campaign or a hang. The exact mask implementation keeps that full
corpus and cap, with byte-identical retained payloads and independent header
oracles. The measured work count is 79,844 versus 5,898,240 full palette
constructions on 90 nonconstant oracle blocks, including new seed work and
excluding the unchanged constant path. No wall-clock A/B, benchmark, timing-only
assertion or exclusive GPU was run. This does not satisfy the deferred speed bar.

Budgets below are unchanged. Mixed-file assertions live in
`scripts/speed/budgets.mjs`; pure speed callbacks register through `speedTest`
only in the active named suite. Scenes, seeds, warmup and repeats stay unchanged
for speed runs; correctness continues to exercise its values and work counts.

| Suite or case | Source | Original measurement / budget |
| --- | --- | --- |
| time budget: one default 256 m tile at 1 m in under 150 ms of CPU (measured about 30 ms on the reference PC) | `packages/biomes/tests/climate.test.js` | <150 ms CPU per tile |
| time budget: an undo and a 50 m dab take under 2 ms of CPU, far inside one 60 Hz frame, before tiles are remade | `packages/biomes/tests/editor.test.js` | dab <2 ms and undo <2 ms CPU |
| time budget (G1): one preset forest tile placed in under 150 ms of CPU on one thread (measured about 30 ms on the reference PC) | `packages/biomes/tests/placement.test.js` | <150 ms CPU per placement tile |
| removing many meshes does not scan every slot per mesh | `tests/core-remove-children.test.js` | <150 ms CPU for 30,001 removals |
| benchmark: chunk and world get/set throughput (printed) | `packages/voxel/tests/benchmark.test.js` | printed throughput, no numeric budget |
| benchmark: chunk, block-change and entity codecs (printed) | `packages/voxel/tests/codec-benchmark.test.js` | printed throughput, no numeric budget |
| benchmark: torch in open air and a 32-wide roof removal (printed) | `packages/voxel/tests/light-benchmark.test.js` | printed throughput, no numeric budget |
| a roof removed and put back: page milliseconds with VoxelLighting and with VoxelLightWorker | `packages/voxel/tests/light-worker-benchmark.test.js` | printed throughput; light-worker also requires posted + written < flood |
| benchmark: meshChunk per random-terrain chunk and per worst-case checkerboard (printed) | `packages/voxel/tests/mesher-benchmark.test.js` | printed throughput, no numeric budget |
| benchmark: VoxelMesher meshes per second with 1, 2 and 3 workers (printed) | `packages/voxel/tests/mesher-worker-benchmark.test.js` | printed throughput, no numeric budget |
| frame cost while generated chunks arrive (printed) | `packages/voxel/tests/stream-benchmark.test.js` | printed throughput, no numeric budget |
| generation benchmark (printed) | `packages/voxel/tests/stream-benchmark.test.js` | printed throughput, no numeric budget |
| benchmark: ray casts, sweeps and character updates (printed) | `packages/voxel/tests/query.test.js` | printed rays/sweeps/updates throughput |
| geometry-edges | `packages/geometry/tests/edges.test.js` | <150 ms CPU on 8,385 vertices |
| geometry-triangulate | `packages/geometry/tests/triangulate.test.js` | <150 ms CPU |
| geometry-circle | `packages/geometry/tests/triangulate.test.js` | CPU <2.5 * noisy ring +50 ms; same 100k and 65,536 points |
| geometry-inputs | `packages/geometry/tests/triangulate-inputs.test.js` | <1500 ms CPU to reject invalid input |
| biomes-object-allocation | `packages/biomes/tests/objects.test.js` | <100 ms CPU to reject oversized detail |
| biomes-wide-road | `packages/biomes/tests/splines.test.js` | <200 ms CPU |
| biomes-wander-road | `packages/biomes/tests/splines.test.js` | <800 ms CPU |
| points-las | `packages/points/tests/las.test.js` | <150 ms CPU for fuzz cases |
| points-e57 | `packages/points/tests/e57.test.js` | <300 ms CPU for fuzz cases |
| points-laz | `packages/points/tests/laz.test.js` | <8000 ms CPU for fuzz cases |
| tiles-fuzz | `packages/tiles/tests/tiles.test.js` | <150 ms CPU |
| wgsl-fuzz | `packages/webgl2-compat/test/wgsl-fuzz.test.js` | <400 ms CPU per contract |
| loaders-xml | `packages/loaders/tests/loaders.test.js` | <150 ms CPU for 200k attributes |
| security-stl | `tests/security.test.js` | <150 ms CPU for 200k unterminated facets |
| fuzz-parsers | `tests/fuzz-regressions.test.js` | per-case original budget (default 600 ms CPU) |
| materials-half | `packages/materials/test/texture-formats.test.js` | <120 ms CPU for 4,194,304 values, native true and false |
| environment-exr | `packages/environment/tests/environment.test.js` | parse < per-texel half conversion, best of 9 alternating rounds |
| exporters-writer | `packages/exporters/tests/exporters.test.js` | writer < search, best of 9 alternating rounds |
| exporters-usdz | `packages/exporters/tests/exporters.test.js` | USDZ <10 * control unit, best of 15 alternating rounds |
| netcode-rtt | `packages/netcode/tests/transports.test.js` | <250 ms localhost RTT |
| sandbox-finds | `examples/voxel-sandbox/test/finds.test.js` | <1000 ms, seeds 1, 2 and 3 |
| quickstart | `scripts/quickstart-timing.mjs` | <300 s default to verified interactive frame |
| biomes-slow-sends | `packages/biomes/tests/flythrough-speed.mjs` | max <=2 ms send +1.5 ms |
| biomes-flight-p99 | `packages/biomes/tests/flythrough-speed.mjs` | added p99 <=0.3 ms; original settle function |
| biomes-flight-max | `packages/biomes/tests/flythrough-speed.mjs` | added worst <=1 ms; original settle function |
| biomes-camera01 | `packages/biomes/tests/objects-frame-speed.mjs` | <=0.7 * RTX A6000 baseline (19.8/53.2 ms) |
| biomes-camera02 | `packages/biomes/tests/objects-frame-speed.mjs` | <RTX A6000 baseline (23.4/63.4 ms) |
| biomes-far-forest | `packages/biomes/tests/objects-frame-speed.mjs` | <=1 ms, median of 3 alternating pairs |
| sandbox-figures | `examples/voxel-sandbox/test/play.browser.mjs` | mean <4 ms for 200 figures over 2,000 updates |
| proof-speedup | `examples/package-benchmarks/proofs/compare.js` | speedup >=1; original warmup 3, A B B A rounds=12 default; per-proof rounds retained |
| biomes-copy-packing | `packages/biomes/tests/flythrough-speed.mjs` | 0 frames stopped copying with <0.25 ms used while steps wait; detail writes delayed 1 ms |
| biomes-flight-samples | `packages/biomes/tests/flythrough-speed.mjs` | each streamed sample has >600 real-time frames; 3 streamed/prefetched alternating flight pairs |
| voxel-physics | `packages/voxel/tests/physics.test.js` | printed collider timings; pure benchmark speedRtest deferred, triangle/cell work assertions live |
| voxel-million | `packages/voxel/tests/vox.test.js` | printed parse/write and best-of-3 batched/setBlock comparisons; equality scene remains live once |
| sciviz-million | `packages/sciviz/tests/graph.test.js` | printed ms per step, no speed threshold; finite values and movement remain live |
| grass-frame-diagnostics | `scripts/modern-grass-tests.js` | 100k and 500k blades, 90 completed GPU frames after warmup; median and p95, no numeric budget |
| hierarchy-frame-diagnostics | `scripts/modern-finalization-tests.js` | 10k hierarchy parts, 70 frames (10 warmup); CPU/GPU median and p95, no speed threshold; draw/visible/frame counts live |
| dof-route-diagnostic | `scripts/modern-postfx-tests.js` | printed per-frame cost; no threshold; fragment/CPU dispatch correctness live |
| boulder-diagnostics | `scripts/test-boulder-browser.mjs` | 2 s GPU submission window and 1.5 s solver window; no speed threshold; pass-count assertions live |
| desktop-cadence | `scripts/desktop-demo-tests.js` | 3 s native callback cadence, no FPS threshold; pixels and controls live |
| shadows-cost | `packages/shadows/test/cutout-casters-browser.mjs` | --cost paired caster frame costs, no threshold; default pixel regression remains shared |

## Standalone speed commands

The executable manifest is `scripts/speed/suites.json`. Unless a budget is
named below or above, the entry prints measurements without a numeric threshold.
The commands preserve the existing workload and its correctness assertions.

| Entry | Budget / comparison |
| --- | --- |
| `bench/cli.mjs` | all suites/cases; existing baseline regression threshold 5%, noise threshold 10%; suite options unchanged |
| `examples/voxel-sandbox/bench.mjs` | printed timing/throughput; no numeric speed budget |
| `examples/voxel-sandbox/test/shard-bench-blocks.mjs` | printed timing/throughput; no numeric speed budget |
| `examples/voxel-sandbox/test/shard-bench-process.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/behavior/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/bvh/scripts/bench-line-pick.js` | printed timing/throughput; no numeric speed budget |
| `packages/bvh/scripts/bench-models.js` | printed timing/throughput; no numeric speed budget |
| `packages/bvh/scripts/bench.js` | printed timing/throughput; no numeric speed budget |
| `packages/compute/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/decoders/scripts/meshopt-simd-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/ecs/scripts/bridge-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/ecs/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/fsm/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/geometry/scripts/polygon-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/lightmap/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/navmesh/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/netcode/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/oit/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/points/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/scene/scripts/bulk-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/sciviz/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/sky/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/splats/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/staging/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/tiles/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/tween/scripts/rival-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/vfx/test/bench-soft.mjs` | printed timing/throughput; no numeric speed budget |
| `packages/wfc/test/heap-bench.mjs` | printed timing/throughput; no numeric speed budget |
| `scripts/benchmark-built-package-workloads.js` | strict-target option retains first/interactive 1000 ms and steady 60 Hz targets; original controls and workload counts |
| `scripts/benchmark-bvh.js` | printed timing/throughput; no numeric speed budget |
| `scripts/benchmark-net.js` | printed timing/throughput; no numeric speed budget |
| `scripts/benchmark-package-workloads.js` | strict-target option retains first/interactive 1000 ms and steady 60 Hz targets; original controls and workload counts |
| `scripts/benchmark-road.js` | printed timing/throughput; no numeric speed budget |
| `scripts/benchmark-vfx-island.js` | printed timing/throughput; no numeric speed budget |
| `scripts/benchmark-vfx-memory.js` | printed timing/throughput; no numeric speed budget |
| `scripts/benchmark-vfx-render-chain.js` | printed timing/throughput; no numeric speed budget |
| `scripts/visual-compat-budget.mjs` | 50 ms median frame default, same demo scenes/chunks |

The worker subprocess `shard-bench-process.mjs` is covered by its parent and is
also guarded against standalone measurement while deferred. The release suite
does not enable the phase itself. A failure keeps its original budget and must
be repaired in its owning package; a busy-machine retest is recorded only under
the existing busy-retest policy, after the build phase ends.

## Additional benchmark entries and historical proof scenes

The following entries use the same switch. Deterministic proof output and work
counts remain enabled; common proof `time()` never calls either measurement
callback during deferral. Historical speed reports are not overwritten with
missing or fabricated timings. Pinned proof runs retain their original history
and fixture requirements. A missing prerequisite is unresolved release evidence.

| Entry | Original measurement / budget |
| --- | --- |
| `bench/biomes/placement.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `packages/voxel-pathtracer/bench/run.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `packages/webgl2-compat/test/perf-browser.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/ecs-growable.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/exporters-model.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/large-coordinates.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/scatter-cull-gpu.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/shadow-shimmer.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/textured-instancing.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/tier-presets-gpu.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/transforms-budget.mjs` | 4 ms median CPU per moving-transform frame default; original capacity search and warmup |
| `examples/package-benchmarks/vfx-gpu.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/vfx-island.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/walk-cpu.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/gates/dof.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/gates/memory.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/gates/post-stack.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/parts/collect-node.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/parts/culling.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/parts/kernel-node.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/parts/kernel-quick.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/parts/remove-node.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/parts/scale-node.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/progressive/run.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/workers/run.mjs` | printed measurements; original scenes/options retained, no new speed threshold |
| `examples/package-benchmarks/proofs/animation-vat.proof.js` | 23 frames, 3 warmup, crowd counts 100/1000; printed update/render/bake CPU time, no threshold; draw/allocation counts remain live |
| `examples/package-benchmarks/proofs/materials-atlas.proof.js` | 256 boxes, separate/shared/merged; 60-frame median, no threshold; draw/allocation counts remain live |

`release:check` and `test:release` require `speed-suite --release`, which refuses
to pass during deferral. An active release run must execute the full manifest;
no gate silently enables the phase.

| Historical proof (same original cases) | Original speed requirement |
| --- | --- |
| `examples/package-benchmarks/proofs/animation.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/animator.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/bvh.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/creative.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/decoders.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/ecs.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/exporters.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/geometry-subdivide.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/geometry.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/gltf-pro-lighting-hooks.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/gltf-pro.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/gltf.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/labels.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/loaders.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/math-consolidation.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/navmesh.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/points.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/post.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/procedural-deps.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/road.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/splats.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/splines.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/taa.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/terrain.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/text.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |
| `examples/package-benchmarks/proofs/wfc.proof.js` | original warmup/rounds; speedup >=1 for `record()` proofs, printed times otherwise |

Every build-phase exclusive request is refused and logged before queue/holder
creation. Only the coordinator, with Scott's OK, may add an exact command, reason,
approvedBy and future expiry to `scripts/gpu-exclusive-allow.json`; it is empty.

## Sciviz deferred speed evidence

Scott deferred all benchmarks, paired wall-clock A/Bs, timing-only assertions and exclusive GPU use during
the build phase (2026-11-10). Correctness gates still run under the shared GPU lock.

- Batch 171 moving-flow continuation: GPU positions/history stay resident during advance/draw, with zero position
  readbacks until explicit inspection. Streaklines load/copy a field once for all releases (mocked instantiation
  work-count regression). Full particle/trail throughput, recovery cost, CPU streakline throughput and rival
  comparisons on the NOAA daily-mean scene remain for the quiet speed phase; no timing proof is claimed.
- Batch 171 flow foundation: CPU arithmetic is in one feature-local Rust/Wasm module, with one reservation,
  no allocator calls during integration and chunks of at most 128 RK4 steps. No speed or SIMD gain is claimed;
  comparison with an equivalent scalar reference and any SIMD throughput proof belong to the deferred speed phase.
- Batch 181 CPU marching-cubes foundation: retain the existing scalar/SIMD output equality and case/triangle
  work evidence. A consistent end-to-end extraction gain still needs the quiet speed phase; no new A/B ran
  after deferral and no public ratio is claimed.
- Batch 181 native surface/rectangle drawing: every `(nx-1)*(ny-1)` cell draws six vertices without a CPU
  expanded mesh; rectangle instances retain all four bounds and one packed colour (20 bytes/rectangle).
  Surface input texture is 4 bytes/sample plus the 1,024-byte colour map. These are work/storage counts,
  not speed measurements. Frame-time, scale-limit, GPU-memory and cross-backend speed evidence remain owed
  after the build phase. No workload was narrowed and no timing budget changed.


### LOD mixed correctness/benchmark page

The inherited `lod/test:gpu` command included a benchmark in `browser-check.mjs`,
which the exclusive/timing-assertion selector did not detect. One continuation
invocation reached that mixed check before this was found; its timing output is
not accepted or published. The normal gate now calls `correctness(120)`, retaining
the same 140 rendered frames in each of three modes and every existing pixel,
visibility, level and error assertion. No clock is read. The page's original
measurement path remains behind explicit `?benchmark=1` for the future speed
phase, including bake timing. `correctness-without-timing.test.js` executes the
real HTML fixture with a clock that throws and checks all 426 renders and one
bake; it fails on the original fixture. Both LOD's GPU command and the full
compatibility command reuse that corrected default check.

## Preview contract continuation, 2026-11-10 restart

Scott forbids speed and timing tests during this continuation. No new timing
result is claimed and no threshold is changed. Before the mainline speed split,
the restart deferred these mixed GPU commands:

- clustered/test:gpu
- materials/test:gpu:cutout-casters
- shadows/test:gpu:cutout-casters

All three call packages/shadows/test/cutout-casters-browser.mjs. Mainline now
separates its optional `--cost` measurement from the default correctness route.
Their default pixel checks can run shared during the build phase; the original
cost workload remains deferred until Scott ends the restriction. This entry
records the earlier boundary, not a performance improvement or an accepted
regression. All other named speed budgets above remain in force.


Preview landing follow-up: the default cutout-caster command now passes on native
WebGPU and full compatibility, once per backend for all three identical package
aliases above. Only the optional --cost route remains deferred. The LOD default
browser check also passes with its original pixel/visibility assertions and no
measurement clock. No timing result is claimed.

### Skip-audit batch 108 job 2

Historical 83 ms versus 67 ms remains an open elapsed-time loss. The same
100 captured queries now read 16 rather than 1,600 matrix components and submit
once rather than 100 times. Horizontal micro misses read 3,200 rather than
6,400 components with identical arithmetic, queries and results. GPU equivalence
and all correctness cases run by default. The optional model latency loop needs
--time and belongs to the quiet speed phase after Scott ends the build phase.
No elapsed speed win or accepted slowdown is claimed from these work counts.

## Batch 134 retained timing proof

The rational-source experiment adds a second complete fitting objective after
the byte fit and retains fixed block scratch, with no speed acceptance. Its
negative source-quality evidence does not discharge any timing or memory debt.
No benchmark, timing A/B or timing-only assertion ran for this experiment.

Scott's 2026-11-10 build-phase ruling defers benchmarks, paired wall-clock A/Bs and timing-only assertions until
he starts the speed phase. Correctness evidence and deterministic work counts continue; correctness GPU gates use
shared locks. Retain historical timing records, without treating them as fresh acceptance evidence.

| Work | Evidence retained | Timing proof still owed before release |
|---|---|---|
| Batch 134 clean-room Basis replacement | Existing prebuilt baseline, active 51-file corpus, 699 served file/target pairs and 9,491 image hashes; private replacement remains incomplete. No new wall-clock A/B was run in this continuation. | Interleaved old/new cold and warm per-file/per-target rounds with per-round minima and spread; isolated compile, instantiate, startup and first-call timings; match or beat each required old target. Run only when Scott ends the build phase. |

Raw/gzip entry and Wasm size, peak memory, exact output, source-quality, hostile-input and GPU correctness bars
remain required. The deferred timing work does not mark Batch 134 jobs 2-5 complete or authorize prebuilt removal.
## Skip-audit work counts and pending timing evidence

| Item | Evidence available | Quiet speed-phase work still owed |
| --- | --- | --- |
| Batch 108 job 2, selection pickMany | Same 100 answers/copies; captured matrix reads 1600 to 16, submissions 100 to 1; rejected micro matrix reads 6400 to 3200 | Reproduce the unchanged 100-pick workload against the parent and like-for-like rival routes; attribute or fix the historical 83 ms versus 67 ms loss. No new timing run during build phase. |
| Batch 61 job 6, erosion Wasm | Exact 32-round 2048x2048 real-DEM hashes; 10n fewer kernel array bytes, n/4 SIMD difference blocks; input/readback adds 21n bytes | Paired CPU/Wasm elapsed comparison at identical output and full copy cost after Scott ends the build phase. No elapsed win or total memory win is claimed. |

Selection's model browser suite runs all correctness comparisons by default.
Its optional latency loop requires `--time` and an exclusive outer GPU lock;
it is not run during this build phase. Reproduction in the later speed phase:
`node scripts/gpu-lock.mjs run --exclusive --owner=codex-skipgaps --wait-max=60 -- node packages/selection/test/models.browser.mjs --time`.


## Batch 273 job 4: WebGL2 layer against the rival WebGL2 renderer

Deferred by Scott's build-phase instruction. No speed run, paired wall-clock A/B,
timing assertion or exclusive GPU hold is authorized during this phase. This is
pending speed evidence, not a passing benchmark or a claim of parity in speed.

Retain `bench/scenes/catalog.js` and `bench/scenes/parity.js` as the scene sources:
`STANDARD.render` (10,000 boxes, materials, lights, shadows, post),
`STANDARD.instanced` (1,000/10,000/50,000 static boxes and 10,000 moving boxes,
instanced and culled), `STANDARD.dynamic` (10,000/100,000/250,000 moving boxes,
all existing matrix, row, instanced, mesh and static controls), and the existing
renderable `parityCases` rows. Preserve geometry, textures, lights, shadow work,
camera paths, seeds, resolution and samples. Never reduce work to match a rival.

The quiet phase still owes an optional compatibility-layer bench runner, outside
core/stage, and like-for-like rows against `three-webgl-parity` run in its own
external repository. Identify actual native/layer/rival backends in every result;
default CLI settings remain 5 runs, 1 warmup, 300 frames, 0.1 noise and 0.05
regression threshold. Publish CPU/GPU/frame, memory, download bytes, draw/pass and
allocation counts with output comparisons. Include every loss and accepted work
difference, plus a like-for-like row, in the whitepaper perf files and reproduce.md.
Only Scott can end deferral; no new speed number or rival-performance claim exists.

## Compute mixed-browser throughput continuation

`packages/compute/tests/compute-browser.mjs` is now a named release suite entry.
The default correctness run prints deferral and reports empty throughput timings;
it still executes every value/error check, all permitted 2M SAXPY candidates,
all four 512-square grids and all five 300,001-element own-kernel settings.
Scripted-device clock/cache tests remain enabled.

Retained unchanged for the active phase: 1M-element sum, fused mean, scan,
sort, argsort and 256-bin histogram (warmup plus five rounds); 1024-cubed
matmul, 2^20 FFT and 2^24 normals (warmup plus five rounds); GPU/CPU 1M sort
and sum and 256-cubed matmul (warmup plus three rounds); 256-square Poisson CG
(warmup32 then tol1e-5); 2M SAXPY hardware autotuning and store/cache reuse;
512-square grid autotuning with [[8,8],[16,16],[32,8],[64,1]] and three trials;
16M-element tuning of reduce/scan/sort, chosen-minimum consistency and the final
5,000-element sum. There is no new speed target or raised budget. Only Scott
ends deferral; the full named suite remains required before release.


### Quality triangle timestamp acceptance

Named suite: packages/quality/test/browser-check.mjs. Retain the exact
0 < p90 < 7 ms GPU timestamp budget, 640x360 canvas and 400-instance triangle,
plus the old submit-to-done p90 diagnostic on the same frames. Wall-clock
instrumentation and the 7 ms assertion run only in the active speed phase.
Real timestamps, tier storage/next-load selection and wrapper cleanup remain
live correctness. No speed run occurred during this continuation.

- Deferred core one-pass item: lane-K measurement d1c55001c and docs a5877f3f1 remain on the branch in margoengine-lane-K; A6000 gain beyond spread, AMD within spread; core change waits for the speed phase and Scott's OK.

Batch133 still owes whole-corpus per-file cold/warm decode minima, compile/
instantiate/startup timings and resolution of every retained warm loss against
the prebuilt. Non-timed RSS and cold work counts do not substitute for those
targets. Both default prebuilts and removal job5 wait for passing speed phase.

Batch 252 job 4: quiet-machine end-to-end navmesh build and tiled build worker startup/transfer/codec/raster/polygonization timings against the TypeScript builders. All polygons must remain byte-identical. Current evidence is deterministic: equal cell/intersection work and three vector plus three scalar interpolation operations instead of nine scalar operations per intersection. No wall-clock A/B ran in the build phase.

Batch 171 atmosphere: NOAA globe with 2048 wind particles and 32 history samples, scalar shell and 100 km glyphs; 24-step data aerial segments, 32-step background, cached 256x64 transmittance and 32x32 multiple-scattering tables. No wall-clock budget is invented during build; establish the quiet-machine tier budget and compare equal-work variants before release. No timing or speed assertion ran in this job.
| Worker page/worker independence budgets, at least 10 page ticks and 5 worker frames during 400 ms opposing-thread blocks | packages/worker/tests/browser-check.mjs | Existing assertions retained behind speedEnabled(); run in the quiet speed phase. RPC and rendered-pixel correctness run now. |

Batch 221: quiet-machine single-worker versus multi-worker BVH construction (one-million-triangle mesh), worker startup/position sharing or cloning/transfer/packing costs, same packed buffers and queries. Compare worker counts under equal work; no speedup claim or timing budget during build phase.
- Batch 249 ecs/parallel: quiet-phase throughput comparison of identical serial and shared-worker module systems with matching outputs; use the real worker fixtures and declared hazards. Atomic overlap is proven now; no wall-clock gain is claimed.

Batch 208: quiet-machine real-network throttle throughput, burst behavior and prefetch impact on foreground downloads in window/service worker. Build-phase proof checks deterministic requested timer debt, exact bytes, idle scheduling and persistence, with no elapsed-time assertion or speed claim.

- Batch 247 GI temporal reuse: deterministic buffer preservation proves skipped surface and upper-cascade traces on identical input, with identical rendered output to forced-fresh computation. Quiet-machine timing across static/painted/moving scenes remains owed before release; no timing assertion or benchmark was run during build phase.
- Batch 266 effects-extra: retain Stars/Sparkles absolute-time animation and exact positions/RGBA; investigate native GPU attribute animation or SIMD only with a proven gain. Current deterministic uploads: 16*count colour bytes per star frame, plus 12*count position bytes for sparkles. Quiet timing proof is owed; no timing assertion or benchmark was run.
- Batch 231 scatter Hi-Z: deterministic same-output wall scene reduces colour instances 100 to 42, retains all 100 shadow instances. Quiet-machine timing of depth prepass, reduction and the second compaction remains owed; test occlusion.browser.mjs on both backends. No published speed claim.

- Batch 206 value clips: investigate reusing PBR model/geometry buffers between fixed-topology frames in ValueClipPlayer, with identical pose/ownership output and deterministic allocation counts; current complete-frame replacement handles changing topology correctly. No speed run in the build phase.

- Batch 173 job 3: time plain VolumeLayer, unlit cinematic wrapper, local spherical AO, directional volume shadows and progressive HG paths on the same constant-field and real EMDB/TCIA scenes in the quiet speed phase. Keep the exact work-count fixture in cinematic-browser.mjs; unlit/AO/shadow counts 169400/4235000/5590200 scalar fetches. Include the wrapper's extra integration/display passes and 48 B per pixel targets. No wall-clock speed claim during build phase.
- Batch 274 decomp: quiet timing comparison of native scalar and Rust SIMD dense decompositions remains owed. Deterministic proof now checks identical scalar-order inner products: floor(n/2) f64x2 product instructions plus n%2 scalar products versus n scalar products, with the same additions. No speed or throughput number is published.


- Batch 173 job 4: quiet speed-phase timings owed for fixed versus block-skipped/adaptive volume sampling and explicit float32 isosurface refinement on constant, sparse and CC0 T1 fields. Compare identical fields/classifiers; include depth capture/snapshot, opacity-envelope rebuild and min/max preparation work. Correctness images are already exact in the defined fixtures; no build-phase wall-clock benchmark.
Batch 174 job 1: shared selection mask uploads have deterministic one-write evidence at two million plotted marks; quiet-machine throughput and latency measurements remain owed before release. Run link-browser.mjs with the same pinned 2MASS observations and membership readback; no timing assertions run in the build phase.

- Batch 186 job 2: quiet-machine shadow-atlas timing remains owed after the build phase. Correctness gates use only deterministic allocated/rasterized texel counts; preserve light/caster work and the whole-atlas dirty policy when comparing.



- Batch 136 Draco encoder: quiet cold/warm Node and browser encoding versus the opaque 1.5.7 encoder on the same Box, Fox, MetalRoughSpheres, CommercialRefrigerator, Lantern and RiggedFigure streams at identical bit/speed settings. Keep every triangle, attribute and error check. Record encode/decode time, memory and output bytes; include bounded seed-search cost. Build-phase evidence is gzip bytes and fixed eight output-bridge calls only; no end-to-end timing claim.
- Batch 175 job 1, sciviz/omezarr: quiet-machine chunk/decode/load timings and Rust/Wasm comparison remain deferred. Current proof is exact lossless output, one chunk for a teravoxel one-sample ROI, and 131072 output bytes per real region; retain all original scenes and budgets.

- Batch 274 job 3, compute/cpu-wasm: quiet-machine paired JavaScript/Rust timings for fused expressions, reductions/scans, stable sorting, matmul, FFT, signal convolution, sparse and Philox. Preserve identical outputs, all sizes and scenes. Deterministic proof already counts actual SIMD groups; bridge allocation/copy costs are included in the later end-to-end timings. No timing bar was weakened or run in this build phase.

- Batch 173 job 5: quiet-machine mapped-volume throughput across radar curvilinear cells and thin spherical ocean shells; retain original data, inverse tolerance, 4096-segment coverage and identical classifier/output. No timing proof during build phase.


- Batch 174 job 2: quiet-machine TLC cross-filter/aggregation timing at 10M rows and web-library comparison still owed. Correctness/work counts proved on both backends: 39 GPU passes, 1,250,016 partial bins, 36,621 indexed rows touched for a boundary move. No speed run during build phase.

- Batch 175 job 2: quiet-machine pointcloud streaming and picking on full large remote sources still owed. Build-phase proof uses 1-billion-point metadata with 2 loaded points/20 attribute bytes, and original USGS archived 188,887 points/2,266,644 attribute bytes; no wall-clock assertions or speed budgets ran.
- Batch 173 job 6: quiet-machine CPU adjacency/BVH construction and direct tetrahedral GPU throughput on the 6048-cell NASA subset and larger conforming meshes. Retain exact mesh/field, cell work and optical-depth equivalence; compare with the same CellLocator image. No timing proof or exclusive GPU use during build phase.


- Batch 174 job 3: quiet-machine 2M parallel-row/matrix and density timing plus web-library comparison still owed. Deterministic proofs: 24MB column storage, 4,000,003 line instances, 24-byte three-axis order writes and 6M density votes. Compatibility atomic density currently uses 245 CPU chunks; investigate a GPU route during speed/fix work without changing count semantics.

- Batch 181 job 2, sciviz/monitor: run quiet scale plans for points, voxels, cells, edges and TLC/GBIF table rows past median frame latency 16.7 ms and through first allocation/driver failure, plus full format/size loads. Preserve pixels, data, work and all failed/slow observations. Use sweepLimits timed mode after Scott ends deferral, with 3 warmups/9 samples and queue completion. Publish every sample/minimum/median, load time, environment, counts and memory in the versioned JSON for batch 182. Current evidence is allocation counts only; default finite ceilings are not hardware limits. No timing claim exists.
- Batch 203 AVIF: after correctness and public worker entry land, measure explicit four-lane integer row-finalization SIMD against scalar with identical inverse-transform pixels on a quiet machine. No timing numbers were collected in the build phase; test-only native/Wasm contracts establish exact output.
- Batch 234.3 underwater: quiet GPU cost of pixel-edge depth-plane reflection/refraction at 1080p and raySteps scaling is owed. Preserve all visited pixels, normals, optical transport and image output; no timing or exclusive run during the build phase.

- Batch 175 job 3: quiet-machine throughput for exact sciviz/aggregate at 100M rows and several bin dimensions, all five glyphs and both backends. Preserve all observations and binary64 exact sums; current proof records exhaustive row/bin tests, dispatches and staging bytes only. No timing gate or paired run was added during the build phase.

- Batch 120 job 7: time the first install through the interactive frame for core/stage, each packed create-margo template (web, game, viz, React and Next), and the documented rival path on a quiet machine before release. Preserve scripts/template-install-check.mjs and template-browser-check.mjs scenes and the original 300 s quickstart budget where applicable; report per-step distributions and cold/warm cache conditions. During the build phase only dependency counts, module identity, builds and pixel correctness were run, with no timing assertion or paired benchmark.


- Batch 181 job 5, sciviz/progressive: quiet-machine frame-budget response and motion/rest frame-time distributions on bricked EMDB and batch 173 cinematic EMDB/TCIA, both backends. Retain original quality at rest and record target pixels/integration work alongside timing. Deferred during build; no speed claim.

- Batch 181 job 4: quiet-machine same-data/same-256x256-pixels scatter density comparisons against regl-scatterplot 20M 2MASS and deck.gl 10M NYC TLC. Preserve every source point, camera, opacity, losses and image differences. Measure upload/first-frame, unchanged-view and camera-change latency/memory, record CPU load and full environment, and include native/compatibility routes (compatibility atomic count currently uses CPU tier). Correctness includes exact 20M/10M integer histograms and 16,777,217 coincident votes on both backends; no timing or exclusive run during build phase.

- Batch 175 job 5, sciviz/graph-gpu: quiet-machine layout/drawing rates for FR and FA2 at a million nodes and OpenAlex citation topology, against Cosmograph public API with equivalent work; report sorting/tree/adjacency counts, FDEB E-squared costs and convergence quality. No timing benchmark ran during build.

- Batch 175 job 4, /series: quiet-machine remote CSV/Arrow/Parquet throughput, progressive first draw, M4/min-max/LTTB and original-data FFT/STFT at larger row counts. No timing run/assertion in build phase; current proof uses original row counts, bounded request bytes, display vertex counts and independent output equality.
# Batch 175 job 6: reader worker timings owed

On a quiet machine after Scott resumes speed work, record worker startup, loading and parsing times per format and input byte size for the existing head.nrrd, zstat1.nii.gz, CT_small.dcm, NOAA wind-classic.nc, wind.vti, wind.vtk and the equivalent NOAA Zarr store. Compare output-identical direct and worker reads and record snapshot/transfer bytes. Only consider a feature-local Rust/Wasm inflater after a permitted paired A/B demonstrates a gain; the existing inflater remains unchanged. The correctness suites do not measure or assert speed.

Batch 137 Basis encoder: quiet-machine encoder throughput, first-call/load cost and peak-memory comparisons against the pinned old prebuilt are owed after the build phase. Retain identical ETC1S/UASTC settings, mip chains, RDO inputs and matched-rate quality corpus. No benchmark, paired wall-clock A/B, timing-only assertion or exclusive GPU run was performed during the build phase. Deterministic work counts and gzip bytes are separate acceptance evidence, not a throughput claim.

- Batch 169 job 1 ui: time the five `scripts/bp-169-ui-oracle.mjs` cases against external Yoga 3.2.1 tonight; include rectangle application and distinguish initial/unchanged/edited layouts. Deterministic nested leaf callbacks reduced 24 to 2 with exact layout bytes; values-only oracle passes. No wall-clock result yet. Remaining jobs text, mesh-edit, splines, terrain, wfc and procedural stay open.

- Batch 169 job 2 text: time the unchanged layout fixtures and Canvas/Troika oracle work after the quiet window opens; logical pair calls 1198 to 599 and prefix advances 35 to 18, identical bytes. Do not compare complete rival SDF generation to pure Margo layout.

## Batch 182 volume quiet rerun

Build-ready controls and external-install commands: [sciviz-rivals](../sciviz-rivals.md). Preserve legacy-64, isotropic-64 and isotropic-128, every image, sample and GPU count. Smoke uses --runs=1 with no elapsed times. Quiet run uses active speed phase, exclusive GPU access and --runs=7; historical loss remains open.


## Batch 182 sciviz comparison quiet run

`MARGO_SPEED_PHASE=active npm run sciviz:compare -- --runs=7` on the quiet machine: all 12 cases at every scale (volume 64 to 512, isosurface 32 to 256, scatter 1,024 to 16,777,216 points on four rivals, line to 1,048,576, heatmap to 1,024 per axis, streamlines 8 to 512 seeds, graph 1 to 256 copies, tiles zoom 1 to 6). Record load to first frame, per-round minima, the scale where a frame passes 16.7 ms and the first failure, memory and image differences. Publish every sample and loss in sciviz-vs-rivals.md and the losses table.
- Batch 169 job 3 mesh-edit: time `subdivideMesh` levels 1 to 4 on the cube and cylinder fixtures, and Blender's modifier on the same meshes through `scripts/bp-169-mesh-oracle.mjs` inputs, in the quiet window. Edge-ID parses 1260 to 0 with identical bytes. Count Margo's planar triangle split separately from Blender's whole quads.

- Batch 169 job 4 splines: time intersectSplines on the six intersect-workcount pairs and larger 64-segment curves in the quiet window; point evaluations 512 to 64 on two 8-segment curves with identical bytes. three.js has no curve intersection, so only value parity (4.44e-16) is shared.
