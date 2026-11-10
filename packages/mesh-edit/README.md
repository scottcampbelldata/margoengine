# @margoengine/mesh-edit

Import `margoengine/mesh-edit` from the `margoengine` package, or `@margoengine/mesh-edit` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional, tree-shakable CPU polygon editing, UV allocation and pixel painting for Margo. Input meshes retain indexed positions, caller face IDs and independent normalized top-left UVs at every polygon corner. Commands return owned geometry and explicit old-to-new component provenance; caller document metadata is excluded.

```ts
import { createPrimitiveMesh, extrudeMeshFace, compilePolygonMesh } from 'margoengine/mesh-edit';
const mesh = createPrimitiveMesh('cube', 'box');
const edit = extrudeMeshFace(mesh, 'box-face-0', 0.25);
const geometry = compilePolygonMesh(edit.mesh);
```

Inset a face (default `amount` 0.24, a centroid fraction from 0.001 to 0.95), then bevel the whole closed mesh (default `amount` 0.12, from 0.001 to 0.45):

```ts
import { createPrimitiveMesh, insetMeshFace, bevelPolygonMesh } from 'margoengine/mesh-edit';
const cube = createPrimitiveMesh('cube', 'box');
const inset = insetMeshFace(cube, 'box-face-0', 0.3);
const beveled = bevelPolygonMesh(inset.mesh, 0.1);
console.log(inset.mesh.faces.length, beveled.mesh.faces.length);
```

Bevel keeps the inset source faces and splits generated strips/caps into convex
planar pieces when their corners are not coplanar. Corner UVs and every generated
piece's source-face mapping survive the split. Strips and caps follow the input
half-edge winding, so further extrude/inset operations remain valid. Closed
inputs must have consistently wound faces and one connected face fan at each
vertex; invalid winding/fans throw TypeError with the arguments help link.

Callers own selection intent, locks, visibility, motion/opacity policy, IDs, undo and texture storage. Margo owns component transform geometry and the UV/paint algorithms below. No engine instance, DOM or GPU is needed. Supply `createId` for deterministic face IDs; otherwise commands call `crypto.randomUUID()` only when creating faces. Empty and duplicate generated IDs reject before exposing output.

The original parity commands retain existing behavior: extrusion acts along the local face normal, inset and whole-mesh bevel use centroid fractions, and `cutMeshFace` bisects one face at opposite-edge midpoints. Cut vertices propagate through neighboring incident edges; each face interpolates its own UVs. Bevel requires closed two-manifold geometry and returns an unchanged owned mesh with a diagnostic for unsupported open/nonmanifold inputs. Supported faces are simple planar convex polygons with 3-64 corners; collinear boundary corners remain valid. Compile produces flat normals and fan triangles, preserving source face and corner-vertex identity. Drawn knife cuts, selected-edge bevels and concave n-gons (split into convex faces) are in the `modeling` entry below; equal-width inset is `insetMeshRegion`.

`meshSelectionVertices(mesh, selection)` resolves explicit object, vertex, canonical edge or face selections. `transformMeshComponents(mesh, selection, worldDelta, {worldMatrix, snapStep})` applies a public affine world delta to those shared vertices once. Unselected positions and all corner UVs remain exact; optional snapping affects only selected vertices in world space. Warped convex polygons become persisted deterministic source triangles, retaining the source face ID on one descendant. Collapsed, crossed, concave or folded projections reject atomically. Mirrored object matrices and half-turn rotations work; reflected edit deltas reject explicitly. Results add exact `edgeMap`, created/removed edges and triangulation diagnostics. Geometry-only shaping never repacks or paints an atlas.

`traceMeshQuadRing(mesh, {faceId, corner})` traverses opposite edges of connected quads with transported edge orientation. `cutMeshQuadRing(mesh, seed, fraction)` accepts `0 < fraction < 1`, splits each geometric edge once, independently interpolates each incident face's UVs and returns the new ring's ordered vertices and edges. Open strips end at geometric boundaries. Nonquad continuation, nonmanifold or inconsistent winding and ambiguous/self-crossing paths reject. This API performs a coherent adjustable ring split; callers own preview, confirm/cancel and selection remapping.

`vertexMap[oldIndex]` lists output descendants, including retained identities where present. `faceMap[oldId]` lists retained and descendant faces. Created vertices are new identities even when they are mapped descendants; removed vertices name discarded input indices, including welded duplicates that still map to a retained output vertex. Bevel replaces all vertex identities and maps each old vertex to its incident face corners. UV seams never weld merely because positions coincide.

Tests import the built public package. Run `npm test --workspace @margoengine/mesh-edit` from the engine repository.

## Modeling: edge bevel, loop slide, dissolve, weld and bridge

Bevel selected edges, cut a loop and slide it, dissolve, merge by distance and bridge two open loops, from the
`margoengine/mesh-edit/modeling` entry (`@margoengine/mesh-edit/modeling`), so apps that only paint or move components
never load it. Edge IDs are `"low:high"` vertex pairs (see `polygonMeshEdges`):

```ts
import { createPrimitiveMesh, cutMeshQuadRing } from 'margoengine/mesh-edit';
import {
  bevelMeshEdges,
  bridgeMeshEdgeLoops,
  dissolveMeshComponents,
  slideMeshEdges,
  weldMeshVertices,
} from 'margoengine/mesh-edit/modeling';

const cube = createPrimitiveMesh('cube', 'box');
// Chamfer one edge 0.1 wide: a strip face, and the two end faces become pentagons.
const beveled = bevelMeshEdges(cube, ['0:1'], 0.1);
// Loop cut halfway round a ring of quads, then slide the new loop a quarter of the way along its rails.
const cut = cutMeshQuadRing(cube, { faceId: 'box-face-0', corner: 0 }, 0.5);
const slid = slideMeshEdges(cut.mesh, cut.ring.edges, 0.25);
// Dissolve the new loop again: its coplanar faces merge back into the cube's six.
const dissolved = dissolveMeshComponents(cut.mesh, { mode: 'edge', edges: cut.ring.edges });
// Merge vertices within 0.0001 (the default distance); corner UVs never weld.
const welded = weldMeshVertices(dissolved.mesh, { distance: 0.0001 });
// Two square sheets one unit apart (the lower one facing down), bridged into a closed box with 2 rows of faces.
const sheet = createPrimitiveMesh('plane', 'sheet');
const sheets = {
  vertices: [...sheet.vertices, ...sheet.vertices.map(([x, y, z]): [number, number, number] => [x, y + 1, z])],
  faces: [
    { id: 'bottom', vertices: [3, 2, 1, 0], uv: [...sheet.faces[0].uv].reverse() },
    { id: 'top', vertices: [4, 5, 6, 7], uv: sheet.faces[0].uv },
  ],
};
const bridged = bridgeMeshEdgeLoops(sheets, ['0:1', '1:2', '2:3', '0:3'], ['4:5', '5:6', '6:7', '4:7'], {
  segments: 2,
});
console.log(beveled.mesh.faces.length, slid.mesh.faces.length, welded.welded, bridged.mesh.faces.length);
```

- `bevelMeshEdges(mesh, edges, width)`: one flat row per edge. Faces beside a beveled edge are cut back `width`
  (local units, measured inside each face) and keep their IDs and interpolated UVs; strips and the corner faces where
  three or more beveled edges meet get default tile UVs. A chain end slides along the neighboring edges. Edges must
  lie between two faces, their vertices must be interior, and a width that reaches past a neighboring edge or folds
  a face throws `RangeError`. Rounded (multi-segment) bevels are not built yet.
