# @margoengine/stage

You normally use this package as [`margoengine`](../margoengine/README.md): `import {createStage} from 'margoengine'` is this package. The packages are not on npm yet; see the [Install](../../README.md#install) section for the routes that work today.

High-level setup for Margo Engine. Mount a canvas, enable orbit/pan/zoom, start rendering and create a spinning orb in five lines. The stage creates a WebGPU engine. Pass `fallback` from the optional `@margoengine/webgl` when a browser has no WebGPU; without it, creation rejects with `WebGPU unavailable`. Core handles resize and automatically recovers a lost WebGPU device. A lost WebGL2 context reports through `onError` and stops rendering; dispose and recreate the stage to resume.

This package is built from source alongside the engine. See the [package catalog](../../docs/README.md) for npm availability. Run `npm run build:packages` in the repository, or install its local tarball and `@margoengine/core`. The only dependency is `@margoengine/core`. `@margoengine/gltf`, `@margoengine/creative`, `@margoengine/scenery`, `@margoengine/gltf-pro`, `@margoengine/environment`, `@margoengine/staging`, `@margoengine/shadows`, `@margoengine/tonemap`, `@margoengine/xr`, `@margoengine/physics`, `@dimforge/rapier3d-compat` and `@margoengine/save` are optional peers, used only by the feature entries below. The root entry imports none of them, not even lazily, so any bundler (Vite, Rollup, esbuild, webpack, Turbopack) builds an app that installs only this package and core. Each feature entry imports its package on the first call and rejects with `Install <package>` when it is absent, which keeps that code out of the initial scene.

Apps using Stage load this facade and its shared core, then only the feature entries they use and those features' required dependencies. Apps using the Engine API directly can load core without Stage. Choose specific feature imports and load heavier features on demand; keep one matching core version across the app.

The build requires the combined core and stage facade, with every base export retained, to stay strictly below 25,000 bytes gzip. It writes measurements to `test-results/modern-bundle-sizes.json`; `npm run measure:size` repeats the gate against the built artifacts. Lazy features and application bootstrap/chunk overhead are measured separately; this is not the complete page download size.

Give the container a height, for example `<div id="scene" style="height:400px"></div>`:

```ts
import {createStage} from 'margoengine';
const app = await createStage('#scene');
const orb = app.sphere({color: '#84d6bd', roughness: 0.25, scale: [1, 0.85, 1]});
app.onTick(delta => {orb.rotation.z += delta;});
window.addEventListener('pagehide', () => app.dispose(), {once: true});
```

Use a selector, an HTMLElement container or an existing canvas. The wrapper appends its own accessible canvas to containers. `app.dispose()` stops rendering, aborts active imports, removes controls and removes an owned canvas. Existing canvases and their styles remain available after disposal. Call disposal when your page or component unmounts. `onTick` returns an unsubscribe function.

`createStage(target, options)` accepts core camera/backend/capacity options and `controls`, `autoStart`, `label` and `onError`. Controls and rendering start by default. Use `autoStart: false` for manual rendering through `app.engine`. Camera validation and initial rendering finish before creation resolves.

| API | Behavior |
| --- | --- |
| `app.sphere({radius, segments, ...options})` | Creates an orb with the same material/transform options as boxes |
| `app.box({size, color, roughness, metalness, position, rotation, scale, parent, name})` | Creates a box and returns the existing mutable mesh handle |
| `app.mesh(geometry, options)` | Attaches existing or custom geometry with the same options |
| `app.onTick(delta => { ... })` | Runs once per frame with delta in seconds; returns an unsubscribe function |
| `app.fit()` / `app.fit(model.meshes)` | Fits visible geometry, including world transforms and hierarchy |
| `app.use(plugin)` | Attaches an existing plugin and returns it |
| `app.signal` | An `AbortSignal` that aborts when the stage is disposed; the feature entries combine it with yours |
| `app.engine` | Existing core API: camera, picking, plugins, manual render, start/stop and recovery |

## CAD camera controls

`createStage` attaches `CADCameraControls` unless `controls: false`: left drag orbits the pivot, middle, right or
Shift + left drag pans, and the wheel zooms smoothly between 2x `camera.near` and 0.8x `camera.far`. On an engine of
your own, attach them yourself and call `update(delta)` each frame. `setPivot(point)` moves the pivot and keeps the
eye; `orbit(azimuth, elevation)` and `pan(x, y)` move the camera from code. `dispose()` removes the listeners and puts
the canvas's `touch-action` back. It moved here from `@margoengine/core` on 2026-11-07, so import it from this package
(or `margoengine`). For CAD-tool button mappings use `cadControls` of `@margoengine/controls`.

```ts
import { Engine, box } from '@margoengine/core';
import { CADCameraControls } from '@margoengine/stage';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
engine.createMesh().setGeometry(box());
const controls = new CADCameraControls(engine.camera, canvas);
const off = engine.onFrame((_, delta) => controls.update(delta));
engine.start();
window.addEventListener('pagehide', () => { off(); controls.dispose(); engine.dispose(); }, { once: true });
```

## Feature entries

Each optional feature is a function in its own entry that takes the stage, so an app bundles (and must install) only
the ones it imports. With `margoengine` the entries are `margoengine/stage/<entry>`.

| Entry | Function | Package it imports on the first call |
| --- | --- | --- |
| `@margoengine/stage/gltf` | `await addGLTF(app, url, {fit, signal})`: loads glTF/GLB, exposes root transforms and fits the camera | `@margoengine/gltf` |
| `@margoengine/stage/sky` | `await addSky(app, options)`: attaches SkyMoon (sun, moon, stars) | `@margoengine/scenery/sky` |
| `@margoengine/stage/particles` | `await addParticles(app, options)`: attaches GPU particles | `@margoengine/creative/particles` |
| `@margoengine/stage/effects` | `await addEffects(app, options)`: attaches post-processing and atmosphere | `@margoengine/creative/post` |
| `@margoengine/stage/environment` | `await addEnvironment(app, source, options)`: image-based lighting from an HDR, EXR or UltraHDR JPEG | `@margoengine/environment` |
| `@margoengine/stage/shadows` | `await addShadows(app, options)`: cascaded shadows; the meshes present now cast | `@margoengine/shadows` |
| `@margoengine/stage/xr` | `await addXRButton(app, options)`: an accessible Enter VR or Enter AR button that starts an XR session | `@margoengine/xr` |
| `@margoengine/stage/physics` | `await addBody(app, mesh, options)`: a rigid body and a fitted collider, loading physics on first use; `await addPhysics(app, options)` for the world | `@margoengine/physics` and its solver |
| `@margoengine/stage/scene` | `await addScene(app, source, options)`: loads a save or prefab document, one mesh per entity, with lights and cameras, all or nothing | `@margoengine/save`; `@margoengine/gltf-pro` when an entity names a model, `@margoengine/animation` when two entities name the same one, `@margoengine/clustered` for point, spot and extra directional lights |
| `@margoengine/stage/viewer` | `await addViewer(app, url, options)`: a product viewer: model, image-based light, backdrop, shadow, tone mapping, fit and turntable tuned together | `@margoengine/gltf-pro`, `@margoengine/environment`, `@margoengine/staging` or `@margoengine/shadows`, `@margoengine/tonemap` |

```ts
import {createStage} from 'margoengine';
import {addGLTF} from 'margoengine/stage/gltf';
import {addShadows} from 'margoengine/stage/shadows';

const app = await createStage('#scene');
const robot = await addGLTF(app, '/robot.glb');
const shadows = await addShadows(app, {resolution: 2048});
shadows.add(app.box({size: [10, 0.1, 10], position: [0, -0.05, 0]}));
console.log(robot.meshes.length);
```

Use `fit: false` to preserve camera framing and `signal` to cancel. Fits use the world-space AABB of transformed vertices. A failed fit retires the imported model. Existing loader byte limits, rollback and supported model subsets apply: glTF supports static opaque constant-color geometry, without textures, skinning or animation.

`app.fit()` also reads registered meshes from the optional `@margoengine/gltf-pro` and FBX loaders, including their current node world transforms. Pass primitive nodes explicitly to fit a selection; grouping nodes themselves have no geometry. Hidden meshes and their hidden descendants stay excluded from fitting. PBR bounds use CPU bind-pose positions; fitting does not advance animation or read back GPU deformation. These queries leave PBR rendering in its optional package and keep `mesh.geometry` null. `addGLTF` continues to use the basic glTF loader.

Feature entries load the narrow entry of their package and its required dependencies rather than the entire domain pack. A feature whose import finishes after stage disposal rejects with `AbortError` before constructing its plugin; active attached plugins remain owned by the engine and are disposed with it.

`addGLTF` returns the exported `LoadedModel` type:

| Property / method | Contract |
| --- | --- |
| `position`, `rotation`, `scale` | Stable references into the root's Wasm transform storage, with `.set(x, y, z)` and `.setAll(value)` |
| `visible` | Boolean root visibility; hides/shows the complete model hierarchy |
| `bounds` | Read-only property returning a retained `Float32Array` of world-space `[minX, minY, minZ, maxX, maxY, maxZ]`, refreshed on access, including hidden geometry |
| `destroy()` | Idempotently unbinds model nodes and releases geometry/GPU buffers when their last mesh reference retires |
| `raw` | Borrowed WebGPU `{vertex, index}` records; core geometry also carries `instance`. Core records are unique per geometry, registered PBR records remain separate per primitive; `null` on WebGL2 |
| `root`, `meshes` | Existing core handles for hierarchy, queries and domain packs |

The bounds array belongs to the model; treat its contents as read-only. Bounds access scans vertices, so use it when framing or inspecting a model rather than querying large imports every tick. Transforms are read directly from the stage's typed storage; no copied transform objects or JavaScript `Proxy` is involved.

`raw` exposes the actual shared renderer buffers, enabled for read-only storage bindings in custom WGSL compute/render passes. Core vertices use interleaved position/normal floats (24-byte stride), indices use uint32, and packed instances use a 96-byte stride (matrix followed by PBR data). Instance order/count follows the current visible geometry batch and can include other meshes sharing that geometry. Registered PBR records instead borrow the loader's existing 80-byte vertex buffers and uint32 indices, including the current deformed buffer when present, and have no core instance buffer. Raw queries include hidden parts and perform no GPU allocation, rendering, or deformation work. Acquire handles after rendering, do not destroy or overwrite engine-owned buffers, and reacquire `raw` after device recovery. Access after destruction rejects. Core buffer lookup uses its explicit extension API; PBR records come from the existing shared mesh-source registry.

```ts
const model = await addGLTF(app, '/robot.glb');
model.position.set(0, 2.5, 0);
model.scale.setAll(1.2);
model.destroy();
```

Sky, particles, effects and GPU picking retain their WebGPU requirements; unsupported operations reject rather than silently disappearing. Plugins have their existing unique names: remove one through `app.engine.removePlugin(plugin.name)` before attaching a replacement.

## Enter VR and Enter AR

`addXRButton` puts a real `<button>` at the foot of the stage (`parent`, default the canvas's parent) and starts the session when it is clicked, which is the user gesture WebXR asks for. The XR device is prepared before the button appears, so the click goes straight to the browser.

```ts
import {createStage} from 'margoengine';
import {addXRButton} from 'margoengine/stage/xr';

const app = await createStage('#scene', {backend: 'webgpu'});
const orb = app.sphere({color: '#84d6bd', position: [0, 1.5, -2], radius: 0.3});
const button = await addXRButton(app, {
  referenceSpace: 'local-floor',
  onFrame({delta}) {
    orb.rotation.y += delta; // onTick pauses during an immersive session
  },
});
console.log(button.supported);
```

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `'immersive-vr'` | `'immersive-ar'` makes an Enter AR button |
| `parent` | the canvas's parent | Element the button goes in |
| `label`, `exitLabel`, `unavailableLabel` | `Enter VR`, `Exit VR`, `VR not available` (AR likewise) | Button text, for translation |
| `className` | none | Your own CSS class in place of the built-in style |
| `onError` | `engine.onError` | Receives a session that failed to start or end, such as a refused permission |
| `signal` | none | Cancels the wait for the package and the device |
| `referenceSpace`, `requiredFeatures`, `optionalFeatures`, `onFrame` | as `XR.requestSession` | Passed to the session on each click |

A browser with WebXR but not its WebGPU binding still runs XR on a page that runs on the WebGL2 compatibility layer: once the page has called `install()` of `@margoengine/webgl2-compat`, the button puts that layer's XR route in place by itself and takes it away with the last button of the page. Where the session cannot start (no WebXR, no route to it, a WebGL2 stage, a page whose permissions policy blocks WebXR), the button stays on the page, disabled and reading `VR not available`, or `VR needs WebXR's WebGPU binding` when that is what is missing; `button.reason` and the button's `title` say why and name the fix, and `button.supported` is false: no error to catch. The built-in style needs the parent to be its containing block, so a parent with `position: static` is set to `position: relative` and stays so; a second button stacks above the first. With `className` the page is left alone and the placement is yours.

Buttons of one stage share one `XR` plugin (`button.xr`, with `controllers`, `session` and `HitTest`), so a VR and an AR button work side by side. `button.dispose()` removes the button; the last one ends its session and frees the XR device, and the stage's disposal does the same. After the XR device is lost, a click reports through `onError`: dispose the button and add a new one. An `XR` you made yourself with `XR.create` takes the stage's one plugin slot, so `addXRButton` then rejects with `state`.

## Model viewer

`addViewer` is the one call for a product page: it loads a glTF with `@margoengine/gltf-pro` and sets up everything around it, sized to the model. Each part imports its package on first use, and `false` leaves the part and its package out.

```ts
import {createStage} from 'margoengine';
import {addViewer} from 'margoengine/stage/viewer';

const app = await createStage('#scene', {backend: 'webgpu'});
const viewer = await addViewer(app, '/shoe.glb', {
  environment: '/studio.hdr', // leave it out for the built-in soft studio
  shadows: 'contact',
  tonemap: {exposure: 0.2},
});
viewer.turntable = false; // stop the camera; set true to start again
viewer.tonemap!.options.exposure = 0.4; // live
viewer.dispose(); // removes the model and everything the viewer added
```

| Option | Default | What it does |
| --- | --- | --- |
| `environment` | a built-in soft studio | `.hdr`, `.exr` or UltraHDR `.jpg` URL, or a decoded source, for the image-based light; `false` for none |
| `lighting` | none | `EnvironmentLighting.load` options, such as `intensity` |
| `background` | `'#dfe1e4'` | Colour behind the model, light because a ground shadow needs something to darken; `false` for none |
| `shadows` | `'contact'` | `'contact'` is a soft shadow under the model, `'cascaded'` a cast shadow on a floor the viewer adds; `false` for none |
| `shadow` | sized to the model | Options of the chosen shadow, over the viewer's values |
| `tonemap` | `{}`, the package's neutral settings | `Tonemap` options; `false` for none |
| `turntable` | `true` | `{seconds: 30, resumeAfter: 3}`: seconds per turn, negative to turn the other way, and seconds after a drag or wheel before it turns again; off for a visitor who asks for reduced motion, until the page sets `viewer.turntable = true` |
| `fit` | `true` | Frames the model from a three-quarter view and sets the camera's near and far to its size |
| `gltf` | none | `loadGLTF` options, such as a shared `draco` decoder |
| `signal` | none | Cancels the load; the stage's disposal cancels it too |

A failed `addViewer` leaves the stage unchanged. Whichever step fails, a package that is not installed, a part that refuses its options or an abort, the error reaches you, everything it added is gone and the camera is as it was, a fit still animating included. Framing the camera is the last step, so nothing can fail after it, and a failure while framing puts the camera back. A part that also fails to clean up goes to `engine.onError` and does not replace the error. `viewer.dispose()` removes every part even if one throws: it throws the first error and sends the others to `engine.onError`.

The turntable orbits the camera about the world's Y axis, not the model, so a model root off centre stays framed and shadows stay cached. A drag holds it. A file with nothing to draw rejects with `Viewer model has no geometry to frame`. `viewer.dispose()` leaves the camera where it is. Needs WebGPU. The `@margoengine/gltf-pro` model is a `PBRModel` (`viewer.model`), not the `LoadedModel` of `addGLTF`.

## Physics in one call

`addBody` gives a stage mesh a rigid body and a collider. The first call imports `@margoengine/physics`, runs `Physics.load()` and attaches one world to the stage, which then steps with the frame loop. Install it and the solver its README names.

```ts
import {createStage} from 'margoengine';
import {addBody, addPhysics} from 'margoengine/stage/physics';

const app = await createStage('#scene');
const floor = app.box({size: [20, 1, 20], position: [0, -0.5, 0]});
const ball = app.sphere({radius: 0.5, position: [0, 5, 0]});

await addBody(app, floor, {type: 'fixed'});
const body = await addBody(app, ball, {collider: {restitution: 0.6}});
body.applyImpulse([1, 0, 0]);

const physics = await addPhysics(app); // the same world, for joints, queries and events
physics.on('contactstart', ({meshA, meshB}) => console.log(meshA, meshB));
```

Without `colliders` the shape comes from the geometry: a box, a sphere (uniformly scaled), otherwise a convex hull for a dynamic body and the exact triangles for a fixed or kinematic one. A mesh without geometry, such as a model's root, gets a box around what it holds.

| Option | Default | What it does |
| --- | --- | --- |
| `addBody`: `collider` | none | Friction, restitution, density and so on of the collider picked for the mesh; ignored with `colliders` |
| `addBody`: `colliders` and the rest | a fitted collider | As `physics.addBody`: `type` (`'dynamic'`), velocities, damping, `ccd` |
| `addPhysics`: `gravity`, `fixedTimestep` and the rest | as `Physics` | World options, on the first call only; afterwards set them on the world, and options reject with `state` |
| `addPhysics`: `signal` | none | Cancels the wait; the stage's disposal cancels it too |

The convex hull of a concave dynamic mesh fills its hollows: pass `colliders: {shape: 'convexDecomposition'}` to keep them. A world you dispose yourself is replaced on the next call.

## Saved scenes

`addScene` opens a `@margoengine/save` document in one line, so a level made in a tool loads straight into the stage. `source` is a URL, a document, its JSON text or its bytes, gzipped or not. Each entity becomes a mesh with its transform and parent; prefabs expand and `migrations` run first. Either everything loads or nothing stays.

```ts
import {createStage} from 'margoengine';
import {addScene} from 'margoengine/stage/scene';

const app = await createStage('#scene');
const level = await addScene(app, {
  format: 'margo-save',
  version: 1,
  entities: [
    {id: 'floor', components: {mesh: {shape: 'box', size: [10, 1, 10]}, material: {color: '#808080'}}},
    {id: 'ball', parent: 'floor', transform: {position: [0, 2, 0]}, components: {mesh: {shape: 'sphere', radius: 0.5}}},
    {id: 'spawn', transform: {position: [2, 1, 0]}, components: {team: {side: 1}}},
  ],
}, {
  onEntity(mesh, entity) {
    if (entity.components.team) console.log('spawn at', mesh.position.x);
  },
});
level.meshes.get('ball')!.position.y = 3;
level.dispose(); // removes every mesh, model and light of the scene
```

Four components are built in. `mesh` is a glTF URL, relative to the document (loaded with `@margoengine/gltf-pro`), or `{shape: 'box', size}` or `{shape: 'sphere', radius, segments}`. `material` is the PBR options, such as `{color, roughness, metalness}`, and cannot move the mesh. `onEntity` takes every other component.

Lights and cameras come from the document too. Both look down their entity's -Z axis, as in glTF, and take its world pose at load:

```ts
import {createStage} from 'margoengine';
import {addScene} from 'margoengine/stage/scene';

const app = await createStage('#scene');
const level = await addScene(app, {
  format: 'margo-save',
  version: 1,
  entities: [
    {id: 'floor', components: {mesh: {shape: 'box', size: [10, 1, 10]}}},
    {id: 'sun', transform: {rotation: [-0.383, 0, 0, 0.924]}, components: {light: {intensity: 2, color: [1, 0.95, 0.9]}}},
    {id: 'lamp', transform: {position: [2, 2, 0]}, components: {light: {type: 'point', color: [1, 0.5, 0.2], intensity: 12, range: 8}}},
    {id: 'main', transform: {position: [0, 3, 9]}, components: {camera: {fov: 45, target: [0, 0, 0]}}},
    {id: 'side', transform: {position: [9, 3, 0]}, components: {camera: {target: [0, 0, 0], active: false}}},
  ],
});
Object.assign(app.engine.camera, level.cameras.get('side')); // switch view
```

`light` takes the names and defaults of `KHR_lights_punctual`: `{type, color, intensity, range, innerConeAngle, outerConeAngle}`, with `type` `'directional'` (default), `'point'` or `'spot'` and `color` in linear RGB. The first directional light is the engine's sun, and `ambient` sets its ambient strength. Point, spot and further directional lights go to `@margoengine/clustered`, which is attached if it is not already, and every model of the scene receives them; `level.lights` is that `Clustered`. Two scenes' lights add up, and each `dispose` takes its own and puts the sun back. The lights replace a list you set yourself with `setLights`. They need WebGPU; the sun does not.

`camera` is `{fov, near, far, target, active}`; `fov`, `near` and `far` default to the engine camera's, and `target` to the point 10 units ahead. Core's camera looks at a point, so a roll in the entity's rotation is dropped. The first camera the document marks `active: true`, or else the first without `active: false`, sets the view, and then `fit` defaults to false. `level.cameras` holds them all in world space, by entity id.

| Option | Default | What it does |
| --- | --- | --- |
| `prefab` | the document's entities | Loads only this prefab of the document, as one instance |
| `parent` | none | Mesh the top-level entities go under |
| `base` | the document's URL, or the page's | Base of relative model URLs |
| `fit` | `true`, `false` when a `camera` sets the view | Frames the camera on what loaded; a scene with no geometry leaves it alone |
| `onEntity` | none | Called for each entity once all exist: `(mesh, entity, get)`, where `get(id)` gives another entity's mesh for `{"$ref": id}` values. A throw undoes the load |
| `migrations` | none | A `Migrations` that brings an older document to the current version |
| `components`, `strictComponents` | none | Validation, as `parseSave` |
| `gltf` | none | `loadGLTF` options, such as a shared `draco` decoder |
| `signal` | none | Cancels the load; the stage's disposal cancels it too |

An invalid document rejects with a TypeError naming its first problem, and a step that fails rejects with `failed` and the `cause`. Each model URL loads once, in parallel with the other URLs, before the first mesh is made. The other entities on a URL get a `cloneModel` copy, which shares the parsed file, the images and the GPU buffers and has nodes of its own, so 100 trees are one load and one upload, each placed and animated on its own.

All core exports are also available from this package. React applications can use the existing `@margoengine/react` components or wrap the engine received by Canvas `onCreated` with `new Stage(engine)`. The existing Canvas component retains ownership of rendering and teardown in that case.

Run `npm run modern:dev` and open `/quickstart.html` for the five-line demo. Verification: `npm test` and `npm run modern:test:wrapper` after building packages; `npm run test:gpu --workspace packages/stage` runs the model viewer and a saved scene with a real model on real WebGPU.
