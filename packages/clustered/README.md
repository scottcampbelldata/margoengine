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

Core meshes receive local lighting automatically. Call `lights.add(pbrModel)` (gltf-pro's `light` lighting hook, `lights.pbr(group)`) or `lights.add(terrain)` (a text patch of its `let linear=` line, as for core meshes; docs/shader-contracts.md) for optional renderers; the returned function unregisters the receiver. Directional shadows compose with local lighting in either registration order. Local lights cast shadows with the optional `@margoengine/clustered/shadows` entry below.

## Point and spot light shadows

```ts
import {EngineKernel,box} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {LocalShadows} from '@margoengine/clustered/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const crate = engine.createMesh().setGeometry(box());
const lights = Clustered.attach(engine);
const shadows = LocalShadows.attach(engine, {lights, maxLights:4, resolution:512});
shadows.add(crate);                  // casters: core meshes, gltf-pro models, materials meshes (instances included)
lights.setLights([
  {position:[0,3,0], range:12, intensity:20, castShadow:true},                                     // point: six cube faces
  {position:[3,4,0], range:15, direction:[-1,-1,0], outerAngle:0.6, intensity:30, castShadow:true}, // spot: one map
]);
engine.start();
```

Lights with `castShadow: true` take shadow slots in list order; the first `maxLights` (1-16, default 4) get maps and later ones stay unshadowed. All maps live in one `depth32float` texture array of `resolution`² layers (default 512): six per point light (cube faces, each slightly wider than 90° so the 3×3 PCF kernel never crosses a face), one per spot light (a perspective frustum over the outer cone). Depth is reversed (near 1, far 0), the near plane is `range / 1000` and the far plane is the light's range. Receivers are offset toward the light by `bias` and along their normal by `normalBias`, both in shadow-map texels at the receiver's distance (defaults 1 and 1.5), so the offset scales with distance and resolution instead of being a world-space constant.

Receivers need nothing new: the shadow term sits inside clustered's light loop, so core meshes and everything registered with `lights.add()` (gltf-pro models, materials meshes) are shadowed. `shadows.add()` registers casters: a core mesh, or anything with gltf-pro's `shadowPrimitives` (gltf-pro models, materials meshes, `createInstancedMesh`, glTF `EXT_mesh_gpu_instancing`; alpha-masked materials cut out). Core mesh casters are not automatic, as three.js's `castShadow` is opt-in per mesh. `add()` returns the remover.

Maps are cached: a light's layers re-render only when that light changes (position, range, direction or cone), and every layer re-renders when a caster moves, shows or hides, changes its instance count or rows, its `shadowVersion` or geometry. Skinned or morphing models change vertices without any of those, so add them with `shadows.add(model, {dynamic: true})`, which re-renders every shadowed light each frame while they are present. `shadows.invalidate()` forces one re-render. `shadows.stats` reports the layers and draws of the last frame and frames that re-rendered nothing.

Without the entry nothing changes: `clustered`'s light loop composes the shadow term only while a `LocalShadows` is attached (its `shadow` hook), and its GPU calls are byte-identical to the previous release otherwise (`examples/package-benchmarks/proofs/clustered-local-shadows.proof.js`). A `castShadow` flag without the entry only writes an unused field of the light buffer.

Limits: casters from `drawShadow` sources (terrain, scatter) are not drawn into local maps; every caster is drawn into every re-rendered layer (no per-light culling), so moving casters cost `layers × casters` draws per frame; the light's own geometry should not be a caster (it would cover the light); no colored, transmissive or soft (PCSS) local shadows; spot frusta wider than about 140° lose resolution; the map adds one sampled texture and one sampler to the lit shader, so a glTF material using gltf-pro's physical variant (13 maps) together with directional `Shadows` and IBL reaches 17 textures, over WebGPU's default limit of 16 per stage. WebGPU only.

Measured (`examples/package-benchmarks/local-shadows-gpu.mjs`, Intel Arc 140V, Chromium, AC power, 1280×720, eight point lights of range 8 over a floor and 19 box casters, `results/local-shadows-gpu.json`): shadows on the floor and boxes for point and spot lights on core and materials receivers, no change on lit floor (max luma difference 0 over 2,285 points), shadows touching their casters (0 px gap). Submit-to-done frame time 8.5 ms with the entry attached and no light shadowed; with 1/4/8 shadowed point lights 8.9/9.9/11.4 ms when maps are cached and 9.8/12.6/16.2 ms when all of them re-render every frame (6/24/48 layers); eight shadowed spot lights 9.9 ms cached, 11.2 ms re-rendered. `dispose()` (or `using`) releases the maps and removes the hook.

Orthographic cameras (for example `CameraProjection` from `@margoengine/cameras`, or any projection whose `camera.matrix` has a constant clip w) get linear depth slices between the projection's own near and far planes, which may lie behind the eye, and cluster boxes whose x/y extents do not grow with depth, including off-centre frustums. Everything is read from `camera.matrix` and `camera.position`; the package does not depend on the cameras package. Perspective output is unchanged.

Fragment lookup removes camera projection jitter before selecting the unjittered compute cluster. This keeps TAA from dropping small lights at fractional tile boundaries; the uniform's previously unused depth.zw fields carry the screen offset, without a dependency on TAA.

Each cluster reserves 1,024 indices, preventing silent truncation when many lights overlap. The default grid uses 13.5 MiB for indices. An optional `grid:[x,y,z]` is checked against storage limits at attachment. `lightLists` exposes GPU counts/indices for diagnostics or custom forward materials; ordinary rendering needs no readback. `clusteredSampling(group)` exports WGSL for custom materials. Frame rate depends on light overlap, materials, resolution and hardware; no locked FPS is promised.

Custom code reproducing `ClusterFrame` must include the trailing `intensity:vec4f`
at byte 112, making the uniform 128 bytes. Its X component is the radiance scale; Y and Z hold the
orthographic NDC offset and W is 1 for an orthographic camera (then `screen.z` is the view half height per NDC unit,
`screen.w` the x/y ratio and `depth.xy` the signed near/far).
Consumers of `clusteredSampling()` and `bindings()` receive this layout automatically.

`dispose()`/`destroy()` releases resources and receiver hooks. Device restoration recreates buffers and reuploads the light list. The package stays separate from core, stage and PBR assets.
