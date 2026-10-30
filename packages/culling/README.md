# @margoengine/culling

Import `margoengine/culling` from the `margoengine` package, or `@margoengine/culling` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

GPU-driven static instances for large assemblies. Parts are uploaded once; every frame a compute pass tests each part
against the view frustum and, optionally, a Hi-Z depth pyramid, compacts the visible parts in their original order and
writes indirect draw arguments. The CPU does a fixed amount of work per frame (a few passes and two draws per batch),
however many parts there are. WebGPU only.

```ts
import {Engine, PbrMaterial} from 'margoengine/core';
import {CulledInstances} from 'margoengine/culling';

const engine = await Engine.create(canvas);
const parts = CulledInstances.attach(engine, [
  // One batch per (geometry, material); transforms are column-major affine world matrices, 16 floats per part.
  {geometry: plate, material: new PbrMaterial({color: '#8d99a6', metalness: 0.6}), transforms: plateMatrices},
  {geometry: bolt, material: new PbrMaterial({color: '#c9ccd1', metalness: 0.9}), transforms: boltMatrices},
], {culling: 'occlusion'});
engine.start();

parts.setTransform(1, 12, matrix);   // batch 1, part 12: one 64-byte upload
parts.setVisible(0, 3, false);        // hide a part (isolation)
parts.culling = 'frustum';            // switch at any time
console.log(await parts.readCounts()); // parts drawn per batch in the last frame (a GPU readback; for tests and tools)
```

Parts are not core meshes. That is where the CPU saving comes from (core's kernel and batch collection never see
them), and also the main limit: no core `engine.pick`, no hierarchy, no mesh BVH raycasts,
no section caps, no shadows. Section clipping itself does apply, because the parts are drawn with core's own frame
shader.

## Core meshes: `CulledMeshes`

`CulledMeshes` GPU-culls regular core meshes instead of a separate part list, so they keep everything core meshes have:
`engine.pick`, `Picking` and hierarchy (checked on the GPU below).

```ts
import {CulledMeshes} from 'margoengine/culling';
const culled = CulledMeshes.attach(engine);   // {minRadius: 2} also drops parts under 2 CSS px in radius
// Let the GPU do the frustum test, so the kept set (and core's instance lists) stay stable while orbiting.
engine.start({culling: false});   // or engine.render({culling: false}) from your own loop
```

Each frame, before any core draw, a compute pass reads each drawn batch from core's own (read-only) instance buffer,
tests every instance's bounding sphere (the kernel's sphere, padded for float32) against the frustum and, with
`minRadius`, its projected size, and compacts the kept instance records in their original order into the package's
buffer with indirect arguments. It then sets `batch.redirect` (core's one GPU-culling hook, see the core README), so
core's main pass and every replay of it (SSAO, SSR, selection outline...) draw the compacted list with core's own
pipelines; core still uploads its instance buffer, which the culler reads. `engine.pick` draws from
core's CPU instance data and is unaffected. With `minRadius: 0` (default) frames are pixel-identical to core
(`examples/package-benchmarks/parts/culled-meshes.mjs`). Limits: frustum and screen size only (no Hi-Z occlusion yet; use
`CulledInstances` for occlusion on static parts); with `engine.render()` (CPU culling on) the GPU test only adds the
screen-size cut. `minRadius` of 1-2 px is the small-part cull for large assemblies: a dropped part simply disappears, so keep it under the size where a
part is still recognisable.

## Moving objects: `DynamicInstances`

Tens or hundreds of thousands of objects that move, hide, appear and go, with a fixed amount of engine CPU work per
frame however many of them change. Import it from `margoengine/culling/dynamic` (or `@margoengine/culling/dynamic`), so
pages that use only `CulledInstances` or `CulledMeshes` do not download it.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {DynamicInstances} from 'margoengine/culling/dynamic';

const engine = await Engine.create(document.querySelector('canvas')!);
const crowd = DynamicInstances.attach(engine, {
  geometry: box(0.5, 0.5, 0.5),
  material: new PbrMaterial({color: '#ffffff', roughness: 0.6}),
  capacity: 100_000,
});
for (let i = 0; i < 100_000; i++) {
  const id = crowd.addInstance([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 316) - 158, 0, Math.floor(i / 316) - 158, 1]);
  crowd.setColorAt(id, [Math.random(), 0.5, 0.8]);   // linear rgb tint of the material colour
}
crowd.setVisibleAt(7, false);                        // hide without deleting
crowd.deleteInstance(8);                             // its index is reused by the next addInstance

