# @margoengine/inspector

Optional DOM inspector for core entities, including `stage.engine`. The hierarchy
updates as entities are added, renamed, reparented or disposed. Arrow keys select,
expand and collapse tree items. Selected entities expose visibility, local
transforms and their core PBR material's roughness and metallic values. Editing a
shared material changes every mesh using it.

```ts
import {Inspector} from '@margoengine/inspector';
import type {EngineKernel} from '@margoengine/core';
function attach(engine: EngineKernel, effects: {exposure: number; bloom: number}) {
  return Inspector.attach(engine, {effects});
}
```

Pass the mutable options object of your attached post-processing effect to
`effects`; exposure/bloom controls bind directly to it. Unbound controls are disabled.

WebGPU wireframe edges, world-space vertex normals and AABB boxes use the existing
`@margoengine/lines` helpers. These overlays apply to core mesh geometry and honor
inherited visibility; they do not visualize gltf-pro's separate primitive buffers
or skinning. Debug drawing is disabled on WebGL2. The hierarchy and property
editor still work there. Neither core nor the stage facade is modified.

`select(mesh)` selects an entity. `setDebug('wireframe' | 'normals' | 'bounds', true)`
toggles a scene overlay. `dispose()` releases the DOM, timer, GPU resources and
registered passes; engine disposal also performs this cleanup.

## Frame debugger (`@margoengine/inspector/frame`)

A separate entry (8.3 kB min+gzip, plus 0.7 kB for the stats package's `GPUProfiler` it
reuses): an app that does not import it pays nothing. `capture()` records one
frame and resolves with a plain-JSON `FrameReport`; the DOM panel (bottom right, a
"Capture frame" button, collapsible tree and tables) shows the same report.

```ts
import {FrameDebugger} from '@margoengine/inspector/frame';
import type {EngineKernel} from '@margoengine/core';
async function inspectFrame(engine: EngineKernel) {
  const debug = FrameDebugger.attach(engine);        // {parent: null}: no panel (tests, CI)
  const report = await debug.capture({render: true}); // or capture() to take the engine's next frame
  return report.warnings;
}
```

What a report contains:

- `graph`: every frame graph pass in execution order, core's `main` (owner `core`) and each
  package pass with its plugin name and `order`, plus `(before frame graph)` /
  `(after frame graph)` for GPU work outside the graph (core's final MSAA resolve). Each has
  CPU encode time, GPU time and its GPU `passes`.
- per GPU pass: render/compute, label, encoder index, GPU time, render targets (format,
  size, samples, resolve target, load/store ops) and `commands`: draw / drawIndexed /
  drawIndirect / drawIndexedIndirect / dispatch / executeBundles with vertex or index count,
  instance count, triangles, workgroups, pipeline id, bind group ids, and for core batches
  the `entities` (mesh ids) drawn. Clicking a draw's mesh button selects it in an attached
  `Inspector`.
- `pipelines`: label, kind, topology, cull mode, blend per target, target formats, depth
  format/compare/write, MSAA samples, whether it was compiled during this frame, and the
  most `textures`/`samplers` bound at once (warning at 15 or 16 of the 16 WebGPU
  guarantees per stage; see gltf-pro's "Texture bindings").
- `bindGroups`: what each binding points at (buffer label, size and range; texture label,
  format and size; sampler).
- `totals`: draws (indexed, indirect), dispatches, triangles, instances, render/compute
  passes, encoders, submits, pipelines and shader modules created this frame (compile
  hitches), bind groups created, uploads and upload bytes; `uploads` per destination.
- `memory`: live GPU buffers and textures (count, bytes, ten largest).
- `timing`: `gpu` when the engine was created with `features: ['timestamp-query']` (pass
  times from the stats package's `GPUProfiler` on the frame graph's encoder), else `cpu`
  with a `note`.

How: while attached, only the device's create calls (buffers, textures, pipelines, bind
groups) are wrapped, to describe them and to count memory. For the captured frame only,
`engine.render`, the frame graph's passes, `createCommandEncoder`, the encoders and passes,
and `queue.writeBuffer` / `writeTexture` / `copyExternalImageToTexture` / `submit` are
wrapped; all are restored right after (a wrapper someone else layered on top is left in
place as a pass-through). Indirect draw arguments are copied to a readback buffer at the end
of the frame. Core is not modified.

Limits: resources, pipelines and bind groups created before `attach` show without
descriptions and are not in `memory` (attach before loading assets). Texture memory is
estimated from format, size, mips and samples. Indirect counts need COPY_SRC on the
arguments buffer (core and culling have it; otherwise the count is null and the draw is
left out of the triangle total) and are the values at the end of the frame. GPU times cover
passes on the frame graph's encoder; passes that already set `timestampWrites` (Stats on its
profiled frame) or that run on other encoders get none. Render bundle contents are not
listed. The texture tally counts texture bindings of all bound groups, sampled and storage.