- `slideMeshEdges(mesh, edges, factor, {correctUV = true})`: `factor` in (-1, 1) moves every vertex of a loop or chain
  along its rail edge (positive: toward the faces whose winding runs with the chain). Loop vertices need one free rail
  per side, as in quad loops. Corner UVs follow their vertex; a UV extended past the atlas is clamped and reported.
  `cutMeshQuadRing` (above) is the loop cut; its `fraction` places the cut anywhere along the ring.
- `dissolveMeshComponents(mesh, {mode: 'edge' | 'vertex' | 'face', ...})`: merges faces across the selection without
  leaving a hole. Because faces stay planar, only coplanar faces merge; an edge on a fold is kept and reported, so the
  shape never changes. A two-edge vertex is removed from its faces. A region that would enclose a hole or touch
  itself throws `MargoError` code `unsupported`. Concave merges are split into convex pieces (the first keeps the ID).
- `weldMeshVertices(mesh, {distance = 0.0001, vertices})`: merge by distance without chaining (each kept vertex
  absorbs later ones within `distance` of itself). Collapsed faces are removed and named in `diagnostics`; faces made
  nonplanar or concave are split into valid pieces.
- `bridgeMeshEdgeLoops(mesh, first, second, {segments = 1})`: joins two open boundary loops (or chains) with the same
  edge count, pairing closed loops at the rotation with the least squared distance. The band follows the loops'
  winding, so the result stays consistently oriented. Band faces get default tile UVs.

Every command validates first and never changes its input; results carry `vertexMap`, `faceMap`, `edgeMap` and the
created/removed components like the commands above. Allocate islands for new faces with `allocateMeshFaceUV` before
painting them.

## Concave faces, knife and subdivision

Faces stay planar and convex, so imported concave n-gons are split first; a knife cuts along a drawn line seen from
the camera, and Catmull-Clark subdivision keeps UV seams:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import {
  convexPolygonPieces,
  knifeMeshFaces,
  splitMeshConcaveFaces,
  subdivideMesh,
  triangulatePolygon,
} from 'margoengine/mesh-edit/modeling';

// An L-shaped outline: 4 triangles, or 2 convex pieces.
const outline: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 2],
  [1, 0, 2],
  [1, 0, 1],
  [2, 0, 1],
  [2, 0, 0],
];
const triangles = triangulatePolygon(outline);
const pieces = convexPolygonPieces(outline);
// An imported concave face becomes editable convex faces; the first keeps the ID.
const imported = splitMeshConcaveFaces({
  vertices: outline,
  faces: [{ id: 'L', vertices: [0, 1, 2, 3, 4, 5], uv: outline.map(([x, , z]): [number, number] => [x / 2, z / 2]) }],
});
// Knife straight across a cube, looking down -Y: it cuts through, front and back.
const cut = knifeMeshFaces(createPrimitiveMesh('cube', 'box'), [[-1, 1, 0.1], [1, 1, 0.1]], [0, -1, 0]);
// Two levels of Catmull-Clark; UVs are smoothed inside islands and stay exact on seams.
const smooth = subdivideMesh(createPrimitiveMesh('cube', 'box'), { levels: 2 });
console.log(triangles.length, pieces.length, imported.mesh.faces.length, cut.cutEdges.length, smooth.mesh.faces.length);
```

- `triangulatePolygon(points)` ear-clips a simple outline (concave allowed) in its own plane, keeping every corner
  (collinear ones too) and the winding. `convexPolygonPieces(points)` then removes diagonals while both sides stay
  convex (Hertel and Mehlhorn, 1983; at most four times the fewest pieces). Both take up to 4096 corners and throw
  `TypeError` for outlines that cross themselves.
- `splitMeshConcaveFaces(mesh)` accepts faces of 3 to 64 corners that are concave or slightly nonplanar and returns
  a valid mesh (pieces keep corners and UVs; `faceMap` names them). Valid faces are untouched.
- `knifeMeshFaces(mesh, points, direction, {faces, closed = false})`: the polyline swept along `direction` (the view
  direction) cuts every face it fully crosses, front and back ("cut through"); `faces` limits the cut. New vertices go
  where the cut crosses edges and where it bends inside a face; neighbors gain the edge vertices, so there are no
  T-junctions. A cut that stops inside a face adds nothing there. `cutEdges` lists the new edges along the cut.
- `subdivideMesh(mesh, {levels = 1, uv = 'smooth', boundary = 'smooth', signal})`: Catmull-Clark (1978). Open borders
  follow the B-spline border rule with corners kept (`'pinned'` fixes every border vertex). UVs subdivide as their own
  face-varying mesh: smoothed inside each island, linear on seams and island corners (`'linear'` interpolates each
  face). Because faces stay planar, curved quads are split into two triangles; flat areas keep quads. Up to 4 levels
  and 200000 output faces.
## Smooth and relax

Clean a scan or soften a blocky edit without losing size:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { smoothMesh } from 'margoengine/mesh-edit/modeling';

const box = createPrimitiveMesh('cube', 'box');
// Taubin by default: noise goes, the volume stays.
const { mesh } = smoothMesh(box, { iterations: 20 });
// Only some vertices move; the rest steer them.
const part = smoothMesh(box, { vertices: [0, 1], method: 'laplacian', iterations: 3 });
console.log(mesh.faces.length, part.mesh.faces.length);
```

- `smoothMesh(mesh, {method, iterations, factor, passBand, vertices, pinBoundary, signal})` returns a `MeshEditResult`.
- `method`: `'taubin'` (default; Taubin, 1995) follows each step with a negative one, so the shape does not shrink. `'laplacian'` only pulls each vertex toward its neighbors, and the shape shrinks.
- `iterations` is 1 to 10000 (default 10). `factor` is above 0 and at most 1 (default 0.5). `passBand` is between 0 and 1 (default 0.1): details below that frequency survive, so a larger value smooths harder.
- `vertices` limits the moves to a selection. `pinBoundary` (default true) holds open edges still, so a surface keeps its outline.
- Neighbors weigh equally, so a mesh with uneven triangles drifts a little along its surface. Run `remeshMesh` first on very uneven scans. Corner UVs stay, and a face the move warps is split into valid convex pieces (`id~t1`, ...).
## Hole filling

Close open borders in imports and scans, with triangles or a quad grid that follows the surrounding curvature:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { fillMeshHoles, meshBoundaryLoops } from 'margoengine/mesh-edit/modeling';

