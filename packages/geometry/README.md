# @margoengine/geometry

Pure-CPU, tree-shakable geometry for Margo Engine: Three.js-compatible primitives, curves, shapes, extrusion, triangulation and mesh utilities.

Not yet published to npm. Build from source with `npm run build` in `packages/geometry`.

```ts
import {Engine, PbrMaterial} from '@margoengine/core';
import {CatmullRomCurve3, Path, Shape, computeTangents, extrudeGeometry, sphereGeometry, toGeometry, tubeGeometry} from '@margoengine/geometry';

// Same parameters and segment semantics as THREE.SphereGeometry.
const sphere = computeTangents(sphereGeometry(1, 48, 24));
engine.createMesh().setGeometry(toGeometry(sphere)).setMaterial(new PbrMaterial({color: '#f97316'}));

// A rounded plate with a hole, beveled like THREE.ExtrudeGeometry.
const plate = new Shape([[-2, -1], [2, -1], [2, 1], [-2, 1]]);
const hole = new Path(); hole.absarc(0, 0, 0.5, 0, Math.PI * 2, true);
plate.holes.push(hole);
const solid = extrudeGeometry(plate, {depth: 0.4, bevelThickness: 0.1, bevelSize: 0.05, bevelSegments: 3});

// A tube along a centripetal Catmull-Rom spline.
const path = new CatmullRomCurve3([[0, 0, 0], [1, 2, 0], [3, 1, 1], [4, 4, 2]]);
const tube = tubeGeometry(path, 128, 0.1, 12);
```

Every function returns a plain `GeometryData` (`positions`, `normals`, `uvs`, `indices`, optional `tangents` and `groups`) made of typed arrays. `toGeometry(data)` hands positions, normals and indices to core's `Geometry`; core has no UV or tangent slots, so those stay on `GeometryData` for packages that use them.

## What it replaces

| Three.js | Here |
| --- | --- |
| `BoxGeometry`, `PlaneGeometry`, `CircleGeometry`, `RingGeometry` | `boxGeometry`, `planeGeometry`, `circleGeometry`, `ringGeometry` |
| `CylinderGeometry`, `ConeGeometry`, `SphereGeometry`, `CapsuleGeometry` | `cylinderGeometry`, `coneGeometry`, `sphereGeometry`, `capsuleGeometry` |
| `TorusGeometry`, `TorusKnotGeometry`, `LatheGeometry`, `TubeGeometry` | `torusGeometry`, `torusKnotGeometry`, `latheGeometry`, `tubeGeometry` |
| `PolyhedronGeometry`, `TetrahedronGeometry`, `OctahedronGeometry`, `IcosahedronGeometry`, `DodecahedronGeometry` | `polyhedronGeometry`, `tetrahedronGeometry`, `octahedronGeometry`, `icosahedronGeometry`, `dodecahedronGeometry` |
| `ShapeGeometry`, `ExtrudeGeometry` | `shapeGeometry`, `extrudeGeometry` |
| `LineCurve(3)`, `QuadraticBezierCurve(3)`, `CubicBezierCurve(3)`, `EllipseCurve`, `ArcCurve`, `SplineCurve`, `CatmullRomCurve3`, `CurvePath`, `Path`, `Shape` | same names; points are `[x, y]` or `[x, y, z]` arrays |
| `ShapeUtils.area`, `isClockWise`, `triangulateShape`, `Earcut.triangulate` | `shapeArea`, `isClockWise`, `triangulateShape`, `triangulate` |
| `BufferGeometryUtils.mergeGeometries`, `mergeVertices`, `computeMikkTSpaceTangents` | `mergeGeometries`, `mergeVertices`, `computeTangents` |
| `computeVertexNormals`, `toNonIndexed`, `applyMatrix4`, `center`, `computeBoundingBox`, `computeBoundingSphere` | same names, pure functions returning new data |
| `EdgesGeometry`, `WireframeGeometry` | `edgesGeometry`, `wireframe` (line index pairs) |
| `LoopSubdivision` (three-subdivide) | `loopSubdivide` |

## How it works

