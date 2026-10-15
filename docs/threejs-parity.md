# three.js r186 parity matrix

What Margo Engine covers compared with three.js r186 and its common add-ons (`three/addons`). It is meant for roadmap planning and as the source for a public comparison page. Every COVERED or PARTIAL claim names the Margo package, the export, and the file where the code lives.

## Summary

156 three.js features in 19 areas:

| Status | Count | Meaning |
| --- | --- | --- |
| COVERED | 88 | A Margo package implements the feature in a form a three.js user would accept as equivalent (limits noted). |
| PARTIAL | 39 | Some of it exists, but a common use case is missing. The notes say what. |
| MISSING | 29 | No implementation was found in any package's `src/`. |

Overall: Margo is strong where three.js relies on third-party libraries or examples. That includes cascaded PCSS shadows, clustered lighting, TAA, Gaussian splats, BVH queries, physics, navigation, terrain, water and sky. The day-one basics the first version of this matrix found missing (textures and materials on meshes you build, glTF extensions and compression, an orthographic camera, picking loaded models, image-based lighting outside React, combinable effects, FXAA, a math library) now exist as optional packages. What remains:

- **WebGL2 reaches core meshes only.** The fallback is the optional `@margoengine/webgl` package and draws core meshes flat-shaded with one light. Textures, glTF-pro models, shadows, post-processing, lines, points, text and most other rendering packages need WebGPU.
- **Lighting is thin outside clustered point and spot lights.** One directional light per engine, a colourless scalar ambient term, a fixed hemisphere fill in glTF-pro. Point and spot lights cast shadows through `@margoengine/clustered/shadows` (up to 16 shadowed lights). No RectAreaLight.
- **Core owns one canvas, one camera and one pass graph.** There is no render-to-texture from a second camera, no CubeCamera and no multiple viewports. All of these need core changes, and core is frozen for v1.0.
- **Materials stop at standard, basic, normal and matcap on your own meshes.** Physical features come only from glTF `KHR_materials_*` files and are approximated (transmission does not refract). No Lambert, Phong, depth or shadow-catcher materials, no second UV set and no geometry groups.
- **glTF coverage has gaps.** `KHR_animation_pointer`, iridescence, anisotropy, dispersion and material variants are rejected when required. glTF cameras are exposed as data only, and export writes no cameras or lights.
- **Post-processing lacks screen-space reflections and GI.** No SSR, GTAO, SSGI, motion blur, SMAA or lens flare, and no built-in screen effects (a shader `NodePass` makes one in a few lines).

