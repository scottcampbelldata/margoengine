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
them), and also the main limit: no core `engine.pick`, no mesh BVH raycasts, no section caps. Section clipping itself
does apply, because the parts are drawn with core's own frame shader. Picking, hierarchy, shadows and streaming are the
package's own, in the `CulledParts` subclass from `margoengine/culling/parts`, so pages that use only culling do not
download them:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {CulledParts} from 'margoengine/culling/parts';
import {Shadows} from 'margoengine/shadows';

const engine = await Engine.create(document.querySelector('canvas')!);
const parts = CulledParts.attach(engine, [
  // capacity reserves slots for addParts; transforms may start empty.
  {geometry: box(), material: new PbrMaterial({color: '#8d99a6'}), transforms: new Float32Array(0), capacity: 1000},
]);
const at = (x: number, y = 0, z = 0) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

// Streaming: new parts go into free slots, with no rebuild. Removing frees the slots; other indices stay.
const [arm, hand] = parts.addParts(0, new Float32Array([...at(0), ...at(2)]));

// Hierarchy: hand's matrix is now relative to arm, and moving arm moves hand too.
parts.setParent(0, hand, {batch: 0, index: arm});
parts.setTransform(0, arm, at(0, 3));
console.log(parts.getWorldMatrix(0, hand)[13]);   // 3

// Shadows: casts every shown part, inside the camera view or not; receiving works as on core meshes.
Shadows.attach(engine, {resolution: 2048}).add(parts);
engine.start();

console.log(await parts.pick(200, 150));   // {batch, index} under a CSS pixel, or null
parts.removeParts(0, [hand]);
```

- `pick` finds parts only; compare with `engine.pick` when core meshes share the view. It draws every shown part once,
  so it costs more than `engine.pick` on a large list.
- A part with a parent stores a local matrix on the CPU. The fold runs when a matrix is set and costs one record write per
  part in the subtree; parts that never call `setParent` cost nothing. A part with children cannot be removed alone.
- `addParts` past `capacity` throws: buffers are sized at attach. New geometry needs a new `CulledParts`. Each free
  slot still costs its record and one test per frame.

### Many materials in one batch

Every part's colour, roughness, metalness and sidedness live in its own 96-byte record, so a batch is one geometry, not
one material. A CAD assembly with hundreds of colours costs one batch per distinct shape. `groupParts` turns a flat list
of items into those batches and says where each item went:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {CulledParts, groupParts} from 'margoengine/culling/parts';

const engine = await Engine.create(document.querySelector('canvas')!);
const bolt = box(0.2, 0.2, 1);
const items = Array.from({length: 500}, (_, n) => ({
  geometry: bolt,
  material: new PbrMaterial({color: [n / 500, 0.4, 1 - n / 500], metalness: 0.8}),
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, n % 25, 0, Math.floor(n / 25), 1],
}));
const {batches, places} = groupParts(items);   // one batch: 500 colours, one draw
const parts = CulledParts.attach(engine, batches);
engine.start();

const {batch, index} = places[42];
parts.setColor(batch, index, '#ff8000');                     // selection highlight: one record write
parts.setMaterial(batch, index, {roughness: 0.2});           // leaves the other values alone
console.log(parts.getMaterial(batch, index).roughness);      // 0.2
```

- By hand: `materials` on a batch gives one `PbrMaterial` per part, and `addParts(batch, transforms, materials)` does
  the same for new parts. A part added without one takes the batch's `material`, also in a slot a coloured part left.
- The values are copied: a later `material.set` does not reach a part, `setMaterial` does.
- Per part means the values in the record. Textures are not per part: core's `PbrMaterial` has none.
- A batch that mixes single-sided and double-sided parts leaves core's back-culled pipeline, as a batch with mirrored
  parts does, and applies the single-sided rule per part in the fragment shader.

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
(`examples/package-benchmarks/parts/culled-meshes.mjs`). With `engine.render()` (CPU culling on) the GPU test only adds
the screen-size cut. `minRadius` of 1-2 px is the small-part cull for large assemblies: a dropped part simply disappears, so keep it under the size where a
part is still recognisable.

### Occlusion for core meshes

`occlusion: true` also drops instances hidden behind others, with the same conservative Hi-Z test as `CulledInstances`:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {CulledMeshes} from 'margoengine/culling';

const engine = await Engine.create(document.querySelector('canvas')!);
const material = new PbrMaterial({color: '#8d99a6'});
engine.createMesh().setGeometry(box(40, 20, 1)).setMaterial(material).setPosition([0, 0, 5]);   // a wall
const small = box(0.5, 0.5, 0.5);
for (let i = 0; i < 2000; i++)
  engine.createMesh().setGeometry(small).setMaterial(material).setPosition([(i % 50) - 25, 0, -Math.floor(i / 50)]);
