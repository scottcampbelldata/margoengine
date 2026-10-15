# @margoengine/clustered

Optional clustered forward GGX lighting for up to 1,024 point/spot lights, plus rectangle area lights (`@margoengine/clustered/area`, below). A compute pass builds logarithmic-depth frustum AABBs and tests view-space light spheres and conservative spot-cone bounds. Fragment shaders calculate their screen/depth cluster and evaluate only its light list. This preserves forward alpha blending and does not require a deferred G-buffer.

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

Without the entry nothing changes: `clustered`'s light loop composes the shadow term only while a `LocalShadows` is attached (its `shadow` hook); otherwise every GPU call, shader module and buffer write is byte-identical to clustered before shadows existed (482 recorded calls at 1x and 4x MSAA against `0ed56b9`, `examples/package-benchmarks/proofs/clustered-local-shadows.proof.js`). A `castShadow` flag without the entry only writes an unused field of the light buffer.

Limits: casters from `drawShadow` sources (terrain, scatter) are not drawn into local maps; every caster is drawn into every re-rendered layer (no per-light culling), so moving casters cost `layers × casters` draws per frame; the light's own geometry should not be a caster (it would cover the light); no colored, transmissive or soft (PCSS) local shadows; spot frusta wider than about 140° lose resolution; the map adds one sampled texture and one sampler to the lit shader: a gltf-pro physical material (13 maps) with directional `Shadows`, IBL and LocalShadows uses exactly the 16 per stage that WebGPU guarantees on every device, so one more texture on it throws a `RangeError` naming the combination (gltf-pro README, "Texture bindings"). WebGPU only.

Measured (`examples/package-benchmarks/local-shadows-gpu.mjs`, Intel Arc 140V, Chromium, AC power, 1280×720, eight point lights of range 8 over a floor and 19 box casters, `results/local-shadows-gpu.json`): every box casts onto the floor under point and spot lights, on core and materials floors alike; no shadow acne (lit floor unchanged: max luma difference 0 over 2,285 sample points, 1,389 under the spot light); shadows touch their casters (0 px gap). Submit-to-done frame time (one run, before the quiet-machine gate existed) 8.5-9.2 ms with no light shadowed, with or without the entry (the spread is run-to-run noise); with 1/4/8 shadowed point lights 8.9/9.9/11.4 ms when maps are cached and 9.8/12.6/16.2 ms when all of them re-render every frame (6/24/48 layers); eight shadowed spot lights 9.9 ms cached, 11.2 ms re-rendered. `dispose()` (or `using`) releases the maps and removes the hook.

## Rectangle area lights

```ts
import {EngineKernel,box} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {AreaLights} from '@margoengine/clustered/area';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box(8,0.02,8));
const lights = Clustered.attach(engine);
const panels = AreaLights.attach(engine, {lights});
panels.setLights([
  {position:[0,2.5,0], direction:[0,-1,0], width:1.6, height:0.6, color:[1,0.95,0.88], intensity:8},           // ceiling panel
  {position:[3,1,0], direction:[-1,0,0], up:[0,1,0], width:0.4, height:2, intensity:4, twoSided:true},           // light bar
]);
engine.start();
```

