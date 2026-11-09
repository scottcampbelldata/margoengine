# @margoengine/procedural

Import `margoengine/procedural` from the `margoengine` package, or `@margoengine/procedural` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

For minimum-spaced placement, import the optional [`/poisson` entry](#poisson-disk-placement).

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
import {generateTreeMesh, generateShrubMesh} from 'margoengine/procedural';
const pine = generateTreeMesh('conifer'); // Also accepts 'broadleaf'.
const bush = generateShrubMesh();
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
