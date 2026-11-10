# Batch 162 deterministic work counts

No benchmark or timed A/B run is part of this record. Historical slower labels remain until the quiet rerun.
All changes stay in their owning optional package, with no core or stage changes, eager optional dependencies,
module-level caches or Wasm loads.

## Row 4.1: primitive angular columns

Cause: sphere, cylinder, capsule and torus builders evaluated the same angular column for each profile row.
The per-call Float64 table retains the original argument expressions and arithmetic order, including signed zero.
No vertex, normal, UV, triangle, group or validation is removed. The box and polyhedra paths are unchanged.
The four shapes in one `p-primitives` iteration now make 654 sin/cos calls instead of 12,452:

| Shape and scene resolution | Parent sin/cos calls | Current calls |
|---|---:|---:|
| sphere 64 x 32 | 4,356 | 196 |
| capped cylinder 64 x 8 | 1,430 | 130 |
| capsule 16 cap, 32 radial, 1 height | 2,310 | 132 |
| torus 32 x 64 | 4,356 | 196 |

Trade-off: one temporary `Float64Array` per changed builder, 16 bytes per angular column including the seam.
The largest table in these scenes is 1,040 bytes. It is neither shared between calls nor retained afterwards.
This is an operation count, not a measured runtime or competitive speedup. Timing pending the quiet rerun.

Proof: `npm run build:packages`, then
`node --test --test-timeout=120000 packages/geometry/tests/primitive-workcount.test.js`.
The count assertion fails on the parent; 13 SHA-256 snapshots recorded before the change check every geometry
buffer byte and group, including zero radii/heights, a cone apex, negative radius, partial and negative sweeps.
These are same-runtime byte checks; transcendental last bits across JavaScript engines are not a new guarantee.

Research comparison: cylindrical/spherical parameterization exposes separable angular and profile variables;
reuse the angular values, without recurrences or approximate trigonometry that would change output bits.
The BVH, spatial hash and hull papers below address different workloads and do not justify changing primitive topology.
Clean room: no engine implementation or companion source was read or copied.

## Row 4.2: lathe and tube angular reuse

Cause: lathe recomputed each revolution angle for every profile point; tube recomputed each radial angle for every ring.
Fixed in `perf(geometry): reuse lathe and tube angular columns` (Batch 162 job 2). Reuse the same per-call Float64 table
as row 4.1. Curve sampling, parallel transport/Frenet frames, closed-seam reuse, normalization and extrusion stay intact.
For the unchanged `p-extrude` resolutions, lathe's 64-point profile and 128 angular segments need 258 sin/cos calls
instead of 16,512. Tube's 513 rings with 16 radial segments need 34 radial sin/cos calls instead of 17,442.
Frame and curve work is additional and unchanged. Combined angular calls fall from 33,954 to 292; this does not count
the extrusion or imply a whole-scene speedup. Timing pending the quiet rerun.

The tables cost 2,064 bytes for that lathe and 272 bytes for that tube, collectible after each call. No retained cache,
approximation, lower segment count, optional dependency or public API is added. The Cornell parameterization notes
below support the separable angular/profile evaluation; caching retains exact sin/cos arguments instead of using
an incremental rotation recurrence that would change floating-point bits.

Reproduce after `npm run build:packages`:
`node --test --test-timeout=120000 packages/geometry/tests/sweep-workcount.test.js`.
Seven parent SHA-256 checks cover every geometry stream for full/partial/collapsed profiles, straight and curved
open tubes and a closed curved tube. A straight tube isolates radial work from frame rotations. The parent fails
the angular-count assertion (16,512 rather than 258 on lathe); all seven parent byte checks pass on both versions.

## Row 4.5: mergeVertices hash factors

