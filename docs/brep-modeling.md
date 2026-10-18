# Margo B-rep kernel: modeling (plan)

Status, 2026-10-17: plan only. The kernel reads and meshes STEP, ACIS SAT and Parasolid XT (`docs/brep-kernel.md`); it
does not edit shapes yet. Goal (Scott, 2026-10-17): beat OpenCascade on web speed, desktop speed and modeling
features. Clean room as before: published standards, textbooks and papers only; OpenCascade stays a measured reference.

## Where we stand (measured 2026-10-17, this PC)

| | Margo (`@margoengine/brep`) | OpenCascade |
| --- | --- | --- |
| Read + mesh, 44 corpus STEP files, 0.001 of the model diagonal, 0.5 rad | 9.2 s, one JS thread (Node) | 27.0 s native C++ one thread; 24.1 s parallel mesh |
| Files faster | 42 of 44 | 2 of 44 (FTC11: we make about 3x the triangles on a 0.1 mm torus) |
| Browser download | 25,474 B gzip worker | 7,604,031 B Wasm (occt-import-js) |
| Formats without paid add-ons | STEP, SAT, Parasolid XT, DXF (loaders) | STEP, IGES |
| Self-check | file's own volume, area, centre: 16 of 16 match | none |
| Modeling | none yet | Booleans, fillets, offsets, healing, ... |

## Design choices (where OpenCascade is weakest)

- **Tolerances:** every vertex and edge carries its own tolerance, set by the operation that made it and checked by
  `validate` after every operation; no global fuzzy value. Predicates that decide topology (orientation, in/out, order
  along a curve) are exact (Shewchuk adaptive predicates, already used by the triangulator) or interval-filtered.
- **Topological naming:** every face, edge and vertex has a persistent id: the operation that created it and the
  generating entities (a face from an extrude of sketch edge e3 keeps that name through later edits). Each operation
  records generated, modified and deleted ids; queries resolve a stored reference through the history.
- **Parallel by default:** intersections and meshing per face pair or per face in workers; nothing global to lock.
- **Web first, desktop too:** TypeScript with typed arrays (the same code in workers and Node); hot paths kept free of
  allocation (NURBS evaluation took 3x less time once it stopped allocating). A Rust/Wasm port of hot loops only where
  measurement shows JS is the limit.

## Stages (each one commit series, tested by Codex before the next)

1. **Topology core.** A mutable half-edge B-rep (bodies, shells, faces, loops, coedges, edges, vertices) built from
   the readers' STEP model; Euler operators (make/kill edge-vertex, edge-face, loop); `validate` (closed, oriented,
   manifold, geometry on topology within tolerance); persistent ids and the history log; STEP export through the
   existing writer.
2. **Construction.** Box, cylinder, cone, sphere, torus; extrude and revolve of planar sketch profiles (lines, arcs,
   splines); sweep along a path later. Each tested by volume and area against closed forms and by STEP round trip.
3. **Intersections.** Curve/surface and surface/surface: exact for plane with plane and quadrics (lines and conics),
   quadric pairs by their known cases, and spline pairs by subdivision with bounding boxes, then marching with step
   control and exact endpoint resolution. Coincident and tangent cases detected before marching, not by tolerance.
4. **Booleans.** Union, subtract, intersect: split faces by the intersection curves (the triangulator's constrained
   (u,v) domains already handle the splitting), classify fragments by exact point-in-solid, merge coplanar and
   cosurface faces, keep non-manifold results as general bodies instead of failing.
5. **Local operations.** Fillets and chamfers (constant, then variable radius; the rolling-ball construction from the
   Parasolid reader is the start), shell and thicken (offset surfaces with self-intersection removal), draft.
6. **Healing.** Sewing open shells, closing gaps within a tolerance, removing slivers and tiny edges, re-fitting bad
   p-curves: needed for real imported files before Booleans on them.
7. **Benchmarks against OpenCascade** at each stage: the same operations on the same inputs, time, success rate and
   validity of results (scripts/brep-occt-native.py grows an operations mode).
