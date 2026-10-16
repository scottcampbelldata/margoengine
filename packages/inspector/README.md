# @margoengine/inspector

Optional DOM inspector for core entities, including `stage.engine`. The hierarchy
updates as entities are added, renamed, reparented or disposed. Arrow keys select,
expand and collapse tree items. Selected entities expose visibility, local
transforms and their core PBR material's roughness and metallic values. Editing a
shared material changes every mesh using it.

```ts
import {Inspector} from '@margoengine/inspector';
import type {EngineKernel} from '@margoengine/core';
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
Disposing a model removes its overlays. Debug drawing is disabled on WebGL2. The hierarchy and property
editor still work there. Neither core nor the stage facade is modified.

`select(mesh)` selects an entity. `setDebug('wireframe' | 'normals' | 'bounds', true)`
toggles a scene overlay. `dispose()` releases the DOM, timer, GPU resources and
registered passes; engine disposal also performs this cleanup.
