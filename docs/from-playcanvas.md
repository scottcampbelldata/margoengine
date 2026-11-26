# Coming from PlayCanvas

A guide for PlayCanvas developers. It maps the concepts you know (application, entity and components, script
lifecycle, assets, materials, lights, glTF, the anim state graph, physics, post-processing, input, UI) to Margo, says
where the conventions differ, and lists the pitfalls that cost people an afternoon. Where Margo has no equivalent, the
guide says so; the list is in [Not yet](#not-yet). The shape follows [Coming from three.js](from-threejs.md), which
covers more of the same ground for that library.

Every task below has a small runnable page in [`examples/from-playcanvas/`](../examples/from-playcanvas/index.html).
Each source file opens with a few lines on what the usual PlayCanvas code for that task does, then the Margo code. Run
them from the repository root:

```sh
npm run build:packages
npm run dev:examples
# http://127.0.0.1:5173/examples/from-playcanvas/index.html
```

<!-- Every ```ts block in this file uses only names that exist in the built packages. The ambient names engine, canvas,
     mesh and model are the ones the other guides use. ```js blocks are PlayCanvas and are not checked. -->

## Contents

- [What is different](#what-is-different)
- [Units, handedness and conventions](#units-handedness-and-conventions)
- [Install only what you import](#install-only-what-you-import)
- [API mapping](#api-mapping)
- [Application and camera](#application-and-camera)
- [Entities and components](#entities-and-components)
- [Scripts and the lifecycle](#scripts-and-the-lifecycle)
- [Assets and loading glTF](#assets-and-loading-gltf)
- [Materials](#materials)
- [Lights and shadows](#lights-and-shadows)
- [Animation](#animation)
- [Picking](#picking)
- [Input and camera controls](#input-and-camera-controls)
- [Physics](#physics)
- [Post-processing](#post-processing)
- [UI and labels](#ui-and-labels)
- [Common pitfalls](#common-pitfalls)
- [Not yet](#not-yet)

## What is different

- **WebGPU first.** Core renders with WebGPU. The WebGL2 fallback is the optional `@margoengine/webgl2-compat` layer; the
  small `@margoengine/webgl2-compat/preview` fallback draws core meshes only. PlayCanvas picks WebGL2 or WebGPU through
  its graphics-device options; Margo has one `Engine`, with `engine.backend` telling you which backend it got, and most
  optional packages need WebGPU.
- **No entity-component model on the scene graph.** A PlayCanvas `Entity` is a node that carries components
  (`render`, `light`, `camera`, `script`, `rigidbody`). A Margo node is a `Mesh`: a transform with optional geometry and
  material, and children that are meshes. Lights, cameras, physics bodies and animation players are not components on
  it; they are plugin objects you create for the engine (`Shadows.attach(engine)`, `physics.addBody(mesh)`,
  `Animation.attach(model)`). If you want your own component model, `@margoengine/ecs` is a typed-array ECS you key to
  your meshes (see [Entities and components](#entities-and-components)).
- **One engine, one implicit scene.** There is no `app.root` to add an entity to. `Engine.create(canvas)` (or the stage
  facade's `createStage`) owns the canvas, the camera and the scene; `engine.createMesh()` makes a mesh in it, and
  `stage.box()` and friends make a mesh with geometry.
- **Features are plugins you attach.** Shadows, clustered lights, post effects, controls, picking and physics are
  objects you create with one form, `Feature.attach(engine, options)`. Everything disposable has `dispose()`; package
  objects also have `[Symbol.dispose]`, so `using` works.
- **Small core, optional packages.** Core plus the stage facade is about 21 kB gzip (`npm run measure:size` prints the
  figure). Everything else (glTF with textures, shadows, post, physics, UI) is a separate package you install and import
  only when you use it, so a bundler drops what you leave out.
- **Tuples, not classes.** Positions, directions and colours are plain arrays (`[x, y, z]`, `'#rrggbb'`). `mesh.position`
  is a live `{x, y, z}` view with `set`, not a `Vec3`. A math library exists in `@margoengine/math` (`Vector3`,
  `Matrix4`, `Quaternion`, `Color`, `Box3`) and converts with `toArray()`.
- **The camera is a position and a target.** There is one core camera, `engine.camera`, with `position`, `target`,
  `fov`, `near`, `far` and `up`. It is not an entity with a camera component. Orbit and fly behaviour is a controls object
  (`OrbitControls`, `FlyControls`, ...), not a script on the camera entity.
- **Events are the browser's.** PlayCanvas's `EventHandler` (`app.on('update')`, `entity.on`, `fire`) maps to
  `engine.onFrame` (or `stage.onTick`) for the frame, the DOM's `addEventListener` on `engine.canvas` for pointers and
  keys, and the `Input` package for actions.
- **Resize and pixel ratio are automatic.** The engine sizes its drawing buffer from the canvas's CSS size every frame.
  There is no `app.setCanvasFillMode` or `app.resizeCanvas` to call. Desktops render with 4x MSAA at pixel ratio 1,
  phones single-sampled at up to 2; `@margoengine/quality` picks a lighter tier on slow GPUs.
- **Two levels of mesh.** A core mesh is a geometry with a constant PBR material, and equal geometries are instanced for
  you. Textured meshes and glTF models are drawn by `@margoengine/materials` and `@margoengine/gltf/pbr`. Shadows,
  clustered lights and SSAO light core meshes on their own; glTF models and materials meshes join a feature with
  `feature.add(model)`.

## Units, handedness and conventions

| | PlayCanvas | Margo |
| --- | --- | --- |
| Handedness | Right-handed | Right-handed. Nothing to mirror |
| Up axis | +Y | +Y |
| Units | One unit is a metre by convention | Metres. glTF's conventions apply: Y up, right-handed, camera looks down -Z |
| Rotation | `setEulerAngles` and `entity.rotate` take **degrees**; `setRotation` takes a `Quat` | `mesh.rotation` is Euler XYZ in **radians**; `setQuaternion([x, y, z, w])` sets a quaternion |
| Field of view | `camera.fov` in degrees, vertical by default (`horizontalFov` switches), default 45 | `engine.camera.fov` in degrees, vertical, default 60 |
| Clip planes | `nearClip` default 0.1, `farClip` default 1000 | `near` default 0.1, `far` default 1000 |
| Colours | `Color` floats 0 to 1, taken as gamma (sRGB) values and converted for lighting | `'#rrggbb'` strings are sRGB and converted to linear; number arrays are linear RGB. Output is tone mapped and sRGB-encoded for you |
| Specular smoothness | `gloss` (1 is a mirror) | `roughness`; roughness is 1 minus gloss |
| Directional light direction | The entity's local -Y axis: the way the light travels | The direction **toward** the light (the sun's position, not its heading) |
| Back-face culling | On by default (`cull`) | `PbrMaterial` is double-sided by default; set `doubleSided: false` for culling |
| Frame time | `dt` in seconds | `delta` in seconds |

Handedness matches, so a scene ports with no mirroring. The two that bite are degrees against radians (`rotation` is
radians; wrap a PlayCanvas angle with `angle * Math.PI / 180`) and the light direction (PlayCanvas aims a light by
turning its entity; Margo takes a vector pointing at the light). For a mesh that turns about more than one axis, set a
quaternion with `setQuaternion` instead of converting Euler angles by hand.

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

## API mapping

Names in the Margo column exist in the built packages; the examples run them. "None" means Margo has nothing equivalent
(see [Not yet](#not-yet)).

### Application, entities and scripts

| PlayCanvas | Margo | Notes |
| --- | --- | --- |
| `new Application(canvas)`, `app.start()` | `Engine.create(canvas, options)` (`@margoengine/core`); `createStage(selector, options)` (`margoengine`) | `createStage` also makes the canvas, adds orbit controls and starts the loop. Without it, call `engine.start()` |
| `app.on('update', dt)` | `engine.onFrame((time, delta) => ...)`, `stage.onTick(delta => ...)` | Seconds. Both return a function that unsubscribes |
| `app.setCanvasFillMode`, `app.resizeCanvas` | Nothing to call | Sized per frame from the CSS size |
| `app.destroy()` | `stage.dispose()`, `engine.dispose()` | Disposes every plugin, model and control |
| `Entity`, `app.root`, `entity.addChild` | `engine.createMesh()` (no geometry for a pure transform node); `mesh.setParent(node)` | A mesh is the node; see [Entities](#entities-and-components) |
| `entity.setPosition`, `setLocalScale`, `setLocalEulerAngles` | `mesh.position`, `mesh.scale`, `mesh.rotation` (live views), `setPosition`, `setScale`, `setRotation`, `setQuaternion` | Local transforms; rotation is radians |
| `entity.enabled = false` | `mesh.visible = false` | |
| `entity.destroy()` | `mesh.dispose()` | |
| `entity.findByName`, `forEach` | `traverse(engine.scene, fn)`, `children(mesh)`, `userData(mesh)` (`@margoengine/scene`) | Match on `mesh.name`. `extendMeshes()` adds them as members |
| `entity.tags.add('enemy')`, `entity.findByTag('enemy')` | `tags(mesh).add('enemy')`, `findByTag(engine.scene, 'enemy')`, `queryTags(scene, 'a && !b')` (`margoengine/scene/tags`) | OR between arguments, AND inside an array. `TagSet` is an `EventTarget` that fires `add`, `remove` and `change` |
| `entity.addComponent(...)` | `@margoengine/ecs` `World` and `world.component({...})`, keyed to your meshes | Data-oriented, typed-array fields |
| `ScriptType`, `Script` class, `entity.script.create`, script attributes | `defineScript({name, attributes, initialize, postInitialize, update, postUpdate, fixedUpdate, onEnable, onDisable, onAttributeChange, destroy, swap})`; `new Scripts(world)`, `scripts.add(entity, type, {values})` (`margoengine/ecs/scripts`) | Typed attributes (`number`, `vec3`, `color`, `entity`, `asset`...) with `default`, `min`, `max` and `enum` options. Scripts attach to ECS entities, not meshes; see [Scripts](#scripts-and-the-lifecycle) |
| `entity.on`, `fire`, `app.fire` | `EventTarget`, or your own emitter | |
| `Application` tween (`entity.tween`) | `@margoengine/tween` (`Tween`, `Timeline`, `Spring`, `to`, `from`, `fromTo`) | |
| `camera.layers`, `entity.render.layers`, `app.scene.layers` | `setRenderLayers(mesh, mask)`, `setCameraLayers(camera, mask)`, `layerMask(...layers)` (`margoengine/cameras/layers`) | 32-bit masks: a view draws a mesh when the two share a bit. Picking takes `layers` too (`SpatialPickingOptions`, `AreaPickingOptions`). Draw order of layers and sublayers is not a Margo concept |
| `camera.rect`, several cameras | `engine.views = [{camera, viewport: [x, y, w, h], scissor?, layers?}]` (core `RenderView`) | Fractions of the canvas, or pixels with `pixels: true`. See [split-screen](../examples/split-screen.html) and [minimap](../examples/minimap.html). `StereoRig` and `HologramRig` (`@margoengine/cameras/stereo`, `/hologram`) build the views for stereo and four-sided displays |

### Assets, materials and textures

| PlayCanvas | Margo | Notes |
| --- | --- | --- |
| `app.assets`, `Asset`, `assets.load`, `assets.loadFromUrl` | `loadGLTF(engine, url, {signal})`, `loadTexture(url)`, `loadEnvironmentImage(url)`; `AssetCache` (`margoengine/cache`) for offline | Promises, no registry. Keep what you load in your own variable |
| `asset.resource.instantiateRenderEntity()` | `loadGLTF` returns a `PBRModel`; `cloneModel(model)` (`margoengine/animation/skeleton-utils`) makes another | |
| Container asset (glb) | `loadGLTF` (`margoengine/gltf/pbr`) | `model.root`, `model.bounds`, `model.nodes` |
| Draco, Basis (KTX2), Meshopt | `@margoengine/decoders` | Passed in only when a file needs them |
| `.obj`, `.fbx`, `.usdz` | `@margoengine/loaders`, `@margoengine/fbx`, `@margoengine/usdz` | |
| Progressive loading, LOD streaming | `loadGLTFProgressive` (`margoengine/gltf/progressive`) | |
| Template asset | None | Build in a function, or clone a loaded model |
| Gaussian splat asset (`gsplat`) | `Splats` (`margoengine/splats`) | GPU sort and projection |
| `StandardMaterial` (`useMetalness`) | `PbrMaterial({color, metalness, roughness, map, normalMap, emissive, ...})` | Colour-only works in core; maps need `@margoengine/materials` |
| `diffuse`, `metalness`, `gloss` | `color`, `metalness`, `roughness` (1 minus gloss) | |
| `diffuseMap`, `normalMap`, `emissiveMap`, `aoMap` | `map`, `normalMap`, `emissiveMap` and friends on `PbrMaterial` | See the materials README |
| `diffuseMapTiling`, `diffuseMapOffset` | `material.setUVTransform({scale, offset})` | |
| `Texture` filled by hand | `new Texture({data, width, height}, {wrapS, wrapT})` | |
| `material.update()` | Nothing to call | |
| Custom shader chunks, `ShaderMaterial` | Node materials and WGSL in `@margoengine/shader` | WGSL, not GLSL ([porting-glsl](porting-glsl.md)) |
| `BatchGroup`, dynamic batching | Equal geometries are instanced for you; `createInstancedMesh` (`@margoengine/materials`); `mergeGeometries` | No manual batch groups to set up |
| `app.scene.lightmapper` | `@margoengine/lightmap` | |

### Lights, shadows and environment

| PlayCanvas | Margo | Notes |
| --- | --- | --- |
| `light` component, type `directional` | `engine.scene.lighting.direction.set([x, y, z, strength])` | Core's one sun. Points **toward** the light |
| Several `directional` lights | `DirectionalLights.attach(engine, {lights}).setLights([{direction, color, intensity, castShadow}])` (`margoengine/clustered/directional`) | Up to 16, four with shadows (`LocalShadows`). Here `direction` is the way the light **travels**, as in PlayCanvas |
| `app.scene.ambientLight` | `lighting.radiance.set([r, g, b, ambient])`; `HemisphereLight` (`margoengine/environment`) | `HemisphereLight` has separate sky and ground colours |
| `light` type `omni`, `spot` | `Clustered.attach(engine)` then `setLights([...])` | Up to 1,024 by default; range in metres |
| `castShadows`, `shadowResolution`, `shadowDistance` | `Shadows.attach(engine, {resolution})`, `shadows.add(mesh)` | Cascaded, soft edge by default; `cascades` 1 to 4 |
| Omni and spot shadows | `LocalShadows` (`@margoengine/clustered/shadows`) | |
| `receiveShadows = false` | `shadows.add(mesh, {castShadow: false})` is the receive-only form | Core meshes receive automatically |
| `scene.envAtlas`, `skybox`, prefiltered cubemap | `Environment.attach(engine, image)`, `EnvironmentLighting.attach(...)` (`margoengine/environment`) | Reads `.hdr`, `.exr`, UltraHDR |
| Procedural sky | `Sky` (`margoengine/sky`) | |
| `scene.fog` | `Fog.attach(engine, {near, far})` or `{density}` | Height fog too |
| Area lights | `@margoengine/clustered/area` | |

### Animation, interaction and game systems

| PlayCanvas | Margo | Notes |
| --- | --- | --- |
| `anim` component, `assignAnimation` | `Animation.attach(model)`, `animation.clips`, `animation.play(name)` | `playing`, `seek`, `loop`, `speed` |
| `baseLayer.transition(state, time)` | `animation.play(name)`, or an `Animator` transition | |
| Anim state graph, layers, blend trees, `setFloat`, `setBoolean`, `setTrigger` | `Animator.attach(animation, {...})` (`margoengine/animator`): states, blend trees, additive layers, `animator.parameters.x = v` | |
| Legacy `animation` component | `Animation` | |
| Morph targets | `animation.setMorph(nodeIndex, targetIndex, weight)` | |
| `Picker`, `getSelection` | `Picking.attach(engine)` then `await picking.pick(x, y)` (`margoengine/selection`) | Asynchronous |
| `rigidbody.raycastFirst`, `camera.screenToWorld` | `physics.raycast(origin, direction)`; `Raycaster` (`margoengine/bvh`) for CPU rays against meshes | |
| Outline layer | `Selection.attach(engine, {color, width})` | Outlines, optionally x-ray |
| `app.keyboard`, `app.mouse`, `app.touch`, `app.gamepads` | `Input` actions (`margoengine/input`); DOM events on `engine.canvas` | |
| `OrbitCamera` script | `OrbitControls.attach(engine)` (`margoengine/controls`) | Also `FlyControls`, `FirstPersonControls`, `WalkControls`, `MapControls` |
| Transform gizmo (editor, `TransformGizmo`) | `TransformControls`, `DragControls` | |
| `rigidbody` and `collision` components (Ammo.js) | `Physics` (`margoengine/physics`): `physics.addBody(mesh, {...})` | Margo's own Rust/Wasm kernel |
| Trigger volumes | `physics.on('intersectionstart', ...)` | Sensors |
| `particlesystem` component | `VFX` (`@margoengine/vfx`) | GPU particles |
| `sprite`, `SpriteAnimation` | `SpriteLayer` (`@margoengine/sprites`) | |
| `sound`, `audiolistener` components | `@margoengine/audio` (`AudioListener`, `PositionalAudio`); `@margoengine/mixer` | |
| `screen` and `element` components | `@margoengine/ui` (`Ui`, `UiRenderer`) | See [UI and labels](#ui-and-labels) |
| `CameraFrame`, `postEffects` | `PostStack.attach(engine, [...effects])` (`margoengine/post/stack`) | |
| Bloom, SSAO, TAA, depth of field, grading | `Bloom`, `SSAO`, `TAA`, `DOF`, `Tonemap` | One entry each |
| `scene.toneMapping`, `exposure` | `Tonemap({curve, exposure})` | |
| `app.xr` | `@margoengine/xr` (`XR`) | Untested on a headset; see [Not yet](#not-yet) |
| `LodComponent`, render `lodDistances` | `LODSystem` (`@margoengine/lod`) | Distance or screen-size levels, octahedral imposters |
| Pathfinding (not built in) | `@margoengine/navmesh` (`NavMesh`, `Crowd`) | |
| Multiplayer (not built in) | `@margoengine/netcode` | |
| Profiler, `app.stats` | `@margoengine/stats`; `@margoengine/inspector` (`Inspector`) | A DOM entity inspector and a frame debugger |

## Application and camera

PlayCanvas: make a canvas and an `Application`, an entity with a `camera` component, an entity with a `light`
component, and `render` component entities; `app.start()`, and `app.on('update', dt)` for per-frame work. In Margo:

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
you call `engine.start()`. Runnable: [`01-app-camera`](../examples/from-playcanvas/01-app-camera.html).

- `engine.camera` has `position`, `target`, `fov`, `near`, `far` and `up`; assign new tuples to move it. There is no
  camera entity to rotate; a camera that looks the way an entity faces is `position` plus a `target` in front of it.
- `capacity` (default 1,024) is the initial number of meshes and transform nodes; the engine doubles it when full. Set it
  for big scenes: `Engine.create(canvas, {capacity: 50_000})`.

## Entities and components

PlayCanvas: an `Entity` has a name, a transform, children and components (`entity.addComponent('render', {...})`); a
system updates each component type. In Margo the node and the data are separate. A mesh is the node; your behaviour
data is whatever you choose, and `@margoengine/ecs` is the fast choice when there are many of them.

```ts
import {World} from 'margoengine/ecs';

const pivot = engine.createMesh();             // a transform node
mesh.setParent(pivot);                         // entity.addChild
const world = new World(64);
const spin = world.component({speed: Float32Array});
const entity = world.create();
spin.add(entity, {speed: 1.2});                // entity.addComponent
const found = new Uint32Array(world.capacity);
engine.onFrame((time, delta) => {              // a system
  const count = world.query([spin], found);
  for (let i = 0; i < count; i++) pivot.rotation.y += spin.fields.speed[spin.index(found[i])] * delta;
});
```

Runnable: [`02-entity-components`](../examples/from-playcanvas/02-entity-components.html). The
[ecs README](../packages/ecs/README.md) covers tags, `without` and `optional` query terms, and growable worlds.
`@margoengine/scene` gives meshes `children`, `parent`, `traverse`, `userData` and world-space getters, and
`extendMeshes()` turns them into members.

## Scripts and the lifecycle

PlayCanvas: a script has `initialize` (once, on enable), `postInitialize` (once, after every `initialize`), `update(dt)`,
`postUpdate(dt)` (after every `update`) and `swap` (on hot reload), with attributes edited in the Editor. `Scripts` in
`@margoengine/ecs` has the same model with typed attributes, minus the Editor: a script type is `defineScript`, and any
number of instances attach to an ECS entity.

```ts
import {World} from 'margoengine/ecs';
import {Scripts, defineScript} from 'margoengine/ecs/scripts';

const world = new World(64);
const scripts = new Scripts(world);
const spinner = defineScript({
  name: 'spinner',
  attributes: {speed: {type: 'number', default: 1, min: 0, max: 20}},
  initialize() { this.state.angle = 0; },
  update(dt) { this.state.angle += this.attributes.speed * dt; mesh.rotation.y = this.state.angle; },
  destroy() { mesh.dispose(); },
});
scripts.register(spinner);
const entity = world.create();
const instance = scripts.add(entity, spinner, {values: {speed: 2}}); // entity.script.create('spinner', {attributes})
const stop = engine.onFrame((time, delta) => scripts.update(delta));
instance.attributes.speed = 4; // validated; runs onAttributeChange
// later: stop(); scripts.dispose();
```

The hooks run with the instance as `this` (`entity`, `world`, `attributes`, `state`, `enabled`). `scripts.update(dt)`
runs every `initialize`, then every `postInitialize`, then every `update`, then every `postUpdate`, ordered by
`priority`. `fixedUpdate`, `onEnable`, `onDisable` and `onAttributeChange` exist too. `scripts.reload(newType)` is `swap`:
instances keep their attribute values and `state`, and `swap(previous)` runs on the new type to migrate. `scripts.schema()`
returns every type's attributes as data for an inspector. An ECS entity is not a mesh, so a script that moves a mesh holds it
in `state`, in an attribute of type `entity`, or in a map you keep. The runnable example adds two bobbing boxes:
[`03-script-lifecycle`](../examples/from-playcanvas/03-script-lifecycle.html). The
[ecs README](../packages/ecs/README.md) has the rest, including `install(schedule)` to run scripts in a frame schedule.

## Assets and loading glTF

PlayCanvas: an `Asset` of type `container` in `app.assets`, `assets.load`, then `instantiateRenderEntity()` and
`app.root.addChild`. In Margo:

```ts
import {loadGLTF} from 'margoengine/gltf/pbr';

const cancel = new AbortController();
const loaded = await loadGLTF(engine, '/models/helmet.glb', {signal: cancel.signal});
loaded.root.setPosition([0, -loaded.bounds[1], 0]); // stand it on y = 0
const b = loaded.bounds;                            // [minX, minY, minZ, maxX, maxY, maxZ]
engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
```

There is no registry and no separate instantiate step: `loadGLTF` adds the model. `loaded.nodes` are the glTF nodes as
meshes you can move or hide, and `loaded.lights` and `loaded.cameras` carry `KHR_lights_punctual` lights and glTF
cameras as data. Free the model with `loaded.destroy()` (or `stage.dispose()`). For a second copy, `cloneModel(loaded)`
from `margoengine/animation/skeleton-utils`. Runnable: [`06-gltf`](../examples/from-playcanvas/06-gltf.html); more in the
[glTF guide](guides/loading-gltf.md).

## Materials

PlayCanvas: a `StandardMaterial` with `useMetalness`, `diffuse` or `diffuseMap`, `metalness`, `gloss`, a normal map,
and `update()`.

```ts
import {sphereGeometry} from 'margoengine/geometry';
import {PbrMaterial, Texture, createMesh} from 'margoengine/materials';

const pixels = new Uint8Array(64 * 64 * 4).fill(255); // paint your own, or use loadTexture(url)
const map = new Texture({data: pixels, width: 64, height: 64}, {wrapS: 'repeat', wrapT: 'repeat'});
const material = new PbrMaterial({map, metalness: 0, roughness: 0.4}); // gloss 0.6
material.setUVTransform({scale: [4, 2]});                               // diffuseMapTiling
const ball = createMesh(engine, sphereGeometry(0.8, 64, 32), material);
ball.root.setPosition([-1.2, 0.8, 0]);
```

For a colour-only mesh, core alone is enough: `engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new
PbrMaterial({color: '#84d6bd'}))`. A metal needs something to reflect, so give it an environment (below). Runnable:
[`04-pbr-material`](../examples/from-playcanvas/04-pbr-material.html). `createMesh` from `@margoengine/materials`
returns an object whose `root` is the mesh to move; the stage's `box` and `sphere` return the mesh itself.

## Lights and shadows

PlayCanvas: a `light` component on an entity, aimed by turning the entity; `castShadows` and `shadowResolution`;
ambient light on the scene.

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

`setLights` replaces the list; call it again to move a lamp. Image-based lighting, fog and sky are in
`@margoengine/environment` and `@margoengine/sky`:

```ts
import {Environment, EnvironmentLighting, Fog, loadEnvironmentImage} from 'margoengine/environment';

const image = await loadEnvironmentImage('/studio.hdr');
const environment = await Environment.attach(engine, image); // scene.envAtlas and skybox
EnvironmentLighting.attach(engine, environment);            // core meshes use it for ambient light
Fog.attach(engine, {color: '#bcd4e6', near: 10, far: 80});   // scene.fog
```

To port a directional light by its entity's angles, take the entity's local +Y axis in world space: that is the vector
toward the light. Runnable: [`05-lights-shadows`](../examples/from-playcanvas/05-lights-shadows.html). The
[lights and shadows guide](guides/lights-and-shadows.md) has every option.

## Animation

PlayCanvas: an `anim` component with a state graph, `baseLayer.transition(state, blendTime)`, and parameters
(`setFloat`, `setBoolean`, `setTrigger`) that drive the transitions.

```ts
import {Animation} from 'margoengine/animation';
import {Animator} from 'margoengine/animator';

const animation = Animation.attach(model);       // skinning and morphs run in a compute pass
animation.play('Walking');                       // by name or index; restarts from time 0
animation.playing = false;                       // pause; seek(seconds) scrubs
animation.setMorph(0, 0, 1);                     // glTF node index, target index, weight

const animator = Animator.attach(animation, {    // a state graph with parameters
  initial: 'move', parameters: {speed: 0},
  states: {move: {parameter: 'speed', samples: [{value: 0, clip: 'Idle'}, {value: 1, clip: 'Walking'}]}},
  transitions: [],
});
animator.parameters.speed = 0.5;                 // anim.setFloat('speed', 0.5)
```

Runnable: [`07-animation`](../examples/from-playcanvas/07-animation.html). Animation needs WebGPU (skinning is a compute
shader). The [animation guide](guides/animation.md) covers the rest.

## Picking

PlayCanvas: a `Picker` that you `prepare` for a camera and ask for the selection at a pixel, or a physics ray from
`screenToWorld` points.

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

Runnable: [`08-picking`](../examples/from-playcanvas/08-picking.html). See [Common pitfalls](#common-pitfalls) for the
asynchronous answer and one pending pick at a time.

## Input and camera controls

PlayCanvas: `app.keyboard.isPressed(KEY_W)` polled in `update`, `app.mouse` and `app.touch` events, and the `OrbitCamera`
script with distance and pitch limits.

```ts
import {OrbitControls} from 'margoengine/controls';
import {Input} from 'margoengine/input';

const orbit = OrbitControls.attach(engine);   // listens on the canvas, updates before each render
orbit.enableDamping = true;                   // inertia
orbit.minDistance = 3;                        // distanceMin
orbit.maxDistance = 20;                       // distanceMax
orbit.maxPolarAngle = Math.PI / 2 - 0.05;     // pitch limit

const input = new Input({jump: [{type: 'key', code: 'Space'}], left: [{type: 'key', code: 'KeyA'}]});
engine.onFrame(() => {
  input.update();                             // once per frame
  if (input.state('jump').pressed) { /* ... */ }
});
```

`FlyControls` and `FirstPersonControls` cover free cameras, `WalkControls` (`margoengine/controls/walk`) walks through a
building with eye height, stairs and walls, and `MapControls` suits top-down views. If you attach your own controls to
a stage, create it with `controls: false`. Runnable: [`09-input`](../examples/from-playcanvas/09-input.html). The
[camera and controls guide](guides/camera-and-controls.md) has the full list.

## Physics

PlayCanvas: a `rigidbody` component (static, dynamic or kinematic; mass, restitution, friction) plus a `collision`
component for the shape, run by Ammo.js.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();                                   // loads the Wasm kernel
const physics = new Physics(engine);
physics.addBody(mesh, {type: 'fixed'});                 // static; the collider is fitted to the geometry
const body = physics.addBody(mesh, {colliders: {shape: 'box', restitution: 0.3, density: 2}});
body.applyImpulse([0, 2, 0]);
physics.on('contactstart', ({meshA, meshB}) => { /* ... */ });
```

Margo's colliders take a `density`, not a `mass`. The world runs at a fixed step with interpolation, and sensors
(`intersectionstart`, `intersectionend`) stand in for trigger volumes. See the
[physics README](../packages/physics/README.md).

## Post-processing

PlayCanvas: `CameraFrame` (bloom, SSAO, TAA, depth of field, grading, vignette) or the older `postEffects` list.

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
options are read every frame, so changing `bloom.options.strength` needs no rebuild. Custom effects are `NodePass`es from
`@margoengine/shader`.

## UI and labels

PlayCanvas builds UI from `screen` components and `element` components (text, image, group), with `ElementInput` for
clicks. `@margoengine/ui` is the in-engine counterpart: panels, labels, buttons, toggles, sliders, bars, lists, menus,
dialogs and toasts, with anchors, flex-style layout, themes and text drawn as signed distance fields.

```ts
import {Ui, UiRenderer} from 'margoengine/ui';

const ui = new Ui();                 // dark theme by default
UiRenderer.attach(engine, ui);       // steps the UI each frame and draws it over the frame
```

HTML labels that follow a mesh are `LabelRenderer` from `@margoengine/labels`. There is no visual UI editor; see
[Not yet](#not-yet).

## Common pitfalls

- **Everything spins the wrong amount.** PlayCanvas angles are degrees; `mesh.rotation` is radians.
- **The sun lights the wrong side.** `lighting.direction` points toward the light. A PlayCanvas directional light
  shines along its entity's -Y axis, so the direction to pass is the entity's +Y in world space.
- **The surface is too shiny or too rough.** `gloss` and `roughness` run opposite ways: `roughness = 1 - gloss`.
- **Colours look washed out or too dark.** Hex strings are sRGB; number arrays are linear. A `Color` copied from a
  PlayCanvas material (gamma values) belongs in a hex string, not as a raw array.
- **Back faces show.** `PbrMaterial` is double-sided by default; set `doubleSided: false` where you want culling.
- **There is no `entity.addComponent`.** Lights, shadows, physics and animation are plugins attached to the engine, and a
  mesh is added to them (`shadows.add(mesh)`, `physics.addBody(mesh)`).
- **Picking returns later.** `picking.pick` is a promise: the GPU answers a frame or two later. Await it, guard against
  a second pending pick, and ignore the pointer-up that ends an orbit drag (the example shows how).
- **Two controls fight over the mouse.** `createStage` adds CAD-style orbit controls; pass `controls: false` if you attach
  `OrbitControls`, `FlyControls` or others yourself. Create drag and selection tools before orbit controls, so a grab
  does not also turn the view.
- **There is no `app.root`.** `engine.scene.meshes` lists every mesh; a node you made with `engine.createMesh()` is
  already in the scene.
- **Feature "does nothing".** A glTF model or materials mesh joins shadows, clustered lights, SSAO and IBL only after
  `feature.add(model)`; core meshes join on their own.
- **Metals look black.** A fully metallic surface reflects its surroundings. Add an environment or lower `metalness`.
- **Loading is cancelled by the page.** Pass an `AbortSignal` to loaders, and call `stage.dispose()` on `pagehide`.

## Not yet

Where there is no Margo equivalent today:

| PlayCanvas | Status in Margo |
| --- | --- |
| The Editor (scene editor, hierarchy panel, inspector, asset panel, attribute editing) | None. Scenes are code. `@margoengine/inspector` is a DOM entity inspector and a frame debugger, not a property editor for every material. |
| Hosting, publishing and the asset pipeline in the cloud | None. Build with your bundler; `margo-convert` optimises and packages models offline. |
| `AssetRegistry` with tags and `asset.ready` | No registry with tags. Loaders return promises; `AssetQueue` (`margoengine/scene/assets`) loads named assets with progress events and `retryFailed`; `AssetCache` caches for offline use. |
| Template assets that instantiate into meshes | `cloneSubtree(mesh)` (`margoengine/scene/clone`) and `cloneModel` copy a node tree or a loaded glTF. `@margoengine/save` has prefab definitions with overrides and nesting, resolved to entity data you build meshes from; it does not create meshes itself. |
| Ammo.js | Margo has its own kernel only. |
| `EventHandler` on every object | None. Use `addEventListener`, `engine.onFrame` and `Input`. |
| WebXR | Present (`@margoengine/xr`) but untested on a headset. |
| `addComponent` on the scene graph, cameras as components with priorities | Meshes are nodes with no component slots; behaviour is `Scripts` or a `World` keyed to your meshes. One engine camera plus `engine.views` for more. Layers have no draw order of their own. |
| Visual `screen` and `element` UI editing | None. The UI is code, in `@margoengine/ui`. |

Margo-only things worth knowing about, since you will not find them in PlayCanvas: CAD navigation presets, GPU picking
that sees skinned poses, a frame debugger that records the real WebGPU calls, vertex-animation-texture crowds
(`@margoengine/animation/vat`), a CAD solid kernel (`@margoengine/brep`) and floating-origin coordinates for
planet-sized scenes. The [three.js guide](from-threejs.md) shows several of them side by side.