Cause: the neighbor scan rebuilt the x/y hash pair for each of the 9 (dx, dy) columns and the z factor for each of the 27 cells, then hashed the vertex's own cell again on insertion: 48 `Math.imul` calls for every vertex that found no match.
Fixed in `perf(geometry): reuse mergeVertices hash factors` (Batch 162 job 3). Each axis keeps three factors in a per-call `Int32Array(3)`; a factor is computed the first time the scan reaches it and reused afterwards, and insertion reuses the center factors. XOR is exact, so every bucket key is the same integer as before.
The scan still visits the same 27 cells in the same order, keeps the exact per-cell check that rejects 32-bit hash collisions and compares the same attributes.

| Case | Parent `Math.imul` calls | Current calls |
|---|---:|---:|
| 64 vertices in separate cells | 3,072 | 576 |
| unmatched, match in the first scanned cell, unmatched | 99 | 21 |

Because a factor is only computed where the parent would first have computed the same value, an early match never costs more calls than before (3 for a match in the first scanned cell, as on the parent).
Trade-off: two 12-byte `Int32Array` scratch arrays per call, nothing retained. This is an operation count, not a runtime or rival speed claim. Timing pending the quiet rerun.

Proof: `npm run build:packages`, then `node --test --test-timeout=120000 packages/geometry/tests/merge-vertices-workcount.test.js`.
Both count assertions fail on the parent (3,072 and 99 calls); 16 parent SHA-256 digests in `packages/geometry/tests/fixtures/merge-vertices-workcount.json` cover tolerance 0, 1e-4 and 0.1, position-only merging, normals, UVs, tangents, groups, degenerate removal, cell boundaries and a 32-bit hash collision.
Research: Teschner et al. 2003 hash the three integer cell coordinates with three large primes combined by XOR; the per-axis products are independent of the other axes, which is what makes them reusable across the 27 neighbor cells.

## Row 4.7: hull eye and parametric samples

Cause, hull: `assign` measures a point against every candidate face and gives it to the farthest, but when a face was later processed its whole outside set was measured again to find the eye. Each face now keeps its farthest outside point as points arrive; strictly greater keeps the first of equal distances, exactly what the ordered rescan chose, and both use the same distance function on the same values.
Coplanar merging also built each face group with `[...group, face]`, copying the list once per member; it now appends.
Fixed in `perf(geometry): keep each hull face's farthest outside point` (Batch 162 job 4).

Cause, parametric: every sample built `[x, y, z]` to run `every(Number.isFinite)` and then read the three coordinates again to copy them. It now reads each coordinate once into locals, checks them and copies them. Fixed in `perf(geometry): check parametric samples without a temporary array` (Batch 162 job 5). A surface function whose result has impure index getters is now read once per coordinate instead of twice; values and errors are otherwise unchanged.

| Case | Parent | Current |
|---|---:|---:|
| `convexGeometry`, 20,000 points in a ball: coordinate reads | 1,922,724 | 1,830,369 |
| `parametricGeometry`, 4 x 2 sphere: coordinate reads (75 samples) | 450 | 225 |
| temporary arrays per parametric sample | 1 | 0 |

The hull's remaining reads are the assignment of every point to its farthest face, the visibility walk and the new faces' planes; Barber, Dobkin and Huhdanpaa (1996) need all three. The p-geometry-misc Klein surface takes 5 samples per vertex, so its 16,641 vertices no longer allocate 83,205 temporary arrays.
The rounded box is unchanged. Trade-off: two numbers per hull face. This is an operation count, not a runtime or rival speed claim. Timing pending the quiet rerun.

Proof: `npm run build:packages`, then `node --test --test-timeout=120000 packages/geometry/tests/convex-workcount.test.js packages/geometry/tests/parametric-workcount.test.js`.
Both count assertions fail on the parent. Five hull digests (a ball, a sphere surface, a duplicated 5 x 5 x 5 grid with coplanar faces, equal-distance ties and an offset, anisotropic cloud) cover `convexGeometry` streams and `convexHullTriangles` indices; four parametric digests cover array, target and Float32Array results, poles and the scene's Klein bottle.

## Row 1.9: Euler conversion

