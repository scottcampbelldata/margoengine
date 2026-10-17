# three.js r186 parity matrix

What Margo Engine covers compared with three.js r186 and its common add-ons (`three/addons`). It is meant for roadmap planning and as the source for a public comparison page. Every COVERED or PARTIAL claim names the Margo package, the export, and the file where the code lives.

## Summary

159 three.js features in 19 areas (recounted from the rows 2026-10-16; 51 of the COVERED rows are marked †):

| Status | Count | Meaning |
| --- | --- | --- |
| COVERED | 95 | A Margo package implements the feature in a form a three.js user would accept as equivalent (limits noted). |
| PARTIAL | 39 | Some of it exists, but a common use case is missing. The notes say what. |
| MISSING | 25 | No implementation was found in any package's `src/`. |

Overall: Margo is strong where three.js relies on third-party libraries or examples. That includes cascaded PCSS shadows, clustered lighting, TAA, Gaussian splats, BVH queries, physics, navigation, terrain, water and sky. The day-one basics the first version of this matrix found missing (textures and materials on meshes you build, glTF extensions and compression, an orthographic camera, picking loaded models, image-based lighting outside React, combinable effects, FXAA, a math library) now exist as optional packages. What remains:

- **WebGL2 reaches core meshes only.** The fallback is the optional `@margoengine/webgl` package and draws core meshes flat-shaded with one light. Textures, glTF-pro models, shadows, post-processing, lines, points, text and most other rendering packages need WebGPU.
- **Lighting is thin outside clustered point and spot lights.** One directional light per engine; core diffuse ambient has RGB multipliers, while glTF-pro keeps its fixed hemisphere fill. Point and spot lights cast shadows through `@margoengine/clustered/shadows` (up to 16 shadowed lights). Rectangle area lights (`@margoengine/clustered/area`) are unshadowed.
- **Core owns one canvas, one primary camera and one pass graph.** `Engine.render({camera})` supports a sequential alternate view and restores primary culling. Core draw calls accept viewport/scissor rectangles. CubeCamera, mirror helpers, independent temporal histories and general multi-scene rendering remain absent. The implemented hooks and remaining package work are listed [below](#what-is-missing-or-partial-and-what-to-do).
- **Materials on meshes you build are standard, physical, basic, normal and matcap.** Physical factors cover clearcoat, sheen, specular, IOR, transmission with screen-space refraction through `@margoengine/materials/transmission`, volume, anisotropy and iridescence. glTF loads the same lobes, with iridescence, anisotropy and diffuse transmission through `@margoengine/gltf-pro/extended`. Dispersion is absent. Lambert, Phong, depth and shadow-catcher materials are absent. Materials meshes now accept independent UV1 coordinates and geometry groups with material arrays.
- **glTF coverage has gaps.** `KHR_animation_pointer` and dispersion are rejected when required (iridescence, anisotropy and diffuse transmission through `@margoengine/gltf-pro/extended`, and material variants, are supported since HANDOFF 5w.e). Export writes no cameras or lights.
- **Post-processing lacks GI.** No GTAO, SSGI, motion blur, SMAA or lens flare; screen-space reflections (`SSR`) cover core meshes and added glTF-pro/materials models, not water or terrain, and no built-in screen effects (a shader `NodePass` makes one in a few lines).

Legend. A **†** marks rows where the evidence is the exported symbols, the package README and a non-trivial amount of source code, not a line-by-line read. See [How this was checked](#how-this-was-checked). Rows that work only on WebGPU say "WebGPU only" in their notes.

## Matrix

### 1. Core objects and scene graph

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Object3D transforms and hierarchy (position, rotation, quaternion, scale, parent, visible, name) | COVERED | core `Engine.createMesh`, `Mesh.setParent`, `setQuaternion` (`packages/core/src/engine.ts`) | Parent depth of 64 or less. Entity slots grow on demand up to 8,388,608 per engine (`packages/core/src/kernel.ts`). No `children`, `traverse`, `userData`, `lookAt` or `getWorldPosition`; world matrices are reachable only through `core/extension`. |
| Group (transform-only node) | COVERED | core mesh with no geometry | glTF importers use this pattern. |
| Scene object, multiple scenes | PARTIAL | one `Engine` = one canvas = one implicit scene | No Scene object. A second scene needs a second engine and canvas. |
| `scene.background` (color, texture, cubemap) | COVERED † | environment `EnvironmentBackground`, `Skybox` (`packages/environment/src/background.ts`), `ColorBackground` (`color.ts`, solid or vertical gradient); sky `Sky` | Core's clear color stays hard-coded; `ColorBackground` covers it with a pass on cleared depth. `TransparentCanvas` provides transparency without a core change (next row). WebGPU only. |
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
| Render targets / render-to-texture | PARTIAL | creative `HDRRenderTarget` (`packages/creative/src/targets.ts`); core `Engine.render({camera})` (`packages/core/src/engine.ts`) | Sequential captures can use another camera and then restore the primary view. There is one implicit scene, no nested render, and no dedicated multi-view capture helper. Camera aspect follows the canvas unless its projection overrides it. |
| Multiple render targets (MRT) | PARTIAL | `DrawOptions.colorAttachments` (`packages/core/src/plugin.ts`) | Low-level only. selection uses it for its ID buffer. Node materials have no MRT outputs. |
| Clipping planes | PARTIAL | machinery `SectionPlanes`, `boxSection` (`packages/machinery/src/section.ts`); shader `discard` | Six planes with stencil caps, core meshes only. A `NodeMaterial` can slice materials meshes with `discard(positionWorld…)`, but shadows still see the whole surface and nothing caps the cut. No per-material `clippingPlanes` on glTF-pro models. WebGPU only. |
| Stats, GPU timing | COVERED † | stats `Stats`, `GPUProfiler` (`packages/stats/src/`); inspector `FrameDebugger` (`packages/inspector/src/frame.ts`) | Uses timestamp queries (request `features: ['timestamp-query']` at engine creation). `FrameDebugger.capture()` is the `renderer.info` / Spector.js counterpart: per-pass draws, pipelines, bindings, targets, GPU time and memory as JSON. |
| Multiple viewports / scissor | PARTIAL | core `DrawOptions.viewport`, `scissor` (`packages/core/src/plugin.ts`, `renderer.ts`); webgl `GLRenderer` (`packages/webgl/src/index.ts`) | Independent top-left pixel rectangles per core draw. Later subviews use `clear:false`; clears still cover the whole attachment. Optional native passes and picking do not inherit rectangles, and projection aspect is caller-controlled. |

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
| BufferGeometry custom attributes (uv, uv1, color, tangent) on drawable meshes | PARTIAL | materials `createMesh`, `createInstancedMesh`, `packGeometry` (`packages/materials/src/built-material.ts`); core `Geometry` (`packages/core/src/geometry.ts`) | Materials meshes take `uvs`, independent `uvs1`, `tangents` and `colors` (RGB or RGBA) into gltf-pro's 80-byte vertex. UV1 defaults to UV0 when omitted. `groups` with a material array become separate primitives under one model/root, sharing vertices and instances; glTF export retains UV1 and group materials. Arbitrary named attributes still cannot reach a shader. Core geometry stays position, normal and index only, up to 1,000,000 vertices. |
| BufferGeometryUtils (merge, mergeVertices, toNonIndexed, computeTangents, computeVertexNormals) | COVERED † | geometry `mergeGeometries`, `mergeVertices`, `toNonIndexed`, `computeTangents`, `computeVertexNormals` (`packages/geometry/src/utils.ts`) | |
| TextGeometry, FontLoader, TTFLoader | MISSING | — | SDF text is covered separately; see [Margo extras](#margo-extras). |
| ConvexGeometry, DecalGeometry, RoundedBoxGeometry, ParametricGeometry | MISSING | — | physics computes convex hulls for colliders only. |

### 5. Materials

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| MeshStandardMaterial, constant factors | COVERED | core `PbrMaterial` (`packages/core/src/geometry.ts`); materials `Material` (`packages/materials/src/index.ts`) | Core: color, roughness, metalness and doubleSided, alpha must be 1; live in place through `material.set({...})` (next frame, no pipeline or bind group rebuild). Materials: live color, emissive, roughness, metalness and opacity. |
| MeshStandardMaterial with maps (map, normalMap, roughness/metalness map, aoMap, emissiveMap) | COVERED | materials `Material`, `Texture`, `loadTexture`, `createMesh` (`packages/materials/src/index.ts`); gltf-pro `PBRModel` for loaded assets | `map`, `metalRoughnessMap` (glTF packing), `normalMap` with `normalScale`, `aoMap` with intensity, `emissiveMap`; map slots are live. Maps affect the lit colour only: SSAO normals ignore `normalMap`, and shadows ignore `map` alpha. No `displacementMap`, `bumpMap`, `lightMap`, `alphaMap` or per-material `envMap`. WebGPU only. |
| MeshPhysicalMaterial (clearcoat, sheen, transmission, iridescence, anisotropy, IOR, specular, dispersion) | PARTIAL | materials `Material` physical options and `Transmission` (`packages/materials/src/index.ts`, `transmission.ts`); gltf-pro `KHR_materials_clearcoat`, `sheen`, `transmission`, `volume`, `ior`, `specular`, and with `@margoengine/gltf-pro/extended` `iridescence`, `anisotropy`, `diffuse_transmission` (`packages/gltf-pro/src/index.ts`, `shader.ts`, `extended.ts`; `tests/materials-ext.test.js`, `scripts/gltf-pro-materials-gpu-check.js`) | On your own meshes and from glTF, one shader (a materials sphere and the same glTF material render identically on a real GPU). Transmission refracts the scene (screen space: mip blur by roughness, Beer-Lambert volume) with `transmission.add(model)`, otherwise tints the background; clearcoat and sheen take only the key light and hemisphere fill. Physical options are factors only (no maps). Iridescence and anisotropy factors also work on meshes you build; diffuse transmission is glTF-only. Clustered lights skip the thin film and anisotropy. No dispersion. |
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
| AmbientLight | PARTIAL | core lighting `radiance[3]` and `ambient` RGB (through `core/extension`, `packages/core/src/renderer.ts`, `shaders.ts`) | Scalar intensity times linear RGB and diffuse albedo on core shader paths, including WebGL preview. It does not apply to metals. Independent glTF-pro/terrain/VAT material shaders retain their own lighting models; environment `EnvironmentLighting` replaces core ambient with IBL. |
| HemisphereLight | PARTIAL | fixed sky/ground gradient in gltf-pro's ambient term (`packages/gltf-pro/src/shader.ts`, line 61) | Not configurable. Core meshes use the flat ambient. |
| DirectionalLight | PARTIAL | core lighting `direction` and `radiance` (`packages/core/src/engine.ts`, through `core/extension`) | Exactly one per engine, and not on the public `EngineKernel` type. |
| PointLight | COVERED † | clustered `Clustered.setLights` (`packages/clustered/src/index.ts`) | Up to 1,024 lights, WebGPU only; shadows with `castShadow` and `@margoengine/clustered/shadows` (see Shadows). Core meshes receive them automatically; glTF-pro models, materials meshes and terrain need `add()`. glTF `KHR_lights_punctual` lights come from `model.clusteredLights()`, or all of a file's lights (the directional one onto the engine light) in one call with gltf-pro's `applyGLTFLights(model, {clustered})`. |
| SpotLight | COVERED † | clustered `Clustered.setLights` with inner and outer cone | Shadows as for PointLight. No projected `map`. |
| RectAreaLight | COVERED | clustered `AreaLights`, entry `@margoengine/clustered/area` (`packages/clustered/src/area.ts`) | Up to 64 rectangles (position, `direction`, optional `up`, width, height, colour, `intensity` in radiance, `twoSided`), shaded with linearly transformed cosines: GGX specular and Lambert diffuse, each quad clipped exactly to the surface's horizon. Core meshes and every `lights.add()` receiver (glTF-pro models, materials meshes, terrain). Every fragment evaluates every area light (no culling). No shadows from area lights. WebGPU only. |
| LightProbe | COVERED | environment `LightProbes`, entry `@margoengine/environment/probes` (`packages/environment/src/probes.ts`); one global probe from the environment map as before (`environment.sh`) | Placed probes baked from the scene on the GPU: an irradiance volume (up to 4,096 L1/L2 SH probes, trilinear) and up to 16 box-projected reflection probes, as the ambient term of core meshes and of glTF-pro, materials and terrain receivers (real-GPU checked, `results/probes-gpu.json`). Static: re-bake on change; no per-probe visibility. |
| IESSpotLight, ProjectorLight | MISSING | — | |
| Physical light units (candela, lux) | MISSING | — | Intensities are unitless radiance scales. |

### 8. Shadows

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Directional light shadows (incl. CSM add-on, PCF/PCFSoft) | COVERED † | shadows `Shadows` (`packages/shadows/src/index.ts`, `cascades.ts`) | Four cascades, PCSS, and a cache for static casters. WebGPU only. Core meshes are shadowed automatically; glTF-pro models (including skinned and morphed ones, cast in their animated pose, and materials meshes), VAT crowds, terrain and scatter need `add()`. Without `distance` and with only core-mesh casters the cascades fit the scene's meshes. Goes beyond three core. |
| PointLight shadows | COVERED | clustered `LocalShadows`, entry `@margoengine/clustered/shadows` (`packages/clustered/src/shadows.ts`) | Lights with `castShadow` get six cube-face layers in one depth texture array (`maxLights` 1-16, default 4; `resolution` default 512), 3x3 PCF, texel-scaled normal and light-direction bias. Casters: core meshes, glTF-pro models, materials and instanced meshes via `add()`; receivers are whatever clustered lights. Maps re-render only when their light or a caster changes (`{dynamic: true}` for skinned casters). Not drawn: terrain/scatter `drawShadow` casters. Real-GPU check and costs: `examples/package-benchmarks/local-shadows-gpu.mjs`. WebGPU only. |
| SpotLight shadows | COVERED | clustered `LocalShadows` (as above) | One perspective layer over the outer cone per light; same filtering, bias, casters and caching as point lights. |

### 9. Environment, fog and color

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| HDRLoader / RGBELoader | COVERED † | environment `parseHDR`, `loadEnvironmentImage` (`packages/environment/src/hdr.ts`) | |
| EXRLoader | COVERED † | environment `parseEXR` (`packages/environment/src/exr.ts`) | Single-part scanline files with NONE, RLE, ZIPS, ZIP or PIZ compression. |
| PMREMGenerator, `scene.environment` (IBL) | COVERED † | environment `Environment`, `EnvironmentLighting` (`packages/environment/src/lighting.ts`) | `EnvironmentLighting.attach(engine, ...)` patches core's mesh shader through `PassContext.shader`; `lighting.add(model)` lights glTF-pro models. IBL replaces the constant ambient term, and post's SSAO occludes it. glTF-pro's clearcoat and sheen layers keep the hemisphere ambient. WebGPU only. |
| Fog, FogExp2 | COVERED † | environment `Fog` (linear, exp2, height); sky `fog` option (exp or exp2, height gain, sky-radiance or fixed colour); creative `PostProcessing` `atmosphere` (exponential height fog in its grading pass) | `Fog` runs in core's and glTF-pro's mesh shaders, so blended glTF primitives are fogged. Particles, VFX and splats are not. |
| Volumetric fog and light shafts (`VolumeNodeMaterial`, `webgpu_volume_lighting`) | COVERED | environment `VolumetricFog` (`packages/environment/src/volumetric.ts`, entry `@margoengine/environment/volumetric`) | Froxel grid (default 160 x 90 x 64) lit by the sun through shadows' cascades and by clustered point and spot lights with their `LocalShadows`; height falloff and noise, temporal reprojection, composited over opaque surfaces and the sky (perspective and orthographic, 1x/4x MSAA). Replaces `Fog` and sky fog rather than adding to them. Needs a post capture or a depth texture; transparent surfaces and particles drawn after it are not fogged. WebGPU only. |
| Sky add-on | COVERED † | sky `Sky` with Preetham and Bruneton models (`packages/sky/src/`) | Adds clouds, sun, moon and stars. |
| Tone mapping (`renderer.toneMapping`) | COVERED † | core fixed Reinhard; gltf-pro ACES; tonemap `Tonemap` with AgX, ACES fitted and Khronos Neutral (`packages/tonemap/src/index.ts`) | |
| Color management (sRGB input, linear workflow, `outputColorSpace`) | PARTIAL | core converts hex sRGB to linear and encodes sRGB output; math `Color` stores linear sRGB; environment `ColorOutput` (`packages/environment/src/output.ts`) for Display P3 and HDR (`toneMapping: 'extended'`) canvases | No ColorManagement API (no P3 input colours or textures: the working space is linear sRGB). `ColorOutput` (zero core bytes, only where the display reports P3 / HDR): sRGB content looks the same on the P3 canvas; colours outside sRGB and highlights above white come from Tonemap only (environment README). |
| Exposure, physical camera parameters | COVERED † | `exposure` in stops on tonemap and Bloom; dof `focalLength` and `aperture` (f-number) | |

### 10. Loaders

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| GLTFLoader: static textured PBR | COVERED | gltf-pro `loadGLTF`, `parseGLTF`, `parseGLTFAsync` (`packages/gltf-pro/src/index.ts`); gltf `loadGLTF` with constant colors, works on WebGL2 (`packages/gltf/src/index.ts`) | Metallic-roughness, MASK and BLEND, normal, occlusion and emissive maps, two UV sets, vertex colors. WebGPU only. |
| GLTFLoader: animations, skins, morph targets | COVERED | animation `Animation.attach` (`packages/animation/src/index.ts`) | STEP, LINEAR and CUBICSPLINE interpolation. |
| Progressive / streamed glTF loading (no three.js counterpart: `GLTFLoader` resolves once the whole file is parsed; third-party progressive loaders exist) | COVERED | gltf-pro `loadGLTFProgressive` (`@margoengine/gltf-pro/progressive`, `packages/gltf-pro/src/progressive.ts`, `stream.ts`) | `ready` gives the model as one box per primitive (bounds valid, camera can fit and orbit), then geometry streams in by screen size and visibility over HTTP range requests (whole-file streaming without range support), then textures, uploads within a per-frame budget; `complete` is byte-identical on the GPU to `loadGLTF` (unit test). Network and decode in a worker. No `MSFT_lod`, no low-res mip first; Draco/meshopt/KTX2 fall back to `loadGLTF`. WebGPU only. |
| glTF extensions (KHR_materials_*, KHR_texture_transform, KHR_lights_punctual, KHR_mesh_quantization, EXT_mesh_gpu_instancing, KHR_animation_pointer) and glTF cameras | PARTIAL | gltf-pro supported set (`packages/gltf-pro/src/asset.ts`, line 14) | Read: `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `unlit`, `clearcoat`, `transmission`, `ior`, `volume`, `sheen`, `specular`, `iridescence`, `anisotropy`, `diffuse_transmission` (with `decoders.materials` from `@margoengine/gltf-pro/extended`), `variants` (`model.variants`, `model.selectVariant`), `KHR_lights_punctual` (as data, `clusteredLights()` and `applyGLTFLights`), `EXT_texture_webp`, `EXT_texture_avif`, `EXT_mesh_gpu_instancing` (one instanced draw per primitive with `decoders.instancing` from `@margoengine/gltf-pro/instancing`, see InstancedMesh), and the three compression extensions below with a decoder. A file that requires anything else throws, naming it: `KHR_animation_pointer` and `KHR_materials_dispersion` are among those. glTF cameras are exposed as `model.cameras` data; `viewGLTFCamera(model, index)` views through one (perspective or orthographic). POINTS and LINES primitives draw as point and line lists (`model.pointsAndLines`). |
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
| LoadingManager, Cache, progress events | PARTIAL | per-loader `AbortSignal` and byte caps (`packages/shared/loading.js`); cache `AssetCache` (`packages/cache/src/index.ts`) | Cache: persistent IndexedDB with ETag/Last-Modified revalidation, offline fallback, range requests and LRU eviction, passed to every loader as its `fetch` option (goes beyond three's in-memory `THREE.Cache`). No shared loading manager. Progress is reported only by machinery's CAD worker. |

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
| Animated crowds (vertex animation textures; three.js has no built-in) | COVERED | animation `bakeVAT`, `VATCrowd` (`packages/animation/src/vat.ts`, entry `@margoengine/animation/vat`) | Clips baked on the CPU into an rgba32float texture; any number of instances in one instanced draw with per-instance matrix, clip, time offset, speed and atlas region. Opaque; casts and receives `Shadows` (`shadows.add(crowd)`) and takes `EnvironmentLighting` IBL (`lighting.add(crowd)`); no SSAO or clustered lights; no clip blending. |
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
| SSRPass | PARTIAL | post `SSR` (`packages/post/src/ssr.ts`, entry `@margoengine/post/ssr`) | HDR `PostStack` effect (or `SSR.attach` alone): Hi-Z ray march, roughness blur and fade, replaces `EnvironmentLighting`'s specular where rays hit and keeps it where they miss; perspective and orthographic; works with TAA. Core meshes (`PbrMaterial`) and glTF-pro models / materials meshes added with `ssr.add(model)` (their own maps, alpha mask, instances, skinning, through gltf-pro's capture hook) show reflections; water, terrain and other custom shaders are reflected but do not reflect. WebGPU only. |
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
| God rays | COVERED | environment `VolumetricFog` with `shadows` (`packages/environment/src/volumetric.ts`); creative `atmosphere.godRays` (`packages/creative/src/post.ts`) | World-space shafts through real occluders from the sun's cascades (and from clustered spot and point lights). creative's screen-space version stays inside its `PostProcessing`. WebGPU only. |
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
| Decals | COVERED | post `Decals`, entry `@margoengine/post/decals` (`packages/post/src/decals.ts`) | Screen-space projected decals (box projector, depth-reconstructed, normal-angle fade, one texture atlas; multiply or over), up to 4,096; needs a post capture for scene depth. Colour only. DecalGeometry itself (mesh decals) is not provided. Real-GPU checked (`results/decals-gpu.json`). |
| MarchingCubes add-on | COVERED † | procedural `marchingCubes` (`packages/procedural/src/`) | Own marching tetrahedra (closed indexed mesh, no dependency) behind the same `marchingCubes` call. |

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

## What is missing or partial, and what to do

Recounted from the rows: 39 PARTIAL, 25 MISSING. COVERED rows stay in the matrix above. The three approved core hooks below measure **20,641 bytes gzip**, against a clean 20,282-byte baseline: +359 bytes, with 4,358 usable bytes below the exclusive 25,000-byte ceiling. Reproduce with `npm run measure:size`; build and GPU evidence is recorded in [the verification note](core-parity-hooks-verification.md).

The user approved these three hooks as a specific exception to the core freeze. Their larger features stay in optional packages.

| Order | Implemented core hook | What it enables | Remaining limit |
| --- | --- | --- | --- |
| 1 | `Engine.render({camera})` selects a camera for one call and restores primary culling, batches and statistics. | Sequential second-camera captures through the existing `HDRRenderTarget`. | No nested frame graph, separate scene, CubeCamera or Reflector implementation. |
| 2 | `Lighting.ambient` supplies linear RGB multipliers; `radiance[3]` keeps its scalar intensity. The canonical frame grows from 112 to 128 bytes with its old prefix preserved. | Colored diffuse ambient on core shader paths and the WebGL preview. | Independent optional material models retain their own ambient APIs. A hemisphere remains an environment feature. |
| 3 | `DrawOptions.viewport` and `scissor` select independent pixel rectangles for a core draw. | Several core subviews, with `clear:false` preserving preceding color/depth. | No automatic aspect change, viewport-aware pick, or rectangle propagation to optional native passes. |

Other core changes, including a second directional light, BatchedMesh and another pass graph, are outside this approved exception. WebGL2 stays the `@margoengine/webgl` preview of core meshes.

### Build in a package

These are separate package tasks. The three core hooks do not implement this backlog.
Independent UV1 and geometry groups have since been implemented in materials and exporters, with
[build, test and GPU evidence](materials-uv-groups-verification.md). The combined attributes row stays PARTIAL
because arbitrary named vertex attributes remain absent; the summary counts are unchanged.

| Row | What is missing | What to do |
| --- | --- | --- |
| WebGL2 fallback | PARTIAL. Flat core meshes, one light, no textures, no glTF-pro, no pick. | Leave the preview. A GL path per rendering package is its own project, outside this 4 KB. |
| ShaderMaterial, RawShaderMaterial | PARTIAL. WGSL per pass and `Material.shader()`, no raw material with its own vertex layout. | Add that material in `@margoengine/shader`. |
| Node materials / TSL | PARTIAL. Typed WGSL nodes. No statement-level `If`, workgroup memory, or light nodes. | Extend `@margoengine/shader`. Shadows and SSAO reading `positionNode` is part of that package. |
| Render targets | PARTIAL. Sequential camera captures are possible; one implicit scene. | Add a dedicated multi-view capture helper in `@margoengine/creative` or `@margoengine/environment` if needed. |
| Multiple render targets | PARTIAL. `DrawOptions.colorAttachments` only. | Add MRT outputs on a `NodeMaterial` in `@margoengine/shader`. |
| Clipping planes | PARTIAL. Six capped planes on core meshes. Node discard does not cap and does not clip shadows. | Teach `@margoengine/machinery` `SectionPlanes` to clip glTF-pro primitives and cap the cut. |
| ArrayCamera | PARTIAL. Stereo exists inside XR only. | Leave it there. A general array camera can build on the sequential camera option, but is not implemented. |
| Custom attributes, second UV, groups | PARTIAL. Independent UV1, material groups, tangents and color are implemented in materials; arbitrary named attributes remain absent. | Use `uvs1`, `setUVTransform({texCoord: 1}, slot)` and `createMesh`/`createInstancedMesh` with material arrays. Named attributes remain a future glTF-pro vertex-layout option. |
| MeshPhysicalMaterial | PARTIAL. Clearcoat, sheen, transmission, IOR, specular, volume, anisotropy and iridescence exist as factors. Dispersion does not. Physical maps on meshes you build do not. | Add dispersion in `@margoengine/gltf-pro`. Add the physical maps in `@margoengine/materials`. |
| MeshToonMaterial | PARTIAL. One toon look for every core mesh. | A per-material toon in `@margoengine/toon` or `@margoengine/materials`, including glTF-pro meshes. |
| Normal, depth, distance materials | PARTIAL. View-normal shading exists. | Add depth and distance shading modes in `@margoengine/materials`. |
| ShadowMaterial | PARTIAL. `ContactShadows` is a ground-plane contact shadow. | A materials mode, or `@margoengine/shadows`, that samples the directional cascades. |
| `side` | PARTIAL. Double-sided exists. Back-side-only does not. | Add back-side-only on `Material` and glTF materials. |
| Wireframe | PARTIAL. Inspector overlay, or `wireframe` drawn with lines. | A materials flag that uses that line path. |
| Blending, depth, polygonOffset, stencil | PARTIAL. Blend mode, depth test and depth write are fixed at construction. | Add polygonOffset and stencil on materials render state. Core meshes stay without them. |
| CubeTexture | PARTIAL. Environment and skybox only. | Let a `Material` sample that cube in `@margoengine/materials`. |
| DataTexture, 3D and array textures | PARTIAL. 2D RGBA8 only. | Add float, single-channel, 3D and array formats on `Texture`. |
| CompressedTexture, KTX2Loader | PARTIAL. glTF `KHR_texture_basisu` works. A standalone `.ktx2` cannot go on a material. Cubes, arrays and UASTC HDR are rejected. | Accept a decoders `GPUTexture` on `Texture`. Keep rejecting cubes, arrays and HDR until that API exists. |
| DepthTexture | PARTIAL. Borrowed from SSAO, Bloom or DOF. | A small helper in `@margoengine/post` that owns the depth target when no effect does. |
| HemisphereLight | PARTIAL. A fixed gradient inside glTF-pro. | A configurable sky/ground gradient belongs in `@margoengine/environment` through its lighting hooks; core's new RGB is flat. |
| DirectionalLight | PARTIAL. One per engine. | Keep one. Point, spot and area lights are `@margoengine/clustered`. A second directional does not fit in the 4 KB. |
| Color management | PARTIAL. sRGB in and out. `ColorOutput` covers a P3 or HDR canvas. | P3 input colors are a `@margoengine/environment` change. Leave core's working space linear sRGB. |
| glTF extensions | PARTIAL. `KHR_animation_pointer` and dispersion are rejected when required. Export writes no cameras or lights. | Pointer in `@margoengine/animation`. Dispersion in `@margoengine/gltf-pro`. Cameras and lights in `@margoengine/exporters`. |
| OBJLoader, MTLLoader | PARTIAL geometry, MISSING materials. `vt`, `usemtl` and `mtllib` are skipped. | Parse those in `@margoengine/loaders` and build a `Material`. |
| Other texture loaders | PARTIAL. UltraHDR only. TGA, DDS, KTX v1, TIFF and IES are absent. | Add a format in `@margoengine/decoders` when a file needs it. |
| LUTCubeLoader | PARTIAL. 33³ cubes only. | Other sizes in `@margoengine/tonemap` when a file needs them. |
| LoadingManager, progress | PARTIAL. `AbortSignal`, byte caps, and `AssetCache`. CAD reports progress. | A progress callback on `packages/shared/loading.js` for the other loaders. |
| USDZExporter | PARTIAL. No textures, vertex colors or alpha masks. | Those channels in `@margoengine/usdz`. |
| KeyframeTrack, PropertyBinding | PARTIAL. Clips come from glTF. `sampleTrack` exists. | An authoring helper in `@margoengine/animation` for node TRS and weights. |
| IK | PARTIAL. Two-bone and foot IK. | CCD chains in `@margoengine/animator` when a rig needs more than two bones. |
| SSRPass | PARTIAL. Core and models passed to `ssr.add`. Water and terrain do not reflect. | Give water and terrain the same capture hook `ssr.add` already uses. |
| Screen effects, SMAA | PARTIAL. FXAA exists. Vignette and the rest are a `NodePass`. SMAA is absent. | Ship the common looks as `NodePass` presets in `@margoengine/shader`. Add SMAA in `@margoengine/post` when a shot needs it. |
| WebXR VR | PARTIAL. Core meshes, WebGPU, no headset test. | Draw glTF-pro in `@margoengine/xr`, then test on a headset before adding effects. |
| WebXR AR | PARTIAL. Session mode only. | Hit testing in `@margoengine/xr` after that headset test. |
| SVGLoader | MISSING. | A loader that feeds `Shape` and `extrudeGeometry`. |
| TextGeometry, FontLoader, TTFLoader | MISSING. | Use `@margoengine/text`. Add font-to-`Shape` in `@margoengine/geometry` only for an extruded logo. |
| RoundedBoxGeometry | MISSING, grouped with the other extra geometries. | Add it in `@margoengine/geometry` when a mesh needs it. |
| ArcballControls | MISSING. | Add it in `@margoengine/controls`. `camera.up` already rolls. |
| Light helpers, SkeletonHelper | MISSING. | Draw them with `@margoengine/lines` or `@margoengine/inspector` when a debug view needs them. |
| Motion blur | MISSING. TAA already has a velocity buffer. | A pass in `@margoengine/post` that blurs with that buffer, when a shot needs it. |
| Lensflare | MISSING. | A sprite in `@margoengine/post` or `@margoengine/sky`. |
| Reflector, Refractor | MISSING. Water refracts on its own. | A planar mirror in `@margoengine/environment` can use sequential camera captures; the mirror itself is not implemented. |
| XRControllerModelFactory, XRHandModelFactory | MISSING. Poses and 25 joints already exist. | Models in `@margoengine/xr` after the headset test. |
| SkeletonUtils | MISSING. | Clone and retarget in `@margoengine/animation` when a second character needs them. |
| Physical light units | MISSING. Intensities are unitless. | A candela/lux scale in `@margoengine/clustered` when a glTF light must match a meter. The core uniform stays unitless. |

### Leave as the documented limit

These rows stay MISSING or PARTIAL. The action is the sentence a caller can rely on.

| Row | What is missing | What to do |
| --- | --- | --- |
| Scene object, multiple scenes | PARTIAL. One engine, one canvas. | A second scene is a second `Engine`. |
| Layers | PARTIAL. Raycasts only, via bvh. | Render layers are outside the three-hook exception. Raycasts remain the layer API. |
| CubeCamera | MISSING. | Its camera prerequisite is available; a dynamic environment capture helper still belongs in `@margoengine/environment`. |
| Multiple viewports / scissor | PARTIAL. Per-core-draw rectangles are implemented. | Optional native passes and picking need their own handling before claiming general viewport parity. |
| StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | MISSING. | Use `@margoengine/xr` for stereo. Do not add anaglyph. |
| MeshLambertMaterial, MeshPhongMaterial | MISSING. | FBX import converts both to PBR. Do not add the old shaders. |
| ConvexGeometry, DecalGeometry, ParametricGeometry | MISSING. Screen-space decals and physics hulls exist. | Do not add mesh decals, a public convex mesh, or parametric surfaces until a file needs one. |
| IESSpotLight, ProjectorLight | MISSING. | Do not add them in this pass. |
| ColladaLoader | MISSING. | Do not add it. |
| Long-tail loaders | MISSING. LDraw, VRML, 3DS, LWO, AMF, MD2, VOX, PDB, GCode, BVH motion capture, 3DM, KMZ, TDS. | Add one loader when a project brings that file. |
| DRACOExporter, EXRExporter, KTX2Exporter | MISSING. | glTF export is `@margoengine/exporters`. Do not add these three. |
| GTAOPass | MISSING. | Use SSAO in `@margoengine/post`. |
| SSGI, denoise | MISSING. | Do not add them. |
| GlitchPass, AfterimagePass | MISSING. | A `NodePass` in the shot that needs one. |
| BatchedMesh | MISSING. | Bake static meshes with `mergeGeometries`. Do not change core batching with this room. |
| Placed probes, transparent canvas, P3 output, area lights, local-light shadows, textured instancing | Already done in optional packages. The older gap list still called some of them open. | Use `@margoengine/environment` probes and `ColorOutput`, `@margoengine/clustered/area`, `@margoengine/clustered/shadows`, and glTF-pro `PBRInstances`. |

Two scaling notes from reading core (not measured):

- **Instance buffer size.** Each unique core `Geometry` keeps an instance buffer sized to the meshes that use it, doubling as it grows: 96 bytes per instance on the GPU and the same on the CPU (`Engine.retain` in `packages/core/src/engine.ts`). The earlier per-geometry allocation of the full entity capacity is gone.
- **Geometry and entity caps.** Core caps `Geometry` at 1,000,000 vertices and engines at 8,388,608 entities (initial capacity 1,024, doubled on demand; 351 B of kernel memory per slot). three.js has neither limit. Materials meshes share the 1,000,000-vertex cap.

## Margo extras

These are not in three.js core or its official add-ons. Many have third-party three.js equivalents (noted), which matters for an honest comparison page.

- **Rendering:** cascaded PCSS shadows with a static-caster cache (shadows); clustered forward lighting for up to 1,024 lights (clustered); TAA with motion vectors (taa); Gaussian splats with GPU covariance projection, radix sort and spherical harmonics up to degree 3 (splats; cf. third-party splat viewers); geometry-clipmap terrain with triplanar layers (terrain); GPU particles up to 1,000,000 with obstacles, sorting and sprites (vfx; creative `GPUParticles` is a preset of it); a 100k-blade grass field and a planet renderer (creative); physical day sky plus a stylized night with stars and a phased moon (sky; scenery `SkyMoon` is a preset of it); scene transitions (transitions); GPU scatter with distance LOD (scatter); GPU-driven frustum and Hi-Z occlusion culling with order-preserving compaction and indirect draws for static assemblies (culling); octahedral imposters (lod); vertex animation texture crowds (animation); device-loss recovery that rebuilds every plugin (`Engine.rebootDevice`).
- **Simulation and gameplay:** Rapier physics with a character controller (physics; cf. cannon-es or Rapier bindings); Recast/Detour navigation (navigation) and a dependency-free navmesh with A*, funnel paths and ORCA avoidance (navmesh; cf. three-pathfinding); sparse-set ECS (ecs); hierarchical state machine (fsm); snapshot interpolation for networking (net); semantic input with gamepad and haptics (input); tweening (tween); damped camera follow and shake (cinematic); animator blend trees and foot IK (animator).
- **Content generation:** procedural cabins, trees, rocks, humanoids, marching cubes and noise (procedural); 3D wave function collapse (wfc); spline roads (road); arc-length splines (splines).
- **Engineering and BIM:** STEP and IGES import through an OCCT worker, kinematics, capped section planes, metrology and exploded views (machinery); IFC through `web-ifc` (ifc).
- **Tooling and integration:** React bindings (react; cf. react-three-fiber); triangle BVH with a worker build (bvh; cf. three-mesh-bvh); SDF text from any browser font (text; cf. troika-three-text); entity inspector (inspector); progressive glTF streaming with HTTP range requests (gltf-pro/progressive; cf. needle-tools progressive loaders); Blender `.margo` offline asset pipeline (blender); Rust/Wasm transform and culling kernel (kernel); CAD camera controls and `fitToBoundingBox` in core.

Positioning caveats for a public page:

- fbx and usdz used to run three.js code at runtime (`FBXLoader` and `GLTFExporter`; the USDA and USDC parsers). Both now have native parsers; three.js is only a test-time reference.
- Several capabilities exist twice. html and labels both export `CSS3DObject`. gizmo and usdz-export are pure re-exports. Two toon paths and two navigation packages remain. The particle, bloom and sky duplicates were merged (2026-10-14): vfx is the one particle system (creative `GPUParticles` is a preset over it), post `Bloom` the one bloom (creative `PostProcessing` lost its bloom), and sky the one sky (scenery `SkyMoon` is a preset; `SkyMoonPass`, `NightAtmosphere` and creative's `atmosphere.sky` backdrop were removed). The merge shrank the five packages' root entries; Night Citadel and Afterlight load a few kB more gzip because they now use the fuller single sky and particle implementations (measured locally at the time; that measurement was not committed).
- Most COVERED rows outside core need WebGPU. Against three.js's WebGL renderer, Margo's WebGL2 reach is core meshes only.

## How this was checked

- **Reading only.** This matrix comes from reading source code. No build, test, benchmark or browser was run while writing it, so no row is a statement that a feature works at runtime.
- **Line-by-line reading.** Core and the stage facade were read in full (`packages/core/src/*.ts`, `packages/margoengine/src/index.ts`). So were the gltf loader and most of gltf-pro, plus the parts of animation, animator, fbx, toon, the React environment adapter, the bvh raycaster, machinery's OBJ parser and creative's targets that the rows cite.
- **Re-audit, 2026-10-14.** Every row was re-checked against `perf/auto-quality` at commit 2c53227: each package's README, `src/index.ts` and package.json `exports`. Read line by line in this pass: materials `src/index.ts`, core `camera.ts` and the instance sizing in `engine.ts`, gltf-pro's extension handling (`asset.ts`, decoder hooks) and post's `PostStack` order rules (`stack.ts`). The table then held 156 rows (texture transforms, VAT crowds and ViewHelper had been added to the original 153); the earlier summary still read 65 / 43 / 45. Since then: InstancedMesh PARTIAL -> COVERED (textured instancing), glTF export with animation PARTIAL -> COVERED, PointLight and SpotLight shadows MISSING -> COVERED (`@margoengine/clustered/shadows`, run on a real GPU): 87 / 39 / 30. SSRPass MISSING -> PARTIAL (post `SSR`, run on a real GPU): 88 / 40 / 28. Progressive glTF loading added as a row (COVERED, `@margoengine/gltf-pro/progressive`, 157 rows): 89 / 40 / 28. Later edits drifted (the order-independent transparency row was added without updating the totals; volumetric fog added a row and moved God rays PARTIAL -> COVERED). Recounted by script from every row's status column (HANDOFF 5l.m, 2026-10-15): 159 rows, 92 / 39 / 28, 51 of the 92 COVERED rows marked †; no duplicate rows. Then RectAreaLight MISSING -> COVERED (clustered `AreaLights`, `@margoengine/clustered/area`): 93 / 39 / 27, recounted by script again. Then LightProbe PARTIAL -> COVERED (`@margoengine/environment/probes`) and Decals MISSING -> COVERED (`@margoengine/post/decals`), HANDOFF 5l.e/5l.h: 95 / 38 / 26, recounted by script.
- **Rows marked †.** For these, the evidence is that the named exports exist, the source is non-trivial, the package README describes the behavior, and keyword searches across `packages/*/src` agree. The implementation itself was not audited line by line.
- **MISSING.** A row is MISSING when no matching class, function or keyword was found in any package's `src/`. README files and tests were not counted as implementation.
- **The three.js side.** The feature list comes from knowledge of three.js r186, its documentation (<https://threejs.org/docs/>) and `three/addons`. It was not re-checked against the r186 tag while writing.
- **Re-checking.** When a gap is closed, update its row, the counts in the Summary, and [What is missing or partial, and what to do](#what-is-missing-or-partial-and-what-to-do). Update the "Not yet" table in [`from-threejs.md`](from-threejs.md) when that page names the same gap.
