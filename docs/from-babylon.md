# Coming from Babylon.js

A guide for Babylon.js developers. It maps the concepts you know (engine, scene, camera, mesh, material, lights,
loaders, animation, physics, post-processing, input, GUI) to Margo, says where the conventions differ, and lists the
pitfalls that cost people an afternoon. Where Margo has no equivalent, the guide says so; the list is in
[Not yet](#not-yet). The shape follows [Coming from three.js](from-threejs.md), which covers more of the same ground
for that library.

Every task below has a small runnable page in [`examples/from-babylon/`](../examples/from-babylon/index.html). Each
source file opens with a few lines on what the usual Babylon.js code for that task does, then the Margo code. Run them
from the repository root:

```sh
npm run build:packages
npm run dev:examples
# http://127.0.0.1:5173/examples/from-babylon/index.html
```

<!-- Every ```ts block in this file uses only names that exist in the built packages. The ambient names engine, canvas,
     mesh and model are the ones the other guides use. ```js blocks are Babylon.js and are not checked. -->

## Contents

- [What is different](#what-is-different)
- [Units, handedness and conventions](#units-handedness-and-conventions)
- [Install only what you import](#install-only-what-you-import)
- [API mapping](#api-mapping)
- [Engine, scene and camera](#engine-scene-and-camera)
- [Meshes and PBR materials](#meshes-and-pbr-materials)
- [Lights and shadows](#lights-and-shadows)
- [Loading glTF](#loading-gltf)
- [Animation](#animation)
- [Picking](#picking)
- [Post-processing](#post-processing)
- [Input and camera controls](#input-and-camera-controls)
- [Physics](#physics)
- [GUI and labels](#gui-and-labels)
- [Loading a .babylon file](#loading-a-babylon-file)
- [Common pitfalls](#common-pitfalls)
- [Not yet](#not-yet)

## What is different

- **WebGPU first.** Core renders with WebGPU. The WebGL2 fallback is the optional `@margoengine/webgl2-compat` layer; the
  small `@margoengine/webgl2-compat/preview` fallback draws core meshes only. Babylon.js has separate `Engine` (WebGL)
  and `WebGPUEngine` classes; Margo has one `Engine`, with `engine.backend` telling you which backend it got, and most
  optional packages need WebGPU.
- **One engine, one implicit scene.** There is no `new Scene(engine)` to pass around. `Engine.create(canvas)` (or the
  stage facade's `createStage`) owns the canvas, the camera and the scene. Meshes come from `engine.createMesh()` (or
  `stage.box()` and friends). Extra scenes exist for overlays such as a HUD ([hud-preview](../examples/hud-preview.html)),
  not as the main way to work.
- **Features are plugins you attach.** Shadows, clustered lights, post effects, controls, picking and physics are
  objects you create with one form, `Feature.attach(engine, options)`. There is no `scene.createDefaultXRExperience`
  style helper that wires many things; you attach what you use. Everything disposable has `dispose()`; package objects
  also have `[Symbol.dispose]`, so `using` works.
- **Small core, optional packages.** Core plus the stage facade is about 21 kB gzip (`npm run measure:size` prints the
  figure). Everything else (glTF with textures, shadows, post, physics, GUI) is a separate package you install and
  import only when you use it, so a bundler drops what you leave out. Babylon.js's per-feature imports from
  `@babylonjs/core/...` play a similar role.
- **Tuples, not classes.** Positions, directions and colours are plain arrays (`[x, y, z]`, `'#rrggbb'`). `mesh.position`
  is a live `{x, y, z}` view with `set`, not a `Vector3`. A Babylon-shaped math library exists in `@margoengine/math`
  (`Vector3`, `Matrix4`, `Quaternion`, `Color`, `Box3`) and converts with `toArray()`.
- **The camera is a position and a target.** There is one core camera, `engine.camera`, with `position`, `target`,
  `fov`, `near`, `far` and `up`. "ArcRotateCamera" and "FreeCamera" are behaviours you add with controls
  (`OrbitControls`, `FlyControls`, ...), not camera classes.
- **No Observables.** Babylon's `onBeforeRenderObservable`, `onPointerObservable` and `onKeyboardObservable` map to
  `engine.onFrame` (or `stage.onTick`), the browser's own pointer and key events on `engine.canvas`, and the `Input`
  package. Controls and other objects use the standard `addEventListener`.
- **Resize and pixel ratio are automatic.** The engine sizes its drawing buffer from the canvas's CSS size every frame.
  There is no `engine.resize()` call to make. Desktops render with 4x MSAA at pixel ratio 1, phones single-sampled at up
  to 2; `@margoengine/quality` picks a lighter tier on slow GPUs.
- **Two levels of mesh.** A core mesh is a geometry with a constant PBR material, and equal geometries are instanced
  for you. Textured meshes and glTF models are drawn by `@margoengine/materials` and `@margoengine/gltf/pbr`. Shadows,
  clustered lights and SSAO light core meshes on their own; glTF models and materials meshes join a feature with
  `feature.add(model)`.

## Units, handedness and conventions

| | Babylon.js | Margo |
| --- | --- | --- |
| Handedness | Left-handed by default (`scene.useRightHandedSystem` flips it) | Right-handed, always. There is no switch |
| Up axis | +Y | +Y |
| Units | Unitless; most assets treat 1 as a metre | Metres. glTF's conventions apply: Y up, right-handed, camera looks down -Z |
| Rotation | `mesh.rotation` is Euler in YXZ order; `rotationQuaternion`, when set, takes over | `mesh.rotation` is Euler XYZ in radians; `setQuaternion([x, y, z, w])` sets a quaternion |
| Field of view | `camera.fov` in radians, vertical, default 0.8 | `engine.camera.fov` in degrees, vertical, default 60 |
| Clip planes | `minZ` default 1, `maxZ` default 10000 | `near` default 0.1, `far` default 1000 |
| Colours | `Color3` floats; Standard colours are displayed as written, PBR colours are linear | `'#rrggbb'` strings are sRGB and converted to linear; number arrays are linear RGB. Output is tone mapped and sRGB-encoded for you |
| Directional light direction | The way the light travels | The direction **toward** the light (the sun's position, not its heading) |
| Texture V | `invertY` is true by default | glTF's UV convention (image rows run top to bottom). `parseBabylon` keeps each texture's `invertY` so you can tell which convention a file used |
| Back-face culling | On for StandardMaterial by default | `PbrMaterial` is double-sided by default; set `doubleSided: false` for culling |
| Frame time | `engine.getDeltaTime()` in milliseconds | `delta` in seconds |

Handedness is the one that bites. A scene that works in Babylon.js with its camera at `z = -10` looking toward +Z
needs its Z mirrored to land correctly in Margo. Three tools do it for you:

- `parseBabylon` (below) mirrors Z for you, in positions, normals, placements, cameras and lights, and flips each
  triangle's winding. `rightHanded: false` keeps the file's numbers.
- glTF files need nothing: glTF is right-handed Y-up, and Babylon.js's glTF loader mirrors it into its own space with a
  root node. Margo loads the file as written.
- Code you port by hand: negate Z in positions, normals and directions, and swap each triangle's winding. For a
  quaternion `[x, y, z, w]` the mirrored value is `[-x, -y, z, w]` (what the loader does). Babylon.js Euler angles use
  YXZ order and Margo's use XYZ, so convert through a quaternion when a mesh turns about more than one axis.

## Install only what you import

There are three ways in: `@margoengine/core` or `@margoengine/stage` alone, a domain install profile, or
`margoengine` for every feature. The [kits guide](guides/kits.md) has the routes that work today (publication is
pending). The examples in this guide import from `margoengine/...`, the full install; with a profile, replace
`margoengine/controls` with `@margoengine/kit-web/controls`, or import `@margoengine/controls` directly.

```sh
npm install @margoengine/core                    # engine, camera, meshes, constant PBR material
npm install @margoengine/stage                   # the createStage facade plus core
npm install margoengine                          # every feature package
```

These commands work once 1.0.0 is published to npm; the packages are not on npm yet. Until then, build them from a
checkout and use the routes in the [kits guide](guides/kits.md).

## API mapping

Names in the Margo column exist in the built packages; the examples run them. "None" means Margo has nothing equivalent
(see [Not yet](#not-yet)).

### Engine, scene and camera

| Babylon.js | Margo | Notes |
| --- | --- | --- |
| `new Engine(canvas)`, `new Scene(engine)` | `Engine.create(canvas, options)` (`@margoengine/core`); `createStage(selector, options)` (`margoengine`) | `createStage` also makes the canvas, adds orbit controls and starts the loop |
| `engine.runRenderLoop(...)` | `engine.start()` | `createStage` starts it. `engine.dispose()` stops it |
| `engine.resize()` | Nothing to call | Sized per frame from the CSS size |
| `scene.onBeforeRenderObservable` | `engine.onFrame((time, delta) => ...)`, `stage.onTick(delta => ...)` | Seconds, not milliseconds |
| `scene.clearColor` | `createStage('#scene', {background: '#cfe3f2'})`, `ColorBackground` (`margoengine/environment`) | `ColorBackground` takes a second colour for a gradient |
| `ArcRotateCamera`, `FreeCamera`, `UniversalCamera` | `engine.camera` plus `OrbitControls`, `FlyControls`, `FirstPersonControls`, `WalkControls` | See [Input and camera controls](#input-and-camera-controls) |
| `camera.setTarget(v)`, `camera.position` | `engine.camera.target = [..]`, `engine.camera.position = [..]` | Assign a new tuple |
| `camera.zoomOn(meshes)`, `framingBehavior` | `engine.camera.fitToBoundingBox(min, max, {duration})`, `stage.fit()` | |
| `camera.mode = ORTHOGRAPHIC_CAMERA` | `@margoengine/cameras` | `camera.up` gives exact top-down views |
| `scene.activeCameras`, `camera.viewport` | `engine.views = [{camera, viewport: [x, y, w, h], scissor?, layers?}]` (core `RenderView`), or `engine.render({views})` | Fractions of the canvas by default, `pixels: true` for pixels. See the [split-screen](../examples/split-screen.html) and [minimap](../examples/minimap.html) examples. `StereoRig` and `HologramRig` (`@margoengine/cameras/stereo`, `/hologram`) build the views for stereo and four-sided displays |
| `mesh.layerMask`, `camera.layerMask` | `setRenderLayers(mesh, mask)`, `setCameraLayers(camera, mask)`, `layerMask(...layers)` (`margoengine/cameras/layers`) | 32-bit masks as in Babylon.js; a view's own `layers` wins. Picking takes `layers` too (`SpatialPickingOptions`, `AreaPickingOptions`) |
| `Tags.AddTagsTo`, `scene.getMeshesByTags` | `tags(mesh).add('enemy')`, `findByTag(engine.scene, 'enemy')`, `queryTags(scene, 'a && !b')` (`margoengine/scene/tags`) | `TagSet` is an `EventTarget`: it fires `add`, `remove` and `change` |
| `scene.dispose()`, `engine.dispose()` | `stage.dispose()`, `engine.dispose()` | Disposes every plugin, model and control |

### Meshes, materials and textures

| Babylon.js | Margo | Notes |
| --- | --- | --- |
| `MeshBuilder.CreateBox`, `CreateSphere`, `CreateCylinder`, `CreatePlane`, `CreateTorus`, `CreateTorusKnot` | `boxGeometry`, `sphereGeometry`, `cylinderGeometry`, `planeGeometry`, `torusGeometry`, `torusKnotGeometry` (`@margoengine/geometry`); `stage.box()`, `stage.sphere()` | Arguments are positional, with Babylon-like defaults; they return typed arrays, and `toGeometry` hands them to core |
| `CreateCapsule`, `CreateDisc`, `CreatePolyhedron`, `CreateLathe`, `CreateTube`, `ExtrudeShape` | `capsuleGeometry`, `circleGeometry`, `polyhedronGeometry`, `latheGeometry`, `tubeGeometry`, `extrudeGeometry` | `sweepGeometry` and `loftGeometry` cover shape extrusion along paths; `parametricGeometry` any surface. There is no `CreateRibbon` by that name |
| `MeshBuilder.CreateDecal` | `decalGeometry` | |
| `Mesh.MergeMeshes` | `mergeGeometries` | |
| `CSG`, `CSG2` | `booleanMeshesExact(a, b, 'union' \| 'difference' \| 'intersection')` (`margoengine/mesh-edit/boolean-exact`); `batchBooleanMeshes` for many inputs (`/boolean-batch`) | Triangle-mesh booleans on mesh-edit's `PolygonMesh`; `toPolygonMesh` and `fromPolygonMesh` (`margoengine/mesh-edit/geometry`) convert a core `Geometry` in and out. `boolean` in `@margoengine/brep` is the CAD solid kernel |
| `TransformNode`, `mesh.parent = node` | `engine.createMesh()` without geometry; `mesh.setParent(node)` | |
| `mesh.position`, `mesh.scaling`, `mesh.rotation` | `mesh.position`, `mesh.scale`, `mesh.rotation` (live views), `setPosition`, `setScale`, `setRotation`, `setQuaternion` | |
| `mesh.isVisible`, `setEnabled(false)` | `mesh.visible = false` | |
| `mesh.createInstance()` | Share a `Geometry`; core instances it | Each instance is a full mesh. `createInstancedMesh` for many textured instances |
| `thinInstanceSetBuffer` | `createInstancedMesh` (`@margoengine/materials`) | One draw, per-instance matrix, tint and atlas region |
| `mesh.addLODLevel` | `LODSystem` (`@margoengine/lod`) | Distance or screen-size levels, octahedral imposters |
| `scene.meshes` | `engine.scene.meshes` | A collection of the scene's meshes |
| `StandardMaterial` | `PbrMaterial`, or Lambert and Phong materials in `@margoengine/materials` | |
| `PBRMaterial`, `PBRMetallicRoughnessMaterial` | `PbrMaterial({color, metalness, roughness, map, normalMap, emissive, ...})` | Colour-only works in core; maps need `@margoengine/materials` |
| `albedoColor`, `metallic`, `roughness` | `color`, `metalness`, `roughness` | |
| `Texture(url)`, `DynamicTexture` | `loadTexture(url)`, `new Texture({data, width, height})` | Texture options `wrapS` and `wrapT`. Painting textures: materials README |
| `uScale`, `vScale`, `uOffset` | `material.setUVTransform({scale, offset})` | |
| `MultiMaterial` and sub-meshes | Meshes with material groups (`@margoengine/materials`) | |
| `NodeMaterial`, Node Material Editor | `@margoengine/shader` (`NodePass`, node materials in code) | No graphical editor |
| `ShaderMaterial` | Node materials and WGSL in `@margoengine/shader` | WGSL, not GLSL ([porting-glsl](porting-glsl.md)) |
| `mesh.dispose()`, `material.dispose()` | `mesh.dispose()`; `material.dispose()` on a materials `Material`; `texture.dispose()` | |

### Lights, shadows and environment

| Babylon.js | Margo | Notes |
| --- | --- | --- |
| `DirectionalLight` | `engine.scene.lighting.direction.set([x, y, z, strength])` | Core's one sun. Points **toward** the light |
| Several `DirectionalLight`s | `DirectionalLights.attach(engine, {lights}).setLights([{direction, color, intensity, castShadow}])` (`margoengine/clustered/directional`) | Up to 16, four with shadows (`LocalShadows`). Here `direction` is the way the light **travels**, as in Babylon.js. Runnable: [`10-more-suns`](../examples/from-babylon/10-more-suns.html) |
| IES profiles on lights | `IESLights`, `parseIES` (`margoengine/clustered/ies`) | |
| `HemisphericLight` | `lighting.radiance.set([r, g, b, ambient])`; `HemisphereLight` (`margoengine/environment`) | `HemisphereLight` has separate sky and ground colours |
| `PointLight`, `SpotLight` | `Clustered.attach(engine)` then `setLights([...])` | Up to 1,024 by default; range in metres |
| `ShadowGenerator`, `addShadowCaster` | `Shadows.attach(engine, {resolution})`, `shadows.add(mesh)` | Cascaded, soft edge by default |
| `CascadedShadowGenerator` | Same `Shadows`; `cascades` option, 1 to 4 | Four by default |
| Point and spot shadows | `LocalShadows` (`@margoengine/clustered/shadows`) | |
| `mesh.receiveShadows` | Core meshes receive automatically | `shadows.add(mesh, {castShadow: false})` for receive-only |
| `scene.environmentTexture`, `CubeTexture`, `HDRCubeTexture` | `Environment.attach(engine, image)`, `EnvironmentLighting.attach(...)` (`margoengine/environment`) | Reads `.hdr`, `.exr`, UltraHDR |
| `createDefaultSkybox`, `Skybox` | `Environment` background, `Sky` (`margoengine/sky`) | |
| `scene.fogMode`, `fogDensity` | `Fog.attach(engine, {near, far})` or `{density}` | Height fog too |
| `MirrorTexture`, `ReflectionProbe` | The `/reflector` and `/cube-camera` entries of `@margoengine/environment` | |
| `VolumetricLightScatteringPostProcess` | `VolumetricFog` (`margoengine/environment/volumetric`) | |
| `RectAreaLight` | `@margoengine/clustered/area` | |

### Loading, animation and interaction

| Babylon.js | Margo | Notes |
| --- | --- | --- |
| `SceneLoader.ImportMeshAsync`, `Append`, `LoadAssetContainerAsync` (glTF) | `loadGLTF(engine, url, {signal})` (`margoengine/gltf/pbr`) | Returns a `PBRModel`; `model.root`, `model.bounds`, `model.nodes` |
| `AssetsManager` | `Promise.all` over `loadGLTF`; `AssetCache` (`margoengine/cache`) for offline | |
| Progressive loading | `loadGLTFProgressive` (`margoengine/gltf/progressive`) | |
| Draco, KTX2, Meshopt | `@margoengine/decoders` | Passed in only when a file needs them |
| `.obj`, `.stl`, `.ply`, `.fbx`, `.usdz` | `@margoengine/loaders`, `@margoengine/fbx`, `@margoengine/usdz` | |
| `.babylon` | `parseBabylon`, `flattenBabylon` (`@margoengine/loaders/babylon`); import only, Margo does not write `.babylon` (export glTF instead) | [Below](#loading-a-babylon-file) |
| Cloth and soft bodies, drawn | `drawSoftBody(engine, body, {material})` (`margoengine/gltf/soft-mesh`) on a `@margoengine/physics/soft` body | |
| `AnimationGroup`, `scene.animationGroups` | `Animation.attach(model)`, `animation.clips`, `animation.play(name)` | `playing`, `seek`, `loop`, `speed` |
| Animation blending, weights | `Animator.attach(animation, {...})` (`margoengine/animator`) | State machines, blend trees, additive layers, foot IK |
| `new Animation(...)` keyframes | `createKeyframeClip` (`margoengine/animation`); `@margoengine/tween` | Tweens: `Timeline`, `Spring`, easings, `to`, `from`, `fromTo` |
| `MorphTargetManager` | `animation.setMorph(nodeIndex, targetIndex, weight)` | |
| `Skeleton`, bones | glTF skins, driven by `Animation` | `Retarget` and `cloneModel` in `@margoengine/animation/skeleton-utils` |
| `scene.pick`, `pickWithRay` | `Picking.attach(engine)` then `await picking.pick(x, y)`; `Raycaster` (`margoengine/bvh`) | Picking is asynchronous. CPU rays are `Raycaster` |
| `HighlightLayer` | `Selection.attach(engine, {color, width})` | Outlines, optionally x-ray |
| `GizmoManager` | `TransformControls`, `DragControls` (`margoengine/controls`) | |
| `PointerDragBehavior` | `DragControls` | |
| `DefaultRenderingPipeline` | `PostStack.attach(engine, [...effects])` (`margoengine/post/stack`) | |
| Bloom, FXAA, tone mapping, depth of field | `Bloom`, `FXAA`, `Tonemap`, `DOF` | One entry each |
| `SSAO2RenderingPipeline`, `SSRRenderingPipeline` | `SSAO`, `SSR` (`margoengine/post/ssao`, `/ssr`) | |
| `GlowLayer` | `Bloom` plus an emissive material above 1 | |
| `PostProcess` with a custom shader | `NodePass` (`@margoengine/shader`) | |
| `ImageProcessingConfiguration` | `Tonemap({curve, exposure})`, `.cube` LUTs | |

### Physics, game systems and UI

| Babylon.js | Margo | Notes |
| --- | --- | --- |
| Havok, Cannon, Ammo, `PhysicsAggregate` | `Physics` (`margoengine/physics`): `physics.addBody(mesh, {...})` | Margo's own Rust/Wasm kernel, not a plugin choice |
| `physicsBody.applyImpulse` | `body.applyImpulse([x, y, z])` | |
| `scene.pickWithRay` on physics, `PhysicsRaycastResult` | `physics.raycast(origin, direction)` | |
| Collision observables | `physics.on('contactstart', ...)` | |
| Joints, constraints | `physics.addJoint(a, b, {type: 'revolute', ...})` | |
| Character controllers, vehicles, ragdolls | `physics.createCharacterController`, `Vehicle`, `@margoengine/ragdoll` | |
| `ParticleSystem`, `GPUParticleSystem` | `@margoengine/vfx` (`VFX`) | GPU particles |
| `SpriteManager` | `@margoengine/sprites` (`SpriteLayer`) | |
| `Sound`, `Sound.spatial` | `@margoengine/audio` (`AudioListener`, `PositionalAudio`); `@margoengine/mixer` | |
| Navigation plugin, crowd agents | `@margoengine/navmesh` (`NavMesh`, `Crowd`) | |
| `ActionManager` | `Input` actions; `@margoengine/fsm`; `@margoengine/behavior` | |
| `@babylonjs/gui` `AdvancedDynamicTexture` | `@margoengine/ui` (`Ui`, `UiRenderer`) | Drawn in the engine; works fullscreen |
| `GUI3D`, HTML overlays | `@margoengine/labels` (`LabelRenderer`), `@margoengine/text` | |
| WebXR experience helper | `@margoengine/xr` (`XR`) | Untested on a headset; see [Not yet](#not-yet) |
| `Inspector` | `@margoengine/inspector` (`Inspector`); `@margoengine/inspector/frame` | A DOM entity inspector and a frame debugger |
| `SceneOptimizer` | `@margoengine/quality` | Measures the GPU and picks a tier |
| `WaterMaterial`, `SkyMaterial`, `TerrainMaterial` | `Water`, `Sky`, `TerrainHeightmap` | Optional packages |

## Engine, scene and camera

Babylon.js: create an `Engine` on a canvas, a `Scene`, an `ArcRotateCamera` that you attach to the canvas, a light and a
sphere and a ground, call `runRenderLoop`, and resize on the window event. In Margo:

```ts
import {createStage} from 'margoengine';

const stage = await createStage('#scene', {
  background: '#cfe3f2',
  camera: {position: [4, 3, 6], target: [0, 0.5, 0], fov: 50}, // degrees
});
stage.box({size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d8d8cf'});
stage.sphere({radius: 0.5, position: [0, 0.5, 0], color: '#84d6bd', roughness: 0.3});
stage.engine.scene.lighting.direction.set([-3, 5, 2, 3]); // toward the light; the last number is its strength
stage.onTick(delta => { /* seconds */ });
```

Without the stage facade, `Engine.create(canvas, {camera: {...}})` from `@margoengine/core` gives the same engine and
you call `engine.start()`. Runnable: [`01-scene-camera`](../examples/from-babylon/01-scene-camera.html).

- `engine.camera` has `position`, `target`, `fov`, `near`, `far` and `up`; assign new tuples to move it. There is no
  `setTarget`.
- `capacity` (default 1,024) is the initial number of meshes and transform nodes; the engine doubles it when full. Set it
  for big scenes: `Engine.create(canvas, {capacity: 50_000})`.

## Meshes and PBR materials

Babylon.js: `MeshBuilder.CreateSphere`, a `PBRMaterial` with `albedoColor` or `albedoTexture`, `metallic`, `roughness`,
`bumpTexture`; assign it to `mesh.material`; set `mesh.position` and `mesh.rotation`.

```ts
import {sphereGeometry} from 'margoengine/geometry';
import {PbrMaterial, Texture, createMesh} from 'margoengine/materials';

const pixels = new Uint8Array(64 * 64 * 4).fill(255); // paint your own, or use loadTexture(url)
const map = new Texture({data: pixels, width: 64, height: 64}, {wrapS: 'repeat', wrapT: 'repeat'});
const material = new PbrMaterial({map, metalness: 0, roughness: 0.4});
material.setUVTransform({scale: [4, 2]});
const ball = createMesh(engine, sphereGeometry(0.8, 64, 32), material);
ball.root.setPosition([-1.2, 0.8, 0]);
ball.root.rotation.y += 0.5;
```

For a colour-only mesh, core alone is enough: `engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new
PbrMaterial({color: '#84d6bd'}))`. A metal needs something to reflect, so give it an environment (below). Runnable:
[`02-mesh-pbr`](../examples/from-babylon/02-mesh-pbr.html).

`createMesh` from `@margoengine/materials` returns an object whose `root` is the mesh to move; the stage's `box` and
`sphere` return the mesh itself.

## Lights and shadows

Babylon.js: a `HemisphericLight`, a `DirectionalLight`, a `PointLight`; a `ShadowGenerator` on the directional light
with `addShadowCaster`, and `receiveShadows` on the ground.

```ts
import {Clustered} from 'margoengine/clustered';
import {Shadows} from 'margoengine/shadows';

const lighting = engine.scene.lighting;
lighting.direction.set([-4, 5, 3, 3]);        // toward the light; strength 3
lighting.radiance.set([1, 0.93, 0.82, 0.15]); // sun colour (linear) and ambient strength

const shadows = Shadows.attach(engine, {resolution: 2048});
shadows.add(mesh);
shadows.add(model);                            // glTF models cast and receive once added

const lamps = Clustered.attach(engine);
lamps.setLights([{position: [0, 2, 1], range: 8, color: [1, 0.3, 0.2], intensity: 12}]);
```

A second sun, or sixteen, is `DirectionalLights` from `margoengine/clustered/directional`, four of them shadowed by `LocalShadows`; its `direction` is the way the light travels, as in Babylon.js. Runnable: [`10-more-suns`](../examples/from-babylon/10-more-suns.html).

`setLights` replaces the list; call it again to move a lamp. Image-based lighting, fog and sky are in
`@margoengine/environment` and `@margoengine/sky`:

```ts
import {Environment, EnvironmentLighting, Fog, loadEnvironmentImage} from 'margoengine/environment';

const image = await loadEnvironmentImage('/studio.hdr');
const environment = await Environment.attach(engine, image); // scene.environmentTexture
EnvironmentLighting.attach(engine, environment);            // core meshes use it for ambient light
Fog.attach(engine, {color: '#bcd4e6', near: 10, far: 80});   // scene.fogMode = FOGMODE_LINEAR
```

Runnable: [`03-lights-shadows`](../examples/from-babylon/03-lights-shadows.html). The
[lights and shadows guide](guides/lights-and-shadows.md) has every option.

## Loading glTF

Babylon.js: import the loaders package, `SceneLoader.ImportMeshAsync` (or `Append`, or an asset container), then scale
or reposition the `__root__` node and frame the camera.

```ts
import {loadGLTF} from 'margoengine/gltf/pbr';

const cancel = new AbortController();
const loaded = await loadGLTF(engine, '/models/helmet.glb', {signal: cancel.signal});
loaded.root.setPosition([0, -loaded.bounds[1], 0]); // stand it on y = 0
const b = loaded.bounds;                            // [minX, minY, minZ, maxX, maxY, maxZ]
engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
```

There is no `__root__` and no handedness flip to unwrap. `loaded.nodes` are the glTF nodes as meshes you can move or
hide, and `loaded.lights` and `loaded.cameras` carry `KHR_lights_punctual` lights and glTF cameras as data. Free the model with `loaded.destroy()` (or `stage.dispose()`).
Runnable: [`04-gltf`](../examples/from-babylon/04-gltf.html); more in the [glTF guide](guides/loading-gltf.md).

## Animation

Babylon.js: a loaded file fills `scene.animationGroups`; you find one by name, `start(loop, speed)` it, `pause` or
`stop` it, and blend groups with `enableBlending` and `blendingSpeed`.

```ts
import {Animation} from 'margoengine/animation';
import {Animator} from 'margoengine/animator';

const animation = Animation.attach(model);       // skinning and morphs run in a compute pass
animation.play('Walking');                       // by name or index; restarts from time 0
animation.playing = false;                       // pause; seek(seconds) scrubs
animation.setMorph(0, 0, 1);                     // glTF node index, target index, weight

const animator = Animator.attach(animation, {    // blending, like weighted animation groups
  initial: 'move', parameters: {speed: 0},
  states: {move: {parameter: 'speed', samples: [{value: 0, clip: 'Idle'}, {value: 1, clip: 'Walking'}]}},
  transitions: [],
});
animator.parameters.speed = 0.5;
```

Runnable: [`05-animation`](../examples/from-babylon/05-animation.html). Animation needs WebGPU (skinning is a compute
shader). The [animation guide](guides/animation.md) covers the rest.

## Picking

Babylon.js: `scene.pick(scene.pointerX, scene.pointerY)` or a `POINTERPICK` pointer observable gives `pickedMesh`; a
`HighlightLayer` outlines it.

```ts
import {Picking, Selection} from 'margoengine/selection';
import {Raycaster} from 'margoengine/bvh';

const picking = Picking.attach(engine);            // GPU picking: what is drawn under the pixel
const outline = Selection.attach(engine, {color: [1, 0.6, 0]});
engine.canvas.addEventListener('click', async event => {
  const hit = await picking.pick(event.offsetX, event.offsetY); // CSS pixels from the canvas corner
  outline.set(hit ? [hit.mesh] : []);
});

const raycaster = new Raycaster();                  // CPU rays against a BVH, nearest first
raycaster.setFromEngine(engine, 100, 100);
const [first] = raycaster.intersectEngine(engine);
```

Runnable: [`06-picking`](../examples/from-babylon/06-picking.html). See [Common pitfalls](#common-pitfalls) for the
asynchronous answer and one pending pick at a time.

## Post-processing

Babylon.js: a `DefaultRenderingPipeline` with bloom, FXAA and image processing, an `SSAO2RenderingPipeline`, a
`GlowLayer`, and `PostProcess` for custom shaders.

```ts
import {Bloom} from 'margoengine/post/bloom';
import {FXAA} from 'margoengine/post/fxaa';
import {PostStack} from 'margoengine/post/stack';
import {SSAO} from 'margoengine/post/ssao';
import {Tonemap} from 'margoengine/tonemap';

PostStack.attach(engine, [
  new SSAO({radius: 0.5}),              // HDR effects first
  new Bloom({strength: 0.8}),
  new Tonemap({curve: 'agx'}),          // one display transform
  new FXAA(),                           // LDR effects last
]);
```

The stack captures the scene once in linear HDR and runs the effects in array order; the engine renders it. Effect
options are read every frame, so changing `bloom.options.strength` needs no rebuild. A glow is an emissive material
above 1 plus `Bloom`. Custom effects are `NodePass`es from `@margoengine/shader`. Runnable:
[`07-post`](../examples/from-babylon/07-post.html).

## Input and camera controls

Babylon.js: an `ArcRotateCamera` with `attachControl`, radius and beta limits; a `FreeCamera` with `keysUp` and friends;
`onKeyboardObservable` or an `ActionManager` for game keys.

```ts
import {OrbitControls} from 'margoengine/controls';
import {Input} from 'margoengine/input';

const orbit = OrbitControls.attach(engine);   // listens on the canvas, updates before each render
orbit.enableDamping = true;                   // inertia
orbit.minDistance = 3;                        // lowerRadiusLimit
orbit.maxDistance = 20;                       // upperRadiusLimit
orbit.maxPolarAngle = Math.PI / 2 - 0.05;     // upperBetaLimit

const input = new Input({jump: [{type: 'key', code: 'Space'}], left: [{type: 'key', code: 'KeyA'}]});
engine.onFrame(() => {
  input.update();                             // once per frame
  if (input.state('jump').pressed) { /* ... */ }
});
```

`FlyControls` and `FirstPersonControls` cover the FreeCamera family, `WalkControls` (`margoengine/controls/walk`) walks
through a building with eye height, stairs and walls, and `MapControls` suits top-down views. Margo's `OrbitControls`
also takes CAD presets (`BLENDER`, `SOLIDWORKS`, ...). If you attach your own controls to a stage, create it with
`controls: false`. Runnable: [`08-input-camera`](../examples/from-babylon/08-input-camera.html). The
[camera and controls guide](guides/camera-and-controls.md) has the full list.

## Physics

Babylon.js: enable a physics engine (Havok, Cannon or Ammo), then a `PhysicsAggregate` or body per mesh.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();                                   // loads the Wasm kernel
const physics = new Physics(engine);
physics.addBody(floor, {type: 'fixed'});                // collider fitted to the geometry
const body = physics.addBody(crate, {colliders: {shape: 'box', restitution: 0.3, density: 2}});
body.applyImpulse([0, 2, 0]);
physics.on('contactstart', ({meshA, meshB}) => { /* ... */ });
```

The physics world runs at a fixed step with interpolation. There is one solver (Margo's own), so there is no plugin to
choose. See the [physics README](../packages/physics/README.md).

## GUI and labels

Babylon.js GUI draws controls into an `AdvancedDynamicTexture`. `@margoengine/ui` is the in-engine counterpart:
panels, labels, buttons, toggles, sliders, bars, lists, menus, dialogs and toasts, with anchors, flex-style layout,
themes and text drawn as signed distance fields.

```ts
import {Ui, UiRenderer} from 'margoengine/ui';

const ui = new Ui();                 // dark theme by default
UiRenderer.attach(engine, ui);       // steps the UI each frame and draws it over the frame
```

HTML labels that follow a mesh (Babylon's GUI "linkWithMesh", or a DOM overlay) are `LabelRenderer` from
`@margoengine/labels`. There is no visual GUI editor; see [Not yet](#not-yet).

## Loading a .babylon file

`@margoengine/loaders/babylon` reads a `.babylon` scene: meshes (with shared geometries and instances), transform nodes,
standard and PBR materials, cameras, lights, skeletons and node animations. It returns plain data, adds nothing to the
engine, and mirrors Z into Margo's right-handed space by default.

```ts
import {createMeshes} from '@margoengine/loaders';
import {flattenBabylon, parseBabylon} from '@margoengine/loaders/babylon';

const scene = parseBabylon(await (await fetch('/scene.babylon')).text()); // a LoaderError with a code on a bad file
const camera = scene.cameras.find(c => c.id === scene.activeCameraId) ?? scene.cameras[0];
engine.camera.position = camera.position;     // already mirrored
engine.camera.target = camera.target;
engine.camera.fov = (camera.fov * 180) / Math.PI;
const meshes = createMeshes(engine, flattenBabylon(scene), {doubleSided: false}); // one mesh per file mesh
```

`flattenBabylon` bakes each mesh's parents and placement into one geometry with a group per mesh, carrying the
material's colour; `createMeshes` turns those into engine meshes with a `PbrMaterial` each. For per-node control (to
animate a transform node, say), walk `scene.transformNodes` and `scene.meshes` yourself: each has `translation`,
`rotation` (a quaternion) and `scale` relative to `parentId`.

What is read, and what is not:

- **Read:** vertices and shared `geometries`, submeshes (as groups with `materialIndex`), instances, Standard and PBR
  material colours, texture slots (names, transforms, embedded `base64String` data), cameras, the four light types,
  skeletons with four or eight influences per vertex, `clearColor` and `ambientColor`.
- **Skipped with a note in `scene.warnings`:** delay-loaded `.babylonbinarymeshdata` meshes, pivot matrices, extra light
  types. Particle systems, sprites, sounds, LODs and post processes are not read.
- **Not turned into engine objects for you:** textures (load the named file or decode the embedded bytes into a
  `Texture`), skeletons (use glTF for skinned characters), and the lights, which are data you apply.

Runnable: [`09-babylon-file`](../examples/from-babylon/09-babylon-file.html), with a small scene in
[`scene.babylon`](../examples/from-babylon/scene.babylon). For anything with skins, animation or lots of textures,
exporting glTF from your Babylon.js scene and using `loadGLTF` is the better path.

## Common pitfalls

- **The scene is mirrored or inside out.** Margo is right-handed; Babylon.js is left-handed. Hand-ported coordinates
  need Z negated and triangle winding swapped; `parseBabylon` does both and glTF needs neither.
- **The sun lights the wrong side.** `lighting.direction` points toward the light. A Babylon.js direction of
  `(1, -2, -1)` becomes `[-1, 2, 1]`.
- **The camera is too close or cuts off.** Defaults differ: `near` 0.1 and `far` 1000, against `minZ` 1 and `maxZ` 10000.
  Raise `far` for big worlds and `near` as far as you can.
- **The field of view is huge.** `fov` is in degrees here. Babylon's 0.8 radians is about 46 degrees.
- **Colours look washed out or too dark.** Hex strings are sRGB; number arrays are linear. A colour copied from a
  Babylon.js `StandardMaterial` (gamma values written as `Color3`) belongs in a hex string or converted, not as a raw
  array. PBR colours are linear and can go in arrays.
- **Back faces show.** `PbrMaterial` is double-sided by default; set `doubleSided: false` where you want culling.
- **Picking returns later.** `picking.pick` is a promise: the GPU answers a frame or two later. Await it, guard against
  a second pending pick, and ignore the pointer-up that ends an orbit drag (the example shows how).
- **Two controls fight over the mouse.** `createStage` adds CAD-style orbit controls; pass `controls: false` if you attach
  `OrbitControls`, `FlyControls` or others yourself. Create drag and selection tools before orbit controls, so a grab
  does not also turn the view.
- **Time is in seconds.** Babylon's `getDeltaTime()` is milliseconds; Margo's frame `delta` is seconds.
- **There is no `scene.render()` to call.** `engine.start()` runs the loop; add per-frame work with `engine.onFrame`.
- **Feature "does nothing".** A glTF model or materials mesh joins shadows, clustered lights, SSAO and IBL only after
  `feature.add(model)`; core meshes join on their own.
- **Metals look black.** A fully metallic surface reflects its surroundings. Add an environment or lower `metalness`.
- **Loading is cancelled by the page.** Pass an `AbortSignal` to loaders, and call `stage.dispose()` on `pagehide`.

## Not yet

Where there is no Margo equivalent today:

| Babylon.js | Status in Margo |
| --- | --- |
| Playground | None. There is no playground tool; examples run from the repository (`npm run dev:examples`). |
| `.babylon` export | None. `.babylon` is import only (`@margoengine/loaders/babylon`); export to glTF instead. |
| Node Material Editor, GUI editor, Sandbox viewer | None. Node materials and the UI are code, in `@margoengine/shader` and `@margoengine/ui`. The Inspector counterpart is a DOM entity inspector and a frame debugger, not a property editor for every material. |
| `Observable` and `Observer` | None. Use `engine.onFrame`, DOM events and `addEventListener`. |
| Several first-class scenes with `scene.activeCamera` switching | One implicit scene per engine; extra scenes exist for overlays, and `engine.render({camera})` renders from another camera. |
| `scene.useRightHandedSystem = false` | Margo is right-handed only. |
| WebXR | Present (`@margoengine/xr`) but untested on a headset. |
| Havok, Cannon, Ammo plugins | Margo has its own kernel only. |
| Skeletons and particle systems inside a `.babylon` file | Read as data (skeletons) or skipped; use glTF and `@margoengine/vfx`. |

Margo-only things worth knowing about, since you will not find them in Babylon.js: CAD navigation presets, GPU
picking that sees skinned poses, a frame debugger that records the real WebGPU calls, vertex-animation-texture crowds
(`@margoengine/animation/vat`) and floating-origin coordinates for planet-sized scenes. The
[three.js guide](from-threejs.md) shows several of them side by side.
