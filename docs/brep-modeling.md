# Margo B-rep kernel: modeling (plan)

Status, 2026-10-17: stages 1 and 2 done (topology, primitives, extrude, names, STEP export); stage 4 has a first cut
(Booleans in general position, below). The kernel reads and meshes STEP, ACIS SAT and Parasolid XT
(`docs/brep-kernel.md`). Goal (Scott, 2026-10-17): beat OpenCascade on web speed, desktop speed and modeling
features. Clean room as before: published standards, textbooks and papers only; OpenCascade stays a measured reference.

## Where we stand (measured 2026-10-17, this PC)

| | Margo (`@margoengine/brep`) | OpenCascade |
| --- | --- | --- |
| Read + mesh, 44 corpus STEP files, 0.001 of the model diagonal, 0.5 rad | 9.2 s, one JS thread (Node) | 27.0 s native C++ one thread; 24.1 s parallel mesh |
| Files faster | 42 of 44 | 2 of 44 (FTC11: we make about 3x the triangles on a 0.1 mm torus) |
| Browser download | 40,030 B gzip worker (114,562 B raw; measured at 2469a93, the modeler is not in it) | 7,604,031 B Wasm (occt-import-js) |
| Formats without paid add-ons | STEP, SAT, Parasolid XT, JT 9.5+ (structure and XT B-rep), DXF (loaders) | STEP, IGES |
| Self-check | file's own volume, area, centre: 16 of 16 match | none |
| Modeling | primitives, extrude, revolve; Booleans on planes, cylinders, cones, spheres and tori (any position, faces on one plane, edges along edges); fillets and chamfers on straight edges and full circles | Booleans on any surface, variable fillets, offsets, healing, ... (docs/brep-occt-gaps.md) |

Where OpenCascade still leads (freeform NURBS intersections, advanced blends, healing) and what matching it takes:
`docs/brep-occt-gaps.md`.

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

## Booleans: first cut (2026-10-17)

`boolean(name, 'union' | 'subtract' | 'intersect', a, b, { history })` in `packages/brep/src/model/boolean.ts`:

- Every edge is crossed with the other solid's faces (`curveSurfaceCrossings`: intervals split until the distance at
  their ends proves no crossing, or narrower than 1e-9 of the curve, so close pairs of crossings are not missed); every
  face pair is intersected exactly (`intersectSurfaces`: plane with plane, cylinder, sphere, cone at right angles;
  parallel cylinders); the curves are kept where they lie inside both faces.
- Faces are split by tracing regions in 3D (sharpest left turn about the face normal at each vertex), so seams and
  periodic surfaces need no special cases; loops are grouped into faces by which side of every loop a point inside
  each lies (signed crossings in (u, v), which also handles loops round a cylinder or a sphere's pole axis).
- Pieces are classified by rays against the other solid's exact faces (three directions, majority); `orient3d` is
  exact (Shewchuk). The result is checked by `validateBody`; a cavity becomes a second shell, written as
  `BREP_WITH_VOIDS`.
- Names: faces and edges that come through keep theirs; a split continues as `<name>#k` (history `modified`);
  intersection edges are `generated` from their two faces; `History.resolve` follows what a name became and
  `History.generatedFrom` what was made from it.
- Measured (tests/boolean.test.js, volume and area against closed forms within 0.1%, 0 open edges): box with box
  (all three operations), through hole, boss, spherical pocket, two holes in a row, sphere cap and remainder, cavity;
  2 to 13 ms each in Node.
- Not yet (each throws a RangeError that says so): faces on one surface that overlap (coplanar boxes), tangent
  contact, curves through a pole, surface pairs beyond the list above (cylinder with cylinder at an angle, sphere with
  cylinder, anything with a torus or spline). Next: the general quadric pairs and spline pairs by marching, then
  coincident faces.
- Mesher fixes it needed: a face that is a closed surface less its holes (a sphere less a cap), oriented shells and
  faces (`ORIENTED_CLOSED_SHELL .F.` of a void now turns its faces), and columns of interior points on curved faces with
  holes (a cylinder wall with a hole made up to 6x the triangles it needed).

## Booleans, fillets and chamfers: second cut (2026-10-17, 511d19d)

- Any pair of analytic surfaces: coaxial pairs meet in exact circles; every other pair (cylinders at an angle, a
  sphere off a cylinder's axis, planes across cones and tori) is traced in the face pair's box (`model/march.ts`) and
  stored as a cubic spline. Tori are cut open round the tube for face splitting. Curves crossing at a shared corner
  get a vertex there; tangential contact inside both faces still throws.
- Contacts within 1e-6 of the model: faces on one surface, edges along edges, vertices on edges and faces. The
  result's faces left on one surface and edges split along one curve are joined (two boxes side by side: 8 V, 12 E,
  6 F). Tested: nine flush/stacked/coplanar cases, six curved pairs (union = A + B - intersect, intersect + subtract
  = A within 0.1% of exact volumes).
- `model.fillet` / `model.chamfer`: straight edges between planes (convex, concave, any angle; mitred where two meet,
  a sphere where three meet at right angles: a rounded box matches its closed form to 0.002%) and full circles
  between a plane and a coaxial cylinder (hole rims, boss tops, boss junctions; Pappus volumes to 0.001%). Where every
  end of a blended straight edge is a corner of three planar faces (running out through a face square to it, a
  mirror-image mitre, or a ball corner), and for full circles where a plane meets a coaxial cylinder, the faces are set
  back and the blend faces put in place (`model/setback.ts`); otherwise each blend is a solid the Booleans subtract or
  add. Against OpenCascade on the operations benchmark (Codex's harness, best of 3 cold calls): Margo faster in 50 of
  66 cases at 7243c0e; at 0b17142 in 67 of 67 against that run's paired OpenCascade times, and in 65 of 66 against the
  7243c0e and b1f5d2e OpenCascade times (the boss-on-plate fillet: 0.457 ms against 0.452 and 0.446 ms). Sub-millisecond
  cases vary by 20 to 60% from run to run. The box with all 12 edges rounded (radius 2 of 10)
  takes 0.4 ms in Node (best of 5; 4.4 to 4.6 ms for a fresh process's first call); OpenCascade's
  BRepFilletAPI_MakeFillet took 14.1 ms on it (Codex, b1f5d2e step 9), and the Booleans 2,691 ms before ca361d2.
- `model.revolve`: lines and arcs round an axis (planes, cylinders, cones, tori, spheres).
- `model.massProperties`: exact volume, area, centroid and inertia from the faces (divergence theorem, Green's
  theorem over each trimmed face, Gauss-Legendre), not a mesh: box, cylinder, sphere, torus, a cone ring, a
  hemisphere over its pole, a holed block and the rounded box match their closed forms to 1e-9 (1e-8 for the hemisphere).
- Next: blends on curved faces and along traced edges, setbacks and variable radius, freeform (spline) Booleans,
  healing (docs/brep-occt-gaps.md); the operations benchmark against OpenCascade (Codex prompt 511d19d, step 9).
