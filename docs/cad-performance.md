# CAD performance (machinery at assembly scale)

Measured 2026-10-14 (11:53-12:02 UTC) on Scott's laptop: Intel Core Ultra 7 258V, Intel Arc 140V (WebGPU `intel` /
`xe-2lpg`), 31 GB, headless Edge 155 through Playwright, canvas 1432x768 at DPR 1, 4x MSAA (the desktop full tier),
vsync and the frame-rate limit off (FPS is throughput, not a 60 Hz cap), cross-origin isolated (5 µs timers). All
numbers below come from one session on AC power (checked before and after every run and recorded in each JSON file as
`acPowerAtStart` / `acPowerAtEnd`) while holding the shared `test-results/gpu.lock`, one GPU run at a time. Earlier
sessions without a recorded power state were discarded; they ran 10-40% faster or slower for the same build, so compare
numbers only within one session. Raw JSON: `examples/package-benchmarks/cad/results-*.json`.

## Workload

`examples/package-benchmarks/cad/assembly.js`: five distinct part shapes (plate with 8 holes, L bracket, hex-head bolt,
chamfered hex nut, washer) instanced into modules of 27 parts (1 plate, 2 brackets, 8 bolts, 8 nuts, 8 washers) under a
5-level hierarchy: root > zone (32 modules) > module > fastener set > part. 30 entities per module (27 parts + 3 groups).
The core caps a TransformStore at 100,000 entities, so the largest case is 89,883 parts in 99,976 entities.

| Case | Parts | Entities | Instanced triangles | Distinct triangles |
| --- | --- | --- | --- | --- |
| 10k | 10,017 | 11,143 | 1.29 M | 936 |
| 50k | 50,004 | 55,619 | 6.44 M | 936 |
| max | 89,883 | 99,976 | 11.57 M | 936 |

The camera orbits the whole assembly (overview: 90-97% of parts visible after culling).

## Results (current branch)

| Measure | 10k | 50k | max (90k) |
| --- | --- | --- | --- |
| Kernel tick, transform + hierarchy + cull, isolated | 1.69 ms | 7.74 ms | 16.4 ms |
| Kernel per entity | 152 ns | 139 ns | 164 ns |
| Kernel tick without culling | 1.65 ms | 7.76 ms | 15.8 ms |
| Kernel tick inside the frame | 2.17 ms | 11.0 ms | 20.8 ms |
| Batch collection (core JS, `meshes.forEach`) | 1.18 ms | 6.15 ms | 11.3 ms |
| Submit (renderer.render, includes instance upload) | 2.57 ms | 3.64 ms | 6.89 ms |
| Whole-frame CPU (`engine.render`) | 6.0 ms | 20.9 ms | 39.1 ms |
| Frame interval / FPS | 6.7 ms / 150 | 22.0 ms / 45 | 40.3 ms / 25 |
| GPU, pass timestamps | 5.2 ms | 15.8 ms | 26.9 ms |
| Serial frame (render, then wait for the GPU) | 14.9 ms | 38.9 ms | 71.4 ms |
| `engine.pick` median (first pick) | 12.1 ms (81) | 30.3 ms (86) | 63.5 ms (133) |
| `AssemblyBVH` create / rebuild / raycast | 24.3 / 5.9 / 0.14 ms | 50.4 / 23.7 / 0.34 ms | 112 / 61 / 0.82 ms |
| `ExplodedView` per frame: animating / at rest | 0.68 / 0 ms | 4.30 / 0 ms | 8.05 / 0 ms |
| Engine create / build scene / first frame | 89 / 56 / 72 ms | 120 / 138 / 126 ms | 119 / 298 / 176 ms |
| Load to first frame | 217 ms | 383 ms | 592 ms |
| JS heap | 17 MB | 42 MB | 75 MB |
| Kernel Wasm memory | 4.1 MB | 16.1 MB | 28.2 MB |
| Instance storage (CPU staging = GPU buffer) | 1.3 MB | 5.1 MB | 10.1 MB |
| Removing one mesh (`mesh.dispose()`) | 1.3 ms | 1.9 ms | 3.0 ms |

The 50k and 90k cases are CPU-bound in the core: frame CPU equals the frame interval, and at 90k parts with 1x MSAA
(`--low`) the frame is still CPU-limited (30.9 ms CPU, 24.7 ms GPU, 32 FPS). GPU timestamp sums are unreliable when
frames queue behind each other, so the serial-frame row is the upper bound for GPU work.

### Kernel: the earlier Node figure

