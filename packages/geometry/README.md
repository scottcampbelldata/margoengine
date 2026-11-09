# @margoengine/geometry

Import `margoengine/geometry` from the `margoengine` package, or `@margoengine/geometry` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

`wireframePositions(data, offsetY = 0)` expands distinct triangle edges into a
contiguous line-position stream with an optional vertical lift for terrain debug views.

`pbrVertexStream(data, occlusion?)` packs the 80-byte PBR vertex layout used by
`ScatterInstances`, retaining normals, tangents and both UV slots. RGB defaults to
white tint; alpha stores baked ambient occlusion, independently of albedo and
opacity. Tangents must be present; occlusion callbacks must return finite 0..1.
`footprintRadius(data)` measures the maximum local XZ distance from the origin.

Pure-CPU, tree-shakable geometry for Margo Engine: primitives, curves, shapes, extrusion, triangulation and mesh utilities.

Build from source with `npm run build` in `packages/geometry`.

```ts
import {Engine, PbrMaterial} from 'margoengine/core';
import {CatmullRomCurve3, Path, Shape, computeTangents, extrudeGeometry, sphereGeometry, toGeometry, tubeGeometry} from 'margoengine/geometry';
const engine = await Engine.create(document.querySelector('canvas')!);

// Radius, width segments, height segments.
const sphere = computeTangents(sphereGeometry(1, 48, 24));
engine.createMesh().setGeometry(toGeometry(sphere)).setMaterial(new PbrMaterial({color: '#f97316'}));

// A rounded plate with a hole and a beveled edge.
const plate = new Shape([[-2, -1], [2, -1], [2, 1], [-2, 1]]);
const hole = new Path(); hole.absarc(0, 0, 0.5, 0, Math.PI * 2, true);
plate.holes.push(hole);
const solid = extrudeGeometry(plate, {depth: 0.4, bevelThickness: 0.1, bevelSize: 0.05, bevelSegments: 3});

// A tube along a centripetal Catmull-Rom spline.
const path = new CatmullRomCurve3([[0, 0, 0], [1, 2, 0], [3, 1, 1], [4, 4, 2]]);
const tube = tubeGeometry(path, 128, 0.1, 12);
```

Every function returns a plain `GeometryData` (`positions`, `normals`, `uvs`, `indices`, optional `tangents` and `groups`) made of typed arrays. `toGeometry(data)` hands positions, normals and indices to core's `Geometry`; core has no UV or tangent slots, so those stay on `GeometryData` for packages that use them.

## What it includes

| Functions |
| --- |
| `boxGeometry`, `planeGeometry`, `circleGeometry`, `ringGeometry` |
| `cylinderGeometry`, `coneGeometry`, `sphereGeometry`, `capsuleGeometry` |
| `torusGeometry`, `torusKnotGeometry`, `latheGeometry`, `tubeGeometry` |
| `polyhedronGeometry`, `tetrahedronGeometry`, `octahedronGeometry`, `icosahedronGeometry`, `dodecahedronGeometry` |
| `shapeGeometry`, `extrudeGeometry` |
| `LineCurve`, `LineCurve3`, `QuadraticBezierCurve`, `QuadraticBezierCurve3`, `CubicBezierCurve`, `CubicBezierCurve3`, `EllipseCurve`, `ArcCurve`, `SplineCurve`, `CatmullRomCurve3`, `CurvePath`, `Path`, `Shape`; points are `[x, y]` or `[x, y, z]` arrays |
| `shapeArea`, `isClockWise`, `triangulateShape`, `triangulate` |
| `mergeGeometries`, `mergeVertices`, `computeTangents`, `creasedNormals` (plus smoothing groups) |
| `computeVertexNormals`, `toNonIndexed`, `applyMatrix4`, `center`, `computeBoundingBox`, `computeBoundingSphere`: pure functions returning new data |
| `edgesGeometry`, `wireframe` (line index pairs) |
| `loopSubdivide` |
| `roundedBoxGeometry`, `convexGeometry`, `parametricGeometry`, `decalGeometry` from `@margoengine/geometry/extras` |
| `NurbsCurve`, `NurbsSurface`, `nurbsSurfaceGeometry`, `nurbsCircle`, `nurbsRevolve` from `@margoengine/geometry/nurbs` |
| `MeshSurfaceSampler` from `@margoengine/geometry/sample` |
| `CurveFlow`, `flowGeometry` from `@margoengine/geometry/flow` |
| `delaunayTriangulate`, `triangulateConstrained` from `@margoengine/geometry/delaunay` |
| `sweepGeometry`, `loftGeometry` from `@margoengine/geometry/sweep` |
| `tessellateGeometry`, `tessellateWithParents` from `@margoengine/geometry/tessellate` |
| `GeometryGenerator`, `GpuGeometry`, `GpuPath`, `gridIndices` from `@margoengine/geometry/gpu` |
| `polygonUnion`, `polygonDifference`, `polygonIntersection`, `polygonXor`, `polygonOffset`, `polygonStroke`, `polygonArea`, `polygonShapes` from `@margoengine/geometry/polygon` |
| `optimizeMesh`, `optimizeVertexCache`, `optimizeOverdraw`, `optimizeVertexFetch`, `vertexFetchRemap`, `analyzeVertexCache` from `@margoengine/geometry/optimize` |

## Smaller entries

The root exports everything except the optional entries below it (extras, nurbs, sample, optimize, flow, delaunay, polygon, sweep, tessellate, gpu), which load only when imported. Code that needs one part imports it alone: `@margoengine/geometry/shapes` (curves, paths,
shapes), `@margoengine/geometry/triangulate` (`triangulate`, `triangulateShape`), `@margoengine/geometry/extrude`
(`extrudeGeometry`, `shapeGeometry`), `@margoengine/geometry/primitives` (the solids and
polyhedra) and `@margoengine/geometry/utils` (`geometryData`, `toGeometry`, merging, normals, tangents, edges and
the other helpers). They are the same functions as the root's.

## Extras

`@margoengine/geometry/extras` holds four more generators, in their own entry so the main one keeps its size. Each
returns the same `GeometryData` with unit normals and UVs.

