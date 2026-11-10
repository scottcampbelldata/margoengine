# Batch 164 pass work counts

## Row 9.5: froxel preparation

Change: `perf(environment): compare froxel grid dimensions without serialization`.
The old path serialized the three grid dimensions once per frame and again when
allocating. Numeric comparison removes all 15 serializations in the 12-frame
explicit-grid fixture (initial setup, an in-place dimension change and restoration).
Default grid, white scattering and jitter bases no longer create per-frame arrays.
Four complete GPU-command tapes (1x/4x, explicit/default grid) match parent
`960bb4f9b` exactly, including shader text, descriptors, uploads, dispatches and draws.
The story changes density, color, temporal weight, resolution and the device.

Reproduce after `npm run build:packages`:

```sh
node --test --test-timeout=120000 packages/environment/tests/volumetric-workcount.test.js
node scripts/gpu-lock.mjs run --owner=bp164-fog --max=10 -- node packages/environment/scripts/test-browser.js --page=volumetric-transparent
npm run check:readme-run -- --packages=environment
```

For compatibility set `MARGO_COMPAT=1` in the environment before the GPU command.
This is CPU preparation work, not a GPU speed claim. Row 9.5 retains its historical
loss and timing is pending the quiet rerun. Its remaining GPU work is a documented
accepted workload difference: Margo injects and temporally reprojects a 160 by 90
by steps shadowed froxel field, then filters/integrates each column and composites
per MSAA depth sample. The rival row is a half-resolution steps-per-pixel
raymarch. The scene and grids are unchanged; reducing them is not an optimization.
Injection and integration stay separate dispatches because integration reads
neighbouring columns' completed injection results; no cross-workgroup barrier
exists within one dispatch. Combining colour effects across stored intermediates
would also change quantization. No equality or speed claim against the rival.

Clean-room research compared:

- Bartlomiej Wronski, *Volumetric Fog: Unified, Compute Shader Based Solution to
  Atmospheric Scattering*, SIGGRAPH 2014,
  https://advances.realtimerendering.com/s2014/wronski/bwronski_volumetric_fog_siggraph2014.pdf.
  Frustum volumes, temporal reprojection and light scattering guide the retained work.
- Sebastien Hillaire, *Physically Based and Unified Volumetric Rendering in
  Frostbite*, SIGGRAPH 2015,
  https://www.ea.com/frostbite/news/physically-based-unified-volumetric-rendering-in-frostbite.
  Keep analytic extinction and integration rather than lowering sample work.
- Jorge Jimenez, *Next Generation Post Processing in Call of Duty: Advanced
  Warfare*, SIGGRAPH 2014,
  https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/.
  Scheduling and traffic matter; fusion is constrained here by exact intermediate values.
- W3C GPU for the Web Working Group, *WebGPU*, 2026,
  https://www.w3.org/TR/webgpu/#programming-model. Dispatch boundaries supply
  producer/consumer ordering across workgroups.

No companion code or rival source was read.

## Row 13.19: screen effect passes

Change: `perf(shader): reuse NodePass render pass descriptors`. Each `NodePass`
render built a new render pass descriptor (object, attachment array and
attachment) and a pipeline key string. It now keeps one descriptor per pass and
compares output format, sample count and display encoding as values. In a
10-frame story with `pixelate`, `rgbShift` and `vignette` (a uniform change, a
resize, a format change, a sample-count change and a device restore), 30
descriptors become 3 at 1x and at 4x. Both full GPU-command tapes match parent
`960bb4f9b` exactly: WGSL, pipelines, bind groups, uniform bytes, passes, draws
and intermediate formats.

Reproduce after `npm run build:packages`:

```sh
node --test --test-timeout=120000 packages/shader/test/screen-effects-workcount.test.js
npm run check:readme-run -- --packages=shader
```

This is CPU preparation work, not a GPU speed claim. The three passes stay. Each
effect writes its result at the output's display precision and the next effect
reads that stored image; a fused shader would skip those stores and change pixels,
so the separate passes are an accepted workload difference. Jimenez (SIGGRAPH 2014,
https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/)
motivates fusion only where the intermediate values stay exact. No rival source
was read.

## Rows 9.7 and 13.15: Tonemap capture resolve

Change: `perf(tonemap): skip the unread depth copy in the final capture resolve`.
At 4x MSAA the final resolve of Tonemap's scene capture copied the multisampled
depth into Tonemap's private 1x depth texture every frame. Nothing reads that
texture afterwards: depth readers of a 4x capture bind its multisampled depth, a
mid-frame reader resolves first, and the capture ends right after the
presentation pass. `SceneTarget.resolve` takes a third argument, `depth`, and
Tonemap passes `false` for its final resolve. Per frame at 4x this removes one
render pass and one draw that read four depth samples and write one per pixel
(20 logical bytes per pixel with depth32float). At 1x nothing changes. In the
steady frame every other command is identical, and no bind group made since setup
or command in the frame references the skipped texture.

Reproduce after `npm run build:packages`:

```sh
node --test --test-timeout=120000 packages/tonemap/tests/capture-resolve.test.js
npm run check:readme-run -- --packages=tonemap
```

Left, as accepted differences: the colour resolve runs as its own pass because
core's scene pass (frozen for v1.0.0) ends without a resolve target, and the
`acescg` curve is the fitted AP1 RRT/ODT, not ACESFilmic. No speed claim.

## Row 13.17: velocity without TAA

`new TAA({velocityOnly: true, depth})` from `@margoengine/taa` draws motion
vectors with no jitter, capture, history or resolve; `MotionBlur` reads
`taa.velocity`. `p-motion-blur-velocity` measures that path as the like-for-like
row, and `p-motion-blur` keeps its full TAA workload. The velocity draw remains a
separate geometry pass because core's frozen scene pass has no velocity output.
Timing pending the quiet rerun.
