# Margo B-rep kernel: our own CAD reader (design)

Status, 2026-11-13: public engine package `@margoengine/brep` (Apache-2.0), the only CAD kernel the engine uses.
`@margoengine/cad-import` reads STEP, IGES, ACIS SAT, Parasolid XT and JT through it in a worker; no third-party CAD code or
WebAssembly importer is left. Clean room: written only from the published standards (ISO 10303-21 file syntax, ISO
10303-42 geometry and topology, the AP203/AP214/AP242 schemas, IGES 5.3, the published SAT, XT and JT format
references) and textbook geometry (NURBS evaluation, constrained Delaunay triangulation). No source of another CAD
kernel, three.js or Babylon.js is read. The tests check the kernel against exact closed forms and the files' own CAx-IF
validation properties, never against another kernel at test time.

## Why

| | The earlier third-party WebAssembly importer | `@margoengine/brep` |
| --- | --- | --- |
| Download | about 7.6 MB of Wasm (3.1 MB gzip) plus its JS glue | TypeScript, bundled into the cad worker |
| Threads | one Wasm thread | ordinary JavaScript in a worker |
| Memory | 32-bit Wasm heap (2-4 GB ceiling) | ordinary JS heap, typed arrays |
| Edges between faces | each face tessellated on its own | one discretization per edge, shared by both faces: no cracks |
| Normals | per-face mesh normals | exact surface normals, hard at every B-rep edge |
| Licence | LGPL-2.1 (source-offer obligations) | Apache-2.0, the engine's own |

## What real files contain (census of the 9 NIST STEP files in `test-results/cad-corpus/nist`)

Faces: 4,129 `ADVANCED_FACE` on `PLANE` 1,469, `CYLINDRICAL_SURFACE` 1,814, `CONICAL_SURFACE` 567,
`B_SPLINE_SURFACE_WITH_KNOTS` 251 (45 rational), `SPHERICAL_SURFACE` 78, `TOROIDAL_SURFACE` 56. Edges: 10,028
`EDGE_CURVE` on `LINE` 5,627, `CIRCLE` 3,735, `B_SPLINE_CURVE_WITH_KNOTS` 1,086, `ELLIPSE` 51; 10 `VERTEX_LOOP`
(cone apexes, sphere poles). No p-curves: boundaries must be projected onto their surfaces. Assemblies: 144
`NEXT_ASSEMBLY_USAGE_OCCURRENCE` with `ITEM_DEFINED_TRANSFORMATION`, 42 `MAPPED_ITEM`. Colours: 5,154 `STYLED_ITEM`.
Some files also carry AP242 tessellated geometry (2,296 `COMPLEX_TRIANGULATED_SURFACE_SET`), which can be read as is.

## Stages (each one commit series, tested before the next)

1. **Part 21 reader and product structure.** Streaming tokenizer (strings with `''` and `\X2\` escapes, reals with
   exponents, enumerations, `$`, `*`, typed parameters, complex instances), an entity table indexed by id, units (SI
   prefixes, inch/degree conversion units, length and plane-angle), the product tree (`PRODUCT_DEFINITION`,
   `NEXT_ASSEMBLY_USAGE_OCCURRENCE`, `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`, `ITEM_DEFINED_TRANSFORMATION`,
   `MAPPED_ITEM`), shape representations and their B-rep bodies, and colours (`STYLED_ITEM` down to `COLOUR_RGB` or
   a pre-defined colour). Output: parts, instances with world matrices, colours, face/edge counts. Errors name the
   entity id and what is unsupported.
2. **Exact geometry.** Placements; curves (line, circle, ellipse, B-spline and rational B-spline with derivatives);
   surfaces (plane, cylinder, cone, sphere, torus, B-spline and rational B-spline with first derivatives). Point
   inversion (3D point to surface u, v): closed form for the analytic surfaces, Newton iteration seeded from a coarse
   grid for B-splines.
3. **Edges.** Each `EDGE_CURVE` discretized once between its vertices by chord height (linear deflection) and angle
   (angular deflection); both faces that share it use the same points.
4. **Faces.** Boundary loops mapped into each surface's (u, v) space (periodic surfaces unwrapped across their seam,
   poles and apexes handled), a constrained Delaunay triangulation of the trimmed domain, interior points added until
   every triangle meets the deflection, normals from the exact surface (flipped by `same_sense`). Planes need no
   interior points. Work is split by face across workers.
5. **Integration.** `parseCADAsync` and `loadCAD` in `@margoengine/cad-import` read every B-rep format through the
   kernel in a worker: each placed body is meshed once, every placement is a transform on that mesh, and a body with
   several face colours becomes one mesh per colour.
6. **More formats.** IGES 5.3, ACIS SAT, Parasolid XT and JT (ISO 14306) are converted to STEP entities and read and
   meshed by the same geometry and tessellator.

## Feature parity with the common CAD kernels

The rule (2026-10-17): match what the widely used CAD kernels can do, learned from their public documentation and
feature lists, never from their source. The list below is the target as written on 2026-10-17; the package README
is the current account of what the kernel reads.

| Kernel capability (documented) | Margo |
| --- | --- |
| STEP AP203, AP214, AP242 reading | written (stage 1) |
| Assembly structure, instance placements, names, part numbers | written (stage 1) |
| Length and plane-angle units, SI prefixes, conversion-based units | written (stage 1) |
| Colours on solids and faces, overriding styles, transparency | written (stage 1) |
| Analytic and NURBS curves and surfaces, offset, revolution, extrusion | written (stage 2) |
| Mesher: linear deflection, absolute or relative to the part size | written (stage 4) |
| Mesher: angular deflection; separate interior deflection and angle | written (stage 4) |
| Mesher: minimum size; checking deflection inside triangles, not only on edges | written (stage 4) |
| Mesher: shared edge discretization (no cracks between faces) | written (stage 3) |
| Mesher: faces in parallel | stage 5 (workers) |
| AP242 tessellated geometry read as is | listed in stage 1; meshing it is stage 5 |
| Layers, validation properties (volume, area, centroid), saved views | to do |
| AP242 PMI (dimensions and tolerances), materials and density | to do |
| Per-instance style overrides (SHUO) | to do |
| Shape healing on read (small edges, wire order, tolerances) | to do; failures are listed per face today |
| IGES reading | stage 6 |
| STEP writing | to do |
| Boolean operations, fillets and chamfers (modelling) | written (`model`, in the package) |
| Cone and frustum, sewing, face offset, shell and draft, sweep along lines and arcs, ruled loft (modelling) | written (`model`, in the package); limits in `docs/limits.md` |

Package: `@margoengine/brep` (optional; never core or the stage). Its known defects are in `docs/known-bugs.md`; the JT
reader's licence terms are in `docs/jt-licensing.md` and its departures from the published texts in `docs/jt-reader.md`.
