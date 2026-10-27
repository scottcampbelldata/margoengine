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

## Smaller entries

The root exports everything. Code that needs one part imports it alone: `@margoengine/geometry/shapes` (curves, paths,
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
const rock = convexGeometry(points);

// Any surface (u, v) in [0, 1]: normals come from the surface, UVs are (u, v).
const wave = parametricGeometry((u, v) => [u * 4 - 2, Math.sin(u * 6) * 0.2, v * 4 - 2], 64, 64);

// A decal: the part of `wall` (geometry plus its world matrix) inside a 0.5 x 0.5 x 0.2 box at `hit`, projected along
// the box's -z. The result is in world space; draw it with an identity transform and the decal texture.
const sticker = decalGeometry(wallGeometry, wallMesh.matrix, hit, [0, 0, 0, 1], [0.5, 0.5, 0.2]);
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

## How it works

- **Tested from first principles.** Primitive parameters, defaults, segment clamping, UV conventions and groups are pinned by `tests/primitives.test.js`: closed solids have no boundary edges and face outward, normals are unit length, areas and volumes match the analytic shapes, and recorded counts, areas and volumes hold to 1e-5. Vertex order inside a primitive is not part of the API.
- **Indices everywhere.** Polyhedra and extrusions are built non-indexed and get sequential indices, so every result has the same shape.
- **Curves.** `getPoint(t)`, arc-length `getPointAt(u)`, `getPoints`, `getSpacedPoints`, `getLength`, `getLengths`, `getUtoTmapping`, `getTangent(At)` and `computeFrenetFrames(segments, closed)` (parallel transport, with the closing twist spread evenly). Arc length uses 200 chord samples (`arcLengthDivisions`); call `updateArcLengths()` after editing control points. Catmull-Rom accepts `'uniform'` as an alias of `'catmullrom'`.
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
tiles.normals = creasedNormals(tiles.positions, {angle: 45, groups: tileGroups}); // tileGroups: one id per triangle
```

## Limits

- `parametricGeometry` does not weld seams or poles and `decalGeometry` does not share vertices between clipped
  triangles; run `mergeVertices` when a caller needs an indexed, welded mesh.
- `latheGeometry` makes every normal unit length, including the last profile normal, which the reference fixture leaves unnormalized. Otherwise output matches the reference fixtures.
- `computeTangents` does not split vertices where the tangent frame is discontinuous. It matches MikkTSpace on meshes already split at UV seams and mirror lines (glTF assets and all primitives here), not bit for bit on arbitrary meshes.
- A shape with collinear points on its outline can leave T-junctions between the extruded caps and walls, because the triangulator drops those points.
- `edgesGeometry` and `wireframe` return index pairs, not a line geometry; core has no line primitive.
- Core's `Geometry` accepts up to 1,000,000 vertices, so `toGeometry` throws above that.
- No custom UV generator for extrusions; UVs are the raw shape coordinates.

## Tests

`npm test` in `packages/geometry` runs Node checks for: vertex and index counts against closed-form formulas for every primitive and segment setting; segment clamping; recorded counts, areas and volumes; box, sphere, cylinder, lathe and polyhedron UV conventions; watertight, consistently wound, outward solids with the right Euler characteristic and analytic volumes for box, sphere, cylinder, cone, capsule, torus, torus knot, all polyhedra at several details, beveled and path extrusions with holes, closed tubes and Loop-subdivided meshes; unit normals that agree with the winding; UV ranges; triangulated area equal to polygon minus holes across reversed, mixed, collinear, duplicate, touching and 420-point noisy inputs; tangent orthogonality and handedness including mirrored UVs; area-preserving merge and weld; analytic curve lengths (line, circle, arc, ellipse, parabola); orthonormal right-handed Frenet frames; core `Geometry` interop; and a Vite bundle check that consumers tree-shake. The extras tests check rounded boxes
(closed, genus 0, bit-identical seams, second-order convergence to the analytic area and volume, the radius-0 box and
the sphere limit), convex hulls (cube lattices with duplicates, edge and face points keep only corners; stacked rings
keep only the end circles; 2,000 sphere points all become vertices with F = 2V - 4; random clouds contain every input
point), parametric spheres and tori (area, volume, Euler characteristic 2 and 0, radial normals) and decals (every
vertex inside the box, UVs 0 to 1 matching the box coordinates, footprint area x * y on planes, turned and mirrored
world matrices).

Apache-2.0 licensed.
