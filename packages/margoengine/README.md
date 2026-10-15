# margoengine

High-level setup for Margo Engine. Mount a canvas, enable orbit/pan/zoom, start rendering and create a spinning orb in five lines. Core renders with WebGPU, handles resize and automatically recovers WebGPU device loss. Browsers without WebGPU need the optional `@margoengine/webgl` fallback passed to `Engine.create` (see its README); the stage does not include it.

This package is built from source alongside the engine. See the [package catalog](../../docs/README.md) for npm availability. Run `npm run build:packages` in the repository, or install its local tarball and the matching engine packages. Dependencies install the packs together, while dynamic imports keep their runtime code out of the initial scene.

Apps using Stage load this facade and its shared core, then only the feature entries they use and those features' required dependencies. Apps using the Engine API directly can load core without Stage. Choose specific feature imports and load heavier features on demand; keep one matching core version across the app.

The build requires the combined core and stage facade, with every base export retained, to stay strictly below 20,000 bytes gzip. It writes measurements to `test-results/modern-bundle-sizes.json`; `npm run measure:size` repeats the gate against the built artifacts. Lazy features and application bootstrap/chunk overhead are measured separately; this is not the complete page download size.

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
| `await app.load(url, options)` | Loads glTF/GLB/STL/OBJ/STEP/IGES, exposes root transforms and fits the imported meshes |
| `app.onTick(delta => { ... })` | Runs once per frame with delta in seconds; returns an unsubscribe function |
| `app.fit()` / `app.fit(model.meshes)` | Fits visible geometry, including world transforms and hierarchy |
| `await app.sky(options)` | Loads the scenery `/sky` entry and attaches SkyMoon |
| `await app.particles(options)` | Loads creative `/particles` and attaches GPU particles |
| `await app.effects(options)` | Loads creative `/post` and attaches post-processing/atmosphere |
| `await app.environment(url, options)` | Loads `@margoengine/environment` and lights every mesh with image-based lighting from an `.hdr`, `.exr` or UltraHDR `.jpg` (or a decoded image); returns the `EnvironmentLighting` (`.environment` has `intensity` and `rotation`) |
| `await app.shadows(options)` | Loads `@margoengine/shadows` and attaches cascaded shadows for the directional light; meshes present at the call cast, add later ones with `shadows.add(mesh)` |
| `app.use(plugin)` | Attaches an existing plugin and returns it |
| `await app.gltf()` / `app.machinery()` / `app.creative()` / `app.scenery()` | Loads the full corresponding pack on demand |
| `app.engine` | Existing core API: camera, picking, plugins, manual render, start/stop and recovery |

Loading infers format from the URL pathname, including `.stp` and `.igs`; set `format` for extensionless endpoints. Use `fit: false` to preserve camera framing, `signal` to cancel, and CAD `onProgress`/`smoothing` options as needed. Fits use the world-space AABB of transformed vertices. A failed fit retires the imported model. Existing loader byte limits, rollback and supported model subsets apply: glTF supports static opaque constant-color geometry, without textures, skinning or animation.

Feature helpers load their entry and its required dependencies rather than the entire domain pack. CAD loading uses `@margoengine/machinery/cad`, without kinematics, surface transport or telemetry. Explicit pack accessors keep their complete namespaces for compatibility. A helper whose import finishes after stage disposal rejects with `AbortError` before constructing its plugin; active attached plugins remain owned by the engine and are disposed with it. `app.environment()` is `EnvironmentLighting.load(app.engine, url, options)`: it rejects with `AbortError` and attaches nothing when the stage is disposed before the image is fetched and processed (pass `signal` to also cancel a download in flight), and disposing the returned lighting also removes its environment. For a visible environment background or fog, use `EnvironmentBackground`/`Fog` from `@margoengine/environment` with `app.engine`.

```ts
const lighting = await app.environment('/studio.hdr', {intensity: 1.2});
const shadows = await app.shadows({resolution: 2048, distance: 50});
shadows.add(app.box({position: [2, 0.5, 0]})); // meshes created after the call
```

`load()` returns the exported `LoadedModel` type:

| Property / method | Contract |
| --- | --- |
| `position`, `rotation`, `scale` | Stable references into the root's Wasm transform storage, with `.set(x, y, z)` and `.setAll(value)` |
| `visible` | Boolean root visibility; hides/shows the complete model hierarchy |
| `bounds` | Read-only property returning a retained `Float32Array` of world-space `[minX, minY, minZ, maxX, maxY, maxZ]`, refreshed on access, including hidden geometry |
| `destroy()` | Idempotently unbinds model nodes and releases geometry/GPU buffers when their last mesh reference retires |
| `raw` | WebGPU buffer records `{vertex, index, instance}` per unique geometry; `null` on WebGL2 |
| `root`, `meshes` | Existing core handles for hierarchy, queries and domain packs |

The bounds array belongs to the model; treat its contents as read-only. Bounds access scans vertices, so use it when framing or inspecting a model rather than querying large imports every tick. Transforms are read directly from the stage's typed storage; no copied transform objects or JavaScript `Proxy` is involved.

`raw` exposes the actual shared renderer buffers, enabled for read-only storage bindings in custom WGSL compute/render passes. Vertices use interleaved position/normal floats (24-byte stride), indices use uint32, and packed instances use a 96-byte stride (matrix followed by PBR data). Instance order/count follows the current visible geometry batch and can include other meshes sharing that geometry. Acquire handles after rendering, do not destroy or overwrite engine-owned buffers, and reacquire `raw` after device recovery. Access during recovery or after destruction rejects. The buffer lookup remains confined to core's explicit extension API.

```ts
const model = await app.load('/assembly.obj');
model.position.set(0, 2.5, 0);
model.scale.setAll(1.2);
const {AssemblyIndex} = await app.machinery();
const index = new AssemblyIndex(app.engine);
index.tag(model.root, 'assembly');
model.destroy();
```

Sky, particles, effects, environment, shadows, sections and GPU picking retain their WebGPU requirements; unsupported operations reject rather than silently disappearing. Heavy CAD workers are loaded by the existing machinery package when needed. Plugins have their existing unique names: remove one through `app.engine.removePlugin(plugin.name)` before attaching a replacement.

All core exports are also available from this package. React applications can use the existing `@margoengine/react` components or wrap the engine received by Canvas `onCreated` with `new Stage(engine)`. The existing Canvas component retains ownership of rendering and teardown in that case.

Run `npm run modern:dev` and open `/quickstart.html` for the five-line demo. Verification: `npm test` and `npm run modern:test:wrapper` after building packages.
