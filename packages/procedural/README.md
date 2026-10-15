# @margoengine/procedural

`generateCabinMesh(height, position = [0,0])` builds a 6 × 8 m timber cabin,
35° roof, recessed windows/door and terrain-sunk stone/porch supports. `position`
is the world XZ origin used for terrain sampling. It returns `floor`, `siding`,
`roof`, `foundation` and `glass`; geometry remains local to that origin and floor.
Supply your own PBR materials and instance transform. Every terrain sample is
validated, and split architectural normals and UV-derived tangents are preserved.
Plank seams are closed, exterior window/door casings sit flush with the siding,
corner trim stands clear and overlapping roof courses have separate depth planes,
avoiding pinholes, fragmented thin edges and z-fighting. Solid gables meet the
siding faces and overlap the roof underside, closing the joint from elevated and
oblique views at both ends. Hidden
plank caps are omitted; trim closes the wall skin. Enterable cabin interiors would
need dedicated wall returns.
Porch post heights and the pitched crossbeam derive from the canopy underside,
keeping the supports below the roof while their bases follow terrain.

`createIslandHeight(seed = 731)` returns the coastal island preset's world-height
sampler. `generateGrassMesh(blades = 3)` returns crossed, tapered grass ribbons;
use 3/2/1 blades for scatter LODs with a double-sided material. Lower LODs remove
blades from the same ordered set, preserving the positions, normals, UVs and
tangents of surviving blades. Both are shared implementations used by the sandbox.

`createHumanoid(engine, [bodyMaterial, trimMaterial, visorMaterial])` creates a
jointed primitive rig and returns `root`, `focus`, `joints`, `knees` and `parts`.
Register `parts` with your shadow module. `poseHumanoid(rig, position, heading,
phase, speed)` writes a walk pose into the existing transforms in place.
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

Surface extraction is the package's own marching tetrahedra (since 5l.v; it replaced the `isosurface` dependency): each grid cube is split into six tetrahedra around its main diagonal, so neighbouring cubes cut shared faces the same way and the indexed mesh is closed wherever the surface stays inside the grid. It makes more, smaller triangles than classic Marching Cubes and none of its ambiguous-case holes. Negative density is inside; gradient normals and triangle winding face outward. Empty surfaces return null. Resolution is 3..128 on each axis, with a bounded output geometry. Worley searches a sufficient five-cell neighborhood per axis for F1. Sampling/extraction are CPU work, not frame-time GPU voxel meshing.

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

## Noise (`@margoengine/procedural/noise`, 2.1 kB min+gzip)

```ts
import {Noise, fbm, ridged, domainWarp} from '@margoengine/procedural/noise';
const noise = new Noise(42);
const hills = fbm((x, y) => noise.simplex2(x, y), {octaves: 6});           // about [-1, 1]
const peaks = ridged((x, y, z = 0) => noise.simplex(x, y, z), {octaves: 5}); // [0, 1], sharp crests
const swirl = domainWarp(hills, {strength: 0.8, dimensions: 2});
const clouds = (x: number, y: number, z: number, t: number) => noise.simplex4(x, y, z, t); // 3D animated along w
```

`Noise` has seeded `simplex2`, `simplex` (3D) and `simplex4`, plus `perlin` and `worley` (3D). The package has no
third-party runtime dependencies. Simplex is its own, written from Perlin (2001) and Gustavson's "Simplex noise
demystified": one kernel `(0.5 - |d|^2)^4 (g . d)` per simplex corner, radius^2 0.5 in every dimension, so the field is
continuous across simplex faces (no seams); values stay inside (-1, 1) (`SIMPLEX_SCALE`).

**Breaking change (5l.v):** `Noise.simplex` used to come from simplex-noise 4.0.3, whose 3D kernel (0.6) leaves small
jumps on simplex faces. The same seed now gives a different (seamless) field; `perlin` and `worley` are unchanged. A world
that must reproduce old simplex output pins `@margoengine/procedural` from before 5l.v. Diagnostic speed against the old
dependency: `examples/package-benchmarks/proofs/procedural-deps.proof.js`.