const box = createPrimitiveMesh('cube', 'box');
const open = { ...box, faces: box.faces.slice(1) };
console.log(meshBoundaryLoops(open).length); // 1
const { mesh, holes } = fillMeshHoles(open, { mode: 'grid' });
console.log(mesh.faces.length, holes[0].faces);
```

- `meshBoundaryLoops(mesh)` lists open borders as vertex loops, wound the way a filling face would be. A border that touches itself at a vertex comes back as separate loops.
- `fillMeshHoles(mesh, {mode, maxEdges, refine, fair, createId, signal})` returns a `MeshEditResult` plus `holes`, each with its border `vertices` and the `faces` added. The faces around a hole do not change.
- `mode: 'triangles'` (default) finds the lowest-cost triangulation of the border (Liepa, 2003), favoring compact triangles that fold little against the faces around them. Holes above 256 edges start from a fan around their center instead, because that search costs edges cubed.
- `mode: 'grid'` lays a quad grid over a hole with an even edge count, by Coons interpolation between four sides whose corners are the border's sharpest turns. Holes with an odd edge count use triangles. A grid quad that ends up warped is stored as two triangles, because faces must be planar.
- `refine` (default true) splits fill triangles until they match the border's edges, flipping toward Delaunay. Border edges never split, so nothing changes outside the hole. `fair` (default true) then moves the added vertices to minimize bending, with the surrounding mesh held still, so the fill continues the curvature around it.
- `maxEdges` leaves larger holes open and says so in `diagnostics`. New faces take UVs from the hole's own plane, scaled to the unit square.


## Booleans

Union, difference and intersection of two closed solids:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { booleanMeshes } from 'margoengine/mesh-edit/modeling';

const box = createPrimitiveMesh('cube', 'box');
const peg = createPrimitiveMesh('cylinder', 'peg');
// A thinner, taller peg, so it passes through the box without touching its sides.
peg.vertices = peg.vertices.map(([x, y, z]): [number, number, number] => [x * 0.6, y * 1.5, z * 0.6]);
// Drill it through the box: one closed solid with a hole (genus 1).
const drilled = booleanMeshes(box, peg, 'difference');
console.log(drilled.mesh.faces.length, drilled.nonManifoldEdges, drilled.faceMap.a['box-face-0']);
```

- `booleanMeshes(a, b, operation, {tolerance, createId, signal})` with `operation` `'union'`, `'difference'` (`a`
  minus `b`) or `'intersection'`. Both inputs must be closed, consistently wound and outward facing (`TypeError`
  otherwise). They may overlap, share coplanar faces, touch along faces or edges, nest or lie apart.
- Output faces keep their source face IDs where free and interpolate UVs; `sources` maps each output face to its
  input face and `faceMap.a` / `faceMap.b` list each input face's pieces. Pieces of one source face that form a convex
  face again are merged back.

### Limits: tolerance, not exact arithmetic

The boolean uses floating point with a tolerance, not exact (rational or adaptive-precision) arithmetic. Faces are
clipped against the other solid's planes with solid BSP trees (Thibault and Naylor, 1987); a point within `tolerance`
of a plane counts as on it (default 1e-9 of the largest input coordinate, at least 1e-12 units). Each split point is
computed from the same end of its edge on both sides, so neighbors agree exactly; then vertices within the tolerance
are welded, T-junctions are closed and slivers with no area are dropped. Before returning, the result is checked to be
closed (every half-edge matched by its reverse); if a configuration finer than the tolerance (nearly but not exactly
coincident faces or vertices) would leave a crack, it throws `MargoError` code `failed` instead of returning a broken
mesh: nudge one input or raise `tolerance`. Exact coplanar contact (shared faces, edges, vertices) is handled.
Shapes that only touch along an edge or at a vertex give a closed result whose touching edges join four faces; their
count is `nonManifoldEdges`. Features thinner than the tolerance are merged away. Work grows with the number of faces
times the BSP depth (typically n log n, n squared at worst); pass `signal` to stop a long run.

### Exact booleans

`booleanMeshes` above fails on geometry finer than its tolerance and asks you to nudge an input. The optional `boolean-exact` entry never does: two boxes one float64 step apart, or a face turned by 1e-15 radians, work as they are.

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { booleanMeshesExact } from 'margoengine/mesh-edit/boolean-exact';

const box = createPrimitiveMesh('cube', 'box');
const other = createPrimitiveMesh('cube', 'other');
// Almost the same box: every face lies 1e-13 from the first box's face.
other.vertices = other.vertices.map(([x, y, z]): [number, number, number] => [x + 1e-13, y + 1e-13, z]);
const result = booleanMeshesExact(box, other, 'union');
console.log(result.mesh.faces.length, result.collapsedFaces, result.nonManifoldEdges);
```

- `booleanMeshesExact(a, b, operation, {createId, signal})` takes the same `operation` values and returns the same `mesh`, `sources`, `faceMap`, `nonManifoldEdges` and `diagnostics` as `booleanMeshes`, plus `collapsedFaces`. There is no `tolerance`.
- Every float64 coordinate is an exact integer in one shared power-of-two scale. Polygons are stored as planes, so a cut adds a plane and never a rounded point (Sugihara and Iri, 1989; Bernstein and Fussell, 2009). Side tests run in float64 with an error bound and use BigInt only when the bound cannot decide. T-junctions are closed exactly, line by line.
- Only at the end are corners rounded to float64. A face of the exact result too thin to be a valid face (about 4e-9 of its length, or a few float64 steps) is folded away, keeping every edge matched by its reverse; `collapsedFaces` counts these. The returned mesh is always closed and passes the mesh-edit checks, so it can feed the next boolean.
- Inputs must be closed and outward facing. Separate shells of one input that overlap are joined first, and `sources` and `faceMap` still name the input's faces. A single surface that crosses itself throws `MargoError` code `failed` when the crossing breaks the result. Faces that are not quite planar count as the triangles an exact ear clip gives them.
- Speed: only what lies in the box where the two bounds overlap goes through the exact trees, so a small cut in a large mesh costs the faces near it. Measured on two spheres of 10,224 triangles each, one operation: 7 to 11 s when they overlap by half, 2 to 3 s with a cutter a fifth the size, under 1 s when they only overlap at the edge. Work in the box grows with its faces squared. Use `booleanMeshes` for large clean inputs and pass `signal` to stop a long run.
## Modifier stack

Mirror, array, solidify, screw and lattice deform that never touch the base mesh. Change the base or any modifier and the stack re-runs from the first stage that is out of date:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { latticePoints, MeshModifierStack } from 'margoengine/mesh-edit/modifiers';

const box = createPrimitiveMesh('cube', 'box');
const stack = new MeshModifierStack(box, [
  { type: 'solidify', thickness: 0.05 },
  { type: 'array', count: 3, offset: [2, 0, 0] },
]);
console.log(stack.evaluate().mesh.faces.length);

// Edit the base: the next evaluate re-runs everything.
stack.base = createPrimitiveMesh('wedge', 'ramp');
// Change one modifier: earlier stages are reused.
stack.update(1, { count: 5 });

// Bend the top of the box with a lattice.
const min: [number, number, number] = [-0.5, -0.5, -0.5];
const max: [number, number, number] = [0.5, 0.5, 0.5];
const points = latticePoints(min, max, [2, 2, 2]).map(([x, y, z]): [number, number, number] =>
  y > 0 ? [x * 2, y, z * 2] : [x, y, z],
);
stack.add({ type: 'lattice', min, max, resolution: [2, 2, 2], points });
const { mesh, faceMap } = stack.evaluate();
console.log(mesh.vertices.length, Object.keys(faceMap).length);
```

