# CAD performance (machinery at assembly scale)

Measured 2026-10-14 on Scott's laptop: Intel Core Ultra 7 258V, Intel Arc 140V (WebGPU `intel` / `xe-2lpg`), 31 GB,
headless Edge 155 through Playwright, canvas 1432x768 at DPR 1, 4x MSAA (the desktop full tier), vsync and the
frame-rate limit off (FPS is throughput, not a 60 Hz cap), cross-origin isolated (5 µs timers). Every browser number
below was taken while holding the shared `test-results/gpu.lock`, one GPU run at a time. The laptop's speed drifts
between sessions (power and thermal state): the same unchanged build measured 64-146 FPS at 10k parts across
sessions, so compare numbers only within one session. Raw JSON: `examples/package-benchmarks/cad/results-*.json`.

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

The camera orbits the whole assembly (overview: 92-98% of parts visible after culling).

## Results (current branch, one session)

| Measure | 10k | 50k | max (90k) |
| --- | --- | --- | --- |
| Kernel tick, transform + hierarchy + cull, isolated | 1.21 ms | 5.99 ms | 10.9 ms |
| Kernel per entity | 109 ns | 108 ns | 109 ns |
| Kernel tick without culling | 1.18 ms | 5.94 ms | 10.8 ms |
| Kernel tick inside the frame | 1.38 ms | 7.75 ms | 13.0 ms |
| Batch collection (core JS, `meshes.forEach`) | 0.84 ms | 3.90 ms | 7.05 ms |
| Submit (renderer.render, includes instance upload) | 3.98 ms | 2.78 ms | 4.42 ms |
| Whole-frame CPU (`engine.render`) | 6.2 ms | 14.6 ms | 24.6 ms |
| Frame interval / FPS | 6.8 ms / 146 | 15.2 ms / 66 | 25.1 ms / 40 |
| GPU, pass timestamps | 5.4 ms | 12.3 ms | 21.3 ms |
| Serial frame (render, then wait for the GPU) | 11.7 ms | 30.3 ms | 52.0 ms |
| `engine.pick` median (first pick) | 8.3 ms (48) | 24.2 ms (61) | 43.6 ms (81) |
| `AssemblyBVH` create / rebuild / raycast | 14.8 / 4.1 / 0.075 ms | 36.2 / 19.8 / 0.31 ms | 52.0 / 38.7 / 0.59 ms |
| `ExplodedView` per frame: animating / at rest | 0.63 / 0 ms | 3.58 / 0 ms | 6.65 / 0 ms |
| Engine create / build scene / first frame | 84 / 41 / 61 ms | 83 / 117 / 91 ms | 83 / 251 / 138 ms |
| Load to first frame | 186 ms | 291 ms | 473 ms |
| JS heap | 15 MB | 61 MB | 79 MB |
| Kernel Wasm memory | 4.1 MB | 16.1 MB | 28.2 MB |
| Instance storage (CPU staging = GPU buffer) | 1.3 MB | 5.1 MB | 10.1 MB |
| Removing one mesh (`mesh.dispose()`) | 0.71 ms | 1.45 ms | 2.65 ms |

At 90k parts with 1x MSAA (`--low`) the frame is the same 40 FPS (24.3 ms CPU, 22.3 ms GPU): the largest assembly is
CPU-bound in the core, not GPU-bound. The GPU timestamp sums are unreliable when frames queue behind each other (an
earlier session reported 48 ms of passes at 47 FPS), so the serial-frame row is the upper bound for GPU work.

### Kernel: the earlier Node figure

The earlier Node run measured about 12.8 ms per tick at 100,000 entities with 10-deep hierarchies and culling. Confirmed
in order of magnitude: the browser measured 10.9-11.4 ms at 99,976 entities in this session (7.1-17 ms across sessions),
and Node now measures 9.3 ms for the 5-level assembly and 7.0 ms for 100,000 entities in 10-deep chains
(`node examples/package-benchmarks/cad/kernel-node.mjs`). Culling is about 0.1-0.3 ms of it. Claims such as "under
0.5 ms for 50k" are not supported: 50k parts take 5.4-6.8 ms.

## Core hot spots (not changed; core is frozen, numbers for the owner)

