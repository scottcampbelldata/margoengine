# @margoengine/clustered

Optional clustered forward GGX lighting for up to 1,024 point/spot lights. A compute pass builds logarithmic-depth frustum AABBs and tests view-space light spheres and conservative spot-cone bounds. Fragment shaders calculate their screen/depth cluster and evaluate only its light list. This preserves forward alpha blending and does not require a deferred G-buffer.

```ts
import {EngineKernel,box} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box());
const lights = Clustered.attach(engine); // 16 × 9 × 24
lights.setLights([
  {position:[0,2,1], range:12, color:[1,0.3,0.1], intensity:20},
  {position:[2,3,0], range:15, direction:[0,-1,0], innerAngle:0.3, outerAngle:0.7, color:[0.1,0.3,1], intensity:30}
]);
engine.start();
```

Positions and directions are world space; cone angles are radians below π/2. Light radiance uses smooth range attenuation, inverse-square distance attenuation, and smooth inner/outer spot cones. `setLights()` replaces the list, validates all entries before changing it, and uploads only when called. Animate lights by calling it before rendering. Camera transformations and culling happen on the GPU.

`lights.intensityScale` multiplies all local light radiance and defaults to 1.
Set a nonnegative finite GPU-float value or a callback sampled each render, such
as `() => sky.nightFactor` for automatic night lights. Zero clears the GPU cluster
lists; authored intensities remain unchanged. The setting survives restoration.

Core meshes receive local lighting automatically. Call `lights.add(pbrModel)` or `lights.add(terrain)` for optional renderers; the returned function unregisters the receiver. Directional shadows compose with local lighting in either registration order.

## Point and spot shadows

Opt into bounded local shadow maps when creating the effect, enable shadows on
individual lights, and register their casters:

```ts
import {Clustered} from '@margoengine/clustered';
import type {EngineKernel,Mesh} from '@margoengine/core';

function localShadows(engine:EngineKernel,blocker:Mesh) {
  const lights=Clustered.attach(engine,{shadows:{resolution:512,maxLights:4}});
  lights.setLights([
    {position:[0,3,0],range:12,intensity:30,shadow:true},
    {position:[2,4,1],range:15,direction:[0,-1,0],outerAngle:0.6,
      innerAngle:0.3,intensity:40,shadow:{near:0.05,bias:0.0005,normalBias:0.02}},
  ]);
  const removeCaster=lights.addShadowCaster(blocker);
  return ()=>{removeCaster();lights.dispose();};
}
```

`shadows` defaults to resolution 512 and a maximum of four shadowed lights.
`maxLights` is an integer from 1 through 32, independent of the 1,024-light
lighting limit. Each slot reserves six `depth32float` layers; point lights render
all six faces and spot lights render one perspective face. Four slots at 512
reserve 24 MiB of depth storage. Attachment validates texture dimensions, array
layers and buffer limits before allocation. `setLights()` validates the full
replacement before changing the list; too many shadowed lights reject explicitly.

Per-light `shadow` defaults to false. `shadow:true` uses near distance
`min(0.1, range/100)`, depth bias 0.0005 and world-space normal bias 0.02.
An object overrides those values; near must be positive and below the light's
range, and both biases must be finite and nonnegative. Animate positions,
directions, ranges or shadow settings with `setLights()` before rendering.

`addShadowCaster()` accepts core meshes, individual loaded glTF/FBX nodes and sources exposing `shadowPrimitives`,
including glTF Pro models and their current deformed vertex buffers. Overlapping model/node registrations draw each primitive once, including distinct materials sharing GPU geometry. PBR masks
honor alpha, vertex alpha, UV0/UV1 and texture transforms; blended PBR primitives
are excluded. Hidden ancestors and disposed sources stop casting. Register a
model with both `addShadowCaster(model)` and `add(model)` when it also receives
local lighting. Custom-only `drawShadow()` sources such as clipmap terrain are
not local shadow casters in this version; terrain can receive the shadows.

Local depth passes run before clustered culling and main shading, redraw active
faces each frame, and use a fixed 3×3 comparison filter. Shadows multiply only
their own light's contribution. Ambient, unshadowed local lights and directional
cascades retain their responses. Bias and resolution control acne and detached
edges; this filter does not model area-light penumbrae. Device restoration
recreates the maps and caster bindings; disposal releases owned resources.

Without `ClusteredOptions.shadows`, the original shader, four lighting bindings
and allocation path remain exact. Opted-in effects add bindings 16–18 in the
existing lighting group (group 2 for glTF Pro); group 3 remains the independent
material slot. TAA, sky and terrain's existing bindings remain available.

Fragment lookup removes camera projection jitter before selecting the unjittered compute cluster. This keeps TAA from dropping small lights at fractional tile boundaries; the uniform's previously unused depth.zw fields carry the screen offset, without a dependency on TAA.

Each cluster reserves 1,024 indices, preventing silent truncation when many lights overlap. The default grid uses 13.5 MiB for indices. An optional `grid:[x,y,z]` is checked against storage limits at attachment. `lightLists` exposes GPU counts/indices for diagnostics or custom forward materials; ordinary rendering needs no readback. `clusteredSampling(group)` exports WGSL for custom materials. Frame rate depends on light overlap, materials, resolution and hardware; no locked FPS is promised.

Custom code reproducing `ClusterFrame` must include the trailing `intensity:vec4f`
at byte 112, making the uniform 128 bytes. Its X component is the radiance scale.
Consumers of `clusteredSampling()` and `bindings()` receive this layout automatically.
Custom shadow-aware materials use `clusteredSampling(group,true)` with the
bindings of a shadow-enabled effect; the default second argument is false.

`dispose()`/`destroy()` releases resources and receiver hooks. Device restoration recreates buffers and reuploads the light list. The package stays separate from core, stage and PBR assets.
