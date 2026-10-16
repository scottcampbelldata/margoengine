# Runtime package workload evidence

Measured 2026-10-13T06:51:10.441Z–2026-10-13T06:53:20.988Z on Windows, headed Edge 154.0.4258.62, Intel Arc 140V (xe-2lpg), physical WebGPU adapter (fallback false). The four default workloads render all actors and call real package APIs. They are local examples, with native-browser acceptance recorded and physical-mobile/cold-hosted acceptance still pending.

Each case runs 750 ms warmup followed by four 2,500 ms windows in timing OFF/ON/ON/OFF order. Optional Stats profiling samples one frame in 15 with pooled resources. GPU values below are the latest completed **sum of sampled pass execution**, not GPU frame elapsed time, queue waiting or presentation. They are single values, not a distribution of GPU cost. Two runs per mode and refresh-limited cadence cannot establish a universal instrumentation overhead bound.

Explicit launch flags: `--start-maximized`, `--disable-features=CalculateNativeWinOcclusion`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`. These measure foreground throughput while avoiding Windows occlusion throttling. All 32 windows were visible and focused, with no hidden-state changes; cadence describes actual render callbacks, not proof of displayed frames.

Native layout: OS DPR 2, engine backing 1351 × 476 (its existing desktop MSAA/DPR policy). Android layout: 390 × 844, DPR 3, engine backing 712 × 776 (existing mobile policy). Emulation uses the same Intel GPU and a mobile user agent; it does not establish Android, iPhone or Samsung performance. No CPU or network throttling was used. Local Vite transforms/caches differ from a cold hosted build.

| Layout | Package / actors | First principal opportunity from navigation (ms) | OFF callback Hz | OFF workload CPU mean (ms) | OFF render CPU mean (ms) | Worst OFF p99 interval (ms) | ON callback Hz | Latest ON GPU pass sums (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Native Edge | ecs / 10000 | 954.4 | 120.00 | 0.897 | 4.096 | 8.5 | 120.00 | 2.097, 3.801 |
| Native Edge | fsm / 1000 | 364.2 | 120.00 | 0.116 | 0.650 | 8.5 | 119.80 | 0.131, 0.197 |
| Native Edge | tween / 1000 | 442.8 | 120.00 | 0.096 | 0.729 | 8.5 | 120.00 | 0.131, 0.197 |
| Native Edge | net / 256 | 439.3 | 120.00 | 0.086 | 0.420 | 8.5 | 119.80 | 0.066, 0.066 |
| Android layout on Intel | ecs / 10000 | 445.9 | 120.00 | 0.650 | 3.363 | 8.5 | 120.00 | 0.590, 0.590 |
| Android layout on Intel | fsm / 1000 | 438.7 | 120.00 | 0.104 | 0.623 | 8.5 | 120.00 | 0.131, 0.131 |
| Android layout on Intel | tween / 1000 | 387.5 | 120.00 | 0.070 | 0.557 | 8.5 | 120.00 | 0.131, 0.131 |
| Android layout on Intel | net / 256 | 362.3 | 120.00 | 0.079 | 0.369 | 8.5 | 120.00 | 0.066, 0.131 |

All eight initial identified principal-scene opportunities were within 1,000 ms in this local run. This correlates the **last successful submission made by the assembled-scene render**, its GPU completion and two later animation callbacks. It excludes earlier preparatory submissions. Screenshot color variation independently rejects a blank canvas, and rendered/principal actor counts match the selected workload. These checks provide local scene-readiness evidence; they do not prove cold production or physical-display deadlines.

Every case passed keyboard Enter/Space Run/Pause, stable frame/submission counters while paused, workload-count rebuild with disposal of prior devices, resized backing pixels and actor continuity, restored requestDevice method after setup, and terminal pagehide resource disposal. Horizontal overflow was false at native/portrait widths. Browser exceptions and uncaptured GPU errors were zero. The source camera refits on resize; the automated resize check does not establish pixel-exact framing.

Per-run timings are relative to each navigation. Rebuild readiness subtracts that generation’s load-start marker; first-load navigation markers remain in the JSON. Interval data retain long gaps and exclude callbacks crossing warmup/pause boundaries. CPU columns include workload/pose generation and mesh synchronization/command encoding separately.

| Layout | Package | Run / timing | Measured callbacks | Rebuild-to-principal (ms) | Callback Hz | Interval p95 / p99 / max (ms) | Work CPU mean (ms) | Render CPU mean (ms) | GPU pass sum (ms) |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Native | ecs | 1 / OFF | 301 | 591.6 | 120.00 | 8.5 / 8.5 / 8.6 | 0.876 | 4.500 | — |
| Native | ecs | 2 / ON | 301 | 156.5 | 120.00 | 8.4 / 8.5 / 8.5 | 1.010 | 4.324 | 2.097 |
| Native | ecs | 3 / ON | 301 | 105.4 | 120.00 | 8.4 / 8.5 / 8.5 | 0.835 | 3.654 | 3.801 |
| Native | ecs | 4 / OFF | 301 | 97.3 | 120.00 | 8.5 / 8.5 / 8.5 | 0.919 | 3.691 | — |
| Native | fsm | 1 / OFF | 300 | 189.9 | 120.00 | 8.4 / 8.5 / 8.5 | 0.115 | 0.649 | — |
| Native | fsm | 2 / ON | 299 | 117.9 | 119.60 | 8.4 / 8.5 / 16.6 | 0.130 | 0.684 | 0.131 |
| Native | fsm | 3 / ON | 301 | 78.7 | 120.00 | 8.4 / 8.5 / 8.5 | 0.116 | 0.642 | 0.197 |
| Native | fsm | 4 / OFF | 300 | 64.8 | 120.00 | 8.5 / 8.5 / 8.5 | 0.117 | 0.650 | — |
| Native | tween | 1 / OFF | 301 | 187.6 | 120.00 | 8.4 / 8.5 / 8.6 | 0.107 | 0.695 | — |
| Native | tween | 2 / ON | 300 | 118.8 | 120.00 | 8.4 / 8.5 / 8.5 | 0.095 | 0.641 | 0.131 |
| Native | tween | 3 / ON | 306 | 65.5 | 120.00 | 8.5 / 8.5 / 8.5 | 0.091 | 0.753 | 0.197 |
| Native | tween | 4 / OFF | 301 | 72.6 | 120.00 | 8.4 / 8.5 / 8.5 | 0.085 | 0.763 | — |
| Native | net | 1 / OFF | 301 | 259.5 | 120.00 | 8.4 / 8.5 / 9.0 | 0.085 | 0.451 | — |
| Native | net | 2 / ON | 299 | 114.4 | 119.60 | 8.4 / 8.5 / 16.9 | 0.101 | 0.485 | 0.066 |
| Native | net | 3 / ON | 300 | 69.6 | 120.00 | 8.4 / 8.5 / 8.5 | 0.097 | 0.428 | 0.066 |
| Native | net | 4 / OFF | 300 | 60.1 | 120.00 | 8.5 / 8.5 / 8.5 | 0.087 | 0.388 | — |
| Android layout | ecs | 1 / OFF | 301 | 304.7 | 120.00 | 8.4 / 8.5 / 8.6 | 0.529 | 2.822 | — |
| Android layout | ecs | 2 / ON | 300 | 115.0 | 120.00 | 8.4 / 8.5 / 8.5 | 0.619 | 3.091 | 0.590 |
| Android layout | ecs | 3 / ON | 301 | 91.2 | 120.00 | 8.4 / 8.5 / 8.6 | 0.736 | 4.024 | 0.590 |
| Android layout | ecs | 4 / OFF | 301 | 91.2 | 120.00 | 8.4 / 8.5 / 8.7 | 0.771 | 3.905 | — |
| Android layout | fsm | 1 / OFF | 300 | 272.9 | 120.00 | 8.4 / 8.5 / 8.6 | 0.106 | 0.623 | — |
| Android layout | fsm | 2 / ON | 301 | 101.7 | 120.01 | 8.4 / 8.5 / 8.5 | 0.119 | 0.613 | 0.131 |
| Android layout | fsm | 3 / ON | 301 | 54.2 | 120.00 | 8.4 / 8.5 / 8.5 | 0.090 | 0.487 | 0.131 |
| Android layout | fsm | 4 / OFF | 301 | 44.1 | 120.00 | 8.4 / 8.5 / 8.5 | 0.102 | 0.622 | — |
| Android layout | tween | 1 / OFF | 301 | 245.5 | 120.00 | 8.4 / 8.5 / 8.5 | 0.073 | 0.519 | — |
| Android layout | tween | 2 / ON | 300 | 88.0 | 120.00 | 8.4 / 8.5 / 8.5 | 0.086 | 0.599 | 0.131 |
| Android layout | tween | 3 / ON | 301 | 56.5 | 120.00 | 8.4 / 8.5 / 8.5 | 0.060 | 0.599 | 0.131 |
| Android layout | tween | 4 / OFF | 300 | 43.1 | 120.00 | 8.4 / 8.5 / 8.5 | 0.067 | 0.595 | — |
| Android layout | net | 1 / OFF | 301 | 254.7 | 120.00 | 8.4 / 8.5 / 8.5 | 0.082 | 0.385 | — |
| Android layout | net | 2 / ON | 300 | 105.3 | 120.00 | 8.4 / 8.5 / 8.5 | 0.083 | 0.445 | 0.066 |
| Android layout | net | 3 / ON | 299 | 55.4 | 120.00 | 8.4 / 8.5 / 8.5 | 0.090 | 0.385 | 0.131 |
| Android layout | net | 4 / OFF | 301 | 53.7 | 120.00 | 8.4 / 8.5 / 8.5 | 0.077 | 0.353 | — |

Byte sizes below are a later source/build snapshot, not the production bundle or its full dependency graph. Net’s last build occurred after measurement for the `createSnapshot` identity-array allocation change; that initialization change needs separate acceptance. The recorded loop measurements cover the already-built snapshot-search/quaternion candidate. SHA-256 and write times are preserved in the portable JSON. The runner now records bytes/hashes before future runs.

| Path | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| `packages/ecs/dist/index.js` | 3647 | 1336 |
| `examples/package-benchmarks/ecs.js` | 1531 | 631 |
| `packages/fsm/dist/index.js` | 2270 | 924 |
| `examples/package-benchmarks/fsm.js` | 1913 | 833 |
| `packages/tween/dist/index.js` | 1990 | 870 |
| `examples/package-benchmarks/tween.js` | 1047 | 548 |
| `packages/net/dist/index.js` | 3480 | 1287 |
| `examples/package-benchmarks/net.js` | 2131 | 904 |
| `examples/package-benchmarks/main.js` | 9949 | 3497 |
| `examples/package-benchmarks/gpu-timing.js` | 1549 | 672 |
| `packages/shared/demo-frame.js` | 2927 | 1065 |
| `packages/stats/dist/index.js` | 10528 | 3451 |

Reproduce with `node scripts/benchmark-package-workloads.js`. Default cases are ECS/FSM/Tween/Net; BVH is integrated and has separate CPU correctness evidence, but was not included in these native runs. The 21 small correctness checks passed via `node --test tests/package-workload-metrics.test.js tests/principal-scene-ready.test.js tests/demo-frame.test.js examples/package-benchmarks/*.test.js`. Shared readiness tests include a preparatory submit followed by the full-scene submit, cancellation and exact hook restoration.

Portable detailed evidence: [package-workloads-2026-10-13.json](./package-workloads-2026-10-13.json). Ignored local report and eight screenshots: `test-results/package-workload-benchmarks.json` and `test-results/package-*.png`. Principal startup route/asset planning is recorded separately in [startup-readiness-audit-2026-10-13.md](./startup-readiness-audit-2026-10-13.md).
