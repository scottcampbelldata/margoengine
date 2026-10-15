# CAD performance (machinery at assembly scale)

**Headline numbers:** the [quiet-machine before/after table](#before--after-on-a-quiet-machine-2026-10-14-1908-1921-local)
(merged core fast paths, one Intel Arc 140V laptop iGPU): 50,004 parts orbit at 92 FPS (49 before), 89,883 parts at
33 FPS (GPU-bound, unchanged), and the kernel is 2.6-4x cheaper in every case. The first results table below is an
earlier (11:53) session from before those core changes, kept for the hot-spot analysis; do not quote it as current.

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

## Results before the merged core fast paths (11:53 session; superseded by the quiet-machine table below)

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

## Core hot spots (as measured before the fast paths below; 1, 2, 3 and 5 are now fixed in core, 4 and 6 are not)

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

## Core static-scene fast paths (merged 2026-10-14: steps 1, 2, 3 and 5; step 4 not merged)

Scott approved steps 1, 2, 3 and 5 of the prototype below; they are ported onto `perf/auto-quality`, one commit per step,
together with two small approved core fixes. Step 4 (pick pipeline reuse) is not merged, so `engine.pick` still
re-renders the scene; it got faster only because the `update()` it runs (kernel + collection) did.

| Commit | What | core + stage gzip |
| --- | --- | --- |
| step 1 | kernel recomputes only entities whose inputs (TRS, parent, bounds, hidden) changed, plus descendants; Wasm rebuilt with `wasm-opt -ocimfs 300` | 18,681 → 19,162 (+481) |
| step 2 | engine reuses last frame's instances; on an unchanged mesh set, material, visibility and cull result it patches only the moved matrices | 19,414 (+252) |
| step 3 | WebGPU renderer uploads only the changed instance range | 19,510 (+96) |
| step 5 | `Engine.remove` detaches children with a native scan of the parent column | 19,515 (+5) |
| CAD controls pole fix | leaving an exact pole (ViewCube top view) keeps the heading given by `camera.up` | 19,536 (+21) |
| `engine.pick` OffscreenCanvas fix | bounds and scaling use `clientWidth \|\| width` | 19,543 (+7) |

Contract change (core README): core's per-geometry GPU instance buffers are read-only for packages. The only writer outside
core was `@margoengine/selection`'s micro pick pass (grep of every package, example and script for `geometryBuffers`,
`.instance` and instance uploads); it now uploads into its own buffer. Readers that bind the buffer (machinery
`FeatureEdges`) are unaffected: the buffer holds the same data as before. Memory: +66 bytes per kernel entity slot.

Bit-exactness: `tests/core-dirty-transforms.test.js` (dirty propagation equals a full recompute, instance lists equal a
from-scratch collection every frame) and `node examples/package-benchmarks/cad/pixels-check.mjs` on the real GPU (static +
moving mix with hide/show, reparent, material edits and assignment, remove/add, scale and geometry swap, compared with a
from-scratch render: 0 differing pixels over 25 comparisons plus 4 unchanged redraws). `npm run verify` passed at the merge (1,051 tests then).

### Before / after on a quiet machine (2026-10-14, 19:08-19:21 local)

Same host and browser setup as above, measured after Scott stopped every other agent, build and benchmark (and closed
other apps), with this benchmark the only workload, on AC power (checked before and after every run, recorded in each
JSON as `acPowerAtStart`/`acPowerAtEnd`, plus a `conditions` note and the `core` commit), holding the GPU lock. Before =
core at `261f1d4`, after = this branch. Before and after alternate per case in two rounds (round 1 before then after,
round 2 after then before); each cell is the mean of the two rounds' medians. Raw JSON:
`examples/package-benchmarks/cad/results-{before,after}{1,2}-{orbit,still,move,orbitmove}.json`;
`node examples/package-benchmarks/cad/summary.mjs before1 before2 after1 after2` prints every run. Cases: `orbit` (camera
orbits, static parts, then `engine.pick` at the centre), `still` (fixed camera, static parts), `move` (fixed camera, 1%
of parts bob every frame), `orbitmove` (orbiting camera and 1% moving; not in the prototype table).

