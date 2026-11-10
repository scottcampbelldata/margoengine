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
Run it through `node scripts/gpu-lock.mjs run --max=15 --wait-max=15
--owner=bp-163 -- node packages/points/scripts/test-browser.js`, then with
`--compat` appended. No timings or claim of winning the historical rows.
Timing pending the quiet rerun; the original point/block/draw work is unchanged.

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
