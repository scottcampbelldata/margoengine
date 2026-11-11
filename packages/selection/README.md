# @margoengine/selection

Import `margoengine/selection` from the `margoengine` package, or `@margoengine/selection` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Objects shown as an imposter of `@margoengine/lod` outline too: an engine plugin with `drawSelectionMask` (`SelectionMaskSource`) marks what it draws in the same mask, and a `LODSystem` does so for any object whose anchor or level is selected.

Visible core and PBR selection outlines using Jump Flood Algorithm distance fields or circular morphological dilation. `Selection.set` discovers glTF Pro/FBX buffers from their loader-owned mesh nodes; no separate outline registration is required.

```ts
import {Selection} from 'margoengine/selection';
import {Engine} from 'margoengine/core';
import {box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box());
const selection = Selection.attach(engine, {algorithm: 'jfa', width: 3, color: [1,0.5,0]});
selection.set([mesh]);
engine.start();
// On teardown: selection.dispose(); engine.dispose();
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

The cached ID texture is written by the colour pass itself, so its coverage matches the drawn pixels exactly. The separate 3x3 pass rasterises again with its own shader; 100 km from the origin its edges can differ from the colour by a pixel unless a `FloatingOrigin` (`@margoengine/cameras/origin`) keeps the scene near local zero ([limits](../../docs/limits.md), `npm run test:browser:far-origin`).

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

Width is drawing-buffer pixels, 1..32 (default 3). The selection mask uses the matching core or registered PBR vertex transform and equal depth, so occluded selected surfaces do not appear. The composite excludes the mask interior. Morphology costs more for large widths; JFA uses logarithmic ping-pong steps. Invisible/disposed meshes are omitted. Dispose releases all targets and passes.

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

`Highlight` refuses the small preview in its own setup through the shared `requireWebGPU` (`Highlight needs WebGPU`, code `unsupported`, help link). Before 2026-11-10 it refused only through its inner `Selection` (message `Selection requires WebGPU`), which the preview-contract gate cannot see, so `npm run verify` failed. The glow pass needs a WebGPU device; native WebGPU and the full compatibility layer are unchanged. Regression: `test/highlight.test.js`.

## Surface attributes: /hit-details

Attach `HitDetails` **instead of** `Picking`: it has the same point, batch,
model-registration and overlay APIs, with capture disabled. Ordinary triangle
hits also contain world `position`, unit world `normal`, Euclidean camera
`distance` in metres and perspective-correct UV0 `uv`. Core geometry has no
UVs and returns `[0, 0]`. Fields follow the winning neighbor pixel, including
nonuniform and mirrored transforms. Overlays keep their own hit fields;
approximate proxies do not gain triangle attributes. Check fields before using
`DetailedPickHit` with mixed providers.

`pick(x, y, view?, signal?)` and `pickMany(points, view?, signal?)` accept an
AbortSignal. Aborting rejects the caller promptly; a submitted GPU read still
finishes safely in the shared pick queue. The ID and attribute targets share
one submission and staging map, with 2,304 staging bytes per point (three
256-byte-pitched, three-row tiles). A miss is null. Dispose removes the picker
and frees its resources; it does not dispose meshes or registered sources.

```ts
import {Engine, box} from '@margoengine/core';
import {HitDetails} from '@margoengine/selection/hit-details';
import type {DetailedPickHit} from '@margoengine/selection/hit-details';

const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:160px;height:160px';
document.body.append(canvas);
const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 4]}});
engine.createMesh().setGeometry(box());
const picker = HitDetails.attach(engine);
const controller = new AbortController();
const hits = await picker.pickMany([[80, 80], [0, 0]], undefined, controller.signal);
for (const hit of hits) {
  if (hit && 'position' in hit && 'normal' in hit && 'uv' in hit && 'distance' in hit) {
    const surface = hit as DetailedPickHit;
    console.log(surface.position, surface.normal, surface.uv, surface.distance);
  }
}
picker.dispose(); engine.dispose(); canvas.remove();
```

## Hidden outlines and pulse: /xray

`XRaySelection` wraps Selection with visible and hidden outlines. It accepts
Selection's algorithm (default jfa), width (3), linear RGB color ([1, 0.5, 0])
and name (selection-xray here). Hidden outlines default to enabled, dash 4,
opacity 0.85 and width 1; their color defaults to the visible color. Set
`xray: false` to keep only visible outlines, or supply an object with
`color`, `width`, `dash` (0 for solid, up to 256) and `opacity`.

Pulse defaults to true: a cosine starts at full brightness, with a two-second
period and minimum factor 0.25. Set `pulse: false` for constant brightness or
`pulse: {period, minimum}` for a positive finite period and minimum 0..1.
The factor scales both outline colors, not alpha. Assign finite seconds to
`time` to pause on a manual value; `play()` resumes from that value. Automatic
time advances once per engine frame, including multiview rendering.

```ts
import {Engine, box} from '@margoengine/core';
import {XRaySelection} from '@margoengine/selection/xray';

