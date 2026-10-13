# Capture performance from an affected browser

Open a slow demo at https://margoengine.com in the affected browser. Open DevTools
with Ctrl+Shift+J, paste the contents of `scripts/collect-performance.js`, and
press Enter. Close DevTools after starting the capture to restore the original
viewport. Keep the demo visible for 20 seconds. The script downloads
`margo-performance-<timestamp>.json`; attach that file to the investigation.
Repeat on another slow demo or PC for comparison. Record whether each run used
the physical screen or RDP and whether the laptop was plugged in.

The report contains the active WebGPU device, browser, canvas CSS/backing sizes,
DPR, scene counters, callback intervals, CPU callback durations, queue submissions,
canvas texture acquisitions, long-frame script attribution, errors and focus or
visibility changes. Exact loaded bundle filenames identify the running build.
GPU identity may be restricted or unavailable in some browsers. Missing metrics
remain unavailable rather than becoming zero.

No cookie, persistent storage or upload endpoint is used. The collector restores
its instrumentation after the capture. The JSON is also available as
`window.margoPerformanceReport`; `window.margoPerformanceCapture` resolves with
the same report. Query strings and fragments are removed from recorded URLs.

Texture acquisitions and submissions measure work issued to the GPU, not displayed
frames. CPU callback timing includes JavaScript and command encoding, not GPU
execution. Current engine devices do not request `timestamp-query`, so this
post-load collector does not report GPU pass times. It captures future errors,
not startup failures. Instrumentation, DevTools and changes in visibility can
affect results; discard captures with hidden intervals. Do not use a headless run
as proof of performance in someone's normal browser.

## Controlled live-site comparison on October 12, 2026

Windows Console session, Intel Arc 140V / WebGPU architecture `xe-2lpg`, hardware
adapter (not fallback), Edge 154.0.4258.62, headed browser, native scheduling,
desktop user agent, device DPR 1. The blank-page control supplied approximately
120 callbacks per second. Each scene warmed for four seconds before a five-second
sample. Two alternating original/diagnostic pairs were measured.

| Scene and drawing buffer | Original 4× submissions/second | Diagnostic 1× submissions/second |
| --- | ---: | ---: |
| Helmet, 1130×800 | 119.7, 119.3 | 119.9, 120.1 |
| Citadel, 2880×1462 | 20.2, 22.2 | 56.3, 60.0 |

The diagnostic changed only the core pipeline descriptor's `multisample` count
in the browser's downloaded response. The desktop quality helper, canvas size,
assets, geometry, shadows, water grid, particles and scene settings stayed the
same. Downstream render targets followed the descriptor's sample count. All
observed Citadel pipeline/texture sampling changed to 1×; both pairs had zero
page or GPU validation errors. Nothing was deployed or changed in engine source.

This establishes the multisampling path as a bottleneck for that Citadel workload
on this GPU. It does not establish the cause for every PC, demo, or viewport.
An attached screenshot's physical pixel dimensions alone do not establish the
browser's drawing-buffer dimensions; capture the normal session to compare.
Short submission-rate samples do not certify sustained displayed FPS.

Git history places the new shared core 4× sampling in `4aab554` (October 12,
3:52 AM Eastern) and multisampled HDR targets in `f4f1f31` (5:57 AM). Phones now
use single sampling. The tested current core limits desktop backing DPR to 1.

Local raw reports and the temporary response-transform harness are saved in
`test-results/msaa-ab.json` (helmet), `test-results/msaa-ab-citadel.json` and
`test-results/msaa-ab.mjs`. These files are ignored by Git.

Validate the collector with `node --test tests/performance-capture.test.js`.
Both unit checks pass. A live 20-second Citadel capture also verified the JSON
download, exact hook restoration and continued rendering, with no page errors.
Its saved report is `test-results/performance-capture-live.json`.
