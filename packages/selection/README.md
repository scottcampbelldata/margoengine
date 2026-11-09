# @margoengine/selection

Import `margoengine/selection` from the `margoengine` package, or `@margoengine/selection` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Objects shown as an imposter of `@margoengine/lod` outline too: an engine plugin with `drawSelectionMask` (`SelectionMaskSource`) marks what it draws in the same mask, and a `LODSystem` does so for any object whose anchor or level is selected.

Visible core and PBR selection outlines using Jump Flood Algorithm distance fields or circular morphological dilation. `Selection.set` discovers glTF Pro/FBX buffers from their loader-owned mesh nodes; no separate outline registration is required.

```ts
import {Selection} from 'margoengine/selection';
import {Engine} from 'margoengine/core';
import {createMesh} from 'margoengine/materials';
import {box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box());
const selection = Selection.attach(engine, {algorithm: 'jfa', width: 3, color: [1,0.5,0]});
selection.set([mesh]);
```

`Picking.attach(engine)` enables faster `engine.pick(x, y)` in canvas CSS pixels:

```ts
import {Picking} from 'margoengine/selection';
import {Engine} from 'margoengine/core';
const x = 0;
const y = 0;
const engine = await Engine.create(document.querySelector('canvas')!);
const picking = Picking.attach(engine);
const mesh = await engine.pick(x, y);
```

The standard core PBR draw writes a second `r32uint` attachment in the same pass, with no extra draw calls. A pick copies a clipped 3×3 neighborhood from that frame when camera, mesh identities, geometry, transforms, visibility, materials and frame-graph revision match. Otherwise it renders a 3×3 micro frustum, rejecting each instance's bounding sphere before batching the survivors. The sphere test stays conservative under nonuniform scale, mirrored transforms and hierarchy shear. Zero means background; stored IDs are core slots plus one, so slot zero remains selectable.

The center wins. For an empty center, orthogonal neighbors win before diagonals, with a deterministic tie order. Coordinates and neighbors are bounded to the canvas. Readback remains asynchronous and one pick may be pending at a time. A reusable 768-byte staging buffer accommodates WebGPU's 256-byte row pitch. Device restoration recreates resources; removal or engine disposal frees them.

`Picking.attach(engine, {capture: false})` leaves the frame untouched (no second color target, no per-frame mesh snapshot) and renders the culled 3x3 pass for every pick; use it when picks are rare and frame rate matters more. Custom scene pipelines fall back to the micro pass; sections also use that pass so mutable core clipping uniforms stay current. Other mutable custom shader effects should render their changed state before picking. The cached ID texture costs four bytes per viewport pixel; the package remains optional and tree-shakable.

## Many points at once

A plain loop of `engine.pick`, awaited or under `Promise.all`, costs one readback a point and this package cannot merge them: core's queue answers overlapping picks one at a time and calls `onPick` for the next only when the last has finished, so a plugin never sees two at once. Merging them would be a core change.

`picking.pickMany(points)` answers many canvas CSS pixels from one GPU readback, where a loop of `engine.pick` waits for one
readback each. It answers what `engine.pick` answers, as `PickHit`s, in
order, with null for a miss or a point off the canvas. All points read the scene as it is at the call's turn in the pick
queue. Pass a `view` as the second argument to pick through it; with several views and no `view`, points outside the first
point's view are picked one at a time.

When the captured ID texture is current, the batch checks the scene once and submits all neighborhood copies in
one command buffer. Micro passes keep their per-point submissions so each reads its own camera and instance uploads.
Their sphere tests compute matrix rows only as each plane is reached, with unchanged arithmetic and culling results.

```ts
import {Picking} from 'margoengine/selection';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const picking = Picking.attach(engine);
const hits = await picking.pickMany([[10, 20], [64, 64], [120, 40]]);
const meshes = hits.map((hit) => hit?.mesh ?? null);
```

## Lines in picks