engine.camera.position = [0, 2, 30];
engine.camera.target = [0, 0, 0];

const culled = CulledMeshes.attach(engine, {occlusion: true});   // occluderSize: 8 (pixels of radius) by default
engine.start({culling: false});
setTimeout(async () => console.log(await culled.readCounts()), 1000);   // instances drawn per geometry
```

Before core's main pass, the instances kept last frame that are at least `occluderSize` pixels in radius are drawn
depth-only with this frame's camera into the package's own target, which is reduced to a pyramid; the cull kernel then
hides an instance only if it is strictly behind the farthest occluder depth everywhere it can touch. Occluders are real
instances of this frame at this frame's position, so a mesh that comes into view draws in that frame: images match
core's (`test/gpu/meshes-occlusion-check.mjs`).

- A frame falls back to frustum culling when core's shader is changed in a way that moves or discards surfaces (section
  planes), as for `CulledInstances`. Batches a package has `claimed` are culled but do not occlude.
- The first frame has no occluders; a hidden crowd starts to drop from the second.
- It costs a depth pass and a pyramid, so it pays in dense or enclosed scenes. Only core's meshes occlude.
- WebGL2 compatibility layer: frustum and screen size only, the same image with more drawn.

## Loaded models and materials meshes: `CulledModels`

`CulledModels` from `margoengine/culling/models` runs the same compute cull on the instanced primitives of gltf-pro
models and materials meshes, whatever they were loaded or built from, so a forest of a million trees costs the CPU the
same as ten.

```ts
import {Engine} from 'margoengine/core';
import {boxGeometry} from 'margoengine/geometry';
import {Material, createInstancedMesh} from 'margoengine/materials';
import {CulledModels} from 'margoengine/culling/models';

const engine = await Engine.create(document.querySelector('canvas')!);
const trees = createInstancedMesh(engine, boxGeometry(1, 4, 1), new Material({color: '#3f7a4a'}), 50_000);
for (let i = 0; i < 50_000; i++)
  trees.instances.setMatrixAt(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 250) * 3, 0, Math.floor(i / 250) * 3, 1]);

const culled = CulledModels.attach(engine, [trees], {minRadius: 1});   // drops rows under 1 CSS px in radius too
engine.start();
setTimeout(async () => console.log(await culled.readCounts()), 1000);   // rows drawn per primitive
```

Each frame, before any draw, every primitive of an added model that has `instances` tests its rows against the frustum,
compacts the kept rows in order, and sets `primitive.redirect`, gltf-pro's hook for this, which core's `Batch.redirect`
matches; every draw of the primitive in that frame (main pass, SSAO, outline) reads the kept rows with one indirect draw.
A glTF with EXT_mesh_gpu_instancing, a `PBRInstances` you assign and `createInstancedMesh` all go the same way. With no
`minRadius` the image is the same as without culling.

- `culled.add(model, {padding})` and `culled.remove(model)` work at any time. A shader that moves vertices past the
  geometry, such as a displacement map, needs `padding` of at least the farthest it moves them, in the primitive's units.
- Shadows, picking and export read every row, so casters outside the view still cast.
- Skinned and morphed primitives are not culled: their bounds are only known on the GPU. Primitives without `instances`
  draw as before, one draw each, so their CPU cost still grows with their number.
- Frustum and screen size only: no occlusion here.
- WebGL2 compatibility layer: nothing is culled and every row draws, the same image. The `@margoengine/webgl` renderer
  is not supported (`MargoError` `'unsupported'`).

## Shadows per cascade: `CascadeParts` and `CascadeInstances`

`shadows.add(parts)` draws every part into every cascade. `CascadeParts` and `CascadeInstances` from
`margoengine/culling/shadows` are `CulledParts` and `DynamicInstances` that test each caster against each cascade's light box
on the GPU, so a cascade draws only what reaches it. The shadow map is the same: a caster outside the box clips away there.

```js
import { Engine, box, PbrMaterial } from 'margoengine';
import { Shadows } from 'margoengine/shadows';
import { CascadeParts } from 'margoengine/culling/shadows';

