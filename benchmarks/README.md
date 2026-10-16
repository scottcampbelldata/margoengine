# Margo Engine validation baseline

For release fault injection, deterministic hardware-limit fuzzing, lifecycle soaks and sharded campaigns, see [stress testing](stress-testing.md). Run `npm run test:release` before publishing; it includes a 500-session matrix in addition to the existing regression suites.

The [local stress validation results](stress-results.md) record the completed NVIDIA/AMD campaigns, 3M-splat run, 100-cycle soak and remaining release gaps.

Run `npm run benchmark:three-vs-margo` after `npm run build:packages` for the automated Three.js **0.186.1** comparison. Install Playwright Chromium (`npx playwright install chromium`) or select an installed Chromium browser with `BROWSER_CHANNEL`. The runner serves gzipped production bundles through a local Vite server, renders exactly 1,200 frames per scene, records CDP heap/GC and Resource Timing data, and counts actual GPU/GL API draws and dispatches. Results are written to [results.md](results.md) and `test-results/benchmark-three-vs-margo.json`. `BROWSER_ARGS` accepts extra Chromium flags. A missing WebGPU adapter fails explicitly; use a physical adapter for performance claims or explicit SwiftShader flags for validation only.

These measurements were captured on 11 October 2026 before the Margo Engine rename. Historical captures retain their original package names. Raw traces, heap profiles, machine inventories, logs and recovery archives remain local; this repository contains portable summaries and the scripts needed to repeat the checks.

The locked core measured **19,874 bytes gzip** on 11 October 2026, leaving **606 bytes** below its 20 KiB budget. That figure is the lock from that day, not the current build. The current consolidated build measures core at **18,255 bytes gzip** and core plus stage at **20,282 bytes gzip**, below the **25,000-byte** combined gzip ceiling. The historical checkpoint's embedded Wasm was **12,046 bytes raw**, with SHA-256 `c9fade2492bc1af53dfd33ece4086e34e634634ea4fea3dec28491c162327fed`; the rename checks below describe that checkpoint.

The Margo Engine rename passed 31 JavaScript tests, four Rust tests, eight AMD browser groups and four standalone package/React 18 groups. A fresh checkout passed `npm ci`, `npm test` and both production builds. All 37 fingerprinted core source/distribution and Rust source files remained byte-for-byte unchanged, as did 120 installed dependency versions. Full stress benchmarks were not repeated for the rename.