`LinePicking.attach(picking, lines)` from `margoengine/lines/pick` makes fat lines answer `engine.pick`, `picking.pick` and `pickMany`, in one depth test with the meshes, with `hit.line` and `hit.segment` set. See the [lines README](../lines/README.md#gpu-picking). `PointPicking` from `margoengine/points/pick` does the same for point clouds (`hit.cloud`, `hit.point`), and `SplatPicking` from `margoengine/splats/pick` for Gaussian splats (`hit.splats`, `hit.splat`); see the [splats README](../splats/README.md#picking-with-meshes-pick).

`picking.addOverlay(overlay)` is the hook it uses: an overlay draws into the 3 x 3 pick tile after every mesh, with IDs from `firstId`, and `pickHit(index)` turns an ID back into a hit. Up to 8 overlays; each owns 2^28 IDs. While one is registered, picks use the 3 x 3 pass rather than the cached ID texture.

## Marquee, lasso, hover and face/edge/vertex picking

`SelectionTool` drags a rubber band (or, with `shape: 'lasso'`, a free-form outline) over the canvas: Shift + drag replaces
the selection, Shift + Ctrl adds, Shift + Alt removes. It stops a matching press from reaching later listeners, so create it
before the camera controls. `HoverHighlight` outlines the mesh under the mouse with its own `Selection`. `selectInRect` and
`selectInPolygon` are the same tests as plain functions, and `pickElement` returns the face, nearest vertex and nearest edge
under a pixel. Both selection modes test each mesh's projected bounding sphere: `mode: 'center'` (default), `'overlap'` (a
crossing window) or `'contain'` (a window).

```ts
import {Picking, Selection, SelectionTool, HoverHighlight, pickElement} from 'margoengine/selection';
import type {EngineKernel} from 'margoengine/core';

function selectionTools(engine: EngineKernel, canvas: HTMLCanvasElement) {
  const picking = Picking.attach(engine);
  const chosen = Selection.attach(engine, {color: [1, 0.5, 0]});
  const hover = HoverHighlight.attach(engine, {
    picking,
    outline: Selection.attach(engine, {name: 'hover', color: [1, 0.9, 0.3], width: 2}),
  });
  const tool = SelectionTool.attach(engine, {
    shape: 'marquee',      // or 'lasso'
    mode: 'overlap',       // touch any part of a mesh to select it
    onSelect: meshes => chosen.set(meshes),
  });
  canvas.addEventListener('dblclick', event => {
    const hit = pickElement(engine, event.offsetX, event.offsetY); // core meshes; walks their triangles
    if (hit) console.log('face', hit.face, 'vertex', hit.vertex, 'edge', hit.edge, 'at', hit.point);
  });
  return () => { tool.dispose(); hover.dispose(); picking.dispose(); chosen.dispose(); };
}
```

`tool.selected` holds the current set, and the tool emits `select` (`meshes`, `operation`), `start` and `cancel`. Pass `signal`
to detach every one of these when an `AbortSignal` aborts, or use `using`. `pickElement` lists the triangles of core meshes whose
bounding sphere the ray crosses (back faces count), so use it for editing-sized models; loaded glTF models are picked with
`Picking` instead.

## Skinned, morphed and static PBR models

Loader-owned PBR nodes are discovered automatically. Explicit `add(model)` registration remains available for custom providers and is deduplicated with discovered sources:

Removing an explicit registration does not disable discovery of a loaded model. Hide its mesh nodes, remove the model, or dispose the picking effect to stop picking it. Unregistering a custom provider still removes that provider's draws.

```ts
import {Picking, Selection} from 'margoengine/selection';
import type {EngineKernel} from 'margoengine/core';
import type {PBRModel} from 'margoengine/gltf-pro';

function selectModel(engine:EngineKernel, model:PBRModel) {
  const picking=Picking.attach(engine,{capture:false});
  const outline=Selection.attach(engine);
  const removePick=picking.add(model),removeOutline=outline.add(model);
  return {async pick(x:number,y:number){
    const hit=await picking.pick(x,y);
    outline.set(hit ? [hit.mesh] : []);
    return hit?.mesh ?? null;
  },dispose(){
    removePick();removeOutline();picking.dispose();outline.dispose();
  }};
}
```

