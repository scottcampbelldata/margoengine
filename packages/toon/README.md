# @margoengine/toon

Install `npm i margoengine` and import `margoengine/toon` (or this package alone: `npm i @margoengine/toon`, imported as `@margoengine/toon`; the two are the same module).

Stepped diffuse ramps reuse creative/ToonShading. A second front-culled pass expands vertex normals into an inverted hull for silhouette outlines.

```ts
import {Toon} from 'margoengine/toon';
const toon = Toon.attach(engine, {bands: 4, rim: 0.15, outline: 0.025});
```

Outline thickness is world units. color is linear RGB in 0..1. The hull replays visible core geometry with the existing reversed-Z depth buffer. Geometry should have coherent smooth normals for a continuous silhouette; hard-normal seams can separate hull corners. This is a core-mesh pipeline, not a glTF-pro/skinned-mesh shader. dispose removes both passes.

For toon shading per material, on materials meshes (plain, instanced, skinned) and loaded glTF-pro models (skinned and morphed too), use `@margoengine/materials`: `new ToonMaterial({gradientMap})` or `{steps: 3}`, and `toonModel(model)` for a loaded model or some of its primitives. Both band the sun, clustered lights and their shadows through the ramp.

```ts
import {ToonMaterial, createMesh, toonModel} from 'margoengine/materials';
createMesh(engine, geometry, new ToonMaterial({color: '#e07040', steps: 3}));
toonModel(character, {steps: 4});
```

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/toon

