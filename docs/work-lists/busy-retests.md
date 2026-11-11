# Timing tests to rerun on a quiet machine

## Batch 21 job 5: integrated GPU frame budget owed

Deferred by Scott's build-phase instruction on 2026-11-10. No timing run was
attempted and no passing integrated-GPU result is claimed. Baseline inspected:
`7fbcb762f`; target hardware: AMD Radeon 680M integrated GPU. CPU load and measured
frame time: not sampled, because measurement is deferred.

After Scott ends the build phase, run `npm run visual:compat:budget -- --chunk=8`
on the integrated GPU on a quiet machine, retaining all demos, native/compat
pairs and the existing failure predicate: median main-thread frame work above
50 ms AND above twice the native frame; missing/nonfinite frame measurements
also fail. Build the site first as the runner requires. Record the exact commit, browser/ANGLE
backend, GPU identity, CPU load, per-demo results and any accepted differences.
This budget gates main-thread work; the frame interval is recorded separately. Keep this item owed until
the actual integrated-GPU record passes; see `speed-phase.md` and
`docs/webgl2-compat-roadmap.md`, M8 frame budget.

Scott, 2026-11-07: every PC is busy with the batches. A test that fails only on time while its machine is loaded goes here and the work moves on. Rules are in `AGENTS.md` (Working rules, busy machines). Budgets are never raised and tests are never skipped or edited. Every row is rerun on a quiet machine before release; this list must be empty then. A miss of more than 2 times its budget, or one that a side-by-side run against the parent commit shows as a real slowdown, is a bug to fix now and never goes here.

| Test | Commit | Machine | Measured against budget | CPU load | Date | Rerun result |
| --- | --- | --- | --- | --- | --- | --- |
| Review 99 root-glass follow-up: scoped tracer README root, resampled-emissive, WebGL2 compatibility and triangle-mesh examples | bcdef9251 plus duplicate-direction correction | Ryzen 9 9950X, Windows 11, RTX A6000, Edge 157 | unchanged 20000 ms module-completion deadlines expired during cold pipeline compilation, with no value/GPU error reported. The full root GPU suite, including four analytic interior furnaces, passes. The correction removes duplicate candidate offers; no timing experiment or compilation-speed claim. All nine examples attempted once: five pass and these four expire. | exact failures not sampled; same-session CPU 63 percent at 15:03, concurrent gates were active | 2026-11-09 | quiet release rerun required |
| `check:readme-run -- --packages=voxel-pathtracer`, WebGL2 compatibility example module completion | 6a09f480f plus Review 99 mesh-only shader specialization; the root shader and compatibility path are unchanged | AMD Ryzen 9 9950X, Windows 11, RTX A6000, Edge 157 | unchanged 20000 ms module-completion deadline expired while awaiting tracer.ready; the partial report has no value or GPU error. This is the existing root cold-compilation wait class, not mesh transport. No timing experiment or budget change; remaining examples run separately. | exact failure not sampled; same-session CPU sample 100 percent with four concurrent verify jobs | 2026-11-09 | quiet release rerun required |
| Same scoped README gate, triangle-mesh capture and spectral example close | 6a09f480f plus Review 99 mesh specialization | same Ryzen 9 9950X / RTX A6000 / Edge 157 | unchanged 20000 ms deadlines expired at mesh module completion (awaiting compilation/capture) and spectral page close, respectively. Other six examples passed. The full mesh native/compatibility suite, capture and lifecycle passed with no value error; spectral implementation unchanged. No timing run, budget increase or claim of a quiet pass. | exact failure not sampled; same-session CPU 100 percent, four verify jobs active | 2026-11-09 | quiet release rerun required |


