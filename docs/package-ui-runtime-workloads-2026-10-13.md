# Runtime and UI workload evidence — 2026-10-13

Four meaningful UI examples join the existing package harness: Gizmo, Inspector, Labels and HTML. Actual Recast Navigation, Rapier Physics and spline Road workloads also passed native checks. All 14 cases completed 56 accepted OFF/ON/ON/OFF measurement windows with actual query-resource, principal-submission, keyboard/pause, rebuild, resize and terminal-cleanup assertions. This is scoped local acceptance; package tuning and whole-product acceptance remain open.

| Profile | Package | Actors | Initial principal opportunity ms | OFF callbacks/s | Workload CPU ms | Render CPU ms | OFF longest interval ms | OFF intervals over 60 FPS budget |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Native | navigation | 128 | 1409 | 120.00 | 0.500 | 0.320 | 8.6 | 0 |
| Native | physics | 80 | 1454 | 120.00 | 0.233 | 0.285 | 8.5 | 0 |
| Native | road | 136 | 389 | 119.60 | 0.158 | 0.339 | 16.7 | 0 |
| Native | gizmo | 16 | 947 | 120.00 | 0.011 | 0.459 | 8.7 | 0 |
| Native | inspector | 16 | 599 | 120.00 | 0.016 | 0.350 | 8.6 | 0 |
| Native | labels | 16 | 356 | 120.00 | 0.012 | 0.388 | 8.5 | 0 |
| Native | html | 16 | 521 | 120.00 | 0.009 | 0.740 | 8.5 | 0 |
| Phone layout | navigation | 128 | 849 | 119.60 | 0.968 | 0.554 | 16.7 | 0 |
| Phone layout | physics | 80 | 1010 | 119.80 | 0.423 | 0.528 | 16.9 | 1 |
| Phone layout | road | 136 | 470 | 120.00 | 0.240 | 0.482 | 8.6 | 0 |
| Phone layout | gizmo | 16 | 502 | 119.99 | 0.011 | 0.418 | 8.5 | 0 |
| Phone layout | inspector | 16 | 555 | 120.00 | 0.015 | 0.355 | 8.6 | 0 |
| Phone layout | labels | 16 | 379 | 120.00 | 0.008 | 0.354 | 8.5 | 0 |
| Phone layout | html | 16 | 360 | 120.00 | 0.009 | 0.696 | 8.6 | 0 |

Each CPU mean combines two 2,500 ms baseline windows, weighted by measured callback counts. Native callback intervals are retained unclipped; the first callback after Run is excluded. Initial principal opportunity is relative to page navigation: the last successful submission from the assembled render, completion of that work and two subsequent animation callbacks. It proves a rendered principal-scene opportunity, not physical display. UI overlay settling is separately bounded and does not change that marker. Complete-scene values above 1,000 ms are retained as misses.

UI checks used actual browser interactions: Gizmo X-handle pointer drag and reset; Inspector position, visibility and GPU AABB controls; Labels clickable selection, toggle and remove/re-add; HTML rendered-depth hiding inside anchors, showing them above and hiding them again while paused without advancing simulation frames. Screenshots retain the stage/DOM controls separately. Six new Node checks cover package operations, stable poses, owned handlers and late-preview cancellation; existing four-package checks pass 22/22.

GPU timing remains off by default and creates zero query sets in baseline scenes, even though the active Core device supports timestamps. Timing-on scenes allocate one pooled query set; every completed per-pass array has the reported count and sums to the aggregate. Latest samples include sum and first-begin/last-end span in the JSON. Quantized 0 ms samples are valid completed measurements; they do not mean no GPU work. Two windows per mode at refresh-limited cadence cannot establish a universal profiler-overhead bound. CPU timing covers synchronous workload/encoding; DOM refresh timers, buffer-map callbacks and browser scheduling can fall outside those columns.

The seven source workloads have clearly labeled local example routes and bounded presets. Gizmo/Inspector preserve selected edits; other cubes move. Labels project real 2D/CSS3D elements. HTML uses actual shared scene depth and bounded asynchronous settling. No package source, renderer refactor, new dependency, production deployment or remote measurement endpoint was added for these examples.

Portable full evidence: [JSON](package-ui-runtime-workloads-2026-10-13.json). It retains raw per-run distributions, readiness phase markers, adapter/features/backing dimensions, visibility/focus observations, GPU passes, sum/span, CPU workload counters, entry/source hashes and UI checks. Built-entry size is not the whole dependency graph. The first native Navigation/Physics/Road cases precede only UI-preview/automation fixes; their simulation/render loops were unchanged. Original Gizmo assertions failed for immediate keyboard-pause state and a phone-layout drag after controls scrolled the canvas; both are retained as rejected evidence. Final UI checks wait for activation and scroll the canvas into view before obtaining drag coordinates; these passed without a package-source change. No rejected windows were silently used.

Runs use headed Edge with explicit occlusion/background-throttling flags. Android-sized layout uses the same Intel laptop GPU, not physical Android hardware. Local Vite startup is not cold hosted startup; module/Wasm initialization remains part of measured readiness. Nothing here closes physical-mobile, cold-hosted or universal 60 FPS/1,000 ms acceptance.
