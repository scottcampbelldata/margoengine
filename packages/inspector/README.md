# @margoengine/inspector

Install `npm i margoengine` and import `margoengine/inspector` (or this package alone: `npm i @margoengine/inspector`, imported as `@margoengine/inspector`; the two are the same module).

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
