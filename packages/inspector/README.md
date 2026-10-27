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
`effects`; exposure/bloom controls bind directly to it. Unbound controls are disabled.

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

Not included: creating or deleting entities, reparenting, shader editing, a GPU memory view (WebGPU does not report
resource sizes) and editing materials other than core's PBR values.

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