const canvas = document.createElement('canvas'); document.body.append(canvas);
const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 4]}});
const selected = engine.createMesh().setGeometry(box());
engine.createMesh().setGeometry(box()).setPosition([0.3, 0, 1]).setScale([0.6, 1.2, 0.2]);
const outline = XRaySelection.attach(engine, {
  color: [1, 0.5, 0], xray: {color: [0, 0.7, 1], dash: 4, opacity: 0.85},
  pulse: {period: 2, minimum: 0.25},
});
outline.set([selected]);
outline.time = 0.5; // Manual seek; outline.play() resumes automatic time.
engine.start();
// On teardown: outline.dispose(); engine.dispose(); canvas.remove();
```

`set([])` clears the selection. `add(source)` returns an idempotent unregister
function for caller-owned current-pose GPU buffers. `maskTexture` is borrowed
from the last frame: do not destroy it or retain it across resize/restore.
Dispose (or `using`) removes passes and targets without disposing selected
objects. Separate effects need distinct names.

## Visible raster selection: /area

`AreaPicking` replaces Picking when marquee/lasso selection must test visible
triangles, rather than the projected bounding spheres used by SelectionTool.
It retains ordinary point queries, sources and the shared pick queue.
`rect({x, y, width, height}, view?, signal?)` normalizes negative sizes.
`polygon(points, view?, signal?)` takes 3..4,096 finite CSS-coordinate pairs;
it closes the polygon and fills self-intersections with the even-odd rule.
Only drawing-buffer pixel centers inside the shape count, so a thin feature
with no covered pixel center produces no hit. Occluded triangles do not count.

Queries clip to the canvas and the chosen view's viewport/scissor and obey its
scene/layers. Pass an explicit RenderView for multiview selection. Hits retain
mesh/model/primitive/instance identity, deduplicate by raster ID and follow
first visible occurrence in row-major order. Custom triangle sources use the
PickingSource protocol. Line, point-cloud and splat overlays and approximate
proxy hits are omitted; this is triangle area selection.

```ts
import {Engine, box} from '@margoengine/core';
import {AreaPicking} from '@margoengine/selection/area';
import {Selection} from '@margoengine/selection';

const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:160px;height:160px'; document.body.append(canvas);
const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 4]}});
engine.createMesh().setGeometry(box());
const picker = AreaPicking.attach(engine, {maxPixels: 1_000_000});
const outline = Selection.attach(engine);
const controller = new AbortController();
const rectangle = await picker.rect({x: 20, y: 20, width: 120, height: 120}, undefined, controller.signal);
const lasso = await picker.polygon([[20, 20], [140, 20], [140, 140], [20, 140]]);
outline.set(lasso.map(hit => hit.mesh));
console.log(rectangle.length, lasso.length);
engine.start();
// On teardown: outline.dispose(); picker.dispose(); engine.dispose(); canvas.remove();
```

Defaults: `capture: false`, `maxPixels: 16_777_216` drawing-buffer pixels in
the clipped bounding rectangle, not just pixels inside the polygon. The query
allocates r32uint IDs, depth32float depth and a readback buffer with 256-byte
row alignment: approximately eight texture bytes per bounding pixel plus
`ceil(width * 4 / 256) * 256 * height` staging bytes. Device texture and buffer
limits still apply when raising maxPixels; exceeding any budget rejects with
RangeError. Abort is checked before work and after GPU readback, then query
resources are freed. It does not cancel submitted GPU work. Dispose releases
the inherited picker resources; selected objects and sources remain yours.

## Visible glow and fill: /highlight

`Highlight` replays Selection's current-pose, alpha-tested visible mask, then
adds translucent fill and a separable Gaussian halo. Occluded surfaces do not
glow through blockers. Options are mutable and checked again when rendering:

| Option | Default | Meaning |
| --- | --- | --- |
| name | selection-highlight | Unique name for each independent group |
| color | [1, 0.5, 0] | Linear RGB fallback for both colors; each channel 0..1 |
| fillColor / glowColor | color | Independent fill / halo linear RGB |
| fillOpacity | 0.15 | Interior alpha, 0..1 |
| glowOpacity | 0.85 | Inner and outer halo alpha, 0..1 |
| radius | 8 | Gaussian support in drawing-buffer pixels, 1..64; sigma = radius / 3 |
| innerGlow / outerGlow | true / true | Enable the halo inside / outside the silhouette |

```ts
import {Engine, box} from '@margoengine/core';
import {Highlight} from '@margoengine/selection/highlight';

