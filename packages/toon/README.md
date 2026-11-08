# @margoengine/toon

Import `margoengine/toon` from the `margoengine` package, or `@margoengine/toon` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Stepped diffuse ramps reuse creative/ToonShading. A second front-culled pass expands vertex normals into an inverted hull for silhouette outlines.

```ts
import {Toon} from 'margoengine/toon';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const toon = Toon.attach(engine, {bands: 4, rim: 0.15, outline: 0.025});
```

Outline thickness is world units. color is linear RGB in 0..1. The hull replays visible core geometry with the existing reversed-Z depth buffer. Geometry should have coherent smooth normals for a continuous silhouette; hard-normal seams can separate hull corners. `Toon` is a core-mesh pipeline; outline loaded and animated models with `ModelOutlines` (below). dispose removes both passes.

## Outlines on loaded and skinned models

`@margoengine/toon/models` draws the same inverted hull around loaded glTF-pro models and `@margoengine/materials` meshes: skinned and morphed characters keep their outline in every pose (the hull is drawn from the vertices their deformer wrote this frame), and instanced primitives get one hull per instance.

```ts
import {ModelOutlines} from 'margoengine/toon/models';
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
const engine = await Engine.create(document.querySelector('canvas')!);
const character = await loadGLTF(engine, '/hero.glb');
Animation.attach(character).play(0);
const outlines = ModelOutlines.attach(engine, {outline: 0.02, color: [0.02, 0.01, 0.01]});
outlines.outline = 0.03; // live, as is color
```

Options: `outline`, thickness in world units 0 to 10 (default 0.025, 0 hides it); `color`, linear RGB 0 to 1 (default `[0.015, 0.015, 0.015]`); `models`, the models to outline (default every model on the engine). Hidden nodes and nodes outside a view's layers get no outline; point and line primitives never do. The line follows vertex normals, so hard-edged meshes with split normals show gaps at their creases. WebGPU only; `dispose()` removes the pass. For a screen-space line of fixed pixel width, use `@margoengine/post` `Outline`.

For toon shading per material, on materials meshes (plain, instanced, skinned) and loaded glTF-pro models (skinned and morphed too), use `@margoengine/materials`: `new ToonMaterial({gradientMap})` or `{steps: 3}`, and `toonModel(model)` for a loaded model or some of its primitives. Both band the sun, clustered lights and their shadows through the ramp.

```ts
import {ToonMaterial, createMesh, toonModel} from 'margoengine/materials';
import {Engine} from 'margoengine/core';
import {sphereGeometry} from 'margoengine/geometry';
import {loadGLTF} from 'margoengine/gltf-pro';
const engine = await Engine.create(document.querySelector('canvas')!);
const geometry = sphereGeometry(1, 32, 16), character = await loadGLTF(engine, '/hero.glb');
createMesh(engine, geometry, new ToonMaterial({color: '#e07040', steps: 3}));
toonModel(character, {steps: 4});
```

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/toon

