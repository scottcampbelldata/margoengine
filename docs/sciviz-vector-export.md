# Scientific 3D vector publication

`@margoengine/sciviz/export-vector` provides `exportVector(figure, options)` and
`exportVectorScene(scene, options)`. Both return `{ svg, mode, reason?, triangles,
fragments }`. The first snapshots the current surfaces, committed GPU isosurfaces,
grid/triangle meshes, point clouds and lines. Axes, colour bars, legend and HTML
text remain vectors. The second accepts owned triangle soups, line strips or
independent segments, and round or square points with a data-to-clip matrix.
Coordinates use the engine's reversed-Z WebGPU clip convention. No renderer,
browser globals or device is needed to export a standalone scene.

The exporter clips in homogeneous coordinates before perspective division.
It subdivides varying per-vertex sRGB colours into 16 facets per triangle by
default (`colorDepth: 2`, allowed 0 through 4). Uniform colours are left intact.
Line colours use 16 segments, round points use 24 boundary vertices, and square
points use four. Screen-width strokes and discs are planar polygons in the same
BSP as surfaces. A line or disc crossing a surface is split rather than sorted
only by its centre. Perspective colour attributes retain reciprocal w through
clipping, subdivision and BSP cuts. Alpha is composited in painter order.

The bounded BSP chooses among nine candidate planes at each partition. It splits
straddling polygons, traverses farther then coplanar then nearer geometry, and
retains input order for coplanar ties. Iterative traversal avoids recursion depth
limits. Plane classification uses a 1e-10 unit-normal clip-space distance boundary band; projected
faces with area determinant at most 1e-18 are degenerate. These are numerical
boundaries, not an exact arithmetic geometry claim.

Defaults are 20,000 source triangles, 50,000 source marks and 200,000 generated
facets/fragments. Limits are independently configurable positive safe integers.
Past any limit the entire figure falls back to its embedded PNG, never a partial
vector figure. The result and SVG `data-sciviz-export` / `data-sciviz-fallback`
attributes state the choice and cause. Standalone scenes supply `raster()` if they
want fallback; without it, budget exhaustion rejects with a coded error and help
link. Unsupported layers and custom physical transport use figure raster export.
The optional entry loads only when imported. Layer snapshot adapters lazily load
their implementation and do not add a core or stage feature.

`signal` preserves its abort reason before and during conversion. Source arrays
are borrowed until the promise resolves: do not mutate a scene, camera, layers or
GPU fields concurrently with export. Layer snapshots own their arrays. Readback
staging buffers are destroyed on success, cancellation and failure. Isosurface
readback uses the committed GPU triangle buffer, not a separate extraction.

`examples/sciviz-export-vector.html` shows OpenNeuro ds000030 T1 at threshold 300,
sampled every eighth stored voxel (16 mm spacing in the prepared RAS volume),
and the complete NASA TMR FUN3D bump x=0.3 surface with original nodes/scalars.
MRI source/licence/hashes are in `examples/assets/sciviz/head.json` (CC0-1.0);
NASA provenance is in `examples/assets/sciviz/contour/source.json` (US government
public domain). The NASA demo raises the source limit to 50,000 and uses four
colour facets per triangle. No new external asset was added.

The vector output uses unlit scientific data colours. It does not reproduce
GPU lighting, procedural surface grid/contour shading, custom material shaders,
world-unit line/point sizing, textures or atmospheric transport. These visual
refinements remain recorded for the finish phase; there is no pixel-equivalence
or universal scientific accuracy claim. All required geometry classes have a
vector path and budgets never silently remove geometry.

Proof: `packages/sciviz/tests/export-vector.test.js` independently checks crossing
planes against an analytic depth oracle, clips a triangle to a hexagon, checks
missing-data holes, degenerate faces, colour subdivision, surface/line/disc depth
crossings, limits and cancellation. `export-vector-browser.mjs` checks exact
committed isosurface readback, latest height updates, complete real-data vectors,
fallback and exported SVG pixels on native WebGPU and WebGL2 compatibility.
Run the latter with a shared GPU lock after building the package. No benchmark
or speed claim is made.
