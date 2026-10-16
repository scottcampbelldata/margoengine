# BVH, routing, generation and final Net workload evidence

Recorded 2026-10-13T07:44:54.336Z–2026-10-13T07:47:36.961Z, headed Windows Edge 154.0.4258.62, Intel Arc 140V (xe-2lpg), nonfallback WebGPU. Five real default workloads were measured in two layouts, 40 windows total. Each window used 750 ms warmup and 2500 ms measurement, in OFF/ON/ON/OFF order. No source package optimization was made by this workload subtask.

Native layout and Android 390×844/DPR3 emulation use the same physical Intel GPU. Explicit maximize/occlusion/backgrounding flags are recorded in the JSON; every measured window remained visible and focused. These are foreground-throughput render callbacks, not displayed FPS. No CPU/network throttling or physical-phone test was performed. Fresh local Vite loading is not cold hosted loading.

| Layout | Package / rendered actors | First principal opportunity (ms) | OFF callback Hz | OFF work CPU mean (ms) | OFF render CPU mean (ms) | Worst OFF p99 / max interval (ms) | OFF intervals >16.87ms | ON callback Hz |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| Native Edge | bvh / 256 | 1316.0 | 119.99 | 2.221 | 0.509 | 8.6 / 8.9 | 0 | 119.20 |
| Native Edge | splines / 384 | 533.4 | 120.00 | 0.184 | 0.670 | 8.6 / 8.6 | 0 | 118.80 |
| Native Edge | navmesh / 96 | 1496.9 | 120.00 | 0.661 | 0.480 | 8.5 / 8.6 | 0 | 119.79 |
| Native Edge | wfc / 64 | 496.5 | 120.00 | 0.011 | 0.540 | 8.6 / 8.6 | 0 | 119.40 |
| Native Edge | net / 256 | 688.3 | 119.21 | 0.115 | 0.571 | 8.5 / 41.6 | 1 | 120.01 |
| Android layout on Intel | bvh / 256 | 551.9 | 120.00 | 1.456 | 0.368 | 8.5 / 8.7 | 0 | 120.00 |
| Android layout on Intel | splines / 384 | 905.5 | 119.80 | 0.151 | 0.501 | 8.5 / 16.7 | 0 | 120.00 |
| Android layout on Intel | navmesh / 96 | 446.0 | 119.60 | 0.521 | 0.437 | 8.6 / 25.0 | 1 | 120.00 |
| Android layout on Intel | wfc / 64 | 387.9 | 115.04 | 0.009 | 0.488 | 33.2 / 91.7 | 6 | 120.00 |
| Android layout on Intel | net / 256 | 718.3 | 117.44 | 0.197 | 0.817 | 24.9 / 66.8 | 3 | 120.00 |

Mean cadence exceeded 60 Hz in all windows, but this is **not steady 60 FPS acceptance**: phone-layout WFC had a 91.7 ms gap and 33.2 ms p99, and final Net had 66.8 ms/24.9 ms. Native Net had a 41.6 ms gap. Visibility stayed valid. Package CPU means do not establish the cause; JavaScript/render maxima and tails are preserved in the detailed JSON, and a trace is needed before attribution.

Native initial BVH at 1,316 ms and Navmesh at 1,497 ms missed the 1,000 ms target; the other eight cases were 388–906 ms. The load-start marker was already 767 ms for native BVH and 1,134 ms for Navmesh, before their factories ran. Constructor/setup measured 148 ms and 9.5 ms respectively. This distinguishes module/bootstrap time from package construction without attributing an untraced delay. The marker identifies the last assembled-scene submission, GPU completion and two later frame opportunities; it does not claim physical-display deadlines.

Actual workloads: BVH deforms/refits 20,000 triangles and performs 256 nearest ray queries plus shapecast each frame; Splines shows 48 fixed path samples and 336 followers with parameter/tangent/cached arc-length queries; Navmesh shows 32 polygon markers and 64 agents with A*/funnel routes and simultaneous nearby-agent ORCA, with caller rejection of outside-mesh steps; WFC generates 64 constrained cells once per simulation second, with pinned corners and weighted reciprocal rules; Net samples 256 snapshot buffers with 32 slots each and simulated 20 Hz packets. WFC recorded zero rule violations, 64 cells and four generations by each capture endpoint. Setup CPU and phase counters are saved.

All 40 runs passed actual query-resource assertions: OFF advertises supported timestamp capability but creates **zero query sets**; ON creates **one pooled set**. Completed public pass counts were 2 native and 1 mobile-layout. GPU sums and first-to-last spans are recorded independently below. One valid mobile Navmesh sample quantized to 0 ms; a completed pass count establishes a sample rather than inventing unsupported zero timing. Browser/GPU errors were zero. Getter data reuse and pool behavior have separate correctness checks.

Each case passed keyboard Run/Pause, stable paused frames/submissions, count rebuild and old-device disposal, backing resize with actor continuity, restored temporary setup hooks and terminal-page cleanup. Screenshot color variation rejected blank canvases, principal/rendered actor counts matched, and horizontal overflow was false. This is not pixel-exact framing proof.