The earlier Node run measured about 12.8 ms per tick at 100,000 entities with 10-deep hierarchies and culling.
Confirmed: on AC power Node measures 11.4 ms for 100,000 entities in 10-deep chains and 15.7 ms for the 5-level
assembly (`node examples/package-benchmarks/cad/kernel-node.mjs`, `results-kernel-node.json`); the browser measures
16.4 ms isolated and 20.8 ms inside the frame at 99,976 entities. Culling is under 0.6 ms of it. Claims such as "under
0.5 ms for 50k" are not supported: 50k parts take 7.7 ms.

## Core hot spots (not changed; core is frozen, numbers for the owner)

1. **Kernel tick recomputes every entity every frame** (139-164 ns each; 16.4 ms at 100k entities). `world_matrix`
   rebuilds the local matrix from TRS in f64 with full finiteness checks, recurses up the parent chain, then recomputes
   the bounding sphere, for static parts too. CAD assemblies are almost entirely static: a dirty flag (skip entities
   whose local transform and parent did not change) would make a still frame cost about the cull alone.
2. **Batch collection in JS** (11.3 ms at 81k visible parts): per mesh a `Map.forEach` callback, a `Map.get` for the
   batch, two `TypedArray.set` copies (16-float matrix view + 8-float material) and the id write. With the kernel this is
   32 ms of the 39 ms frame at 90k parts, so the largest assembly cannot reach 30 FPS however fast the GPU is.
3. **Instance upload of every visible part every frame**: 10.1 MB per frame at 90k parts, even when nothing moved.
4. **`engine.pick` re-renders the whole scene** into a 1x1 target and re-runs `update()` (kernel + collection), creating a
   shader module and pipeline on every pick: 63.5 ms at 90k parts. `AssemblyBVH` (below) answers a ray in 0.8 ms.
5. **`Engine.remove` scans every mesh** to unparent children: about 3 ms per removal at 100k entities, so disposing a
   90k-part assembly mesh by mesh is O(n²), minutes.
6. **100,000-entity cap** in `TransformStore.create`: a 100,000-part assembly does not fit once assembly nodes are counted.

## Changes in this branch (machinery only)

### Feature edges: `@margoengine/machinery/edges`