const engine = await Engine.create(document.querySelector('canvas'));
const transforms = new Float32Array(16 * 1000);
for (let i = 0; i < 1000; i++) transforms.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 3, 0, 0, 1], i * 16);
const parts = CascadeParts.attach(engine, [{ geometry: box(), material: new PbrMaterial(), transforms }]);
Shadows.attach(engine).add(parts);
```

`readCascades()` resolves the casters kept per cascade in the last shadow frame. Each list costs one u32 per slot per cascade.
Lists too large to bind, the WebGL2 layer, and a pass with no `prepareShadow` in its frame all draw every caster, as the
plain classes do. Parts keep their sphere for this test whatever `bounds` says.


## Levels of detail: `LodInstances`

`LodInstances` from `margoengine/culling/lod` draws many copies of one object at up to four levels of detail. One compute pass
tests each instance against the frustum, picks its level by its radius on screen and appends it to that level's list, so the
frame has no CPU loop over instances. Core then draws each list with its own shader.

```js
import { Engine, box, PbrMaterial } from 'margoengine';
import { LodInstances } from 'margoengine/culling/lod';

const engine = await Engine.create(document.querySelector('canvas'));
const transforms = new Float32Array(16 * 1000);
for (let i = 0; i < 1000; i++) transforms.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 3, 0, 0, 1], i * 16);
const trees = LodInstances.attach(engine, {
  levels: [
    { geometry: box(1, 1, 1), minRadius: 40 },
    { geometry: box(0.8, 0.8, 0.8), minRadius: 8 },
    { geometry: box(0.6, 0.6, 0.6) },
  ],
  material: new PbrMaterial(),
  transforms,
});
trees.setTransform(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1]);
trees.setVisible(1, false);
```

`minRadius` is in CSS pixels, each level below the one before; an instance under the last level's value draws nothing (the
default 0 draws it however small). The first level's bounding sphere stands for every level, so the others must fit in it.
`readCounts()` resolves the instances drawn per level. Each level holds a list of every instance, 96 bytes each. Instances
cast no shadows through this class, and the WebGL2 layer draws every shown instance at the first level.


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
of them) and runs one compute pass: each live row's bounding sphere (the kernel's bound, padded for float32) is tested
against the frustum and, with `minRadius`, its size on screen, and the kept rows' 96-byte core instance records are
built on the GPU, compacted in index order, with indirect draw arguments. Core then draws them as one batch
through `Batch.redirect`, core's GPU-culling hook: a batch with a redirect is drawn even when core collected no
instances for it, which is the one line of core this class needs. So the instances draw in core's main pass and every
replay of it (SSAO, outline, post) with core's own shader and every shader patch, shadow receiving included.

- Shadows: `shadows.add(crowd)` (@margoengine/shadows) casts every live, shown instance, including those outside the
  camera view (one draw of all rows per cascade). Those rows are built by `prepareShadow`, which Shadows calls: once per
  cull, and a frame with no shadows or `crowd.pick` skips the work.
- Picking: `engine.pick` never returns instances (they are not core meshes); `crowd.pick(x, y)` returns the index.
- GPU-side motion: `crowd.transforms` is the GPU copy of `matrices`; an app compute pass that writes it animates
  instances with no upload at all.
- Mirrored matrices need `mirrored: true` (single-sided instances otherwise draw back-face culled, and `setMatrixAt`
  refuses a mirror). Rows with non-finite values draw nothing.
- WebGL2 compatibility layer: the same test runs on the CPU from the rows (O(n) per frame), the records are uploaded.
  The `@margoengine/webgl` renderer is not supported (`MargoError` `'unsupported'`).

Pixel checks on the GPU (`npm run test:gpu -w @margoengine/culling`): `test/gpu/parts-check.mjs` compares `CulledInstances`
with core meshes through hides, hierarchy moves, removes, adds and shadows, and compares picks with `engine.pick`.
`packages/culling/test/gpu/dynamic-check.mjs`: 576
boxes drawn as DynamicInstances and as core meshes, through moves, hides, deletes, adds into freed and new rows and
camera moves, with and without shadows: 0 differing pixels in every frame, and `crowd.pick` names the box `engine.pick`
names. RTX A6000, Edge 156.

Measured (diagnostic, busy machine; RTX A6000, Edge 156, 1280 x 720; `npm run bench -- dynamic`): with nothing moving the plugin's CPU work is 0.05 ms per frame at 10,000 and at
250,000 instances. With every box moving and its matrix set each frame, 7.7 ms CPU and 1.5 ms GPU at 100,000 boxes
against 15.6 and 2.7 ms as core meshes; 18.8 and 2.8 ms at 250,000 against 45.7 and 6.0 ms. The GPU time is still
above a plain instanced draw with no culling: [known-bugs.md](../../docs/known-bugs.md), "DynamicInstances: about
15-35% more GPU time".

## Modes

- `'frustum'` (default): bounding spheres against the six frustum planes (the same planes core's kernel uses).
- `'occlusion'`: frustum test, then a Hi-Z test against the parts that were visible last frame and are large on screen
  (`occluderSize`, default 8 px of bounding-sphere radius). Worth it for dense or enclosed assemblies; on an open
  layout the depth prepass and pyramid cost more than they save (numbers below).
- `'none'`: draw every part that is not hidden.

Both tests start from a part's bounding sphere. `bounds: 'box'` adds its oriented box, the geometry's box under the part's
matrix, for assemblies of long or thin parts, whose spheres reach far past them:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {CulledInstances} from 'margoengine/culling';

const engine = await Engine.create(document.querySelector('canvas')!);
const at = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const rods = new Float32Array(16 * 400);
for (let i = 0; i < 400; i++) rods.set(at((i % 20) - 10, -0.3, Math.floor(i / 20) - 10), i * 16);
const parts = CulledInstances.attach(engine, [
  {geometry: box(40, 0.05, 40), material: new PbrMaterial({color: '#8d99a6'}), transforms: new Float32Array(at(0, 0, 0))},
  {geometry: box(6, 0.1, 0.1), material: new PbrMaterial({color: '#c9ccd1'}), transforms: rods},   // under the plate
], {culling: 'occlusion', bounds: 'box'});
engine.camera.position = [0, 12, 20];
engine.camera.target = [0, 0, 0];
engine.start();
setTimeout(async () => console.log(await parts.readCounts()), 1000);   // [1, 0]: spheres would keep the rods
```

