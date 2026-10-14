# three.js r186 parity matrix

What Margo Engine covers compared with three.js r186 and its common add-ons (`three/addons`). It is meant for roadmap planning and as the source for a public comparison page. Every COVERED or PARTIAL claim names the Margo package, the export, and the file where the code lives.

## Summary

153 three.js features in 19 areas:

| Status | Count | Meaning |
| --- | --- | --- |
| COVERED | 65 | A Margo package implements the feature in a form a three.js user would accept as equivalent (limits noted). |
| PARTIAL | 43 | Some of it exists, but a common use case is missing. The notes say what. |
| MISSING | 45 | No implementation was found in any package's `src/`. |

Overall: Margo is strong where three.js relies on third-party libraries or examples. That includes cascaded PCSS shadows, clustered lighting, TAA, Gaussian splats, BVH queries, physics, navigation, terrain, water and sky. The gaps are in the basics a three.js user expects on day one:

- **No materials or textures you can create yourself.** Core `PbrMaterial` is a constant color, opaque and untextured, and core `Geometry` has no UVs. Textures only render on assets loaded through glTF.
- **No glTF extensions.** Any file that lists `extensionsRequired` is rejected. The Draco, meshopt and KTX2 decoders exist but the glTF loader does not call them.
- **No orthographic camera.** (Since added as `@margoengine/cameras`, see Cameras.)
- **Loaded glTF models cannot be picked.** (Since added: bvh `Raycaster` and selection `Picking` hit gltf-pro models, see Interaction.)
- **Image-based lighting is not applied automatically.** Only the React adapter applies it.
- **Effects do not combine freely.** Bloom, SSAO and creative post-processing reject each other.
- **WebGL2 fallback is core-only.** About 30 packages require WebGPU.

