# Margo against other libraries

Three.js has no equivalent for these packages, so the rows live here instead of `perf-vs-threejs.md` (that file is
rewritten by `bench/parity-report.mjs`). Each rival is installed outside this repository and run as a black box.
Margo's harness is in the package's `scripts/rival-bench.mjs`. Both sides run in one process, taking turns, and the
time is the fastest round. These numbers were taken on a busy machine and are diagnostic, not a release claim.

| Package | Work | Margo | Rival | Result |
| --- | --- | --- | --- | --- |
| `@margoengine/behavior` | 1,000 agents, one flock step (separation, alignment, cohesion, radius 2) | 3.098 ms | Yuka 0.7.8, 9.472 ms | win |
| `@margoengine/navmesh` | gapped floor, build | 3.190 ms | recast-navigation 0.44.0, 1.130 ms | loss |
| `@margoengine/navmesh` | gapped floor, one path query | 0.064 ms | recast-navigation 0.44.0, 0.082 ms | win |
| `@margoengine/navmesh` | gapped floor, path length | 24.212 | recast-navigation 0.44.0, 23.778 | loss |
| `@margoengine/navmesh` | open floor, path length | 22.627416997969522 | recast-navigation 0.44.0, same value, the Euclidean length | equal |
| `@margoengine/ecs` | 100,000 entities, one `position += velocity` query | 1.249 ms | bitECS 0.4.0, 11.054 ms | win |
| `@margoengine/fsm` | 10,000 transitions of a two-state toggle | 1.443 ms | XState 5.33.4, 27.935 ms | win |
| `@margoengine/tween` | 10,000 linear tweens, one 16 ms step | 0.371 ms | tween.js 25.0.0, 1.018 ms | win |
| `@margoengine/netcode` | 180 frames, two peers, rollback against a forward-only run | 0.0176 ms/frame (rollback), 0.0086 ms/frame (forward) | no JavaScript rollback rival | published |
| `@margoengine/save` | 200 seeded migration round trips | 0.086 ms each, 87,234 bytes, 0 failures | no rival package | published |
| `@margoengine/compute` | matmul 256 x 256, f32, then read the product | 0.900 ms | TensorFlow.js 4.22.0 WebGPU, 3.100 ms | win |
| `@margoengine/compute` | FFT of 65,536 real points, then read both halves | 2.400 ms | TensorFlow.js 4.22.0 WebGPU, 22.700 ms | win |
| `@margoengine/compute` | sum of 1,048,576 values, then read the scalar | 0.900 ms | TensorFlow.js 4.22.0 WebGPU, 3.000 ms | win |
| `@margoengine/sciviz` | volume-64, 256 x 256, frame plus the pixel read | 1.500 ms | VTK.js 38.0.5, 1.300 ms | loss |
| `@margoengine/splats` | truck 7k prefix, 699,050 degree-3 splats, one still frame | 10.765 ms | GaussianSplats3D 0.4.7, 4.500 ms | loss |
| `@margoengine/splats` | truck 7k, full 1,692,538-splat cloud against the published photo `000001` (camera-to-world, entry 115) | PSNR 20.882 dB, MAE 13.037 | GaussianSplats3D 0.4.7 at the old world-to-camera pose, PSNR 9.994 dB (rerun at the right pose owed, speed phase) | picture |
| `@margoengine/tiles` | quadtree, 5,461 tiles, screen-space error 16, selected set | 1,120 tiles, checksum 121586381 | 3DTilesRendererJS 0.4.21, same 1,120 tiles, same checksum | equal |
| `@margoengine/tiles` | same view, one settled `update` | 0.300 ms | 3DTilesRendererJS 0.4.21, 2.300 ms | win |
| `@margoengine/points` | 10,000,000 points, one settled frame | 9.000 ms | potree-core 2.0.17, 5.400 ms | loss |
| `@margoengine/lightmap` | Cornell box, irradiance per texel, 881 texels, one indirect bounce both sides | MAE 0.024863, relative 0.087125 | Cycles, Blender 5.3.0 Beta, 128 samples | picture error (ray noise; 8 seeds: 0.012063) |
| `@margoengine/oit` | five panes, 1280 x 720, frame plus completion | 2.000 ms | Babylon.js 8.33.0 dual depth peeling, 7.100 ms | win, busy machine |
| `@margoengine/oit` | same picture against exact ray-composited reference | MAE 1.567519, PSNR 35.388 dB | Babylon MAE 0.048151, PSNR 61.305 dB | loss |
| `@margoengine/sky` | default Preetham angular radiance, 297 samples, zenith-Y normalized | MAE 1.439228, max 70.681783 | Mitsuba 3.9.1 sunsky (Hosek-Wilkie), scalar_rgb | accepted difference (different model; Margo tuning share MAE 0.012108) |
| `@margoengine/staging` | default ContactShadows, sphere on ground, ray-traced hemispherical occlusion | MAE 0.048174, RMSE 0.074416 | 4096 cosine rays/pixel; projected-solid-angle oracle | loss |

