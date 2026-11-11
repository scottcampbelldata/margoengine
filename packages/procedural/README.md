# @margoengine/procedural

Import `margoengine/procedural` from the `margoengine` package, or `@margoengine/procedural` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

For minimum-spaced placement, import the optional [`/poisson` entry](#poisson-disk-placement).

`generateCabinMesh(height, position = [0,0])` builds a 6 × 8 m timber cabin,
35° roof, recessed windows/door and terrain-sunk stone/porch supports. `position`
is the world XZ origin used for terrain sampling. It returns `floorElevation` (world Y) and `parts` containing `siding`,
`roof`, `foundation` and `glass` geometry. Every value in `parts` is geometry;
geometry remains local to that origin and floor. The old scalar `floor` field and
flat part fields are replaced by this explicit placement/parts contract.
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

```ts
import { Engine, Geometry } from '@margoengine/core';
import { generateCabinMesh } from '@margoengine/procedural';
const engine = await Engine.create(document.querySelector('canvas')!);
const position = [10, 20] as const;
const cabin = generateCabinMesh(() => 2, position);
for (const data of Object.values(cabin.parts)) {
  engine.createMesh().setGeometry(new Geometry(data.positions, data.normals, data.indices))
    .setPosition([position[0], cabin.floorElevation, position[1]]);
}
engine.dispose();
```

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
For the biome presets there are more plants: `generatePalmMesh()`, `generateBirchMesh()`, `generateAcaciaMesh()` and
`generateSnagMesh()` (a dead standing tree, empty canopy) return `{ trunk, canopy }` like `generateTreeMesh`, and
`generateCactusMesh()`, `generateReedMesh(stems = 9)` (double sided) and `generateTundraShrubMesh()` return one
`GeometryData`; each is rooted at the origin, +Y up, in metres.
Mesh levels for distance: `generateTreeMesh(kind, options)`, `generateShrubMesh`, `generateTundraShrubMesh`,
`generatePalmMesh`, `generateBirchMesh` and `generateAcaciaMesh` take `{ detail: 0 | 1 | 2 }` (default 2, the full
mesh, unchanged byte for byte). Level 1 keeps the shape with coarser lobes (a broadleaf canopy goes from 6,240 to
3,180 triangles); level 0 merges lobes into a few coarse ones for the far rings (400 triangles).
Level 1 keeps each axis of the canopy box within 20 percent of level 2; level 0 is stretched to level 2's box (conifer,
broadleaf, palm, birch, acacia and shrub canopies, within 10 percent on every axis), so far trees keep their size. An
invalid level throws a `RangeError`.

```ts
import {generateTreeMesh} from 'margoengine/procedural';
const rings = ([2, 1, 0] as const).map((detail) => generateTreeMesh('broadleaf', {detail})); // near, middle, far
```

For a cove scene there are two waterfront props, each one `GeometryData` mesh with UVs, tangents and unit normals,
local origin at the water surface (y = 0), +Y up, in metres, deterministic by `seed` (an integer, default 1):

| Call | Options (defaults) | Triangles at `detail` 2 / 1 / 0 |
| --- | --- | --- |
| `generateJettyMesh(options?)` | `length` 4..120 (24), `width` 1..8 (2.2), `height` above the water 0.3..4 (1.1), `ladder` (true), `seed`, `detail` | 2,768 / 1,680 / 508 |
| `generateBoatMesh(options?)` | `length` 1.5..12 (3.6), `seats` 0..4 (3), `oars` (true), `seed`, `detail` | 1,884 / 812 / 372 |

The jetty runs along +X from the shore end at x = 0, with planks, stringers, posts and a ladder at the far end. The
boat is a rowing boat centred on the origin with its bow toward +X. A wrong type throws a `TypeError` and a value out of
range a `RangeError`; the message names the range to pass.

```ts
import {generateJettyMesh, generateBoatMesh} from 'margoengine/procedural';
const jetty = generateJettyMesh({length: 28, seed: 3}); // place it with its shore end on the beach
const boat = generateBoatMesh({seed: 7, oars: false}); // moor it beside the jetty, y = 0 is the waterline
```

`contactAO(y, groundY)` gives bounded ground-contact occlusion, and
`radialAO(x,y,z,center,radius)` shades enclosed canopy volumes. Use their output
with `pbrVertexStream()` from geometry to bake ambient occlusion into vertex alpha
at initialization. `ScatterInstances` applies it to ambient lighting; direct light
and material albedo remain independent.

Seeded 3D simplex, gradient Perlin and exact nearest-feature Worley noise, CPU Marching Cubes geometry, and standalone tree/shrub generators.

```ts
import {Noise, marchingCubes} from 'margoengine/procedural';
const noise = new Noise(123);
const geometry = marchingCubes((x,y,z) => x*x+y*y+z*z-0.5, {resolution: [32,32,32]});
```

Surface extraction is the package's own marching tetrahedra (since 5l.v; it replaced the `isosurface` dependency): each grid cube is split into six tetrahedra around its main diagonal, so neighbouring cubes cut shared faces the same way and the indexed mesh is closed wherever the surface stays inside the grid. It makes more, smaller triangles than classic Marching Cubes and none of its ambiguous-case holes. Negative density is inside; gradient normals and triangle winding face outward. Empty surfaces return null. Resolution is 3..128 on each axis, with a bounded output geometry. Worley searches a sufficient five-cell neighborhood per axis for F1. Sampling/extraction are CPU work, not frame-time GPU voxel meshing.