Legend. A **†** marks rows where the evidence is the exported symbols, the package README and a non-trivial amount of source code, not a line-by-line read. See [How this was checked](#how-this-was-checked).

## Matrix

### 1. Core objects and scene graph

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Object3D transforms and hierarchy (position, rotation, quaternion, scale, parent, visible, name) | COVERED | core `Engine.createMesh`, `Mesh.setParent`, `setQuaternion` (`packages/core/src/engine.ts`) | Parent depth of 64 or less. At most 100,000 entities per engine (`packages/core/src/kernel.ts`). No `children`, `traverse`, `userData`, `lookAt` or `getWorldPosition`; world matrices are reachable only through `core/extension`. |
| Group (transform-only node) | COVERED | core mesh with no geometry | glTF importers use this pattern. |
| Scene object, multiple scenes | PARTIAL | one `Engine` = one canvas = one implicit scene | No Scene object. A second scene needs a second engine and canvas. |
| `scene.background` (color, texture, cubemap) | COVERED † | environment `EnvironmentBackground`, `Skybox` (`packages/environment/src/background.ts`), `ColorBackground` (`color.ts`, solid or vertical gradient); sky `Sky` | Core's clear color stays hard-coded; `ColorBackground` covers it with a pass on cleared depth. A transparent canvas still needs a core change. WebGPU only. |
| Transparent canvas (`alpha: true`) | MISSING | — | The WebGPU context is configured without `alphaMode` and WebGL2 is created with `alpha:false` (`packages/core/src/renderer.ts`). Only XR AR clears to transparent. |
| Frustum culling | COVERED | Rust/Wasm kernel, `TransformStore.tick` (`packages/kernel/src/lib.rs`, `packages/core/src/kernel.ts`) | Bounding spheres against six planes. |
| Render loop, Clock/Timer | COVERED | core `Engine.start`, `onFrame` (`packages/core/src/engine.ts`) | Frame delta is clamped to 0.1 s. |
| Layers | PARTIAL | bvh `setMeshLayers`, `getMeshLayers` | Only filters raycasts. No camera or render layers. |
| Math library (Vector3, Matrix4, Quaternion, Euler, Box3, Sphere, Ray, Plane, Frustum, Color) | MISSING | — | Public APIs take tuples. Matrix helpers are internal (`packages/shared/math.js`) or duplicated per package (`multiplyMatrices` in bvh and animation, `parseColor` in lines, points and text). |

### 2. Renderer and platform

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| WebGPU renderer | COVERED | core `GPURenderer` (`packages/core/src/renderer.ts`) | Automatic instancing, reversed-Z, device-loss reboot. |
| WebGL2 fallback (WebGLRenderer, WebGPURenderer's WebGL2 backend) | PARTIAL | core `GLRenderer` (`packages/core/src/renderer.ts`) | Draws core meshes with the constant PBR shader only. About 30 packages check for WebGPU and refuse to run on WebGL2: gltf-pro, animation, shadows, clustered, post, taa, dof, tonemap, lines, points, text, environment, selection, sky, water, xr and others. `engine.pick` also requires WebGPU. Only gltf (constant colors), bvh, controls and labels work on WebGL2. |
| MSAA | COVERED | core `sceneSamples()` (`packages/core/src/quality.ts`) | 4x on desktop. 1x on user-agent-detected phones and on the light quality tier. |
| Reversed-Z / logarithmic depth | COVERED | core reversed-Z (`depthCompare:'greater-equal'`) | |
| ShaderMaterial, RawShaderMaterial, onBeforeCompile | PARTIAL | `core/extension` `FrameGraph`, `DrawOptions.pipeline`, `PassContext.shader` (`packages/core/src/plugin.ts`) | Custom WGSL works per pass, or by string-patching the shared shader. There is no per-mesh material object or uniform abstraction. |
| Node materials / TSL | PARTIAL | shader `NodeMaterial`, `NodePass`, `ComputePass` (`packages/shader/src`) | Typed nodes compile to WGSL with CSE and dead-code elimination; material slots (colour, normal, roughness, metalness, emissive, opacity, vertex position), PostStack effects and 1D compute over storage buffers. No statement-level If, atomics, light/shadow nodes or GLSL output (README limits). |
| Compute (TSL compute, GPUComputationRenderer) | PARTIAL | raw `engine.gpu` via `core/extension` | No abstraction. Packages write raw WGSL compute. |
| Render targets / render-to-texture | PARTIAL | creative `HDRRenderTarget` (`packages/creative/src/targets.ts`) | Captures the one scene from the one camera. There is no way to render a second camera or scene into a texture. |
| Multiple render targets (MRT) | PARTIAL | `DrawOptions.colorAttachments` (`packages/core/src/plugin.ts`) | Low-level only. selection uses it for its ID buffer. |
| Clipping planes | PARTIAL | machinery `SectionPlanes`, `boxSection` (`packages/machinery/src/section.ts`) | Six planes with stencil caps. WebGPU and core meshes only. |
| Stats, GPU timing | COVERED † | stats `Stats`, `GPUProfiler` (`packages/stats/src/`) | Uses timestamp queries. |
| Multiple viewports / scissor | MISSING | — | |

### 3. Cameras

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| PerspectiveCamera | PARTIAL | core `Camera` (`packages/core/src/camera.ts`) | Defined by position and target, with no up vector or roll. `update()` throws `RangeError('Vertical camera')` when the view is exactly vertical, so straight top-down or bottom-up views fail. No `zoom`, `setViewOffset`, `focalLength` or `filmGauge`. `fitToBoundingBox` is a Margo extra. |
| OrthographicCamera | COVERED | cameras `CameraProjection` (`packages/cameras/src/index.ts`) | Replaces the core camera's `update`, so culling, `engine.pick`, selection and bvh rays follow the ortho frustum; also renders exactly vertical views (perspective or ortho) with an explicit screen up. SSAO, lines/points sizes, labels, clustered, DOF and splats still assume `fov`. |
| ArrayCamera | PARTIAL | xr stereo renderer (`packages/xr/src/renderer.ts`) | Internal to XR, not a general multi-view camera. |
| CubeCamera (dynamic environment maps) | MISSING | — | |
| StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | MISSING | — | |

### 4. Geometry

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Built-in primitives (Box, Capsule, Circle, Cone, Cylinder, polyhedra, Plane, Ring, Sphere, Torus, TorusKnot) | COVERED † | geometry `boxGeometry` … `torusKnotGeometry` (`packages/geometry/src/primitives.ts`, `polyhedra.ts`) | The README says the tests compare against three r180 fixtures vertex for vertex. |
| Shape, Path, curves, Extrude, Lathe, Tube | COVERED † | geometry `Shape`, `Path`, `CatmullRomCurve3` …, `extrudeGeometry`, `latheGeometry`, `tubeGeometry` | No custom `UVGenerator`. |
| EdgesGeometry, WireframeGeometry | COVERED † | geometry `edgesGeometry`, `wireframe` | Draw the result with the lines package. |
| BufferGeometry custom attributes (uv, uv1, color, tangent) on drawable meshes | PARTIAL | core `Geometry` (`packages/core/src/geometry.ts`) | Core geometry is position, normal and index only, up to 1,000,000 vertices. `toGeometry` drops UVs and tangents. Only gltf-pro, blender and scatter `ScatterInstances` draw the 80-byte PBR vertex with UVs and tangents. |
| BufferGeometryUtils (merge, mergeVertices, toNonIndexed, computeTangents, computeVertexNormals) | COVERED † | geometry `mergeGeometries`, `mergeVertices`, `toNonIndexed`, `computeTangents`, `computeVertexNormals` (`packages/geometry/src/utils.ts`) | |
| TextGeometry, FontLoader, TTFLoader | MISSING | — | SDF text is covered separately; see [Margo extras](#margo-extras). |
| ConvexGeometry, DecalGeometry, RoundedBoxGeometry, ParametricGeometry | MISSING | — | physics computes convex hulls for colliders only. |

### 5. Materials

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| MeshStandardMaterial, constant factors | COVERED | core `PbrMaterial` (`packages/core/src/geometry.ts`) | Color, roughness, metalness and doubleSided. Alpha must be 1. |
| MeshStandardMaterial with maps (map, normalMap, roughness/metalness map, aoMap, emissiveMap) | PARTIAL | gltf-pro `PBRModel` (`packages/gltf-pro/src/index.ts`, `shader.ts`) | Works only for meshes that come from glTF (or from FBX, USD or Blender `.margo`, which convert into glTF-pro). There is no user-facing material or texture API, so you cannot put an image on a mesh you built. |
| MeshPhysicalMaterial (clearcoat, sheen, transmission, iridescence, anisotropy, IOR, specular, dispersion) | MISSING | — | |
| MeshBasicMaterial (unlit) | MISSING | — | |
| MeshLambertMaterial, MeshPhongMaterial | MISSING | — | |
| MeshToonMaterial | PARTIAL | toon `Toon`, creative `ToonShading` (`packages/toon/src/index.ts`) | Applies to every core mesh at once, not per material. The README says it does not apply to glTF-pro or skinned meshes. |
| MeshMatcapMaterial | MISSING | — | |
| MeshNormalMaterial, MeshDepthMaterial, MeshDistanceMaterial | MISSING | — | inspector has a debug normal overlay, but it is not a material. |
| ShadowMaterial (shadow catcher) | MISSING | — | |
| PointsMaterial, SpriteMaterial | COVERED † | points `PointsMaterial`, `SpriteMaterial` (`packages/points/src/material.ts`) | WebGPU only. |
| LineBasicMaterial, LineDashedMaterial, Line2's LineMaterial | COVERED † | lines `LineMaterial` (`packages/lines/src/line.ts`) | Width, joins, caps and dashes. WebGPU only. |
| Transparency, alpha blending, alphaTest | PARTIAL | gltf-pro `MASK` and `BLEND`, sorted back to front | Core materials are opaque only. |
| Vertex colors | PARTIAL | gltf-pro `COLOR_0` | Not available on core meshes. |
| `side` (Front, Back, Double) | PARTIAL | `doubleSided` on `PbrMaterial` and glTF | No back-side-only rendering. |
| Wireframe | PARTIAL | inspector overlay; geometry `wireframe` drawn with lines | No material flag. |
| Per-material blending modes, depthTest, depthWrite, polygonOffset, renderOrder, stencil | MISSING | — | |

### 6. Textures

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Texture, TextureLoader on arbitrary meshes | MISSING | — | No public texture type. Textures are created only inside gltf-pro, terrain, points and text. |
| CubeTexture, CubeTextureLoader | PARTIAL | environment `Environment` built from an equirect or six `CubeFaces` | Used only for IBL and backgrounds. |
| DataTexture, Data3DTexture, DataArrayTexture | MISSING | — | Used internally (tonemap 3D LUT, shadow arrays), but not exposed. |
| CompressedTexture (KTX2/Basis) | PARTIAL | decoders `KTX2Decoder.createTexture` (`packages/decoders/src/ktx2.ts`) | Returns a raw `GPUTexture` that no material or loader consumes. KTX2 cube maps, arrays and HDR are rejected. |
| VideoTexture, VideoFrameTexture | PARTIAL | video `Video` (`packages/video/src/index.ts`) | Draws to a screen-space rectangle only; `import(device)` is offered for custom renderers. The README says it is "not a new core material slot". |
| CanvasTexture | MISSING | — | |
| DepthTexture | PARTIAL | `depthTexture` getters on post `Bloom` and `SSAO`, and on dof `DOF` | Borrowed from whichever effect owns the scene capture. |
| Mipmaps, wrapping, filtering | PARTIAL | gltf-pro mip generation and glTF samplers (`packages/gltf-pro/src/index.ts`, `mip.ts`) | glTF assets only. No anisotropic filtering setting was found. |

### 7. Lights

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| AmbientLight | PARTIAL | core `engine.lighting.radiance[3]` | A scalar intensity times albedo. It has no color and does not apply to metals (`packages/core/src/shaders.ts`). |
| HemisphereLight | PARTIAL | fixed sky/ground gradient in gltf-pro's ambient term (`packages/gltf-pro/src/shader.ts`, line 61) | Not configurable. Core meshes use the flat ambient. |
| DirectionalLight | PARTIAL | core `engine.lighting.direction` and `radiance` (`packages/core/src/engine.ts`) | Exactly one per engine. |
| PointLight | COVERED † | clustered `Clustered.setLights` (`packages/clustered/src/index.ts`) | Up to 1,024 lights, WebGPU only, no shadows. Core meshes receive them automatically; glTF-pro models and terrain need `add()`. |
| SpotLight | COVERED † | clustered `Clustered.setLights` with inner and outer cone | No shadows and no projected `map`. |
| RectAreaLight | MISSING | — | |
| LightProbe | PARTIAL | environment `projectEquirectSH`, `environment.sh` | One global probe from the environment map. No placed probes or probe volumes. |
| IESSpotLight, ProjectorLight | MISSING | — | |
| Physical light units (candela, lux) | MISSING | — | Intensities are unitless radiance scales. |

### 8. Shadows

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Directional light shadows (incl. CSM add-on, PCF/PCFSoft) | COVERED † | shadows `Shadows` (`packages/shadows/src/index.ts`, `cascades.ts`) | Four cascades, PCSS, and a cache for static casters. WebGPU only. Core meshes are shadowed automatically; glTF-pro models (including skinned ones), terrain and scatter need `add()`. Goes beyond three core. |
| PointLight shadows | MISSING | — | The clustered README says local lights do not cast shadows. |
| SpotLight shadows | MISSING | — | |

### 9. Environment, fog and color

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| HDRLoader / RGBELoader | COVERED † | environment `parseHDR`, `loadEnvironmentImage` (`packages/environment/src/hdr.ts`) | |
| EXRLoader | COVERED † | environment `parseEXR` (`packages/environment/src/exr.ts`) | Single-part scanline files with NONE, RLE, ZIPS, ZIP or PIZ compression. |
| PMREMGenerator, `scene.environment` (IBL) | COVERED † | environment `Environment`, `EnvironmentLighting` (`packages/environment/src/lighting.ts`) | `engine.use(lighting)` patches core's mesh shader through `PassContext.shader`; `lighting.applyTo(model)` lights glTF-pro models. React `<Environment>` uses it. IBL replaces the constant ambient term. |
| Fog, FogExp2 | COVERED † | environment `Fog` (linear, exp2, height); sky `fog` option; creative `PostProcessing` `atmosphere` | `Fog` runs in core's and glTF-pro's mesh shaders, so blended glTF primitives are fogged. Particles, VFX and splats are not. |
| Sky add-on | COVERED † | sky `Sky` with Preetham and Bruneton models (`packages/sky/src/`) | Adds clouds, sun, moon and stars. |
| Tone mapping (`renderer.toneMapping`) | COVERED † | core fixed Reinhard; tonemap `Tonemap` with AgX, ACES fitted and Khronos Neutral (`packages/tonemap/src/index.ts`) | |
| Color management (sRGB input, linear workflow, `outputColorSpace`) | PARTIAL | core converts hex sRGB to linear and encodes sRGB output | No Color class and no ColorManagement API. No Display-P3 or HDR canvas output. |
| Exposure, physical camera parameters | COVERED † | `exposure` in stops on tonemap and Bloom; dof `focalLength` and `aperture` (f-number) | |

### 10. Loaders

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| GLTFLoader: static textured PBR | COVERED | gltf-pro `loadGLTF`, `parseGLTF` (`packages/gltf-pro/src/index.ts`); gltf `loadGLTF` with constant colors, works on WebGL2 (`packages/gltf/src/index.ts`) | Metallic-roughness, MASK and BLEND, normal, occlusion and emissive maps, two UV sets, vertex colors. WebGPU only. |
| GLTFLoader: animations, skins, morph targets | COVERED | animation `Animation.attach` (`packages/animation/src/index.ts`) | STEP, LINEAR and CUBICSPLINE interpolation. |
| glTF extensions (KHR_materials_*, KHR_texture_transform, KHR_lights_punctual, KHR_mesh_quantization, EXT_mesh_gpu_instancing, KHR_animation_pointer) and glTF cameras | MISSING | — | Any `extensionsRequired` entry throws (`packages/gltf-pro/src/asset.ts`, line 63). No package `src/` handles any `KHR_` extension. |
| DRACOLoader, glTF Draco | PARTIAL | decoders `DracoDecoder` (`packages/decoders/src/draco.ts`) | Not wired into either glTF loader (decoders README, "Limits"). gltf-pro throws on `KHR_draco_mesh_compression` (`index.ts`, line 59). |
| Meshopt (`EXT_meshopt_compression`) | PARTIAL | decoders `MeshoptDecoder`, `decodeMeshoptBuffer` (`packages/decoders/src/meshopt.ts`) | Same: the decoder exists but the glTF loaders do not call it. |
| KTX2Loader | PARTIAL | decoders `KTX2Decoder` | Same. |
| FBXLoader | COVERED | fbx `loadFBX`, `convertFBX` (`packages/fbx/src/index.ts`) | Native binary/ASCII FBX 7.x reader and GLB writer (no three.js): hierarchy with pivots, Phong/Lambert as PBR, textures, skins, blend shapes, clips. Tested equivalent to the old three.js bridge. |
| OBJLoader | PARTIAL | machinery `parseCAD`, `loadCAD` (`packages/machinery/src/cad-parser.ts`) | Geometry only: `vt`, `usemtl` and `mtllib` records are skipped. |
| MTLLoader | MISSING | — | |
| STLLoader | COVERED | machinery `parseCAD` (format `stl`) | |
| PLYLoader | COVERED † | loaders `parsePLY` (`packages/loaders/src/ply.ts`) | Colors and UVs are kept on the data but core does not render them. |
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
| GLTFExporter | PARTIAL | exporters `exportGLB`, `exportGLTF` (`packages/exporters/src/gltf.ts`) | Static only. The README says it writes no animations, skins, morphs, cameras, lights or KHR extensions. |
| OBJExporter, STLExporter, PLYExporter | COVERED † | exporters `exportOBJ` (with MTL), `exportSTL`, `exportPLY` | |
| USDZExporter | PARTIAL | exporters `exportUSDZ`, re-exported by usdz-export | Rejects textures, vertex colors and alpha masks. Hierarchy is baked. |
| DRACOExporter, EXRExporter, KTX2Exporter | MISSING | — | |

### 12. Animation

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| AnimationMixer, clip playback | COVERED | animation `Animation` (`packages/animation/src/index.ts`) | For glTF-pro models on WebGPU. One clip at a time unless animator is used. |
| Cross-fade, blending, additive layers | COVERED | animator `Animator`, `blend1D`, `blend2D` (`packages/animator/src/index.ts`) | Also has blend trees and state transitions. |
| SkinnedMesh, Skeleton, Bone | COVERED | animation compute skinning (`packages/animation/src/shader.ts`) | Four influences per vertex. Skins must come from glTF. |
| Morph targets | COVERED | animation morph compute, `setMorph` | Position, normal and tangent morphs. |
| KeyframeTrack, AnimationClip authored in code, PropertyBinding | PARTIAL | animation `sampleTrack`, `sampleTrackInto`; tween `Tween` | Clips come only from glTF node TRS and weights. No property tracks on arbitrary objects. |
| SkeletonUtils (clone, retarget), AnimationObjectGroup | MISSING | — | |
| IK (CCDIKSolver) | PARTIAL | animator `solveTwoBoneIK` and foot IK (`packages/animator/src/ik.ts`); machinery `Kinematics` | Analytic two-bone IK only. No general CCD chains. |

### 13. Post-processing

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| EffectComposer, or the WebGPU PostProcessing node chain | PARTIAL | frame-graph passes run by `order` (`packages/core/src/plugin.ts`) | Each of post `Bloom`, post `SSAO` and creative `PostProcessing` owns the scene capture and rejects the others (post and dof READMEs). DOF, then Tonemap, then TAA is a documented working chain. |
| UnrealBloomPass | COVERED † | post `Bloom` (`packages/post/src/bloom.ts`); creative `PostProcessing({bloom})` | |
| SSAOPass, SAOPass | COVERED † | post `SSAO` (`packages/post/src/ssao.ts`) | Normal-aware bilateral blur. |
| GTAOPass | MISSING | — | |
| SSRPass | MISSING | — | |
| SSGI, denoise | MISSING | — | |
| TAA (TAARenderPass, TRAA node) | COVERED † | taa `TAA` (`packages/taa/src/index.ts`) | Uses a velocity buffer and YCoCg clamping. |
| FXAA, SMAA | MISSING | — | Phones render single-sampled, so they have no anti-aliasing unless TAA is attached. |
| BokehPass, DOF | COVERED † | dof `DOF` (`packages/dof/src/index.ts`); creative `focus` and `aperture` | |
| OutlinePass | COVERED † | selection `Selection` with jump flood or dilation (`packages/selection/src/index.ts`) | Core meshes only. |
| FilmPass (grain) | COVERED † | creative `PostProcessing({grain})` | |
| GlitchPass | MISSING | — | |
| AfterimagePass | MISSING | — | |
| LUTPass | COVERED † | tonemap `setLUT` | 33³ `.cube` files only. |
| OutputPass, tone mapping | COVERED † | tonemap `Tonemap` | |
| God rays | PARTIAL | creative `atmosphere.godRays` (`packages/creative/src/post.ts`) | Only inside creative `PostProcessing`, which cannot be combined with post Bloom or SSAO. |
| Motion blur | MISSING | — | taa already produces a velocity buffer. |
| Color correction, grading | COVERED † | creative `lift`, `gain`, `saturation`, `contrast`; tonemap `contrast` | |
| Simple screen effects (vignette, RGB shift or chromatic aberration, pixelation, halftone, dot screen, Sobel) | MISSING | — | transitions has chromatic displacement, but only as a scene-change wipe. |
| Lensflare | MISSING | — | |

### 14. Controls

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| OrbitControls, MapControls, TrackballControls, FlyControls, FirstPersonControls, PointerLockControls | COVERED † | controls (`packages/controls/src/orbit.ts`, `trackball.ts`, `fly.ts`, `first-person.ts`, `pointer-lock.ts`) | core also has `CADCameraControls`. |
| TransformControls | COVERED † | controls `TransformControls` (`packages/controls/src/transform.ts`); gizmo re-exports it | |
| DragControls | COVERED | controls `DragControls` (`packages/controls/src/drag.ts`) | Core meshes and gltf-pro models, mouse and touch, view plane, world plane or axis, hover events; hits from the bvh `Raycaster`. No rotate mode or `transformGroup`. |
| ArcballControls | MISSING | — | |

### 15. Helpers

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| GridHelper, PolarGridHelper, AxesHelper, BoxHelper, Box3Helper, ArrowHelper, CameraHelper, PlaneHelper, VertexNormalsHelper | COVERED † | lines (`packages/lines/src/helpers.ts`) | WebGPU only. |
| Light helpers (Directional, Point, Spot, Hemisphere, RectArea) | MISSING | — | |
| SkeletonHelper | MISSING | — | |

### 16. Interaction and spatial queries

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| Raycaster | COVERED | bvh `Raycaster.intersectEngine`, `intersectObjects` (`packages/bvh/src/raycaster.ts`) | Core meshes and gltf-pro primitives (loaded models and materials meshes) with node transforms; model hits carry model, primitive, node and `uv`. Skinned and morphed primitives are hit in bind pose. Lines are never hit; points has its own `pickPoint`. |
| GPU picking | COVERED | core `engine.pick`; selection `Picking` (`packages/selection/src/picking.ts`) | Core meshes and gltf-pro models (deformed skinned buffers included); `picking.pick` names the model and primitive. WebGPU only. |

### 17. Special objects

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| InstancedMesh | COVERED | core automatic instancing of meshes that share a `Geometry` (`packages/core/src/engine.ts`); scatter `ScatterInstances` | Each instance has its own PBR factors. At most 100,000 entities per engine. See the buffer-sizing note in [Ranked gaps](#ranked-gaps). |
| BatchedMesh | MISSING | — | Each distinct geometry is its own draw call. |
| LOD | COVERED | lod `LODSystem`, `Imposter` (`packages/lod/src/index.ts`, `imposter.ts`); scatter's GPU distance rings | Distance or screen-size levels with three.js hysteresis over core meshes, gltf-pro and materials models, geometry swaps and octahedral imposters (one instanced draw per atlas). Imposters are not pickable and cast no shadows. |
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

Every MISSING or PARTIAL item, ordered by how often real three.js projects need it. **Fit** says where the work belongs under the v1.0 rule: core and the stage facade are frozen, and new capability goes into optional packages. "Freeze conflict" marks items that cannot be done cleanly without a core change.

### High

1. **Materials and textures for meshes you build yourself** (TextureLoader, `map`, `normalMap`, MeshBasicMaterial, alpha, vertex colors, emissive). Almost every three.js project textures a mesh it creates in code. Today only glTF assets can carry textures.
   **Fit:** new `@margoengine/materials` package that draws its own meshes with gltf-pro's 80-byte vertex and shader, or a programmatic constructor on gltf-pro `PBRModel`. Core `Geometry` cannot hold UVs, so this has to bypass core batches, as `ScatterInstances` and blender already do.
2. **glTF extensions and compression.** This covers Draco, meshopt and KTX2 wiring, `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, unlit, transmission, clearcoat and volume, `KHR_lights_punctual` and glTF cameras. Files from gltfpack, gltf-transform, Sketchfab or Blender exports often list required extensions, and gltf-pro rejects those files outright.
   **Fit:** extend gltf-pro, plus the `GLTFDecoderHooks` the decoders README already proposes.
3. **Raycasting and picking glTF-pro models.** Click-to-select on loaded models is near-universal, and today only core meshes can be hit.
   **Fit:** extend bvh (`Raycaster` accepts `PBRModel` primitives; the `shadowPrimitives` contract already exposes buffers) and selection (an `onPick` for models).
   **Done:** bvh `Raycaster` tests gltf-pro primitives, selection `Picking` and `Selection` cover models, `engine.pick` returns model nodes.
4. **IBL that applies itself** (`scene.environment`). PBR without an environment map looks flat, and outside React every user has to reproduce the shader patch. **Done:** environment `EnvironmentLighting` (core meshes and glTF-pro models).
   **Fit:** extend environment with an `applyTo(model)` or `LightingEffect` export (move the adapter out of `packages/react/src/components.tsx`). Core-mesh IBL is a freeze conflict, since the core shader has no hook for it. A string patch through `PassContext.shader`, as tonemap and toon do, is the workaround.
5. **Background color and transparent canvas.** `scene.background = color` appears in most three.js scenes, and a transparent canvas is standard for embeds. **Background color done:** environment `ColorBackground`; the transparent canvas remains (core change).
   **Fit:** a solid-color background pass is a small addition to environment. A transparent canvas needs `alphaMode` in core's context setup, which is a freeze conflict.
6. **Effects that combine** (EffectComposer). Bloom with AO with AA with grading is the normal stack, and Bloom, SSAO and creative PostProcessing currently reject each other.
   **Fit:** extend post with a shared HDR scene-capture owner that Bloom, SSAO, DOF, tonemap and creative all read from.
7. **OrthographicCamera, plus exactly vertical views.** CAD, maps, isometric games and editors all use it, and top-down perspective views throw today.
   **Fit:** new `@margoengine/cameras` package that overrides the pass camera matrix the way taa does. Culling planes are computed by core from the perspective camera, so this is a freeze conflict. A v1.x core exception is likely cleaner.
8. **WebGL2 fallback beyond core.** A three.js replacement has to reach browsers and devices without WebGPU. Today that fallback is flat-shaded boxes.
   **Fit:** extend each rendering package with a GL path, starting with gltf-pro. This is a large effort and a strategic decision rather than one package.
9. **Public math library** (Vector3, Matrix4, Quaternion, Box3, Ray, Plane, Color). three.js users write against these constantly, and Margo duplicates helpers per package.
   **Fit:** new tree-shakable `@margoengine/math` package.
10. **FXAA or SMAA.** Phones run without MSAA, so there is no anti-aliasing at all unless TAA is attached.
    **Fit:** extend post (or taa) with an FXAA or SMAA pass.

### Medium

11. **More than one directional light, a colored ambient light, and HemisphereLight.** Key, fill and sky lighting is common.
    **Fit:** extend clustered (add directional and hemisphere entries), or a new `@margoengine/lights` package that injects via `LightingEffect`. Core's single-light uniform is frozen.
12. **Point and spot light shadows.** Common in interiors and games.
    **Fit:** extend shadows.
13. **MeshPhysicalMaterial features** (clearcoat, transmission, sheen). Product configurators depend on them.
    **Fit:** extend gltf-pro, together with gap 2's KHR_materials_*.
14. **Render-to-texture from a second camera, CubeCamera, multiple viewports.** Used for minimaps, mirrors, portals and split screen.
    **Fit:** freeze conflict, because core owns one camera and one pass graph. Consider for core v1.x.
15. **Video and canvas textures on meshes.** Video planes and dynamic UI textures are common in web 3D.
    **Fit:** extend video and the new materials package from gap 1.
16. **OBJ with MTL and UVs.** Still a very common interchange format.
    **Fit:** move OBJ into loaders and add MTL. Needs gap 1 for textures.
17. **SVGLoader.** Extruded logos and icons are common on marketing sites.
    **Fit:** extend loaders (geometry already has `Shape` and `extrudeGeometry`).
18. **General LOD object.** (Since added as `@margoengine/lod`, with octahedral imposters.)
    **Fit:** new small package, or extend scatter.
19. **Node materials, TSL, per-mesh custom shaders.** This is three r186's main extension model, and power users rely on it.
    **Fit:** new `@margoengine/shader` (material and uniform abstraction) on top of gltf-pro's draw path. **Started:** `@margoengine/shader` covers node materials, node post passes and node compute; per-mesh raw WGSL materials remain.
20. **glTF export with animation.** Used by editors and configurators.
    **Fit:** extend exporters.
21. **WebXR completeness** (glTF-pro and skinning in XR, controller and hand models, AR hit test).
    **Fit:** extend xr.
22. **Programmatic keyframe tracks, SkeletonUtils retargeting, general CCD IK.**
    **Fit:** extend animation and animator.
23. **DragControls.**
    **Fit:** extend controls (bvh supplies the hits).
    **Done:** controls `DragControls`.
24. **ShadowMaterial (shadow catcher).** Product shots on a page background use it.
    **Fit:** extend shadows.
25. **Scene-wide fog that is not a post pass,** including fog on transparent objects. **Done:** environment `Fog`.
    **Fit:** extend sky or environment.
26. **UltraHDR environment maps.** Increasingly used in three.js projects. **Done:** environment `decodeUltraHDR` (also picked by `loadEnvironmentImage`).
    **Fit:** extend environment.
27. **RectAreaLight.** Archviz and product lighting.
    **Fit:** extend clustered (LTC).
28. **Decals.**
    **Fit:** new package or extend geometry (`DecalGeometry`) together with gap 1.

### Low

29. **SSR, GTAO, SSGI, motion blur.**
    **Fit:** extend post. taa's velocity buffer already exists.
30. **Simple screen effects** (vignette, RGB shift, pixelation, halftone, dot screen, Sobel, glitch, afterimage).
    **Fit:** one small new `@margoengine/fx` package, once gap 6 lands.
31. **Lensflare.**
    **Fit:** extend post or sky.
32. **TextGeometry and fonts.** SDF text covers most text needs.
    **Fit:** extend geometry (font to `Shape`).
33. **Collada and the long-tail loaders** (LDraw, VRML, 3DS, and so on).
    **Fit:** extend loaders when a user asks.
34. **Texture loaders** (TGA, DDS, KTX v1, TIFF, IES, other LUT formats).
    **Fit:** extend decoders or loaders.
35. **BatchedMesh.**
    **Fit:** freeze conflict (core batching). Revisit in v1.x.
36. **Lambert, Phong, Matcap, Normal and Depth materials, and per-material Toon.**
    **Fit:** the new materials package.
37. **Per-material render state** (blending, depthWrite, renderOrder).
    **Fit:** the new materials package.
38. **Light and skeleton helpers.**
    **Fit:** extend lines.
39. **Layers for rendering.**
    **Fit:** freeze conflict, small.
40. **Physical light units, IES and projector lights.**
    **Fit:** extend clustered.
41. **ArcballControls, StereoCamera and anaglyph.**
    **Fit:** extend controls; new package.
42. **Draco, EXR and KTX2 exporters.**
    **Fit:** extend exporters.
43. **Compute abstraction** (GPUComputationRenderer).
    **Fit:** new package. Raw device access already works.
44. **Placed light probes.**
    **Fit:** extend environment.
45. **LoadingManager and progress events.**
    **Fit:** extend `shared/loading`.
46. **Display-P3 or HDR canvas output.**
    **Fit:** freeze conflict.

Two scaling notes from reading core (not measured):

- **Instance buffer size.** Each unique core `Geometry` allocates an instance buffer sized to the full entity capacity: `capacity × 96` bytes on the GPU and the same on the CPU (`Engine.retain` in `packages/core/src/engine.ts`; `GPURenderer.add` in `renderer.ts`). At the maximum capacity of 100,000, that is about 9.6 MB per distinct geometry on each side. Scenes with many unique core meshes should be checked.
- **Geometry and entity caps.** Core caps `Geometry` at 1,000,000 vertices and engines at 100,000 entities. three.js has neither limit.

## Margo extras

These are not in three.js core or its official add-ons. Many have third-party three.js equivalents (noted), which matters for an honest comparison page.

- **Rendering:** cascaded PCSS shadows with a static-caster cache (shadows); clustered forward lighting for up to 1,024 lights (clustered); TAA with motion vectors (taa); Gaussian splats with GPU covariance projection, radix sort and spherical harmonics up to degree 3 (splats; cf. third-party splat viewers); geometry-clipmap terrain with triplanar layers (terrain); GPU particles (vfx, creative `GPUParticles`); a 100k-blade grass field and a planet renderer (creative); procedural night sky with moon (scenery); scene transitions (transitions); GPU scatter with distance LOD (scatter); device-loss recovery that rebuilds every plugin (`Engine.rebootDevice`).
- **Simulation and gameplay:** Rapier physics with a character controller (physics; cf. cannon-es or Rapier bindings); Recast/Detour navigation (navigation) and a dependency-free navmesh with A*, funnel paths and ORCA avoidance (navmesh; cf. three-pathfinding); sparse-set ECS (ecs); hierarchical state machine (fsm); snapshot interpolation for networking (net); semantic input with gamepad and haptics (input); tweening (tween); damped camera follow and shake (cinematic); animator blend trees and foot IK (animator).
- **Content generation:** procedural cabins, trees, rocks, humanoids, marching cubes and noise (procedural); 3D wave function collapse (wfc); spline roads (road); arc-length splines (splines).
- **Engineering and BIM:** STEP and IGES import through an OCCT worker, kinematics, capped section planes, metrology and exploded views (machinery); IFC through `web-ifc` (ifc).
- **Tooling and integration:** React bindings (react; cf. react-three-fiber); triangle BVH with a worker build (bvh; cf. three-mesh-bvh); SDF text from any browser font (text; cf. troika-three-text); entity inspector (inspector); Blender `.margo` offline asset pipeline (blender); Rust/Wasm transform and culling kernel (kernel); CAD camera controls and `fitToBoundingBox` in core.

Positioning caveats for a public page:

- fbx and usdz used to run three.js code at runtime (`FBXLoader` and `GLTFExporter`; the USDA and USDC parsers). Both now have native parsers; three.js is only a test-time reference.
- Several capabilities exist twice. html and labels both export `CSS3DObject`. gizmo and usdz-export are pure re-exports. There are two particle systems (vfx and creative), two toon paths, two bloom paths (post and creative), three sky or atmosphere implementations (sky, scenery and creative), and two navigation packages.

## How this was checked

- **Reading only.** This matrix comes from reading source code. No build, test, benchmark or browser was run while writing it, so no row is a statement that a feature works at runtime.
- **Line-by-line reading.** Core and the stage facade were read in full (`packages/core/src/*.ts`, `packages/margoengine/src/index.ts`). So were the gltf loader and most of gltf-pro, plus the parts of animation, animator, fbx, toon, the React environment adapter, the bvh raycaster, machinery's OBJ parser and creative's targets that the rows cite.
- **Rows marked †.** For these, the evidence is that the named exports exist, the source is non-trivial, the package README describes the behavior, and keyword searches across `packages/*/src` agree. The implementation itself was not audited line by line.
- **MISSING.** A row is MISSING when no matching class, function or keyword was found in any package's `src/`. README files and tests were not counted as implementation.
- **The three.js side.** The feature list comes from knowledge of three.js r186, its documentation (<https://threejs.org/docs/>) and `three/addons`. It was not re-checked against the r186 tag while writing.
- **Re-checking.** When a gap is closed, update its row and the counts in the Summary.