The 11 October baseline recorded a public `0.1.0` release of five libraries, matching registry downloads and clean registry-consumer checks for imports, embedded Wasm initialization and React 18.3.1 SSR. That historical record does not describe the current `1.0.0` workspace. Its 74-package catalog currently reports zero published versions; use the [source setup](../README.md#run-from-source) or locally built tarballs until a verified release supplies registry installation commands.

GPU suites run one at a time; the finalization and roller assembly checks need the Vite dev server (`npm run dev`). `BROWSER_CHANNEL` picks the browser (`msedge` by default, `bundled` for Playwright's Chromium), JSON `BROWSER_ARGS` passes launch flags, and `GPU_VENDOR` and `GPU_POWER` select and verify the adapter. On Windows, `scripts/gpu-adapters.ps1` lists adapter LUIDs, which vary by machine and session. Rebuilding the Rust kernel needs the toolchain pinned in `rust-toolchain.toml`; ordinary use relies on the checked in Wasm.

## SwiftShader runs (no GPU)

The files in [swiftshader/](swiftshader/) were recorded on 11 October 2026 at commit b3987dd on a Linux 6.12 virtual machine with 8 vCPU (Intel Xeon), 15 GiB RAM and no GPU, using Node.js 24.21.0, Rust 1.99.0 and Playwright Chrome Headless Shell 156.0.8078.4. WebGPU and WebGL2 ran on SwiftShader, a software Vulkan implementation, so GPU completion times in these files do not describe real graphics hardware.

| File | Contents |
| --- | --- |
| `bench-tick-b3987dd-run1.json` to `run3.json` | Three runs of the roller assembly tick and frame timing at 20, 200 and 240 rollers |
| `modern-finalization.json` | The finalization suite, including the 12,014 entity stress scene |
| `modern-browser.json` | The browser suite: 8 check groups for both backends and both starters |
| `modern-domains.json` | The domain suite: 8 check groups for caps, effects, particle sorting and device loss |
| `modern-packages.json` | The packed package suite: standalone imports, strict consumer types and React 18 |
| `conveyor-check-picking-failure.txt` | Output of the full `modern:check:conveyor` run, which fails at its live picking step on SwiftShader (the absolute checkout path is shortened) |

To repeat, follow the commands in [README.md](../README.md). GPU suites run sequentially; finalization and live conveyor checks require the Vite dev server. `GPU_VENDOR`, `GPU_POWER` and JSON `BROWSER_ARGS` select the adapter; `scripts/gpu-adapters.ps1` lists Windows adapter LUIDs, which vary by machine/session. A Rust source rebuild also requires the toolchain pinned in `rust-toolchain.toml`; ordinary consumers use the checked-in embedded Wasm.

The machinery runtime extension was measured separately on an AMD Ryzen 9 9950X with Node 24.15.0. For 500 queued parts, the Wasm solver median/p95 was 0.0135/0.0137 ms; the complete JS + Wasm surface update was 0.0421/0.0429 ms. Solver maximum was 0.3122 ms, so the 0.040 ms target is met at p95 on this host, not for every sample. Picking a 6,000-triangle assembly measured 0.0009/0.0011 ms median/p95, with a 0.3233 ms maximum. Memory views remained stable; this does not establish whole-application zero GC. Repeat with `npm run modern:bench:machinery`; raw JSON remains in `test-results/modern-machinery-performance.json`.

`npm run modern:test:machinery` checks real STEP/IGES import, worker transfer/deduplication, progress, cancellation and production asset URLs on NVIDIA RTX A6000 / Edge. A 5 MB, 100,000-triangle STL import kept animation frames running while parsing and optimization ran in a worker. B-Rep progress is stage-based because OCCT's reader is synchronous inside that worker. Existing domain GPU checks pass with dedicated depth-fail cap masks, retained descriptors, resize and device restoration. These fixtures do not establish support for every industrial CAD dialect or universal frame-time limits.

The machinery browser matrix on 11 October 2026 passed 51 check groups per browser across six suites in installed Chrome 154.0.8037.98 and Edge 155.0.4283.45 on NVIDIA RTX A6000, with no software GPU fallback. Coverage included WebGL2/WebGPU rendering, caps and device recovery, production CAD workers/file pickers, Wasm surface transport, binary telemetry, BVH/clearance, live conveyor interaction and packaged React consumers. Per-browser JSON reports and the matrix summary are in `test-results/browser-matrix`. Explicit `BROWSER_CHANNEL` selection prevents silent bundled-Chromium fallback; in PowerShell set `$env:BROWSER_CHANNEL='chrome'` or `$env:BROWSER_CHANNEL='msedge'` before the browser scripts. GPU suites share ports and must run sequentially. Chrome's first drag trace recorded two tasks over 50 ms; an isolated repeat recorded none, and Edge recorded none. Both final 15-second drag traces recorded one minor GC, so these checks do not establish zero GC or universal frame-time limits.

Night Citadel on NVIDIA RTX A6000 / Edge 155 at 1280×900 sustained **60.03 FPS** over 15.18 seconds of continuous orbit after adding the silhouette rim and lantern wash. One-second windows ranged from 59.44 to 60.79 FPS; the separate 120-target sample reported 118.68 FPS. Chromium's headless frame limiter and GPU VSync were disabled for these pacing measurements. With the limiter enabled, even an idle animation callback ran at roughly 31 Hz, so these results measure submitted frames rather than physical presentation. Regression tests cover native 60 Hz jitter, faster clocks, bursty callbacks, stalls and refresh-rate changes.

A separate visible Edge run with default launch settings on this Windows session delivered 31.98 FPS over 15 seconds; after rendering stopped, its idle callback still delivered 31.99 FPS / 31.26 ms. That session's presentation limit remains outside the scene's render loop. The native-browser capture is `test-results/night-citadel-native.json`; physical 60/120 Hz presentation on another desktop has not been verified.

The scene retains 643 instances and 15 draw calls, including one static batch of 95 lantern-wash quads, with no steady-state buffer, texture, bind-group or pipeline creation. Its 15-second profile recorded no minor/major GC and no retained heap growth, but sampled transient allocations in camera math, validation and WebGPU command submission. It does **not** establish zero bytes allocated per frame. Pixel checks passed for lunar phases, shared moon/geometry lighting, shadows, horizon haze, star twinkle and the 15° star cutoff. Lantern wash brightened 1,062 masonry pixels without changing depth; the opening lunar disc remained in frame on desktop and mobile. Drag, wheel, keyboard, pinch, resize and teardown also passed without runtime warnings or WebGPU validation errors.

Scenery now reconstructs view rays at three vertices and caches lunar angular trigonometry on configuration. GPU timestamp measurements of `SkyMoonPass` reported a 0.0195 ms median and 0.0215 ms p95 per draw at 1920×1080 (100 samples, 64 draws per batch to exceed timestamp quantization). The before/after median was unchanged on this GPU; frame pacing was the material improvement. Core measured 19,874 bytes gzip on 11 October 2026 and has no scenery dependency. Repeat with `npm run modern:test:citadel`, `npm run modern:test:sky` and `npm run modern:bench:sky`; raw reports, screenshots and profiles are in `test-results/night-citadel*` and `test-results/sky-moon-benchmark.json`.

### Setup

```sh
npm ci
npx playwright install chromium
D=~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64
export VK_ICD_FILENAMES=$D/vk_swiftshader_icd.json LD_LIBRARY_PATH=$D BROWSER_CHANNEL=bundled
export BROWSER_ARGS='["--enable-unsafe-webgpu","--enable-features=Vulkan","--use-vulkan=swiftshader","--use-webgpu-adapter=swiftshader","--use-angle=swiftshader","--enable-unsafe-swiftshader"]'
npm run build
npm run dev &    # the timing and finalization checks use the Vite dev server
```

Adjust `D` to the headless shell folder Playwright installed on your machine.

### Tick and frame timing

```sh
npm run modern:check:conveyor -- --timing-only
```

This loads the demo roller assembly at 20, 200 and 240 rollers. For each size it times 300 ticks of the motor drive, gear couplings and Wasm transform update after 120 warm up ticks, then times 180 rendered frames split into JavaScript before the tick, the Wasm export, and scene collection, encoding and upload. It writes `test-results/modern-conveyor-timing.json` and skips the picking and drag trace steps. The browser timer resolves 0.1 ms, so the summary uses means over 10 tick windows.

The three committed runs were recorded with a copy of the same timing section before the `--timing-only` flag existed; a later run with the flag gave results in the same range.

### Other suites

```sh
npm run modern:test:browser
npm run modern:test:domains
npm run modern:test:packages
```

Each writes the matching JSON file to `test-results/`. The browser suite file in this folder was recorded after the `BROWSER_CHANNEL` change to the test scripts; the engine code is the same as at b3987dd.

### Stress scene

```sh
npm run modern:test:finalization
```

The stress entry in `test-results/modern-finalization.json` reports CPU and GPU completed times over 60 frames for an assembly of 500 rollers plus 10,000 shared geometry parts. On SwiftShader only the CPU figures are meaningful.
