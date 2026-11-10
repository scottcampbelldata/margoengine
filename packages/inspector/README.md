# @margoengine/inspector

Import `margoengine/inspector` from the `margoengine` package, or `@margoengine/inspector` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional DOM inspector for core entities, including `stage.engine`. The hierarchy
updates as entities are added, renamed, reparented or disposed. Arrow keys select,
expand and collapse tree items. Selected entities expose visibility, local
transforms and their core PBR material's roughness and metallic values. Editing a
shared material changes every mesh using it.

```ts
import {Inspector} from 'margoengine/inspector';
import type {EngineKernel} from 'margoengine/core';
function attach(engine: EngineKernel, effects: {exposure: number; bloom: number}) {
  return Inspector.attach(engine, {effects});
}
```

Pass the mutable options object of your attached post-processing effect to
`effects`; exposure/bloom controls bind directly to it. Unbound controls are disabled
and initially display zero. With no selected entity, roughness/metallic sliders
initially display the core material defaults, 0.5/0, while disabled.

## Place the panel in your page layout

By default the panel is a `position: fixed` element at the top right of the page with a high `z-index`. In an app with
its own buttons in that corner it sits on top of them and takes their clicks. Give it a container with `parent`, and
override its position with a style on `inspector.element` (a style set there wins over the panel's built-in one):

```ts
import {Inspector} from 'margoengine/inspector';
import type {EngineKernel} from 'margoengine/core';
function attachInSidebar(engine: EngineKernel, sidebar: HTMLElement) {
  const inspector = Inspector.attach(engine, {parent: sidebar});
  Object.assign(inspector.element.style, {
    position: 'relative', top: 'auto', right: 'auto', width: '100%', maxHeight: '70vh', overflow: 'auto',
  });
  return inspector;
}
```

The panel then sits in the flow of `sidebar` with a bounded height and scrolls inside it. The
[debugging guide](../../docs/guides/debugging.md) runs this in a real browser and clicks the button next to the panel.

## Edit, undo, search, pick, save

Every change made in the panel (name, visibility, position, rotation, scale, colour, double sided, roughness, metallic,
bound effects) is recorded and can be undone with the Undo and Redo buttons, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` or
`Ctrl/Cmd+Y` (inside a text field the browser keeps its own undo). A slider drag is one step. The Search box keeps the
entities whose name contains the text, and their parents. A click on the canvas selects the object under the pointer
(`pick: false` turns it off; a pointer that moves more than 4 px is a camera drag, not a click). Colour edits the core
material's base colour (sRGB in the panel, linear in the material).

```ts
import {Inspector} from 'margoengine/inspector';
import type {EngineKernel} from 'margoengine/core';
async function tour(engine: EngineKernel) {
  const inspector = Inspector.attach(engine, {historyLimit: 500});
  const saved = JSON.stringify(inspector.snapshot());   // names, visibility, transforms, material values
  // ...edit in the panel or in code...
  inspector.restore(JSON.parse(saved));                 // one undoable step; checks the file first
  inspector.undo();
  inspector.redo();
  console.log(inspector.resources());                   // meshes, geometries, materials, triangles, plugins
  console.log(inspector.shaderSource.length);           // the scene WGSL of the latest WebGPU frame
  inspector.history.onChange(() => console.log(inspector.history.nextUndo));
}
```

The panel's Save button downloads the snapshot as `scene.json` and Load restores one. `restore` matches meshes by id,
reports the ones that are gone (`missing`), changes nothing when the file is malformed or the engine rejects a value
(a scale of 0), and does not recreate or reparent meshes. The Resources section counts what the engine draws, and Scene
shader shows the WGSL of the latest WebGPU frame; both build their text only while open. Without the panel, import
`EditHistory` from `margoengine/inspector/history`, `snapshotMeshes`/`restoreSnapshot`/`parseSnapshot` from
`margoengine/inspector/snapshot` and `describeEngine` from `margoengine/inspector/resources`.

Creation, deletion and reparenting use the optional `/edit` entry; WGSL editing uses `/shaders`.
The root panel has no GPU memory view (WebGPU does not report resource sizes).
Other packages' lights, materials, shadows and effects are edited in the package panel below.

## Choose an optional editor

Import each feature from `@margoengine/inspector/<entry>` or its forwarding alias
`margoengine/inspector/<entry>`. Attaching the root Inspector does not attach these editors.
Use an existing inspector's `history` where an editor accepts one to share undo and redo.
Importing an entry does not install texture instrumentation, start a relay or create a panel.

| Entry | Public starting point | Purpose |
|---|---|---|
| `tweak` | `new TweakPanel(options)` | Bind application settings without an engine. |
| `gizmo` | `InspectorGizmo.attach(engine, inspector, options)` | Transform the inspector selection. |
| `edit` | `SceneEditor.attach(engine, inspector, options)` | Create and edit core entity hierarchies. |
| `textures` | `TextureCapture.start(options)`, `TextureViewer.attach(capture, options)` | Capture WebGPU textures before opening a viewer. |
| `animation` | `AnimationPanel.attach(engine, players, options)` | Inspect clip playback and skeletons. |
| `gl` | `GLInspector.attach(engine, options)`, `captureGLFrame(engine, options)` | Native WebGL2 preview overlays and frame capture. |
| `tools` | `CameraTools.attach(engine, options)` | Camera selection, canvas capture and glTF export. |
| `shaders` | `ShaderEditor.attach(engine, options)`, `recompileShader(mesh, wgsl, options)` | Edit a WgslMaterial with device diagnostics. |
| `remote` | `RemoteTarget.attach(engine, options)`, `new RemoteInspector(options)` | Inspect another running page. |
| `remote-relay` | `await createRemoteRelay(options)` | Node development relay for remote pages. |

## Application settings and gesture undo

`TweakPanel` needs a DOM but no engine. Its default parent is `document.body`, title is
`Parameters`, and history is a new `EditHistory`. `parent`, `title`, `history` and `signal`
override those choices. `add(object, key, options)` returns a binding for a number, string,
boolean, vector, enum or function button. `addColor` selects colour controls;
`addFolder(title)` creates a child panel sharing the history.

Numeric `min` and `max` default to unbounded, with no quantization until `step` is set.
`axes` overrides ranges per vector component. Colours accept `#rrggbb`, 24-bit integers,
or RGB(A) components; `colorScale` defaults to 1 and also accepts 255, while alpha stays
in 0..1. `options` supplies an enum array or a label-to-value map. `readonly` defaults
to false; `label` defaults to the property key. Function buttons are outside history
unless their binding has an `undo` function.

`binding.setValue(value)` validates and records one step. Input events in a gesture
coalesce until change or blur; Escape cancels the pending gesture. Vector and colour
component edits preserve the bound object's identity. `getValue`, `reset`, `onChange`
and `refresh` expose the binding without DOM events; `onChange` returns an unsubscribe
function. Call `panel.refresh()` after application writes: there is no polling timer.
`panel.undo()` and `panel.redo()` use its history. Dispose bindings or the whole panel
when finished; aborting the supplied signal disposes the panel and its folders.


```ts
import {TweakPanel} from '@margoengine/inspector/tweak';
const settings = {speed: 1, enabled: true, color: '#ff8800', position: [0, 1, 0], mode: 'solid', reset: () => console.log('reset')};
const panel = new TweakPanel({title: 'Preview'});
const folder = panel.addFolder('Appearance');
const speed = panel.add(settings, 'speed', {min: 0, max: 4, step: 0.1});
panel.add(settings, 'enabled');
folder.addColor(settings, 'color');
folder.add(settings, 'position', {kind: 'vector'});
folder.add(settings, 'mode', {options: ['solid', 'wire']});
panel.add(settings, 'reset');
speed.setValue(2);
panel.undo(); panel.redo();
console.log(settings.speed); // 2
panel.dispose(); // At application teardown; leave attached to edit interactively.
```

## Selection gizmos

Attach `InspectorGizmo` after its Inspector is attached to the same engine. The gizmo
follows `inspector.selected`; `sync()` updates it immediately after a programmatic
selection. `controls` exposes the underlying TransformControls. The toolbar defaults
to `inspector.root`; `parent: null` hides it. The default mode is translate, space is
world, size is 1, and translation/rotation/scale snapping is off. Other control options
and defaults are documented in [TransformControls](../controls/README.md).

Pass `cameraControls` to suspend those controls for a gizmo drag and restore their
previous enabled state afterward. A completed drag is one step in `inspector.history`.
Canvas keyboard shortcuts default to enabled: W/E/R choose move/rotate/scale, Q changes
space, +/- change size and Escape cancels a drag. `keyboard: false` leaves keyboard
handling to the application. Disposal removes listeners, toolbar and controls, restores
the canvas tabindex and camera control state, and detaches the owned plugin. An abort
signal, engine disposal or removal of a connected inspector also releases the gizmo.


```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {Inspector} from '@margoengine/inspector';
import {InspectorGizmo} from '@margoengine/inspector/gizmo';
const canvas = document.body.appendChild(document.createElement('canvas'));
canvas.width = 480; canvas.height = 320;
const engine = await Engine.create(canvas);
const mesh = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial());
const inspector = Inspector.attach(engine);
const gizmo = InspectorGizmo.attach(engine, inspector);
inspector.select(mesh);
gizmo.sync();
engine.render();
// Keep these attached for interactive dragging, then release in this order.
gizmo.dispose(); inspector.dispose(); engine.dispose(); canvas.remove();
```

## Create, delete, duplicate and reparent

`SceneEditor` attaches to the inspector's scene, with one editor per scene. Its toolbar
defaults to `inspector.root` and may be hidden with `parent: null`. `createPrimitive`
defaults to a box at the root origin; supported kinds are box, sphere, plane, cylinder,
cone, capsule, torus, circle, ring and torusKnot, using geometry-package dimensions.
An optional parent makes the new primitive's origin parent-relative.

`createLight` supports point (default), spot, directional and ambient lights with white
colour, intensity 1, range 10, angle PI/4 and penumbra 0. The returned mesh is a
selectable transform anchor. `light(handle)` reads a copy of its settings and
`setLight(handle, values)` records a checked edit. Existing `lights` and `directional`
plugins must belong to this scene; otherwise the editor finds or attaches its lighting
plugins when needed. Clustered point/spot lighting requires WebGPU.

`delete()` and `duplicate()` default to the current selection and operate on its
subtree. Duplication shares immutable geometry and copies each distinct material once.
`reparent(handle, parent)` preserves the local transform, accepts null for the root,
and rejects cycles before editing. Tree dragging uses the same operation. Delete and
Ctrl/Cmd+D shortcuts in the tree default to enabled (`keyboard: false` disables them).
These operations use the inspector history; package-owned PBR subtrees must be edited
through their owning package rather than this core hierarchy editor.

Deletion retains original handles for undo, hides the subtree and removes its drawable
geometry. Deleted handles are finally disposed when their last retaining history entry
is discarded. Editor disposal removes its UI, input and owned lights while keeping
scene meshes and shared history usable. The supplied signal also disposes it.


```ts
import {Engine} from '@margoengine/core';
import {Inspector} from '@margoengine/inspector';
import {SceneEditor} from '@margoengine/inspector/edit';
const canvas = document.body.appendChild(document.createElement('canvas'));
canvas.width = 480; canvas.height = 320;
const engine = await Engine.create(canvas);
const inspector = Inspector.attach(engine);
const editor = SceneEditor.attach(engine, inspector);
const parent = editor.createPrimitive('box');
const child = editor.createPrimitive('sphere', parent);
const copy = editor.duplicate(child);
editor.reparent(copy, null);
editor.delete(copy);
inspector.undo(); // Restores the same retained handle.
const light = editor.createLight('ambient');
editor.setLight(light, {intensity: 0.5});
console.log(editor.light(light));
editor.dispose(); inspector.dispose(); engine.dispose(); canvas.remove();
```

## Texture capture and previews

Start `TextureCapture` before `Engine.create` and before loading textures. A viewer
opened later can then inspect earlier captured textures. The default GPU is
`navigator.gpu`; `gpu: null` watches only devices explicitly passed to `watchDevice`.
`watchGPU` follows future adapter/device requests, `watchAdapter` follows future
devices, and `watchDevice` captures future texture creation. Existing resources need
`register(device, texture)`, which does not change their usage. `watchCanvas(context)`
captures future swapchain textures and must run before the desired canvas frame.

`inspectable` defaults to true: captured creation descriptors gain TEXTURE_BINDING
without mutating application descriptors. Turning it off preserves usage flags, but
resources without TEXTURE_BINDING cannot be previewed. `list()` reports live metadata;
`onChange` returns an unsubscribe function. Destroyed or collected textures disappear.

`preview(id, options)` returns width, height and top-left RGBA display bytes, rather than
raw source-format data. Defaults are mip 0, layer 0, channel rgba, exposure 1 and range
[0,1]. Layers select array/cube faces or a 3D slice at the chosen mip. Channels are
rgba, rgb, r, g, b and a; isolated channels display as grayscale. Aspect defaults to
depth-only for depth formats, stencil-only for stencil8 and all otherwise. An explicit
aspect must exist in the source. Exposure multiplies values before range mapping and
clamping, so integer and HDR textures need an appropriate range. Invalid mip, layer,
aspect or mapping rejects; this is a display preview, not a lossless texture export.

`TextureViewer.attach` defaults to `document.body`; `select(id, options)` resolves after
the pixels are visible. A preview signal cancels its wait without cancelling unrelated
GPU work. Disposing the viewer cancels its preview but keeps the capture alive. Disposing
or aborting the capture removes its owned wrappers and metadata without destroying
application textures. Keep both handles and dispose each owner explicitly.


```ts
import {Engine} from '@margoengine/core';
import {TextureCapture, TextureViewer} from '@margoengine/inspector/textures';
const capture = TextureCapture.start(); // Before engine/device/texture creation.
const canvas = document.body.appendChild(document.createElement('canvas'));
canvas.width = 480; canvas.height = 320;
const engine = await Engine.create(canvas);
const device = engine.gpu!; // This example requires WebGPU.
const texture = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING});
device.queue.writeTexture({texture}, new Uint8Array([255, 128, 0, 255]), {bytesPerRow: 4}, [1, 1]);
const id = capture.register(device, texture);
const viewer = TextureViewer.attach(capture);
await viewer.select(id, {channel: 'rgba', mip: 0, layer: 0});
const preview = await capture.preview(id);
console.log(preview.width, preview.height);
viewer.dispose(); capture.dispose(); texture.destroy(); engine.dispose(); canvas.remove();
```

## Animation playback and skeletons

`AnimationPanel.attach(engine, players, options)` accepts live Animation players from
that engine. Omitting players discovers existing Animation plugins; `add(player)` adds
later players. `parent` defaults to `document.body`; null leaves the controls detached.
`state(player, clipIndex)` returns a copy of a clip's time, weight, playing, loop and
speed. Indices distinguish clips with duplicate names. `set(player, clipIndex, patch)`
updates these values and immediately poses scrubs and weight changes. Time, weight and
speed must be finite and nonnegative; time clamps to clip duration. UI scrubbing pauses
that clip. Positive clip weights normalize per model; all-zero weights show the pose
captured when the player was added.

The panel owns each added player's clock until `remove(player)` or disposal. Initial
time and weight select the player's current clip; other weights start at zero, while
playing, loop and speed follow its captured state. Skeleton checkboxes show an SVG
overlay on either backend when skins exist. Removal restores the saved pose and player
state for a live model, without disposing the player or model. Model disposal removes
its controls. Panel disposal, engine disposal or its abort signal releases all models,
helpers and DOM.

Serve the repository root so the included Fox GLB is available at the URL below.

```ts
import {Engine} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import {AnimationPanel} from '@margoengine/inspector/animation';
const canvas = document.body.appendChild(document.createElement('canvas'));
canvas.width = 480; canvas.height = 320;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb');
const player = Animation.attach(model);
const panel = AnimationPanel.attach(engine, [player]);
panel.set(player, 0, {playing: false, time: 0.5, weight: 1});
console.log(panel.state(player, 0));
engine.render();
panel.remove(player); // Returns clock/pose ownership to the player.
panel.dispose(); player.dispose(); model.dispose(); engine.dispose(); canvas.remove();
```

## Native WebGL2 preview inspection

The root Inspector's debug overlays are WebGPU-only. For an engine using the WebGL2
preview backend, attach `GLInspector` and use `setDebug` with wireframe, normals, bounds
or lights. Its parent defaults to `document.body`; null keeps controls detached.
This entry operates on the engine's native WebGL2 context and owns its debug program
and overlays; it does not load a compatibility renderer or require a compatibility-package
peer dependency. Overlay drawing restores the GL state it changes.

`capture(options)` or standalone `captureGLFrame(engine, options)` reports native draw
calls, arguments, program/framebuffer/vertex-array ids, viewport, depth/blend/cull state,
shader sources and per-view passes with owners and CPU/GPU costs. `render` defaults to
true; false waits for the next application frame. `timeout` defaults to 5000 ms and
must be positive and finite. Only one capture per engine may be pending. `signal`
cancels capture; panel disposal cancels its own pending capture. Temporary capture
wrappers are removed on success or failure. GPU costs are null when timer queries are
unsupported or disjoint; a null value is not zero cost. Context loss disables overlays;
dispose and reattach after restoring the context.


```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {GLInspector} from '@margoengine/inspector/gl';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas, {backend: 'webgl2', fallback: webglRenderer});
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial());
const panel = GLInspector.attach(engine);
panel.setDebug('bounds', true);
const report = await panel.capture({render: true, timeout: 5000});
console.log(report);
panel.dispose(); engine.dispose(); canvas.remove();
```

`GLInspector` is a reviewed preview route in `scripts/check-preview-contract.mjs` (2026-11-10, 3 `backend` tests): it exists for the small WebGL2 preview and draws its overlays with WebGL2 there. Pixel evidence: `test/gl-browser.mjs` (`npm run test:browser:gl`, and `test:browser:gl:compat`); unit evidence: `test/gl.test.js`. No behaviour changed; the row was missing, which kept `npm run verify` red.

## Cameras, screenshots, recordings and glTF

`CameraTools.attach` defaults to `document.body`; use `parent: inspector.root` to place
it beside the tree or null for detached controls. `cameras` supplies named application
cameras; `addCamera` adds or replaces one and `removeCamera` removes it. Id `default`
and ids starting with `model:` are reserved. `list()` includes application cameras and
live loaded-model cameras discovered from scene plugins or supplied in `models`.
Await `select(id)` to activate one. The selected camera's live pose/projection is copied
each update; selecting default restores the engine camera captured at attach time.

`screenshot(options)` renders and returns a Blob of canvas pixels, excluding DOM
overlays. Type defaults to image/png; JPEG/WebP requests may fall back to PNG in the
browser. Lossy `quality` defaults to the browser choice and accepts 0..1; `timeout`
defaults to 10000 ms. `startRecording(options)` lazily loads video/record and returns
its recording handle. Await `stopRecording()` for the final encoded Blob; the browser
must support canvas capture and MediaRecorder. Only one recording may start or run
at once. Recording options are those of [video/record](../video/README.md).

`exportGLTF(options)` lazily loads exporters. It defaults to binary GLB for the engine
scene; `binary: false` returns embedded-buffer glTF JSON. Passing a live `model` from
this engine selects model export, preserving its PBR data, skins and attached animations
through the model exporter. Screenshot, recording and export accept operation signals;
the panel's signal disposes the tools. Disposal restores the original camera, aborts
pending work, disposes recording, revokes owned download URLs and removes the panel.
Loaded-camera projection support is imported only when selecting a loaded camera.


```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {CameraTools} from '@margoengine/inspector/tools';
const canvas = document.body.appendChild(document.createElement('canvas'));
canvas.width = 480; canvas.height = 320;
const engine = await Engine.create(canvas);
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial());
const tools = CameraTools.attach(engine);
await tools.select('default');
const png = await tools.screenshot({type: 'image/png'});
const glb = await tools.exportGLTF();
console.log(png.size, glb);
tools.dispose(); engine.dispose(); canvas.remove();
```

## Edit other packages' objects

`margoengine/inspector/packages` edits what other packages attach, found by shape without importing them: core's sun and
ambient, every light in a `clustered*` plugin's `list` (point, spot, directional, area), the glTF PBR materials of the
scene's gltf-pro and FBX nodes (base colour, opacity, roughness, metallic, normal scale, occlusion, emissive, alpha
cutoff, double sided, wireframe), the `shadows` options (distance, cascade blend, light size, bias, normal bias, caster
margin) and every other plugin's `options` numbers and switches (Bloom's strength, threshold, exposure and radius, say).
An option the app never set shows its documented default; an undo back past the first edit unsets it again.

