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
- [ ] 1.2 Import into the modeler: STEP, SAT, Parasolid and JT B-reps read as modeler bodies, so every operation (and
      mass properties, checking, healing, export) works on imported parts, not only on shapes built in Margo.
      Written and on main for STEP (model.bodiesFromSTEP; SAT, XT and JT through their readers' B-reps). On 200 imported
      corpus parts Codex measured cuts valid on 84 (OpenCascade 200) and fillets on 4 (OpenCascade 67), 304 throws.
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
- [ ] 2.3 Parasolid transmit files before version 12.
- [ ] 2.4 ABC 10,000-model slice: 0 crashes, 0 open edges on valid solids, Euler-Poincare on every solid.

## Phase 3: freeform modeling

- [ ] 3.1 Booleans on spline surfaces: signed distance and projection, subdivision seeds, traced intersections.
- [ ] 3.2 Tangential contact inside faces, and coincident freeform patches.

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