| Layout | Package | Run / timing | Callbacks | Load-to-principal (ms) | Callback Hz | Interval p95 / p99 / max (ms) | Work CPU mean (ms) | Render CPU mean (ms) | GPU sum / span (ms) |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Native | bvh | 1 / OFF | 306 | 548.8 | 119.98 | 8.5 / 8.6 / 8.7 | 2.495 | 0.600 | — |
| Native | bvh | 2 / ON | 301 | 106.4 | 119.99 | 8.5 / 8.6 / 8.7 | 2.564 | 0.465 | 0.066 / 0.262 |
| Native | bvh | 3 / ON | 296 | 146.5 | 118.40 | 8.4 / 16.5 / 25.1 | 2.378 | 0.552 | 0.066 / 0.197 |
| Native | bvh | 4 / OFF | 301 | 101.2 | 120.00 | 8.4 / 8.5 / 8.9 | 1.948 | 0.418 | — |
| Native | splines | 1 / OFF | 300 | 262.0 | 120.00 | 8.5 / 8.6 / 8.6 | 0.181 | 0.679 | — |
| Native | splines | 2 / ON | 296 | 78.7 | 118.40 | 8.5 / 8.7 / 33.3 | 0.294 | 1.014 | 0.197 / 0.328 |
| Native | splines | 3 / ON | 298 | 76.5 | 119.20 | 8.4 / 8.6 / 16.7 | 0.283 | 0.855 | 0.197 / 0.328 |
| Native | splines | 4 / OFF | 302 | 73.0 | 120.01 | 8.4 / 8.5 / 8.6 | 0.187 | 0.662 | — |
| Native | navmesh | 1 / OFF | 300 | 362.6 | 120.00 | 8.4 / 8.5 / 8.5 | 0.852 | 0.504 | — |
| Native | navmesh | 2 / ON | 298 | 73.3 | 119.59 | 8.4 / 8.5 / 16.7 | 0.641 | 0.586 | 0.066 / 0.197 |
| Native | navmesh | 3 / ON | 301 | 73.4 | 120.00 | 8.4 / 8.5 / 8.6 | 0.472 | 0.404 | 0.066 / 0.197 |
| Native | navmesh | 4 / OFF | 301 | 59.4 | 120.00 | 8.5 / 8.5 / 8.6 | 0.470 | 0.456 | — |
| Native | wfc | 1 / OFF | 300 | 272.5 | 120.00 | 8.5 / 8.6 / 8.6 | 0.013 | 0.660 | — |
| Native | wfc | 2 / ON | 300 | 64.4 | 120.00 | 8.5 / 8.5 / 8.6 | 0.015 | 0.701 | 0.066 / 0.197 |
| Native | wfc | 3 / ON | 297 | 71.7 | 118.80 | 8.5 / 9.4 / 25.2 | 0.019 | 0.659 | 0.066 / 0.197 |
| Native | wfc | 4 / OFF | 300 | 60.3 | 120.00 | 8.4 / 8.5 / 8.5 | 0.009 | 0.420 | — |
| Native | net | 1 / OFF | 297 | 217.4 | 118.41 | 8.4 / 8.5 / 41.6 | 0.119 | 0.577 | — |
| Native | net | 2 / ON | 301 | 81.7 | 120.02 | 8.5 / 8.5 / 8.5 | 0.140 | 0.628 | 0.066 / 0.262 |
| Native | net | 3 / ON | 300 | 64.8 | 120.00 | 8.4 / 8.5 / 8.7 | 0.102 | 0.430 | 0.066 / 0.262 |
| Native | net | 4 / OFF | 300 | 60.3 | 120.00 | 8.4 / 8.5 / 9.2 | 0.110 | 0.565 | — |
| Android layout | bvh | 1 / OFF | 300 | 356.3 | 120.00 | 8.4 / 8.5 / 8.7 | 1.511 | 0.353 | — |
| Android layout | bvh | 2 / ON | 301 | 66.0 | 120.00 | 8.4 / 8.5 / 8.6 | 1.546 | 0.328 | 0.066 / 0.066 |
| Android layout | bvh | 3 / ON | 300 | 99.5 | 120.00 | 8.5 / 8.5 / 8.6 | 1.352 | 0.405 | 0.066 / 0.066 |
| Android layout | bvh | 4 / OFF | 300 | 86.3 | 120.00 | 8.4 / 8.5 / 8.5 | 1.401 | 0.384 | — |
| Android layout | splines | 1 / OFF | 301 | 358.3 | 119.60 | 8.4 / 8.5 / 16.7 | 0.160 | 0.496 | — |
| Android layout | splines | 2 / ON | 300 | 52.1 | 120.00 | 8.4 / 8.5 / 8.5 | 0.103 | 0.357 | 0.131 / 0.131 |
| Android layout | splines | 3 / ON | 300 | 45.0 | 120.00 | 8.4 / 8.5 / 8.9 | 0.109 | 0.397 | 0.131 / 0.131 |
| Android layout | splines | 4 / OFF | 299 | 58.4 | 120.00 | 8.4 / 8.5 / 8.6 | 0.141 | 0.507 | — |
| Android layout | navmesh | 1 / OFF | 298 | 262.4 | 119.20 | 8.5 / 8.6 / 25.0 | 0.700 | 0.618 | — |
| Android layout | navmesh | 2 / ON | 301 | 63.8 | 120.00 | 8.5 / 8.5 / 8.5 | 0.445 | 0.417 | 0.066 / 0.066 |
| Android layout | navmesh | 3 / ON | 300 | 57.0 | 120.00 | 8.5 / 8.5 / 8.7 | 0.411 | 0.349 | 0.000 / 0.000 |
| Android layout | navmesh | 4 / OFF | 299 | 52.3 | 120.00 | 8.4 / 8.5 / 8.5 | 0.342 | 0.255 | — |
| Android layout | wfc | 1 / OFF | 300 | 242.1 | 120.00 | 8.4 / 8.5 / 8.5 | 0.007 | 0.285 | — |
| Android layout | wfc | 2 / ON | 300 | 72.4 | 120.00 | 8.4 / 8.5 / 8.5 | 0.016 | 0.555 | 0.066 / 0.066 |
| Android layout | wfc | 3 / ON | 301 | 56.7 | 120.01 | 8.4 / 8.5 / 8.5 | 0.005 | 0.428 | 0.066 / 0.066 |
| Android layout | wfc | 4 / OFF | 277 | 51.9 | 110.07 | 8.4 / 33.2 / 91.7 | 0.010 | 0.691 | — |
| Android layout | net | 1 / OFF | 300 | 246.1 | 120.00 | 8.4 / 8.5 / 8.5 | 0.182 | 0.874 | — |
| Android layout | net | 2 / ON | 300 | 64.1 | 120.00 | 8.4 / 8.5 / 8.6 | 0.180 | 0.773 | 0.066 / 0.066 |
| Android layout | net | 3 / ON | 300 | 57.4 | 120.00 | 8.5 / 8.5 / 9.0 | 0.119 | 0.562 | 0.066 / 0.066 |
| Android layout | net | 4 / OFF | 292 | 52.1 | 114.88 | 8.5 / 24.9 / 66.8 | 0.212 | 0.760 | — |

