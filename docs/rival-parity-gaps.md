# Rival parity gaps (2026-11-24)

What Margo still lacks against three.js r186 (core, add-ons and the examples gallery), Babylon.js 8.x, PlayCanvas 2.x
and the three.js ecosystem libraries users expect (drei, pmndrs postprocessing, three-mesh-bvh, troika, model-viewer,
Needle, Filament). Godot, Unity, Unreal and Blender are not the bar.

Built from four audits on 2026-11-24 (a second pass on 2026-11-25 added the "Second-pass audit" blocks; a third pass on 2026-11-26 went through the three.js examples gallery name by name and added the "Third-pass audit" blocks): the three.js examples gallery grouped into features, the Babylon.js docs, the
PlayCanvas manual plus the ecosystem libraries, and a code check of the 52 export-only rows of
[threejs-parity.md](threejs-parity.md). Every MISSING row was grepped in `packages/*/src` before it was listed. Rival
features come from documentation and example names only, never their source (clean room).

A finished row reads DONE in Status with its commit in Landed; a row found to exist already reads EXISTS with its evidence path.

Sizes: S under a day, M one to three days, L about a week, XL more.

## Not gaps after all (removed from the audit lists)

glTF `KHR_animation_pointer` (`animation/src/pointer.ts`), `KHR_interactivity` (`animation/src/interactivity.ts`),
async pipeline compile (core `createRenderPipelineAsync`), directional lightmaps (`lightmap/src/directional.ts`),
light-probe grids (`environment/src/probes.ts`, `lightmap/src/probes.ts`), dashed lines (`bvh/src/lines.ts`), the
shader node editor (`shader/src/editor.ts`), metaballs (`procedural/src/marching-cubes.ts`), point attractors
(`vfx/src/base.ts`), globe controls (`controls/src/globe.ts`), splat picking (`kit-viz/src/splats/pick.ts`).

## Lane A: post-processing and materials

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| ASCII effect | three.js, pmndrs | DONE | S | 12d7c41c5 |
| Radial / zoom blur | three.js | DONE | S | 9d6aa73d9 |
| Ramp, Grid, Depth view and texture overlay effects (`DepthTexture` already existed; `DepthView` builds on it) | pmndrs | DONE | S each | 7efaf1445 |
| Colour curves in image processing (`Grade` curves and wheels already existed; `ranges` added) | Babylon | DONE | S | 67827878e |
| Retroreflection material | three.js | DONE | S | 566dabc45 |
| glTF `KHR_materials_diffuse_roughness` | three.js | DONE | M | f9d753a54 |
| Material plugins on the stock PBR material (inject code into the built-in shader) | Babylon, three.js `onBeforeCompile` | DONE | M | b2757feeb |
| IBL shadows (shadows from the environment map) | Babylon | DONE | M | 363b2c8f2 |
| Blurred / rough planar and screen-space reflections (roughness cone with contact hardening: environment `contactHardening`, water `contactHardening`, SSR blur level) | three.js | DONE | M | 519453f01 |
| Caustics as a general package (today only inside water, studio, lightmap and the game bundle) | three.js, PlayCanvas | DONE: `@margoengine/post/caustics` `SurfaceCaustics` casts sun caustics from any surface mesh onto every opaque receiver; water/caustics draws with its shared beam and projection shaders; lightmap, react and water point at it | M | 90e3c5a51 |