For a surface that changes every frame (metaballs, sculpting), pass the samples instead of a function: a grid of
`resolution[0] * [1] * [2]` values, x fastest, then y, then z, sampled at the grid points of `bounds`. Writing each
blob only into the samples near it is far cheaper than a function that sums every blob at every grid point.

```ts
import {marchingCubes} from 'margoengine/procedural';
const n = 48, grid = new Float32Array(n * n * n).fill(1); // 1: outside
for (let z = 0, i = 0; z < n; z++)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++, i++) grid[i] = Math.hypot(x - 24, y - 24, z - 24) / 16 - 1; // a sphere
const sphere = marchingCubes(grid, {resolution: [n, n, n]}); // normals from the grid's gradient
```

```ts
import {Engine, Geometry} from '@margoengine/core';
import {generateTreeMesh} from '@margoengine/procedural';
const engine = await Engine.create(document.querySelector('canvas')!);
const tree = generateTreeMesh('broadleaf');
for (const data of [tree.trunk, tree.canopy]) {
  engine.createMesh().setGeometry(new Geometry(data.positions, data.normals, data.indices))
    .setPosition([4, 0, 7]); // Both parts share this rooted transform.
}
engine.dispose();
```

For a complete tree in one call, import the optional `/tree` entry. `createTree`
creates a root plus both child meshes, with brown trunk and green canopy materials.
Options: `position` defaults to [0,0,0], `detail` to 2; `trunkMaterial` and
`canopyMaterial` optionally borrow your PbrMaterials. Move/rotate/scale `root` to
transform both parts. Dispose the returned tree to remove all three nodes.

```ts
import {Engine} from '@margoengine/core';
import {createTree} from '@margoengine/procedural/tree';
const engine = await Engine.create(document.querySelector('canvas')!);
using tree = createTree(engine, 'broadleaf', {position: [4, 0, 7]});
tree.root.position.x = 8;
tree.dispose();
engine.dispose();
```

Trees return separate `trunk` and `canopy` GeometryData plus canopy `center` and
`radius`. Six-tier pines keep their timber supports enclosed inside the foliage;
broadleaf canopies are fifteen lumpy lobes plus 24 opaque, double-sided leaf
clumps per lobe (diamond cards rooted inside the lobe and reaching up to about
0.5 m past it) that break the smooth outline; all their normals radiate from the
collective centroid. The clumps add 1,440 triangles to the 4,800 of the lobes
and need no alpha test, so they keep early depth rejection on phone GPUs.
Shrubs use three compact, asymmetric hemispherical lobes with smooth normals.
All meshes have contiguous Float32 positions, normals, UVs and tangents, and
Uint32 indices. Generation is deterministic, initialization-only CPU work, with
no asset downloads. Pack them into your scene's 80-byte vertex stream, then
upload and release CPU arrays. The gameplay sandbox
uses these exports with `ScatterInstances` and `PlacementLayout` from scatter.

## Noise (`@margoengine/procedural/noise`, 2.1 kB min+gzip)

```ts
import {Noise, fbm, ridged, domainWarp} from 'margoengine/procedural/noise';
const noise = new Noise(42);
const hills = fbm((x, y) => noise.simplex2(x, y), {octaves: 6});           // about [-1, 1]
const peaks = ridged((x, y, z = 0) => noise.simplex(x, y, z), {octaves: 5}); // [0, 1], sharp crests
const swirl = domainWarp(hills, {strength: 0.8, dimensions: 2});
const clouds = (x: number, y: number, z: number, t: number) => noise.simplex4(x, y, z, t); // 3D animated along w
```

`worley(x, y, z)` returns the exact F1 distance over the 5 x 5 x 5 cells around the point (one seeded feature per
cell, Worley 1996). It visits the 27 nearest cells first and hashes a cell only while the gap to its box is below the
nearest distance found so far, so most of the outer shell is never hashed; the value is the same bit for bit as
checking every cell:

```ts
import {Noise} from '@margoengine/procedural/noise';

const cells = new Noise(7);
const d = cells.worley(1.25, -3.5, 0.75);
console.log(d >= 0 && d < Math.sqrt(3)); // true: the point's own cell holds a feature
```

`Noise` has seeded `simplex2`, `simplex` (3D) and `simplex4`, plus `perlin` and `worley` (3D). The package has no
third-party runtime dependencies. Simplex is its own, written from Perlin (2001) and Gustavson's "Simplex noise
demystified": one kernel `(0.5 - |d|^2)^4 (g . d)` per simplex corner, radius^2 0.5 in every dimension, so the field is
continuous across simplex faces (no seams); values stay inside (-1, 1) (`SIMPLEX_SCALE`).

**Breaking change (5l.v):** `Noise.simplex` used to come from simplex-noise 4.0.3, whose 3D kernel (0.6) leaves small
jumps on simplex faces. The same seed now gives a different (seamless) field; `perlin` and `worley` are unchanged. A world
that must reproduce old simplex output pins `@margoengine/procedural` from before 5l.v. Diagnostic speed against the old
dependency: `examples/package-benchmarks/proofs/procedural-deps.proof.js`, a dated record (`fff47af`); re-running it needs
the two old packages installed, otherwise it reports HISTORICAL.

