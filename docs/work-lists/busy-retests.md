# Timing tests to rerun on a quiet machine

Scott, 2026-11-07: every PC is busy with the batches. A test that fails only on time while its machine is loaded goes here and the work moves on. Rules are in `AGENTS.md` (Working rules, busy machines). Budgets are never raised and tests are never skipped or edited. Every row is rerun on a quiet machine before release; this list must be empty then. A miss of more than 2 times its budget, or one that a side-by-side run against the parent commit shows as a real slowdown, is a bug to fix now and never goes here.

| Test | Commit | Machine | Measured against budget | CPU load | Date | Rerun result |
| --- | --- | --- | --- | --- | --- | --- |
| `tests/browser-teardown.test.js`: real browser close ends its process tree | cfe0d2b54 plus batch 77 tile/WFC harness repairs; browser/shutdown implementation unchanged from that parent | dev PC, Windows 11, Edge 157 | shared 30,000 ms close budget exceeded; whole test 30,771.6487 ms, no value failure or outer test hang. Same-session phase diagnostics closed all owned processes in 11,963 / 2,822 / 1,972 ms; PowerShell settle alone varied from 10,691 to 486 ms. No browser/shutdown source change or speed claim. | not sampled at the failure; same-session diagnostic CPU samples 99.32 to 100 percent | 2026-11-09 | quiet release rerun required; budget and test unchanged |
| physics-refs harness speed rows, Margo next (`js/margo-next/margo3d.mjs`, default and equal): every `step_ms_*` and `awake_step_ms_*` row, the new `cubes_1000/5000_drop_10s_no_sleep` raw-cost rows included | main dd0144ba6; the kernel the harness ran is 280ee47ad (lane U dist) | AMD Ryzen 9 9950X, Windows 11, Node 26.12 | no budget; hints only, e.g. 5,000 cubes no sleep equal cost 24.4 ms median, 1,000 cubes no sleep 3.76 ms | 26 to 88 percent other load per scene (the run's `load` block) | 2026-11-07 | |
| physics-refs harness speed rows, Rapier 0.21, Jolt JS 1.1.1 and native Jolt 5.6 cubes scenes with the Lane Q sleep counts and no-sleep variants (`scenes/rapier3d.mjs`, `scenes/jolt3d.mjs`, `native/jolt/jolt3d.cpp`) | main dd0144ba6 | same | no budget; hints only, e.g. 5,000 cubes no sleep: Rapier 14.3 ms, native Jolt 13.4 ms median | 28 to 54 percent before each run | 2026-11-07 | |
| `cargo run --release --example profile` phase times (packages/physics/kernel) | main dd0144ba6 | same | no budget; hints only | 94 percent at the time | 2026-11-07 | |


### Batch 168 OIT diagnostic measurement

Quiet release rerun required: default weighted OIT versus Babylon.js 8.33.0 dual depth peeling,
`node packages/oit/scripts/rival-bench.mjs` under the exclusive GPU lock. Current diagnostic minima
2.000 versus 7.100 ms on the busy RTX A6000 machine. This is a measurement rerun, not a failed budget
or a waiver. The image loss remains open independently of timing. Raw rounds: perf history 109.
