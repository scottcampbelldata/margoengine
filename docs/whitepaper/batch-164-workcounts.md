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
