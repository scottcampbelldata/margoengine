# Pinned live island: opt-in GPU pass profile

Four 10-second desktop / phone / phone / desktop windows completed on Chrome
**155.0.8059.40**, with fresh owned contexts, no device reboot, identical
1432×768 canvas, engine DPR 1, camera and solar time 18.016666666666666 hours.
Each used the pinned published 301030-byte entry, private 1×/DPR1 rewrite and
unchanged authored 1M particle capacity/settings. Phone UA selects the authored
smaller scene on this same Intel laptop; it does not emulate iPhone hardware.

GPU profiling explicitly enabled timestamp-query and the existing Stats pool.
Its render rates are separate from the default query-free experiment. All timed
windows had one real native submission per successful Engine.render, unchanged
pipelines/shaders/GPU allocations, exact cameras, visible foreground, valid
1M indirect counts and no page/GPU errors. Every context/device and tracked
buffer/texture retired. Browser.close exceeded 30 seconds; the runner exited 1.
Final tasklist and native inventories show the exact owned Chrome and runner
absent. Earlier CIM returned a stale exited Chrome row. No successful process
termination occurred and no user Chrome was touched.

| Metric | Desktop A1 | Phone B1 | Phone B2 | Desktop A2 |
|---|---:|---:|---:|---:|
| Instrumented render/submit Hz | 34.8404 | 39.1912 | 38.6427 | 33.5724 |
| Native samples | 24 | 26 | 26 | 23 |
| Median pass sum, ms | 22.806528 | 19.791872 | 20.447232 | 22.282240 |
| Median first-pass to last-pass span, ms | 27.525120 | 23.396352 | 23.789568 | 27.918336 |
| Median non-pass time inside that span, ms | 4.915200 | 3.473408 | 3.604480 | 5.373952 |
| Maximum non-pass time inside span, ms | 6.160384 | 9.306112 | 7.077888 | 8.781824 |
| Median read callback wall time, ms | 171.8 | 160.3 | 177.2 | 173.7 |

The following are per-pass medians in milliseconds. Pipeline/module identities
and full WGSL sources are retained in the raw report; descriptions group source
roles and do not imply time was measured separately inside a combined pass.

| Pass | Role | Desktop A1 | Phone B1 | Phone B2 | Desktop A2 |
|---|---|---:|---:|---:|---:|
| 0 | Scatter grass culling compute | .065536 | .065536 | .065536 | .065536 |
| 1 | Scatter fieldstone culling compute | 0 | 0 | 0 | 0 |
| 2 | VFX full-capacity simulation | 4.784128 | 4.784128 | 4.718592 | 5.308416 |
| 3 | Shadow cascade raster | .262144 | .262144 | .262144 | .262144 |
| 4 | Shadow cascade raster | .131072 | .131072 | .131072 | .131072 |
| 5 | Shadow cascade raster | .131072 | .065536 | .065536 | .131072 |
| 6 | Shadow cascade raster | .065536 | .065536 | .065536 | .065536 |
| 7 | Clustered lighting compute | 0 | 0 | 0 | 0 |
| 8 | Main terrain/explorer raster | 4.259840 | 3.342336 | 3.342336 | 4.259840 |
| 9 | Settlement raster | 3.145728 | 3.145728 | 3.145728 | 3.145728 |
| 10 | Grass raster | .786432 | .196608 | .262144 | .786432 |
| 11 | Fieldstone raster | .458752 | .458752 | .458752 | .458752 |
| 12 | Sky reflection compute | 0 | .065536 | .065536 | .065536 |
| 13 | Sky atmosphere compute | .327680 | .262144 | .262144 | .262144 |
| 14 | Combined coastal flow/integration compute | .393216 | .196608 | .196608 | .393216 |
| 15 | Water spray simulation compute | 0 | 0 | 0 | 0 |
| 16 | Water depth-copy compute | .196608 | .131072 | .131072 | .196608 |
| 17 | Water surface raster | .786432 | .458752 | .458752 | .786432 |
| 18 | Water spray raster | 0 | 0 | 0 | 0 |
| 19 | Sky fog compute | .196608 | .196608 | .196608 | .196608 |
| 20 | VFX draw | 4.784128 | 4.587520 | 4.456448 | 4.915200 |
| 21 | Bloom compute | .262144 | .262144 | .262144 | .262144 |
| 22 | AgX presentation raster | .262144 | .262144 | .262144 | .262144 |

Particle simulation and drawing dominate individual GPU passes. Main terrain
and settlement rendering are also substantial; authored phone quality saves
terrain, grass, water and coastal work but retains both expensive particle passes.
The instrumented GPU span remains over 16.67 ms. Zero entries are quantized
measurements, not proof that a pass is free; reported increments are 0.065536 ms.
Adding per-pass medians does not equal the median total.

GPU query nanoseconds and browser performance.now milliseconds are uncalibrated
clock domains. The largest read-wall-minus-native-span residual is 205.309888 ms.
It describes asynchronous queue/callback wall delay and cannot prove CPU cost,
hardware idle or ownership of a particular rendered submission. This existing
pool lacks explicit sample-origin submission identity. A separate private
two-staging diagnostic is prepared to capture originating frame/submit IDs;
it has not been run or accepted for production.

Evidence: ignored test-results/afterlight-live-scene-gpu-profile-chrome-10s-live-scenes-gpu-v1.json
SHA256 `eda5abbb65221ee48eed463c9f96c8dadd52d514959dbd8a1a86617c83321560`.
The adjacent .harness directory preserves the actual executed helper bytes and
hashes. Adjacent .pass-summary.json, .stdout.log, .terminal-cleanup.json and
.evidence.json preserve analysis and terminal evidence. The earlier default
scene ABBA and long sampling reports also record Chrome 155.0.8059.40; previous
154 comparisons have an additional browser-version dimension.