The box test runs on parts that pass the sphere test, so it only ever drops more, and images stay the same
(`test/gpu/bounds-check.mjs`). It reads the geometry's vertices once, at attach. `CulledParts` takes the same option.
`CulledMeshes`, `DynamicInstances` and `CulledModels` use spheres, and so does the WebGL2 compatibility layer's route.

## Any geometry as occluder

In `'occlusion'` mode only parts hide parts until you say otherwise. `addOccluder` adds a core mesh, a gltf-pro model, a
materials mesh or a `Terrain`, so a building hides the parts behind it even though it is not a part:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {CulledParts} from 'margoengine/culling/parts';

const engine = await Engine.create(document.querySelector('canvas')!);
const transforms = new Float32Array(16 * 1000);
for (let i = 0; i < 1000; i++)
  transforms.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 40) - 20, 0, -Math.floor(i / 40), 1], i * 16);
const parts = CulledParts.attach(engine, [
  {geometry: box(0.5, 0.5, 0.5), material: new PbrMaterial({color: '#c9ccd1'}), transforms},
], {culling: 'occlusion'});

const building = engine.createMesh().setGeometry(box(60, 20, 2)).setMaterial(new PbrMaterial({color: '#8d99a6'}));
building.setPosition([0, 0, 8]);
parts.addOccluder(building);       // also a loaded model, a materials mesh or a Terrain
engine.camera.position = [0, 2, 30];
engine.camera.target = [0, 0, 0];
engine.start();
setTimeout(async () => console.log(await parts.readCounts()), 1000);   // few of the 1,000 parts draw
```

Each frame the occluders are drawn into the same depth target as the parts, with the same camera and vertex maths as
their own draws, so the image does not change (`test/gpu/occluders-check.mjs`).

- Every primitive of an occluder is drawn each frame, without culling: add the large things, not everything.
- Only front faces occlude, so an open single-sided surface never hides what its back shows. A hidden mesh, or one not in
  the view's layers, does not occlude. A mirrored row of `PBRInstances` turns its primitive off as an occluder.
- Alpha cut-outs, blended and transmissive primitives, displacement maps and clipping planes do not occlude: their
  depth is not what the geometry says. A material extension that moves vertices cannot be seen from here, so do not add
  a model that uses one.
- `Terrain` draws its own rings on its own uniforms (`terrain.drawOccluder`), and any object with `drawOccluder` can do
  the same: depth greater-equal, at the `samples` it is given. `CulledMeshes` has no `addOccluder`: it runs before the
  frame's deformers.

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

- Static parts, one geometry per batch; `CulledInstances` has one `PbrMaterial` per batch, and `CulledParts` holds one per
  part. At most 1,000,000 parts and 96 bytes x parts within `maxStorageBufferBindingSize`.
- With bounding spheres, thin parts just behind a surface (a rod under a plate) are rarely culled: use `bounds: 'box'`.
  On an open layout the depth prepass and pyramid cost more GPU time than occlusion saves; use `'frustum'` there.
- Occluders are the package's own parts plus what `addOccluder` names; everything else draws but does not occlude.
- One frame shader variant is cached; changing `PassContext.shader` every frame recompiles.