`fbm` divides by the total amplitude (the range stays the field's), `ridged` sums `(1 - |n|)^2`,
`domainWarp` offsets each axis by `strength * warp(p + o)` (o = `WARP_OFFSETS`). The same names in
`@margoengine/shader/noise` are WGSL twins of `simplex2`, `simplex`, `perlin` and the three combinators; the same seed gives
the same field on the GPU within f32 rounding. Coordinates are limited to |v| <= 1e7.

## L-systems (`@margoengine/procedural/lsystem`, 2.2 kB min+gzip)

```ts
import {createStage} from 'margoengine';
import {expand, interpret, tubes} from 'margoengine/procedural/lsystem';
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
import {voronoi2, voronoi3, fractureMesh} from 'margoengine/procedural/voronoi';
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

## Voxel expressions (`@margoengine/procedural/expression`, 4.5 kB min+gzip)

A small, bounded expression language evaluated for every cell of an indexed voxel grid: Margo Voxel Studio's original
expression language (version 1), so its saved expression text gives the same grids. It is not GLSL, WGSL or a
JavaScript runtime: it evaluates only its own syntax tree, with no host access.

```ts
import {runVoxelExpression, VoxelExpressionError} from 'margoengine/procedural/expression';
const signal = AbortSignal.timeout(30_000);
const grid = {voxels: new Uint8Array(64 * 32 * 64)};
const {voxels} = runVoxelExpression({
  source: 'noise(x * f, y * f, z * f) > 0.5 ? tone : color', // one expression per cell
  size: [64, 32, 64], voxels: grid.voxels,                    // voxel-edit layout: x + sx * (z + sz * y), Y up
  parameters: {f: 0.2, tone: 24}, seed: 7, iterations: 1,
}, signal);                                                  // checked every 1,024 cells
```

- **Values.** Numbers (`12`, `1.5`, `.5`, `1e3`); variables `x y z` (the cell), `sx sy sz` (grid size), `color` (the
  cell's palette index), `frame`, `iteration`, `seed`, `pi`, `e`, `true` (1), `false` (0) and up to 32 named
  parameters (finite, within ±1e9). `//` comments run to the end of the line.
- **Operators**, loosest first: `a ? b : c`, `||`, `&&`, `== !=`, `< <= > >=`, `+ -`, `* / %`, `**` (right to left);
  unary `+ - !` bind tighter than `**` (`-2**2` is 4). `&&`, `||` and `?:` evaluate only the branch they need;
  comparisons and logic give 0 or 1.
- **Functions** (`VOXEL_EXPRESSION_FUNCTIONS` lists arity and cost): `abs floor ceil round sqrt sin cos tan pow`,
  `min max` (2-8 arguments), `clamp(v, a, b)`, `mix(a, b, t)`, `smoothstep(e0, e1, v)`, `length(x, y, z)`, signed
  distances `sphere(x, y, z, r)`, `box(x, y, z, hx, hy, hz)`, `torus(x, y, z, R, r)`; `hash(x, y, z)` and
  `noise(x, y, z)` (seeded by `seed`); `voxel(x, y, z)` reads the current iteration's input and `prev(x, y, z)` the
  `previous` frame (integer cells; outside the grid, or without `previous`, they read 0).
- **Results.** Each cell's value must be an integer palette index 0-255. `iterations` (1-32) run the expression
  again on the previous pass's output; every pass reads an immutable snapshot, and the input arrays are never changed.
- **Exact noise.** `voxelHash(x, y, z, seed)` and `voxelNoise(x, y, z, seed)` are exported with their formulas in the
  TSDoc: a 32-bit integer lattice hash in [0, 1] and smoothstep-blended value noise over it. They are not
  `@margoengine/procedural/noise`'s hash, whose constants differ; that module and its defaults are unchanged.
- **Bounds**, all checked before output is allocated (`VOXEL_EXPRESSION_LIMITS`): 8,192 source characters, 4,096
  tokens, 2,048 syntax nodes, depth 64, 32 parameters, 32 iterations, 1024 per axis and 16,777,216 cells, 64 MiB of
  buffers and 67,108,864 work units (`cells * iterations * workPerCell`; a node costs 1, `noise` 32 more).
- **Errors.** Text that does not parse, names an unknown variable or function, or exceeds a token, node or depth
  bound throws `VoxelExpressionError` (`code` `'syntax'` or `'limit'`, 1-based `line` and `column`, `detail` without
  the location); a non-finite value, an invalid function argument or a bad output throws it with `code: 'evaluation'`
  at the operator. Inputs of the wrong shape throw TypeError, values out of range or over a budget RangeError.
  `compileVoxelExpression` and `validateVoxelExpressionInput` check without evaluating.

Compatibility with Studio (`test/expression.test.js`): its own tests and presets, and a generated corpus of 400
programs whose grids and error locations hash to the digest Studio's interpreter produced. In a differential run,
15,000 random programs gave identical grids or identical errors (line, column and message), and 90,000 random token
sequences parsed identically with one deliberate difference: a JavaScript object-prototype name used as an infix
operator (`x toString 1`) was accepted by Studio's parser and failed only when evaluated, and is now a syntax error.
`sin`, `cos`, `tan`, `pow`, `**` and the distance functions (`Math.hypot`) use the host's `Math`, which JavaScript
engines may round differently in the last bit; every other operation, `hash` and `noise` included, is exact. Closure compilation makes it 1.7 to 3.3 times faster than
Studio's tree walker (96 x 96 x 96 cells: sphere 162 ms, noise 177 ms, recolor 26 ms in Node 26).

## Examples

`examples/lsystem.html` and `examples/voronoi.html` (Vite at the repository root after `npm run build:packages`).

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/procedural

## Poisson disk placement

Optional `@margoengine/procedural/poisson`: 1,290 B min+gzip JavaScript and one lazy Rust/Wasm file,
29,914 B raw / 13,192 B gzip. Importing the entry fetches nothing. The factory loads the shipped artifact;
applications need no Rust toolchain. WebGPU and WebGL2 use the same CPU sampler.

```ts
import {createPoissonSampler} from 'margoengine/procedural/poisson';
using sampler = await createPoissonSampler();
const trees = sampler.rectangle([0, 0, 40, 30], {radius: 2, seed: 7}); // packed XY
const onSlope = sampler.surface(new Float32Array([
  0, 0, 0,  10, 0, 0,  0, 10, 10,
]), {radius: 0.8, seed: 11}); // packed XYZ, on this triangle
console.log(trees.positions.length / 2, onSlope.positions.length / 3);
```

`rectangle` takes `[minX,minY,maxX,maxY]`, with positive extents. `surface` takes `Float32Array` or
`Float64Array` triangle soup, nine numbers per triangle, at most 65,536 triangles. Triangle choices are weighted
by area. Empty or zero-area surfaces return no points. Separation is ambient Euclidean distance, including
across nearby disconnected faces, rather than distance along a surface. Coordinates must be finite and within
+/-1,000,000. Output arrays are fresh float64 coordinates; converting them to float32 can reduce spacing.

`radius` is required, 0.000001..1,000,000. Other defaults: `seed: 1` (uint32, zero shares one's stream),
`maxPoints: 4096` (0..65,536), `attempts: 100000` (0..2,000,000). Zero points or attempts returns empty output.
Bounded dart throwing guarantees separation, not a maximal covering or the point limit. Inspect result
`attempts` (candidates actually considered), `comparisons` (neighbour distance tests) and `dimensions` (2 or 3).
Triangles whose cross products round to zero carry no probability. No spectral or frame-time guarantee is made.

The factory accepts `{signal}` for loading; sampling options accept `signal`, checked before synchronous work.
Use a worker for cancellation in flight. `dispose()` and `Symbol.dispose` are idempotent, preserve returned arrays
and release the instance. Later work throws code `disposed`; invalid input throws code `failed`, with a help link.
No rendering resources are owned; device/context loss leaves sampling usable.

The Rust hash and a float64 all-pairs oracle accept identical output for 3,000 fixed candidate points, using 3,329
versus 3,445,553 distance tests. This proves less rejection work, not a language or wall-clock speedup. Native tests:
`npm run test:poisson-kernel --workspace @margoengine/procedural`. Rebuild the committed artifact with
`npm run build:poisson --workspace @margoengine/procedural` (Rust target `wasm32-unknown-unknown`, simd128 enabled;
no SIMD speed claim). Browser proof: `npm run test:gpu --workspace @margoengine/procedural`, including a production
consumer below a non-root base, lazy Wasm requests and values on WebGPU/WebGL2 after device/context loss.

## Dungeon layouts

The optional `@margoengine/procedural/dungeon` entry makes seeded BSP rooms and corridors with no input assets.
Use `margoengine/procedural/dungeon` through the umbrella package. Each room is inside its own partition;
one centre-to-centre corridor joins the two child layouts at each split. This constructs a connected layout
without retries or a repair pass. Coordinates and dimensions are integer grid cells, with X fastest.

```ts
import { createDungeonGenerator } from '@margoengine/procedural/dungeon';
using generator = await createDungeonGenerator();
const layout = generator.generate({ width: 64, height: 48, seed: 19 });
console.log(layout.rooms.length, layout.corridors.length);
console.log(layout.cells[20 * layout.width + 30]); // 0 wall, 1 walkable
```

| Option | Default | Limits |
| --- | --- | --- |
| width | 64 | Integer 6..1024; at least minRoomSize + 4 |
| height | 48 | Integer 6..1024; at least minRoomSize + 4 |
| seed | 1 | uint32; zero uses seed one's stream |
| minRoomSize | 4 | Integer 2..64, in cells |
| maxRooms | 32 | Integer 1..256; an upper bound, small grids can fit fewer |
| signal | absent | Factory load is abortable; generation checks before synchronous work |

`rooms` hold x/y/width/height, `corridors` hold from/to room indices and an orthogonal bend. Each corridor
is one cell wide. Crossings with rooms or other corridors are allowed. The link graph is a tree; crossings
can introduce loops in the raster. The outer border is always wall. Every floor cell is reachable using
four-neighbour movement. `cells` is an owned Uint8Array; layouts survive later calls and disposal.
`rasterVisits` counts written room/corridor cells including repeated writes, excluding zero initialization.
The independent test oracle checks every cell against every room and corridor segment with identical output.
This is a work-count proof, not a timing or Wasm/SIMD speed claim.

The factory loads one feature-local Rust/Wasm asset lazily; importing downloads no Wasm. WebGPU and WebGL2
use the same CPU generator, which remains usable after device/context loss. `dispose()` and `Symbol.dispose`
release the instance and are idempotent. Bad settings and use after disposal throw coded errors with help links.
Use a worker for interruption of work in flight. Build the checked-in artifact with `npm run build:dungeon`
in this package; `npm run test:dungeon-kernel` runs the native Rust tests. SIMD compilation is enabled;
its benefit has not been measured. Layouts are blockouts, without rendering, doors, stairs, gameplay
furnishing, 3D meshes or navigation clearance guarantees (LIM-628). All proof maps are generated stand-ins.

## Space colonisation trees and roots

The optional `@margoengine/procedural/trees` entry grows a branching skeleton towards attraction points.
Use `margoengine/procedural/trees` through the umbrella package. With no settings it creates a seeded crown
of 512 points inside a sphere of radius 2 metres, centred 3 metres above the root. The crown samples use
normalized cube directions and a uniform radial distance; they are not a uniform volume distribution.
Every influenced node grows one segment along the normalized sum of normalized attraction directions.
Reached points are consumed, while equidistant nodes use the lowest insertion index.

```ts
import { createTreeGenerator } from '@margoengine/procedural/trees';
using generator = await createTreeGenerator();
const tree = generator.generate({ seed: 19 });
console.log(tree.positions.length / 3, tree.parents.length, tree.stopped);
const roots = generator.generate({
  attractionPoints: new Float64Array([0, -2, 0, -1, -3, 0, 1, -3, 0]),
  root: [0, 0, 0],
});
console.log(roots.remainingAttractions);
```

| Option | Default | Limits |
| --- | --- | --- |
| attractionPoints | seeded crown | Float64Array of XYZ triples, at most 8192 points, coordinates finite within +/-1e6; empty gives only the root |
| root | [0, 0, 0] | Three finite coordinates within +/-1e6; generated crown may extend 5 metres beyond a root coordinate |
| attractionCount | 512 | Integer 1..8192; ignored when custom points are present |
| seed | 1 | uint32; zero uses seed one's stream |
| segmentLength | 0.2 | 0.0001..10000 metres |
| influenceRadius | 3 | 0.0001..1e6 metres |
| killRadius | 0.3 | segmentLength/2..influenceRadius |
| maxNodes | 2048 | Integer 1..16384, including the root |
| maxIterations | 128 | Integer 1..512 growth rounds |
| signal | absent | Factory load is abortable; generation checks before synchronous work |

The attraction point count times maxNodes times maxIterations must not exceed 134,217,728. This bounds
nearest-distance work; it is not a generation-time guarantee. A point influences its nearest node within
influenceRadius, including the boundary. Points at or within killRadius are consumed. Direction sums with
length at most 1e-12 do not grow a segment. Symmetrically balanced or unreachable clouds can stop without
consuming all points. `stopped` is `complete`, `stalled`, `maxNodes` or `maxIterations`; `remainingAttractions`
records unreached points. The generator also consumes reached points after its final growth round.

`positions` and `attractionPoints` are owned Float64Arrays. `parents` is an owned Int32Array with -1 for the
root and an earlier node index for every other node, so every node is connected to the same root and the
parent graph has no cycles. `iterations` counts growth rounds. `distanceTests` counts complete squared-distance
tests in nearest-node queries, including final consumption. A spatial grid with conservative cell bounds
avoids testing distant nodes. The fixed seed 19 crown, influenceRadius 1.5, uses 218,405 distance tests versus
821,423 in the exhaustive independent reference, producing identical 674-node positions and parents.
This generated stand-in proves less distance work, without a wall-time, language or SIMD speed claim.

The factory lazily loads its own Rust/Wasm file; importing the entry fetches no asset. The CPU data generator
has the same behaviour on WebGPU and WebGL2 and survives device/context loss. Idempotent `dispose()` and
`Symbol.dispose` release the instance; previously returned data remains valid. Bad inputs and disposed use
throw coded errors with help links. Use a worker for interruption of generation in flight.
`npm run build:trees` rebuilds the committed Wasm; `npm run test:trees-kernel` runs its native tests.
These skeletons do not include bark/foliage meshes, smoothing, branch radii, species calibration or intersection
guarantees. Procedural evidence is stand-in only (LIM-631).

The Poisson, dungeon and tree factories preserve the caller's exact AbortSignal reason. Other loading
failures use code `failed` with a help link and the original error as `cause`; existing HTTP and CSP
faults retain their specific help. This covers file reads, fetch/body errors and malformed Wasm bytes.

## Sharp SDF models

`@margoengine/procedural/sdf` contours a bounded signed-distance expression with
uniform-grid dual contouring. Tangent planes place one vertex per active cell;
their constrained quadratic error minimum retains box corners and sharp CSG edges.
The default model is a box, so no user-supplied field or asset is required.

```ts
import { Geometry } from '@margoengine/core';
import { createSdfModeler } from '@margoengine/procedural/sdf';
using modeler = await createSdfModeler();
const mesh = modeler.mesh({
  type: 'difference',
  a: { type: 'box', halfSize: [0.8, 0.7, 0.6] },
  b: { type: 'sphere', center: [0.5, 0, 0], radius: 0.4 },
}, { resolution: 32 });
const geometry = new Geometry(mesh.positions, mesh.normals, mesh.indices);
console.log(geometry.indices.length / 3);
```

`mesh(shape?, options?)` returns owned Float64 XYZ `positions`, unit outward SDF
gradient `normals` at those vertices, and Uint32 triangle `indices`, in outward
order. Pass them directly to core `Geometry`. For sharp shading, expand indexed
triangles and compute one normal per face. No UVs or material assignments are generated. `edgeSolves` counts unique sign-changing grid
edges; `cellEdgeUses` counts the four cell uses per edge on an enclosed surface.
Sharing Hermite roots removes three of four root solves with identical inputs and
output, without a wall-time or SIMD speed claim.

Shapes are spheres (`radius`, optional `center`, default [0,0,0]), axis-aligned boxes
(`halfSize`, optional `center`, default [0,0,0]), and binary `union`, `intersection`
or `difference` (`a` and `b`, difference subtracts b from a). At most 63 nodes are
accepted. All coordinates must be finite within +/-10000; radii and half sizes are
0.0001..10000. CSG uses min/max, whose zero surfaces are correct but whose field
values need not be exact distances. Arbitrary callbacks, imported sampled fields,
rotated primitives, adaptive octrees and manifold repair are not implemented.

Options: `resolution` is cells per axis, integer 4..64, default 24; `bounds` is two
strictly increasing XYZ corners. When omitted, bounds derive from the analytic
tree: primitive AABBs, union enclosure, intersection overlap and the minuend of
a difference, plus 10% of each axis extent on both sides (at least 0.0001). A
disjoint intersection uses an operand enclosure and produces empty output. Bounds
that cannot fit the supported coordinate/extent limits give linked code `failed`
and ask for explicit bounds. Explicit bounds have
extent 0.0001..10000 per axis and coordinates within +/-10000. A nonpositive sampled
boundary value throws code `failed` and asks for larger bounds. An empty sampled
field returns empty arrays. Features smaller than the grid, multiple crossings of
one edge, tangent surfaces and disconnected components inside one cell may be lost
or become nonmanifold. CSG may produce zero-area triangles where surfaces touch;
there is no topology guarantee for arbitrary expressions. Normals are analytical
primitive gradients selected through CSG, with deterministic axis ties on box edges.
Roots use 40 bisections; rank-deficient QEFs use the Hermite mass point with a 1e-10
absolute eigenvalue cutoff on the unit-normal system and bounded face/edge/corner
minimization. These are approximation rules, not exact CAD operations.

The factory lazily loads one independent Rust/Wasm asset, accepts `signal`, and
has no import-time work. Generation checks `signal` before synchronous work; use a
worker for in-flight interruption. `dispose()` and `Symbol.dispose` are idempotent;
owned results survive disposal. Errors carry codes and help links. CPU output is
identical on WebGPU and WebGL2, including after real device/context loss.
`npm run build:sdf` rebuilds the committed asset; `npm run test:sdf-kernel` runs
native tests. The external Khronos Box proves all eight sharp corners, planar
surface, winding, closed edges and volume; sphere/CSG/extreme controls are generated
stand-ins. No production model, render-quality or timing claim (LIM-632).

## Tileable GPU textures

`@margoengine/procedural/textures` bakes periodic noise, bricks, tiles, wood-like
bands and rust-like patches directly into owned RGBA8 GPU textures. It accepts a
WebGPU device or a Margo engine. On native WebGL2 it compiles a fragment pipeline
on the engine canvas, with all five patterns and the same options. Pass the engine
itself on that route; its `gpu` is null. Each RGBA8 colour channel agrees within
one quantization step on the tested GPU. Mortar exactly on a threshold may vary
with floating-point rasterization. No CPU pixel loop, asset fetch or Wasm is used.
The WebGL2 chunk loads only when that backend is selected.

```ts
import { createTextureBaker } from '@margoengine/procedural/textures';
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('WebGPU adapter required');
const device = await adapter.requestDevice();
{
  using baker = await createTextureBaker(device);
  using baked = await baker.bake({ pattern: 'bricks', width: 128, height: 128 });
  console.log(baked.texture.format, baked.width, baked.height);
}
device.destroy();
await device.lost;
```

| Bake option | Default | Limits |
| --- | --- | --- |
| pattern | bricks | noise, bricks, tiles, wood, rust |
| width, height | 256 each | Integers 16..2048, at most maxTextureDimension2D (WebGPU) or MAX_TEXTURE_SIZE (WebGL2) |
| seed | 1 | Unsigned 32-bit integer, including zero |
| repeat | [4,8] | Integer columns/rows 1..64; bricks require even rows to repeat the alternate offset |
| detail | 0.2 | 0..1; per-texel brick/tile variation, wood phase warp, rust threshold softness; ignored by noise |
| grout | 0.08 | 0..0.45, half mortar width as a cell fraction; bricks/tiles only |
| stagger | 0.5 | 0..1, alternate brick-row horizontal offset as a cell fraction; bricks only |
| color | [0.55,0.2,0.08] | Primary linear RGB, each 0..1 |
| secondary | [0.15,0.12,0.1] | Mortar/secondary linear RGB, each 0..1 |
| offset | [0,0] | UV phase, finite within +/-1024; integer parts discarded |
| signal | absent | Cancels compilation/bake waits; caller's exact reason is preserved |

Native WebGPU outputs have `backend: 'webgpu'` and a `GPUTexture`. Native WebGL2
outputs have `backend: 'webgl2'`, a `WebGLTexture` and its owning `gl` context. They
are native handles for their renderer; neither can be used on another context.
The fragment pass restores GL state before yielding. Recreate the baker after
WebGL2 context loss/restoration. Disposal releases every retained output.

```ts
import {Engine} from '@margoengine/core';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
import {createTextureBaker} from '@margoengine/procedural/textures';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgl2', fallback: webglRenderer});
using baker = await createTextureBaker(engine);
using baked = await baker.bake({pattern: 'bricks', width: 256, height: 256});
console.log(baked.backend, baked.width, baked.height);
baked.dispose(); baker.dispose(); engine.dispose();
```

All presets use the same caller-controlled palette. `noise` is four-octave periodic
value noise with lattice periods 4,8,16,32 and weights 8,4,2,1, quintic interpolation
and an integer seed hash. Brick/tile mortar is a hard threshold without filtering.
Wood is periodic wavy longitudinal bands; rust is thresholded periodic noise. These
are stylized patterns, without wood anatomy, corrosion simulation or PBR maps.
`repeat` controls brick/tile cells and wood bands; noise/rust use fixed octave
periods. Bake enough pixels per cell to avoid aliasing. No mipmaps are generated.
The format is linear `rgba8unorm`, alpha 1, with TEXTURE_BINDING, STORAGE_BINDING and
COPY_SRC. Each channel is rounded to the nearest of the 255 steps in the shader: WebGPU leaves
that rounding to the GPU, and GPUs differ near a half step (an RTX A6000 stored 133 where
a Radeon 680M stored 134). Use a sampler with repeat addressing on both axes. Pixel centres on
opposite edges need not match: the underlying function repeats continuously, and
the adjacent pixel across a repeat boundary is the next sample of that function.

`bake()` resolves after submission completes. Each output is owned and disposable;
baker disposal destroys retained outputs and cancels pending work. Abort, disposal,
allocation failure and device loss clean up incomplete outputs. Create a fresh
baker on a replacement device. The entry does no work on import. Validation and
compile/driver failures use coded errors with help links and retain original causes;
shader errors name their source line. CPU lifecycle controls use stand-ins, while
the actual shader, 44,415 pixel/channel checks, seam-crossing phase shifts, real
abort/loss/disposal and replacement run on WebGPU. Native WebGL2 runs the same
shader oracle and also verifies state restoration, cancellation, disposal and
actual context loss/restoration.
The downloaded Lefebvre/Poulin 2000 figure 1(d) supplies a measured running-bond
offset for a calibrated structural check only. Generated numerical controls remain
stand-ins; no photograph reconstruction, wood/rust realism, material quality,
cross-device byte identity or timing is claimed (LIM-639).

GPU wait promises are observed before checking cancellation, and loss/cancellation
is checked again after completion. An already lost factory and a cancelled queue
cannot leave a later GPU rejection unhandled; the original abort reason still wins.

## Rectangular building shape grammar

The optional `@margoengine/procedural/buildings` entry applies a restricted,
declarative shape grammar: footprint -> floor splits -> four facade components ->
repeated equal bays -> centred window insets -> flat or gable roof. Changing simple
data changes the shell and its floor/bay scopes. It is not a general CGA parser.

```ts
import { createBuildingGenerator } from '@margoengine/procedural/buildings';

using buildings = await createBuildingGenerator();
const mesh = buildings.generate({
  width: 18, depth: 10, floorHeights: [4, 3, 3], bayWidth: 3,
  window: [0.55, 0.6], roof: 'gable', roofHeight: 2,
});
console.log(mesh.positions.length / 3, mesh.indices.length / 3, mesh.bays.length / 8);
```

Metres, Y up. Defaults: width12, depth8, origin[0,0,0] (bottom centre), yaw0,
floorHeights[3,3,3], bayWidth3, window[.55,.6], roof'flat', roofHeight2 (ignored
for flat), no signal. Width/depth .1..1000; bayWidth .1..1000; each side uses
ceil(length/bayWidth) equal bays, 1..256; at most4096 bays overall. Floor heights
are1..64 values of .1..100 with total<=5000; window fractions .05...95; gable rise
.1..100; origin coordinates +/-10000 and yaw +/-2pi. All numbers must be finite.

Positions are owned Float64 XYZ; normals Float32; indices Uint32; materials Uint8
per triangle (0 wall,1 window,2 roof/gables,3 base). Floors pack bottom/height;
bays pack floor,side,start,bottom,width,height,windowWidth,windowHeight. Facade
sides run +X at -Z, +Z at +X, -X at +Z, -Z at -X. Roof ridge runs along local Z.
Wall rings and flush panes partition the shell without overlapping faces. There
are no interior slabs, doors, wall thickness, collision data, UVs, arbitrary
footprints, recursive user productions or context/occlusion queries. Separate
planar faces have separate vertices; boundary T junctions require welding and
subdivision before use as a manifold solid in downstream tooling.

One lazy buildings.wasm; no import-time fetch. Independent of GPU resources and
identical on WebGPU/WebGL2 before and after loss. Synchronous generation checks
signal before work; use a worker for interruption. Dispose is idempotent and owned
outputs survive disposal. Errors are coded with help links. JS 1502 B gzip;
Wasm 31252 B raw / 12794 B gzip. Native and browser area/volume, partition,
ownership and hostile-input tests; real Montreal CityJSON supplies measured
envelope dimensions only. Generated facades and other controls remain stand-ins.
Two shared sine/cosine evaluations equal the per-vertex transform oracle with
fewer trig calls; no timing, SIMD gain or architecture-realism claim (LIM-642).

A downloaded real CMP facade photo and its annotation XML additionally calibrate
four windows in a 2x2 region. Measured floor splits preserve the row heights;
generated bounds agree within1.89 source pixels against the fixed2-pixel bar.
Source hashes, licence (publisher CC BY-SA, no version stated), measurements and
method are in test/fixtures/buildings/facade-reference.json. This limited calibrated
layout test does not recover the whole facade, its ornamentation or material.

## Cellular automata caves and islands

The optional `@margoengine/procedural/caves` entry generates seeded binary 2D or
3D grids. A synchronous Moore rule counts the 8 or 26 neighbours, excluding the
centre: state 0 becomes 1 at `birth` occupied neighbours, state 1 survives at
`survival` occupied neighbours. The defaults retain the previous state on a tie.
Interpret 1 as rock/land and 0 as floor/water. Caves have a fixed rock boundary;
islands have a fixed water boundary, including Z faces in 3D.

```ts
import { createCaveGenerator } from '@margoengine/procedural/caves';

using caves = await createCaveGenerator();
const cave = caves.generate({ width: 64, height: 48, seed: 7 });
const islands = caves.generate({ width: 64, height: 48, mode: 'islands', seed: 9 });
const volume = caves.generate({ width: 32, height: 32, depth: 32, seed: 7 });
console.log(cave.cells.length, islands.cells.length, volume.cells.length);
```

| Option | Default | Bounds and meaning |
| --- | --- | --- |
| width, height | 64, 48 | Integer 3..1024 cells each |
| depth | 1 | 1 for 2D, otherwise integer 3..256; total cells <= 1,048,576 |
| seed | 1 | Unsigned 32-bit, zero has its own stream |
| steps | 5 | Integer 0..64; total cells times steps <= 16,777,216 |
| fill | 0.45 | Probability of state 1, finite 0..1; validated but unused with initial |
| mode | caves | caves or islands; controls the fixed outermost cell layer |
| birth, survival | 5, 4 (2D); 14, 13 (3D) | Integer 0..8 or 0..26, inclusive thresholds |
| initial | absent | Optional owned Uint8Array, exact grid length, binary 0/1; copied and boundary replaced |
| signal | absent | Abort checked before synchronous generation; use a worker to interrupt in flight |

Owned `cells` index X fastest, then Y, then Z: `(z * height + y) * width + x`.
Zero steps returns initialization with the fixed boundary. The LCG advances once
per grid cell, including boundary cells: unsigned `1664525 * state + 1013904223`,
occupied when state / 2^32 < fill. There is no automatic component pruning, route
carving, connectivity, navigability, minimum land/floor area, chunk continuity,
meshing or guarantee that either state survives a selected rule. 3D controls are
stand-ins; no measured geological realism is claimed (LIM-643).

One lazy caves.wasm, no import-time work, no GPU required. Identical values on
actual WebGPU/WebGL2 before and after device/context loss. Dispose is idempotent;
owned maps survive disposal. Loading accepts AbortSignal; errors have codes and
help links. Real public-domain Natural Earth land polygons provide a Madagascar
mask tested against a separate scalar automaton, without claiming geographic
reconstruction. Its original bytes, source, hash and licence are test fixtures.
Separable integer sums reduce stencil input reads against a direct Moore stencil
with identical output; tiny grids select the direct stencil when cheaper. Counts
include intermediate and centre reads, exclude initialization, copies, allocation
and compilation. No elapsed-time, SIMD gain or rival-speed claim is made.

Caves entry: 1421 B min+gzip (ceiling 1680 B); caves.wasm 27405 B raw / 11564 B gzip. Core plus stage 24743 B gzip, strictly below 25000 B.

## Texture baker and WebGL2 tiers

`createTextureBaker` now has a native fragment route on the small `/preview` engine, added on main while the attachment contract was being checked. It stays on that tier without escalation. The full `webgl2-compat` layer reports `backend: 'webgpu'` and runs the compute route. `packages/webgl2-compat/test/package-tiers-browser.mjs` exercises both complete tiers and verifies the real preview route stays on WebGL2. The original no-device refusal was correct for the former GPU-only baker.