1. **Kernel tick recomputes every entity every frame** (109 ns each, 10.9 ms at 100k entities). `world_matrix` rebuilds
   the local matrix from TRS in f64 with full finiteness checks, recurses up the parent chain, then recomputes the
   bounding sphere, for static parts too. CAD assemblies are almost entirely static: a dirty flag (skip entities whose
   local transform and parent did not change) would make a still frame cost about the cull alone (0.1-0.3 ms).
2. **Batch collection in JS** (7.0 ms at 82k visible parts): per mesh a `Map.forEach` callback, a `Map.get` for the
   batch, two `TypedArray.set` copies (16-float matrix view + 8-float material) and the id write. Together with the
   kernel this is 20 ms of the 24.6 ms frame at 90k parts, so the largest assembly stays near 40 FPS however fast the
   GPU is.
3. **Instance upload of every visible part every frame**: 10.1 MB per frame at 90k parts, even when nothing moved.
4. **`engine.pick` re-renders the whole scene** into a 1x1 target and re-runs `update()` (kernel + collection), creating a
   shader module and pipeline on every pick: 43.6 ms at 90k parts. `AssemblyBVH` (below) answers a ray in 0.6 ms.
5. **`Engine.remove` scans every mesh** to unparent children: 2.65 ms per removal at 100k entities, so disposing a 90k-part
   assembly mesh by mesh is O(n²), about two minutes.
6. **100,000-entity cap** in `TransformStore.create`: a 100,000-part assembly does not fit once assembly nodes are counted.

## Changes in this branch (machinery only)

### Feature edges: `@margoengine/machinery/edges`

