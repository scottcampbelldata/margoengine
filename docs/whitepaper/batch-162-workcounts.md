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

## Research consulted

- Steve Marschner, Cornell CS4620, *Triangle meshes I* (2019), [course notes](https://www.cs.cornell.edu/courses/cs4620/2019fa/slides/04trimesh1.pdf): mesh parameterization and cylindrical coordinates.
- Ingo Wald, *On fast Construction of SAH-based Bounding Volume Hierarchies* (2007), [paper](https://publications.sci.utah.edu/publications/wald07/fastbuild.pdf): binned construction.
- Henri Ylitie, Tero Karras and Samuli Laine, *Efficient Incoherent Ray Traversal on GPUs Through Compressed Wide BVHs* (2017), [paper](https://research.nvidia.com/sites/default/files/publications/ylitie2017hpg-paper.pdf): traversal and memory traffic trade-offs.
- Alexander Majercik, Cyril Crassin, Peter Shirley and Morgan McGuire, *A Ray-Box Intersection Algorithm and Efficient Dynamic Voxel Rendering* (2018), [JCGT](https://jcgt.org/published/0007/03/04/): ray/box arithmetic.
- C. Bradford Barber, David P. Dobkin and Hannu Huhdanpaa, *The Quickhull Algorithm for Convex Hulls* (1996), [paper](https://www.cise.ufl.edu/~ungor/courses/fall06/papers/QuickHull.pdf): outside sets and hull facets.
- Matthias Teschner, Bruno Heidelberger, Matthias Mueller, Danat Pomeranets and Markus Gross, *Optimized Spatial Hashing for Collision Detection of Deformable Objects* (2003), [ETH record](https://www.research-collection.ethz.ch/entities/publication/f29bfb28-ee5f-4a7e-9905-f787e138bb81): hash buckets and exact candidate tests.
