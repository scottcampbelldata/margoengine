# Where OpenCascade still leads, and testing to commercial grade (roadmap, to address later)

Noted 2026-10-17. Each item is where OpenCascade (OCCT) is still ahead of `@margoengine/brep`, with
where Margo stands today and what matching it would take. The goal is to match or beat OCCT on all of it.

## 1. Freeform NURBS-to-NURBS surface intersection

OCCT's biggest lead: 30 years of edge cases on arbitrary high-degree rational B-spline surfaces (marching, adaptive
subdivision, inflection points, singularities, high-order contact).

Margo today: Booleans intersect planes, cylinders, cones, spheres and tori exactly (closed forms for the analytic and
coaxial pairs, traced curves for the rest; `model/intersect.ts`, `model/march.ts`). Spline surfaces throw a RangeError.
Tangential contact inside both faces (two equal cylinders at right angles) throws; at a shared corner it is handled.

To match:
- signed distance and gradient for spline surfaces (closest-point projection with good seeds), so the tracer and
  the crossing search take them;
- seeds by subdivision with bounding boxes of both control nets (not iso-lines only), so small loops are not missed;
- singular points (tangent contact, branch points) located exactly and the branches through them traced;
- high-order contact and coincident freeform patches detected before marching.

## 2. Advanced blending

OCCT has variable-radius fillets along 3D curves, rolling-ball blends where the radius exceeds the adjoining face's
width (face-swallowing, setback corners), and G2/G3 (curvature-continuous) blend transitions.

Margo today: constant-radius fillets and chamfers on straight edges between planar faces, convex or concave, with
mitred corners where two blended edges meet and sphere corners where three meet at right angles (`model/blend.ts`;
the common case built in place, `model/setback.ts`, 0.4 ms for a box with every edge rounded against OpenCascade's
14.1 ms).
Circular edges (hole and boss rims) are next, then edges on curved faces.

To match:
- rolling-ball blends on any pair of faces: the spine as the intersection of the two offset surfaces (traced), the
  blend surface as a swept circle (a spline), contact curves on both faces;
- variable radius along the spine; chord-length and setback options;
- vertex blends for any number of edges and radii (n-sided patches), and setbacks;
- face swallowing: a blend wider than a neighbouring face removes that face and continues on the next;
- G2/G3 blends (curvature-continuous cross-sections) as an option.

## 3. Healing and defeaturing

OCCT's `ShapeFix` takes broken, non-manifold IGES/STEP from sketchy exporters and stitches, snaps or re-approximates
it into solid shells.

Margo today: the reader tolerates a lot (missing placements, seams, poles, older SAT/XT forms) and meshes what it can,
reporting failed faces; the corpus has 0 failed faces on the 44 original files. It does not repair topology.

To match:
- sewing faces into shells by matching edges within a tolerance; closing small gaps;
- re-fitting p-curves and edges that do not lie on their surfaces; removing slivers and tiny edges;
- making shells closed and consistently oriented, then solids; reporting what was changed;
- defeaturing: removing holes, fillets and chamfers by face selection (the inverse of the operations above).

## 4. Testing to commercial grade

Noted 2026-10-18. Users of a CAD kernel (CAD/CAM tools, robotics simulators, generative design, web
configurators) judge it by how it behaves at the boundaries and whether it ever crashes, not by benchmarks. Three
suites take Margo from measured-on-clean-files to that standard.

### A. Pathological public corpora

Margo today: the corpus is the 54 NIST/CAx-IF files (clean, structural): every parsed file at 0 failed faces and 0
open edges on solids, 43 matching OpenCascade's mesh. `validateBody` checks loops, edge use and that edges and vertices
lie on their curves and surfaces, but nothing checks topology globally and nothing stops a runaway operation.

To do:
- run a 10,000-model slice of the ABC Dataset (CAD models from Onshape, with real user defects: self-intersecting and
  degenerate faces, non-tangent seams, micro-edges, floating-point noise);
- gate every run on three counts: crash immunity (no unhandled exception and no hang, with a time limit on every
  Boolean and blend search), watertightness (0 open edges on every valid solid), and the Euler-Poincare check
  V - E + F - (L - F) - 2(S - G) = 0 (vertices, edges, faces, loops, shells, genus) on every solid read or made, so
  each is a valid 2-manifold.

### B. Perturbation and boundary fuzzing

Margo today: the fillet builder was compared with the Boolean construction on 5,286 straight-edge and 168 circle cases
(radii 0.25 to 3.5 mm on 5 to 20 mm parts, 2026-10-18): same solids, none lost. No sweeps to the limits, no jitter.