`FeatureEdges` draws CAD feature lines for every mesh: edges whose faces meet at more than `angle` degrees (default 30)
and open boundaries, from `@margoengine/geometry`'s `edgesGeometry`, computed once per distinct geometry and cached.
Lines are drawn instanced per geometry from the same per-geometry instance buffer the core already filled for the parts,
so transforms, frustum culling, hidden parts and `ExplodedView` apply without any per-part CPU work. Constant
screen-space width, antialiased coverage, hardware depth bias (`depthBias`, default 256 units of depth32float, which
scales with depth like float precision) so lines never z-fight their own faces, works under `@margoengine/cameras`
orthographic projection (everything is in clip space), and is clipped by `SectionPlanes` (it detects the section uniform
in the frame's shader and binds the same buffer). A compute pre-pass keeps only parts whose bounding sphere projects to
at least `minRadius` CSS pixels (default 6) and writes an indirect draw; segments shorter than half a pixel are dropped.

It lives in machinery, not lines: it needs the section clipping uniform (now shared through `section-uniform.ts`) and is
CAD-specific; `@margoengine/lines` draws one `Line` per draw call with its own model matrix uniform, which would be 50,000
draws and 50,000 uniform writes here.

| Edges | 10k | 50k | max (90k) |
| --- | --- | --- | --- |
| Segments of visible parts (before the size test) | 0.66 M | 3.28 M | 5.89 M |
| Edge pass GPU | 2.23 ms | 4.65 ms | 5.83 ms |
| Size-test compute pass GPU | 0.07 ms | 0.26 ms | 0.39 ms |
| CPU per frame (visible count per geometry) | 0.26 ms | 0.93 ms | 2.12 ms |
| Edge extraction, first frame (5 shapes) | 6.7 ms | 12.0 ms | 14.4 ms |
| Serial frame with / without edges | 17.9 / 13.8 ms | 49.0 / 40.5 ms | 78.5 / 71.1 ms |

While designing it (earlier sessions, power not recorded) the edge pass at 50k parts went from 27.3 ms (size test in the
vertex shader) to 9.6 ms (compute-compacted list) to 4.5 ms (sub-pixel segments dropped). Real-GPU correctness:
`node packages/machinery/test/edges-check.mjs` checks edge pixels for perspective, orthographic, section-clipped (kept
and removed sides), exploded, hidden and sub-`minRadius` parts, with no WebGPU errors. Still frames:
`node examples/package-benchmarks/cad/run.mjs --sizes= --shot` writes `test-results/cad-edges-{perspective,ortho}.png`.

### Exploded view

`ExplodedView` updated positions on the CPU every frame: a liveness check (`Map.get`) and three writes per part, 0.62 /
4.70 / 11.3 ms per frame at 10k / 50k / 90k parts (before build, same session) even when the amount did not change. It
now writes only when `amount` changes (same API; positions identical): 0 ms at rest. While the amount animates the cost
is unchanged (Node proof at 50k parts: 3.23 ms before, 3.17 ms after), because the per-part liveness check that guards
against writing into a reused entity slot dominates. A GPU offset buffer would remove it but would leave
`node.position`, kernel culling, shadows and BVH picking unaware of the explode, so it was not done.

### Assembly BVH (the package hot spot)

`AssemblyBVH` flattened every instanced triangle into world space and built one Wasm BVH over all of them: it refused
assemblies above 1,000,000 instanced triangles (about 7,800 parts of this workload, so none of the three cases above) and
its rebuild (needed after any transform change, such as an explode) took 1.4 s at 7,560 parts. It now builds one
local-space BVH per distinct geometry, shared by every instance, and tests rays against per-part bounding spheres first;
rebuild recomputes spheres and affine inverses only. Same API.

| `AssemblyBVH`, Node proof (AC) | Before | After |
| --- | --- | --- |
| 7,560 parts, 973k instanced triangles: create | 1,465 ms | 18.9 ms |
| rebuild | 1,400 ms | 3.5 ms |
| raycast | 15.7 µs | 33.9 µs |
| largest distance error vs exact float64 | 3.6e-5 m | 2.3e-13 m |
| 89,883 parts, 11.6M instanced triangles: create / rebuild / raycast | refused | 72 / 41 / 0.60 ms |

Raycast is about 2x slower at this size (a linear sphere pass over parts instead of one world tree); at 90k parts it is
0.6-0.8 ms per ray, fine for clicks. A top-level tree over the spheres is the upgrade if hover picking needs it.

### Sizes (minified + gzip)

| Entry | Before | After |
| --- | --- | --- |
| `@margoengine/machinery/edges` (new; app bundle with core external) | - | 4,299 B, plus 551 B for `edgesGeometry` from `@margoengine/geometry` |
| `@margoengine/machinery/spatial` (with its Wasm kernel chunk) | 14,118 B | 14,937 B |
| `@margoengine/machinery/exploded` | 508 B | 538 B |
| `@margoengine/machinery` root | 33,121 B | 33,849 B |
| core + stage (`npm run measure:size`, untouched) | 18,681 B | 18,681 B |

## STEP / IGES loading (`loadCAD`)

OCCT (occt-import-js 0.0.23) Wasm: 7,604,031 bytes, 3,110,912 gzip; glue JS 96,871 (26,835 gzip); Margo CAD worker
14,246 (5,672 gzip). Sample files ship with the occt-import-js dev dependency (the repo has none of its own):

| File | Size | Result | Worker start | OCCT ready | Tessellated | Total |
| --- | --- | --- | --- | --- | --- | --- |
| `cax-if/as1-oc-214.stp` | 441,968 B | 18 parts, 5,040 triangles | 39-48 ms | 184-246 ms | 1,376-1,680 ms | 1,403-1,715 ms |
| `cube-10x10mm/Cube 10x10.igs` | 11,562 B | 1 part, 12 triangles | 31-34 ms | 155-181 ms | 358-452 ms | 361-456 ms |

(Three runs each.) OCCT initialisation (load + compile + instantiate) is about 120-200 ms after the worker starts;
`ReadStepFile` plus normals dominate at about 1.2-1.5 s for a 442 kB file; smoothing and transfer about 30 ms. A lighter
path: tessellate once (server or build step) and ship the result as a binary mesh, keeping OCCT for user uploads only.

## Reproduce

From the repository root after `node scripts/build-modern.js --precompiled` and `npm run build --workspace packages --if-present`,
on AC power (the scripts refuse to time on battery unless `BENCH_ALLOW_BATTERY=1`), holding `test-results/gpu.lock`:

```sh
node examples/package-benchmarks/cad/run.mjs --sizes=10000,50000,max --label=after
node examples/package-benchmarks/cad/run.mjs --sizes=10000,50000,max --edges --no-bvh --no-explode --label=edges
node examples/package-benchmarks/cad/run.mjs --sizes=max --low --no-bvh --no-explode --label=max-1x-msaa
node examples/package-benchmarks/cad/run.mjs --sizes=1000 --step --shot --no-bvh --no-explode --label=step
# Before/after against another machinery build (Git Bash: MSYS_NO_PATHCONV=1):
node examples/package-benchmarks/cad/run.mjs --sizes=10000 --machinery=/test-results/machinery-7d5a5dd --label=before-10k
node examples/package-benchmarks/cad/kernel-node.mjs
node examples/package-benchmarks/proofs/machinery-cad.proof.js
node packages/machinery/test/edges-check.mjs
```

The `before-*` files used a copy of `packages/machinery/dist` built from `7d5a5dd` sources (`exploded.ts`, `spatial.ts`).
