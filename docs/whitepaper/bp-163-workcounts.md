# Batch 163 deterministic work counts

## Job 1: shared points and sprite frame uploads

The `p-points-1000000` and `p-sprites` scenes use a still camera. The points
plugin unconditionally queued its 144-byte camera uniform each view, even when
all bytes matched the buffer's last write. `perf(points): reuse identical frame
uniform uploads` compares all 36 words after constructing the original uniform.
It retains the last queued bytes for the single GPU buffer, across views, and
invalidates the snapshot on resource creation. It adds no core or stage work.

`node --test --test-timeout=120000 packages/points/tests/frame-work.test.js`
proves one initial upload followed by zero frame uploads for 100 identical
frames, instead of 101 writes / 14,544 bytes. The retained state is 144 bytes
plus one typed view and a validity flag per plugin. Camera, format, dimensions,
alternating view sizes and restoration each upload the uncached reference's
exact bytes. All other GPU commands match the forced-upload negative control.
The package browser test compares every pixel byte for cached and forced-upload
point frames on native WebGPU and WebGL2 compatibility (native 1x and 4x MSAA).
Run both backends in PowerShell:

```powershell
$env:MARGO_GPU_SLOTS='3'
node scripts/gpu-lock.mjs run --max=15 --wait-max=15 --owner=bp-163 -- node packages/points/scripts/test-browser.js
node scripts/gpu-lock.mjs run --max=15 --wait-max=15 --owner=bp-163 -- node packages/points/scripts/test-browser.js --compat
```
 No timings or claim of winning the historical rows.
Timing pending the quiet rerun; the original point/block/draw work is unchanged.


## Job 2: live light-helper circles

`p-light-helpers` moves point lights each frame. The old CPU circle builder
recomputed sine and cosine for both endpoints in all three coordinate lanes
for each of 32 edges in each of three circles: 1,152 calls per moving helper.
`perf(lines): retain light-helper circle samples` lazily stores the same 33
angles' sine/cosine results in Float64 (528 bytes), plus two three-number
coordinate arrays. Three circles share this per-helper state. Initial work is
66 trig calls; each subsequent moving-helper rebuild uses zero circle trig
calls and no per-edge endpoint arrays (192 arrays before). Segment order,
position arithmetic, colour selection, 32 edges and GPU drawing stay intact.
No state is allocated until a circle is used; import has no new work.

Run `node --test --test-timeout=120000 packages/lines/tests/helper-work.test.js`
after `npm run build:packages`. The independent uncached reference produces
byte-identical Float32 geometry at ordinary, tiny, signed-zero and large finite
positions. The first-use and moving-frame call counts fail with the old builder.
Existing spot and hemisphere tests retain their original geometry assertions.
GPU checks in PowerShell:

```powershell
$env:MARGO_GPU_SLOTS='3'
node scripts/gpu-lock.mjs run --max=15 --wait-max=15 --owner=bp-163-lines -- node packages/lines/scripts/test-browser.js
node scripts/gpu-lock.mjs run --max=15 --wait-max=15 --owner=bp-163-lines -- node packages/lines/scripts/test-browser.js --compat
```

Timing pending the quiet rerun; the historical slower status remains.

## Clean-room research

- Markus Schütz, Bernhard Kerbl and Michael Wimmer (2021),
  [Rendering Point Clouds with Compute Shaders and Vertex Order Optimization](https://www.cg.tuwien.ac.at/research/publications/2021/SCHUETZ-2021-PCC/).
  Contrasts closest-point rasterization and blended high-quality output.
- Markus Schütz, Bernhard Kerbl and Michael Wimmer (2022),
  [Software Rasterization of 2 Billion Points in Real Time](https://www.cg.tuwien.ac.at/research/publications/2022/SCHUETZ-2022-PCC/SCHUETZ-2022-PCC-paper.pdf).
  Batch culling, adaptive coordinate precision and LOD reduce point bandwidth.
- Nicolas P. Rougier (2013),
  [Shader-Based Antialiased, Dashed, Stroked Polylines](https://jcgt.org/published/0002/02/08/paper.pdf).
  Shader distance coverage avoids tessellating each dash.
- Kai Ninomiya, Brandon Jones and Jim Blandy, editors (2026),
  [WebGPU, W3C Candidate Recommendation Draft, 15 September 2026](https://www.w3.org/TR/2026/CRD-webgpu-20260915/#dom-gpuqueue-writebuffer).
  Queue writes copy source bytes into the destination buffer in queue order.

Compared approaches before implementation: compute rasterization, reduced
precision, reordered points and polyline tessellation can change exact output
or touch unrelated code. Reusing unchanged uniform bytes preserves all existing
point order, precision, coverage and shader work. Only papers, specifications
and Margo's own code were read; no companion or rival source was used.

For job 2, Rougier's 2013 analysis distinguishes geometry preparation from
fragment dash/coverage work. This change keeps the preparation's exact geometry
and avoids repeated evaluation, rather than changing its tessellation. Ecma
International, TC39 (2025), [ECMAScript Language Specification, Math.sin and
Math.cos](https://tc39.es/ecma262/2025/multipage/numbers-and-dates.html#sec-math.sin)
specifies implementation-approximated Number results. Values are retained at
runtime in Float64, never rounded to Float32, precomputed offline or derived
through a recurrence, so each runtime retains its own original results.


## Job 3: line and skeleton draw work

`p-lines` queued its unchanged 112-byte frame uniform every view. Skeleton
helpers use independent butt segments but submitted 78 vertices per bone:
the 72 cap/join vertices all collapse to their segment endpoint. In
`perf(lines): avoid redundant frame and empty fan work`, lines retains a
112-byte Uint32 snapshot per plugin, invalidated whenever its GPU frame buffer
is recreated. Unchanged frames queue no write. Independent butt and square
segments without a custom shader extension submit six vertices. The remaining
shader, dash, clipping, colour, depth, body and point order are unchanged.
Extensions retain their original vertex contract; connected and round-cap lines
still submit 78 vertices. Picking keeps its existing full vertex contract.

After `npm run build:packages`, run:

```powershell
node --test --test-timeout=120000 packages/lines/tests/render-work.test.js
$env:MARGO_GPU_SLOTS='3'
node scripts/gpu-lock.mjs run --max=15 --wait-max=15 --owner=bp163-r2-lines -- node packages/lines/scripts/test-browser.js
node scripts/gpu-lock.mjs run --max=15 --wait-max=15 --owner=bp163-r2-lines -- node packages/lines/scripts/test-browser.js --compat
```

The CPU test proves 101 static frames use one upload (112 bytes versus 11,312)
and skeleton bones submit 6 versus 78 vertices. It checks exact reference
uniform bytes, unchanged other commands, moving geometry, alternating view
sizes, output formats, signed zero and resource restoration. GPU controls
force the original 78 vertices and unconditional frame write and compare every
pixel byte, with butt/square caps, dash gaps, translucent lines, depth-writing,
a moving skeleton, a zero-length segment and a near-plane crossing, at 1x/4x
MSAA. Existing tiled capture and picking tests remain enabled.

Rougier (2013, cited above) describes separating the stroke body and caps/joins;
replacing the full tessellation or distance function would risk different
coverage. WebGPU (Ninomiya, Jones and Blandy, 2026, cited above) defines
triangle-list primitives and queue writes; zero-area endpoint triangles cannot
cover samples. Keeping the original six body vertices and shader arithmetic
avoids that risk. This is clean-room Margo code, with no rival source read.
Timing pending the quiet rerun; the historical slower classifications remain.
