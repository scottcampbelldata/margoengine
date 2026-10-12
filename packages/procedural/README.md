# @margoengine/procedural

Seeded 3D simplex, gradient Perlin and exact nearest-feature Worley noise, plus CPU Marching Cubes geometry.

```ts
import {Noise, marchingCubes} from '@margoengine/procedural';
const noise = new Noise(123);
const geometry = marchingCubes((x,y,z) => x*x+y*y+z*z-0.5, {resolution: [32,32,32]});
```

Simplex uses simplex-noise; surface extraction uses isosurface's established Marching Cubes implementation. Negative density is inside; gradient normals and triangle winding face outward. Empty surfaces return null. Resolution is 3..128 on each axis, with a bounded output geometry. Worley searches a sufficient five-cell neighborhood per axis for F1. Sampling/extraction are CPU work, not frame-time GPU voxel meshing. Classic Marching Cubes retains its ambiguous-cell topology limitations.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/procedural