```ts
import {convexGeometry, decalGeometry, parametricGeometry, roundedBoxGeometry} from 'margoengine/geometry/extras';

// Width, height, depth, facets per rounded edge, radius. Six groups like boxGeometry; radius 0 is the plain box.
const button = roundedBoxGeometry(2, 1, 0.4, 4, 0.15);

// The convex hull of any points ([x, y, z] arrays or flat numbers): only the corners become vertices.
const rock = convexGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, 0.2, 0.2]]);

// Any surface (u, v) in [0, 1]: normals come from the surface, UVs are (u, v).
const wave = parametricGeometry((u, v) => [u * 4 - 2, Math.sin(u * 6) * 0.2, v * 4 - 2], 64, 64);

// A decal: the part of `wall` (geometry plus its world matrix) inside a 0.5 x 0.5 x 0.2 box at `hit`, projected along
// the box's -z. The result is in world space; draw it with an identity transform and the decal texture.
const wallGeometry = roundedBoxGeometry(4, 3, 0.2, 1, 0), wallMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const sticker = decalGeometry(wallGeometry, wallMatrix, [0, 1, 0.1], [0, 0, 0, 1], [0.5, 0.5, 0.2]);
```

- `roundedBoxGeometry(width, height, depth, segments = 2, radius = 0.1)`: every edge and corner is rounded; the radius
  is clamped to half the smallest side, and half of every side gives a sphere. Each rounded edge is split between the
  two faces that meet there and both compute their shared vertices from the same numbers, so there are no cracks. An
  odd `segments` gets one extra facet so a vertex sits on the 45-degree seam.
- `convexGeometry(points)`: quickhull (Barber, Dobkin and Huhdanpaa 1996) with a tolerance scaled to the coordinates.
  Duplicates and points inside or on a face or edge are dropped; coplanar triangles merge into one flat face with one
  normal. UVs project each face onto the bounding-box side it faces. Fewer than four points, or points that do not
  span a volume, throw `RangeError`.
- `parametricGeometry(fn, slices = 8, stacks = 8)`: `fn(u, v)` returns `[x, y, z]` or writes its third argument.
  Normals are `dP/du x dP/dv` by central differences, so a surface whose parameters turn counter-clockwise seen from
  outside faces out; at poles the normal is taken a small step inside the parameter square. Seams are not welded.
- `decalGeometry(target, matrix, position, orientation, size, {offset, backfaces})`: `orientation` is a quaternion
  or Euler XYZ radians. Triangles facing the projector are clipped to the box's six planes (Sutherland-Hodgman) and
  fanned back, keeping the target's winding (also under a mirroring matrix). UVs are `x / size.x + 0.5` and
  `y / size.y + 0.5`, so 0 to 1 across the box. Vertices lift `offset` along their normal (default 1/1000 of the
  smaller side) to avoid depth fighting; `backfaces: true` keeps triangles facing away from the projector.

## NURBS

`@margoengine/geometry/nurbs` holds rational B-spline curves and surfaces with knots and weights, for exact circles and smooth industrial shapes.

```ts
import {tubeGeometry} from 'margoengine/geometry';
import {NurbsCurve, NurbsSurface, nurbsCircle, nurbsRevolve, nurbsSurfaceGeometry} from 'margoengine/geometry/nurbs';

// A cubic curve. Weights pull it towards a point; knots default to clamped and uniform.
const curve = new NurbsCurve({
  degree: 3,
  points: [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 1]],
  weights: [1, 2, 1, 1],
});
const pipe = tubeGeometry(curve, 64, 0.1, 12); // It is a Curve, so everything that takes a Curve takes it.
const outline = curve.tessellate(0.001); // Points within 0.001 of the curve.

// Exact shapes: every point of this circle is at radius 2 to rounding, and the sphere's normals are radial.
const ring = nurbsCircle(2);
const sphere = nurbsSurfaceGeometry(nurbsRevolve(nurbsCircle(1, -Math.PI / 2, Math.PI / 2)), 32, 48);

// Any control net: points[i][j] with i along u, j along v.
const patch = new NurbsSurface({
  degreeU: 2,
  degreeV: 2,
  points: [
    [[0, 0, 0], [0, 0, 1], [0, 0, 2]],
    [[1, 1, 0], [1, 2, 1], [1, 1, 2]],
    [[2, 0, 0], [2, 0, 1], [2, 0, 2]],
  ],
});
const mesh = nurbsSurfaceGeometry(patch, 24, 24);
```

- `new NurbsCurve({points, degree, knots, weights})`: 2D or 3D. `degree` defaults to 3, or the most the point count
  allows; `knots` to clamped and uniform on [0, 1]; `weights` to 1. Unclamped knots work: the curve runs from
  `knots[degree]` to `knots[points.length]`. As a `Curve`, `t` in [0, 1] maps linearly to that range, and
  `getPointAt`, `getLength` and `computeFrenetFrames` use its arc-length table.
- `curve.evaluate(u)` and `curve.derivatives(u, order = 1, left = false)` take the knot parameter. Derivatives of any
  order are exact for the rational curve; `left` picks the left-hand ones at a repeated knot.
- `curve.tessellate(tolerance = 1e-3)`: points within `tolerance` of the curve, in its units. Every distinct knot is
  kept, so corners stay exact, and each span is halved at most 12 times.
- `new NurbsSurface({points, degreeU, degreeV, knotsU, knotsV, weights})`: `getPoint(u, v)` and `getNormal(u, v)` take
  [0, 1]; `evaluate(u, v)` and `derivatives(u, v)` take knot parameters.
- `nurbsSurfaceGeometry(surface, slices = 32, stacks = 32)`: the even grid plus a line at every inner knot. Positions
  and normals are evaluated, not differenced, and the normal is `dS/du x dS/dv`, matching the winding. UVs are (u, v)
  in [0, 1]. A knot repeated `degree` times gets a doubled line with one-sided normals, so creases stay sharp.
  Triangles that collapse at a pole are left out.
- `nurbsCircle(radius = 1, startAngle = 0, endAngle = 2 pi)`: rational quadratic spans of at most 90 degrees in the
  z = 0 plane; an end below the start runs clockwise.
- `nurbsRevolve(profile, angle = 2 pi)`: turns a profile around +y, from +x towards +z. `u` runs along the profile and
  `v` around the axis. A profile rising along +y on the +x side faces out.

