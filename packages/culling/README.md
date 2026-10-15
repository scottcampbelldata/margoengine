# @margoengine/culling

GPU-driven static instances for large assemblies. Parts are uploaded once; every frame a compute pass tests each part
against the view frustum and, optionally, a Hi-Z depth pyramid, compacts the visible parts in their original order and
writes indirect draw arguments. The CPU does a fixed amount of work per frame (a few passes and two draws per batch),
however many parts there are. WebGPU only.

```ts
import {Engine, PbrMaterial} from '@margoengine/core';
import {CulledInstances} from '@margoengine/culling';

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
them), and also the main limit: no core `engine.pick`, no hierarchy, no `ExplodedView`/`AssemblyBVH`/`FeatureEdges`,
no section caps, no shadows. Section clipping itself does apply, because the parts are drawn with core's own frame
shader.

## Core meshes: `CulledMeshes`

`CulledMeshes` GPU-culls regular core meshes instead of a separate part list, so they keep everything core meshes have:
`engine.pick`, `Picking`, hierarchy, `ExplodedView`, `AssemblyBVH` and `FeatureEdges` (checked on the GPU below).

```ts
import {CulledMeshes} from '@margoengine/culling';
const culled = CulledMeshes.attach(engine);   // {minRadius: 2} also drops parts under 2 CSS px in radius
engine.onFrame(...);
// Your loop: let the GPU do the frustum test, so the kept set (and core's instance lists) stay stable while orbiting.
engine.render({culling: false});
```

Each frame, before any core draw, a compute pass reads each drawn batch from core's own (read-only) instance buffer,
tests every instance's bounding sphere (the kernel's sphere, padded for float32) against the frustum and, with
`minRadius`, its projected size, and compacts the kept instance records in their original order into the package's
buffer with indirect arguments. It then sets `batch.redirect` (core's one GPU-culling hook, see the core README), so
core's main pass and every replay of it (SSAO, SSR, selection outline...) draw the compacted list with core's own
pipelines; core still uploads its instance buffer, which the culler reads. `FeatureEdges` (machinery) draws its lines from the
compacted list too, so edges get the same frustum and screen-size culling. `engine.pick` draws from
core's CPU instance data and is unaffected. With `minRadius: 0` (default) frames are pixel-identical to core
(`examples/package-benchmarks/cad/culled-meshes.mjs`). Limits: frustum and screen size only (no Hi-Z occlusion yet; use
`CulledInstances` for occlusion on static parts); with `engine.render()` (CPU culling on) the GPU test only adds the
screen-size cut. `minRadius` of 1-2 px is the small-part cull for large assemblies (HANDOFF 5l.a; numbers in
[cad-performance.md](../../docs/cad-performance.md)): a dropped part simply disappears, so keep it under the size where a
part is still recognisable.

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
fragments beyond core's single-sided rule or changes core's clip-position line (for example `SectionPlanes`).

## Measurements

Intel Arc 140V (Core Ultra 7 258V), headless Edge, 1432x768, 4x MSAA, AC power, GPU lock held:
`examples/package-benchmarks/cad/results-culling.json`, written by `node examples/package-benchmarks/cad/culling.mjs
--check --views=orbit,still,grazing --layouts=sheet,stack`. Summary in `docs/cad-performance.md`.

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
