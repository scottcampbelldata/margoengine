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
| `@margoengine/splats` | same frame against the published photo `000001` | PSNR 12.226 dB, MAE 52.272 | GaussianSplats3D 0.4.7, PSNR 9.994 dB, MAE 60.646 | picture error |
| `@margoengine/tiles` | quadtree, 5,461 tiles, screen-space error 16, selected set | 1,120 tiles, checksum 121586381 | 3DTilesRendererJS 0.4.21, same 1,120 tiles, same checksum | equal |
| `@margoengine/tiles` | same view, one settled `update` | 0.300 ms | 3DTilesRendererJS 0.4.21, 2.300 ms | win |
| `@margoengine/points` | 10,000,000 points, one settled frame | 9.000 ms | potree-core 2.0.17, 5.400 ms | loss |

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
is closer (PSNR 12.226 dB, MAE 52.272) than camera-to-world (10.672 dB, MAE 59.713). The rival is shown that same
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
