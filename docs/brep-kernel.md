# Margo B-rep kernel: our own STEP reader (design)

Status: design, 2026-10-17. Replaces OpenCascade (`occt-import-js`) for STEP, then IGES. Clean room: written only from
the published standards (ISO 10303-21 file syntax, ISO 10303-42 geometry and topology, the AP203/AP214/AP242 schemas)
and textbook geometry (NURBS evaluation, constrained Delaunay triangulation). No OpenCascade, three.js or Babylon.js
source is read. OpenCascade stays only as a test oracle (dev dependency) until our reader passes the corpus, then it is
removed.

## Why

| | OpenCascade today (`occt-import-js` 0.0.23) | Goal for `@margoengine/brep` |
| --- | --- | --- |
| Download | 7,604,031 B Wasm (3,110,912 gzip, 2,315,009 brotli) + 96,871 B JS | tens of kB of JavaScript |
| Threads | one Wasm thread | faces split across workers (every CPU core) |
| Memory | 32-bit Wasm heap (2-4 GB ceiling) | ordinary JS heap, typed arrays, streaming |
| Edges between faces | each face tessellated on its own | one discretization per edge, shared by both faces: no cracks |
| Normals | per-face mesh normals | exact surface normals, hard at every B-rep edge |
| Licence | LGPL-2.1 (source-offer obligations) | ours |

## What real files contain (census of the 9 NIST STEP files in `test-results/cad-corpus/nist`)

Faces: 4,129 `ADVANCED_FACE` on `PLANE` 1,469, `CYLINDRICAL_SURFACE` 1,814, `CONICAL_SURFACE` 567,
`B_SPLINE_SURFACE_WITH_KNOTS` 251 (45 rational), `SPHERICAL_SURFACE` 78, `TOROIDAL_SURFACE` 56. Edges: 10,028
`EDGE_CURVE` on `LINE` 5,627, `CIRCLE` 3,735, `B_SPLINE_CURVE_WITH_KNOTS` 1,086, `ELLIPSE` 51; 10 `VERTEX_LOOP`
(cone apexes, sphere poles). No p-curves: boundaries must be projected onto their surfaces. Assemblies: 144
`NEXT_ASSEMBLY_USAGE_OCCURRENCE` with `ITEM_DEFINED_TRANSFORMATION`, 42 `MAPPED_ITEM`. Colours: 5,154 `STYLED_ITEM`.
Some files also carry AP242 tessellated geometry (2,296 `COMPLEX_TRIANGULATED_SURFACE_SET`), which can be read as is.

## Stages (each one commit series, tested by Codex before the next)

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
5. **Integration.** `parseCADAsync`/`loadCAD` in `@margoengine/machinery` and `margo-convert` gain the new reader
   (option first, then default). The corpus runner compares it with OpenCascade per file: triangle count, surface
   area, enclosed volume, bounds, and largest distance between the two meshes; plus load time and memory.
6. **Switch and remove.** Default to our reader once every corpus file matches; then an IGES reader on the same
   geometry and tessellator (entities 100-144, 186, 502-514); then OpenCascade is removed from the dependencies and
   the LGPL notices go.

Package: `@margoengine/brep` (optional; never core or the stage). Not in scope for the first version: repairing
broken files, offset and swept surfaces beyond revolution and extrusion, Boolean operations, PMI display.

Order (Scott, 2026-10-17): the demo packages come first; this work starts after them.