Curves and surfaces are fixed once built; to change one, build a new one. Invalid degrees, knots, weights or
coordinates throw `RangeError` or `TypeError` naming the fix.

## Surface sampling

`@margoengine/geometry/sample` picks random points on any mesh, for scattering grass, fur, debris and particles.

```ts
import {sphereGeometry} from 'margoengine/geometry';
import {MeshSurfaceSampler} from 'margoengine/geometry/sample';

const rock = sphereGeometry(1, 32, 16);

// Even over the surface. Flat arrays, ready for an instance buffer.
const sampler = new MeshSurfaceSampler(rock);
const {positions, normals, uvs} = sampler.samplePoints(10_000);

// Or by density: 5 points per square unit.
const dense = sampler.samplePoints(Math.round(sampler.area * 5));

// A painted map: one weight per vertex, here more points towards +y.
const weights = Array.from({length: rock.positions.length / 3}, (_, v) => Math.max(0, rock.positions[v * 3 + 1]));
const moss = new MeshSurfaceSampler(rock, {weights, seed: 7});

// One at a time; pass the last sample back to skip the allocation.
let point = moss.sample();
point = moss.sample(point);
console.log(point.position, point.normal, point.uv, point.color, point.triangle, point.barycentric);
```

- `new MeshSurfaceSampler(data, {weights, colors, random, seed = 1})`: `normals` and `uvs` may be empty. `colors` holds 3
  or 4 values per vertex, because `GeometryData` has no colour slot; without it samples are white.
- Without `weights` density is even per area. With them, density follows the weight linearly across each triangle, so
  one big quad with a painted gradient still gives a gradient, not one flat level per triangle.
- The same mesh and seed give the same points. Pass `random` (a function returning [0, 1)) to use your own generator.
- Normals are the interpolated vertex normals, renormalized; the face normal where those are missing or cancel out.
- A sample costs one binary search over the triangles; building the sampler reads the mesh once. It keeps a reference
  to `data`, so changing the arrays afterwards changes what samples read but not the triangle weights.

## Mesh optimisation

`@margoengine/geometry/optimize` is the step engines run at import, and it runs in `margo-convert` by default and in `loadGLTF` with `optimize: true`: the same triangles and vertices, in an order the GPU
reads faster. An opaque mesh draws the same picture.

```ts
import {mergeVertices, sphereGeometry} from 'margoengine/geometry';
import {analyzeVertexCache, optimizeMesh, optimizeVertexCache} from 'margoengine/geometry/optimize';

const mesh = mergeVertices(sphereGeometry(1, 64, 48));

// All three steps, group by group.
const fast = optimizeMesh(mesh);
console.log(analyzeVertexCache(mesh.indices).acmr, analyzeVertexCache(fast.indices).acmr);

// A transparent mesh whose triangle order matters to you: keep the cache step, skip the overdraw sort.
const glass = optimizeMesh(mesh, {overdraw: false});

// Or one step on a bare index list.
const indices = optimizeVertexCache(mesh.indices, mesh.positions.length / 3);
```

- `optimizeVertexCache(indices, vertexCount?)`: Forsyth's linear-speed greedy order. Triangles keep their corners and
  winding; only their order changes.
- `optimizeOverdraw(indices, positions, {threshold = 1.05, cacheSize = 16})`: Sander, Nehab and Barczak's method. Run it
  after the cache step. It cuts the list into clusters and draws the ones facing furthest out of the mesh first, so the
  depth test can skip what they hide. `threshold` caps how much worse the cache miss ratio may get.
- `optimizeVertexFetch(data)`: rewrites the vertex arrays in order of first use and drops unused vertices. Attributes
  outside `GeometryData` (skin weights, say) follow with `vertexFetchRemap(indices, vertexCount?)`, which gives each old
  vertex its new index, or `0xffffffff` if unused.
- `optimizeMesh(data, {overdraw = true, threshold, cacheSize})`: the three in order. Each stretch between group boundaries
  is handled alone, so groups keep exactly their triangles. A mesh with one vertex per corner (extrusions, polyhedra) has
  nothing to reuse, so run `mergeVertices` first.
- `analyzeVertexCache(indices, vertexCount?, cacheSize = 16)`: `{misses, acmr, atvr}` on a first-in first-out cache.
  `acmr` is misses per triangle (3 is the worst), `atvr` misses per vertex used (1 is the best).

## Extrusion UVs

By default extrusions use raw shape coordinates as UVs. Pass `uvGenerator` to change that: `worldUVs(tile)` keeps a texture
at one real-world scale, including round bevels and along paths, and your own function gets every triangle corner.

```ts
import {extrudeGeometry, Shape, worldUVs} from 'margoengine/geometry';

const wall = new Shape([[0, 0], [4, 0], [4, 3], [0, 3]]);

// One texture repeat every 2 world units on caps, walls and bevels.
const brick = extrudeGeometry(wall, {depth: 0.5, uvGenerator: worldUVs(2)});

// Your own mapping: caps fill 0 to 1 over the shape, walls wrap once round the ring.
const custom = extrudeGeometry(wall, {
  depth: 0.5,
  bevelEnabled: false,
  uvGenerator: ({surface, shape, u, distance}) =>
    surface === 'cap' ? [shape[0] / 4, shape[1] / 3] : [u / 14, distance / 0.5],
});
```

Each corner has `surface` (`'cap'` or `'wall'`), `position`, `shape` (the point in the shape's plane, bevel widening
included), the default `u` and `v`, and `distance`: the true length walked from the first layer, so a bevel's curve counts
in full. Default UVs do not change when the option is absent. On walls `u` comes from the outline before the bevel widens
it.

## Tangents that split at seams

`computeTangents(data)` keeps the vertices it is given, which matches MikkTSpace on meshes already split at UV seams and
mirror lines. A mesh that shares vertices across a mirror line needs two frames there, so pass `split: true`. Normal maps
baked against MikkTSpace, as Blender and Substance bake them, then shade without seams.

```ts
import {sphereGeometry} from 'margoengine/geometry';
import {computeTangents, splitTangents} from 'margoengine/geometry/utils';

const mesh = sphereGeometry(1, 32, 16);

// May add vertices: the indices and vertex count can change.
const mapped = computeTangents(mesh, {split: true});

// splitTangents also says where each vertex came from, so your own attributes can follow.
const {data, source} = splitTangents(mesh);
const colors = new Float32Array(source.length * 3); // Copy from your colors at source[v].
```