const canvas = document.createElement('canvas'); document.body.append(canvas);
const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 4]}});
const left = engine.createMesh().setGeometry(box()).setPosition([-0.8, 0, 0]);
const right = engine.createMesh().setGeometry(box()).setPosition([0.8, 0, 0]);
const warm = Highlight.attach(engine, {name: 'warm', fillColor: [1, 0.2, 0], glowColor: [1, 0.7, 0], radius: 12});
const cool = Highlight.attach(engine, {name: 'cool', color: [0, 0.5, 1], fillOpacity: 0, innerGlow: false});
warm.set([left]); cool.set([right]);
engine.start();
// On teardown: warm.dispose(); cool.dispose(); engine.dispose(); canvas.remove();
```

Each effect has its own mask and two full-size r16float blur targets (four
additional bytes per drawing-buffer pixel for the blur pair). Multiple groups
multiply those resources. Viewport/scissor bounds isolate multiview blurs;
resize and device restoration recreate targets. `set([])` clears a group;
`add(source)` borrows custom current-pose buffers and returns an unregister
function. `maskTexture` is borrowed, as for XRaySelection. Dispose or `using`
removes the effect and its GPU resources, leaving selected objects owned by
the caller. Both effects need WebGPU or the full compatibility layer.

## World pointers and proximity

`SpatialPicking` from `@margoengine/selection/spatial` reuses a caller-owned
`Picking` for arbitrary world rays without moving the desktop camera. Each
asynchronous query owns its camera. `sphere` finds the nearest actual triangle
surface in world metres, including nonuniform scale, glTF instances and the
current GPU-deformed pose. It loads the optional `@margoengine/bvh` peer lazily
on the first sphere query; ordinary rays do not load it.

Copy `packages/exporters/tests/fixtures/Box.glb` to your app's
`public/xr-pointer-box.glb` before running this example. The README gate serves
that exact licensed fixture at the same URL.

```ts
import { Engine } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf-pro';
import { Picking } from '@margoengine/selection';
import { SpatialPicking } from '@margoengine/selection/spatial';

const canvas = document.createElement('canvas'); document.body.append(canvas);
const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 4] } });
await loadGLTF(engine, '/xr-pointer-box.glb');
const picking = Picking.attach(engine);
const spatial = new SpatialPicking(engine, picking);
console.log(await spatial.ray([0, 0, 4], [0, 0, -1]));
console.log(await spatial.sphere([0, 0, 0.6], 0.11));
spatial.dispose(); picking.dispose(); engine.dispose();
```

The model is Cesium's Khronos Box (CC BY 4.0), recorded in
[the fixture notice](../exporters/tests/fixtures/NOTICE.md). Serve this clone or
copy the asset to your application. Constructor options: `scene` defaults to
`engine.scene`, `layers` to every render layer. Ray range defaults to 0.0001 to
1000 metres. `ray(origin, direction, near?, far?, signal?)` and
`sphere(center, radius, signal?)` accept AbortSignal. Both follow visibility and
scene/layer membership. Rays preserve the GPU picker's cutouts and sidedness;
sphere contacts test geometric surfaces on both sides, without texture alpha.
A sphere wholly inside a closed mesh does not touch its surface. Contacts retain
mesh, model, primitive, instance, world position, distance and face identity;
ray hits retain the existing `PickHit` fields and do not invent a world position.
Proximity constructs world-space BVHs per query for current geometry; large
continuous proximity workloads should budget that work explicitly.
The helper owns no meshes or GPU picker; disposal terminates only the helper.

`SpatialPicking.attach(engine, picking, options?)` is the equivalent factory.
For secondary-scene rays, register a Picking in that scene with
`scene.use(new Picking())` and pass it to the helper with `{ scene }`. A picker
registered in a different scene rejects rays with code `attached` before any
GPU read. Proximity does not require a registered GPU picker.

Spatial ray coordinates use each canvas axis independently: a positive
clientWidth/clientHeight supplies that axis's CSS size, otherwise width/height
supplies its backing size. This also supports detached, headless and worker
canvases without CSS layout; world rays never require moving the main camera.

## Works with

The [public CAD-format viewer](../../docs/integration-engineering.md) combines
selection with loaders, usdz, fbx, mesh-edit, cameras and ViewCube. The
[product viewer](../../docs/integration-product.md) combines loaded-model
selection with lighting, post effects and React; each guide lists its runnable
page, test command and measured integration boundaries.