```ts
import {Inspector} from 'margoengine/inspector';
import {PackageEditor, findPackageObjects, editProperty} from 'margoengine/inspector/packages';
import type {EngineKernel} from 'margoengine/core';
function editPackages(engine: EngineKernel, settings: {speed: number}) {
  const inspector = Inspector.attach(engine);
  // One undo history for both panels; `objects` adds your own (a materials Material, app settings).
  const editor = PackageEditor.attach(engine, {history: inspector.history, objects: {Settings: settings}});
  const sun = findPackageObjects(engine).find((o) => o.id === 'light:sun')!;
  editProperty(sun, 'intensity', 4, inspector.history);   // checked: a negative intensity throws RangeError
  editor.set('light:sun', 'color', [1, 0.9, 0.8]);
  return editor;
}
```

Each object has an `id` (`light:clustered:0`, `material:0`, `shadows:shadows`, `effect:bloom`), a `group` and its
`properties` (`key`, `kind` number, boolean, color or vector, `min`, `max`, live `get` and `set`). Colours are linear
RGB (the panel's colour inputs are sRGB). The panel lists objects again every 500 ms when plugins, lights or meshes come
and go. A glTF material whose `@margoengine/materials` shading reports a version is shown read only (that shading
caches its values by version): pass its `Material` in `objects`, whose setters `describeObject` finds. A package reads
most of these values every frame; an option it reads only when it attaches keeps its old value until it is attached
again.

WebGPU wireframe edges, world-space vertex normals and AABB boxes use the existing
`@margoengine/lines` helpers. These overlays apply to core meshes and loaded glTF/FBX
PBR nodes, including every primitive on a node, and honor inherited visibility.
PBR wireframes, normals and bounds show the retained CPU bind pose with the current
world transform. They do not read animated vertex buffers back from the GPU.
The loader keeps ownership of its geometry, and no duplicate core draw is created.
Disposing a model removes its overlays. "Light helpers" draws the lights the engine has, found by shape without
importing their packages: core's sun, every `clustered*` plugin's `list` (point and spot, directional and area lights)
and an environment hemisphere or ambient light (lines' `LightsHelper`). Debug drawing is disabled on WebGL2. The hierarchy and property
editor still work there. Neither core nor the stage facade is modified.

With engine views, the debug helpers show in each view for the meshes that view draws (its culling and layers), the tree lists the meshes of the inspector's scene (`scene.use(inspector)` for another scene), and a frame capture lists every pass once per view with `view` (id, rectangle, scene); scenes created after a capture starts appear from the next capture. `select(mesh)` selects an entity. `setDebug('wireframe' | 'normals' | 'bounds' | 'lights', true)`
toggles a scene overlay. `dispose()` releases the DOM, timer, GPU resources and
registered passes; engine disposal also performs this cleanup.

## Live shader editing

`margoengine/inspector/shaders` edits the WGSL of a mesh drawing a `WgslMaterial` from `margoengine/materials` and
recompiles it in place. `ShaderEditor.attach(engine, {meshes})` shows a panel with the mesh list and its WGSL; typing
applies after a short pause. Each edit is compiled on the device first, inside the module text the engine drew, so a
broken edit is never drawn: its errors are listed with their line and column, and the mesh keeps its last good shader.
A good edit swaps in a new material with the same uniforms, textures and other values, and undo puts the old one
back. `recompileShader(mesh, wgsl, {device: engine.gpu})` does the same without a panel and returns the compiler's
messages. Diagnostics need WebGPU; generated shaders of other materials stay read only in the Inspector.

Pass actual materials-package `createMesh` results drawing a `WgslMaterial` in `meshes`
(an array or a function called by `refresh`). `history` defaults to a new EditHistory;
pass the inspector history to share undo. `parent` defaults to `document.body`, `live`
defaults to true, `delayMs` defaults to 400 (0..10000), and `timeoutMs` defaults to 3000.
`apply()` resolves with the edit result; `result` holds the last displayed result.

Standalone `recompileShader` needs the drawing device for compiler checks. Without
`device`, it swaps unchecked. Its `settleMs` defaults to 50 and must be between zero and
`timeoutMs`; timeoutMs accepts 0..60000. Keep rendering while awaiting an edit: the
first checked edit may need a frame to learn the full generated module. Inspect `ok`,
`modules` and `diagnostics`, rather than assuming a resolved promise proves compilation.
Diagnostics use 1-based edited-text coordinates, with zero for engine-generated text.
An unchanged edit may return ok with zero modules. Zero observed modules do not prove
GPU compilation; keep the target visible and rendering for that evidence. Dispose the editor
to remove its timer, listeners and panel; meshes and their materials remain app-owned.

A standalone WebGPU edit with a visible mesh:

```ts
import {Engine} from '@margoengine/core';
import {boxGeometry} from '@margoengine/geometry';
import {WgslMaterial, createMesh} from '@margoengine/materials';
import {ShaderEditor, recompileShader} from '@margoengine/inspector/shaders';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [2, 2, 3], target: [0, 0, 0]}});
const wgsl = 'fn shade(i: Out, s: Surface) -> Surface { var o = s; o.base = vec4f(0.2, 0.6, 0.9, 1.0); return o; }';
const mesh = createMesh(engine, boxGeometry(1, 1, 1), new WgslMaterial({wgsl}));
const editor = ShaderEditor.attach(engine, {meshes: [mesh], live: false});
engine.start(); // The edit must render to compile its pipelines.
const result = await recompileShader(mesh, wgsl.replace('0.2, 0.6, 0.9', '0.9, 0.4, 0.2'), {device: engine.gpu, history: editor.history});
if (!result.ok || result.modules === 0) throw new Error(JSON.stringify(result));
console.log(result.diagnostics);
editor.history.undo();
editor.dispose(); engine.dispose(); canvas.remove();
```

## Remote inspection

`margoengine/inspector/remote` inspects a scene running on a phone or headset from a desktop browser. The page on the
device attaches a `RemoteTarget`, the desktop page creates a `RemoteInspector`, and the two talk over any string
channel: `channelTransport` wraps a MessagePort, BroadcastChannel or WebSocket the app already has, and
`relayTransport` goes through the development relay that `margoengine/inspector/remote-relay` starts in Node
(`createRemoteRelay({host: '0.0.0.0'})` returns a LAN url and a token). The desktop panel lists the device's lights,
materials, shadows, post effects and meshes with their values, edits them (each edit is checked on the device, with
undo), shows the frame rate and takes a screenshot of the device's canvas. The target runs only that fixed list of
operations and, when given a token, refuses requests without it. Development builds only.

Start the Node relay separately from the browser bundles. Its defaults are host
127.0.0.1, port 0 (a free port), a random 32-byte base64url token and a 16000000-byte
message limit. A supplied token needs at least 16 characters; maxBytes accepts
1..16000000. Use the returned `url` and `token` for each `relayTransport`, with role
target on the scene page and viewer on the desktop page. The token travels in the
Authorization header, never in the URL. Configure the same optional protocol token
on RemoteTarget and RemoteInspector as well. Anyone holding the relay token can
inspect the scene; keep this facility in development builds.

Attach the target before awaiting `viewer.connect()`. Connect resolves after hello
and scene delivery; `set`, `undo`, `redo` and `capture` return promises for target
operations. The viewer parent defaults to document.body, with null for no panel;
`timeoutMs` defaults to 10000 and accepts 100..120000. A screenshot returns base64 PNG
data, mimeType and dimensions, of canvas pixels only. `relayTransport`'s `onError` is called
once on a send/stream failure, after which that transport stops. Dispose the target
and viewer, close their transports, then await the relay's `close()` (or use async
disposal) when the session ends.

For browser checks, wait for relay state delivery and shader pipeline/submitted-work
readiness rather than sleeping for a guessed duration. The package's
`test:browser:remote` exercises two browser connections to a real local relay on one
machine; it does not prove phone/headset hardware behavior. `test:browser:shaders`
checks real compiler diagnostics, rollback and panel undo on WebGPU. Native preview
coverage is in `test:browser:gl` and `test:browser:gl:compat`.

This local browser example uses the same protocol without a server:

```ts
import {Engine} from '@margoengine/core';
import {RemoteTarget, RemoteInspector, channelTransport} from '@margoengine/inspector/remote';
const canvas = document.body.appendChild(document.createElement('canvas'));
canvas.width = 480; canvas.height = 320;
const engine = await Engine.create(canvas);
const channel = new MessageChannel();
const targetTransport = channelTransport(channel.port1);
const viewerTransport = channelTransport(channel.port2);
const target = RemoteTarget.attach(engine, {transport: targetTransport, token: 'local-development'});
const viewer = new RemoteInspector({transport: viewerTransport, token: 'local-development', parent: null});
await viewer.connect(); // Scene delivery, with no guessed sleep.
console.log(viewer.objects);
await viewer.set('light:sun', 'intensity', 2);
await viewer.undo();
viewer.dispose(); target.dispose();
targetTransport.close?.(); viewerTransport.close?.();
channel.port1.close(); channel.port2.close();
engine.dispose(); canvas.remove();
```

The relay runs separately in Node, never in a browser bundle:

```ts
import {createRemoteRelay} from '@margoengine/inspector/remote-relay';
const relay = await createRemoteRelay({host: '127.0.0.1'});
console.log(relay.url, relay.token); // Supply both privately to the two development pages.
await relay.close(); // On development server shutdown.
```

## Plugin and pass view

`margoengine/inspector/frame` records one frame. Its report lists every attached plugin in attach order with the
frame graph passes it registered and the time its `onPreUpdate` took in that frame, and every frame graph pass with
its owner, order and CPU and GPU cost. The panel shows both.

```ts
import {FrameDebugger} from 'margoengine/inspector/frame';
import type {EngineKernel} from 'margoengine/core';
async function pluginCosts(engine: EngineKernel) {
  const debug = FrameDebugger.attach(engine, {parent: null});   // null: no panel
  const report = await debug.capture({render: true});
  for (const p of report.plugins) console.log(p.scene, p.order, p.name, p.passes, p.preUpdateMilliseconds);
  for (const pass of report.graph) console.log(pass.owner, pass.order, pass.name, pass.cpuMilliseconds, pass.gpuMilliseconds);
  debug.dispose();
  return report.plugins;
}
```

`preUpdateMilliseconds` is null for a plugin with no `onPreUpdate` and for a frozen one (its hook cannot be wrapped);
a plugin of a scene the frame did not draw shows 0. The hooks are wrapped only for the captured frame. Plugins and
scenes added during the frame show from the next capture. Frame capture needs WebGPU.