// Bulk writers (physics, animation) write rows of `matrices` (12 floats: the matrix without its last row) and mark them.
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  for (let i = 0; i < 1000; i++) crowd.matrices[i * 12 + 10] = Math.sin(time + i);  // translation y
  crowd.update(0, 1000);
});
engine.start();
console.log(await crowd.readCount());   // instances drawn in the last frame (a GPU readback; for tests and tools)
console.log(await crowd.pick(200, 150)); // the instance index under a CSS pixel, or null
```

Each frame, before any core draw, the plugin uploads the blocks of 256 rows that were written (one `writeBuffer` per run
of them) and runs one compute pass: each live row's 96-byte core instance record is built on the GPU, its bounding
sphere (the kernel's bound, padded for float32) is tested against the frustum and, with `minRadius`, its size on
screen, and the kept rows are compacted in index order with indirect draw arguments. Core then draws them as one batch
through `Batch.redirect`, core's GPU-culling hook: a batch with a redirect is drawn even when core collected no
instances for it, which is the one line of core this class needs. So the instances draw in core's main pass and every
replay of it (SSAO, outline, post) with core's own shader and every shader patch, shadow receiving included.

- Shadows: `shadows.add(crowd)` (@margoengine/shadows) casts every live, shown instance, including those outside the
  camera view (one draw of all rows per cascade).
- Picking: `engine.pick` never returns instances (they are not core meshes); `crowd.pick(x, y)` returns the index.
- GPU-side motion: `crowd.transforms` is the GPU copy of `matrices`; an app compute pass that writes it animates
  instances with no upload at all.
- Mirrored matrices need `mirrored: true` (single-sided instances otherwise draw back-face culled, and `setMatrixAt`
  refuses a mirror). Rows with non-finite values draw nothing.
- WebGL2 compatibility layer: the same test runs on the CPU from the rows (O(n) per frame), the records are uploaded.
  The `@margoengine/webgl` renderer is not supported (`MargoError` `'unsupported'`).

Pixel check on the GPU (`npm run test:gpu -w @margoengine/culling`, `packages/culling/test/gpu/dynamic-check.mjs`): 576
boxes drawn as DynamicInstances and as core meshes, through moves, hides, deletes, adds into freed and new rows and
camera moves, with and without shadows: 0 differing pixels in every frame, and `crowd.pick` names the box `engine.pick`
names. RTX A6000, Edge 156.

Measured (diagnostic, busy machine; RTX A6000, Edge 156, 1280 x 720; `npm run bench -- dynamic`): with nothing moving the plugin's CPU work is 0.05 ms per frame at 10,000 and at
250,000 instances. With every box moving and its matrix set each frame, 7.7 ms CPU and 1.5 ms GPU at 100,000 boxes
against 15.6 and 2.7 ms as core meshes; 18.8 and 2.8 ms at 250,000 against 45.7 and 6.0 ms. The GPU time is still
above a plain instanced draw with no culling: [known-bugs.md](../../docs/known-bugs.md), "DynamicInstances: about
25-35% more GPU time".

## Modes

- `'frustum'` (default): bounding spheres against the six frustum planes (the same planes core's kernel uses).
- `'occlusion'`: frustum test, then a Hi-Z test against the parts that were visible last frame and are large on screen
  (`occluderSize`, default 8 px of bounding-sphere radius). Worth it for dense or enclosed assemblies; on an open
  layout the depth prepass and pyramid cost more than they save (numbers below).
- `'none'`: draw every part that is not hidden.

## How it works

Per frame, inside one plugin pass after core's main pass:

1. **Occluder selection** (occlusion only): parts drawn last frame, still in the frustum and at least `occluderSize`
   pixels in radius are appended to a per-batch list (atomics; order does not matter for depth).
2. **Depth prepass** (occlusion only): those parts are drawn depth-only into the package's own depth texture, at the
   scene's MSAA sample count and with the same vertex math as core's shader, so every occluder sample is a sample the
   main pass will also cover at the same depth.
3. **Hi-Z**: level 0 is the farthest depth over all samples of each pixel; each level above takes the farthest of 2x2.
4. **Cull**: each part's bounding sphere is tested against the frustum; in occlusion mode the 8 corners of its box are
   projected, the smallest mip level whose 2x2 texels cover that rectangle is read, and the part is hidden only if its
   nearest depth (box corner, or the sphere's nearest point for perspective and orthographic cameras) is strictly
   behind the farthest occluder depth in that footprint (1e-5 relative margin).
5. **Stable compaction**: a workgroup scan, a scan of workgroup totals and a scatter write the visible parts' 96-byte
   instance records in their original order and each batch's instance count into the indirect arguments.
6. **Main pass**: one `drawIndexedIndirect` per batch with core's frame shader and pipeline state into core's targets.

Because occluders are re-rendered this frame from this frame's camera, there is no one-frame-late pyramid: a part that
becomes disoccluded is drawn in the frame it becomes visible. A culled part fails the depth test at every sample it
could touch, and visible parts are drawn in the same order as without culling, so coplanar faces resolve the same way
(greater-equal depth: the later batch wins). Occlusion falls back to frustum culling for any frame whose shader discards
fragments beyond core's single-sided rule or changes core's clip-position line.

## Measurements

Intel Arc 140V (Core Ultra 7 258V), headless Edge, 1432x768, 4x MSAA, AC power, GPU lock held:
`examples/package-benchmarks/parts/results-culling.json`, written by `node examples/package-benchmarks/parts/culling.mjs
--check --views=orbit,still,grazing --layouts=sheet,stack`.

| 89,883 parts | core meshes | `none` | `frustum` | `occlusion` |
| --- | --- | --- | --- | --- |
| CPU per frame (`engine.render`, GPU idle) | 23.4 ms | 0.48 ms | 0.41 ms | 0.55 ms |
| Open sheet, orbit: FPS / GPU ms | 36.4 / 24.7 | 45.5 / 16.4 | 51.8 / 18.3 | 46.6 / 16.3 |
| Open sheet, still | 31.9 / 26.6 | 47.9 / 17.4 | 52.9 / 15.7 | 47.2 / 18.9 |
| Open sheet, grazing view inside | 48.3 / 15.1 | 48.4 / 18.9 | 97.7 / 8.0 | 83.3 / 9.4 |
| Stacked block, orbit (parts drawn) | - | 27.2 (89,883) | 28.2 (80,803) | 37.3 (20,643) |
| Stacked block, still | - | 25.9 | 26.6 | 32.6 |
| Stacked block, grazing view inside | - | 29.1 | 48.7 | 52.3 |

GPU ms are pass timestamps sampled every 15th frame (noisy, about ±15% between runs); FPS is throughput with vsync off.
The stacked rows are FPS.

Real-GPU pixel check (same script, `--check`): two engines render the same 28,672 parts (1,024 modules plus a coplanar
twin of every plate in another colour) along a 160-frame camera path, one culled and one drawing everything; frames
are compared byte for byte on the flat sheet (orbit, grazing flight, view from below) and on a stacked block (orbit,
then a flight between two layers). Result: 0 differing pixels in all 640 compared frames (occlusion and frustum, both
layouts), no WebGPU errors; occlusion drew as few as 4,770 of 28,672 parts where frustum culling drew 16,338.

## Limits

- Static parts with one `PbrMaterial` per batch (per-part colours mean one batch per colour); at most 1,000,000 parts
  and 96 bytes x parts within `maxStorageBufferBindingSize`.
- Bounding spheres: thin parts just behind a surface (a nut under a plate, seen obliquely) are rarely culled, and on an
  open layout the depth prepass and pyramid cost more GPU time than occlusion saves; use `'frustum'` there.
- Occluders are this package's own parts; core meshes and other plugins' geometry do not occlude.
- One frame shader variant is cached; changing `PassContext.shader` every frame recompiles.
