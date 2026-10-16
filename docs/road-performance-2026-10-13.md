# Road generation audit

The optional Road package exports one function, `road(curve, options)`, and its
options/result interfaces. The complete caller trace found its catalog entry,
the portable module-consumer check, the existing Road unit test, and the new
bounded visible workload. There is no production scene caller to update.

Defaults and validation remain width 6, curbWidth 0.2, curbHeight 0.15,
segments 128, uvMeters 5, at most 4,096 segments and 2–32 cross-section coordinates.
The Y-up spline must have a nonvertical tangent. Returned core Geometry has
hard-normal duplicate vertices and original triangle winding; UVs stay separate
and the returned section owns coordinate copies. No API, feature, configuration
or quality change is proposed.

The rejected candidate replaced position/normal/UV temporary array literals and their
`Float32Array.set` calls with direct attribute writes. Every arithmetic
expression was retained. The index array, section copy, normalization, sampling,
validation and core Geometry construction were retained. It passed exact output
and useful CPU-gain checks but failed the user's size requirement. Road source
and distribution were restored to the baseline; no optimization is retained.

The regression file `packages/road/test/generation.test.js` adds an independent
graded-line position/normal/UV/winding oracle, ownership checks,
minimum/maximum topology budgets and
invalid profiles. `scripts/benchmark-road.js` accepts an explicit Git baseline
ref, bundles both versions with identical optional-package flags, checks full
vertex/normal/index/bounds/UV byte equality and section copies, and alternates
12 ABBA/BAAB blocks for six actual workloads. Timings include the complete
generation and Geometry constructor; array-call instrumentation runs separately
in the benchmark. All three restored package unit tests pass.

```sh
node scripts/build-optional.js road
node --test packages/road/test/*.test.js
node scripts/benchmark-road.js 5fc55a0826fba23f0ff220f48bc6bf6de6c305cd --direct-writes
```

These are CPU producer measurements. They do not establish browser rendering
FPS, physical-phone performance or cold hosted startup. The visible Road
workload remains available independently of whether this candidate is retained.

The original measurement used Node 24.15.0 on Windows x64, Intel Core Ultra 7
258V, after eight alternating warm-up batches per case. Full vertices, normals,
indices, bounds and UV bytes and section coordinates matched in all six cases.
The initial candidate eliminated the three temporary source-array calls per
vertex: 714 for the visible demo, 5,418 at default settings and 172,074 at the maximum
segment count. These are observed calls, not a heap-profiler allocation count.

| Actual sweep | Original median ms/road | Candidate median ms/road | Median paired ratio | Faster pairs |
| --- | ---: | ---: | ---: | ---: |
| Visible 16-segment demo | 0.03325 | 0.01990 | 1.67× | 12/12 |
| Default 128 segments | 0.26889 | 0.17516 | 1.51× | 12/12 |
| 32-corner profile, 256 segments | 1.86944 | 1.09800 | 1.71× | 11/12 |
| 1,024 segments | 2.03404 | 1.30691 | 1.63× | 12/12 |
| Maximum 4,096 segments | 7.91047 | 5.32822 | 1.54× | 12/12 |
| Minimum 1 segment/two corners | 0.00208 | 0.00171 | 1.26× | 10/12 |

Practical cases won 59/60 paired blocks; all cases won 69/72. The complete traces
and output/array-call evidence are in the ignored
`test-results/road-generation-rejected-attributes.json`; the portable script's
`--direct-writes` option reconstructs the exact initial experiment from the
explicit baseline Git ref in memory, with no production source/dist writes.

The identical optional Vite build measured the original at 2,384 raw/1,075 gzip
bytes and the initial candidate at 2,392 raw/1,090 gzip. Additional equivalent
address spellings were measured for size only; they were not accepted or used
as timing evidence:

| Direct-write spelling | Raw delta | Gzip delta |
| --- | ---: | ---: |
| Initial independent position/UV offsets |+8|+15|
| Repeated UV address |+5|+12|
| Repeated attribute addresses |+18|+9|
| Paired position/normal writes |−7|+7|
| Paired two-index writes |−9|+9|

Every form increased gzip, so this direct-write approach reached the size gate
and was rejected despite the CPU improvement. Further attempts must find an
exact, understandable shrink before proposing the runtime change again. Index
literal removal or caching repeated scalar work is a separate, unmeasured
hypothesis; neither was added to Road production source.
