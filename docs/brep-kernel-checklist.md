# CAD kernel checklist

Goal (Scott, 2026-10-18): `@margoengine/brep` replaces OpenCascade: everything it does, done better and faster, tested,
with no known bugs. Worked top to bottom; each phase leans on the ones before it. Where OpenCascade leads and why is in
[brep-occt-gaps.md](brep-occt-gaps.md); this file is the order of work and its state.

Every item is done only when all of these hold:
- built clean-room in `packages/brep`, with synthetic tests that pin it down;
- validated by Codex: the CAD corpus with no regressions, OpenCascade comparisons where it has the feature, hygiene
  gates met, `check:merge` passing;
- faster than OpenCascade on the same inputs, wherever OpenCascade has the operation (the operations benchmark grows
  with each new operation);
- documented in [brep-modeling.md](brep-modeling.md) with measured numbers.

## Phase 0: land current work

- [x] Integration branch (real JT 9.5 and JT 10 meshes, MultiXT, torus bands, tolerant edges, STEP seam edges, smooth
      traced curves): Codex validation, then push. Codex's check:merge passed at dc5d3f50 (2,709/2,709, proofs 15/15,
      visuals 55/55, brep 81/81); landed on main 2026-10-20 with 1.1-1.3 below.

## Phase 1: measuring sticks (every later item is checked with these)

- [ ] 1.1 Exact mass properties: volume, area, centroid and inertia integrated over the B-rep's faces, not its mesh;
      matching closed forms and OpenCascade's GProp on the corpus and every operation result.
      Written and on main (model.massProperties). Codex's interim comparison (dc5d3f50, paused 2026-10-19) found: a
      negative signed volume on an imported body (Jubilee body 48), round trips that double it (CirPattern bodies 10,
      12, 14, 17), pole/apex errors on cone and sphere apex faces (Jubilee 70 and 90, Radial Engine JT part 10), up to
      4.7e-5 relative from GProp on the model tests. Fix these first.
      Fixed 2026-10-20 (claude/kernel-fixes), measured against a fine mesh, not GProp: the round trips (a seam cut
      through an equator vertex), the negative and 17x volumes (projections onto helical thread surfaces and their
      edges settling on the next turn), and the pole/apex throws (loops through an apex or a collapsed spline row now
      run along its line). Jubilee: 30 bodies threw, now none; every volume within 0.17% of the mesh (its own chord
      error). Left: Codex's GProp comparison again, Radial Engine JT part 10, and the 4.7e-5 on the model tests.