Use `hit.mesh` to outline the picked child. Selecting `hit.model` selects the whole model instead. A miss clears the outline with `set([])`. A selected node includes its descendants, so picking a drawable assembly root outlines its subtree.

The loaded-assembly regression is `node scripts/selection-loaded-child-tests.js` from the repository root after building packages. It loads the checked-in Khronos `CommercialRefrigerator.glb` (six named nodes, eight native PBR primitives). Real pixel hits on `FridgeDoor` and the drawable scene root `FridgeCase` verify child-only and whole-assembly outlines; a background miss restores the unselected frame exactly. It checks actual 1x and 4x MSAA without constructing geometry.

With registered sources, picking uses a combined 3×3 depth pass for core and PBR
geometry. It reads the current vertex buffer produced by animation, including
four/eight joint skinning and morphs. The optional deformation hook runs before
the pick pass, so seeking, editing a bone or changing morph weights does not
require a beauty render. Animation time is not advanced by the query. Deformed
draws are not rejected by their bind-pose bounds.

The returned mesh is the primitive's node. Picking and outlines honor hidden
ancestors, mirrored winding, front/back/double-sided materials, alpha masks, opacity maps
(materials `alphaMap`, `PickingPrimitive.opacity`), displaced surfaces (`displacement`), clipping planes (`clip`, whatever
`clipShadows` says), vertex alpha (left out with `vertexAlpha: false`),
UV1, texture transforms and implicit mip filtering. Blended PBR surfaces are
pickable when their sampled alpha is at least 0.001, materials meshes included. GPU picking chooses the
nearest visible surface; CPU BVH queries remain geometric triangle queries.

Outlines replay the same current PBR buffers against scene depth, with both
selection algorithms and single-sample or 4× MSAA targets. Registering buffers
does not change the model's beauty shader or bindings. Sources and their buffers
remain caller-owned; unregister functions are idempotent. Disposed sources,
reused mesh slots, pending readbacks and device restoration are guarded.

`PickingSource`/`PickingPrimitive` expose the same structural protocol to custom
providers with packed 80-byte PBR vertices. Arbitrary vertex WGSL, PBR section
clipping and TAA-jittered outline matching are outside this replay. Core-only
sources retain their existing MRT, culling and allocation paths.

Width is viewport pixels, 1..32. The selection mask uses the matching core or registered PBR vertex transform and equal depth, so occluded selected surfaces do not appear. The composite excludes the mask interior. Morphology costs more for large widths; JFA uses logarithmic ping-pong steps. Invisible/disposed meshes are omitted. Dispose releases all targets and passes.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/selection
## On the WebGL2 preview

`Picking` and `HoverHighlight` run on the preview when `webglPicking` is attached first. They find core meshes, a hit holds
`mesh` only, `pickMany` makes one pick a point, overlays refuse with `unsupported`, and `Selection` cannot draw there, so
hover shows through `onHover`:

```ts
import {Engine, box} from 'margoengine/core';
import {HoverHighlight, Picking} from 'margoengine/selection';
import {webglPicking, webglRenderer} from 'margoengine/webgl2-compat/pick';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgl2', fallback: webglRenderer});
engine.createMesh().setGeometry(box());
engine.start();
engine.use(webglPicking());
const picking = Picking.attach(engine);
HoverHighlight.attach(engine, {picking, onHover: (mesh) => console.log(mesh)});
```

Real WebGPU checks: npm run test:browser --workspace @margoengine/selection

## Preview tier contract

The small `@margoengine/webgl2-compat/preview` renderer reports `backend: 'webgl2'` and has no GPU device. GPU-only attachments throw a linked `MargoError` with code `unsupported` before allocating resources. Native WebGPU and the full WebGL2 compatibility layer both report `backend: 'webgpu'`. Use [`autoEngine` with `loadCompat`](../webgl2-compat/README.md#automatic-escalation) during scene setup to select a complete tier automatically.

`Selection` outlines already refused the preview; `Picking` can use the real `/pick` route when `webglPicking()` is attached first.
