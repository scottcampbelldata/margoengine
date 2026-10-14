# @margoengine/culling

GPU-driven static instances for large assemblies. Parts are uploaded once; every frame a compute pass tests each part
against the view frustum and, optionally, a Hi-Z depth pyramid, compacts the visible parts in their original order and
writes indirect draw arguments. The CPU does a fixed amount of work per frame (a few passes and two draws per batch),
however many parts there are. WebGPU only.

```ts
import {Engine, PbrMaterial} from '@margoengine/core';
import {CulledInstances} from '@margoengine/culling';

const engine = await Engine.create(canvas);
const parts = new CulledInstances([
  // One batch per (geometry, material); transforms are column-major affine world matrices, 16 floats per part.
  {geometry: plate, material: new PbrMaterial({color: '#8d99a6', metalness: 0.6}), transforms: plateMatrices},
  {geometry: bolt, material: new PbrMaterial({color: '#c9ccd1', metalness: 0.9}), transforms: boltMatrices},
], {culling: 'occlusion'});
engine.use(parts);
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