Corners at one vertex share a frame only when they sit in the same fan of connected triangles with the same UV
orientation, which is the grouping MikkTSpace defines. Triangles keep their order and winding, and the first frame at a
vertex keeps its index. `w` follows UVs with v up; UVs stored v down, as in glTF files, give the opposite `w`.

## Mesh housekeeping

`@margoengine/geometry/utils` also bakes poses into plain positions, tidies draws, and packs buffers.

```ts
import {boxGeometry} from 'margoengine/geometry';
import {
  bakeMorphTargets,
  bakeSkin,
  deinterleaveAttributes,
  estimateMemory,
  interleaveAttributes,
  mergeGroups,
  triangleFanToTriangles,
  triangleStripToTriangles,
} from 'margoengine/geometry/utils';

const mesh = boxGeometry();
const count = mesh.positions.length / 3;

// One morph pose, for picking or export. Targets are differences from the base, as in glTF.
const smile = {positions: new Float32Array(count * 3)};
const posed = bakeMorphTargets(mesh, [smile], [0.75]);

// One skinned pose. matrices: joint world matrix times inverse bind matrix, 16 values per joint.
const joints = new Uint8Array(count * 4);
const weights = new Float32Array(count * 4).fill(0.25);
const matrices = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1];
const baked = bakeSkin(mesh, {joints, weights, matrices});

// One draw per material, then one vertex buffer.
const tidy = mergeGroups(mesh);
const {buffer, stride, offsets} = interleaveAttributes([
  {array: mesh.positions, size: 3},
  {array: mesh.normals, size: 3},
  {array: mesh.uvs, size: 2},
]);
const [positions, normals, uvs] = deinterleaveAttributes(buffer, [3, 3, 2]);

console.log(estimateMemory(mesh).total, 'bytes');

// Strip and fan index lists from older formats. A number means a non-indexed draw of that many vertices.
const fromStrip = triangleStripToTriangles([0, 1, 2, 3]);
const fromFan = triangleFanToTriangles(6);
```

- `bakeMorphTargets` and `bakeSkin` return a new mesh, with normals and tangents unit length again. Skin normals use the
  inverse transpose of the blended matrix, and stay facing out through a mirroring pose.
- `bakeSkin` normalizes weights; a vertex with no weight stays where it is.
- `mergeGroups` keeps the order materials first appear in, and triangles in no group stay at the end.
- Strip conversion keeps one winding, drops the repeats used to stitch strips, and treats `0xffffffff` as a restart.

## Delaunay triangulation

`@margoengine/geometry/delaunay` triangulates point sets and polygons so that triangles are as well shaped as the points
allow. It keeps every point it is given, and exact arithmetic decides every test, so grids, points on one circle and
near-collinear runs are safe.

```ts
import {extrudeGeometry, Shape} from 'margoengine/geometry';
import {delaunayTriangulate, triangulateConstrained} from 'margoengine/geometry/delaunay';

// Terrain from scattered samples, keeping a ridge line as an edge.
const samples: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [4, 5], [6, 5]];
const terrain = delaunayTriangulate(samples, {edges: [[4, 5]]});

// A polygon with a hole, plus inner points and edges to hold.
const outline: [number, number][] = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]];
const hole: [number, number][] = [[4, 4], [6, 4], [6, 6], [4, 6]];
const fill = triangulateConstrained(outline, [hole], {points: [[2, 2], [8, 8]]});
// fill.indices address outline, then hole, then points.

// Extruded caps that keep every outline point, so they meet the walls with no T-junctions.
const solid = extrudeGeometry(new Shape(outline), {depth: 1, triangulate: triangulateConstrained});
```

- `delaunayTriangulate(points, {edges})` covers the convex hull and returns counter-clockwise triangles as a
  `Uint32Array`. A repeated point becomes its first copy, and points all on one line give no triangles.
- `triangulateConstrained(contour, holes, {points, edges})` has the same result shape as `triangulateShape`, plus `points`.
  Rings fill by the even-odd rule in any winding. A hole may touch the outline at a point or along a side.
- A constraint through a point on its line passes through that point. Edges that cross are refused: split them where they
  meet.
- Neither adds points. The smallest angle is the best those points allow, never worse than `triangulateShape` on the same
  points. Many outlines tie: the default triangulator already gives good shapes, so the main gain is keeping every point.

## Polygon booleans and offsets

`@margoengine/geometry/polygon` combines 2D shapes and grows or shrinks them, for floor plans, text outlines, road edges
and bevels before extrusion.

```ts
import {Shape, extrudeGeometry} from 'margoengine/geometry';
import {polygonArea, polygonDifference, polygonOffset, polygonShapes, polygonStroke, polygonUnion} from 'margoengine/geometry/polygon';

const room: [number, number][] = [[0, 0], [6, 0], [6, 4], [0, 4]];
const annexe: [number, number][] = [[5, 1], [9, 1], [9, 3], [5, 3]];
const column: [number, number][] = [[2, 1.5], [2.5, 1.5], [2.5, 2], [2, 2]];

// A floor plan: two rooms, less a column. Each result is {contour, holes}.
const floor = polygonDifference(polygonUnion(room, annexe), column);
console.log(polygonArea(floor)); // 29.75

// Walls 0.2 thick inside the plan, as a solid.
const walls = polygonDifference(floor, polygonOffset(floor, -0.2));
const solid = extrudeGeometry(polygonShapes(walls), {depth: 3, bevelEnabled: false});

// A path around the building with round corners, and a road from a centre line.
const path = polygonOffset(floor, 1, {join: 'round'});
const road = polygonStroke([[0, -5], [10, -5], [14, 0]], 3, {join: 'round', cap: 'round'});

// Inputs can be rings, {contour, holes}, Shapes or lists of them.
const disc = new Shape();
disc.absarc(0, 0, 2, 0, Math.PI * 2, false);
const notched = polygonDifference(disc, [[0, -0.5], [3, -0.5], [3, 0.5], [0, 0.5]], {curveSegments: 32});
```