The flock checksums after that step were 31517.19 (Margo) and 31516.70 (Yuka). Both moved from the same grid. They are
not bit-equal: Yuka keeps a neighbourhood per vehicle and Margo uses one uniform grid. The behaviours are the ones in
Reynolds 1987, weights 1.5, 1 and 1, max speed 3, max force 6. Rerun: `node packages/behavior/scripts/rival-bench.mjs`
after `npm run build --workspace @margoengine/behavior`. The Yuka install is `batch-167` under engine-bench
(`MARGO_ENGINE_BENCH` overrides the folder).

The navmesh rows use one gapped floor (four quads, cell size 0.25) and one open floor. Build time and the path query are
separate paired runs. Margo's gapped path takes the north hall (4 points, length 24.212). Detour takes the south hall
(5 points, length 23.778). The straight line through the gap corners is about 23.26. Both open-floor paths equal
`hypot(16, 16)`. The build loss and the length loss stay open in `docs/known-bugs.md`. The open floor and the rule that
the gapped path stays out of the hole are `packages/navmesh/test/path-length.test.js` (that test does not freeze
Detour's length). Rerun: `node packages/navmesh/scripts/rival-bench.mjs`.

The ecs row is one query over 100,000 entities, `position += velocity`, setup outside the timer. Both sides finished at
`n = 100000` and `sum = 5000050000`. Rerun: `node packages/ecs/scripts/rival-bench.mjs`.

The fsm row is 10,000 `NEXT` events on a two-state toggle. Construction is outside the timer. Both machines end in
state `a`. Rerun: `node packages/fsm/scripts/rival-bench.mjs`.

The tween row is 10,000 linear tweens from 0 to 100 over 1 second, one step of 16 ms. Both checksums are
16000.000000002541, which is 10,000 times 1.6. Halfway through a linear tween is halfway to the target
(`packages/tween/test/linear-oracle.test.js`). Rerun: `node packages/tween/scripts/rival-bench.mjs`.

The netcode row has no JavaScript rival. GGPO is C++ and Colyseus is not rollback. Two peers play the README fighter for
180 frames. A forward-only run (no latency, steady input) takes 0.0086 ms/frame. A rollback run (40 ms latency, input
that changes every frame) takes 0.0176 ms/frame. The last counted round resimulated 346 frames across both peers
(166 rollbacks each). The extra time per resimulated frame, using each round's own count, is 2.403 microseconds at
the minimum. The rollback run is slower because it simulates those extra frames, not because a rolled frame costs
many times a forward step. Busy machine, diagnostic. Rerun: `node packages/netcode/scripts/rival-bench.mjs`.

The save row has no rival package. Two hundred documents from seed 167 (version 1, entities, parents, components and
`$ref`) are migrated to version 2, validated, encoded, decoded, parsed and migrated again. The two results match and
validation is empty. One run on a busy machine: 87,234 bytes, 0.086 ms each. The same generator is locked by
`packages/save/tests/migration-fuzz.test.js`. Rerun: `node packages/save/scripts/fuzz-roundtrip.mjs`.

The compute rows are the published cases matmul-256, fft-65536 and reduce-1048576. The clock is the operation plus the
read of its result. Inputs are uploaded first. Two warmup calls each, then 7 paired rounds, and the time is the
fastest round. Node 26.12 has no WebGPU, so both libraries share one headless page on an RTX A6000 (WebGPU adapter:
nvidia, ampere). Matmul matches on both sides: sum 519, sum of squares 8591379379, first element -511, last 509.
The sum is 393216 on both sides. Margo's FFT checksums are sum of real parts -131071.9960873127, imag sum 0, energy
8590063186.016674, against NumPy's -131072, 0 and 8590065664. Every CPU bin was within 0.00845 of NumPy, and the GPU
run met the same 0.01 window. TensorFlow.js keeps the same transform: DC bin exact, energy 0.028% high, peak bin off
by 16.7 and 153 (magnitude 0.06% low). The FFT rounds do not overlap (Margo 2.4 to 7.0 ms, TensorFlow.js 22.7 to
27.1). On matmul and the sum, one slow Margo round sits inside the TensorFlow.js spread; the minima still favour
Margo. Busy machine, diagnostic. Rerun:
`node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/compute/scripts/rival-bench.mjs`.
The oracle is `packages/compute/tests/numpy-oracle.test.js`.

The sciviz row is volume-64, a radial sphere whose samples sum to 32731.121874443877
(`packages/sciviz/tests/volume-field.test.js`). Axes are off. Both use the figure camera at [2.6, 1.7, 2.9] looking at
the origin, view up +Y, a 60 degree field of view, background #0f141c, shading on, and about 1.5 samples per voxel.
The clock is one frame plus reading the 256 x 256 image. Two warmups, then 7 paired rounds, and the time is the
fastest round. One headless page on an RTX A6000. The last pair differs by 1.801 per channel on average (0 to 255);
7.48% of pixels differ by more than 8. VTK.js reports bounds half a spacing outside the point box. The rounds overlap
(Margo 1.5 to 2.0 ms, VTK.js 1.3 to 2.2). The minimum still favours VTK.js, so the row is a loss. Busy machine,
diagnostic. Rerun:
`node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/sciviz/scripts/rival-bench.mjs`.

The splat rows are the published truck at iteration 7,000 (1,692,538 degree-3 splats) cut to the first 699,050,
the most whose SH buffer fits the WebGPU minimum storage binding of 134,217,728 bytes. The full cloud is refused
(`RangeError: Splat attributes exceed device storage limits`). Both sides load that prefix. The photograph is the
dataset's `000001` JPEG, 979 x 546, and the render is that size. `cameras.json` names 1957 x 1091; the vertical
field of view uses that height and `fy` (50.513 degrees), and the principal point is taken as the image centre.
COLMAP's frame (x right, y down, z forward) was tried as world-to-camera and as camera-to-world. World-to-camera
was closer (PSNR 12.226 dB, MAE 52.272) than camera-to-world (10.672 dB, MAE 59.713) only because of a projection
bug (KB2604f, fixed 2026-11-11, entry 115): after the fix camera-to-world is the match, 20.882 dB on the full cloud. The rival is shown that same
world-to-camera pose (PSNR 9.994 dB, MAE 60.646). Neither is a match to the photograph. The clock is one update
and one render plus GPU completion, not the pixel read. Two warmups, then 7 paired rounds, still camera,
per-round minimum. The rounds do not overlap (Margo 10.765 to 14.535 ms, GaussianSplats3D 4.500 to 7.470). The
rival's shared-memory GPU sort produced no draw calls, so the timed path is its CPU sort (`gpuAcceleratedSort`
false, `sharedMemoryForWorkers` false, `integerBasedSort` false), antialiasing off, SH degree 3, black background.
RTX A6000, busy machine, diagnostic. The loss and the picture error stay open. Rerun:
`node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/splats/scripts/rival-bench.mjs`.
The fit count is `packages/splats/test/storage-fit.test.js`. The pose maths are `packages/splats/test/paper-camera.test.js`.

