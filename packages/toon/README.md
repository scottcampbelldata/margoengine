# @margoengine/toon

Stepped diffuse ramps reuse creative/ToonShading. A second front-culled pass expands vertex normals into an inverted hull for silhouette outlines.

```ts
import {Toon} from '@margoengine/toon';
const toon = Toon.attach(engine, {bands: 4, rim: 0.15, outline: 0.025});
```

Outline thickness is world units. color is linear RGB in 0..1. The hull replays visible core geometry with the existing reversed-Z depth buffer. Geometry should have coherent smooth normals for a continuous silhouette; hard-normal seams can separate hull corners. This is a core-mesh pipeline, not a glTF-pro/skinned-mesh shader. dispose removes both passes.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/toon