| Case | Parts | Kernel in frame (ms) | Collection (ms) | Frame CPU (ms) | FPS | GPU, timestamps (ms) | `engine.pick` (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orbit | 10,017 | 2.17 → 0.65 | 1.18 → 1.01 | 5.02 → 3.70 | 168 → 247 | 4.85 → 4.62 | 10.7 → 7.6 |
| orbit | 50,004 | 10.7 → 2.66 | 5.22 → 4.42 | 19.7 → 10.4 | 49 → 92 | 17.0 → 17.5 | 28.9 → 19.5 |
| orbit | 89,883 | 14.9 → 4.09 | 7.52 → 6.82 | 28.6 → 30.0 | 34 → 33 | 27.0 → 28.3 | 43.2 → 30.9 |
| still | 10,017 | 2.08 → 0.66 | 1.07 → 0.09 | 4.88 → 3.71 | 182 → 204 | 4.46 → 3.83 | - |
| still | 50,004 | 9.67 → 3.15 | 4.79 → 0.18 | 18.3 → 11.6 | 53 → 78 | 16.4 → 12.0 | - |
| still | 89,883 | 16.0 → 5.54 | 7.84 → 0.28 | 29.7 → 17.9 | 33 → 52 | 26.2 → 18.5 | - |
| move | 10,017 | 1.87 → 0.68 | 0.99 → 0.14 | 4.10 → 4.67 | 207 → 182 | 3.64 → 4.29 | - |
| move | 50,004 | 9.53 → 2.93 | 4.58 → 0.54 | 17.7 → 6.85 | 54 → 133 | 16.1 → 14.9 | - |
| move | 89,883 | 15.7 → 5.70 | 7.60 → 1.09 | 29.3 → 22.4 | 33 → 43 | 27.6 → 21.0 | - |
| orbitmove | 10,017 | 2.11 → 0.65 | 1.12 → 0.94 | 4.69 → 4.54 | 183 → 189 | 4.46 → 4.10 | - |
| orbitmove | 50,004 | 8.73 → 3.38 | 4.27 → 5.03 | 16.4 → 12.4 | 58 → 76 | 15.1 → 16.2 | - |
| orbitmove | 89,883 | 14.5 → 5.08 | 7.31 → 7.82 | 28.4 → 29.5 | 34 → 33 | 26.6 → 28.2 | - |

Reading: the kernel is 2.6-4x cheaper in every case; collection all but disappears while the camera and the cull result
are fixed (still, move). With an orbiting camera the cull result changes every frame, so collection runs in full as before
and 90k parts stay GPU-bound (~28 ms of GPU per frame): orbit at 90k is unchanged (34 → 33 FPS), 50k orbit nearly doubles.
`move` at 10k got slower in both rounds (207 → 182 FPS; GPU 3.6 → 4.3 ms, CPU without GPU wait 4.2 → 2.7 ms): at that size
the frame is GPU-bound and the GPU time rose; not explained. The quiet-machine "before" numbers are 10-35% better than the
11:53 session at the top of this page (34 vs 25 FPS at 90k orbit), which is why only same-session pairs are compared.

### Back-face culling in core (merged 2026-10-15, `d96e2d7`)

Scott approved the smaller per-batch variant instead of the per-cull-group branch below: core builds a second main
pipeline (`cullMode: 'back'`, the shader's `discard` compiled out by an override) and uses it for a geometry batch
when every drawn instance is single-sided and unmirrored; any other batch, package shader variants and draws with extra
bindings keep the cull-none pipeline. Core + stage 19,577 -> 19,793 B gzip. Same pixels (`cad/cull-pixels.mjs`
against `dc0c4ff`: 0 differing pixels over 13 steps). **The CAD numbers on this page do not move**: they use core's
default double-sided material, which draws the same pipeline as before. Single-sided CAD (diagnostic, busy machine,
`results/vs-threejs-cad-pairs.json`): 10k parts 4.04 -> 2.15 ms GPU per frame, 50k 11.4 -> 12.0 ms (no gain;
geometry-bound). Instanced pairs against three.js: `docs/whitepaper/boxes-vs-threejs.md`.
### Back-face culling by pipeline `cullMode` (measured only, not merged; branch `scratch/core-backface-cull`)

Core's shader rejects back faces with `if(!facing&&i.material.z<0.5){discard;}` under `cullMode:'none'`; a `discard`
anywhere in the shader stops the GPU from writing depth early, for double-sided materials (the default) too. The scratch
branch draws each batch once per cull group present (single-sided: `cullMode:'back'`; single-sided mirrored: `'front'`;
double-sided: `'none'`), with a shader override `G` that drops other groups' instances in the vertex stage and compiles
the discard out; pipelines that packages build from the same shader text keep `G=3` (no filter, discard kept). Cost:
core + stage 19,543 → 19,858 B gzip (+315), over the 19,600 target. Caveats: a batch mixing groups is drawn up to three
times (vertex work, draw order between groups changes), and pipeline creation per group is synchronous.

Benchmark `examples/package-benchmarks/cad/cull-bench.mjs` (on that branch; quiet machine, AC, GPU lock, 1432x768, 4x
MSAA; 4 runs per case over two alternating rounds, median shown; raw `results-cull-{discard,cullmode}-{1,2}.json`):

| Scene | Sides | GPU, discard (ms) | GPU, cullMode (ms) | Serial frame, discard → cullMode (ms) |
| --- | --- | --- | --- | --- |
| CAD 50k parts (46k visible) | double (default) | 15.6 | 13.7 | 21.7 → 19.6 |
| CAD 50k parts | single | 14.2 | 12.4 | 20.9 → 18.8 |
| 1 full-screen layer | double | 1.31 | 0.79 | 4.0 → 4.0 |
| 1 full-screen layer | single | 0.79 | 0.39 | 3.9 → 3.9 |
| 16 full-screen layers, front to back | double | 1.57 | 0.79 | 4.3 → 3.9 |
| 16 full-screen layers, front to back | single | 0.79 | 0.33 | 4.0 → 3.8 |
| 16 full-screen layers, back to front | single | 11.9 | 4.7 | 15.8 → 9.0 |

So: about 2 ms (12%) of GPU per frame on the 50k CAD scene and up to 2.5x on heavy overdraw drawn back to front; the
CAD runs are noisier (single runs between 8.7 and 15.7 ms).

## Prototype: static-scene fast paths in core (branch `worktree-agent-a46261c57b837ecd0`; steps 1, 2, 3, 5 merged above)

Hot spots 1-5 above, one commit per step so each can be accepted alone. Same API, identical pixels
(`node examples/package-benchmarks/cad/pixels-check.mjs`: a static + moving mix with hide/show, reparent, material
edits/assignment, remove/add, scale, geometry swap and picks, compared with a from-scratch render every step: 0 differing
pixels; `engine.pick` agrees with selection's independent micro pass). Measured 2026-10-14 on AC under the GPU lock, same
host as above; `node examples/package-benchmarks/cad/summary.mjs s0 s1 s2 s3 s4 s5` prints every case. Cases: `orbit`
(camera orbits, static parts; includes `engine.pick`), `still` (fixed camera, static parts), `move` (fixed camera, 1% of
parts move every frame). Frame CPU at 90k parts includes waiting on the GPU (26-31 ms GPU per frame), so kernel and
collection are the CPU numbers to compare there.

| Step | core + stage gzip | Kernel in frame 10k / 50k / 90k | Collection (still · move · orbit), 90k |
| --- | --- | --- | --- |
| 0 baseline | 18,681 | 2.2 / 11.6 / 19.5 ms | 10.6 · 11.2 · 10.6 ms |
| 1 kernel skips unchanged entities | 19,162 (+481) | 0.7 / 3.5 / 6.0 ms | unchanged |
| 2 reuse instances, patch moved matrices | 19,414 (+252) | - | 0.32 · 1.30 · 10.3 ms |
| 3 upload changed ranges only | 19,510 (+96) | - | still 90k: 40 FPS (was 30) |
| 4 pick: reused pipeline, pixel-frustum culling | 19,916 (+406) | - | pick 57.6 → 9.6-13.9 ms at 90k |
| 5 removal: native parent scan | 19,921 (+5) | - | dispose 90k engine 48 s → 20 ms |

Not solved: during an orbit the cull result changes every frame, so step 2 re-collects (10 ms at 90k parts); keeping
draw order (coplanar CAD faces resolve by order) rules out cheap incremental insertion. GPU culling with indirect draws
(1f a) is the route. Memory: +66 bytes per entity slot in the kernel (input snapshot + 2 flags), +5 in JS.

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

Measured in the 11:53 session, before the merged core fast paths and before `803aa19` changed the edges pass's section

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

Before and after were measured locally for that change (not committed); "Now" is the committed record
[entry-sizes.json](../examples/package-benchmarks/results/entry-sizes.json) at `e2cc4c5` (other packages external).

| Entry | Before | After | Now |
| --- | --- | --- | --- |
| `@margoengine/machinery/edges` (new; app bundle with core external) | - | 4,299 B, plus 551 B for `edgesGeometry` from `@margoengine/geometry` | 3,940 B (geometry external) |
| `@margoengine/machinery/spatial` (with its Wasm kernel chunk) | 14,118 B | 14,937 B | 14,411 B |
| `@margoengine/machinery/exploded` | 508 B | 538 B | 588 B |
| `@margoengine/machinery` root | 33,121 B | 33,849 B | 33,418 B |
| core + stage (`npm run measure:size`, untouched) | 18,681 B | 18,681 B | 19,577 B (core fast paths and material setters since) |

## GPU culling: `@margoengine/culling` (HANDOFF 1f.a)

Measured 2026-10-14 in one session (Arc 140V, headless Edge, 1432x768, 4x MSAA, AC power checked before and after every
run, GPU lock held; 0 runs discarded). Raw JSON: `examples/package-benchmarks/cad/results-culling.json`, script
`culling.mjs` / `culling.js` in the same folder. Compare these numbers with each other only (the core baseline here is
faster than the session above; another worker's GPU timing shared the machine between runs).

`CulledInstances` draws the same assembly (same shapes, materials and per-shape order) without core meshes: instances
are uploaded once, and a compute pass culls, compacts in order and writes indirect draws. Core's kernel tick, batch
collection and 10 MB instance upload do not run for these parts, which is where most of the win comes from. The price:
culled parts are not core meshes, so they get no `engine.pick`, hierarchy, `ExplodedView`/`AssemblyBVH`/`FeatureEdges`,
section caps or shadows (package README, Limits). The `core meshes` column predates the merged core fast paths.

| 89,883 parts (FPS / GPU ms) | core meshes | culling `none` | `frustum` | `occlusion` |
| --- | --- | --- | --- | --- |
| CPU per frame (`engine.render` with the GPU idle) | 23.4 ms | 0.48 ms | 0.41 ms | 0.55 ms |
| Orbit | 36.4 / 24.7 | 45.5 / 16.4 | 51.8 / 18.3 | 46.6 / 16.3 |
| Still | 31.9 / 26.6 | 47.9 / 17.4 | 52.9 / 15.7 | 47.2 / 18.9 |
| Grazing view inside the sheet (0.3 m above the plates) | 48.3 / 15.1 | 48.4 / 18.9 | 97.7 / 8.0 | 83.3 / 9.4 |
| 50,004 parts, orbit | 62.6 / 15.8 | 71.9 / 12.0 | 89.9 / 8.5 | 75.0 / 10.1 |
| 50,004 parts, still | 63.0 / 14.9 | 74.5 / 9.9 | 86.4 / 9.2 | 75.2 / 10.9 |
| 50,004 parts, CPU per frame | 14.2 ms | 0.44 ms | 0.46 ms | 0.48 ms |
| 10,017 parts, orbit / still | 215 / 197 | 192 / 203 | 230 / 235 | 177 / 194 |

GPU ms are pass timestamps sampled every 15th frame (about ±15% between runs). FPS is throughput (vsync off). The package's
CPU cost is flat in part count: a few passes and two indirect draws per batch.

Occlusion does not pay on this layout. Seen from above, the parts it could hide (nuts and washers 3-13 mm under a 12 mm
plate) are never strictly behind the plate across their bounding-sphere footprint, so the overview culls nothing more
than the frustum test (78,940 parts drawn either way at 90k still), while the occluder prepass (0.5 ms) and Hi-Z build
(+0.5-2 ms) still run. A dense layout shows the other side: the same modules stacked in 15 layers 0.13 m apart
(`--layouts=stack`, no core baseline):

| Stacked block, 89,883 parts | `none` | `frustum` | `occlusion` |
| --- | --- | --- | --- |
| Orbit: FPS (parts drawn) | 27.2 (89,883) | 28.2 (80,803) | 37.3 (20,643) |
| Still | 25.9 (89,883) | 26.6 (84,238) | 32.6 (22,370) |
| Grazing view inside the block | 29.1 (89,883) | 48.7 (38,247) | 52.3 (6,372) |

Hence `frustum` is the default and `occlusion` is opt-in for dense or enclosed assemblies. Per-pass GPU at 90k stacked
orbit, occlusion: occluder prepass 3.7 ms, Hi-Z + cull 0.9 ms, main 17.4 ms (frustum main: 30.7 ms).

Pixel check (`culling.mjs --check`): two engines render 28,672 parts (1,024 modules plus a coplanar twin of every plate in
another colour, drawn in a later batch) along a 160-frame path, one culled and one drawing every part, compared byte for
byte. Sheet: orbit, descent to a grazing flight, view from below. Stack: descending orbit, then a flight between the
two middle layers (the last 23 frames leave the block and see nothing). 0 differing pixels in all 640 frames (occlusion
and frustum, both layouts), no WebGPU errors; occlusion drew down to 4,770 parts where frustum drew 16,338. The twin
plates show everywhere, so coplanar ties still resolve to the later batch.

Package size: 7,060 B min+gzip at `e2cc4c5` (core external; entry-sizes.json), most of it WGSL. Zero cost when not (separate package, `sideEffects: false`, no core change).

## STEP / IGES loading (`loadCAD`)

OCCT (occt-import-js 0.0.23) Wasm: 7,604,031 bytes, 3,110,912 gzip; glue JS 96,871 (26,835 gzip); Margo CAD worker
14,246 (5,672 gzip). Sample files ship with the occt-import-js dev dependency (the repo has none of its own):

| File | Size | Result | Worker start | OCCT ready | Tessellated | Total |
| --- | --- | --- | --- | --- | --- | --- |
| `cax-if/as1-oc-214.stp` | 441,968 B | 18 parts, 5,040 triangles | 39-48 ms | 184-246 ms | 1,376-1,680 ms | 1,403-1,715 ms |
| `cube-10x10mm/Cube 10x10.igs` | 11,562 B | 1 part, 12 triangles | 31-34 ms | 155-181 ms | 358-452 ms | 361-456 ms |

(Three runs each.) OCCT initialisation (load + compile + instantiate) is about 120-200 ms after the worker starts;
`ReadStepFile` plus normals dominate at about 1.2-1.5 s for a 442 kB file; smoothing and transfer about 30 ms. The
lighter path: tessellate once at build time with `npx margo-convert part.step part.glb`
([tools/margo-convert](../tools/margo-convert/README.md), sizes and times there) and keep OCCT for user uploads only.

## Reproduce

From the repository root after `npm run build:packages`,
on AC power (the scripts refuse to time on battery unless `BENCH_ALLOW_BATTERY=1`), holding `test-results/gpu.lock`:

```sh
node examples/package-benchmarks/cad/run.mjs --sizes=10000,50000,max --label=after
node examples/package-benchmarks/cad/run.mjs --sizes=10000,50000,max --edges --no-bvh --no-explode --label=edges
node examples/package-benchmarks/cad/run.mjs --sizes=max --low --no-bvh --no-explode --label=max-1x-msaa
node examples/package-benchmarks/cad/run.mjs --sizes=1000 --step --shot --no-bvh --no-explode --label=step
# Before/after against another machinery build (Git Bash: MSYS_NO_PATHCONV=1):
node examples/package-benchmarks/cad/run.mjs --sizes=10000 --machinery=/test-results/machinery-7d5a5dd --label=before-10k
node examples/package-benchmarks/cad/culling.mjs --check --views=orbit,still,grazing --layouts=sheet,stack --label=culling
node examples/package-benchmarks/cad/kernel-node.mjs
node examples/package-benchmarks/proofs/machinery-cad.proof.js
node packages/machinery/test/edges-check.mjs
```

The `before-*` files used a copy of `packages/machinery/dist` built from `7d5a5dd` sources (`exploded.ts`, `spatial.ts`).