Byte/hash snapshots were taken before these measurements. These are built entry/source bytes, not full production bundles; core’s entry re-exports additional modules. Strict real core+stage validation is recorded separately as 19,975 gzip bytes.

| File | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| `packages/core/dist/index.js` | 319 | 178 |
| `packages/stats/dist/index.js` | 9243 | 3268 |
| `packages/bvh/dist/index.js` | 421 | 238 |
| `packages/splines/dist/index.js` | 3936 | 1378 |
| `packages/navmesh/dist/index.js` | 8669 | 3050 |
| `packages/wfc/dist/index.js` | 4408 | 1619 |
| `packages/net/dist/index.js` | 3480 | 1287 |
| `examples/package-benchmarks/bvh.js` | 5009 | 1880 |
| `examples/package-benchmarks/splines.js` | 3159 | 1338 |
| `examples/package-benchmarks/navmesh.js` | 5111 | 1919 |
| `examples/package-benchmarks/wfc.js` | 3283 | 1364 |
| `examples/package-benchmarks/net.js` | 2131 | 904 |
| `examples/package-benchmarks/main.js` | 10416 | 3639 |
| `examples/package-benchmarks/gpu-timing.js` | 1549 | 672 |
| `packages/shared/demo-frame.js` | 2927 | 1065 |

Correctness command: `node --test examples/package-benchmarks/routing-generation.test.js packages/splines/test/splines.test.js packages/navmesh/test/navmesh.test.js packages/wfc/test/wfc.test.js examples/package-benchmarks/bvh.test.js packages/net/test/net.test.js tests/package-workload-metrics.test.js` passed 22/22. New tests verify real curve identities/query counts and stable buffers, connected hole-avoiding paths, bounded simultaneous velocities, WFC seed replay/adjacency/pins, invalid inputs and disposal. Net’s final identity-copy initialization and search/quaternion code are included in this build snapshot.

The earlier first-four [report](./package-workloads-2026-10-13.md) and its ignored JSON were preserved. This run uses `WORKLOAD_PACKAGES=bvh,splines,navmesh,wfc,net` and `WORKLOAD_REPORT_PREFIX=package-routing-generation-net-final`. Detailed portable evidence: [JSON](./package-routing-workloads-2026-10-13.json); ignored screenshots/report use that prefix under `test-results`.

After this capture, the harness gained a minimal awaited-factory/late-disposal guard for separate Navigation/Physics examples, plus registry entries for Navigation/Physics/Road. Their real Wasm/CPU correctness checks passed separately; their native cadence/startup and the new asynchronous setup path remain browser-pending. No live deployment occurred. All packages remain open for full acceptance and evidence-led tuning.