Cause: `setFromEuler` evaluated `euler.x / 2` (and y, z) separately for sin and cos, and its eight triple products repeated four pair products (`sx * cy` in a and d, `cx * sy` in b and c, `cx * cy` in e and g, `sx * sy` in f and h). Each half angle is now read and halved once and each pair product formed once; the triple products keep their left-to-right grouping, so every bit of the result is unchanged. The six sin/cos calls stay.
Fixed in `perf(math): read Euler angles once and share pair products` (Batch 162 job 6).

| `setFromEuler` | Parent | Current |
|---|---:|---:|
| angle reads | 6 | 3 |
| multiplies | 16 | 12 |

Trade-off: +13 B gzip on `@margoengine/math/quaternion` and +17 B on `/affine` (size baseline recorded with the reason). This is an operation count, not a runtime or rival speed claim. Timing pending the quiet rerun.

Considered and not landed: `Matrix4.multiplyMatrices` reads the left matrix once per output column (64 reads), the right once (16) and copies a 16-element scratch. Reading all 32 inputs once and writing the 16 sums straight into `elements` is bit-identical (it was built and tested, aliasing and a Float32 view overlapping the destination included), but it needs the product fully unrolled: +128 B gzip on `/matrix4`, +369 B on `/affine` and +91 B on `/compat`. Fewer reads without a measured runtime gain do not justify bytes every Matrix4 user pays, so the parent loop stays; the quiet rerun decides whether the matrix product is a measured loss.

Proof: `npm run build:packages`, then `node --test --test-timeout=120000 packages/math/test/euler-workcount.test.js`. The read-count assertion fails on the parent (x, y and z read twice). Bit comparisons against the parent formula cover 2,011 angle triples in all six orders (signed zero, subnormal, plus and minus 1e300, infinity, NaN); every double compares byte for byte except NaN, whose payload ECMAScript leaves to the engine.
Research: Knoop, Ruething and Steffen, *Lazy Code Motion* (1992), [paper](https://rsim.cs.uiuc.edu/arch/qual_papers/compilers/knoop92.pdf), on removing partially redundant computations without changing evaluation results; Higham (1990), [level-3 BLAS stability](https://eprints.maths.manchester.ac.uk/365/), which rules out fast (Strassen-style) multiplication for the matrix product, so its dot products would keep their order.

## Research consulted

- Steve Marschner, Cornell CS4620, *Triangle meshes I* (2019), [course notes](https://www.cs.cornell.edu/courses/cs4620/2019fa/slides/04trimesh1.pdf): mesh parameterization and cylindrical coordinates.
- Ingo Wald, *On fast Construction of SAH-based Bounding Volume Hierarchies* (2007), [paper](https://publications.sci.utah.edu/publications/wald07/fastbuild.pdf): binned construction.
- Henri Ylitie, Tero Karras and Samuli Laine, *Efficient Incoherent Ray Traversal on GPUs Through Compressed Wide BVHs* (2017), [paper](https://research.nvidia.com/sites/default/files/publications/ylitie2017hpg-paper.pdf): traversal and memory traffic trade-offs.
- Alexander Majercik, Cyril Crassin, Peter Shirley and Morgan McGuire, *A Ray-Box Intersection Algorithm and Efficient Dynamic Voxel Rendering* (2018), [JCGT](https://jcgt.org/published/0007/03/04/): ray/box arithmetic.
- C. Bradford Barber, David P. Dobkin and Hannu Huhdanpaa, *The Quickhull Algorithm for Convex Hulls* (1996), [paper](https://www.cise.ufl.edu/~ungor/courses/fall06/papers/QuickHull.pdf): outside sets and hull facets.
- Matthias Teschner, Bruno Heidelberger, Matthias Mueller, Danat Pomeranets and Markus Gross, *Optimized Spatial Hashing for Collision Detection of Deformable Objects* (2003), [ETH record](https://www.research-collection.ethz.ch/entities/publication/f29bfb28-ee5f-4a7e-9905-f787e138bb81): hash buckets and exact candidate tests.