### Second-pass audit (2026-11-25)

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Pepper's ghost hologram effect (four-view layout) | three.js | DONE (`@margoengine/cameras/hologram` `HologramOutput`) | S | 82030eff0 |
| Trail texture: pointer or object motion painted into a fading texture for displacement and reveal effects | drei | DONE (`@margoengine/post/trail` `TrailTexture`) | S | ae7e576ec |
| Kawase / dual-filter blur, 1D LUT, colour-average and depth-downsampling utility passes (`post/src/blur.ts` has one blur kind) | pmndrs postprocessing | DONE (`@margoengine/post/kawase-blur`, `/lut1d`, `/color-average`, `/depth-downsample`) | S each | 69b31fd94 |
| Custom per-instance attributes and bulk buffers: register extra per-instance data read by a material, set per instance or as a whole buffer, update in place (instances expose matrix, colour and UV transform only) | - | DONE (`@margoengine/materials/instance-attributes`: `f32` to `mat4x4f` and colour with defaults, read by material plugin WGSL; `set`, `setBuffer`, in-place `array` + `update`, `reset`; shadows follow; GPU cullers leave the rows in place; limits.md) | S to M | 8a3baa7e1 |
| Stencil portal masks as a one-call helper: several windows into other scenes, mask-and-contents pairs (raw stencil state exists) | drei `Mask`, `MeshPortalMaterial` | DONE (`@margoengine/materials/portal` `Portals`) | S | a870d4b33 |
| Node Render Graph runtime: data-driven, serializable pass graph (tasks declare inputs and outputs, persistent ping-pong textures, build then execute); the editor is in do-later.md | Babylon Frame Graph / Node Render Graph | DONE (`@margoengine/post/render-graph` `RenderGraph`; the editor is still in do-later.md) | M | 369f02cff |
| Image filter graph runtime: a node graph of image filters run on an image, video or camera input with no scene, and a block-merging optimizer that fuses passes | - | DONE (`@margoengine/post/filter-graph` `ImageFilterGraph`; the visual editor is out of scope) | M | 5fc4565b5 |
| Mesh blending post process: soften seams where separate meshes meet (rocks on terrain), per-mesh tag and radius, depth-slope rejection | Babylon | DONE | M | 021ad8daf (models and terrain 446c6819c) |
| Single-frame spatial upscaler (FSR 1 style edge-adaptive upscale plus sharpen) for devices without history (`taa/src/upscale.ts` is temporal) | Babylon | DONE | S | 0b6b5df04 |
| Mesh data debug view material (page read 2026-11-25): wireframe, vertex dots, both together, a checker on UV set 0 or 1 (colours, scale), vertex colours, a distinct colour per material id, plus a plain camera-lit shading mode. | - | DONE (`@margoengine/inspector/mesh-debug` `MeshDebugView`: wireframe, vertex dots, both, checker on UV set 0 or 1, vertex colours, material colours, camera-lit shading, over or in place of each picture) | S | a1c0d9476 |
| Colour Enhance and channel mixer in the grade: shadows/highlights/midtones, vibrance, dehaze, 3x3 RGB mixer | - | DONE (`@margoengine/tonemap/enhance` `ColorEnhance`: shadows, midtones, highlights, vibrance, dehaze, 3x3 RGB mixer) | S | a1c0d9476 |

### Third-pass audit (2026-11-26)

From the three.js examples gallery, example by example (names only).

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Per-instance morph target weights on instanced meshes: `SkinnedCrowd` holds every instance at the model's current weights and `VATCrowd` plays baked morph clips; no live weights per instance | three.js examples (`webgl_instancing_morph`, `webgpu_instancing_morph`) | DONE | M | d6d292747 |
| Batched mesh per-item frustum culling and LOD levels: `BatchedMesh` items carry a matrix, a colour and a visible flag only (`CulledModels` and `LODSystem` cover instanced models) | three.js examples (`webgl_batch_lod_bvh`) | DONE | M | 5e6b82ff6 |
| Draw a skinned or morphed mesh as points that follow the deformation (glTF POINTS primitives are skinned and `vfx` emits from a skinned surface; no option draws a triangle mesh as its vertices) | three.js examples (`webgpu_skinning_points`) | DONE | S | f8c292a91 |