To do:
- sweep the operations benchmark's 66 cases over continuous ranges: fillet radius towards 0 (micro-radii) and towards
  the largest that fits (exactly where a blend swallows a face); coplanar face merges; near-tangent cylinder-plane and
  cylinder-cylinder contact;
- jitter input coordinates by 1e-7 to 1e-5 (files from different systems carry different tolerances: about 1e-6 in
  Parasolid, 1e-7 in ACIS); the kernel must reconcile disjoint edge tolerances without tearing shells.

### C. STEP round trips

Margo today: the validation runs check every exported test result in OpenCascade (BRepCheck, GProp, occt-import-js). The exporter
wrote closed curved faces without seam edges, which OpenCascade's mesher misread; fixed 2026-10-18 (below).

To do, the highest validation priority: import STEP, edit in Margo (blend, Boolean), export STEP, open the result in
Siemens NX, FreeCAD and SolidWorks, automatically (FreeCAD's command line for a start). Engineers reject a file one of
them flags for missing seam edges, inverted faces or unstitched sheets.

## Other work parked for later (not the kernel)

### Night Citadel is darker on the CAD branch

Found by the b1f5d2e validation (2026-10-18, `test-results/b1f5d2e-validation/browser/NIGHT-NUMBERS.md` in the
split worktree). Same fixed view, branch against main 1f7d19f: mean screen brightness is about 62% of main's on desktop
(26.7 against 43.1, 8-bit luminance) and 66% on the phone. The castle stone, island rock and sea read nearly black;
stars now show and the moon is brighter. Likely cause: the sky-lighting and display-curve commits of 2026-10-17 on
this branch (sky SH diffuse and split-sum reflections bae0bbd, sun and moon from the transmittance 5d646e0, PBR Neutral
display curve 56ee987). Decide whether to bring the moonlit stone back to main's readability (moon light strength or
the scene's exposure) while keeping the stars.

Related: the Night Citadel browser test expects phones at 2 device pixels per CSS pixel, but fb01fb1 (on main,
"cap phone pixels") made phones render at 1, so the test fails on main too. Restore 2x on phones or update the test.

### STEP export: OpenCascade misread faces on closed surfaces (fixed 2026-10-18)

Found by the b1f5d2e and 7243c0e validations. Three causes in `bodiesToSTEP`, all fixed in `model/seams.ts`:

- A face going round a cylinder, cone, sphere or torus (a sphere or torus less a hole, a cap over a pole) was bounded
  only by its own edges, and OpenCascade's mesher filled the wrong side. It is now cut open along the surface's seam by
  seam edges used once each way, ending on a sphere at a vertex on each pole the face covers; a sphere cap smaller
  than a hemisphere is written with the sphere's axis turned across it instead.
- An edge on a traced intersection loop (a closed B-spline) could run across the spline's start, which a reader that
  takes the spline as written cannot follow (032's GProp was -15.65 mm3). Such edges are now split there.
- GProp's default integration uses a fixed number of points per edge, whatever the edge's curve. 023 (torus less a
  tilted box) keeps one traced loop, written as one closed edge: 3,807.8 mm3 against Margo's 3,698.1 (+3%), its plane
  face 683.9 mm2 against 656.9. Not the spline's continuity or span count: the loop refitted as a C2 spline (simple
  knots) or with 19 to 301 spans still read 3,796 to 3,808, while the same spline cut into 2, 4 or 8 edges read 3,699.0
  each time (adaptive integration, relative error 1e-7: 3,699.0). B-spline edges are now written in pieces that turn
  half a turn at most, split at equal turns (023: 4 edges; 42 more edges over 20 of the 74 results). Quarter turns
  read as well but made occt-import-js 0.0.23's mesher cover part of a hole (030's sphere face +3% area) or fold
  (022's torus face), and splitting at equal lengths did too; OCP 8.0.1's mesher meshes those files like the old ones.

All 74 Boolean, blend and model test results, exported and read back: occt-import-js (1 um deflection, 0.05 rad) mesh
volume within 0.041% of Margo's and area within 0.014% (before: 010 -61%, 022 -40%, 026 -26%, 030 -14%, 031 +7.5%,
032 -126%, 033 -85%, 035 -76%, 036 -40%, and 024, 025, 027 off 0.5% to 2%). OpenCascade's GProp (default integration)
volume within 0.061% (078, a whole torus, where Margo's own mesh is 0.06% under) and area within 0.014%; 023 now
3,699.0 mm3 (+0.024%). BRepCheck finds all 74 valid. Our reader reads every export back to the same solids, volumes
within 0.018% of the old exports'.
