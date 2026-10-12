# Demo cold-load measurements

Measured October 12, 2026, against the production build. Scope: all seven pages
shipped by `scripts/build-site.js`, including both robot entry points.

## Method

`npm run benchmark:demo-loads` uses three fresh Edge/Chromium browser processes per
page, an iPhone user agent, 390 × 844 CSS pixels, DPR 3, touch input, 4× CPU
slowdown, 40 ms request latency and a 10 Mbps download cap. Browser cache is
disabled. A snapshot of `site/dist` keeps concurrent builds from changing assets
during a run. Run this benchmark without other GPU benchmarks for useful timings.

This runs on Windows with an NVIDIA Ampere GPU, **not iPhone Safari or Metal**.
The local preview serves uncompressed assets. CDN DNS/TLS setup and actual mobile
network latency are not included. Fresh browser profiles do not clear driver-level
shader caches. These numbers are a reproducible proxy, not an iPhone guarantee.

First frame means the first submitted draw has completed GPU work and the browser
has had two animation-frame opportunities to present it. An empty canvas does not
count. Scene ready is the later of that time and the demo's controls-ready signal.
Afterlight submits its actual sky before constructing the rest of the island;
the scene-ready measurement waits for the full island and controls.

## Results

| Demo | First frame, median | Scene ready, median | Scene ready, worst of three |
| --- | ---: | ---: | ---: |
| Night Citadel | 901 ms | 901 ms | 1,006 ms |
| Afterlight / gameplay sandbox | 1,412 ms | 1,420 ms | 1,527 ms |
| Damaged helmet | 929 ms | 929 ms | 935 ms |
| Character study | 818 ms | 818 ms | 824 ms |
| Robot Expressive | 813 ms | 813 ms | 851 ms |
| Windy meadow | 740 ms | 740 ms | 752 ms |
| Earth | 844 ms | 844 ms | 887 ms |

Six of seven meet the one-second target on median; Afterlight remains above it.
Night Citadel also crossed one second in one sample. All pages rendered without
browser errors and requested only assets from their own origin.

The initial single-sample run under the same throttle took 4,080 ms for the helmet,
2,846 ms for Earth, 1,471 ms for Character study, 1,465 ms for Robot Expressive and
1,872 ms for Afterlight. The final table uses repeated samples; the baseline did not.

## Changes

- Earth fetches its five maps concurrently, with sibling cancellation and complete
  cleanup if any map fails. It retains the image dimension and memory checks.
- Phones use 1024 × 512 Earth WebP maps: 381,276 bytes total, down from 2,275,024.
  Resized normal/specular maps use lossless encoding. Desktop maps retain 2K detail.
- Model demos use local, pinned GLBs and preload the selected assets. Their optional
  module imports overlap engine initialization instead of forming a request chain.
- The phone helmet uses 512-pixel maps and 6,179 triangles: 600,948 bytes versus
  3,773,916 for the original desktop asset. Source credits and licenses ship with it.
- Afterlight starts with 100k particles, 25k grass instances, 96-cell terrain,
  a 128-cell heightmap, 64 water segments and 512-pixel shadows on phones. Its sky
  GPU work overlaps island construction. All particle tiers remain selectable.

## Verification and reproduction

Build package distributions, then run:

```sh
node scripts/build-site.js
npm run benchmark:demo-loads
```

The full request timings, per-run hardware information and samples are written to
`test-results/demo-loads.json`; phone screenshots are saved beside it.
`node scripts/optimize-demo-assets.js` regenerates the checked-in phone assets using
the workspace's installed sharp, meshoptimizer and gltf-validator tools.

The Planet unit tests cover concurrent requests, sibling failure, late decode
cleanup, caller cancellation, GPU validation failures and device restoration.
Earth, model and Afterlight browser checks cover rendered pixels, mobile controls,
animation, SSAO, HDR, shader errors and GPU recovery. The sandbox typecheck and
package-boundary test pass. The generated helmet passes glTF validation.

Core and stage received no features. Their existing CI gzip gate still rejects
20,000 bytes and above; the measured bundle is 19,998 bytes.

Real-device iPhone Safari and deployed CDN timing remain unverified. Phone detail
is reduced, and startup still depends on device compilation and network speed.