| `check:readme-run -- --packages=voxel-pathtracer`, resampled-emissive example module completion | b9985bd07 plus restored batch-99 gamma correction; all three tracer shader inputs byte-identical to that parent | dev PC, Windows 11, RTX A6000, Edge 157 | original 20000 ms deadline expired; instrumented completion 21821 ms against 20000 ms, no value/GPU error. Three interleaved parent/current rounds under an exclusive GPU lease: parent 18239/17518/19455 ms, current 21821/18314/15420 ms. Current minimum is below parent minimum; variation exceeds their difference. The unchanged full nine-example gate then passed in 50.746 s. | original failure not sampled; same-session diagnostic samples 91 to 100 percent | 2026-11-09 | quiet release rerun required; deadline and test unchanged |
| `tests/browser-teardown.test.js`: real browser close ends its process tree | cfe0d2b54 plus batch 77 tile/WFC harness repairs; browser/shutdown implementation unchanged from that parent | dev PC, Windows 11, Edge 157 | shared 30,000 ms close budget exceeded; whole test 30,771.6487 ms, no value failure or outer test hang. Same-session phase diagnostics closed all owned processes in 11,963 / 2,822 / 1,972 ms; PowerShell settle alone varied from 10,691 to 486 ms. No browser/shutdown source change or speed claim. | not sampled at the failure; same-session diagnostic CPU samples 99.32 to 100 percent | 2026-11-09 | quiet release rerun required; budget and test unchanged |
| `tests/catalog.test.js` after hook: bounded browser close | `8f33704a2` | Windows 11, Edge 157, RTX A6000 host | SHUTDOWN_TIMEOUT at 30,013.1942 ms against 30,000 ms; catalog assertions passed, no outer unit-test timeout. Browser/teardown implementation is unchanged from origin/main 269da2b90; same established Windows close-budget class as the row above. | exact failure not sampled; same gate session sampled 98 percent CPU. No slowdown change to browser/teardown code. | 2026-11-09 | quiet release rerun required; budget and test unchanged |
| physics-refs harness speed rows, Margo next (`js/margo-next/margo3d.mjs`, default and equal): every `step_ms_*` and `awake_step_ms_*` row, the new `cubes_1000/5000_drop_10s_no_sleep` raw-cost rows included | main dd0144ba6; the kernel the harness ran is 280ee47ad (lane U dist) | AMD Ryzen 9 9950X, Windows 11, Node 26.12 | no budget; hints only, e.g. 5,000 cubes no sleep equal cost 24.4 ms median, 1,000 cubes no sleep 3.76 ms | 26 to 88 percent other load per scene (the run's `load` block) | 2026-11-07 | |
| physics-refs harness speed rows, Rapier 0.21, Jolt JS 1.1.1 and native Jolt 5.6 cubes scenes with the Lane Q sleep counts and no-sleep variants (`scenes/rapier3d.mjs`, `scenes/jolt3d.mjs`, `native/jolt/jolt3d.cpp`) | main dd0144ba6 | same | no budget; hints only, e.g. 5,000 cubes no sleep: Rapier 14.3 ms, native Jolt 13.4 ms median | 28 to 54 percent before each run | 2026-11-07 | |
| `cargo run --release --example profile` phase times (packages/physics/kernel) | main dd0144ba6 | same | no budget; hints only | 94 percent at the time | 2026-11-07 | |


### Batch 168 OIT diagnostic measurement

Quiet release rerun required: default weighted OIT versus Babylon.js 8.33.0 dual depth peeling,
`node packages/oit/scripts/rival-bench.mjs` under the exclusive GPU lock. Current diagnostic minima
2.000 versus 7.100 ms on the busy RTX A6000 machine. This is a measurement rerun, not a failed budget
or a waiver. The image loss remains open independently of timing. Raw rounds: perf history 109.

### Preview tier validation (2026-11-09)

| Test | Commit | Machine | Measured against budget | CPU load | Date | Rerun result |
| --- | --- | --- | --- | --- | --- | --- |
| `tests/page-ready.test.js`: delayed last-module proof, browser shutdown | `b9985bd07`; this test, browser launcher and shutdown source are unchanged by preview-silent-skip | Windows workstation, Node 26.12 | 30,000 ms browser close budget exceeded; first test 33,141.4642 ms, no readiness/value failure or outer test hang. Same-session alternating parent/current tests (identical source): parent 10,864 / 4,957 ms, current 4,982 / 5,206 ms. Current minimum differs by 25 ms, within the 249 ms current-round spread. No browser or shutdown speed change. | not sampled at the instant of failure; immediately following full unit run, Win32_Processor reported 99 percent | 2026-11-09 | quiet release rerun required; four diagnostic runs closed successfully, budget and test unchanged |

### Review 99 deferred spectral verification (2026-11-09)

| Test | Commit | Machine | Measured against budget | CPU load | Date | Rerun result |
| --- | --- | --- | --- | --- | --- | --- |
| Scoped tracer README resampled-emissive example | parent 258721517 plus deferred spectral correction; root and resampled sources unchanged | Ryzen 9 9950X, Windows 11, RTX A6000, Edge 157 | existing 20000 ms module-completion deadline expired, with no value or GPU error. The previously failing root example now passes. Only spectral transport changed; no timing experiment, budget edit or speed claim. The remaining compatibility, mesh and changed spectral examples all pass in the next narrowed run. | 99 percent immediately after the failure; full repository verification and other lanes active | 2026-11-09 | quiet release rerun required |

Batch 56 teardown row resolved: main cf699846f/20375ea56 repairs the owned
Chromium shutdown cause. The original ground --studio --compat assertions and
teardown pass in test-results/56fix/resume-gpu-teardown-ground-studio-compat.log
with the unchanged 30,000 ms close budget. This was a teardown defect, not a
busy-time exception. The separate compatibility capture value failure remains
an open correctness gate in known-bugs.md.

| Batch 136 clean-room Draco encoder cold/warm Node/browser timing | batch-136 replacement commit | Windows dev PC, RTX A6000 | Not run: Scott's deferred speed phase; no time number or budget change | Not sampled because no timing run occurred | 2026-11-10 | Owed on a quiet machine before release; scenes/settings retained in speed-phase.md |

- Batch 181 job 2: sciviz timed scale/failure and format/size sweeps are not run during the deferred build phase. No measured miss or timing regression is claimed. Quiet-machine 16.7 ms crossings and failure-scale observations remain owed in speed-phase.md; preserve the original default real-data fixtures and extend the scale plans. Allocation JSON records host, CPU utilization and source digest.

### Batch 137 encoder timing owed (2026-11-10)

| Test | Commit | Machine | Measured against budget | CPU load | Date | Rerun result |
| --- | --- | --- | --- | --- | --- | --- |
| ETC1S/UASTC encoder throughput, first-call/load cost and peak memory against the pinned old prebuilt, with identical source pixels, settings, mip chains and RDO inputs | batch-137 replacement | quiet release machine required | Not measured: deferred by the build phase. Record every loss and its cause; deterministic work counts and gzip bytes do not establish throughput. | not sampled; no timed run | 2026-11-10 | Owed after Scott ends the build phase |
| `node scripts/benchmark-package-workloads.js` (MARGO_SPEED_PHASE=active), steady 60 Hz acceptance | c5e55d814 | dev PC, Ryzen 9 9950X, Windows 11, RTX A6000 (display reports 60 Hz), headed Edge 157 | 8 workloads at 55.1 to 55.5 Hz mean callback rate against the unchanged 60 Hz floor, including `net` at 0.26 ms CPU per frame; the empty native callback in `scripts/desktop-demo-tests.js` measured 54.5 to 55.2 Hz on the same night, so the cap is the browser frame clock on this machine, not the workloads | not sampled during the run; quiet window, cleanup session running alongside | 2026-11-10 | |
| `check:readme-run -- --packages=voxel-pathtracer`, browser close at the end of the run (whether an example hit its deadline is hidden) | fl-pathtracer landing on 839f310d5; the same failure with origin/main voxel-pathtracer and webgl2-compat sources and README rebuilt in place | dev PC, Windows 11, RTX A6000, Edge 157 | the run ends in `browser host <pid> did not acknowledge the end: null` after "Chromium was ended but the kernel had not finished tearing it down 2000 ms later", which hides the per-example report (docs/known-bugs.md, check:readme-run entry); the same class as the two 20000 ms tracer.ready rows above; webgl2-compat (17 of 17) and math (10 of 10) pass in the same session | not sampled; a webgl2-compat GPU suite and other lanes were running | 2026-11-10 | quiet release rerun required; deadline and test unchanged |
| `check:readme-run -- --packages=voxel-pathtracer`, example `readme-resampled-emissive-lighting` (64 x 64, 8 samples: one submission before and after KB-BL1, so its GPU work is unchanged) | KB-BL1 landing on 0525c34e14 | dev PC, Ryzen 9 9950X, Windows 11, RTX A6000, Edge 157 | did not finish within its 20 s deadline while waiting for module completion; most of it is `tracer.ready`, the native trace pipeline compile (about 17 s a pipeline on Dawn D3D12, KB5185a) | 99% (Win32_Processor LoadPercentage) | 2026-11-11 | pending quiet rerun |