- `new MeshModifierStack(base, modifiers)` copies the base. Set `stack.base` to a new mesh after an edit. `add(modifier, index)`, `update(index, changes)`, `remove(index)` and `move(from, to)` change the list; `evaluate()` returns a `MeshEditResult` whose `vertexMap` and `faceMap` lead back to the base; `apply()` bakes the result into the base and empties the list. `applyMeshModifiers(mesh, modifiers)` is the same as a one-off call.
- Face IDs are built from base IDs (`id~m`, `id~a2`, `id~s`), so a re-run names each face the same way and selections survive. Any modifier takes `enabled: false` to switch off without being removed.
- `{type: 'mirror', axis = 'x', origin = 0, merge = 1e-6}`: reflects across the plane, reversing the copy's winding so it faces out. Vertices within `merge` of the plane move onto it and join both halves; faces wholly on it are dropped, so an open half closes. `merge: 0` keeps the halves apart.
- `{type: 'array', count = 2, offset, relativeOffset, merge = 0}`: `count` copies, the original included, each `offset` plus `relativeOffset` times the bounding box size further on. With neither given the step is one box width along X. `merge` welds touching neighbors with `weldMeshVertices`.
- `{type: 'solidify', thickness = 0.1, offset = -1, even = true}`: a second shell with reversed winding, and rim faces along open edges. `offset` -1 puts the wall behind the surface, 0 centers it, 1 puts it in front. `even` keeps the thickness at corners. Walls thicker than a concave part's radius fold over themselves: nothing detects that.
- `{type: 'screw', axis = 'y', origin = [0, 0, 0], angle = 2 pi, steps = 16, height = 0}`: sweeps a surface profile around the axis, climbing `height` over the whole sweep. Open edges make the walls; a sweep that does not close gets the profile as its end caps; a full turn with no `height` closes on itself and leaves no caps. Vertices on the axis stay shared. `PolygonMesh` has no loose edges, so the profile is a surface, not a wire.
- `{type: 'lattice', min, max, resolution, points}`: free-form deformation (Sederberg and Parry, 1986) with Bernstein weights. Start from `latticePoints(min, max, resolution)`, which changes nothing, and move points. Vertices outside the box stay where they are.
- A modifier that warps a face splits it into valid convex pieces (`id~t1`, ...) and says so in `diagnostics`.


## Simplification and levels of detail

Quadric error edge collapse that keeps UV seams and open borders:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { meshLODChain, simplifyMesh, subdivideMesh } from 'margoengine/mesh-edit/modeling';

const smooth = subdivideMesh(createPrimitiveMesh('cube', 'box'), { levels: 3 }).mesh;
// Half the triangles, never moving a seam.
const half = simplifyMesh(smooth, { ratio: 0.5 });
// Three nested levels: 50%, 25% and 12.5% of the input's triangles.
const lods = meshLODChain(smooth, { ratios: [0.5, 0.25, 0.125] });
console.log(half.triangles, half.error, lods.map((level) => level.triangles.after));
```

- `simplifyMesh(mesh, {ratio = 0.5, targetTriangles, maxError, mergeCoplanar = true, createId, signal})` follows
  Garland and Heckbert (1997): face planes summed into per-vertex quadrics, cheapest collapse first. Each collapse
  moves one end of an edge onto the other (the paper's vertex-subset placement), so output positions and corner UVs
  are input values and textures never swim; the trade is a slightly larger error than optimal placement. Border and
  UV-seam vertices slide only along their own border or seam (with the paper's perpendicular constraint planes), and
  corners where seams meet stay. Collapses that would fold a triangle, flip its UVs, pinch the surface (the link
  condition) or leave a sliver are skipped, so the target is a ceiling. `maxError` is a squared distance in local
  units. Coplanar triangles of one source face merge back into convex polygons; `faceMap` and `sourceVertices`
  give provenance.
- `meshLODChain(mesh, {ratios = [0.5, 0.25, 0.125]})` simplifies each level from the previous one, so levels nest and
  seams match between them.
## Remeshing

Rebuild a messy or scanned mesh into even faces before sculpting, simulation or simplification:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { remeshMesh, remeshMeshVoxels } from 'margoengine/mesh-edit/remesh';

const box = createPrimitiveMesh('cube', 'box');
// Even triangles on the same surface; the cube keeps its corners and creases.
const even = remeshMesh(box, { targetLength: 0.1 });
// The same, paired into a mostly quad surface.
const quads = remeshMesh(box, { targetLength: 0.1, quads: true });
// A new closed surface from a voxel grid, with quad topology.
const voxels = remeshMeshVoxels(box, { voxelSize: 0.05 });
console.log(even.mesh.faces.length, quads.quads?.length, quads.unpaired, voxels.quads.length, voxels.nonManifoldEdges);
```

- `remeshMesh(mesh, {targetLength, iterations = 5, sharpAngle = 40 degrees in radians, preserveSeams = true, createId, signal})` is isotropic remeshing (Botsch and Kobbelt, 2004): each round splits edges over 4/3 of the target, collapses those under 4/5, flips toward six neighbors per vertex, relaxes along the surface and snaps back onto the input. Creases, seams and open borders stay, and so does every corner where one of them turns by more than `sharpAngle`, so a target larger than the mesh leaves it as it is. `targetLength` defaults to the mean edge length. Open edges, creases above `sharpAngle` and UV seams stay in place. Corner UVs carry over, and `sources` names the input face under each output face. The output is triangles.
- `remeshMeshVoxels(mesh, {voxelSize, maxCells = 16777216, createId, signal})` builds a signed distance grid and extracts it with surface nets (Gibson, 1998). Whatever the input's triangles were, the result has edges of about `voxelSize`; gaps under a voxel close and details under a voxel go. The input must be closed (use `fillMeshHoles` first). Inside is decided by parity, so where two parts overlap the shared region counts as outside: union them first if that matters. UVs do not carry over.
- `quads: true` on `remeshMesh` pairs the even triangles across their edges, the squarest pair first, and leaves creases and seams as edges. A pair whose worst corner is over 65 degrees from a right angle stays apart. `quads` lists the pairs and `unpaired` counts the triangles left: measured on a rounded cube at `targetLength` 0.15, 228 of 1,234 (81.5% paired) with seams kept and none of 1,254 with `preserveSeams: false`; more seams leave more, since each island can leave odd ones. The matching is greedy with an augmenting search, so it is quad-dominant, not all quads: for an all-quad surface use `remeshMeshVoxels`, which gives up the input's UVs.
- A `PolygonMesh` face must be planar, so a warped quad, from either remesher, is stored as two triangles. `quads` always lists the full quad topology as vertex indices of `mesh`.
- `nonManifoldEdges` counts edges joining four faces, which happens where two sheets of the surface pass within a voxel. A finer `voxelSize` separates them.
## Sculpt brushes

Draw, smooth, grab, inflate and crease brushes for apps like Margo Mesh, with optional dynamic topology:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { subdivideMesh } from 'margoengine/mesh-edit/modeling';
import { MeshSculptSession } from 'margoengine/mesh-edit/sculpt';

let mesh = createPrimitiveMesh('cube', 'box');
for (let level = 0; level < 3; level++) mesh = subdivideMesh(mesh).mesh;
const session = new MeshSculptSession(mesh, { radius: 0.3, dynamicTopology: true, detailSize: 0.05 });