The three.js `RectAreaLight` equivalent, shaded with Linearly Transformed Cosines (Heitz, Dupuy, Hill and Neubelt, 2016): GGX specular (the stretched highlight of glossy floors) and Lambert diffuse. A light is a `width` × `height` rectangle centred on `position` that lights the side its `direction` faces (both sides with `twoSided`); `width` runs along `direction × up` and `height` along `up` (default world +Y, or +Z for a vertical `direction`). `intensity` is emitted radiance (luminance, as three.js's), times the linear `color`: a light of area A lights a surface it faces like a clustered point light of intensity `intensity × A` (tested to 0.1%). `lights.intensityScale` applies too. Up to 64 lights; `setLights()` replaces the list and validates every entry first.

Receivers are those of the clustered lights: core meshes automatically, `lights.add()` for gltf-pro models, materials meshes and terrain. Each quad is clipped exactly to the receiving surface's horizon (three.js uses an approximation there), so panels that cross a surface's plane, such as a wall light over a floor, have exact diffuse.

Accuracy (`test/area.test.js`, against brute-force quadrature of GGX with height-correlated Smith masking and Schlick Fresnel, the BRDF the table was fitted to): diffuse matches the exact form factor (under 0.2%, horizon clipping included); specular within 5% for views up to 60° from the normal and a dielectric pixel within 14%; the worst tested case is an 80° view at roughness 0.5 (+17% specular, -18% dielectric). Past about 84° on glossy surfaces the LTC approximation itself is off by up to ~35%; that is a property of the method, not of the table size.

The LTC table (the inverse-matrix and magnitude/Fresnel fits) is 32×32 cells of six float16 values, fitted from first principles by `scripts/build-ltc.mjs` (which regenerates `src/ltc.ts`): per cell, Nelder-Mead fits the transform to the GGX lobe by Heitz et al.'s method and the magnitude and Fresnel terms are integrated numerically. It is uploaded once into the same storage buffer as the lights and filtered bilinearly in the shader, so area lights bind no texture or sampler (one storage buffer, binding 17) and do not touch the 16-texture budget (gltf-pro README, "Texture bindings"). 32×32 keeps the entry at 8.9 kB min+gzip (`examples/package-benchmarks/entry-sizes.mjs`), about 21 kB with the 64×64 table. Clustered's root entry grew 87 B (4,503 -> 4,590) for the hook.

Real GPU (`examples/package-benchmarks/area-lights-gpu.mjs`, Intel Arc 140V, Edge 155, AC power, GPU lock, `results/area-lights-gpu.json`): a glossy (0.2) and a rough (0.8) grey floor, as a core mesh and as a materials plane lit through `lights.add()`, under a 1.6 x 0.6 m panel: at 768 pixel centres per frame the screenshot equals the CPU mirror of the shader within 1/255 on all four, no non-finite values; on the core floors GPU radiance (inverted tone map) matches brute-force GGX + Lambert quadrature within 1.5% at 10 points. Under a square light the glossy half-maximum highlight is stretched toward the viewer (z/x 1.35) and the rough one is not (0.96) with a 1.43x smaller largest pixel step. A one-sided light facing away leaves the floor exactly unlit; `twoSided` equals the light turned toward the floor within 1/255; an empty `AreaLights` renders byte-identical to none. GPU pass time at 1280 x 720 with the floor covering the whole frame (diagnostic: machine not quiet, quiet-gate timed out; 17% CPU at start): no lights 1.25 ms (also with an empty `AreaLights`), 1/4/16 lights 3.34/8.72/32.31 ms, about 1.9 ms per light per full-screen 720p frame (2.1 ns per pixel and light). Most of it is the two horizon-clipped quad integrals per light (diffuse alone measured ~1.3 ms per light), so a dozen full-screen area lights is the practical budget on this iGPU.

Without lights, `AreaLights` creates no buffer and composes nothing: GPU calls, shader modules and buffer writes are identical to clustered without the entry (`examples/package-benchmarks/proofs/clustered-area-lights.proof.js`, against `67e0172`). Limits: every fragment evaluates every area light (they have no range, so they are not culled into the cluster grid); no shadows from area lights (combine with `LocalShadows` point/spot lights or directional `Shadows` if needed); no textured (`map`) lights; WebGPU only.

Orthographic cameras (for example `CameraProjection` from `@margoengine/cameras`, or any projection whose `camera.matrix` has a constant clip w) get linear depth slices between the projection's own near and far planes, which may lie behind the eye, and cluster boxes whose x/y extents do not grow with depth, including off-centre frustums. Everything is read from `camera.matrix` and `camera.position`; the package does not depend on the cameras package. Perspective output is unchanged.

Fragment lookup removes camera projection jitter before selecting the unjittered compute cluster. This keeps TAA from dropping small lights at fractional tile boundaries; the uniform's previously unused depth.zw fields carry the screen offset, without a dependency on TAA.

Each cluster reserves 1,024 indices, preventing silent truncation when many lights overlap. The default grid uses 13.5 MiB for indices. An optional `grid:[x,y,z]` is checked against storage limits at attachment. `lightLists` exposes GPU counts/indices for diagnostics or custom forward materials; ordinary rendering needs no readback. `clusteredSampling(group)` exports WGSL for custom materials. Frame rate depends on light overlap, materials, resolution and hardware; no locked FPS is promised.

Custom code reproducing `ClusterFrame` must include the trailing `intensity:vec4f`
at byte 112, making the uniform 128 bytes. Its X component is the radiance scale; Y and Z hold the
orthographic NDC offset and W is 1 for an orthographic camera (then `screen.z` is the view half height per NDC unit,
`screen.w` the x/y ratio and `depth.xy` the signed near/far).
Consumers of `clusteredSampling()` and `bindings()` receive this layout automatically.

`dispose()`/`destroy()` releases resources and receiver hooks. Device restoration recreates buffers and reuploads the light list. The package stays separate from core, stage and PBR assets.
