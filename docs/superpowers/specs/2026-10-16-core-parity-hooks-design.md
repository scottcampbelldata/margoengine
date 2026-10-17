# Three core parity hooks

The user explicitly approved an exception to the v1 core feature freeze for these three hooks, in order. Combined core + stage must remain **strictly below 25,000 bytes gzip**, measured after each hook. The stage facade implementation stays unchanged. WebGL remains a preview of core meshes. Cube cameras, mirrors, hemisphere lights and the other optional-package backlog are outside this change.

## 1. Camera per render

Extend `Engine.render` options with `camera?: Camera`. Omission preserves the stage camera. The selected camera drives matrix updates, frustum culling and the renderer's `PassContext.camera`. The permanent `engine.camera` reference stays unchanged. A temporary camera may advance its own fit by the supplied delta; the stage camera's fit must not advance. Call simulation/plugin pre-update once per render.

Before returning, including a renderer/pass failure, restore the primary camera's culling planes, visible instances, batches and statistics. Recollection must not invoke simulation again. Preserve the ordinary render path's behavior and avoid per-frame arrays on it. Reject nested renders before changing view state. Alternate renders are sequential; this does not enable recursive frame graphs, isolated temporal histories, or automatically retarget camera-dependent optional plugins.

## 2. Colored ambient hook

Expose extension-only `Lighting.ambient?: Float32Array`, three nonnegative finite linear RGB multipliers, omitted meaning white. Runtime engines initialize white. Keep `radiance[3]` as ambient intensity and preserve all existing directional-light fields.

Append `ambient:vec4f` to the canonical core WGSL Frame, preserving its existing 112-byte prefix, and grow its storage to 128 bytes. RGB occupies floats 28–30. Core's diffuse ambient term gains the RGB multiplier. Update every producer of this canonical core shader/frame (including picking, GPU culling, XR, scatter, probes and shader replays) so default-white rendering and validation remain correct. Independent optional shading models keep their existing API; this hook does not claim configurable hemisphere lighting or full material parity.

## 3. Rectangles per core draw

Extend `DrawOptions` with independent `viewport?: readonly [number, number, number, number]` and `scissor?: readonly [number, number, number, number]`. Coordinates are top-left drawing-buffer pixels, with nonnegative integer origins and positive integer sizes. Reject invalid values before opening a render pass. Rectangles must fit the active target; custom target owners are responsible for reporting/using the correct dimensions.

Absent options retain the backend's full-target drawing behavior. Set rectangles on each WebGPU pass; WebGL converts top-left Y and resets rectangle state on subsequent ordinary draws. Honor `clear:false` on WebGL as on WebGPU. Clearing still clears the full attachment; later subviews use `clear:false`. This hook does not change camera aspect, optional packages' native passes or picking coordinates.

## Evidence

Use failing behavioral tests before each implementation, focused regressions after it, and a size measurement after each hook. Finish with package builds, strict types, API reports, the full Node suite, meaningful real-GPU captures for alternate views, RGB ambient and successive rectangle draws, plus the existing helmet regression. Use the shared GPU lock in the main checkout for every GPU run. Preserve user edits in the main checkout's parity documents.