const hit = session.pick([0, 0, 5], [0, 0, -1]);
if (hit) {
  session.beginStroke({ brush: 'draw', strength: 0.8 });
  session.dab(hit.point); // once per pointer move
  session.endStroke();
}
session.undo();
session.redo();
console.log(session.mesh().faces.length);
```

- `new MeshSculptSession(mesh, {brush, radius, strength, falloff, invert, symmetry, dynamicTopology, detailSize, undoLimit, createId})` copies the mesh into a triangle surface. `mesh()` returns it as a new polygon mesh.
- `brush`: `'draw'` (default) pushes along the brush's average normal, `'inflate'` along each vertex's own normal, `'smooth'` toward neighbors, `'crease'` sinks and pinches toward the center, and `'grab'` holds the vertices under its first dab and drags them with the pointer. `invert` pushes the other way.
- `radius` (default 0.25), `strength` 0 to 1 (default 0.5), `falloff` `'smooth'` (default), `'linear'`, `'sharp'` or `'constant'`, and `symmetry` `'x'`, `'y'` or `'z'` to repeat each dab across that plane through the origin. All can be set per stroke in `beginStroke`.
- `pick(origin, direction)` returns the nearest `{point, normal, distance}`. A hash grid finds the triangles along the ray and the vertices under a brush, so a pick and a dab cost what the ray and the brush touch, whatever the size of the mesh. `session.stats` says how much the last pick and dab visited.
- `dynamicTopology` splits and collapses edges under the brush to hold `detailSize` (default the mean edge length), so a long pull does not stretch triangles. Corner UVs interpolate. For `grab` this runs once at the end of the stroke, since it holds fixed vertices.
- Each stroke is one undo step, `undoLimit` of them (default 32). A step stores only what the stroke changed: vertices, triangles and sharp edges.
- A session takes up to 200,000 vertices and faces, like every mesh-edit mesh.

Draw it while it changes with `@margoengine/mesh-edit/sculpt-view`, which needs `@margoengine/core` and `@margoengine/gltf-pro`. Each frame uploads only the vertices the brush moved; when triangles change (dynamic topology, or undoing it) the whole mesh is rewritten.

```ts
import { Engine } from 'margoengine/core';
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { subdivideMesh } from 'margoengine/mesh-edit/modeling';
import { MeshSculptSession } from 'margoengine/mesh-edit/sculpt';
import { SculptView } from 'margoengine/mesh-edit/sculpt-view';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { camera: { position: [0, 0, 4], target: [0, 0, 0] } });
const session = new MeshSculptSession(subdivideMesh(createPrimitiveMesh('cube', 'box'), { levels: 3 }).mesh, { radius: 0.3 });
const view = SculptView.attach(engine, session);

const hit = session.pick([0, 0, 4], [0, 0, -1]);
if (hit) {
  session.beginStroke({ brush: 'draw' });
  session.dab(hit.point); // the next frame shows it
  session.endStroke();
}
console.log(view.stats.uploadedVertices);
```

- `SculptView.attach(engine, session, {material})` draws the session as `view.model`, a gltf-pro model, with a matte clay material by default (`material` takes a glTF material). The view owns the model; `dispose()` removes it and leaves the session usable. Normals are smooth, area-weighted over each vertex's faces.
- `view.stats` counts `uploadedVertices` and whole-mesh `rewrites`.
- `session.drawing()` gives the same buffers without gltf-pro: `vertices` (20 floats a vertex, gltf-pro's prepared layout) and `indices`, and `update()` returns the vertex ranges that changed, or `'all'` when triangles did.
## Baking maps from a detailed mesh

Keep the look of a detailed mesh on a simplified one: bake its normals, ambient occlusion and colour into textures laid out by the low mesh's UVs.

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { bakeMeshMaps } from 'margoengine/mesh-edit/bake';
import { subdivideMesh } from 'margoengine/mesh-edit/modeling';

const low = createPrimitiveMesh('plane', 'low');
const high = subdivideMesh(subdivideMesh(low).mesh).mesh;
const { normal, ao, covered, missed } = bakeMeshMaps(low, high, {
  width: 256,
  maps: ['normal', 'ao'],
  aoRays: 16,
});
console.log(normal?.data.length, ao?.width, covered, missed);
```

Each covered texel casts one ray along the low surface's smooth normal, through `distance` on both sides, and takes the hit nearest the low surface from a float64 `@margoengine/bvh` tree. Images are RGBA8, rows from the top.

| Option | Default | Meaning |
| --- | --- | --- |
| `width`, `height` | 512, the width | Texels, 1 to 8192 |
| `maps` | `['normal']` | Any of `'normal'`, `'ao'`, `'color'` |
| `distance` | 5% of the high mesh's size | Ray search each way from the low surface |
| `color` | none | Image read at the high mesh's UVs, or a function of the hit; needed for `'color'` |
| `aoRays` | 32 | Cosine-weighted rays per texel, 1 to 1024 |
| `aoDistance` | the high mesh's size | Hits farther away do not occlude |
| `padding` | 4 | Texels grown out of each island, 0 to 64, so filtering stays off the background |
| `seed` | 1 | Occlusion rays repeat exactly for a seed |
| `signal` | none | `AbortSignal`, checked per low triangle |

`bakeSurfaceMaps(low, high, options)` takes the same options for triangles that already carry their shading frame, such as a loaded model's primitive and a simplified copy of it: `{positions, indices, uvs, normals, tangents}`, as flat arrays. Rays leave along `low.normals`, and the normal map is written in the frame of `low.tangents` as a shader reads them, so a material drawing `low` shows `high`. `@margoengine/lod/auto` calls it for its `bake` option. Nothing is welded, so any triangles go. `shared` in the result counts the texels a second triangle also lay well inside, which is how overlapping UVs show.

```ts
import { bakeSurfaceMaps } from 'margoengine/mesh-edit/bake';

const square = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3], uvs: [0, 0, 1, 0, 1, 1, 0, 1] };
const tilted = { ...square, positions: [0, 0, 0, 1, 0, 0.5, 1, 1, 0.5, 0, 1, 0] };
const { normal, shared } = bakeSurfaceMaps(square, tilted, { width: 64, distance: 1 });
console.log(normal?.width, shared); // 64 0
```

Normals are tangent space with green up, the glTF convention, in a frame built from the low mesh's UVs. Overlapping UVs share texels, first triangle wins: run `unwrapMesh` first. `missed` counts texels that found nothing; raise `distance` when it is above zero. The bake runs on the calling thread.
## Vertex groups and weight painting

Named per-vertex weights that follow the mesh through edits, and a brush to paint them, so rigging can happen in the browser:

```ts
import { createPrimitiveMesh, extrudeMeshFace } from 'margoengine/mesh-edit';
import { paintMeshWeights, VertexGroups } from 'margoengine/mesh-edit/weights';

const mesh = createPrimitiveMesh('cube', 'body');
const groups = new VertexGroups(mesh.vertices.length);
paintMeshWeights(groups, mesh, 'hip', { center: [0, -0.5, 0], radius: 1 });
paintMeshWeights(groups, mesh, 'chest', { center: [0, 0.5, 0], radius: 1, normalize: true });

const edit = extrudeMeshFace(mesh, mesh.faces[0].id, 0.25);
const after = groups.remap(edit);
const { joints, weights } = after.skinAttributes();
console.log(after.names, joints.length, weights.length);
```

`remap` takes any mesh-edit result. A kept vertex keeps its weight, each copy of a split vertex inherits it, welded vertices average, and created vertices take the mean of their edge neighbors, ring by ring. Call it once per edit, in order; a vertex map of the wrong size throws.

`paintMeshWeights(groups, mesh, group, options)` is one dab and returns the vertices touched. Distance is straight-line.

