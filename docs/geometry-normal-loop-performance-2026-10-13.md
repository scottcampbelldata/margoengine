# Geometry normal accumulation loop: rejected private candidate

The candidate replaces the existing per-triangle nested-array iteration with a
numeric three-iteration loop over cached a/b/c indices. It preserves the cyclic
corner arguments a/b/c, b/c/a and c/a/b, Float64 accumulation order, Math.hypot,
Math.acos, normalization and Float32 output. It uses no modulo. Production
Geometry, Core/Stage and guarded app trial sources were not modified.

Exact fixtures passed24 small and17 full/caller cases: 96/192 island fields,
complete terrain stream and128/256 heightmap bytes, representative trees/rock/
fern, degenerate/repeated/out-of-range indices, malformed inputs, signed zero,
NaN/Infinity fallbacks, groups/tangents, fresh normals and unchanged input
positions/indices/UVs. Out-of-range triangle indices retain the existing helper's
fallback behavior; no new validation contract was introduced.

Static caller audit covers the Geometry public export/tests, subdivision,
Terrain heightfieldGeometry and three Procedural foliage calls. Loaders exports
a separate similarly named normals helper and is unaffected. Cabinet/settlement
PBR tangent generation does not duplicate this normal pass. Terrain mesh vertex
and heightmap center sample coordinates differ, so reusing one grid's samples
for the other was rejected as a geometry change.

One bounded counterbalanced CPU run used3 warmups per variant,12 pairs for
normals-only and8 pairs for complete field/stream/heightmap. No browser/GPU work
or additional repeated timing run occurred.

| CPU work | Baseline median ms | Candidate median ms | Speedup |
|---|---:|---:|---:|
| 96-grid normals only | 16.0142 | 13.9068 | 1.1515× |
| 192-grid normals only | 73.2528 | 65.5321 | 1.1178× |
| Complete current96 terrain /128 map | 36.8317 | 36.2373 | 1.0164× |
| Complete192 terrain /256 map | 127.4244 | 115.7510 | 1.1008× |

The current complete CPU path saves0.5944ms median. These offline timings were
collected while root had observed native Screen-saver/PID0. External GPU/screen-
saver load, CPU thermal state, clocks and equivalent power mode were not
controlled. They are not foreground FPS, browser startup or GPU execution proof.

Actual write:false production-config Geometry builds grew55438→55496 raw
(+58) and16147→16169 gzip (+22). Matched whole current consumer JS grew306041→
306069 raw (+28) and102365→102370 gzip (+5). This fails the no-byte-growth gate,
so the candidate is rejected and the owning source remains unchanged.

The recorded older API startup trace had57–61ms settlement construction,
48–49ms terrain mesh construction and22ms heightmap construction gaps. Its
warm-to-principal span also contains26.8/139.2ms of uninstrumented main/canvas
preparation, which is not proven CPU geometry cost. Awaited adapter/device/base
pipeline requests, first-use driver preparation and queue completion remain
separate. In the current source ABBA, first principal GPU completion occurred
at1.8–2.2s and full detail at2.6–3.0s. This small CPU optimization cannot establish
a one-second first-completion target; the tested change was not adopted.

Evidence is preserved in ignored
test-results/geometry-normal-loop-2026-10-13T193655959Z/report.json,
its decision.json and the complete geometry-normal-loop-benchmark-20261013.stdout.log.
The adjacent baseline/candidate full Geometry modules retain actual build bytes;
geometry-normal-loop-candidate.patch is the reviewable private one-loop diff.

## One smaller modulo-index follow-up: rejected before timing

The single follow-up uses a numeric corner-position loop and cyclic index loads
I[t+k], I[t+(k+1)%3], I[t+(k+2)%3]. It preserves repeated-index behavior and does
not infer corner position from vertex identity. The earlier ternary experiment
and its outputs remain unchanged. All24 small and17 full/caller/edge cases pass
with exact Float32 output, unchanged input arrays and existing malformed-input
behavior.

Actual virtual full Geometry builds grow55438→55453 raw (+15),16147→16150 gzip
(+3); the matched whole current consumer grows306041→306048 raw (+7) and
102365→102369 gzip (+4). The size gate failed, so this variant is also rejected.
No warmup or timed CPU benchmark ran, no performance benefit is claimed and
production Geometry/Core/Stage/guarded app sources remain unchanged.

The complete size-gated run exited0 and released the exclusive CPU/build slot.
Evidence is preserved in test-results/geometry-normal-mod-index-2026-10-13T195528175Z/report.json,
its decision.json/repro copies and geometry-normal-mod-index-benchmark-20261013.stdout.log.
The report has timings[] and an explicit timingSkipped reason. No browser/GPU
launch occurred while the native desktop remained Screen-saver.
