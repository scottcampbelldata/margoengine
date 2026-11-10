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

Not included: creating or deleting entities, reparenting, shader editing and a GPU memory view (WebGPU does not report
resource sizes). Other packages' lights, materials, shadows and effects are edited in the package panel below.

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

## Remote inspection

`margoengine/inspector/remote` inspects a scene running on a phone or headset from a desktop browser. The page on the
device attaches a `RemoteTarget`, the desktop page creates a `RemoteInspector`, and the two talk over any string
channel: `channelTransport` wraps a MessagePort, BroadcastChannel or WebSocket the app already has, and
`relayTransport` goes through the development relay that `margoengine/inspector/remote-relay` starts in Node
(`createRemoteRelay({host: '0.0.0.0'})` prints a LAN url and a token). The desktop panel lists the device's lights,
materials, shadows, post effects and meshes with their values, edits them (each edit is checked on the device, with
undo), shows the frame rate and takes a screenshot of the device's canvas. The target runs only that fixed list of
operations and, when given a token, refuses requests without it. Development builds only.

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