- `polygonUnion(a, b?, options)`, `polygonDifference(a, b, options)`, `polygonIntersection(a, b, options)` and
  `polygonXor(a, b, options)` return `Polygon[]`, largest first. Outlines run counter-clockwise and holes clockwise, no
  two edges cross, regions that meet only at a point are separate polygons, and points on a straight run are dropped.
  Vertices that did not move come back bit for bit. `polygonUnion(a)` alone cleans one input.
- Options: `fillRule` and `curveSegments` (points per curve of a `Shape`, default 12). The default fill rule
  `'positive'` turns outlines and holes the right way first, so ring direction does not matter, and a hole cuts only
  its own outline. `'nonzero'` and `'evenodd'` keep each ring's direction, for outlines that cross themselves.
- `polygonOffset(input, distance, options)`: positive grows, negative shrinks. `join` is `'miter'` (default),
  `'round'` or `'bevel'`. `miterLimit` (default 4) is the longest miter as a multiple of the distance, as in SVG, and
  longer ones become bevels. `arcTolerance` (default 1/500 of the distance) is the largest gap between a round join and
  its chords. Corners only need a join on the side that opens up, so an outset keeps inner corners sharp and an inset
  keeps outer corners sharp. Thin parts vanish, narrow gaps close and holes move the opposite way.
- `polygonStroke(points, width, options)`: a band around a line of points, which may cross itself. It takes `join`,
  `miterLimit` and `arcTolerance`, plus `cap` (`'butt'` by default, `'round'`, `'square'`) and `closed`.
- `polygonArea(polygons)` is the filled area. `polygonShapes(polygons)` gives `Shape`s for `extrudeGeometry` and
  `shapeGeometry`; `triangulateConstrained(contour, holes)` takes a polygon's rings as they are.
- All points go onto one grid of about 2^26 steps across the input, so results are exact on that grid at any scale, and
  edges closer than one step (1.5e-8 of the width) count as touching. Parts thinner than two steps are dropped.

## Sweep and loft

`@margoengine/geometry/sweep` builds handrails, bottles, ducts and organic shapes. A sweep takes one profile along a path,
with scale and twist that change along it. A loft skins a surface over several different profiles.
For `closed:true`, endpoint tangent samples wrap across the path seam, including custom `Curve` subclasses using the default finite-difference tangent. The final row uses the initial centre and the corrected initial frame; matching endpoint scale/twist gives identical positions and joined normals, with a separate UV row. `periodic-sweep.test.js` checks this on a nonplanar custom loop with and without an authored up direction, including up parallel to the seam tangent.

```ts
import {CatmullRomCurve3, Path, Shape} from 'margoengine/geometry';
import {loftGeometry, sweepGeometry} from 'margoengine/geometry/sweep';

const circle = (radius: number, corners = 32): [number, number][] =>
  Array.from({length: corners}, (_, i): [number, number] => {
    const angle = (i / corners) * Math.PI * 2;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
const square = (half: number): [number, number][] => [[-half, -half], [half, -half], [half, half], [-half, half]];
const path = new CatmullRomCurve3([[0, 0, 0], [2, 1, 0], [4, 1, 2], [6, 2, 2]]);

// A handrail that stays level as it climbs. Corners sharper than 40 degrees get hard edges.
const rail = sweepGeometry(square(0.04), path, {steps: 96, up: [0, 1, 0]});

// A horn: wider towards the end, with half a turn along the way.
const horn = sweepGeometry(square(0.2), path, {scale: (t) => 1 + 2 * t * t, twist: Math.PI});

// A bottle: the surface runs smoothly through every section.
const bottle = loftGeometry([
  {profile: circle(0.4), position: [0, 0, 0]},
  {profile: circle(0.42), position: [0, 0, 1]},
  {profile: circle(0.15), position: [0, 0, 1.5]},
  {profile: circle(0.14), position: [0, 0, 2]},
]);

// A duct that goes from square to round, with a bend.
const duct = loftGeometry([
  {profile: square(1), position: [0, 0, 0]},
  {profile: circle(0.8), position: [0, 2, 4], normal: [0, 1, 1]},
], {smooth: false, steps: 12});

// A hollow one: each section is a Shape with a hole, and holes pair up by their order.
const ring = (radius: number, wall: number) => {
  const shape = new Shape(circle(radius));
  shape.holes.push(new Path(circle(radius - wall)));
  return shape;
};
const pipe = loftGeometry([
  {profile: ring(1, 0.1), position: [0, 0, 0]},
  {profile: ring(0.6, 0.1), position: [0, 0, 3]},
]);
```

- `sweepGeometry(profile, path, options)`: `profile` is a ring of `[x, y]` points, a `Shape` with holes, or a `Path`, and
  `path` is any curve. The profile's +x and +y follow the path's parallel-transport frames, so it does not spin by
  itself. Options: `steps` (64 rows), `scale` and `twist` (a value, or a function of `t` from 0 to 1 by length; a plain
  `twist` is the total in radians), `up` (keeps the profile's +y leaning that way), `closed` (the path is a loop, with no
  caps; scale and twist should match at both ends), `closedProfile` (default true; false makes an open ribbon).