- [ ] 1.2 Import into the modeler: STEP, SAT, Parasolid and JT B-reps read as modeler bodies, so every operation (and
      mass properties, checking, healing, export) works on imported parts, not only on shapes built in Margo.
      Written and on main for STEP (model.bodiesFromSTEP; SAT, XT and JT through their readers' B-reps). On 200 imported
      corpus parts Codex measured cuts valid on 84 (OpenCascade 200) and fillets on 4 (OpenCascade 67), 304 throws.
      Claude's drill check (2026-10-20, a hole through the middle of each Jubilee solid): 78 of 145 valid after the
      mass and apex fixes; of the 67 failures 62 are spline faces (3.1), 2 tangential contacts (3.2), 2 results with an
      edge off its surface, 1 a probe sizing slip. Imported cones (a face covering or running through its apex) now cut.
      Later the same day (spline Booleans and tolerant edges, below): 127 of 145; then 144 of 145 after fixing curve
      crossings with every sheet of a spline, traces seeded on or past a spline's edge, and sampling of long rational
      curves (the drill now sized from the mesh). Left: Jubilee 104, where the mesh-sized drill is within 0.34 nm
      of grazing a 3 mm rib (near contact, 3.2); drilled at exactly 1.5 mm it now cuts.
- [ ] 1.3 Topology checker: Euler-Poincare (V - E + F - (L - F) - 2(S - G) = 0), every edge used twice and oppositely in
      a solid, consistent orientation, no face crossing another; run on every file read and every operation result.
      Written (claude/kernel): validateBody (Euler-Poincare, one piece per shell) on every operation and import;
      checkBody (orientation by enclosed volume, crossing edges of a face, edges through faces); extrude and revolve
      refuse self-touching profiles. Left: two faces crossing in a closed curve that meets no edge of either.
- [ ] 1.4 Crash immunity: every operation bounded (time and iteration limits on intersection, tracing and blend
      searches); every failure a typed error naming the cause; no unhandled exception on any input.
- [ ] 1.5 Harnesses: an ABC Dataset slice runner, a sweep-and-jitter fuzzer for every operation, and a STEP round trip
      runner (OpenCascade reader and mesher, then FreeCAD's command line).

## Phase 2: read everything

- [ ] 2.1 IGES reader (trimmed and bounded surfaces, B-splines, analytic surfaces, colours, assemblies), so the viewer
      no longer needs OpenCascade for any format.
- [ ] 2.2 Healing: sew faces into shells within tolerance, close small gaps, refit curves that leave their surfaces,
      fix orientation, remove slivers and tiny edges; report every change.
      Started 2026-10-20: imported edges keep their measured gap to their faces as tolerance (up to 10 micrometres or
      1e-4 of the part); Jubilee's 469 such edges no longer count as problems.
- [ ] 2.3 Parasolid transmit files before version 12.
- [ ] 2.4 ABC 10,000-model slice: 0 crashes, 0 open edges on valid solids, Euler-Poincare on every solid.

## Phase 3: freeform modeling

- [ ] 3.1 Booleans on spline surfaces: signed distance and projection, subdivision seeds, traced intersections.
      Written 2026-10-20 (claude/kernel-speed): signed distance by projection, seeds along iso lines, curves ended
      exactly at the spline's domain edge; a bicubic block cut by holes, a box and another spline block matches exact
      integrals within 1e-7 (1e-6 spline on spline); Jubilee drills pass on 144 of 145 solids (78 before). Left:
      Codex's corpus check and OpenCascade comparison, speed against OpenCascade.
- [ ] 3.2 Tangential contact inside faces, and coincident freeform patches.
      Written 2026-10-20 (claude/kernel-speed), exact contact: surfaces touching at a point (two equal cylinders
      crossed, a slanted hole touching a drill wall from inside) get a vertex at every pass of each curve through it and
      every edge through it is cut there; traced pieces keep only their own stretch of a curve that crosses itself.
      Surfaces touching along a line (a drill as wide as a rib grazing its walls) cut neither face along it; the line
      ends where either face's edges cross it. Where the result's surface touches itself, its sheets meet without
      sharing a vertex or edge there (a pinch vertex becomes one per fan). Tested against closed forms: the Steinmetz
      solid (union, intersect, subtract), the tangent hole in three seam directions, a 3 mm drill through a 3 mm rib
      alone and on a base (all three operations, two seam directions, within 1e-9). Jubilee 104 drilled at exactly
      1.5 mm (its 3 mm rib) cuts in all three operations; its common part matches an independent integral over the
      drill's section (203.2639 mm3 both). Left: near contact. The survey's drill, sized from the 32-bit mesh, misses
      one rib wall by 0.34 nm and dips 0.28 nm into the other; there the drill's curves with the wall's 0.5 mm round
      pass about 1 um apart instead of crossing, the tracer steps from one to the other, and the Boolean refuses
      (an error, not a wrong result). Needs: the tracer to walk through a near touch as it does an exact one. Also
      left: tangency along a circle or a traced curve, and coincident freeform patches.

## Phase 4: blends

- [ ] 4.1 Rolling-ball fillets on any two faces (curved faces, traced edges), with spline blend surfaces.
- [ ] 4.2 Corners where several blends meet (vertex blends) and setbacks.
- [ ] 4.3 Variable radius; chamfers by two distances or distance and angle.
- [ ] 4.4 Face swallowing: a blend wider than its neighbouring face.
- [ ] 4.5 Curvature-continuous (G2) blends as an option.

## Phase 5: the rest of OpenCascade's modeling operations

- [ ] 5.1 Sweep along a path.
- [ ] 5.2 Loft through sections.
- [ ] 5.3 Shell (hollow a solid) and thicken a sheet.
- [ ] 5.4 Offset surfaces and solids.
- [ ] 5.5 Draft angles.

## Phase 6: commercial-grade proof

- [ ] 6.1 Fuzz every operation to its limits, with 1e-7 to 1e-5 coordinate jitter.
- [ ] 6.2 STEP round trips: automated through FreeCAD; NX and SolidWorks where licences allow.
- [ ] 6.3 Every operation faster than OpenCascade on the benchmark; numbers published.