| Option | Default | Meaning |
| --- | --- | --- |
| `center`, `radius` | required | Brush position and size in mesh space |
| `mode` | `'replace'` | `'replace'`, `'add'`, `'subtract'` or `'smooth'` |
| `value` | 1 | Weight painted toward, or added and taken away |
| `strength` | 1 | How much one dab applies, 0 to 1 |
| `falloff` | `'smooth'` | `'smooth'`, `'linear'` or `'constant'` |
| `normalize` | false | Rescale touched vertices so all groups sum to 1 |

`skinAttributes({ influences, joints })` keeps each vertex's strongest `influences` groups (default 4), rescaled to sum to 1, as the `Uint16Array` joints and `Float32Array` weights that `Skin` in `@margoengine/animation` takes. `joints` maps group names to joint indices; by default a group's joint is its position in `names`. Vertices with no weight get joint 0 at full weight and are listed in `unweighted`. `toJSON` and `VertexGroups.fromJSON` save and restore sparse weights.


## UV unwrap and lightmap UVs

Automatic charts, flattened with least squares conformal maps, with seams and pins:

```ts
import { createPrimitiveMesh } from 'margoengine/mesh-edit';
import { meshLightmapUVs, subdivideMesh, unwrapMesh } from 'margoengine/mesh-edit/modeling';

const smooth = subdivideMesh(createPrimitiveMesh('cube', 'box'), { levels: 2 }).mesh;
// New corner UVs: charts cut at edges sharper than 60 degrees, 4 texels apart at 1024.
const unwrapped = unwrapMesh(smooth, { angle: 60, padding: 4 });
// A second UV set for baked light: every chart in its own texels of a 256 x 256 lightmap.
const lightmap = meshLightmapUVs(smooth, { resolution: 256, padding: 2 });
console.log(unwrapped.charts.length, unwrapped.seams.length, lightmap.texelsPerUnit);
```

- `unwrapMesh(mesh, {seams = [], angle = 66, pins = [], resolution = 1024, padding = 4, signal})` cuts along `seams`
  (edge IDs), open borders, nonmanifold or inconsistently wound edges and edges whose faces meet at more than `angle`
  degrees (180 turns this off). Each chart is flattened by least squares conformal maps (Lévy, Petitjean, Ray and
  Maillot, 2002), so angles are kept as well as a flat map allows. A chart that is not a topological disk (a closed
  surface, a handle), or whose map would fold a triangle or let its border touch itself, is split in two where regions
  grown from its two farthest-apart faces meet, and again until none does; every chart is then a disk with
  no folds and no self-overlap. Charts are scaled to their true surface area (one texel density for all), rotated to
  their smallest bounding box and shelf-packed into the unit square with `padding` texels around each at
  `resolution`. Input UVs may be missing (draft UVs); positions, faces, IDs and winding are unchanged.
- Pins (`{vertex, uv}`, normalized top-left) fix every corner of that vertex. A chart with two or more pins is solved
  through them and stays exactly where they put it (no rotation or rescale); one pin anchors its chart at the packed
  density, rotated to its smallest box. The other charts are packed around the bounding box of every pinned chart,
  `padding` texels clear of it, so no two charts ever overlap. A pinned vertex on a seam pins each chart that holds it.
- Pin errors are reported, never laid out as overlaps: pinned charts that overlap each other, or that leave the other
  charts no room at any density, throw a `MargoError` with code `failed`; two or more pins that put a chart outside the
  unit square throw a `RangeError`. Pinned charts that touch or sit closer than `padding` are allowed and listed in
  `diagnostics`, as are pin sets that fold their chart. A single-pin chart near the border or another pinned chart
  lowers the one texel density all charts share until it fits (listed in `diagnostics`); when it cannot fit at any
  density (a pin on the border with the chart past it) it throws a `RangeError`.
- The result has `charts` (faces, pins, bounds, surface area and `stretch`, the largest over smallest triangle scale),
  `seams` (edges whose output UVs are discontinuous) and `texelsPerUnit`.
- `meshLightmapUVs(mesh, {seams, angle, resolution = 256, padding = 2, signal})` makes the same charts without pins as
  a separate UV set (`uv[face][corner]`, for glTF `TEXCOORD_1`): one texel density, each chart starting on a texel
  corner with `padding` empty texels to its neighbors and the border, so bilinear filtering never bleeds between
  charts. Too many charts for the resolution throws a RangeError naming the fix.

### Limits: unwrap and lightmap UVs

- Charts are packed by their bounding boxes on shelves, not by their outlines, so an L-shaped or diagonal chart wastes
  the empty corners of its box. Pinned charts are obstacles by their bounding boxes too.
- Pins are checked against each other by their face outlines (overlap throws, touching is reported), but the packed
  charts keep `padding` from a pinned chart's whole box.
- One texel density for every unpinned and single-pin chart; there is no per-chart weighting.
- `meshLightmapUVs` takes no pins. Bake its UV set with `bakeMeshLightmap` from `@margoengine/lightmap/mesh`: fan-split
  each face into triangles and pass `uv[f][c]` per corner as the mesh's `uv1`.

## Import to editable meshes and flat-tile merging

Turn a glTF primitive, an OBJ or any indexed triangles into polygons you can edit:

```ts
import { readAccessor, splitGLB } from 'margoengine/exporters';
import { mergeFlatFaces, polygonMeshFromTriangles } from 'margoengine/mesh-edit/modeling';

const parts = splitGLB(new Uint8Array(await (await fetch('/models/crate.glb')).arrayBuffer()));
const gltf = parts.json as { meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[] };
const primitive = gltf.meshes[0].primitives[0];
// Seams rejoin, coplanar triangles merge back into quads, UVs are kept (or unwrapped when missing).
const { mesh, diagnostics } = polygonMeshFromTriangles({
  positions: readAccessor(parts, primitive.attributes.POSITION).values,
  uvs: readAccessor(parts, primitive.attributes.TEXCOORD_0).values,
  indices: readAccessor(parts, primitive.indices).values,
});
// Flat-tile merging on any mesh: coplanar neighbors with one UV map become one face.
const tiles = mergeFlatFaces(mesh);
console.log(mesh.faces.length, tiles.merged, diagnostics);
```

- `polygonMeshFromTriangles({positions, indices, uvs, faceSizes, positionIndices}, {weld = 0, mergeFlat = true,
  uv = 'auto', unwrap, signal})`. For an OBJ, pass `parseOBJ`'s (`margoengine/loaders`) `positions`, `uvs`,
  `indices`, `faceSizes` and `positionIndices`: polygons are rebuilt from their fans and positions rejoined exactly.
  Otherwise positions within `weld` (default 0, identical only) are joined, which rejoins vertices split at UV seams;
  corner UVs never weld. Polygons with repeated or crossing corners or no area are dropped, concave or nonplanar ones
  split into convex faces (both counted in `diagnostics`). `uv: 'auto'` keeps the source UVs when all are within 0 to
  1 and unwraps with `unwrapMesh` otherwise (missing or tiling UVs); `'keep'` throws instead; `'unwrap'` always
  unwraps. Face IDs are `f<index>` of the source polygon, so they are stable between imports; `sourceFaces` maps each
  output face to the source polygons it covers.