Legend. A **†** marks rows where the evidence is the exported symbols, the package README and a non-trivial amount of source code, not a line-by-line read. See [How this was checked](#how-this-was-checked). Rows that work only on WebGPU say "WebGPU only" in their notes.

## Matrix

### 1. Core objects and scene graph

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Object3D transforms and hierarchy (position, rotation, quaternion, scale, parent, visible, name) | COVERED | core `Engine.createMesh`, `Mesh.setParent`, `setQuaternion` (`packages/core/src/engine.ts`) | Parent depth of 64 or less. At most 100,000 entities per engine (`packages/core/src/kernel.ts`). No `children`, `traverse`, `userData`, `lookAt` or `getWorldPosition`; world matrices are reachable only through `core/extension`. |
| Group (transform-only node) | COVERED | core mesh with no geometry | glTF importers use this pattern. |
| Scene object, multiple scenes | PARTIAL | one `Engine` = one canvas = one implicit scene | No Scene object. A second scene needs a second engine and canvas. |
| `scene.background` (color, texture, cubemap) | COVERED † | environment `EnvironmentBackground`, `Skybox` (`packages/environment/src/background.ts`), `ColorBackground` (`color.ts`, solid or vertical gradient); sky `Sky` | Core's clear color stays hard-coded; `ColorBackground` covers it with a pass on cleared depth. A transparent canvas still needs a core change. WebGPU only. |
| Transparent canvas (`alpha: true`) | COVERED | environment `TransparentCanvas` (`packages/environment/src/color.ts`); webgl `webglRenderer(canvas, {transparent: true})` | Zero core bytes: the plugin switches core's canvas context to premultiplied and writes alpha 0 where nothing was drawn, and follows device restores. FXAA, Bloom and PostStack keep valid alpha; Tonemap and SSAO keep alpha with a faint silhouette rim; DOF, TAA and SceneFade are opaque-canvas only (`packages/post/README.md`). |
| Frustum culling | COVERED | Rust/Wasm kernel, `TransformStore.tick` (`packages/kernel/src/lib.rs`, `packages/core/src/kernel.ts`) | Bounding spheres against six planes, taken from the final camera matrix, so orthographic projections cull exactly. For large static assemblies, culling `CulledInstances` does the same test (plus Hi-Z occlusion) on the GPU with no per-part CPU work. |
| Render loop, Clock/Timer | COVERED | core `Engine.start`, `onFrame` (`packages/core/src/engine.ts`) | Frame delta is clamped to 0.1 s. |
| Layers | PARTIAL | bvh `setMeshLayers`, `getMeshLayers` | Only filters raycasts. No camera or render layers. |
| Math library (Vector3, Matrix4, Quaternion, Euler, Box3, Sphere, Ray, Plane, Frustum, Color) | COVERED † | math `Vector2` … `Spherical`, `MathUtils` (`packages/math/src/`, one entry per type, e.g. `@margoengine/math/vector3`) | three.js method names; `toArray()` feeds core's tuple APIs, `Matrix4.fromArray` reads `camera.matrix`. Float64 matrices, no input validation. No Line3, Triangle, Cylindrical, `Vector3.project`/`unproject` or ColorManagement (README limits). Some packages still keep private matrix helpers. |

### 2. Renderer and platform

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| WebGPU renderer | COVERED | core `GPURenderer` (`packages/core/src/renderer.ts`) | Automatic instancing, reversed-Z, device-loss reboot. |
| WebGL2 fallback (WebGLRenderer, WebGPURenderer's WebGL2 backend) | PARTIAL | webgl `GLRenderer`, `webglRenderer` (`packages/webgl/src/index.ts`), passed as `Engine.create(canvas, {backend: 'auto', fallback: webglRenderer})` | Optional since it left core: without `fallback`, `backend: 'auto'` rejects when WebGPU is missing. Draws core meshes flat-shaded with one directional light: no textures, effects or `engine.pick`. Works on WebGL2: core meshes, gltf (constant colors), bvh, controls, labels, viewcube and lod distance or screen levels. Most other rendering packages (gltf-pro, materials, animation, shadows, clustered, post, taa, dof, tonemap, lines, points, text, environment, selection, sky, water, shader, xr and others) need WebGPU. |
| MSAA | COVERED | core `sceneSamples()` (`packages/core/src/quality.ts`) | 4x on desktop. 1x on user-agent-detected phones and on the light quality tier. |
| Reversed-Z / logarithmic depth | COVERED | core reversed-Z (`depthCompare:'greater-equal'`) | |
| ShaderMaterial, RawShaderMaterial, onBeforeCompile | PARTIAL | `core/extension` `FrameGraph`, `DrawOptions.pipeline`, `PassContext.shader` (`packages/core/src/plugin.ts`); materials `Material.shader(source, group)` (`packages/materials/src/index.ts`); shader `wgslFn` | Custom WGSL works per pass, or by string-patching the shared shaders. `Material.shader()` is an `onBeforeCompile`-style hook for one material's gltf-pro beauty shader, and shader's `wgslFn` drops hand-written WGSL into a node graph. There is no raw shader material with its own vertex layout and uniforms. |
| Node materials / TSL | PARTIAL | shader `NodeMaterial`, `NodePass`, `ComputePass` (`packages/shader/src`) | Typed nodes compile to WGSL with CSE and dead-code elimination; material slots (colour, normal, roughness, metalness, emissive, opacity, vertex position), PostStack effects and 1D compute over storage buffers. `discard(cond, value)` for cut-outs and slicing; atomics (add, max, min, load, store) on u32/i32 storage. No statement-level If, workgroup memory, light/shadow nodes or GLSL output; shadows and SSAO do not see `positionNode` (README limits). WebGPU only. |
| Compute (TSL compute, GPUComputationRenderer) | COVERED † | shader `ComputePass`, `storage` (`packages/shader/src/compute.ts`) | One-dimensional dispatch (up to 65,535 workgroups) over storage buffers that materials and post nodes can read. Runs every frame while attached. No workgroup memory or barriers, no texture ping-pong targets. Raw `engine.gpu` via `core/extension` remains for anything else. WebGPU only. |
| Render targets / render-to-texture | PARTIAL | creative `HDRRenderTarget` (`packages/creative/src/targets.ts`) | Captures the one scene from the one camera. There is no way to render a second camera or scene into a texture. |
| Multiple render targets (MRT) | PARTIAL | `DrawOptions.colorAttachments` (`packages/core/src/plugin.ts`) | Low-level only. selection uses it for its ID buffer. Node materials have no MRT outputs. |
| Clipping planes | PARTIAL | machinery `SectionPlanes`, `boxSection` (`packages/machinery/src/section.ts`); shader `discard` | Six planes with stencil caps, core meshes only. A `NodeMaterial` can slice materials meshes with `discard(positionWorld…)`, but shadows still see the whole surface and nothing caps the cut. No per-material `clippingPlanes` on glTF-pro models. WebGPU only. |
| Stats, GPU timing | COVERED † | stats `Stats`, `GPUProfiler` (`packages/stats/src/`) | Uses timestamp queries (request `features: ['timestamp-query']` at engine creation). |
| Multiple viewports / scissor | MISSING | — | |

### 3. Cameras

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| PerspectiveCamera | COVERED | core `Camera` (`packages/core/src/camera.ts`) | Position and target, `fov`, `near`, `far`; the aspect follows the canvas. `camera.up` sets screen up, so exact top-down views and roll work; `update()` throws `RangeError('Vertical camera')` only when `up` is parallel to the view. `camera.project` replaces the projection. No `zoom`, `setViewOffset`, `focalLength` or `filmGauge`. `fitToBoundingBox` is a Margo extra. |
| OrthographicCamera | COVERED | cameras `CameraProjection` (`packages/cameras/src/index.ts`) | Uses core's `camera.project` and `camera.up` hooks, so culling, `engine.pick`, selection and bvh rays follow the ortho frustum; also renders exactly vertical views (perspective or ortho). SSAO, points, labels, clustered, DOF, splats and lines' world widths read the orthographic matrix. `projection.fit(model.bounds)` frames a box by zoom. Shadow cascades are still fitted to the perspective frustum; they stay texel-locked under orthographic pan and zoom: zoom is bit-identical and a slow pan changes about 0.6 of 14,423 shadow-edge pixels per frame, against 194 for a 0.01° light turn (`examples/package-benchmarks/shadow-shimmer.mjs`, `results/shadow-shimmer.json`, Intel Arc 140V). |
| ArrayCamera | PARTIAL | xr stereo renderer (`packages/xr/src/renderer.ts`) | Internal to XR, not a general multi-view camera. |
| CubeCamera (dynamic environment maps) | MISSING | — | |
| StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | MISSING | — | |

### 4. Geometry

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Built-in primitives (Box, Capsule, Circle, Cone, Cylinder, polyhedra, Plane, Ring, Sphere, Torus, TorusKnot) | COVERED † | geometry `boxGeometry` … `torusKnotGeometry` (`packages/geometry/src/primitives.ts`, `polyhedra.ts`) | The README says the tests compare against three r180 fixtures vertex for vertex. |
| Shape, Path, curves, Extrude, Lathe, Tube | COVERED † | geometry `Shape`, `Path`, `CatmullRomCurve3` …, `extrudeGeometry`, `latheGeometry`, `tubeGeometry` | No custom `UVGenerator`. |
| EdgesGeometry, WireframeGeometry | COVERED † | geometry `edgesGeometry`, `wireframe` | Draw the result with the lines package. |
| BufferGeometry custom attributes (uv, uv1, color, tangent) on drawable meshes | PARTIAL | materials `createMesh`, `packGeometry` (`packages/materials/src/index.ts`); core `Geometry` (`packages/core/src/geometry.ts`) | Materials meshes take `uvs`, `tangents` and `colors` (RGB or RGBA) into gltf-pro's 80-byte vertex. The second UV set is a copy of the first, arbitrary named attributes cannot reach a shader, and geometry `groups` are ignored (one material per mesh). Core geometry stays position, normal and index only, up to 1,000,000 vertices. |
| BufferGeometryUtils (merge, mergeVertices, toNonIndexed, computeTangents, computeVertexNormals) | COVERED † | geometry `mergeGeometries`, `mergeVertices`, `toNonIndexed`, `computeTangents`, `computeVertexNormals` (`packages/geometry/src/utils.ts`) | |
| TextGeometry, FontLoader, TTFLoader | MISSING | — | SDF text is covered separately; see [Margo extras](#margo-extras). |
| ConvexGeometry, DecalGeometry, RoundedBoxGeometry, ParametricGeometry | MISSING | — | physics computes convex hulls for colliders only. |

### 5. Materials

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| MeshStandardMaterial, constant factors | COVERED | core `PbrMaterial` (`packages/core/src/geometry.ts`); materials `Material` (`packages/materials/src/index.ts`) | Core: color, roughness, metalness and doubleSided, alpha must be 1; live in place through `material.set({...})` (next frame, no pipeline or bind group rebuild). Materials: live color, emissive, roughness, metalness and opacity. |
| MeshStandardMaterial with maps (map, normalMap, roughness/metalness map, aoMap, emissiveMap) | COVERED | materials `Material`, `Texture`, `loadTexture`, `createMesh` (`packages/materials/src/index.ts`); gltf-pro `PBRModel` for loaded assets | `map`, `metalRoughnessMap` (glTF packing), `normalMap` with `normalScale`, `aoMap` with intensity, `emissiveMap`; map slots are live. Maps affect the lit colour only: SSAO normals ignore `normalMap`, and shadows ignore `map` alpha. No `displacementMap`, `bumpMap`, `lightMap`, `alphaMap` or per-material `envMap`. WebGPU only. |
| MeshPhysicalMaterial (clearcoat, sheen, transmission, iridescence, anisotropy, IOR, specular, dispersion) | PARTIAL | gltf-pro `KHR_materials_clearcoat`, `sheen`, `transmission`, `volume`, `ior`, `specular` (`packages/gltf-pro/src/index.ts`, `shader.ts`) | Only from glTF files; materials has no physical options. Approximations by design (README): transmission tints the background without refracting, clearcoat and sheen take only the key light and hemisphere fill. No iridescence, anisotropy or dispersion. |
| MeshBasicMaterial (unlit) | COVERED | materials `Material({shading: 'basic'})`; gltf-pro `KHR_materials_unlit` | Basic output skips tone mapping (three.js tone-maps basic materials by default). |
| MeshLambertMaterial, MeshPhongMaterial | MISSING | — | fbx converts Lambert and Phong materials to PBR on import. |
| MeshToonMaterial | PARTIAL | toon `Toon`, creative `ToonShading` (`packages/toon/src/index.ts`) | Applies to every core mesh at once, not per material. The README says it does not apply to glTF-pro or skinned meshes. |
| MeshMatcapMaterial | COVERED | materials `Material({shading: 'matcap', matcap})` | Skips tone mapping, like basic. |
| MeshNormalMaterial, MeshDepthMaterial, MeshDistanceMaterial | PARTIAL | materials `Material({shading: 'normal'})` | View-space normals as colour. No depth or distance material. |
| ShadowMaterial (shadow catcher) | PARTIAL | staging `ContactShadows` (`packages/staging/src/index.ts`) | The product-shot case: a soft contact shadow on a ground plane over whatever is there (three.js's ContactShadows example), from core meshes, glTF-pro and materials meshes. Not a material: it catches no directional-light (cascade) shadows and only on a Y-up plane. WebGPU only. |
| PointsMaterial, SpriteMaterial | COVERED † | points `PointsMaterial`, `SpriteMaterial` (`packages/points/src/material.ts`) | WebGPU only. |
| LineBasicMaterial, LineDashedMaterial, Line2's LineMaterial | COVERED † | lines `LineMaterial` (`packages/lines/src/line.ts`) | Width, joins, caps and dashes. WebGPU only. |
| Transparency, alpha blending, alphaTest | COVERED | materials `transparent`, `opacity`, `alphaTest`; gltf-pro `MASK` and `BLEND` | All material meshes draw in one pass: opaque, then transparent back to front, each by `renderOrder`. Shadows ignore `map` alpha cut-outs on materials meshes. Core meshes are opaque only. |
| Order-independent transparency (three.js has none built in; its examples sort per object) | COVERED † | oit `OIT` (`packages/oit/src/index.ts`) through gltf-pro's transparency hook | Weighted blended OIT for gltf-pro BLEND primitives and materials transparent meshes (`oit.add(model)`): no popping between overlapping transparent parts; MSAA 1x/4x, PostStack, TransparentCanvas, orthographic. An approximation, exact for one layer (errors per layer count in `packages/oit/README.md`). Transmission and custom blending stay sorted. WebGPU only. |
| Vertex colors | COVERED | materials geometry `colors` (RGB or RGBA, floats or bytes); gltf-pro `COLOR_0` | Always multiply the base colour (no `vertexColors` switch). Not available on core meshes. |
| `side` (Front, Back, Double) | PARTIAL | `doubleSided` on `PbrMaterial`, materials `Material` and glTF | No back-side-only rendering. |
| Wireframe | PARTIAL | inspector overlay; geometry `wireframe` drawn with lines | No material flag. |
| Per-material blending modes, depthTest, depthWrite, polygonOffset, renderOrder, stencil | PARTIAL | materials `blending` (`'normal'`, `'additive'`, `'multiply'`, `'none'`), `depthWrite`, `depthTest`, `createMesh(…, {renderOrder})`; gltf-pro `material.renderState` | Fixed at construction. No custom blend equations, `polygonOffset` or stencil state. Core meshes have none of these. |

### 6. Textures

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Texture, TextureLoader on arbitrary meshes | COVERED | materials `Texture`, `loadTexture` (`packages/materials/src/index.ts`) | Any image, bitmap, canvas, video, VideoFrame, ImageData or raw RGBA8. `colorSpace`, `flipY` (three.js default), one GPU copy shared by every material. `loadTexture` caps downloads at 64 MiB and 4096 × 4096 pixels. Materials and glTF-pro meshes only. WebGPU only. |
| CubeTexture, CubeTextureLoader | PARTIAL | environment `Environment` built from an equirect or six `CubeFaces` | Used only for IBL and backgrounds; no material takes a cube map. |
| DataTexture, Data3DTexture, DataArrayTexture | PARTIAL | materials `new Texture({data, width, height})` | 2D RGBA8 only. No float or single-channel formats, and no 3D or array textures (used internally by the tonemap LUT and shadow arrays, not exposed). |
| CompressedTexture (KTX2/Basis) | PARTIAL | decoders `KTX2Decoder` (`packages/decoders/src/ktx2.ts`), consumed by gltf-pro for `KHR_texture_basisu` | Works for glTF textures. A standalone `.ktx2` gives a raw `GPUTexture` from `createTexture` that materials cannot take. KTX2 cube maps, arrays and HDR are rejected. |
| VideoTexture, VideoFrameTexture | COVERED | materials `new Texture(videoElement)` or a `VideoFrame`; video `Video` (`packages/video/src/index.ts`) | Videos re-upload when `currentTime` changes (a copy per frame, not zero-copy); call `update()` for a new `VideoFrame`. video's zero-copy external texture draws to a screen rectangle only. |
| CanvasTexture | COVERED | materials `new Texture(canvas)` | Call `texture.update()` after drawing. |
| Texture `offset` / `repeat` / `rotation` / `center`, texture atlases | COVERED † | materials `uvTransform`, `setUVTransform`, `packAtlas`, `transformUVs` (`packages/materials/src/index.ts`, `atlas.ts`); gltf-pro `KHR_texture_transform` | glTF `KHR_texture_transform` semantics (rotation about the UV origin, no `center`); per map slot on a `Material`, not per `Texture`. Atlas regions merge static meshes into one draw. Shader-node `texture()` reads raw UVs. |
| DepthTexture | PARTIAL | `depthTexture` getters on post `PostStack`, `Bloom` and `SSAO`, and on dof `DOF` | Borrowed from whichever effect owns the scene capture. |
| Mipmaps, wrapping, filtering | COVERED | materials `TextureOptions`: `wrapS`/`wrapT` (clamp, repeat, mirror), `magFilter`/`minFilter`, `mipmaps`, `anisotropy` up to 16; gltf-pro glTF samplers and mips (`packages/gltf-pro/src/mip.ts`) | Mip chains are generated on the GPU. |

### 7. Lights

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| AmbientLight | PARTIAL | core lighting `radiance[3]` (through `core/extension`) | A scalar intensity times albedo. It has no color and does not apply to metals (`packages/core/src/shaders.ts`). environment `EnvironmentLighting` replaces it with IBL. |
| HemisphereLight | PARTIAL | fixed sky/ground gradient in gltf-pro's ambient term (`packages/gltf-pro/src/shader.ts`, line 61) | Not configurable. Core meshes use the flat ambient. |
| DirectionalLight | PARTIAL | core lighting `direction` and `radiance` (`packages/core/src/engine.ts`, through `core/extension`) | Exactly one per engine, and not on the public `EngineKernel` type. |
| PointLight | COVERED † | clustered `Clustered.setLights` (`packages/clustered/src/index.ts`) | Up to 1,024 lights, WebGPU only; shadows with `castShadow` and `@margoengine/clustered/shadows` (see Shadows). Core meshes receive them automatically; glTF-pro models, materials meshes and terrain need `add()`. glTF `KHR_lights_punctual` lights come from `model.clusteredLights()`. |
| SpotLight | COVERED † | clustered `Clustered.setLights` with inner and outer cone | Shadows as for PointLight. No projected `map`. |
| RectAreaLight | MISSING | — | |
| LightProbe | PARTIAL | environment `projectEquirectSH`, `environment.sh` | One global probe from the environment map. No placed probes or probe volumes. |
| IESSpotLight, ProjectorLight | MISSING | — | |
| Physical light units (candela, lux) | MISSING | — | Intensities are unitless radiance scales. |

### 8. Shadows

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Directional light shadows (incl. CSM add-on, PCF/PCFSoft) | COVERED † | shadows `Shadows` (`packages/shadows/src/index.ts`, `cascades.ts`) | Four cascades, PCSS, and a cache for static casters. WebGPU only. Core meshes are shadowed automatically; glTF-pro models (including skinned ones and materials meshes), terrain and scatter need `add()`. Goes beyond three core. |
| PointLight shadows | COVERED | clustered `LocalShadows`, entry `@margoengine/clustered/shadows` (`packages/clustered/src/shadows.ts`) | Lights with `castShadow` get six cube-face layers in one depth texture array (`maxLights` 1-16, default 4; `resolution` default 512), 3x3 PCF, texel-scaled normal and light-direction bias. Casters: core meshes, glTF-pro models, materials and instanced meshes via `add()`; receivers are whatever clustered lights. Maps re-render only when their light or a caster changes (`{dynamic: true}` for skinned casters). Not drawn: terrain/scatter `drawShadow` casters. Real-GPU check and costs: `examples/package-benchmarks/local-shadows-gpu.mjs`. WebGPU only. |
| SpotLight shadows | COVERED | clustered `LocalShadows` (as above) | One perspective layer over the outer cone per light; same filtering, bias, casters and caching as point lights. |

### 9. Environment, fog and color

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| HDRLoader / RGBELoader | COVERED † | environment `parseHDR`, `loadEnvironmentImage` (`packages/environment/src/hdr.ts`) | |
| EXRLoader | COVERED † | environment `parseEXR` (`packages/environment/src/exr.ts`) | Single-part scanline files with NONE, RLE, ZIPS, ZIP or PIZ compression. |
| PMREMGenerator, `scene.environment` (IBL) | COVERED † | environment `Environment`, `EnvironmentLighting` (`packages/environment/src/lighting.ts`) | `EnvironmentLighting.attach(engine, ...)` patches core's mesh shader through `PassContext.shader`; `lighting.add(model)` lights glTF-pro models. IBL replaces the constant ambient term, and post's SSAO occludes it. glTF-pro's clearcoat and sheen layers keep the hemisphere ambient. WebGPU only. |
| Fog, FogExp2 | COVERED † | environment `Fog` (linear, exp2, height); sky `fog` option (exp or exp2, height gain, sky-radiance or fixed colour); creative `PostProcessing` `atmosphere` (exponential height fog in its grading pass) | `Fog` runs in core's and glTF-pro's mesh shaders, so blended glTF primitives are fogged. Particles, VFX and splats are not. |
| Sky add-on | COVERED † | sky `Sky` with Preetham and Bruneton models (`packages/sky/src/`) | Adds clouds, sun, moon and stars. |
| Tone mapping (`renderer.toneMapping`) | COVERED † | core fixed Reinhard; gltf-pro ACES; tonemap `Tonemap` with AgX, ACES fitted and Khronos Neutral (`packages/tonemap/src/index.ts`) | |
| Color management (sRGB input, linear workflow, `outputColorSpace`) | PARTIAL | core converts hex sRGB to linear and encodes sRGB output; math `Color` stores linear sRGB | No ColorManagement API. No Display-P3 or HDR canvas output. |
| Exposure, physical camera parameters | COVERED † | `exposure` in stops on tonemap and Bloom; dof `focalLength` and `aperture` (f-number) | |

### 10. Loaders

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| GLTFLoader: static textured PBR | COVERED | gltf-pro `loadGLTF`, `parseGLTF`, `parseGLTFAsync` (`packages/gltf-pro/src/index.ts`); gltf `loadGLTF` with constant colors, works on WebGL2 (`packages/gltf/src/index.ts`) | Metallic-roughness, MASK and BLEND, normal, occlusion and emissive maps, two UV sets, vertex colors. WebGPU only. |
| GLTFLoader: animations, skins, morph targets | COVERED | animation `Animation.attach` (`packages/animation/src/index.ts`) | STEP, LINEAR and CUBICSPLINE interpolation. |
| glTF extensions (KHR_materials_*, KHR_texture_transform, KHR_lights_punctual, KHR_mesh_quantization, EXT_mesh_gpu_instancing, KHR_animation_pointer) and glTF cameras | PARTIAL | gltf-pro supported set (`packages/gltf-pro/src/asset.ts`, line 14) | Read: `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `unlit`, `clearcoat`, `transmission`, `ior`, `volume`, `sheen`, `specular`, `KHR_lights_punctual` (as data plus `clusteredLights()`), `EXT_texture_webp`, `EXT_texture_avif`, `EXT_mesh_gpu_instancing` (one instanced draw per primitive with `decoders.instancing` from `@margoengine/gltf-pro/instancing`, see InstancedMesh), and the three compression extensions below with a decoder. A file that requires anything else throws, naming it: `KHR_animation_pointer`, `KHR_materials_iridescence`, `anisotropy`, `dispersion` and `variants` are among those. glTF cameras are exposed as `model.cameras` data and are not applied to the engine camera. |
| DRACOLoader, glTF Draco | COVERED † | decoders `DracoDecoder` (`packages/decoders/src/draco.ts`), passed as `loadGLTF(engine, url, {decoders: {draco}})` | Worker-pooled Wasm. gltf-pro does not import decoders, so files without Draco pay nothing. The small gltf loader does not use it. |
| Meshopt (`EXT_meshopt_compression`) | COVERED † | decoders `MeshoptDecoder`, `decodeMeshoptBuffer` (`packages/decoders/src/meshopt.ts`), passed as `decoders.meshopt` | Pure TypeScript. Also accepts `KHR_meshopt_compression`. |
| KTX2Loader | PARTIAL | decoders `KTX2Decoder`, passed as `decoders.ktx2` | glTF `KHR_texture_basisu` textures transcode to BC7, ASTC, ETC2 or RGBA8. Standalone `.ktx2` files cannot go on materials meshes; cube maps, arrays and UASTC HDR are rejected. |
| FBXLoader | COVERED | fbx `loadFBX`, `convertFBX` (`packages/fbx/src/index.ts`) | Native binary/ASCII FBX 7.x reader and GLB writer (no three.js): hierarchy with pivots, Phong/Lambert as PBR, textures, skins, blend shapes, clips. Tested equivalent to the old three.js bridge. |
| OBJLoader | PARTIAL | machinery `parseCAD`, `loadCAD` (`packages/machinery/src/cad-parser.ts`) | Geometry only: `vt`, `usemtl` and `mtllib` records are skipped. |
| MTLLoader | MISSING | — | |
| STLLoader | COVERED | machinery `parseCAD` (format `stl`) | |
| PLYLoader | COVERED † | loaders `parsePLY` (`packages/loaders/src/ply.ts`) | Colors and UVs are kept on the data; core meshes do not render them. |
| 3MFLoader | COVERED † | loaders `parse3MF` (`packages/loaders/src/threemf.ts`) | No textures. |
| USDZLoader, USDLoader | COVERED † | usdz `loadUSDZ`, `parseUSDA`, `parseUSDC` (`packages/usdz/src/index.ts`) | Static subset. Native USDA (shared `readUSDA` in loaders) and native USDC Crate reader; no three.js. loaders also has `parseUSDA` and `parseUSDZ`. |
| PCDLoader, XYZLoader, VTKLoader | COVERED † | loaders `parsePCD`, `parseXYZ`, `parseVTK`, plus `parseOFF` | Legacy VTK only. |
| ColladaLoader | MISSING | — | |
| SVGLoader | MISSING | — | geometry has `Shape` and `extrudeGeometry`, but nothing parses SVG paths. |
| Long-tail model loaders (LDraw, VRML, 3DS, LWO, AMF, MD2, VOX, PDB, GCode, BVH motion capture, 3DM, KMZ, TDS) | MISSING | — | |
| Texture loaders (UltraHDR, TGA, DDS, KTX v1, TIFF, IES, LUT3dl, LUTImage) | PARTIAL | environment `decodeUltraHDR` | UltraHDR only, as an environment source. The rest are missing. |
| LUTCubeLoader | PARTIAL | tonemap `parseCube` (`packages/tonemap/src/cube.ts`) | 33³ LUTs only. |
| LoadingManager, Cache, progress events | PARTIAL | per-loader `AbortSignal` and byte caps (`packages/shared/loading.js`) | No shared manager or cache. Progress is reported only by machinery's CAD worker. |

### 11. Exporters

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| GLTFExporter | COVERED | exporters `exportModel` (`packages/exporters/src/model.ts`, also `@margoengine/exporters/model`) for gltf-pro models and materials meshes; `exportGLB`, `exportGLTF` (`gltf.ts`) for engine and data scenes | `exportModel`: options `binary`, `animations`, `onlyVisible`, `embedImages`, `maxTextureSize`; skins, morph targets and weights, clips, `EXT_mesh_gpu_instancing`, metallic-roughness/normal/occlusion/emissive maps, `KHR_texture_transform`, alpha modes and the `KHR_materials_*` gltf-pro draws. Round-trip tested through gltf-pro (DamagedHelmet, RobotExpressive, instanced grids) and the Khronos validator. No cameras or lights, no Draco/meshopt output. |
| OBJExporter, STLExporter, PLYExporter | COVERED † | exporters `exportOBJ` (with MTL), `exportSTL`, `exportPLY` | |
| USDZExporter | PARTIAL | exporters `exportUSDZ`, re-exported by usdz-export | Rejects textures, vertex colors and alpha masks. Hierarchy is baked. |
| DRACOExporter, EXRExporter, KTX2Exporter | MISSING | — | |

### 12. Animation

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| AnimationMixer, clip playback | COVERED | animation `Animation` (`packages/animation/src/index.ts`) | For glTF-pro models on WebGPU. One clip at a time unless animator is used. |
| Cross-fade, blending, additive layers | COVERED | animator `Animator`, `blend1D`, `blend2D` (`packages/animator/src/index.ts`) | Also has blend trees and state transitions. |
| SkinnedMesh, Skeleton, Bone | COVERED | animation compute skinning (`packages/animation/src/shader.ts`) | Four influences per vertex. Skins must come from glTF (or fbx, which converts to glTF). |
| Animated crowds (vertex animation textures; three.js has no built-in) | COVERED | animation `bakeVAT`, `VATCrowd` (`packages/animation/src/vat.ts`, entry `@margoengine/animation/vat`) | Clips baked on the CPU into an rgba32float texture; any number of instances in one instanced draw with per-instance matrix, clip, time offset, speed and atlas region. Opaque; no shadows, SSAO, clustered or IBL; no clip blending. |
| Morph targets | COVERED | animation morph compute, `setMorph` | Position, normal and tangent morphs. |
| KeyframeTrack, AnimationClip authored in code, PropertyBinding | PARTIAL | animation `sampleTrack`, `sampleTrackInto`; tween `Tween` | Clips come only from glTF node TRS and weights. No property tracks on arbitrary objects. |
| SkeletonUtils (clone, retarget), AnimationObjectGroup | MISSING | — | |
| IK (CCDIKSolver) | PARTIAL | animator `solveTwoBoneIK` and foot IK (`packages/animator/src/ik.ts`); machinery `Kinematics` | Analytic two-bone IK only. No general CCD chains. |

### 13. Post-processing

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| EffectComposer, or the WebGPU PostProcessing node chain | COVERED † | post `PostStack` (`packages/post/src/stack.ts`, entry `@margoengine/post/stack`) | One linear-HDR scene capture shared by its effects, run in array order: HDR effects (`SSAO`, `DOF`, `Bloom`, HDR `NodePass`), at most one display effect (`Tonemap` or creative `PostProcessing`), then LDR effects (`FXAA`, LDR `NodePass`); any other order throws. TAA wraps the stack. Alone, each effect still owns its capture and refuses the others. WebGPU only. |
| UnrealBloomPass | COVERED † | post `Bloom` (`packages/post/src/bloom.ts`) | One implementation since the dedupe: creative `PostProcessing` has no bloom; stack `Bloom` before it in a `PostStack`. Half-resolution 9-tap Gaussian with a hard threshold (no soft knee, no mip chain). |
| SSAOPass, SAOPass | COVERED † | post `SSAO` (`packages/post/src/ssao.ts`) | Normal-aware bilateral blur. Works under orthographic cameras and occludes environment IBL (diffuse and specular, same AO factor). |
| GTAOPass | MISSING | — | |
| SSRPass | MISSING | — | |
| SSGI, denoise | MISSING | — | |
| TAA (TAARenderPass, TRAA node) | COVERED † | taa `TAA` (`packages/taa/src/index.ts`) | Uses a velocity buffer and YCoCg clamping. |
| FXAA, SMAA | COVERED † | post `FXAA` (`packages/post/src/fxaa.ts`, entry `@margoengine/post/fxaa`) | FXAA 3.11-style, alone (it wraps any other effect) or last in a `PostStack`. SMAA is not provided. |
| BokehPass, DOF | COVERED † | dof `DOF` (`packages/dof/src/index.ts`); creative `focus` and `aperture` | |
| OutlinePass | COVERED † | selection `Selection` with jump flood or dilation (`packages/selection/src/index.ts`) | Core meshes, whole glTF-pro models or single glTF nodes (skinned buffers included), and materials meshes. Hidden (occluded) parts in dashed or dimmer lines with `xray` (OutlinePass `hiddenEdgeColor`), one `Selection` per set (`name`). Not drawn for LOD imposter levels. |
| FilmPass (grain) | COVERED † | creative `PostProcessing({grain})` | |
| GlitchPass | MISSING | — | |
| AfterimagePass | MISSING | — | |
| LUTPass | COVERED † | tonemap `setLUT` | 33³ `.cube` files only. |
| OutputPass, tone mapping | COVERED † | tonemap `Tonemap` | |
| God rays | PARTIAL | creative `atmosphere.godRays` (`packages/creative/src/post.ts`) | Screen-space, inside creative `PostProcessing`; combine with post Bloom or SSAO through a `PostStack`. |
| Motion blur | MISSING | — | taa already produces a velocity buffer. |
| Color correction, grading | COVERED † | creative `lift`, `gain`, `saturation`, `contrast`; tonemap `contrast` | |
| Simple screen effects (vignette, RGB shift or chromatic aberration, pixelation, halftone, dot screen, Sobel) | PARTIAL | shader `NodePass` with `inputColor`, `inputDepth`, `screenUV` (`packages/shader/src/post.ts`) | None is built in. Each is a few nodes in a `NodePass` (the shader README shows a vignette). transitions has chromatic displacement, but only as a scene-change wipe. |
| Lensflare | MISSING | — | |

### 14. Controls

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| OrbitControls, MapControls, TrackballControls, FlyControls, FirstPersonControls, PointerLockControls | COVERED † | controls (`packages/controls/src/orbit.ts`, `trackball.ts`, `fly.ts`, `first-person.ts`, `pointer-lock.ts`) | core also has `CADCameraControls`. No roll: Trackball stops short of the poles and Fly ignores Q and E. |
| TransformControls | COVERED † | controls `TransformControls` (`packages/controls/src/transform.ts`); gizmo re-exports it | |
| DragControls | COVERED | controls `DragControls` (`packages/controls/src/drag.ts`) | Core meshes and gltf-pro models, mouse and touch, view plane, world plane or axis, hover events; hits from the bvh `Raycaster`. No rotate mode or `transformGroup`. |
| ArcballControls | MISSING | — | |

### 15. Helpers

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| GridHelper, PolarGridHelper, AxesHelper, BoxHelper, Box3Helper, ArrowHelper, CameraHelper, PlaneHelper, VertexNormalsHelper | COVERED † | lines (`packages/lines/src/helpers.ts`) | WebGPU only. |
| Light helpers (Directional, Point, Spot, Hemisphere, RectArea) | MISSING | — | |
| SkeletonHelper | MISSING | — | |
| ViewHelper (examples) | COVERED | viewcube `ViewCube` (`packages/viewcube/src`) | CAD view cube: clickable faces, edges and corners, animated views, keyboard and screen-reader labels, perspective/orthographic toggle with cameras. DOM/CSS, so WebGPU and WebGL2. |

### 16. Interaction and spatial queries

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Raycaster | COVERED | bvh `Raycaster.intersectEngine`, `intersectObjects` (`packages/bvh/src/raycaster.ts`) | Core meshes and gltf-pro primitives (loaded models and materials meshes) with node transforms; model hits carry model, primitive, node and `uv`. Skinned and morphed primitives are hit in bind pose. LOD imposters hit their bounding sphere (`approximate: true`). Lines are never hit; points has its own `pickPoint`. |
| GPU picking | COVERED | core `engine.pick`; selection `Picking` (`packages/selection/src/picking.ts`) | Core meshes and gltf-pro models (deformed skinned buffers included); `picking.pick` names the model and primitive. LOD imposters pick their anchor approximately. Lines, points and splats are not pickable. WebGPU only. |

### 17. Special objects

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| InstancedMesh | COVERED | gltf-pro `PBRInstances` (`@margoengine/gltf-pro/instancing`, `packages/gltf-pro/src/instancing.ts`; apps that never instance do not load it) on any primitive, also from `EXT_mesh_gpu_instancing`; materials `createInstancedMesh` (`packages/materials/src/index.ts`); core automatic instancing of meshes that share a `Geometry` (`packages/core/src/engine.ts`); culling `CulledInstances`; animation `VATCrowd` | Textured: one draw for N instances of a primitive and material with `setMatrixAt`, `getMatrixAt`, `setColorAt`, per-instance atlas UV offset/scale (`setUVTransformAt`), `count` and `needsUpdate`; shadows, contact shadows, clustered, IBL, fog and SSAO see every instance; bvh `Raycaster` and selection `Picking` report `instanceId`. Real GPU: the instanced frame equals N meshes (`examples/package-benchmarks/results/textured-instancing-gpu.json`). No per-instance frustum culling or transparent sorting, and TAA gives instances camera motion only (`packages/gltf-pro/README.md`). Core instances keep constant colours; `ScatterInstances` still takes a constant `PbrMaterial`. WebGPU only. |
| BatchedMesh | MISSING | — | Each distinct geometry is its own draw call. materials atlases with geometry `mergeGeometries` bake static meshes into one draw. |
| LOD | COVERED | lod `LODSystem`, `Imposter` (`packages/lod/src/index.ts`, `imposter.ts`); scatter's GPU distance rings | Distance or screen-size levels with three.js hysteresis over core meshes, gltf-pro and materials models, geometry swaps and octahedral imposters (one instanced draw per atlas). Imposters pick approximately (bounding sphere) through bvh and selection, and cast or receive no shadows. Distance and screen levels also work on WebGL2. |
| Points | COVERED † | points `PointCloud`, `PointsPlugin` (`packages/points/src/cloud.ts`) | Block culling and point budgets. |
| Sprite | COVERED † | points `SpriteBatch` (`packages/points/src/sprites.ts`) | |
| Line, LineSegments, LineLoop, Line2 | COVERED † | lines `Lines`, `Line` | WebGPU only. |
| CSS2DRenderer, CSS3DRenderer | COVERED † | labels `LabelRenderer`, `Label`, `CSS3DObject` (`packages/labels/src/`); html `HTML` | html adds occlusion against scene depth. |
| Reflector, Refractor (planar mirror and glass) | MISSING | — | water does its own refraction. |
| Water, Water2 add-ons | COVERED † | water `Water` (`packages/water/src/index.ts`) | Gerstner waves, shallow-water flow, foam and spray. |
| Decals | MISSING | — | |
| MarchingCubes add-on | COVERED † | procedural `marchingCubes` (`packages/procedural/src/`) | Uses the `isosurface` dependency. |

### 18. Audio

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| AudioListener, Audio, PositionalAudio, AudioAnalyser, AudioLoader | COVERED † | audio `AudioListener`, `Audio`, `PositionalAudio`, `AudioAnalyser`, `loadAudioBuffer` (`packages/audio/src/`) | |

### 19. WebXR

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| WebXR VR (`renderer.xr`) | PARTIAL | xr `XR.requestSession('immersive-vr')` (`packages/xr/src/index.ts`) | Requires the native `XRGPUBinding` (WebGPU). Draws core meshes only; the README lists glTF-pro textures and skinning, advanced effects and a WebGL XR fallback as not implemented. Untested on physical headsets. |
| WebXR AR (hit test, anchors, plane detection, depth sensing, light estimation) | PARTIAL | xr `immersive-ar` session mode | No hit testing or AR helpers. |
| Controller and hand input poses | COVERED † | xr `XRController` (`packages/xr/src/controller.ts`) | Target-ray and grip poses, buttons, axes, 25 hand joints. |
| XRControllerModelFactory, XRHandModelFactory | MISSING | — | |

## Ranked gaps

Every MISSING or PARTIAL item, ordered by how often real three.js projects need it. **Fit** says where the work belongs under the v1.0 rule: core and the stage facade are frozen, and new capability goes into optional packages. "Freeze conflict" marks items that cannot be done cleanly without a core change. Gaps closed since the first version of this list (materials and textures for your own meshes, glTF extension and decoder wiring, picking loaded models, IBL that applies itself, a background color, combinable effects, the orthographic camera, FXAA, the math library, DragControls, scene fog, UltraHDR, LOD, node materials and compute) are no longer listed.

### High

1. **WebGL2 fallback beyond core.** A three.js replacement has to reach browsers and devices without WebGPU. Today the fallback draws flat-shaded core meshes; no textures, models or effects.
   **Fit:** extend each rendering package with a GL path, starting with gltf-pro and materials. This is a large effort and a strategic decision rather than one package.
2. [DONE: environment `TransparentCanvas`, zero core bytes] **Transparent canvas** (`alpha: true`). Standard for embeds over page content.
   **Fit:** freeze conflict: needs `alphaMode` and a transparent clear in core's context setup. Small.
3. **More than one directional light, a colored ambient light, and a configurable HemisphereLight.** Key, fill and sky lighting is common.
   **Fit:** extend clustered (directional entries), and environment for hemisphere or colored ambient through the same `margoAmbient` shader hook `EnvironmentLighting` uses. Core's single-light uniform is frozen.
4. [DONE] **Point and spot light shadows**: clustered `LocalShadows` (`@margoengine/clustered/shadows`), cube faces for point lights and a perspective map for spot lights in one texture array, cached per light (PointLight shadows and SpotLight shadows rows).
   **Left:** per-light caster culling, `drawShadow` casters (terrain, scatter), soft (PCSS) local shadows.
5. [DONE] **Textured instancing** (InstancedMesh with a textured material, glTF `EXT_mesh_gpu_instancing`): gltf-pro `PBRInstances` and materials `createInstancedMesh`, one draw for N instances (InstancedMesh row).
   **Left:** per-instance frustum culling, sorting transparent instances, `ScatterInstances` with textured materials.
6. **Remaining glTF extensions.** `KHR_animation_pointer`, `KHR_materials_iridescence`, `anisotropy`, `dispersion` and `variants`, refracting transmission, and applying glTF cameras. Files that require them are rejected.
   **Fit:** extend gltf-pro (and animation for the pointer).
7. **MeshPhysicalMaterial on meshes you build, and real transmission.** Product configurators depend on clearcoat, sheen and glass that refracts.
   **Fit:** extend materials with physical options over gltf-pro's physical shader variant; refraction needs a scene-color copy, which post's stack already captures.
8. **Second UV set, geometry groups and custom attributes on your own meshes.** Light maps and AO maps use `uv1`, multi-material meshes use groups, and custom shaders read their own attributes.
   **Fit:** extend materials (gltf-pro's vertex already holds a second UV set; groups become several primitives). Custom attributes need a vertex-layout option in gltf-pro.
9. **ShadowMaterial (shadow catcher).** Product shots on a page background use it. The contact-shadow case is done
   (`@margoengine/staging` `ContactShadows`); catching the directional light's cascade shadows is not.
   **Fit:** extend shadows, or a materials shading mode that samples the cascades.
10. [DONE] **glTF export with animation.** exporters `exportModel`: clips, skins, morphs, instancing, PBR textures and
    KHR material extensions from gltf-pro models and materials meshes (GLTFExporter row).
    **Left:** cameras and lights, Draco/meshopt output.

### Medium

11. **Render-to-texture from a second camera, CubeCamera, multiple viewports, several scenes.** Used for minimaps, mirrors, portals and split screen.
    **Fit:** freeze conflict, because core owns one camera and one pass graph. Consider for core v1.x.
12. **Clipping planes on models and textured meshes.** CAD and BIM viewers section everything, not only core meshes.
    **Fit:** extend machinery sections to gltf-pro primitives (a discard plus caps), or a materials option over shader's `discard`.
13. **OBJ with MTL and UVs.** Still a very common interchange format.
    **Fit:** move OBJ into loaders, add MTL and feed materials.
14. **SVGLoader.** Extruded logos and icons are common on marketing sites.
    **Fit:** extend loaders (geometry already has `Shape` and `extrudeGeometry`).
15. **Node materials and custom shaders, completed.** Statement-level `If`, workgroup memory, light and shadow nodes, node offsets seen by shadows and SSAO, MRT outputs, and a raw WGSL material with its own vertex layout.
    **Fit:** extend shader.
16. **WebXR completeness** (glTF-pro and skinning in XR, controller and hand models, AR hit test).
    **Fit:** extend xr.
17. **Programmatic keyframe tracks, SkeletonUtils retargeting, general CCD IK.**
    **Fit:** extend animation and animator.
18. **Lambert, Phong, depth and distance materials, per-material toon, back-side-only rendering, polygonOffset and stencil.**
    **Fit:** extend materials.
19. **Standalone compressed and data textures.** KTX2 files on materials meshes, float and single-channel `DataTexture`, `Data3DTexture`, `DataArrayTexture`, cube maps as a material input.
    **Fit:** extend materials (accept a decoders `GPUTexture` and more formats).
20. **RectAreaLight.** Archviz and product lighting.
    **Fit:** extend clustered (LTC).
21. **Decals, Reflector and Refractor, and the missing geometries** (DecalGeometry, ConvexGeometry, RoundedBoxGeometry, ParametricGeometry).
    **Fit:** extend geometry; a planar reflector needs a second camera (gap 11).

### Low

22. **SSR, GTAO, SSGI, motion blur.**
    **Fit:** extend post. taa's velocity buffer already exists.
23. **SMAA and built-in screen effects** (vignette, RGB shift, pixelation, halftone, dot screen, Sobel, glitch, afterimage). A shader `NodePass` makes most of them in a few lines; afterimage also needs a history target.
    **Fit:** one small new `@margoengine/fx` package of `NodePass` presets.
24. **Lensflare, and god rays outside creative.**
    **Fit:** extend post or sky.
25. **TextGeometry and fonts.** SDF text covers most text needs.
    **Fit:** extend geometry (font to `Shape`).
26. **Collada and the long-tail loaders** (LDraw, VRML, 3DS, and so on).
    **Fit:** extend loaders when a user asks.
27. **Texture loaders** (TGA, DDS, KTX v1, TIFF, IES, other LUT formats and sizes).
    **Fit:** extend decoders, loaders or tonemap.
28. **BatchedMesh.**
    **Fit:** freeze conflict (core batching). Revisit in v1.x; atlases plus `mergeGeometries` cover static scenes.
29. **Light and skeleton helpers.**
    **Fit:** extend lines.
30. **Layers for rendering.**
    **Fit:** freeze conflict, small.
31. **Physical light units, IES and projector lights.**
    **Fit:** extend clustered.
32. **ArcballControls, roll in the controls, StereoCamera and anaglyph.**
    **Fit:** extend controls (core's `camera.up` already allows roll); new package for stereo.
33. **Draco, EXR and KTX2 exporters, and USDZ export with textures.**
    **Fit:** extend exporters.
34. **Placed light probes.**
    **Fit:** extend environment.
35. **LoadingManager and progress events.**
    **Fit:** extend `shared/loading`.
36. **Display-P3 or HDR canvas output, and a ColorManagement API.**
    **Fit:** freeze conflict.
37. **A wireframe material flag.**
    **Fit:** extend materials (geometry `wireframe` plus lines works today).

Two scaling notes from reading core (not measured):

- **Instance buffer size.** Each unique core `Geometry` keeps an instance buffer sized to the meshes that use it, doubling as it grows: 96 bytes per instance on the GPU and the same on the CPU (`Engine.retain` in `packages/core/src/engine.ts`). The earlier per-geometry allocation of the full entity capacity is gone.
- **Geometry and entity caps.** Core caps `Geometry` at 1,000,000 vertices and engines at 100,000 entities (default capacity 1,024). three.js has neither limit. Materials meshes share the 1,000,000-vertex cap.

## Margo extras

These are not in three.js core or its official add-ons. Many have third-party three.js equivalents (noted), which matters for an honest comparison page.

- **Rendering:** cascaded PCSS shadows with a static-caster cache (shadows); clustered forward lighting for up to 1,024 lights (clustered); TAA with motion vectors (taa); Gaussian splats with GPU covariance projection, radix sort and spherical harmonics up to degree 3 (splats; cf. third-party splat viewers); geometry-clipmap terrain with triplanar layers (terrain); GPU particles up to 1,000,000 with obstacles, sorting and sprites (vfx; creative `GPUParticles` is a preset of it); a 100k-blade grass field and a planet renderer (creative); physical day sky plus a stylized night with stars and a phased moon (sky; scenery `SkyMoon` is a preset of it); scene transitions (transitions); GPU scatter with distance LOD (scatter); GPU-driven frustum and Hi-Z occlusion culling with order-preserving compaction and indirect draws for static assemblies (culling); octahedral imposters (lod); vertex animation texture crowds (animation); device-loss recovery that rebuilds every plugin (`Engine.rebootDevice`).
- **Simulation and gameplay:** Rapier physics with a character controller (physics; cf. cannon-es or Rapier bindings); Recast/Detour navigation (navigation) and a dependency-free navmesh with A*, funnel paths and ORCA avoidance (navmesh; cf. three-pathfinding); sparse-set ECS (ecs); hierarchical state machine (fsm); snapshot interpolation for networking (net); semantic input with gamepad and haptics (input); tweening (tween); damped camera follow and shake (cinematic); animator blend trees and foot IK (animator).
- **Content generation:** procedural cabins, trees, rocks, humanoids, marching cubes and noise (procedural); 3D wave function collapse (wfc); spline roads (road); arc-length splines (splines).
- **Engineering and BIM:** STEP and IGES import through an OCCT worker, kinematics, capped section planes, metrology and exploded views (machinery); IFC through `web-ifc` (ifc).
- **Tooling and integration:** React bindings (react; cf. react-three-fiber); triangle BVH with a worker build (bvh; cf. three-mesh-bvh); SDF text from any browser font (text; cf. troika-three-text); entity inspector (inspector); Blender `.margo` offline asset pipeline (blender); Rust/Wasm transform and culling kernel (kernel); CAD camera controls and `fitToBoundingBox` in core.

Positioning caveats for a public page:

- fbx and usdz used to run three.js code at runtime (`FBXLoader` and `GLTFExporter`; the USDA and USDC parsers). Both now have native parsers; three.js is only a test-time reference.
- Several capabilities exist twice. html and labels both export `CSS3DObject`. gizmo and usdz-export are pure re-exports. Two toon paths and two navigation packages remain. The particle, bloom and sky duplicates were merged (2026-10-14): vfx is the one particle system (creative `GPUParticles` is a preset over it), post `Bloom` the one bloom (creative `PostProcessing` lost its bloom), and sky the one sky (scenery `SkyMoon` is a preset; `SkyMoonPass`, `NightAtmosphere` and creative's `atmosphere.sky` backdrop were removed). The merge shrank the five packages' root entries; Night Citadel and Afterlight load a few kB more gzip because they now use the fuller single sky and particle implementations (measured locally at the time; that measurement was not committed).
- Most COVERED rows outside core need WebGPU. Against three.js's WebGL renderer, Margo's WebGL2 reach is core meshes only.

## How this was checked

- **Reading only.** This matrix comes from reading source code. No build, test, benchmark or browser was run while writing it, so no row is a statement that a feature works at runtime.
- **Line-by-line reading.** Core and the stage facade were read in full (`packages/core/src/*.ts`, `packages/margoengine/src/index.ts`). So were the gltf loader and most of gltf-pro, plus the parts of animation, animator, fbx, toon, the React environment adapter, the bvh raycaster, machinery's OBJ parser and creative's targets that the rows cite.
- **Re-audit, 2026-10-14.** Every row was re-checked against `perf/auto-quality` at commit 2c53227: each package's README, `src/index.ts` and package.json `exports`. Read line by line in this pass: materials `src/index.ts`, core `camera.ts` and the instance sizing in `engine.ts`, gltf-pro's extension handling (`asset.ts`, decoder hooks) and post's `PostStack` order rules (`stack.ts`). The table then held 156 rows (texture transforms, VAT crowds and ViewHelper had been added to the original 153); the earlier summary still read 65 / 43 / 45. Since then: InstancedMesh PARTIAL -> COVERED (textured instancing), glTF export with animation PARTIAL -> COVERED, PointLight and SpotLight shadows MISSING -> COVERED (`@margoengine/clustered/shadows`, run on a real GPU): 87 / 39 / 30.
- **Rows marked †.** For these, the evidence is that the named exports exist, the source is non-trivial, the package README describes the behavior, and keyword searches across `packages/*/src` agree. The implementation itself was not audited line by line.
- **MISSING.** A row is MISSING when no matching class, function or keyword was found in any package's `src/`. README files and tests were not counted as implementation.
- **The three.js side.** The feature list comes from knowledge of three.js r186, its documentation (<https://threejs.org/docs/>) and `three/addons`. It was not re-checked against the r186 tag while writing.
- **Re-checking.** When a gap is closed, update its row, the counts in the Summary and the Ranked gaps, and the "Not yet" table in [`from-threejs.md`](from-threejs.md).