- `loftGeometry(sections, options)`: a section is a profile, which goes at `[0, 0, i]` for section `i`, a placement
  `{profile, position, normal, scale}`, or a ring of `[x, y, z]` points used as it is. Points are matched by their share
  of the way round each ring, from the starting points that twist least, and every corner of every section stays.
  Options: `smooth` (default true, a Catmull-Rom curve through the sections; false is straight lines), `steps` (rows
  between sections, 8 when smooth or else 1), `closed` (join the last section to the first), `segments` (even points
  around every section instead) and `align` (default true; false keeps each ring's own first point).
- Both take `caps` (default true), `creaseAngle` (40 degrees) and `curveSegments` (12, for `Shape` and `Path` profiles).
  Rings may run either way: walls always face out. Normals are smooth across the first row and column and hard only at
  sharper corners. Caps are group 0 and walls group 1, as in `extrudeGeometry`, and UVs run round the profile in u and
  along the length in v. A scale of 0 ends in a point with no cap.

## Tessellating by edge length

`@margoengine/geometry/tessellate` splits triangles until no edge is longer than a limit, so vertex displacement, morphing
and curved deformations have enough vertices to work with.

```ts
import {boxGeometry} from 'margoengine/geometry';
import {tessellateGeometry, tessellateWithParents} from 'margoengine/geometry/tessellate';

// A box with 12 triangles becomes one fine enough to bend, with the same shape.
const fine = tessellateGeometry(boxGeometry(2, 2, 2), 0.1);

// Bulge it into a sphere: no cracks open, even where faces have their own vertices.
for (let i = 0; i < fine.positions.length; i += 3) {
  const length = Math.hypot(fine.positions[i], fine.positions[i + 1], fine.positions[i + 2]);
  for (let k = 0; k < 3; k++) fine.positions[i + k] /= length;
}

// Attributes of your own follow through the parents of each added vertex.
const box = boxGeometry(1, 1, 1);
const heat = new Float32Array(box.positions.length / 3).fill(1);
const {data, parents} = tessellateWithParents(box, 0.25);
const all = new Float32Array(data.positions.length / 3);
all.set(heat);
for (let v = heat.length; v < all.length; v++) {
  const at = (v - heat.length) * 2;
  all[v] = (all[parents[at]] + all[parents[at + 1]]) / 2;
}
```

- `tessellateGeometry(data, maxEdge, {maxTriangles})` always splits the longest edge at its middle (Rivara 1984), which
  keeps angles bounded: no sliver gets thinner as it splits. An edge is split exactly when it is over the limit, so
  triangles that share an edge agree without looking at each other, and meshes stay closed across UV seams and hard
  edges, where vertices are duplicated.
- Normals and tangents are interpolated and made unit length again, UVs are interpolated and groups follow their
  triangles. The surface does not change: new vertices lie on existing edges, so smooth shapes stay faceted until you
  move the vertices.
- `maxTriangles` (default 5,000,000) throws before a tiny limit runs out of memory.
- `tessellateWithParents` also returns `parents`: two entries per added vertex, the vertices it is halfway between, always
  earlier ones. Use it for morph targets and attributes of your own.

## Geometry built on the GPU

`@margoengine/geometry/gpu` writes positions and normals straight into the vertex buffer the engine draws from, in a
compute pass before the scene, for geometry that changes every frame: ropes, cables, animated ribbons and rippling
sheets. No vertices are uploaded; each item sends 64 bytes of settings a frame. WebGPU only.

```ts
import {Engine, PbrMaterial} from 'margoengine';
import {GeometryGenerator} from 'margoengine/geometry/gpu';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 2, 8], target: [0, 0, 0]}});
const generator = GeometryGenerator.attach(engine);
const material = new PbrMaterial({color: '#d08030'});

// A rippling sheet: the height is a WGSL function of u, v and time, and normals follow by themselves.
const sheet = generator.grid({
  width: 6,
  depth: 6,
  columns: 128,
  rows: 128,
  bounds: 5,
  code: `fn height(u: f32, v: f32, time: f32, p: vec4f) -> f32 { return 0.2 * sin(u * 12.0 + time * 3.0); }`,
});
engine.createMesh().setGeometry(sheet.geometry).setMaterial(material);

// A rope through 16 points. Points can come from the CPU like this, or from your own compute pass through rope.points.
const rope = generator.tube({points: 16, radius: 0.05, bounds: 10});
engine.createMesh().setGeometry(rope.geometry).setMaterial(material);
engine.onFrame(() => {
  rope.setPoints(Array.from({length: 16}, (_, i) => [i / 3 - 2.5, 1 + Math.sin(i / 2 + rope.time) / 2, 0]));
});
```

- `surface({code})` takes `fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f`; `grid`, `sphere`, `torus` and
  `cylinder` (an open side wall, or a cone with one radius 0) are the same thing with the function written for you.
  Normals are `dP/du x dP/dv` by differences, carried on from inside at the first and last rows so poles come out right.
- `tube` and `ribbon` follow a Catmull-Rom curve through their control points, which are `vec4f`: `xyz`, and `w`
  multiplying the radius or width. Frames do not twist on their own (double reflection, Wang et al. 2008), and `closed`
  spreads what is left of the turn over the loop so the ends meet. `up` sets where the frames start.
- `rope.points` is the GPU buffer of control points. Bind it in a compute pass of your own, such as a rope simulation, and
  nothing passes through the CPU. After a lost device the points are those of the last `setPoints`.
- `params` is four numbers the shader reads; for the built-in shapes they are the sizes. Change them at any time. `time`
  advances with the engine and can be set. `active = false` holds the last result.
- Only geometry on a mesh in the frame is generated, once a frame, whichever view draws it first.
- `bounds` is where the geometry can reach, for culling. The default of radius 1,000,000 is never culled.
- The CPU copy of the geometry stays zero, so CPU raycasts and exports do not see the shape. `await item.read({signal})`
  copies the vertices back; it waits for the GPU, so use it for a pick or an export, not every frame.
- `GeometryGenerator.attach` throws `unsupported` on the WebGL2 backend.

## Bending along a curve

`@margoengine/geometry/flow` deforms a mesh to follow a curve, or places rigid copies along it: trains on tracks, text
along a path, pipes and snakes.

```ts
import {boxGeometry, CatmullRomCurve3, creasedNormals, toNonIndexed} from 'margoengine/geometry';
import {CurveFlow, flowGeometry} from 'margoengine/geometry/flow';

const track = new CatmullRomCurve3([[0, 0, 0], [10, 2, 5], [20, 0, 0], [30, 1, -5]]);

// A snake: a long box with plenty of segments, stretched over the whole curve.
const body = boxGeometry(1, 0.4, 0.4, 128, 2, 2);
const snake = flowGeometry(body, track, {fit: true});

// Build a CurveFlow to reuse the frames. lockUp keeps a train level on hills.
const flow = new CurveFlow(track, {lockUp: true});
const wagon = flow.deform(boxGeometry(0.8, 1, 3, 2, 2, 32), {axis: 'z', offset: 12});

// Rigid copies: sleepers every metre as instance matrices, or one moving train car.
const sleepers = flow.matrices(Math.floor(flow.length), {spacing: 1});
const car = flow.matrixAt(12.5, 'z');
const {position, tangent, up, side} = flow.getFrame(12.5);
```

- `new CurveFlow(curve, {closed = false, segments = 256, up = [0, 1, 0], lockUp = false})`: samples frames at equal
  distances. Without `lockUp`, frames turn with the curve by the smallest rotation from a first up leaning towards `up`,
  so a coaster goes through a loop without flipping; with it, every frame holds `up`, and a section running straight up
  keeps the last good frame. `closed` wraps distances and spreads the twist of one lap so the frames meet.
- `flow.deform(data, {axis = 'x', offset = 0, scale = 1, fit = false})`: `axis` runs along the curve, and local +y stays up
  (+z when `axis` is `'y'`). `offset` places local 0 along the curve, `scale` stretches along it, and `fit` maps the
  mesh's extent onto the whole curve. Animate `offset` to slide a mesh along. Past the ends of an open curve the mesh
  carries on straight along the end tangent.
- Normals use the inverse transpose of the bend's Jacobian, so they stay perpendicular to the bent surface even with
  `scale`; tangents use the Jacobian. Only vertices move, so a mesh needs enough segments along `axis`.
- `flow.matrices(count, {axis = 'x', offset = 0, spacing})` gives column-major 4x4 matrices, 16 values each; `spacing`
  defaults to even over the curve. `flow.matrixAt(distance, axis = 'x', target?)` is one matrix, and `target` skips the
  allocation.

## How it works

- **Tested from first principles.** Primitive parameters, defaults, segment clamping, UV conventions and groups are pinned by `tests/primitives.test.js`: closed solids have no boundary edges and face outward, normals are unit length, areas and volumes match the analytic shapes, and recorded counts, areas and volumes hold to 1e-5. Vertex order inside a primitive is not part of the API.
- **Indices everywhere.** Polyhedra and extrusions are built non-indexed and get sequential indices, so every result has the same shape.
- **Curves.** `getPoint(t)`, arc-length `getPointAt(u)`, `getPoints`, `getSpacedPoints`, `getLength`, `getLengths`, `getUtoTmapping`, `getTangent(At)` and `computeFrenetFrames(segments, closed)` (parallel transport, with the closing twist spread evenly). Arc length uses 200 chord samples (`arcLengthDivisions`); call `updateArcLengths()` after editing control points. Catmull-Rom accepts `'uniform'` as an alias of `'catmullrom'`.
- **Polygon booleans.** Every point goes onto an integer grid sized to fit a double's exact products, so no test can round the wrong way. Segments are cut by snap rounding (J. Hobby, 1999): a segment passing through the grid cell of a vertex or crossing bends to its centre, repeated until segments meet only at ends. A plane sweep gives every edge the winding numbers on its two sides, the edges with the result on one side only are walked into rings keeping the result on the left, and rings are cut where they touch themselves. An offset runs the same sweep over the raw offset curve and keeps what it winds around (Chen and McMains, 2005), so short edges and self-overlap need no special cases.
- **Triangulation.** Ear clipping after D. Eberly, "Triangulation by Ear Clipping" (2002): rings that share sides are merged first, each hole is joined to the outer ring at a shared corner or by a bridge to a mutually visible vertex, and the best-shaped ears are cut first with a grid keeping each ear test local (a 20,000-vertex ring takes tens of milliseconds). A one-point hole becomes an interior vertex. Stuck passes (rounding, self-touching or self-intersecting rings) fall back to splitting along a valid diagonal, so every input terminates. Ring orientation in the input does not matter, and output triangles are always counter-clockwise.
- **Utilities.** `computeVertexNormals` weights face normals by corner angle. `computeTangents` follows the MikkTSpace recipe (per-triangle UV derivatives projected onto each vertex normal's plane, angle weighted, Gram-Schmidt, `w` from the bitangent). `applyMatrix4` transforms normals by the inverse-transpose; a mirroring matrix also flips the winding and the tangent sign so solids stay outward. `mergeVertices` uses a spatial hash with neighbor-cell lookup. `loopSubdivide` welds positions to find topology, applies Loop's weights with boundary rules, keeps UV seams and recomputes normals.
- **Pure and SSR safe.** No globals, no GPU, no DOM; every function returns new arrays and leaves its input untouched. `"sideEffects": false` with one module-level export per feature, so bundlers keep only what you import: `boxGeometry` plus `toGeometry` stays under 1.5 kB gzip and under an eighth of the whole package (both enforced by `npm test`).

## Options

The polyhedron primitives accept `smooth` as an optional third argument, and
`polyhedronGeometry(vertices, indices, radius, detail, smooth)` accepts it fifth.
By default, detail 0 uses flat face normals and higher detail uses smooth radial
normals. Pass `true` at every detail to keep procedural rock LOD shading consistent,
for example `icosahedronGeometry(0.65, 0, true)`. This changes only normals; use
the same radius and local origin for every LOD to avoid size changes.

`extrudeGeometry(shapes, options)`:

| Option | Default |
| --- | --- |
| `curveSegments` | 12 points per curve segment |
| `steps` | 1 |
| `depth` | 1, along +z |
| `bevelEnabled` | true; forced off with `extrudePath` |
| `bevelThickness` | 0.2 |
| `bevelSize` | `bevelThickness - 0.1` |
| `bevelOffset` | 0 |
| `bevelSegments` | 3; floored, values below 0 count as 0 |
| `extrudePath` | none; a 3D curve, shape x follows the frame normal and y the binormal |

`mergeVertices(data, options)`: `tolerance` (1e-4 per component), `positionOnly` (false: normals, UVs and tangents must match too), `removeDegenerate` (false). `edgesGeometry(data, thresholdAngle = 1)` takes degrees.

`creasedNormals(positions, options)` returns flat-or-smooth vertex normals (a `Float32Array`, xyz per vertex) for
meshes stored one vertex per triangle corner, like tiles: each corner averages (angle weighted) the faces at the same
position that are within `angle` degrees of its own face (default 180; 0 is flat) and share its smoothing group.
`indices` (optional), `groups` (one id per triangle; only equal ids smooth together) and `tolerance` (1e-4 per
component, for matching positions) are the other options. Zero-area triangles are ignored. It takes plain arrays, so
it works on `GeometryData` and on any `{positions, indices?}` mesh.

```ts
const tiles = toNonIndexed(boxGeometry(1, 1, 1));
const tileGroups = Array.from({length: tiles.positions.length / 9}, (_, triangle) => triangle >> 1); // one id per triangle
tiles.normals = creasedNormals(tiles.positions, {angle: 45, groups: tileGroups});
```

## Limits

- NURBS surfaces are not trimmed: a surface is meshed over its whole knot range, seams of closed surfaces are not
  welded (run `mergeVertices`), and there is no knot insertion, degree elevation or file import. A pole's normal is
  taken 1/10,000 of the parameter range inside the surface.
- `parametricGeometry` does not weld seams or poles and `decalGeometry` does not share vertices between clipped
  triangles; run `mergeVertices` when a caller needs an indexed, welded mesh.
- `latheGeometry` makes every normal unit length, including the last profile normal, which the reference fixture leaves unnormalized. Otherwise output matches the reference fixtures.
- `computeTangents` follows UVs with v up, as the primitives have them. UVs stored v down, as in glTF files, give the opposite `w`; flip v first or negate `w`.
- By default a shape with collinear points on its outline can leave T-junctions between the extruded caps and walls, because `triangulateShape` drops those points. Pass `triangulate: triangulateConstrained` to keep them.
- Polygon results are exact on a grid of 2^26 steps across the input, not in doubles: a vertex at a crossing moves by up to half a step, and features under two steps wide are dropped. A round join is a chain of chords, so a rounded outset is up to `arcTolerance` smaller than the true curve.
- `sweepGeometry` turns frames smoothly, so a path with a sharp corner pinches the profile there: round the corner in the path. A profile wider than the path's bend folds through itself. `loftGeometry` holes are skinned by their order, so every section needs the same number of them and a hole's partner is the one in the same place in the list. Turning a section more than about 90 degrees from its neighbour twists the surface in a way `align` cannot undo.
- `edgesGeometry` and `wireframe` return index pairs, not a line geometry; core has no line primitive.
- Core's `Geometry` accepts up to 1,000,000 vertices, so `toGeometry` throws above that.

## Tests

`npm test` in `packages/geometry` runs Node checks for: vertex and index counts against closed-form formulas for every primitive and segment setting; segment clamping; recorded counts, areas and volumes; box, sphere, cylinder, lathe and polyhedron UV conventions; watertight, consistently wound, outward solids with the right Euler characteristic and analytic volumes for box, sphere, cylinder, cone, capsule, torus, torus knot, all polyhedra at several details, beveled and path extrusions with holes, closed tubes and Loop-subdivided meshes; unit normals that agree with the winding; UV ranges; triangulated area equal to polygon minus holes across reversed, mixed, collinear, duplicate, touching and 420-point noisy inputs; tangent orthogonality and handedness including mirrored UVs; area-preserving merge and weld; analytic curve lengths (line, circle, arc, ellipse, parabola); orthonormal right-handed Frenet frames; core `Geometry` interop; and a Vite bundle check that consumers tree-shake. The extras tests check rounded boxes
(closed, genus 0, bit-identical seams, second-order convergence to the analytic area and volume, the radius-0 box and
the sphere limit), convex hulls (cube lattices with duplicates, edge and face points keep only corners; stacked rings
keep only the end circles; 2,000 sphere points all become vertices with F = 2V - 4; random clouds contain every input
point), parametric spheres and tori (area, volume, Euler characteristic 2 and 0, radial normals) and decals (every
vertex inside the box, UVs 0 to 1 matching the box coordinates, footprint area x * y on planes, turned and mirrored
world matrices). The NURBS tests check circles and arcs at radius to 1e-12 at every parameter, the Bezier special
case, rational derivatives to third order against differences, spheres and tori against their closed forms (radius,
radial normals, closed after welding, area and volume), and creases at repeated knots. The sampler tests check the
share of points per triangle, a chi-squared test over a square, the moments of a linear density on a single quad,
zero-weight triangles, interpolated attributes, seeds and the ends of the random range. The optimiser tests check that
every triangle survives with its winding and group, a hand-counted cache model, miss ratios under 0.8 from shuffled
grids, spheres and knots, and overdraw on nested shells with a software depth buffer. The flow tests check that a
straight line changes nothing, a band and a tube bent round a circle land on the closed forms with the right normals,
normals under stretch, closed frames meeting, level frames with `lockUp`, and instance matrices. The extrusion UV tests
check default UVs staying as they were, every corner being offered once, world scale on bevels and paths, and refused
results. The split tangent tests compare every triangle corner with tangents Blender made: a mirrored sheet in
`tests/fixtures/mikktspace-mirror.json`, which must split exactly its six mirror vertices, and an exported glTF. The
housekeeping tests check baked poses against hand-worked results, stretched and mirrored normals, an identity pose,
group order, buffer round trips and strip winding. The Delaunay tests check empty circles by brute force, Euler's
triangle count, grids, circles, collinear runs, coordinates scaled by 2^500 and 2^-1060 giving the same answer, kept
constraints, holes in any winding or touching the outline, and watertight extrusions. The polygon tests check every
operation on random concave outlines point by point and through area identities, that no two result edges cross,
shared edges, touching corners, gaps from 1e-3 to -1e-7, coordinates scaled by 2^500 and 2^-500, 1,000 overlapping
triangles, fill rules, offsets and strokes point by point against true distances, and extruded results being closed.
The sweep tests check boxes, cylinders, frustums, pyramids and tori against closed forms, radial normals with no seam,
hard edges, twist landing on the right corners, a match with `tubeGeometry`, level rails and holes. The loft tests check
square to circle, sections of different counts and starts, smooth lofts passing through every section, closed rings and
3D rings in either direction. The tessellation tests check that no edge stays over the limit, that area and volume do not
change, closed solids across hard edges and seams, the same points on both sides of a shared edge, displaced meshes
staying closed, interpolated attributes, groups, the smallest angle on a split square, and parents. The GPU geometry
tests check grid topology, sizes, bounds, validation and when work is sent against a stand-in device; `npm run test:gpu`
reads vertices back from a real GPU and checks spheres, tori, cones, sheets and surfaces against closed forms, tubes
against the curve through their points, triangles facing their normals, points written by a compute pass, a vertex
buffer core replaced, closed loops meeting, a drawn picture and a lost device.

Apache-2.0 licensed.