`FeatureEdges` draws CAD feature lines for every mesh: edges whose faces meet at more than `angle` degrees (default 30)
and open boundaries, from `@margoengine/geometry`'s `edgesGeometry`, computed once per distinct geometry and cached.
Lines are drawn instanced per geometry from the same per-geometry instance buffer the core already filled for the parts,
so transforms, frustum culling, hidden parts and `ExplodedView` apply without any per-part CPU work. Constant
screen-space width, antialiased coverage, hardware depth bias (`depthBias`, default 256 units of depth32float, which is
relative to depth like float precision) so lines never z-fight their own faces, works under `@margoengine/cameras`
orthographic projection (everything is in clip space), and is clipped by `SectionPlanes` (it detects the section uniform
in the frame's shader and binds the same buffer).

It lives in machinery, not lines: it needs the section clipping uniform (now shared through `section-uniform.ts`) and is
CAD-specific; `@margoengine/lines` draws one `Line` per draw call with its own model matrix uniform, which would be 50,000
draws and 50,000 uniform writes here.

Cost at overview scale. A compute pre-pass keeps only parts whose bounding sphere projects to at least `minRadius` CSS
pixels (default 6) and writes an indirect draw; segments shorter than half a pixel on screen are dropped:

| Edges | 10k | 50k | max (90k) |
| --- | --- | --- | --- |
| Segments of visible parts (before the size test) | 0.66 M | 3.26 M | 5.98 M |
| Edge pass GPU | 2.49 ms | 4.46 ms | 4.92 ms |
| Size-test compute pass GPU | 0.07 ms | 0.26 ms | 0.39 ms |
| CPU per frame (visible count per geometry) | 0.17 ms | 0.78 ms | 1.51 ms |
| Edge extraction, first frame (5 shapes) | 4.6 ms | 6.9 ms | 9.1 ms |
| Serial frame with / without edges | 14.0 / 11.7 ms | 37.4 / 34.8 ms | 59.3 / 50.0 ms |

Edge pass at 50k parts as the design changed: size test per vertex 27.3 ms, compute-compacted list 9.6 ms, plus
sub-pixel segment drop 4.5 ms. Real-GPU correctness: `node packages/machinery/test/edges-check.mjs` checks edge pixels
for perspective, orthographic, section-clipped (kept and removed sides), exploded, hidden and tiny parts, with no WebGPU
errors.

### Exploded view

`ExplodedView` updated positions on the CPU every frame: a liveness check (`Map.get`) and three writes per part, 0.5 /
2.9 / 5.9 ms per frame at 10k / 50k / 90k parts even when the amount did not change. It now writes only when `amount`
changes (same API; positions identical). At rest: 0 ms (Node proof: 2.61 ms -> 0.0015 ms at 50k parts). While the
amount animates the cost is unchanged (3.6 ms at 50k), because the per-part liveness check that guards against writing
into a reused entity slot dominates; a GPU offset buffer would remove it but would leave `node.position`, kernel culling,
shadows and BVH picking unaware of the explode, so it was not done.

### Assembly BVH (the package hot spot)

`AssemblyBVH` flattened every instanced triangle into world space and built one Wasm BVH over all of them: it refused
assemblies above 1,000,000 instanced triangles (about 7,800 parts of this workload, so none of the three cases above) and
rebuild (needed after any transform change, such as an explode) took 0.8 s at 7,560 parts. It now builds one local-space
BVH per distinct geometry, shared by every instance, and tests rays against per-part bounding spheres first; rebuild
recomputes spheres and affine inverses only. Same API.

| `AssemblyBVH`, Node proof | Before | After |
| --- | --- | --- |
| 7,560 parts, 973k instanced triangles: create | 1,154 ms | 10.8 ms |
| rebuild | 802 ms | 2.2 ms |
| raycast | 12.6 µs | 25.1 µs |
| largest distance error vs exact float64 | 3.6e-5 m | 2.3e-13 m |
| 89,883 parts, 11.6M instanced triangles: create / rebuild / raycast | refused | 80 / 35 / 0.56 ms |

Raycast is slower at this size (a linear sphere pass over parts instead of one world tree); at 90k parts it is 0.6 ms per
ray, fine for clicks. A top-level tree over the spheres is the upgrade if hover picking needs it.

## STEP / IGES loading (`loadCAD`)

OCCT (occt-import-js 0.0.23) Wasm: 7,604,031 bytes, 3,110,912 gzip; glue JS 96,871 (26,835 gzip); Margo CAD worker
14,246 (5,672 gzip). Sample files ship with the occt-import-js dev dependency (the repo has none of its own):

| File | Size | Result | Worker start | OCCT ready | Tessellated | Total |
| --- | --- | --- | --- | --- | --- | --- |
| `cax-if/as1-oc-214.stp` | 441,968 B | 18 parts, 5,040 triangles | 32-45 ms | 148-214 ms | 1,212-1,289 ms | 1,255-1,330 ms |
| `cube-10x10mm/Cube 10x10.igs` | 11,562 B | 1 part, 12 triangles | 25-33 ms | 144-170 ms | 293-390 ms | 294-392 ms |

(Three runs each; an earlier session measured 913-988 ms for the STEP file.) OCCT initialisation (load + compile +
instantiate) is about 110-170 ms after the worker starts; `ReadStepFile` plus normals dominate at about 1.0-1.1 s for a
442 kB file; smoothing and transfer about 35 ms. A lighter path: tessellate once (server or build step) and ship the
result as a binary mesh, keeping OCCT for user uploads only.

## Reproduce

From the repository root after `node scripts/build-modern.js --precompiled` and `npm run build --workspace packages --if-present`
(take `test-results/gpu.lock` first when other GPU work may run):

```sh
node examples/package-benchmarks/cad/run.mjs --sizes=10000,50000,max --label=after
node examples/package-benchmarks/cad/run.mjs --sizes=10000,50000,max --edges --no-bvh --no-explode --label=edges
node examples/package-benchmarks/cad/run.mjs --sizes=max --low --no-bvh --no-explode --label=max-1x-msaa
node examples/package-benchmarks/cad/run.mjs --sizes=1000 --step --no-bvh --no-explode --label=step
node examples/package-benchmarks/cad/run.mjs --sizes= --shot                 # test-results/cad-edges-*.png
# Before/after against another machinery build (Git Bash: MSYS_NO_PATHCONV=1):
node examples/package-benchmarks/cad/run.mjs --sizes=10000 --machinery=/test-results/machinery-7d5a5dd --label=before-10k
node examples/package-benchmarks/cad/kernel-node.mjs
node examples/package-benchmarks/proofs/machinery-cad.proof.js
node packages/machinery/test/edges-check.mjs
```
