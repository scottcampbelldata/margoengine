# BVH performance check — October 13, 2026

`MeshBVH.shapecast()` constructed two child/score pairs and their outer array at each internal node. The candidate keeps two mutable child slots in an index loop. It preserves scoring, callback order, containment, recursive traversal, early exits and independently retained ray hits. Build, refit and intersection arithmetic are unchanged.

The source caller audit found no production use outside the existing BVH tests before this work. The new [package workload](../examples/package-benchmarks/bvh.js) uses an actual 20,000-triangle heightfield, deforms/refits it, queries a moving broad-phase region with `shapecast`, and renders markers from actual nearest ray hits. Amber means the hit triangle is in a selected leaf range; the region is conservative, rather than an exact triangle/rectangle intersection. Red marks actual missed ray origins. Presets are 64/256/1,024 rays per frame, default 256. Build CPU time is separate from per-frame deformation, refit, shapecast, ray queries and render measurements.

The baseline was Git `5fc55a0826fba23f0ff220f48bc6bf6de6c305cd`; its built/source snapshot is locally retained in ignored `test-results/bvh-before-shapecast`. A portable [CPU benchmark](../scripts/benchmark-bvh.js) rebuilds that source class using the package's TypeScript configuration and checks unchanged build/math dependencies. It uses the actual candidate build and rejects a stale `dist`.

| Traversal form | Built bvh.js raw delta | Gzip delta | Evidence |
| --- | ---: | ---: | --- |
| Original child/score arrays | 0 | 0 | Saved baseline: 35,525 raw / 8,462 gzip |
| Index loop with explicit `i === 0` ternaries | +53 | +8 | All 20 package tests; paired CPU gains, rejected size growth |
| Index loop with truthy `i` ternaries | +41 | +3 | Emitted-code byte comparison only; not accepted or performance tested |
| Child/score slots in loop initializer/update | +25 | +1 | Emitted-code byte comparison only; not accepted or performance tested |
| Two mutable child slots | +32 | −21 | Exact callbacks and paired CPU gains |
| Two mutable slots, documentation kept in erased callback interface | −89 | −63 | Final accepted CPU candidate; all 20 package tests and 3 workload tests pass |

Sizes compare the same TypeScript output and Node gzip settings. Other built JavaScript modules are byte-identical. The final accepted form changes `bvh.js` to 35,436 raw / 8,399 gzip bytes, and total package JS from 85,332 raw / 22,853 summed individual-module gzip bytes to 85,243 / 22,790. Documentation remains in the erased callback interface and emitted declaration. Core and stage are untouched. Declarations, workload/test files and documentation are separate from these runtime JS measurements.

The local CPU workload built identical node/index/face bytes for baseline and candidate: 20,000 triangles and 6,367 nodes. For each of four query modes, 24 deterministic region inputs produced exactly equal complete callback traces, scores, containment/depth/node arguments, selected face order, early-stop return values and counters. Each mode then warmed up with 12 alternating batches and measured 12 ABBA blocks, 24 queries per batch. Trace capture is outside timed regions.

| Query mode | Baseline median/batch | Candidate median/batch | Median paired speed ratio | Winning blocks |
| --- | ---: | ---: | ---: | ---: |
| Entire contained tree | 3.2907 ms | 2.3555 ms | 1.43× | 12/12 |
| Moving region | 0.5519 ms | 0.4246 ms | 1.29× | 11/12 |
| Scored region traversal | 0.7211 ms | 0.5760 ms | 1.25× | 11/12 |
| Third-leaf early exit | 0.0377 ms | 0.0226 ms | 1.66× | 12/12 |

These are CPU query measurements, not native browser FPS or production proof. The final source passed all 20 package tests, including the existing shapecast correctness test and two new callback-order/nested-query/early-stop tests. Three workload tests check independent triangle interpolation, refitted storage identity, ray identities, selected marker colors and disposal. The full 29-test combined run also covered all 6 Shadows tests. Native BVH visual/performance checks and further diminishing-return review remain pending.

Reproduce from the repository root after building optional dependencies:

```powershell
node packages/bvh/scripts/build.js
node --test packages/bvh/tests/*.test.js examples/package-benchmarks/bvh.test.js
node scripts/benchmark-bvh.js 5fc55a0826fba23f0ff220f48bc6bf6de6c305cd
```

The benchmark writes full ABBA timings and module sizes to ignored `test-results/bvh-shapecast-benchmark.json`. Run performance measurements without simultaneous builds or other native GPU/CPU benchmarks. Build/refit/ray APIs, worker building, serialized layout, conservative pruning slack, face ties, side rules, non-unit direction distances and retained result objects remain requirements for later candidates. Pooling returned hit vectors would break retained-hit behavior and is not part of this change.