- `mergeFlatFaces(mesh, {faces, tolerance, uv = 'match', signal})` joins neighboring faces across any shared run of
  edges when the union is one planar convex polygon of at most 64 corners and, with `uv: 'match'`, their UVs are one
  affine map of position, so the result renders exactly as before (`'ignore'` merges on geometry alone, for meshes you
  will unwrap). Corners left in the middle of a straight edge drop out from every face that uses them at once, so no
  T-junction appears; unused vertices are removed. `tolerance` defaults to 1e-6 of the bounding-box diagonal. The
  merged face keeps its first face's ID; `faceMap` names it for every input face.

## Pixel painting and UVs

`meshUVTopology(mesh)` identifies islands through opposite two-face geometric edges whose UVs match exactly at both endpoints. Point contacts, disconnected overlapping atlas regions, nonmanifold edges and inconsistent winding do not connect islands. It returns stable face/corner references and explicit seam reasons. `meshSelectionUVCorners` resolves corner, face, island-seed or whole-mesh intent to deduplicated source-order corners; stale identities reject.

`transformMeshUVs` accepts `translationSnap` for positive grid steps applied only to the movement vector. An island moves as a whole: fractional corner spacing and an unmoved axis remain intact, including Number precision and signed zero. Steps use texels with `atlasDimensions`, normalized UV units otherwise. Invalid steps/overflow reject atomically. Existing `snap` explicitly rounds individual selected corners after the affine transform and can change their spacing; use it for intentional pixel alignment, not routine snapped movement. Both options can be supplied explicitly when both operations are intended.

`extrudeMeshRegion(mesh, faceIds, distance, options)` joins selected faces through opposite manifold edges, duplicates their cap vertices once per connected region, and adds walls only on boundary edges (including inner loops). Each region moves along its area-weighted local normal or `options.direction`; distance is local, and zero/empty commands are no-ops. Caps retain IDs and exact UVs. New walls initially sample the source edge and should receive separate islands through `allocateMeshFaceUV` before painting. Now-unused old interior vertices compact with explicit vertex/face/edge mappings; preexisting loose vertices remain. Disconnected/point-touching patches keep independent caps. Touched nonmanifold/winding conflicts, complete closed selections, invalid IDs, nonfinite commands and degenerate output reject without changing input. This is region extrusion, not a global self-intersection or CSG certificate.

`fillMeshPaintFaces(scene, targets, color, options)` fills entire eligible face masks beyond the 128-pixel dab limit, then derives their protected one-pixel halos. It uses the same locked/shared-owner policy, atlas-coordinate dither and exact RGBA/transparent color handling as surface paint. Duplicate targets deduplicate; stale identities/invalid selected UVs/options reject before writes, ineligible owners skip, and unchanged fills return null. One owned texture copy serves all targets. Allocate isolated new UV islands first when existing painted work must remain untouched.

`transformMeshUVs(mesh, selection, transform)` returns owned geometry with unchanged positions, polygon indices and face IDs. Translation, pivot and optional snapping use normalized UVs, or texels when `atlasDimensions` is supplied. Scale is applied before rotation about the pivot; negative scales mirror UVs. Quarter turns within one full turn use exact coefficients, and identity transforms preserve coordinate precision. Out-of-atlas, zero-scale and nonfinite edits reject atomically without clamping or wrapping. Only selected corners change. This edits texture coordinates, not atlas pixels; painted-pixel relocation, pins, explicit seam authoring and geometric seam-continuous brush transfer remain separate capabilities. Callers invalidate prepared paint sessions after a UV edit and own locks, visibility, preview/cancel and undo.

`PaintScene` accepts indexed polygon objects with public Margo world matrices, an RGBA atlas and explicit `canPaint`, `canProject` and `canMirror` flags. The caller resolves hierarchy, locks and visibility into those flags. Draft UVs may be missing or malformed for repair; geometry and matrices must remain valid. Outputs contain owned pixel/geometry arrays and no editor document fields.

`meshPaintTexel` floors and clamps normalized top-left UVs to the nearest texel. `paintMeshSurface` paints the hit face, optionally mirrors in local X (with world-space fallback), and supports solid, erase and two-color dither brushes. `paintMeshAtlas` paints eligible island masks at an integer atlas location. Both maintain a one-pixel halo, return `null` for no change and protect content and halos belonging to every ineligible owner, including overlapping shared UVs. Out-of-bounds atlas brush centers are no-ops. UV-mask caches rebind current geometry and eligibility on every call. `mirrorMeshPaintHit` returns the corresponding neutral surface hit without painting.

`allocateMeshFaceUV` allocates only new faces around protected existing rectangles, preserving exact world-space texel density. `projectMeshUV` and `packMeshUV` use integer texel spans and raster occupancy with halos. Selected reprojection reads the original RGBA atlas with nearest sampling; unmapped repair flat-fills from the first finite source UV or a fallback color. Allocation exhaustion rejects atomically. These policies intentionally differ to preserve established assets. Reprojection also initializes conservatively covered edge-only cells before halo derivation, as described below. Continuous brushes across disconnected UV seams and UV-layer authoring are outside this API.

`resizeMeshPaintAtlas` copies texels and rescales normalized UVs to preserve integer texel coordinates on a rectangular atlas up to 1024 pixels per axis. `dominantMeshPaintColors`, `createMeshPaintPalette` and `applyMeshPaintPalette` provide stable color-frequency selection, the existing blue/red/toxic presets and simultaneous RGB substitution with alpha preserved. Callers name variants and package exports.

`new MeshPaintSession(scene)` prepares an independent owned scene and supports one reversible stroke at a time. `begin(revision)` returns an opaque stroke; `surface` and `atlas` validate small commands and journal actual writes against prepared masks, protection and halo stencils. `flush` returns an owned packed RGBA rectangle, with sequence and revision, for ordinary regional texture uploads. No caller scene reads, full-image copies or raster-index signatures occur per dab. `commit(stroke, revision)` returns one owned full atlas only for net changes; `cancel` restores original bytes and returns a restoration rectangle, including earlier previews of a net-zero stroke. Flush pending output before commit, or restore committed presentation on close. A stale revision or stroke handle throws `MargoError` code `state`; any call after `dispose()` (or `[Symbol.dispose]()`) throws code `disposed`.

Changed commits and successful `replace(scene)` advance the revision; replacement invalidates old stroke identities. Failed replacement preserves the active transaction. Caller/input/result mutations cannot alter prepared storage. `dispose` is idempotent; other operations on a disposed session reject. The caller must cancel/invalidate before document changes and keep previews out of history/storage/exports. Preparation still performs full validation/copy/raster work; this API alone does not promise cold-input or browser presentation latency. The pure paint APIs retain full mutable-input validation.

`quantizePolygonMesh(mesh, worldMatrix, step)` snaps in world space using public Margo matrices, then maps back to local positions. Steps range from 1/1024 to 1 unit. It preserves UVs and face IDs, and rejects noninvertible transforms, collapsed/flipped/warped faces or volume before returning. Arbitrarily rotated quads may warp under discrete snapping; use a finer grid or triangular faces. The input remains unchanged on rejection.

`cleanupPolygonMeshes(inputs, {weld: true})` takes explicit `canEdit`, `canOcclude` and `motionGroup` policy for each mesh. It removes only strict convex enclosure or complete opposing shared polygons between eligible meshes. Occluders must have opposite directed edge incidences, one connected closed face component, supporting convex planes and nonzero volume. Duplicate/open/disconnected sheets cannot prove enclosure. Locked meshes may occlude when permitted but are never edited; shared-boundary deletion requires both meshes to be editable. Partial overlaps and general CSG are unsupported. Optional welding merges exact coincident used positions within each editable mesh and preserves independent corner UVs; unused points are compacted without counting as welds.

