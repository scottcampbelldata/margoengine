# @margoengine/stage

You normally use this package as [`margoengine`](../margoengine/README.md): `import {createStage} from 'margoengine'` is this package. The packages are not on npm yet; see the [Install](../../README.md#install) section for the routes that work today.

High-level setup for Margo Engine. Mount a canvas, enable orbit/pan/zoom, start rendering and create a spinning orb in five lines. The stage creates a WebGPU engine. Pass `fallback` from the optional `@margoengine/webgl` when a browser has no WebGPU; without it, creation rejects with `WebGPU unavailable`. Core handles resize and automatically recovers a lost WebGPU device. A lost WebGL2 context reports through `onError` and stops rendering; dispose and recreate the stage to resume.

This package is built from source alongside the engine. See the [package catalog](../../docs/README.md) for npm availability. Run `npm run build:packages` in the repository, or install its local tarball and `@margoengine/core`. The only dependency is `@margoengine/core`. `@margoengine/gltf`, `@margoengine/creative`, `@margoengine/scenery`, `@margoengine/environment`, `@margoengine/shadows` and `@margoengine/xr` are optional peers, used only by the feature entries below. The root entry imports none of them, not even lazily, so any bundler (Vite, Rollup, esbuild, webpack, Turbopack) builds an app that installs only this package and core. Each feature entry imports its package on the first call and rejects with `Install <package>` when it is absent, which keeps that code out of the initial scene.

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

Where the session cannot start (no WebXR, no WebGPU binding, a WebGL2 stage, a page whose permissions policy blocks WebXR), the button stays on the page, disabled and reading `VR not available`, and `button.supported` is false: no error to catch. The built-in style needs the parent to be its containing block, so a parent with `position: static` is set to `position: relative` and stays so; a second button stacks above the first. With `className` the page is left alone and the placement is yours.

Buttons of one stage share one `XR` plugin (`button.xr`, with `controllers`, `session` and `HitTest`), so a VR and an AR button work side by side. `button.dispose()` removes the button; the last one ends its session and frees the XR device, and the stage's disposal does the same. After the XR device is lost, a click reports through `onError`: dispose the button and add a new one. An `XR` you made yourself with `XR.create` takes the stage's one plugin slot, so `addXRButton` then rejects with `state`.

All core exports are also available from this package. React applications can use the existing `@margoengine/react` components or wrap the engine received by Canvas `onCreated` with `new Stage(engine)`. The existing Canvas component retains ownership of rendering and teardown in that case.

Run `npm run modern:dev` and open `/quickstart.html` for the five-line demo. Verification: `npm test` and `npm run modern:test:wrapper` after building packages.
