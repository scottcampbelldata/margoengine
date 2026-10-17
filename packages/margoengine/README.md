# margoengine

High-level setup for Margo Engine. Mount a canvas, enable orbit/pan/zoom, start rendering and create a spinning orb in five lines. Core selects WebGPU with WebGL2 fallback, handles resize and automatically recovers WebGPU device loss. WebGL2 context loss reports through `onError` and stops rendering; dispose and recreate the stage to resume.

This package is built from source alongside the engine. See the [package catalog](../../docs/README.md) for npm availability. Run `npm run build:packages` in the repository, or install its local tarball and `@margoengine/core`. The only dependency is `@margoengine/core`. `@margoengine/gltf`, `@margoengine/machinery`, `@margoengine/creative`, `@margoengine/scenery`, `@margoengine/environment`, and `@margoengine/shadows` are optional peers. `load`, `sky`, `particles`, `effects`, `environment`, and `shadows` import them on use and reject with `Install <package>` when they are absent. Dynamic imports keep that runtime code out of the initial scene.

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
| `await app.load(url, options)` | Loads glTF/GLB/STL/OBJ/STEP/IGES, exposes root transforms and fits the imported meshes |
| `app.onTick(delta => { ... })` | Runs once per frame with delta in seconds; returns an unsubscribe function |
| `app.fit()` / `app.fit(model.meshes)` | Fits visible geometry, including world transforms and hierarchy |
| `await app.sky(options)` | Loads the scenery `/sky` entry and attaches SkyMoon |
| `await app.particles(options)` | Loads creative `/particles` and attaches GPU particles |
| `await app.effects(options)` | Loads creative `/post` and attaches post-processing/atmosphere |
| `app.use(plugin)` | Attaches an existing plugin and returns it |
| `await app.gltf()` / `app.machinery()` / `app.creative()` / `app.scenery()` | Loads the full corresponding pack on demand |
| `app.engine` | Existing core API: camera, picking, plugins, manual render, start/stop and recovery |

Loading infers format from the URL pathname, including `.stp` and `.igs`; set `format` for extensionless endpoints. Use `fit: false` to preserve camera framing, `signal` to cancel, and CAD `onProgress`/`smoothing` options as needed. Fits use the world-space AABB of transformed vertices. A failed fit retires the imported model. Existing loader byte limits, rollback and supported model subsets apply: glTF supports static opaque constant-color geometry, without textures, skinning or animation.

`app.fit()` also reads registered meshes from the optional `@margoengine/gltf-pro` and FBX loaders, including their current node world transforms. Pass primitive nodes explicitly to fit a selection; grouping nodes themselves have no geometry. Hidden meshes and their hidden descendants stay excluded from fitting. PBR bounds use CPU bind-pose positions; fitting does not advance animation or read back GPU deformation. These queries leave PBR rendering in its optional package and keep `mesh.geometry` null. `app.load()` continues to use the basic glTF loader.

Feature helpers load their entry and its required dependencies rather than the entire domain pack. CAD loading uses `@margoengine/machinery/cad`, without kinematics, surface transport or telemetry. Explicit pack accessors keep their complete namespaces for compatibility. A helper whose import finishes after stage disposal rejects with `AbortError` before constructing its plugin; active attached plugins remain owned by the engine and are disposed with it.

`load()` returns the exported `LoadedModel` type:

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
const model = await app.load('/assembly.obj');
model.position.set(0, 2.5, 0);
model.scale.setAll(1.2);
const {AssemblyIndex} = await app.machinery();
const index = new AssemblyIndex(app.engine);
index.tag(model.root, 'assembly');
model.destroy();
```

Sky, particles, effects, sections and GPU picking retain their WebGPU requirements; unsupported operations reject rather than silently disappearing. Heavy CAD workers are loaded by the existing machinery package when needed. Plugins have their existing unique names: remove one through `app.engine.removePlugin(plugin.name)` before attaching a replacement.

All core exports are also available from this package. React applications can use the existing `@margoengine/react` components or wrap the engine received by Canvas `onCreated` with `new Stage(engine)`. The existing Canvas component retains ownership of rendering and teardown in that case.

Run `npm run modern:dev` and open `/quickstart.html` for the five-line demo. Verification: `npm test` and `npm run modern:test:wrapper` after building packages.