`isAtlasOpaque(mesh, texture)` answers whether every texel under each face's UV bounding rectangle of a top-left
row-major RGBA8 atlas has alpha 255, the usual test for `canOcclude`. The rectangle overestimates non-rectangular
islands, so nearby transparency can only make it refuse to occlude.

## Component deletion

The public deleteMeshComponents operation deletes selected vertices and incident faces, selected edges' incident faces, or selected faces. Default affected-only pruning removes formerly used vertices made loose by the edit and preserves preexisting loose vertices; set pruneUnusedVertices false to retain unselected loose vertices. This removes faces; it does not dissolve, rebuild or fill a surface. Surviving position values, face IDs, winding/corner order and UVs stay exact. Every source component has explicit output provenance through index compaction, including numeric edge-name collisions. Empty selections return owned no-ops and empty output meshes remain valid. Output boundary, more-than-two-incidence and two-face winding-conflict identities describe remaining edges, without certifying global manifold validity. The host owns eligibility, selection/history and storage.

## Complete projection edge transfer

projectMeshUV and selected packMeshUV now initialize every conservative destination content texel before generating halos. Covered center samples keep their existing nearest source behavior. Edge-only cells clip the destination fan triangles to the texel, select greatest overlap and sample its centroid (or a line/point contact). Barycentric coordinates transfer one original RGBA texel without color blending. Transparent RGB stays exact, peer reservations remain protected, and missing source UVs keep the gray fallback. Allocations and writes stay owned and atomic; no public signature changes. This does not certify lossless one-to-one reprojection at reduced density or continuous geometric brushes.

## Equal-width region inset

`insetMeshRegion(mesh, faceIds, width, options)` offsets connected planar regions by an equal nonnegative width. Provide an invertible affine `worldMatrix` to measure the width in world space, including reflected/nonuniform transforms; omit it for local width. Concave outlines, holes, collinear subdivisions and interior vertices are supported. Boundary miters share cap vertices, collinear points redistribute along their offset edge, and interior displacement extends harmonically across the selected graph. Caps retain IDs and exact ordered UVs; only boundary edges produce new border faces. Allocate new border islands with `allocateMeshFaceUV` before painting.

Results carry explicit vertex/face/edge provenance through affected-only compaction, preserve preexisting loose vertices and never mutate inputs. Empty selections and width0 return owned no-ops. Nonplanar/branched/nonmanifold/incoherent regions, collapsed or crossing widths and numerically unresolved metrics reject with repair guidance; widths are not silently clamped. Straight-skeleton topology changes, curved-surface inset, selected-edge bevel and global CSG validation remain outside this operation. The legacy centroid-fraction `insetMeshFace` remains unchanged. Validation/topology is shared with existing region extrusion; CPU command measurements do not certify interactive latency or frame rate.

`new MeshRegionInsetSession(mesh, faceIds, options)` owns a captured source/selection/affine metric for repeated `inset(width)` previews. It lazily prepares source incidence, planar projection, loops and unit harmonic displacement once. Every candidate still checks cap/border geometry, crossings, collapse and finite local output. Positive results keep the session's generated border IDs; the ID callback runs only to establish its first geometrically valid template. Each returned result owns all arrays and provenance. Zero/empty no-ops allocate no IDs; failures return no candidate and preserve valid preparation. Later source/transform edits require a new session. `dispose()`/`[Symbol.dispose]()` release captured state; reentrant ID callbacks and disposed evaluations reject with actionable MargoErrors. The host retains history, UV allocation and paint policy. Preparation and full candidate validation remain synchronous; this API makes no frame-time promise.

`new MeshRegionInsetPreview(scene, objectId, faceIds, options)` additionally owns scene policy/transforms, source RGBA and protected UV reservations. Its `inset(width, {pixelsPerUnit, color, mode, secondaryColor})` composes the checked geometry operation with the existing exact-density projection, row-major allocation and full-face fill/halo rules. Omit color for geometry/UV only. Results contain independent raw topology, allocated geometry and a changed atlas or null; caller metadata/history stay outside Engine. Only the last identical width/density frame may be reused for color/dither changes. A changed width or density rebuilds projection, allocation and new conservative raster masks, preserving cap UVs, protected peer texels, transparent RGB and halo ownership. Exhaustion never lowers density. Source arrays/results do not escape into cached storage; recapture after any source, atlas or policy change. Standard disposal releases all captured state. This optional composition removes repeated validation of immutable source/atlas data while retaining complete new-candidate geometry checks; it does not certify input latency or frame rate.

Polygon and inset-edge validation reuse exact vector/edge measurements and avoid temporary flattening and callback arrays in hot loops. All finite/structural, distinct-corner, planarity, crossing/overlap, backtracking, convexity and collapse predicates retain their existing epsilons and rules. This is an implementation optimization; it adds no public validation bypass or relaxed geometry policy. Frozen-SDK differential checks supplement independent positive and negative geometry cases, including near-tolerance and unresolved-coordinate inputs.

`new MeshSurfaceQuery([{objectId, mesh, compiled?, worldMatrix?}])` owns editable-source geometry, affine world transforms and compiled corner/triangle provenance at JavaScript number precision. `intersect({origin, direction}, options)` returns owned double-sided surface hits with exact barycentrics, local/world/ray points and polygon-clamped UVs. Directions must be normalized; their components are copied without renormalization. A borrowed live RGBA8 `texture` adds floor/clamped texels and sampled-alpha rejection (default cutoff 6), allowing paint revisions without geometry recapture. Maximum polygon UV edges clamp inward by 1e-9, retaining the content texel instead of selecting its halo. Only dimensions/storage and sampled alpha bytes are validated per query; unrelated RGB/texels are not scanned.

`objectIds` restricts captured identities without changing renderer visibility or paint policy, including query-only collider helpers. Hits sort by distance then capture order; `firstHitOnly` retains the first equal-distance hit. The default strict lower distance bound is 0.00001 and the upper bound is inclusive. `triangles()` and `worldVertices(objectId)` return independent source-frame data, including loose vertices. Supplied compiled buffers retain their actual index/corner provenance rather than refanning faces; callers are responsible for providing the intended triangle coverage. Each source gets one `@margoengine/bvh` tree over its float64 world positions (engine-free `@margoengine/bvh/tree` entry), so hit distances, points and barycentrics keep full double precision. It is not a posed-skin or rendered-frame query. Recapture after topology/UV/transform changes; dispose releases owned data and blocks later calls. Reentrant calls reject, and disposal during a caller-owned getter publishes no result. No renderer or core dependency is added.

`frame()` returns owned rich triangles and world vertices with shared world-corner references within that result. `worldFrame()` returns the same complete world geometry and identities for presentation while omitting unused local/UV/bounds copies. Full attributes remain owned by the query and available through `frame()`, `triangles()` and exact hit results; this never changes paint, topology or export data. Both presentation forms retain per-vertex projection reuse and never alias captured storage. Source capture reuses a transform vector, checks corner identity without temporary slices/callback arrays, caches exact per-corner UV pairs and accumulates finite world bounds while transforming. All structural, geometry, finite, matrix, compiled position/UV and face-corner provenance checks remain; no unchecked capture option is exposed. The optional all-hit `order: 'source'` retains source/compiled traversal for host component tie policy.
