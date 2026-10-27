# @margoengine/mesh-edit

Install `npm i margoengine` and import `margoengine/mesh-edit` (or this package alone: `npm i @margoengine/mesh-edit`, imported as `@margoengine/mesh-edit`; the two are the same module).

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
const beveled = bevelPolygonMesh(cube, 0.1);
console.log(inset.mesh.faces.length, beveled.mesh.faces.length);
```

Callers own selection intent, locks, visibility, motion/opacity policy, IDs, undo and texture storage. Margo owns component transform geometry and the UV/paint algorithms below. No engine instance, DOM or GPU is needed. Supply `createId` for deterministic face IDs; otherwise commands call `crypto.randomUUID()` only when creating faces. Empty and duplicate generated IDs reject before exposing output.

The original parity commands retain existing behavior: extrusion acts along the local face normal, inset and whole-mesh bevel use centroid fractions, and `cutMeshFace` bisects one face at opposite-edge midpoints. Cut vertices propagate through neighboring incident edges; each face interpolates its own UVs. Bevel requires closed two-manifold geometry and returns an unchanged owned mesh with a diagnostic for unsupported open/nonmanifold inputs. Supported faces are simple planar convex polygons with 3-64 corners; collinear boundary corners remain valid. Compile produces flat normals and fan triangles, preserving source face and corner-vertex identity. Arbitrary drawn knife paths, equal-width bevel/inset and concave n-gons remain unsupported.

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
