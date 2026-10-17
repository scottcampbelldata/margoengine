# Local release stress validation — 11 October 2026

The production stress harness passed these completed campaigns on this Windows host. These are measurements of the current uncommitted workspace based on Git revision `9b98d25e25163d48d02de1c0eb8e8c1b9be4ab5a`; they are not clean-commit release certification. Repeat the release gate from a clean checkout before publishing. Commands and coverage are in [stress-testing.md](stress-testing.md).

| Campaign | Browser / WebGPU adapter | Passed sessions | Submitted frames | Seed |
| --- | --- | ---: | ---: | ---: |
| Main matrix, 120 frames, 10 soak cycles | Edge 155.0.4283.45 / NVIDIA RTX A6000, Ampere | 500 / 500 | 87,000 | 20261011 |
| Hardware repeat, 120 frames, 10 soak cycles | Edge 155.0.4283.45 / AMD Radeon integrated, RDNA 2 | 55 / 55 | 9,600 | 20261012 |
| CI smoke, 24 frames, 3 soak cycles | Full Chromium 156.0.8078.4 / SwiftShader WebGPU | 22 / 22 | 432 | 20261017 |
| 12,014 entities, mixed scene, 3M splats; 600 frames each | Edge 155.0.4283.45 / AMD RDNA 2 | 3 / 3 | 1,800 | 20261018 |
| Two-worker sharding, 12 frames, 2 soak cycles | Full Chromium 156.0.8078.4 / SwiftShader WebGPU | 22 / 22 | 192 | 20261019 |
| Long soak, 24 frames, 100 mixed-scene cycles | Chrome 154.0.8037.98 / AMD RDNA 2 | 11 / 11 | 2,544 | 20261020 |

Physical campaigns verified non-fallback NVIDIA/AMD adapters. SwiftShader is software WebGPU validation; its WebGL scenarios used the host's available renderer. Intentional loss/failure scenarios assert their expected diagnostics and rollback, so the pass count means the specified failure contract held, not that no failures were injected. Failed initialization/recovery and context-loss scenarios intentionally submit fewer frames. Do not pool these different workloads into one universal reliability percentage.

The main matrix covered all 11 scenarios, with 45–46 profiles each. It explicitly retired all **131,877 tracked GPU buffers/textures**, with zero tracked buffers/textures/devices remaining after each scenario. Forty-five same-page soaks stayed below the 8 MiB retained-heap regression threshold; maximum measured growth was 551,572 bytes across ten lifecycles. The separate 100-cycle Chrome soak grew by 642,976 bytes. Heap samples include instrumentation and JIT/browser caches; these results do not establish zero allocation or zero memory leaks.

The 3,000,000-splat AMD fixture completed all 600 frames, recovered its device and destroyed all owned tracked resources. Instrumented completed-frame median/p95 was **181.4 / 210.9 ms**. This is a substantial workload on integrated graphics and is not a 60 FPS or physical-presentation result. Campaigns on the two physical GPUs overlapped, so the timings also include host contention.

Additional checks passed: 447 Node tests, two gameplay-sandbox tests; Vite and Next production starters, showcase and gameplay-sandbox builds; all 37 packed module imports and strict Bundler/NodeNext TypeScript consumers; packed game, interop and post-processing consumers; and nine existing browser suites on AMD (browser, stage wrapper, domains, game, PBR extensions, post-processing, XR, USDZ and all modules). That campaign recorded core + stage at **20,053 bytes gzip**, which was below the older **20,480-byte** ceiling. The current gate is 25,000. The current build measures core at 18,876 bytes gzip and core plus stage at 21,107 bytes gzip. No production engine/package features were added for stress testing.

During an earlier development-server campaign, an AMD browser session failed before engine initialization with Chromium `ERR_NO_BUFFER_SPACE`. That failed campaign and the interrupted NVIDIA campaign were preserved as `report-dev-server-interrupted.json`. Switching to a production bundle removed development-module connection churn; the complete campaigns above did not reproduce that failure. Playwright's default headless shell also returned no WebGPU adapter with the CI flags; the full `chromium` channel passed the exact 22-session CI command. The GitHub workflow itself has not been dispatched in this session.

Raw JSON, immediate session JSONL, live progress and screenshots are local under `test-results/stress/seed-<seed>-shard-<shard>/`. Sharding produced every requested session exactly once; the release aggregator correctly refused these dirty-checkout reports. Its success, missing/duplicate/mixed/incomplete evidence and failure-report paths also pass unit checks.

Still unverified: the full 10,000-session fleet, cloud/physical mobile devices, Safari/Firefox, real VRAM exhaustion, physical driver resets, OS suspend/resume, sustained display presentation, and deployed production CSP/network/asset delivery. The generated 10,000-profile unit check validates deterministic profile generation, not 10,000 executed GPU sessions. Publish only the measured coverage above.
