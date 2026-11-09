# Matched complete-step profile design

This diagnostic freezes the current finite-certificate-trim 2D kernel and its own shared kernel-common, README and Wasm checker into this directory. A source manifest records the live HEAD and every copied file hash before edits. No production files, production documentation, handoff, rival source or Git metadata are changed.

Two Wasm artifacts use the same frozen source, compiler, release profile and `-C target-feature=+simd128`: an uninstrumented control and a feature-gated instrumented build. Instrumentation adds only clock calls, counters and private diagnostic exports. It does not change physical operations, settings, iteration order, benchmark construction, solver policy or assertions. Both must pass all three explicit current hashes (`9ffefc83c3a99be4`, `95a47530df180011`, `92db6847c4e919d4`) and the shipped check0/1/2, including the support bar. A full per-step body/contact/cache fingerprint and all public work counts are compared for the unchanged 100-row pyramid before profiling.

The workload remains the existing checker benchmark: 100 rows, 5,050 awake bodies, default settings, 60 settling steps followed by the same 40 complete steps. Samples retain all 40 vectors and totals; they never combine independently selected phase minima into an imaginary step. Matched complete-step minima and medians come from real complete steps. The profile reports every phase for the same selected complete step, plus per-phase distributions across all measured steps. Repeated rounds alternate instrumented and uninstrumented modules in one process/page. The fixed control is used to expose the perturbation caused by instrumentation rather than claiming the instrumented absolute sum is an unmodified production timing.

Non-overlapping phase accounting covers the entire checked World::step:

| Phase | Boundary and included work |
|---|---|
| Preflight | Entry through current public body/shape/contact/joint/settings validation and step-counter reset |
| Broad phase | Refit bounds, broad pairs, filters and persistent contact-list merge |
| Narrow phase | Current manifold generation and cache refresh |
| Islands | Wake and island construction |
| Solver setup | Solver scratch/body/constraint construction, colouring, SIMD blocks, joint setup |
| Support planner | The once-per-frame support Plan build/reuse and snapshot allocation setup |
| Substep preparation | Support snapshot, velocity/gravity/damping integration and observer reset |
| Warm start | SIMD/scalar contacts and joint warm starts |
| Biased solve | All biased contact/joint passes, with unchanged visits |
| Support correction | Impulse write-back, certified path correction and impulse reload |
| Pose integration | Exact center and rotation updates |
| Relax solve | All unbiased contact/joint passes |
| Substep observer | Movement observer merge |
| Solver finalization | Counts, SIMD write-back, restitution, velocities/caches/rounded poses and scratch return |
| Post-solve validation | The full finite body/rotation/cache validation after solve |
| Sleep | Sleep timers and island sleep decisions |
| Post-sleep validation | The separate full body/rotation validation after sleep |

A private imported monotone `probe_now` clock supplies timestamps. Each boundary accounts the preceding interval and switches phase; a step guard closes the final interval even on an error. Clock-call count and phase-entry count are recorded. Clock import overhead is measured with a dedicated exported calibration loop using the identical import and with a matched empty loop. Raw elapsed times, calibration distribution and estimated overhead are retained. Raw phase values remain the primary evidence. An explicitly labelled estimated correction may subtract measured per-call cost, bounded at zero, but is never represented as an exact deconvolution: clock import, bookkeeping, code layout and optimizer perturbation are distinct limitations. The uninstrumented/instrumented matched whole-step ratio is also reported.

The support-planner phase also owns the immediately following `fresh` setup and `substep_pose_speed` allocation before the first substep. Fingerprint, phase-array and work-count exports are read after the outer timer stops. Aggregate shares use sums from actual measured steps; per-phase extrema and medians are explicitly non-additive. The selected minimum complete-step vector records its real round and step index. Outer elapsed time minus the sum of phases is retained rather than forced to zero. The empty calibration loop uses `black_box(i)` and an observable f64 checksum; emitted Wasm is inspected to confirm the loop remains, but the result remains a noisy import-cost estimate rather than an exact overhead subtraction.

The private checker diagnostics expose per-step timings, timer calls and counts, along with full state fingerprints. Counts include public compared/pair/manifold/constraint/colour/overflow/block/sequential/awake work and support planning/correction phase entries. Every measured complete step must still return 5,050 awake bodies and agree with its control state and work fingerprint.

All preparation, builds, checks and runs use the existing hard process-tree deadline runner with unique logs. Preparation/build jobs may run now. No Node profiling run, calibration timing, browser launch or GPU/profile timing starts until the parent explicitly releases profiling. After authorization, an exclusive bounded GPU lease protects any browser profile; the same unchanged scene is used. Results are busy-machine diagnostics, with source-path/static-data differences recorded explicitly and no binary-layout invariance claim.
