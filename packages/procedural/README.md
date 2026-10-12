# @margoengine/procedural

`generateCabinMesh(height, position = [0,0])` builds a 6 × 8 m timber cabin,
35° roof, recessed windows/door and terrain-sunk stone/porch supports. `position`
is the world XZ origin used for terrain sampling. It returns `floor`, `siding`,
`roof`, `foundation` and `glass`; geometry remains local to that origin and floor.
Supply your own PBR materials and instance transform. Every terrain sample is
validated, and split architectural normals and UV-derived tangents are preserved.
Plank seams are closed, exterior window/door casings sit flush with the siding,
corner trim stands clear and overlapping roof courses have separate depth planes,
avoiding pinholes, fragmented thin edges and z-fighting. Hidden
plank caps are omitted; trim closes the wall skin. Enterable cabin interiors would
need dedicated wall returns.

`createIslandHeight(seed = 731)` returns the coastal island preset's world-height
sampler. `generateGrassMesh(blades = 3)` returns crossed, tapered grass ribbons;
use 3/2/1 blades for scatter LODs with a double-sided material. Lower LODs remove
blades from the same ordered set, preserving the positions, normals, UVs and
tangents of surviving blades. Both are shared implementations used by the sandbox.

`createHumanoid(engine, [bodyMaterial, trimMaterial, visorMaterial])` creates a
jointed primitive rig and returns `root`, `focus`, `joints`, `knees` and `parts`.
Register `parts` with your shadow module. `poseHumanoid(rig, position, heading,
phase, speed)` updates the existing transforms with a walk pose, without allocations.
The sandbox supplies phase/speed from the shared controls module.

`generateRockMesh()` produces deformed fieldstones with smooth, averaged normals
across split vertices while preserving UV seams and tangent frames.
`generateFernMesh()` produces seven curved, tapered ribbon fronds; use a
double-sided material. Both return `GeometryData` and are deterministic.
`contactAO(y, groundY)` gives bounded ground-contact occlusion, and
`radialAO(x,y,z,center,radius)` shades enclosed canopy volumes. Use their output
with `pbrVertexStream()` from geometry to bake ambient occlusion into vertex alpha
at initialization. `ScatterInstances` applies it to ambient lighting; direct light
and material albedo remain independent.

Seeded 3D simplex, gradient Perlin and exact nearest-feature Worley noise, CPU Marching Cubes geometry, and standalone tree/shrub generators.

```ts
import {Noise, marchingCubes} from '@margoengine/procedural';
const noise = new Noise(123);
const geometry = marchingCubes((x,y,z) => x*x+y*y+z*z-0.5, {resolution: [32,32,32]});
```

Simplex uses simplex-noise; surface extraction uses isosurface's established Marching Cubes implementation. Negative density is inside; gradient normals and triangle winding face outward. Empty surfaces return null. Resolution is 3..128 on each axis, with a bounded output geometry. Worley searches a sufficient five-cell neighborhood per axis for F1. Sampling/extraction are CPU work, not frame-time GPU voxel meshing. Classic Marching Cubes retains its ambiguous-cell topology limitations.

```ts
import {generateTreeMesh, generateShrubMesh} from '@margoengine/procedural';
const pine = generateTreeMesh('conifer'); // Also accepts 'broadleaf'.
const bush = generateShrubMesh();
```

Trees return separate `trunk` and `canopy` GeometryData plus canopy `center` and
`radius`. Six-tier pines keep their timber supports enclosed inside the foliage;
broadleaf lobes share smooth normals radiating from their collective centroid.
Shrubs use three compact, asymmetric hemispherical lobes with smooth normals.
All meshes have contiguous Float32 positions, normals, UVs and tangents, and
Uint32 indices. Generation is deterministic, initialization-only CPU work, with
no asset downloads. Pack them into your scene's 80-byte vertex stream, then
upload and release CPU arrays. The gameplay sandbox
uses these exports with `ScatterInstances` and `PlacementLayout` from scatter.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/procedural