The tiles rows are one explicit REPLACE quadtree, 7 levels, 5,461 tiles, 256 m on a side, y-up, no geodetic
transform. `geometricError` is half the cell at every level except the leaves, which are 0. Every tile has a
content URI and every URI serves the same small GLB; selection uses the JSON bounding volume. The camera sits at
`[0, 80, 400]`, looks at the origin, up is +Y, the vertical field of view is 50 degrees, and the drawing buffer
is 1080 x 1080. Both error budgets are 16 pixels (the rival's README default is 6; it is set to 16 here). The
frustum passed to Margo matches the rival camera on five sample points. After every wanted tile has loaded, both
select the same 1,120 tiles: 992 at level 5 and 128 at level 6, checksum 121586381. The clock is one settled
`update`, not the load. Two warmups, then 7 paired rounds, per-round minimum. The rounds do not overlap (Margo
0.300 to 0.900 ms, 3DTilesRendererJS 2.300 to 3.100). Busy machine, diagnostic. The selected set is locked by
`packages/tiles/tests/sse-scene.test.js`. Rerun:
`node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/tiles/scripts/rival-bench.mjs`.

The points row is one Potree 2.0 folder, a single leaf of 10,000,000 points on a 200 x 200 x 250 grid in a 100 m
cube centred on the origin. Both budgets are 10,000,000, so a settled frame draws every point. Point size is 4
pixels and does not shrink with distance. The camera is at `[0, 0, 180]`, looks at the origin, up is +Y, the
vertical field of view is 50 degrees, and the drawing buffer is 1080 x 1080. The clock is one render plus GPU
completion: `onSubmittedWorkDone` on Margo, and a one-pixel `readPixels` on the rival (`fenceSync` returned
`WAIT_FAILED` in this browser). Two warmups, then 7 paired rounds, per-round minimum. The rounds do not overlap
(Margo 9.000 to 12.400 ms, potree-core 5.400 to 7.600). The rival submitted 7 draws of 10,000,000 points. Busy
machine, diagnostic. The loss stays open. The grid and the file layout round-trip in
`packages/points/tests/points-10m.test.js`. Rerun:
`node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/points/scripts/rival-bench.mjs`.

The lightmap row is the published Cornell box, scaled by 0.01, with every face snapped to a parallelogram
(`p2 = p1 + p3 - p0`). The short block top moves from (240, 165, 272) to (242, 165, 274). The floor, the back wall,
the left wall and the tall block top are snapped too. The published floor and ceiling holes are omitted, and the
rectangle light sits one published unit below the ceiling. Radiometry is physical irradiance. Reflectance is the
published table averaged in three bands against the published emission, not a CIE match. Margo takes one path
bounce (`bounces` 1, `bounceMode` 'path', 32 paths) and 16 samples on the area light. Cycles bakes diffuse direct
plus indirect with the surface color left out, 128 samples, and `diffuse_bounces` 1: Cycles counts indirect bounces
as Margo does. Until 2026-11-11 the bake used 2, from a time faces were baked alone and the ceiling came out black at
1; with every face present it is lit at 1, and the two-bounce reference made Margo look 0.069543 off (KB2604h). A direct-only
calibration (unit square light, height 2, 0.25 m receiver) fixes the scale using independent
128 by 128 midpoint quadrature: multiply the Cycles pixels by 9.873209. All 15 faces remain present as
occluders and bounce surfaces during every bake; the lifecycle regression detects an isolated-face bake and a
bounce count that differs from Margo's. Mean irradiance is 0.288177 (Margo) and 0.285376 (Cycles). Mean absolute
error is 0.024863, which is 0.087125 of the Cycles mean. The largest texel miss is 0.284111. The 8-bit step is
0.016813. The rest is Margo's ray noise: averaging 8 seeds gives 0.012063. The snaps and the direct integral are `packages/lightmap/tests/cornell-box.test.js`.
Rerun: `node packages/lightmap/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/lightmap`.


Five unlit binary-colour panes isolate the transparency algorithms. Source channels 0 and 1 are unchanged
by per-material sRGB encoding; both canvas readbacks are then given one common sRGB encoding. The reference
casts a primary ray per pixel, intersects every pane, sorts all hits and evaluates the exact emission/coverage
transport with the Porter-Duff over operator. No refraction, dielectric reflection or stochastic path noise.
Single-layer and background MAE are zero on both engines. Overlaps retain the weighted-blending error;
full-image MAE includes the 738,416 background pixels. All per-layer counts/errors are in
[the raw result](results/batch-168-oit.json). Babylon's default pass count is 5; compatibility mode stays default.
Seven alternating rounds: Margo 2.000 to 5.000 ms, Babylon 7.100 to 9.300 ms, per-round minimum.
Completion is queue.onSubmittedWorkDone on Margo, one-pixel readPixels on Babylon, including that transfer.
Busy machine, diagnostic, not isolated GPU pass costs. Weighted OIT approximates depth-ordered transport,
while depth peeling resolves these five layers; the quality loss stays open. Nonbinary colours introduce an
additional display-domain blending limitation, which this binary-palette algorithm comparison does not cover.
Rerun: `node scripts/gpu-lock.mjs run --exclusive --owner=codex-168 -- node packages/oit/scripts/rival-bench.mjs`.


The sky comparison evaluates the shipped Preetham WGSL directly on the GPU, before display mapping.
Mitsuba 3.9.1 sunsky runs externally as scalar_rgb, ground albedo 0 and sun_scale 0. The sun is at
10, 45 or 75 degrees elevation, turbidity 2, 3 or 6. Each of nine cases samples 33 directions:
5, 15, 30 and 60 degrees at eight azimuths, plus zenith once (297 RGB samples total).
Mitsuba's Z-up axes are mapped explicitly from Margo's Y-up axes. Every case divides each sky by its
own zenith luminance: Margo's artistic luminance scale does not provide Mitsuba-compatible physical units.
Thus this is an angular-radiance and colour comparison, not an absolute power calibration, hemisphere
integral, display picture or measured atmosphere. Mean normalized RGB error 1.439228; relative MAE
ranges from 0.199319 to 0.765628 by case. Largest channel error 70.681783 (sun 10 degrees, turbidity 6).
Preetham and Hosek-Wilkie are different models. The paper Preetham model without Margo's tuning measures MAE
1.436382 on the same grid; Margo's daylight-locus floor moves it by MAE 0.012108 and its clamps do not act here, so
the difference is the model (accepted difference KB3148c, docs/limits.md). No coefficients were copied or invented.
[Per-case values](results/batch-168-sky.json). Rerun under the shared GPU lock:
`node packages/sky/scripts/rival-bench.mjs`. No speed comparison is claimed.


The staging reference is a black sphere of radius 0.5 touching white diffuse ground under uniform
upper-hemisphere illumination. Actual default ContactShadows settings: 4 m plane, height 1 m, blur 0.06 m,
opacity 0.6, resolution 256. A 128 x 128 top view compares 15,472 exposed-ground pixels, excluding the visible
sphere and a one-pixel silhouette guard. The clean-room reference traces 4096 cosine-weighted rays per
pixel; its largest difference from the independent analytic projected solid angle is 0.001734.
Compare normalized shadow-catcher darkness over display white; no exposure or opacity is fitted.
MAE 0.048174, RMSE 0.074416, max 0.288788. Mean darkness is 0.000177 (contact) versus 0.048351 (reference).
The nearness map's fixed blur and height falloff produce a local contact cue rather than broad hemispherical
occlusion. Accepted difference (KB3193, 2026-11-11): the default is a footprint cue by design (one pass,
cacheable), and a sphere's footprint lies under the sphere. AmbientShadows with `ambient: 1` (all-sky visibility, 1024 cosine directions, opacity 1) on the same scene, pixels and reference measures MAE 0.001561, RMSE 0.001948, max 0.007994, mean darkness 0.048200 against 0.048351, on WebGPU and the WebGL2 compatibility layer
(`packages/staging/test/sky-occlusion-browser.mjs`). No directional area-light or speed equivalence is claimed.
[Raw result](results/batch-168-staging.json). Rerun under the shared GPU lock:
`node packages/staging/scripts/rival-bench.mjs`, and `--ambient` for AmbientShadows.


The closing batch 168 check also path-traces the OIT panes independently in Cycles (Blender 5.3.0 Beta,
CPU, 1024 samples, seed 168). Transparent BSDF/emission mixtures implement the same linear coverage
transport, black world, identical camera and geometry. After a common sRGB encoding, Margo MAE is
1.632960 (PSNR 33.630 dB) and Babylon 0.132651 (38.261 dB). The exact primary-ray oracle versus Cycles
has MAE 0.094812; their centre RGB is identical (198,163,103). Residual path noise and silhouette sampling
differences give max 125 on all three comparisons, so the full-frame PSNR includes reference noise and
edge differences. The independent trace confirms the weighted image loss, not an accuracy-parity claim.
No second timing row is published. [Path-traced result](results/batch-168-oit-cycles.json).
Reproduce: `node scripts/gpu-lock.mjs run --exclusive --max=6 --wait-max=1 --owner=codex-168 -- node scripts/rival-oit-cycles.mjs`.

## Batch 169 procedural: work counts, 2026-11-10

| Work | Before | After | Output | Oracle | Status |
| --- | --- | --- | --- | --- | --- |
| 1024 Worley F1 samples | 1,536,000 hash multiplies | 183,696 | 1029 samples x 3 seeds, identical Float64 bytes | 100,000 points equal an exhaustive 125-cell F1; Poisson minimum spacing at or above the radius | `perf(procedural): hash only Worley cells that can win`; timing pending the quiet rerun |

Values and commands: [batch-169.md](batch-169.md#job-7-procedural-worley-cells).

## Batch 169 wfc: work counts, 2026-11-10

| Work | Before | After | Output | Oracle | Status |
| --- | --- | --- | --- | --- | --- |
| 16 x 16, 8 weighted tiles, TypeScript heap | 6656 bit scans | 4608 | 5 tile sets x 3 seeds x pins: identical solutions and stats | 0 adjacency violations over 120 solves on three solvers | `perf(wfc): gather the full-domain union once`; timing pending the quiet rerun |
| Same grid, legacy WFC | 4608 bit scans | 512 | identical solutions | same | timing pending the quiet rerun |

Values and commands: [batch-169.md](batch-169.md#job-6-wfc-full-domain-propagation).

## Batch 169 terrain: work counts, 2026-11-10

| Work | Before | After | Output | Oracle | Status |
| --- | --- | --- | --- | --- | --- |
| Eight frames, 3 rings, 2 cascades, 1 local layer | 96 uniform writes (12 per frame) | 45 (0 on unchanged frames) | 12 buffers hold identical bytes after every frame | TerrainQuery equals all 66049 source samples; clipmap triangulation error per level recorded | `perf(terrain): upload only changed ring uniforms`; timing pending the quiet rerun |

Values and commands: [batch-169.md](batch-169.md#job-5-terrain-uniform-uploads).

## Batch 169 splines: work counts, 2026-11-10

| Work | Before | After | Output | Black-box oracle | Status |
| --- | --- | --- | --- | --- | --- |
| Two 8-segment Catmull-Rom curves intersected | 512 point evaluations | 64 | 6 curve pairs, 26 points and 7 overlaps, 1264 identical bytes | three.js 0.186.1 CatmullRomCurve3 values equal within 4.44e-16; it has no curve intersection | `perf(splines): rebuild intersection cubics once per curve`; timing pending the quiet rerun |

Values and commands: [batch-169.md](batch-169.md#job-4-splines-curve-intersection).

## Batch 169 mesh-edit: work counts, 2026-11-10

| Work | Before | After | Output | Black-box oracle | Status |
| --- | --- | --- | --- | --- | --- |
| Cube, three Catmull-Clark levels | 1260 edge-ID parses | 0 parses | 20 subdivisions, 482650 identical bytes | Blender 5.3 Subdivision Surface: every vertex matches, max 1.52e-7 (Float32); Blender keeps curved quads, Margo splits them into planar triangle pairs (2x faces) | `perf(mesh-edit): index subdivision edges numerically`; timing pending the quiet rerun |

The face-count difference is an accepted work difference (planar faces). Values and
commands: [batch-169.md](batch-169.md#job-3-mesh-edit-subdivision-edges). No rival timing.

## Batch 169 text: work counts, 2026-11-10

| Work | Before | After | Output | Status |
| --- | --- | --- | --- | --- |
| 600-character logical/visual pair measurement | 1198 kerning calls | 599 calls | 35 layouts, 387896 identical canonical bytes | `perf(text): reuse logical kerning and shaped prefix advances`; timing pending the quiet rerun |
| 18-character shaped run | 35 advance calls | 18 calls | same carets and bounds | timing pending the quiet rerun |

The [batch record](batch-169.md#job-2-text-layout-measurements) reports all four
Canvas and Troika 0.52.4 advance-width comparisons, including the nonzero numeric
differences and limited oracle scope. No rival timing or speed verdict is claimed.

## Batch 169 UI: work counts, 2026-11-10

| Package | Work | Before | After | Black-box oracle | Status |
| --- | --- | --- | --- | --- | --- |
| ui | 8 nested rows, same content widths 200 and 20 | 24 leaf measures | 2 leaf measures; 64 mixed-tree layout hashes unchanged | Yoga 3.2.1: one measure, same 9 rectangles; explicit grow/shrink: zero measures on both | `perf(ui): memoize intrinsic layout per call`; timing pending the quiet rerun |

Cause, accepted measurement-contract difference, the like-for-like explicit-size rows
and exact reproduction commands are in [batch-169.md](batch-169.md). No rival timing
was run and no speed ratio is claimed.

## Batch 182 volume controls

The historical volume-64 loss is retained. Its anisotropic normalized/world stride and lighting differ. [The clean-room controls](../sciviz-rivals.md) add unshaded isotropic 64/128 cubes, exact repeated images and public GPU API counts. Volume preparation removes two temporary 16-float matrices per frame with exact uniform-byte regression coverage. Fix: this batch 182 volume job commit. Timing pending the quiet rerun; no updated winner is claimed.


## Batch 182 sciviz scenes

Eight scenes against six rivals, same data, pixels, camera and colour ([sciviz-vs-rivals](sciviz-vs-rivals.md)). Smoke only: no timing row is published yet. Explicit work differences (Margo volume depth composition, Plotly PNG export on both sides, Cosmograph's own animation loop) are recorded per scene. Timing pending the quiet rerun.

## Batch 170 React: work counts, 2026-11-10

| Package | Work | Before | After | Black-box rival | Status |
| --- | --- | --- | --- | --- | --- |
| react | 10,000 meshes, one StrictMode rerender | 20,000 props enumerations | 0; 90,000 transform value bytes unchanged | React Three Fiber 9.8.2 (three r186): no counter for its props handling | `perf(react)`; timing pending the quiet rerun |
| react | `react-1000` and `react-10000`, first frame after mount | 1,000 and 10,000 draw calls | same | R3F: 1,000 and 10,000 draw calls | equal draw work; timing pending the quiet rerun |

The R3F adapter, its public-API scope and the smoke command are in [batch-170-react.md](batch-170-react.md).
No rival timing was run and no speed ratio is claimed.

## Batch 170 stats: work counts, 2026-11-10

| Package | Work | Before | After | Black-box rival | Status |
| --- | --- | --- | --- | --- | --- |
| stats | `Stats` overlay, 10 s idle (no frames) | 8,580 canvas commands | 0 | stats.js 0.17.0: 0 | `perf(stats)`; timing pending the quiet rerun |
| stats | `Stats` overlay, 10 s at 60 Hz | 7,617 canvas commands | 7,617, same draws | stats.js 0.17.0: 6,090 (bar graph scrolled by image copy) | accepted difference in drawing; timing pending the quiet rerun |

Method and rival harness: [batch-170-stats.md](batch-170-stats.md). No rival timing was run.

## Batch 170 worker: work counts, 2026-11-10

| Package | Work | Before | After | Rival | Status |
| --- | --- | --- | --- | --- | --- |
| worker | Start plus 100 unchanged Resize Observer calls | 100 size messages | 0, same worker state | three.js 0.186.1: no library code on this path | `perf(worker)`; frame time pending the quiet rerun |

Method: [batch-170-worker.md](batch-170-worker.md). No rival timing was run.

## Batch 170 cache: work counts, 2026-11-10

| Package | Work | Before | After | Rival | Status |
| --- | --- | --- | --- | --- | --- |
| cache | 300 hits on 3 stored files, issued together | 300 readonly + 300 readwrite IndexedDB transactions | 300 readonly + 1 readwrite, same records | Workbox 7.4.1 CacheFirst + ExpirationPlugin: 300 Cache Storage reads + 300 readwrite | `perf(cache)`; timing pending the quiet rerun |

Method and rival harness: [batch-170-cache.md](batch-170-cache.md). No rival timing was run.

## Batch 170 blender: export size, 2026-11-10

| Package | Work | Margo | Rival | Status |
| --- | --- | --- | --- | --- |
| blender | 256 x 128 UV sphere, 10 objects sharing it: file size (gzip -9) | `.margo` 11,227,568 B (2,910,714 B); meshopt 3,386,244 B (2,373,541 B) | glTF-Blender-IO (Blender 5.3.0 Beta) `.glb` 4,959,600 B (1,160,872 B) | accepted difference: 80 B GPU-ready vertices against 32 B, so load copies no vertex data; load time pending the quiet rerun |
| blender | Like for like: vertex bytes at 80 B per vertex, 130,560 vertices | 10,444,800 B | 10,444,800 B if glTF stored the same six attributes (4,177,920 B as written, 32 B) | same size for the same layout |

Method and harness: [batch-170-blender.md](batch-170-blender.md). No rival timing was run.

## Batch 170 vfx: work counts, 2026-11-10

| Package | Work | Margo | Rival | Status |
| --- | --- | --- | --- | --- |
| vfx | Steady frame, 100,000 live particles: bytes sent to the GPU | 224 B in 1 write | three.quarks 0.17.1: 4,800,000 B of instance attributes | no loss; timing pending the quiet rerun |

Method and rival harness: [batch-170-vfx.md](batch-170-vfx.md). No rival timing was run.