## Lane B: particles, simulation and physics

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Solid Particle System (many meshes as one mesh, per-particle transform and colour, pickable) | Babylon | DONE | M | 86b898ed7 |
| Particle sub-emitters (spawn on birth, death, collision) | Babylon, PlayCanvas | DONE (death and collision EXISTS in `packages/vfx/src/events.ts`; birth added) | S to M | 0480e7a40 |
| Particle fluid solver (`ParticleLiquid` only draws particles today) | three.js, Babylon fluid rendering | PLANNED: FLUID-01 and FLUID-02 in [physics-solvers.md](physics-solvers.md) | L |  |
| Soft-body defects KB-SOFT-LIGHT1 and KB-SOFT-ITER1, plus a cloth render bridge | three.js, Babylon | DONE (KB-SOFT-LIGHT1, KB-SOFT-ITER1, cloth render bridge `@margoengine/gltf/soft-mesh`) | M | 0a4570d8e, d640a7242, 606261f00 |
| Breakable / fracturing bodies | three.js `physics_ammo_break` | PLANNED: BREAK-01 in [physics-solvers.md](physics-solvers.md) | M |  |
| Swappable physics plugin (one API over different engines) | Babylon physics v2 plugins | PLANNED: "Other engines as solvers", [physics-framework.md](physics-framework.md) section 5 | M |  |
| Floating-origin physics regions (large worlds without precision loss) | Babylon | PLANNED: "Large worlds", [physics-framework.md](physics-framework.md) section 2 | M |  |
| WebXR AR GPU depth occlusion (real objects hide virtual ones; only CPU depth today) | three.js, Babylon | EXISTS (`packages/xr/src/occlusion.ts`: CPU and `gpu-optimized` depth, `feather` soft edge, `npm run test:gpu:occlusion`; not yet run on a device) | M | 25c4bbbfe |
| WebXR AR reflection cube map from light estimation, as the environment's specular | three.js, Babylon | DONE (`@margoengine/xr/reflection`; not yet run on a device) | M | dbbd7fc7f |
| WebXR VR and AR passes, controller poses and XR layers not covered by the stand-in sessions | three.js, Babylon | DONE (`@margoengine/xr/session`: blend mode, visibility, frame rate, play-area bounds; layer `quality`, `blendTextureSourceAlpha`, `chromaticAberrationCorrection`, `mipLevels`. Multiview not built, see limits.md; not yet run on a headset) | M | 5f1f6ca25 |
| AR Quick Look and Scene Viewer launch where WebXR is absent | model-viewer | DONE (`@margoengine/xr/launch`: Quick Look `rel="ar"` link, Scene Viewer intent, fallback; URL scheme checks; not yet run on a phone) | S | 73d8e2269 |
| USDZ interactive behaviours (Quick Look tap and trigger actions in the USDZ exporter) | Apple AR Quick Look | DONE (`behaviors` option of `exportUSDZ`: tap trigger; emphasize, hide, wait and group actions, only values Apple's pages state; others listed in limits.md; not yet run in Quick Look) | M | 38e3af6bf |
| SVG from an engine scene (sciviz writes SVG from supplied geometry only) | three.js SVGRenderer | DONE (`@margoengine/sciviz/scene-svg`: meshes, lines and points through a camera, BSP painter's order, back-face culling, shading) | M | 640a0e630 |
| WebXR multiview (both eyes in one pass where the device and binding offer it, a view per eye otherwise) | - | BLOCKED: needs every drawing package and a browser that offers it (core change approved 2026-11-25/26, not made; checked 2026-11-26). Core's part fits: a measured prototype (`RenderView.multiview`, two frames in one 256 B uniform, `viewCount` on core's passes, a `FrameGraph.multiview` gate) took core + stage from 24,820 B to 24,943 B gzip with the WGSL rewrite and checks in `@margoengine/xr`, and 25,133 B with them in core. But every pipeline drawn in a multiview pass must declare the views (OVR_multiview2: a program whose `num_views` differs from the framebuffer is INVALID_OPERATION; gpuweb view-instancing proposal: each attachment a 2d-array view, `viewCount` on the pass), and 49 packages open their own render passes with their own camera uniforms (gltf, materials, sky, environment, shadows, post among them), so a gated single pass would serve only scenes of core meshes and every glTF scene would stay per eye. WebGPU: view-instancing is a draft proposal (gpuweb #4109, 2026-04-29); Edge 158 rejects `enable view_instancing;` even with unsafe-API flags. MSAA: WebGPU requires `depthOrArrayLayers` 1 when `sampleCount` > 1 and the proposal does not lift it, so desktop and headset scenes (4x) could not take it; WebGL2 has multisampled multiview only through OCULUS_multiview. Needs: the core part, multiview framebuffers and `num_views` program variants in `@margoengine/webgl2-compat`, and per-view cameras in each package that draws in the scene pass. `EyeViews` draws a view per eye meanwhile | XL |  |

### Second-pass audit (2026-11-25)

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Node Particle system: a whole particle system as a block graph (creation, emitter shape, update, random/gradient, triggers that start or chain systems) with JSON load (`vfx/src/nodes.ts` covers forces only) | Babylon Node Particle Editor | DONE | M | 8d00b3f47 |
| Near-interaction XR UI and behaviours: hand constraint, follow-in-view, surface magnetism, six-DoF drag, multi-pointer scale, app bar, holographic slate and near menu | Babylon | DONE | M | 660579824 |
| WebXR body tracking | Babylon | DONE | S | 9464e1394 |

## Lane C: scene, assets, text and formats

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Smart assets: a per-scene registry mapping stable string keys to asset URLs, with load, unload, reload and swap by key (a texture swap rebinds existing materials), a JSON asset map that loads from URL, file or object and serialises back, and a missing-asset callback that can return a replacement URL or file | Babylon Smart Assets | DONE (`AssetRegistry` of `@margoengine/scene/assets`: a swap reaches material textures through `subscribe`, where the app assigns the new texture; the registry holds no materials) | M | 861843398, 87a4f6781, 6a9c1b925 |
| Asset containers: load, add, remove and duplicate a set of objects as one unit, plus scene save and load | Babylon | DONE (scene save and load already existed: `save/src/engine.ts`) | M | f19d13852 |
| Layer sort modes (back-to-front, front-to-back, manual) | PlayCanvas | DONE (`setMaterialSortModes`: per engine, opaque and transparent material meshes) | S | 8aaf6a290 |
| Blob shadow and planar `ShadowMesh` | three.js, drei | DONE (`@margoengine/materials/fake-shadows`; pixels checked on WebGPU and the WebGL2 layer, `features-browser.mjs fakeShadows`) | S | 196b41134, 2ed1a656d |
| drei helpers: Float, Center, Resize, ScreenSizer, interaction prompt | drei, model-viewer | DONE (`@margoengine/scene/helpers`) | S each | b83eba2dc |
| Font formats: WOFF and WOFF2, CFF `.otf`, GPOS kerning | three.js TextGeometry, troika | DONE | M | d2f0084e2 |
| Configurable `loadTexture` caps (fixed at 16.7 MP and 64 MiB) | three.js | DONE (`maxBytes`, `maxPixels`; cube maps and restore take them too, cd259602f, e1c8eff03) | S | 8aaf6a290 |
| 3MF textures, texture `center` on the texture, live metaball object | three.js | DONE: texture `center` (`uvTransform.center`) and live metaball (`Metaballs`) 3642ec0b1; layered `multiproperties` textures: `parse3MFMaterials` keeps every layer of a stack (`groups[].layers`, `layerColor<k>`/`layerUV<k>` attributes, mix and multiply) and `create3MFMesh` (`@margoengine/loaders/threemf-mesh`) draws it through `layered()` (which gained `blend: multiply`), checked against the 3MF Consortium's samples on WebGPU and the WebGL2 layer | S each | 2ed1a656d |
| Webcam / MediaStream texture outside React | three.js | EXISTS: `new Texture(video)` takes any HTMLVideoElement (`packages/materials/src/built-material.ts`, live upload per frame), and `prepareVideo` accepts a video whose `srcObject` is a getUserMedia stream (`packages/video/src/playback.ts`); no React needed | S |  |
| Stale docs: cloth, caustics and the mesh path tracer still marked NOT PLANNED in [threejs-parity.md](threejs-parity.md); its MISSING 0 count; the "Not yet" section of [from-threejs.md](from-threejs.md) | — | DONE | S | 1525aff1e |

### Second-pass audit (2026-11-25)

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| MMD loader: PMD/PMX models plus VMD motion and camera clips (no physics) | three.js | DONE (`parsePMD`, `parsePMX`, `parseMMD`, `parseVMD`, `sampleVMDBone` of `@margoengine/loaders/mmd`; rigid bodies and joints are data only, never simulated) | M | c47d27afe |
| DirectX `.x` loader (text and binary, skin and animation sets) | three.js | DONE (`parseX` of `@margoengine/loaders/xfile`; compressed `tzip` and `bzip` files are refused as unsupported) | M | 55fe7dd90 |
| Tilt Brush `.tilt` loader (brush strokes as ribbons) | three.js | DONE (`@margoengine/loaders/tilt`) | S | 004c621ab |
| PRWM loader (packed binary mesh) | three.js | DONE (`@margoengine/loaders/prwm`) | S | 004c621ab |
| RGBM, LogLuv and HDR-JPG texture loaders (Ultra HDR gain maps exist) | three.js | DONE (`@margoengine/environment/encoded-hdr`; HDR-JPG is the existing gain-map decoder, now also `decodeHDRJPG`) | S | d49bcdff4 |
| G-code exporter (toolpath from a mesh or lines; the G-code loader exists) | three.js | DONE (`@margoengine/exporters/gcode`) | S | b3bf73bcb |
| Depth-video point cloud (RGB plus depth video to points) | three.js | DONE (`@margoengine/points/depth-video`) | S | 146657294 |
| Parametric surface presets (Klein bottle, Mobius strip, torus-knot variants) on the generic `geometry/src/parametric.ts` builder | three.js | DONE (`@margoengine/geometry/extras`: Klein bottle, Möbius strip, knots) | S | 65bd2d5d3 |
| Node Geometry runtime: serializable graph (sources, setters, instantiate on vertices/faces, conditional, noise, merge, material id) that builds a mesh, JSON in and out; the editor is in do-later.md | Babylon Node Geometry | DONE (`GeometryGraph`, `buildGeometryGraph`, `parseGeometryGraph` of `@margoengine/geometry/node-graph`; no editor) | L | 688590050 |
| Scene change recorder: track edits to a loaded scene and save or re-apply them as a small JSON delta (prefab overrides exist) | Babylon delta files | DONE (`@margoengine/save/delta`) | S to M | 0d5b43853 |
| Asset task queue: typed tasks with per-task success/error, progress, retry and an all-done event | Babylon AssetsManager | DONE (`@margoengine/scene/assets`) | S | 861843398 |
| `.babylon` scene import | Babylon | DONE (`parseBabylon`, `flattenBabylon` of `@margoengine/loaders/babylon`; meshes, shared geometries, instances, standard and PBR materials, cameras, lights, skeletons, node animation; the exporter was removed on 2026-11-26, Margo writes no rival format) | S to M | 8df1341a1 |

### Third-pass audit (2026-11-26)

From the three.js examples gallery, example by example (names only).

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| COLLADA kinematics: joints with axes and limits bound to scene nodes, so a loaded model is posed by joint value (`parseDAE` reads geometry, skins, morphs and keyframes) | three.js examples (`webgl_loader_collada_kinematics`) | MISSING | S to M |  |
| City generator: streets, blocks and lots filled with rule-built buildings in one call (`generateBuilding` and road graphs exist separately) | three.js examples (`webgpu_generator_city`) | PARTIAL | M |  |

## Lane D: tools, runtime and interaction

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Script component system (attributes, lifecycle hooks, hot reload) | PlayCanvas, Needle | DONE | L | b95470338 |
| Occlusion query API for apps (only internal in voxel-pathtracer; Hi-Z culling exists) | three.js, Babylon | DONE | M | 3a95eb3b7 |
| Mesh path tracer: instancing, skinning, emissive triangles, alpha blend, `/mesh-pbr` README | three-gpu-pathtracer | DONE | L | README 4f7780bf7, BLEND eb57207ea, skinned poses 8ce7e3e8d; instancing EXISTS (d34b3de1c, src/mesh-instances.ts), emissive triangles EXISTS (adc7807e5, src/mesh-light-build.ts) |
| Raycaster current-pose hits on skinned meshes (sync), Line and Points thresholds | three.js | DONE | M | 99d42804c (thresholds EXISTS: packages/bvh/src/scene.ts, packages/bvh/src/points.ts) |
| Greased Line: per-point width and colour | Babylon | DONE | S | 61f3dcf3f (colorMode; per-point colour and width EXISTS: packages/lines/src/line.ts, packages/lines/src/stroke.ts) |
| Geospatial camera with terrain collision and geo maths | Babylon | DONE | M | 56d8616c4 (WGS84/ECEF/ENU EXISTS: packages/tiles/src/wgs84.ts, now backed by math/geo) |
| Gaussian splat part visibility and compound mode, interactive splat editing | Babylon, PlayCanvas | DONE | M to L | b78b414f5 (SplatEditSession, packages/splats/src/session.ts); compound EXISTS packages/splats/src/set.ts, brush EXISTS packages/splats/src/brush.ts, visibility 5fee46878 |
| Voice chat and screen share over the netcode WebRTC transport | Needle | DONE | M | 8092aaee6 |
| WebGL2 layer: voxel and mesh path tracers on ANGLE D3D11 (Safari, Firefox, phones and the integrated-GPU frame budget recorded as not yet measured in [limits.md](limits.md)) | three.js WebGLRenderer, Babylon WebGL2 | DONE | L | 508b6c1cc (warm draw restored), 7144a4fc0 (no synchronous query behind a warm compile); `test:gpu:d3d11` and `test:gpu:mesh-pbr` pass on an Intel Arc 140V, Chrome 157. The serial draw-time fxc compile left is ANGLE's (KB-L5a-10) |

### Geospatial camera: best in open source

Scott, 2026-11-25: most demos are open world, so `@margoengine/controls/geospatial` must beat every open-source
geospatial camera. Rivals are judged by their public docs and feature lists only.

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| 1. Surface-true picking: zoom-to-cursor, rotate-around and pan grab the real surface hit (BVH on terrain, tiles, meshes), anchored drag | CesiumJS, 3D Tiles renderer GlobeControls, Google 3D map controls | DONE | M | 5f77e327e |
| 2. Collision of the whole near plane against terrain, tiles and meshes; minimum clearance; underground mode; collision while flying and during flyTo | CesiumJS, Babylon geospatial camera | DONE | M | 4840d19ed |
| 3. Navigation modes with smooth switches: globe orbit, local orbit, first-person fly, walk/drive with ground following, top-down map, cinematic path | CesiumJS, deck.gl views, Google 3D map controls | DONE | L | 5326d5a78, 76a197eea |
| 4. flyTo on the van Wijk and Nuij 2003 optimal path, duration from distance, easing, AbortSignal, cancel on input; flyToBoundingSphere, fit-to-bounds | CesiumJS, MapLibre GL `flyTo`, deck.gl `FlyToInterpolator` | DONE | M | 5467c80bc |
| 5. Feel: per-axis inertia, height-scaled speed, presets (Cesium-like, map-like, CAD/DCC), touch, keyboard, gamepad, pen, reduced motion | CesiumJS, MapLibre GL, Google 3D map controls | DONE | M | 5624db24f, 5745639a1 |
| 6. Planet scale: near/far and depth from street level to orbit with the floating origin, no jitter at large coordinates | CesiumJS, 3D Tiles renderer | DONE | M | ca5622c5b |
| 7. Heights above terrain, ellipsoid and geoid; ENU heading/pitch/roll; north-up reset; compass and state events; view save/restore with a URL hash | CesiumJS, MapLibre GL hash, Google 3D map controls | DONE | M | 8b5326f27, 91b0069ac |
| 8. Works out of the box with terrain, tiles (a tiles height query) and biomes open worlds, zero config | CesiumJS, 3D Tiles renderer | DONE | M | 97e4fb1ac, cfe43df33, 41038a41f (EGM96 grid file pending: see docs/limits.md) |
| 9. Follow camera for moving targets (chase, orbit-follow, side, flyby, lock-on with lead room, flock framing), critically damped springs, banking, surface clearance, built on third-person | CesiumJS `trackedEntity`, Babylon `FollowCamera` | DONE | L | 8905f1eb5 |

### Second-pass audit (2026-11-25)

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Webcam face tracking driving morph targets (landmarks to ARKit-style blendshapes, webcam driver) | three.js, drei `FaceControls`/`FaceLandmarker` | DONE | L | 71b195b94 (source 588842f8f) |
| Webcam hand and pose landmarks from a camera stream outside WebXR, for AR and body overlays | drei, MediaPipe examples | DONE | L | 24e6efcad (source 588842f8f) |
| Tube painter for freehand 3D strokes (pointer or XR controller paint) | three.js | DONE (`TubePainter`, `@margoengine/lines/tube-painter`) | S | 3b1a571bb |
| Infinite shader grid with cell and section sizes and distance fade (`GridHelper` is finite) | drei `Grid` | DONE (`@margoengine/lines/infinite-grid`) | S | f144ef66b |
| Shadow map viewer: debug view of cascade, spot and point shadow maps | three.js | DONE | S | e639b3ed9 |
| Light probe helper and positional-audio cone helper | three.js | DONE | S | d0dfc71e1 |
| Raycaster helper (ray and hits) and BVH tree visualiser with a depth slider | three.js, three-mesh-bvh | DONE (`@margoengine/lines/tree-helpers`: `RaycasterHelper`, `BVHHelper`) | S | 312af62b9 |
| Octree helper for `points/src/octree.ts` | three.js | DONE (`@margoengine/lines/tree-helpers`: `OctreeHelper`) | S | 312af62b9 |
| Cycle raycast: repeat a pick to step through overlapping hits | drei | DONE (`CycleRaycast`, `@margoengine/selection`) | S | 29bb42e10 |
| Bounding-box anchor: HTML or a label pinned to a box corner or face | drei `BBAnchor` | DONE (`boxAnchorPoint`, `@margoengine/labels`) | S | 9cf6c56f0 |
| Declarative action manager: triggers on a node (pick, long pick, pointer over/out, intersect enter/exit, every frame, keys) with chained actions | Babylon ActionManager | DONE | S to M | fdc511bde |
| Orbit camera behaviours: elastic bounce at radius limits, idle auto-rotation, animated framing of a mesh | Babylon camera behaviors | DONE (`OrbitBehaviors`, `@margoengine/controls/behaviors`) | S | 05ced2d88 |
| Hotspot on a deformed mesh: a fixed point inside a triangle of a skinned or morphed mesh, projected to screen | Babylon Hotspot | DONE (`Hotspot`, `@margoengine/labels`) | S | 9d2ff0cb9 |
| Coroutines (page read 2026-11-25): a generator stepped once per frame; a bare `yield` waits one frame, yielding a promise waits for it, yielding another coroutine's promise waits for that coroutine; an async run form returns a promise that resolves on completion and rejects on cancel | Babylon | DONE (`Coroutines`, `@margoengine/ecs/coroutines`) | S | 3ddcd1643 |
| Single-file / playable-ad publish: one inlined HTML with scripts, Wasm and assets, ad-network size budgets and MRAID hooks | PlayCanvas | DONE (`margo-convert playable`, `margo-convert/playable`, `margo-convert/playable-runtime`) | M | 48d01e498 |
| Mobile app wrapper publish (Capacitor-style project from a built scene, safe area and orientation) | PlayCanvas | DONE (`margo-convert mobile`, `margo-convert/mobile`, `margo-convert/mobile-runtime`) | M | 1ec57ee7b |

### Third-pass audit (2026-11-26)

From the three.js examples gallery, example by example (names only).

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Occluder fade: find the meshes between the camera and a target and dither them out, then back in (the dither fade of `@margoengine/lod` and the selection x-ray exist; nothing finds the occluders) | three.js examples (`webgpu_tsl_occlusion_dither`) | DONE | S | eec7eb93d |
| Transform gizmo driven by an XR controller ray (`TransformControls` takes DOM pointer events and screen points only; XR has rays, grab and drag) | three.js examples (`webxr_xr_controls_transform`) | DONE (`@margoengine/xr/gizmo` `XRGizmo` and `GizmoRayDriver`; not run on a headset) | S | 7c5ce6388 |

## Needs a maintainer decision or hardware first

| Gap | Why it waits | Size |
| --- | --- | --- |
| WebXR VR and AR, XR passes, controller poses, XR layers | Being built by lane B without a device (Scott, 2026-11-25: "Anything that's waiting on hardware, just build it, push it to main, and assume that it works") | M |
| Deferred shading, voxel cone-traced GI | NOT PLANNED by decision; clustered forward and probes plus SSGI instead | XL |
| Snapshot rendering: record a static scene's draw commands once and replay them (render bundles) | Needs core (frozen): ask Scott | M |
| Dual-source blending (SRC1 colour and alpha blend factors) on materials | Needs a core blend-state option (frozen): ask Scott | M |
| Multi-draw: many sub-draw ranges of one merged mesh in one call, with per-range show/hide | Needs a core draw API (frozen): ask Scott | M |

The visual scene editor, several canvases on one device and the visual flow-graph editor are in
[do-later.md](do-later.md), out of every current list (Scott, 2026-11-25).

The four audit tables behind this list (evidence paths per row) were working files and are not kept; rerun the audits
from this page's rows when it is next checked.
