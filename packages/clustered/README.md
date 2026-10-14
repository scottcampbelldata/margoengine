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

Core meshes receive local lighting automatically. Call `lights.add(pbrModel)` (gltf-pro's `light` lighting hook, `lights.pbr(group)`) or `lights.add(terrain)` (a text patch of its `let linear=` line, as for core meshes; docs/shader-contracts.md) for optional renderers; the returned function unregisters the receiver. Directional shadows compose with local lighting in either registration order. Local lights themselves do not cast shadows.

Orthographic cameras (for example `CameraProjection` from `@margoengine/cameras`, or any projection whose `camera.matrix` has a constant clip w) get linear depth slices between the projection's own near and far planes, which may lie behind the eye, and cluster boxes whose x/y extents do not grow with depth, including off-centre frustums. Everything is read from `camera.matrix` and `camera.position`; the package does not depend on the cameras package. Perspective output is unchanged.

Fragment lookup removes camera projection jitter before selecting the unjittered compute cluster. This keeps TAA from dropping small lights at fractional tile boundaries; the uniform's previously unused depth.zw fields carry the screen offset, without a dependency on TAA.

Each cluster reserves 1,024 indices, preventing silent truncation when many lights overlap. The default grid uses 13.5 MiB for indices. An optional `grid:[x,y,z]` is checked against storage limits at attachment. `lightLists` exposes GPU counts/indices for diagnostics or custom forward materials; ordinary rendering needs no readback. `clusteredSampling(group)` exports WGSL for custom materials. Frame rate depends on light overlap, materials, resolution and hardware; no locked FPS is promised.

Custom code reproducing `ClusterFrame` must include the trailing `intensity:vec4f`
at byte 112, making the uniform 128 bytes. Its X component is the radiance scale; Y and Z hold the
orthographic NDC offset and W is 1 for an orthographic camera (then `screen.z` is the view half height per NDC unit,
`screen.w` the x/y ratio and `depth.xy` the signed near/far).
Consumers of `clusteredSampling()` and `bindings()` receive this layout automatically.

`dispose()`/`destroy()` releases resources and receiver hooks. Device restoration recreates buffers and reuploads the light list. The package stays separate from core, stage and PBR assets.