- **Three.js parity.** Primitive parameters, defaults, clamping, vertex order, UV layout and groups follow Three.js. The test suite compares 20 primitives, Catmull-Rom (centripetal, chordal, uniform, closed), ellipse and path sampling and Frenet frames against a fixture generated from Three.js r180, vertex for vertex, to 1e-5.
- **Indices everywhere.** Three.js leaves polyhedra and extrusions non-indexed; here they get sequential indices so the vertex count is still the Three.js one and every result has the same shape.
- **Curves.** `getPoint(t)`, arc-length `getPointAt(u)`, `getPoints`, `getSpacedPoints`, `getLength`, `getLengths`, `getUtoTmapping`, `getTangent(At)` and `computeFrenetFrames(segments, closed)` (parallel transport, with the closing twist spread evenly). Arc length uses 200 chord samples (`arcLengthDivisions`); call `updateArcLengths()` after editing control points. Catmull-Rom accepts `'uniform'` as an alias of `'catmullrom'`.
- **Triangulation.** An earcut-style ear clipper written for this package: holes are bridged into the outer ring, duplicate and collinear points are filtered, and stuck passes fall back to curing local self-intersections and then splitting along a valid diagonal. Ring orientation in the input does not matter, and output triangles are always counter-clockwise.
- **Utilities.** `computeVertexNormals` weights face normals by corner angle. `computeTangents` follows the MikkTSpace recipe (per-triangle UV derivatives projected onto each vertex normal's plane, angle weighted, Gram-Schmidt, `w` from the bitangent). `applyMatrix4` transforms normals by the inverse-transpose; a mirroring matrix also flips the winding and the tangent sign so solids stay outward. `mergeVertices` uses a spatial hash with neighbor-cell lookup. `loopSubdivide` welds positions to find topology, applies Loop's weights with boundary rules, keeps UV seams and recomputes normals.
- **Pure and SSR safe.** No globals, no GPU, no DOM; every function returns new arrays and leaves its input untouched. `"sideEffects": false` with one module-level export per feature, so bundlers keep only what you import: `boxGeometry` plus `toGeometry` is under 1 KiB gzip.

## Options

`extrudeGeometry(shapes, options)`:

| Option | Default |
| --- | --- |
| `curveSegments` | 12 points per curve segment |
| `steps` | 1 |
| `depth` | 1, along +z |
| `bevelEnabled` | true; forced off with `extrudePath`, like Three.js |
| `bevelThickness` | 0.2 |
| `bevelSize` | `bevelThickness - 0.1` |
| `bevelOffset` | 0 |
| `bevelSegments` | 3 |
| `extrudePath` | none; a 3D curve, shape x follows the frame normal and y the binormal |

`mergeVertices(data, options)`: `tolerance` (1e-4 per component), `positionOnly` (false: normals, UVs and tangents must match too), `removeDegenerate` (false). `edgesGeometry(data, thresholdAngle = 1)` takes degrees like Three.js.

## Limits

- Three.js `LatheGeometry` leaves its last profile normal unnormalized; here every normal is unit length. Otherwise output matches Three.js r180.
- `computeTangents` does not split vertices where the tangent frame is discontinuous. It matches MikkTSpace on meshes already split at UV seams and mirror lines (glTF assets and all primitives here), not bit for bit on arbitrary meshes.
- Like Three.js, a shape with collinear points on its outline can leave T-junctions between the extruded caps and walls, because the triangulator drops those points.
- `edgesGeometry` and `wireframe` return index pairs, not a line geometry; core has no line primitive.
- Core's `Geometry` accepts up to 1,000,000 vertices, so `toGeometry` throws above that.
- No custom `UVGenerator` for extrusions; UVs follow Three.js `WorldUVGenerator`.

## Tests

`npm test` in `packages/geometry` runs 47 Node checks: vertex and index counts against the Three.js formulas for every primitive and segment setting; vertex-for-vertex agreement with Three.js r180 (`tests/fixtures/three-reference.json`, regenerated with `scripts/three-fixture.js` from any Three.js install); watertight, consistently wound, outward solids with the right Euler characteristic and analytic volumes for box, sphere, cylinder, cone, capsule, torus, torus knot, all polyhedra at several details, beveled and path extrusions with holes, closed tubes and Loop-subdivided meshes; unit normals that agree with the winding; UV ranges; triangulated area equal to polygon minus holes across reversed, mixed, collinear, duplicate, touching and 420-point noisy inputs; tangent orthogonality and handedness including mirrored UVs; area-preserving merge and weld; analytic curve lengths (line, circle, arc, ellipse, parabola); orthonormal right-handed Frenet frames; core `Geometry` interop; and a Vite bundle check that consumers tree-shake.

MIT licensed.
