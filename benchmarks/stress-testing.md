# Release stress testing

Run from the repository root on Node 24 with built packages and a supported Chromium browser. `npm run test:release` builds packages and the production starters/showcase, checks all Node tests and the 20,000-byte combined core/stage gzip gate, verifies packed exports and strict TypeScript consumers, runs the existing browser/wrapper/domain/game/PBR/post/XR/USDZ/module tests, then runs 500 seeded sessions of 120 frames. All commands fail on errors; they never publish anything. CI runs a smaller 22-session matrix on explicitly selected SwiftShader. Use physical GPUs for performance evidence.

```powershell
$env:BROWSER_CHANNEL='msedge' # or chrome / chromium (full Playwright Chromium)
npm run test:release
# Longer campaign; 10,000 sessions, not 10,000 physical devices
npm run modern:test:stress -- --sessions=10000 --frames=600 --cycles=25 --timeout=600000
# Largest supported splat fixture (requires substantial CPU and GPU memory)
npm run modern:test:stress -- --sessions=11 --frames=600 --splats=3000000 --timeout=600000
```

The deterministic matrix covers 12,014 shared-geometry entities; PBR skinning/morphs, SSAO/TAA, shadows, clustered lights, terrain, VFX and splats together; standalone splat sorting; WebGL2; missing-adapter fallback; failed device creation; failure after partial buffer allocation; failed recovery; disposal while recovery waits; WebGL context loss/remount; and repeated mixed-scene lifecycles in one page. WebGPU rendering sessions lose their device at a seeded frame, either between submissions or inside a pass. They resize through a collapsed host, exercise deltas from zero to one second, check finite transforms, recycle entity IDs, and verify actual output pixels. Optional features are removed in half the profiles.

Limits are read through bound WebIDL accessors, clamped against the real adapter, and forwarded into `requestDevice({requiredLimits})` so the native device enforces the selected constraints. Profiles stay at or above baseline WebGPU maxima. The runner rejects features/limits exceeding the synthetic contract. It does not model another vendor's driver, thermal behavior or clock speed.

Every session fails on browser errors, rejected promises, HTTP errors, uncaptured WebGPU errors, blank output, recovery timeout, changed CPU state, or GPU buffers/textures/devices not explicitly destroyed. The soak collects Chromium's retained JS heap after GC and fails at 8 MiB growth from its warmed baseline. This is a regression threshold, not proof of zero memory leaks or a GPU/VRAM measurement. Allocation faults are deterministic API failures, not real VRAM exhaustion. WebGL's supported contract is one error, stopping animation, and remounting; GPU loss recovers automatically. Frame metrics include submitted-work completion and instrumentation, not presented FPS.

Heap samples include harness request records and browser/JIT caches. Investigate a long-soak failure with a heap snapshot before attributing growth to the engine.

The runner builds the harness before execution, so sessions exercise one production bundle and avoid development-module connection churn. Reports and initial-scenario screenshots are under `test-results/stress/seed-<seed>-shard-<shard>/`. Reports include commit, dirty status, browser, actual GPU identity/fallback, options, full replayable profiles, checks, resource counts, timing, heap samples and failures. `sessions.jsonl` retains each completed session immediately; `progress.json` shows live totals, and `report.json` is finalized when the run ends. A failed session does not stop the rest of the matrix; the final exit code fails the run. Repeat a failure with the same seed and workload (or the same total sessions/shards/shard). Reports at the same seed/shard path are replaced on rerun; preserve evidence before rerunning.

For a fleet, run the same checkout and seed on each worker with `--sessions=10000 --shards=20 --shard=N` for N=0..19. Each shard uses its own ephemeral server port. Keep GPU workers sequential on each physical device to avoid confounding memory/performance; separate workers may run concurrently. Do not dispatch thousands of jobs to one GPU. Copy all shard reports into this workspace and aggregate their explicit paths:

```powershell
npm run modern:test:stress:aggregate -- C:\evidence\worker-0\report.json C:\evidence\worker-1\report.json
```

Aggregation requires every requested session and shard exactly once, identical options/seed/commit, and clean checkouts. It rejects missing, duplicate, incomplete or mixed evidence and exits nonzero on any failure. The summary is `test-results/stress/summary.json`. Do not combine different GPU campaign settings into one reliability claim; publish the actual tested workload and hardware.

Before public release, repeat on real Intel/AMD/NVIDIA, Apple Silicon Safari, iPhone Safari, Android Adreno/Mali, and Firefox where supported. Use each provider's actual browser automation integration rather than treating a WebDriver URL as a Playwright endpoint. A local Chromium matrix cannot certify these devices. Real driver resets, OS suspension/resume, real memory pressure, mobile touch/presentation, network interruption and production CSP/asset delivery remain separate release checks. Record failures as release blockers and publish only measured coverage; no unsupported "95% coverage", "zero leaks" or "100% recovery" claims.