`fbm` divides by the total amplitude (the range stays the field's), `ridged` sums `(1 - |n|)^2`,
`domainWarp` offsets each axis by `strength * warp(p + o)` (o = `WARP_OFFSETS`). The same names in
`@margoengine/shader/noise` are WGSL twins of `simplex2`, `simplex`, `perlin` and the three combinators; the same seed gives
the same field on the GPU within f32 rounding. Coordinates are limited to |v| <= 1e7.

## L-systems (`@margoengine/procedural/lsystem`, 2.2 kB min+gzip)

```ts
import {createStage} from 'margoengine';
import {expand, interpret, tubes} from '@margoengine/procedural/lsystem';
const stage = await createStage('#app');
const rules = {
  X: [{successor: 'F[+X][-X]&[^X]!FX', weight: 3}, {successor: 'F!X', weight: 1}],    // stochastic: weighted choices
  A: {condition: (l: number) => l > 0.1, successor: (l: number) => `F(${l})[+A(${l * 0.6})]A(${l * 0.8})`}, // parametric, guarded
  F: 'FF',
};
const branches = interpret(expand('X', rules, 5, {seed: 7}), {angle: 24, step: 0.12, radius: 0.08});
stage.mesh(tubes(branches, {radialSegments: 6}));         // or new Line({mode: 'segments', positions: branches.positions})
```

`expand` rewrites in parallel, seeded (rule choice uses one xorshift stream), with a module budget (default 1,000,000).
Successors are module text (`F(1.5)[+X]`) or functions of the matched parameters returning text or modules. Not supported:
context-sensitive rules and parameter expressions inside successor text (use a function). `interpret` is a 3D turtle
(heading +Y, up +Z): `F`/`G` draw, `f`/`g` move, `+ -` yaw, `& ^` pitch, `\ /` roll, `|` turn around, `[ ]` push/pop, `!`
shrinks the radius; a parameter overrides the default length, angle or radius. `tubes` shares the joint ring between a
segment and its same-depth continuation (tilted to the bisector, so stems bend without gaps); side branches start inside
their parent and tips taper to `tipScale`. Tube ends are open; normals are radial (no cone slope).

## Voronoi and fracture (`@margoengine/procedural/voronoi`, 4.8 kB min+gzip)

```ts
import {createStage, sphere} from 'margoengine';
import {voronoi2, voronoi3, fractureMesh} from '@margoengine/procedural/voronoi';
const stage = await createStage('#app');
const points = Array.from({length: 200}, () => Math.random() * 100), points3 = Array.from({length: 300}, () => Math.random() * 10);
const {cells, edges, delaunay} = voronoi2(points, [0, 0, 100, 100]);   // cells[i].polygon, .edgeSites, .neighbors
const rooms = voronoi3(points3, [0, 0, 0, 10, 10, 10]);                 // convex cells: vertices, faces, faceSites, volume
for (const {geometry, center} of fractureMesh(sphere(1, 48), 24, {seed: 3}))   // 24 seeded sites
  stage.mesh(geometry, {position: [center[0] * 0.2, center[1] * 0.2, center[2] * 0.2]}); // pushed apart along their sites
```

`delaunay2`/`delaunay3` are Bowyer-Watson (O(n^2), up to 100,000 points; fine for levels and fracture, not for millions).
A cavity facet the new point does not strictly see drops its cell from the cavity, so co-circular grids and rounding
never produce overlapping triangles; duplicate points are skipped (empty cell). Voronoi cells are the bounds clipped by
the bisectors of the Delaunay neighbours, each edge/face tagged with the site across it (-1 on the bounds).
`fractureMesh` welds by position, then clips the mesh by each cell's planes, closing every cut with a flat cap
(triangulated with holes, so a torus fractures correctly). Chunk volumes add up to the mesh volume (1e-5 relative in the
tests; 240 fractures of a box, icosphere, UV sphere and torus checked closed). Needs a closed mesh; chunks are non-indexed;
caps get flat normals and no UVs; all CPU work, meant for load time or a loading step, not per frame.

## Examples

`examples/lsystem.html` and `examples/voronoi.html` (Vite at the repository root after `npm run build:packages`).

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/procedural

