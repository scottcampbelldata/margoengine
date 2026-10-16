# @margoengine/selection

Visible core and PBR selection outlines using Jump Flood Algorithm distance fields or circular morphological dilation. `Selection.set` discovers glTF Pro/FBX buffers from their loader-owned mesh nodes; no separate outline registration is required.

```ts
import {Selection} from '@margoengine/selection';
const selection = Selection.attach(engine, {algorithm: 'jfa', width: 3, color: [1,0.5,0]});
selection.set([mesh]);
```

`Picking.attach(engine)` enables faster `engine.pick(x, y)` in canvas CSS pixels:

```ts
import {Picking} from '@margoengine/selection';
const picking = Picking.attach(engine);
const mesh = await engine.pick(x, y);
```

The standard core PBR draw writes a second `r32uint` attachment in the same pass, with no extra draw calls. A pick copies a clipped 3×3 neighborhood from that frame when camera, mesh identities, geometry, transforms, visibility, materials and frame-graph revision match. Otherwise it renders a 3×3 micro frustum, rejecting each instance's bounding sphere before batching the survivors. The sphere test stays conservative under nonuniform scale, mirrored transforms and hierarchy shear. Zero means background; stored IDs are core slots plus one, so slot zero remains selectable.

The center wins. For an empty center, orthogonal neighbors win before diagonals, with a deterministic tie order. Coordinates and neighbors are bounded to the canvas. Readback remains asynchronous and one pick may be pending at a time. A reusable 768-byte staging buffer accommodates WebGPU's 256-byte row pitch. Device restoration recreates resources; removal or engine disposal frees them.

`Picking.attach(engine, {capture: false})` leaves the frame untouched (no second color target, no per-frame mesh snapshot) and renders the culled 3x3 pass for every pick; use it when picks are rare and frame rate matters more. Custom scene pipelines fall back to the micro pass; sections also use that pass so mutable core clipping uniforms stay current. Other mutable custom shader effects should render their changed state before picking. The cached ID texture costs four bytes per viewport pixel; the package remains optional and tree-shakable.

## Skinned, morphed and static PBR models

Loader-owned PBR nodes are discovered automatically. Explicit `add(model)` registration remains available for custom providers and is deduplicated with discovered sources:

Removing an explicit registration does not disable discovery of a loaded model. Hide its mesh nodes, remove the model, or dispose the picking effect to stop picking it. Unregistering a custom provider still removes that provider's draws.

```ts
import {Picking, Selection} from '@margoengine/selection';
import type {EngineKernel} from '@margoengine/core';
import type {PBRModel} from '@margoengine/gltf-pro';

function selectModel(engine:EngineKernel, model:PBRModel) {
  const picking=Picking.attach(engine,{capture:false});
  const outline=Selection.attach(engine);
  const removePick=picking.add(model),removeOutline=outline.add(model);
  outline.set(model.primitives.map(primitive=>primitive.node));
  return {pick:(x:number,y:number)=>engine.pick(x,y),dispose(){
    removePick();removeOutline();picking.dispose();outline.dispose();
  }};
}
```

With registered sources, picking uses a combined 3×3 depth pass for core and PBR
geometry. It reads the current vertex buffer produced by animation, including
four/eight joint skinning and morphs. The optional deformation hook runs before
the pick pass, so seeking, editing a bone or changing morph weights does not
require a beauty render. Animation time is not advanced by the query. Deformed
draws are not rejected by their bind-pose bounds.

The returned mesh is the primitive's node. Picking and outlines honor hidden
ancestors, mirrored winding, double-sided materials, alpha masks, vertex alpha,
UV1, texture transforms and implicit mip filtering. Blended PBR surfaces are
pickable when their sampled alpha is at least 0.001. GPU picking chooses the
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

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/selection
Real WebGPU checks: npm run test:browser --workspace @margoengine/selection

