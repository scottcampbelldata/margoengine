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
      Imported edges off their faces, fixed 2026-10-20 (claude/affectionate-satoshi-c47109): each face's integral along
      its loops took an edge's rates in (u', v) from its tangent, which round a curved face moves faster or slower than
      the edge's foot when the edge lies a little off the face (within its tolerance), and a vertex off its edges left
      the loop open there; either way a face's integrals depended on where its inner integral starts (v*), so pieces of
      a face did not add up to the face. The rates are now the foot's (the offset against the surface's second
      derivatives, from one step of its first), and every loop is closed straight in (u', v) at each corner. Jubilee body
      121 (a standoff whose thread crest is 35 half-turn faces, edges 0.2-0.9 um off it, one line 12.6 nm off its
      vertex), drilled by the survey: the drill misses it, the Boolean joins the crest into one face, and subtract +
      intersect - part was 2.0e-5 of the part; now 1.8e-14. A hand-built cylinder with the same two faults matches pi
      r^2 h within 1e-12 however its side is split (8.6e-6 before). All 145 drilled bodies, moments about one point per
      body: subtract + intersect - part over 1e-9 on none (worst 6.7e-10; main: 32, worst 2.0e-5). Drill survey 145 of
      145 as on main (46 s both); 106 drilled volumes moved, 25 by more than 1e-6 (at most 1.75e-5, body 121), and 61
      imported volumes, 25 by more than 1e-6 (at most 1.1e-5), all on bodies with tolerant edges; mass of all 145
      solids as fast as before (32 s). Left then (both done below): where an edge lies off both its faces their
      boundaries part, so an imported shell does not quite close and its volume moves with the point moments are taken
      about (body 142: 1.2e-5 per mm, as on main); lines and conics on spline faces take one Gauss piece, and no piece is
      split where an edge's foot crosses the surface's knots, so a spline face's integrals still depend on v* (body
      142's volume moves 1.9e-5 with it, 15 other bodies by 1e-9 to 1.3e-8).
      Spline faces' v* fixed 2026-10-20 (claude/zealous-bouman-290363): on a spline face an edge's rates now integrate
      to the change of (u', v) between its ends. Each Gauss piece is cut where the edge's foot crosses a knot line
      (found by regula falsi), where the derivatives kink; the foot of an edge running a little past the surface's edge
      is held on it as the projection holds it, moving along it only, and the piece is cut where it gets there; and a
      part whose nodes still miss the exact integrals of z^k dz (k = 0, 1, 2, z each coordinate) by over 1e-12 of the
      face is halved while that helps (a span where the foot's speed changes sixfold). Analytic faces are as before, bit
      for bit. Body 142, face #381175: lines #330740 and #442299 missed their change of u' by 1.5e-4 and 3.4e-5 of the
      face box, now 1.8e-11 and 9e-14; every edge of body 142's spline faces under 5.4e-10 (was up to 1.5e-4). Moving v*
      to the top of every face moves no Jubilee body's volume by more than 2.0e-11 (body 142; 3 over 1e-12) and no area
      by more than 1.4e-11 (base: 16 bodies over 1e-9, worst 1.9e-5; area 1.1e-5). New test: a wedge whose slanted face
      is a plane as a cubic-by-linear spline, its long edges lines across five knot spans with the foot's speed changing
      fifteenfold in a span, matches its closed-form area and centroid to 2.7e-13 (base: area 1.4e-2 off). Drill survey
      145 of 145 as on base; drilled volumes moved on 40 bodies, 18 by over 1e-9, two by over 1e-7: body 142 (1.6e-5)
      and body 60 (9.8e-7: its Cut-Revolve1 spline faces run along the surface's edge 0.18 um past it, and the old
      unheld rates gave that edge a v-rate in the across integral; each face's area moved 2.6e-5, now equal to an
      independent integration in the other order to 1e-13). Mass of all 145 solids as fast as on main (6 runs each,
      alternating processes on a busy machine: median 51.2 s, main 51.6 s); 0.8% more nodes. brep tests 104/104.
      Imported shells closed, 2026-10-20 (claude/keen-burnell-9bd60b): an edge lying off both its faces has a different
      foot on each, so the faces parted along it, the integral of n dA over the shell was not zero and the volume moved
      with the point moments are taken about (main: 49 of Jubilee's 145 solids over 1e-10 of their area, worst 1.4e-5 on
      body 63; volume per mm of that point over 1e-9 on 47, worst 1.9e-5). Each face now also takes the ruled strip from
      its edges' feet out to the edges themselves (in volume and moments, not area), so an edge's two faces meet on the
      edge; and on a cone the foot's v follows the edge's height (the cone's projection keeps it), not the nearest
      point's. The branch cut spline faces' Gauss pieces at knot lines and domain ends its own way; joined with the v*
      fix above (2026-10-21) those cuts are pieceNodes', with each node adding its strip. Measured on the branch alone
      first. Jubilee: n dA under 1e-10 of the area on 144 of 145 solids, and volume per mm of the reference point under
      1e-9 on all 145 (worst 1.5e-10). Body 103 reads
      1.6e-9: four spline faces whose edges run along the surface's first and last rows, 0.1-0.3 um off, their feet
      coming to and leaving the domain's end 15 and 32 times along an edge, each a kink inside a Gauss piece (its volume
      moves 1.5e-10 per mm). Volume moved by v* over 1e-9 on body 142 only (5.7e-9; main 16 bodies, 142 by 1.9e-5).
      Subtract + intersect - part of the drill survey, each body's moments about its own point: none over 1e-9 (worst
      -4.6e-11, body 142; main 24, worst -1.3e-6). A hand-built box whose top edges sit 0.1 um off both their faces
      matches its closed form (abc less the slivers the strips enclose) within 4e-16, and its volume beside a far cube
      within 7e-16 (main: 1.2e-5 and 1.3e-5). Drill survey 145 of 145 (48.6 s both). Volumes against main: 31 of 145
      imported solids moved by more than 1e-6, 20 by more than 1e-5 (drilled: 31 and 21), all with tolerant edges; the
      largest, body 47 (-1.5e-4), is a revolved part whose cone faces' feet keep the edge's height and sit up to 1.8 um
      from it all round the axis: a ring of slits whose n dA cancels but whose volume does not. Closed, its volume is the
      same within 6e-8 whether a cone's feet keep the height or lie nearest (open, 2.3e-4 apart). Mass of all 145
      solids: 4.5% more surface points in the inner integrals than main; a build with 3.9% more ran 32.9 s against
      main's 32.8 s (median of 5 rounds, two passes each, quiet machine); this one not timed cleanly (the machine was
      busy: rounds alternating with main's read 0.83 to 1.37 of them). Left: a clean timing of it; body
      103's feet flipping at the domain's end (catching every flip means sampling every edge along a spline's end rows,
      too slow); a spline's projection stuck at a corner of its domain when both parameters run past it (Jubilee 128: 4e-7
      of u at one vertex; the cuts absorb it here, but surfaces.ts should move each parameter alone there).
      OpenCascade, from its reference manual only (not run): BRepGProp needs a shape with no free boundary and does not
      check it; BRepGProp_Face takes each face's boundary from the edge's P-curve on that face, so a tolerant shell parts
      along its edges as Margo's did; GProp_GProps advises putting its reference point near the shape, for accuracy.
      Codex can measure whether GProp's volume of body 142 moves with that point.
      Joined on main (2026-10-21, both fixes and the strips at pieceNodes' nodes): n dA under 1e-10 of the area on all
      145 Jubilee solids (worst 3.2e-11, body 103), volume per mm of the reference point under 1e-9 on all (worst
      1.4e-11, body 142), and moving v* to the top of every face moves no volume by more than 2.0e-11 (body 142) and no
      area by more than 1.4e-11. brep tests 107/107.
- [ ] 1.2 Import into the modeler: STEP, SAT, Parasolid and JT B-reps read as modeler bodies, so every operation (and
      mass properties, checking, healing, export) works on imported parts, not only on shapes built in Margo.
      Written and on main for STEP (model.bodiesFromSTEP; SAT, XT and JT through their readers' B-reps). On 200 imported
      corpus parts Codex measured cuts valid on 84 (OpenCascade 200) and fillets on 4 (OpenCascade 67), 304 throws.
      Claude's drill check (2026-10-20, a hole through the middle of each Jubilee solid): 78 of 145 valid after the
      mass and apex fixes; of the 67 failures 62 are spline faces (3.1), 2 tangential contacts (3.2), 2 results with an
      edge off its surface, 1 a probe sizing slip. Imported cones (a face covering or running through its apex) now cut.
      Later the same day (spline Booleans and tolerant edges, below): 127 of 145; then 144 of 145 after fixing curve
      crossings with every sheet of a spline, traces seeded on or past a spline's edge, and sampling of long rational
      curves (the drill now sized from the mesh); 145 of 145 once near contact (3.2) cut Jubilee 104, where the
      mesh-sized drill is within 0.34 nm of grazing a 3 mm rib.
- [ ] 1.3 Topology checker: Euler-Poincare (V - E + F - (L - F) - 2(S - G) = 0), every edge used twice and oppositely in
      a solid, consistent orientation, no face crossing another; run on every file read and every operation result.
      Written (claude/kernel): validateBody (Euler-Poincare, one piece per shell) on every operation and import;
      checkBody (orientation by enclosed volume, crossing edges of a face, edges through faces); extrude and revolve
      refuse self-touching profiles. Left: two faces crossing in a closed curve that meets no edge of either.
- [ ] 1.4 Crash immunity: every operation bounded (time and iteration limits on intersection, tracing and blend
      searches); every failure a typed error naming the cause; no unhandled exception on any input.
      Open, found by `node scripts/brep-stress/bad-input.mjs` (2026-10-24; each case returns a body instead of a
      typed error):
      - `G-sphere-Infinity`: `model.sphere(name, Infinity)`.
      - `G-torus-major-Infinity`: `model.torus(name, Infinity, 0.001)`.
      - `G-frame-origin-NaN`, `G-frame-origin-Infinity`: `model.frameOf([v, 0, 0], [0, 0, 1])`.
      - `G-frame-x-NaN`, `G-frame-x-Infinity`: `model.frameOf([0, 0, 0], [0, 0, 1], [v, 0, 0])`.
      - `G-step-missing-ref`: a box's STEP whose MANIFOLD_SOLID_BREP points at a missing entity (#999999) imports
        through `bodiesFromSTEP` as one body with no problems reported.
      - `G-step-bad-number`: the same STEP with a CARTESIAN_POINT coordinate written `NaN` imports as one body with
        no problems reported.
- [ ] 1.5 Harnesses: an ABC Dataset slice runner, a sweep-and-jitter fuzzer for every operation, and a STEP round trip
      runner (OpenCascade reader and mesher, then FreeCAD's command line).
      Started: `scripts/brep-stress` (seeded primitives and Booleans, blends and profiles, bad input, corpus).
      Open, found by `node scripts/brep-stress/primitives.mjs --matrix=staged --match=A/box-sphere/s1/overlap`
      (2026-10-24): `A/box-sphere/s1/overlap` (1 mm box, sphere offset -0.69 mm): the Boolean results' STEP round trip
      changes their volume: subtract 6.294e-10 -> 6.456e-10 m^3, union 1.153e-9 -> 6.456e-10, intersect (moved)
      3.706e-10 -> 3.467e-10, swapped subtract 1.530e-10 -> -3.485e-10; the same under repeat and rigid motion.

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
      integrals within 1e-7 (1e-6 spline on spline); Jubilee drills pass on 145 of 145 solids (78 before; the last
      needed near contact, 3.2). Left:
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
      drill's section (203.2639 mm3 both).
      Near contact, written 2026-10-20 (claude/epic-torvalds-ee13dd): surfaces within the Booleans' tolerance (1e-6 of
      the model) of touching are cut as if they touched. A walk heading into a point where the normals turn parallel
      finds it (Newton's method on the curvature difference, midway between the surfaces) and goes straight through,
      so curves passing a few micrometres apart there cross as at an exact touch; where the surfaces curve apart every
      way (a kiss) the micrometre loop round the point is dropped. A plane or cylinder along a cylinder within the
      tolerance gives one line, and an edge dipping into a face by less than it touches the face at one point. Tested
      against closed forms: the rib, the tee and the tee with 3 mm fillets (kisses) with the drill 0.1 nm off centre
      either way (all three operations, two seams, within 1e-9), and the slanted hole 1 and 10 nm either side of
      touching (three seams, within 1e-6 of the quadrature). Jubilee 104 with the survey's drill (0.34 nm short of one
      wall, 0.28 nm into the other): valid in all three operations, common part 203.263868 mm3, subtract + intersect
      - part = 7.6e-5 mm3 (as with the exact 1.5 mm drill); the survey drills 145 of 145.
      Near misses, written 2026-10-20 (claude/jovial-goodall-b5bedd): where the surfaces come a little further than the
      tolerance from touching, the curves passing each other there are traced apart. A walk that finds such a point
      (as it finds a touch), or starts from a seed near it, keeps every step under a quarter of its distance from the
      point (or of the width of the turn), so it follows the turn and never steps onto the other curve; a trace that
      found one is redone knowing it. Before, a seed 5.6 um from the point started a walk that hopped between the two
      windows' curves and went round eight times. The slanted hole 30, 50 and 100 nm either side of touching (three
      seams) now cuts within 1e-6 of the quadrature (was refused in 8 of 18 cases), and every offset tried from 0.1 nm
      to 10 um either side cuts within 6.1e-10 of it (90 cuts).
      Near misses at face edges, written 2026-10-20 (claude/charming-clarke-5e6c76): a face split where a curve passes
      a little further than the tolerance inside its edge keeps its regions. Each region's point inside is now the one
      furthest from every loop (from the middles of each loop's eight longest segments), not the middle of the longest
      segment, which for the rib's top face lay 15 nm from the drill and was taken to lie on the drill's face. A point
      within the tolerance of the other solid's face counts as on it only where the faces run along each other (normals
      within a milliradian); a sliver thinner than the tolerance next to where a surface crosses it (the base's top
      under the drill's 30 nm bite out of the rib's wall) is settled by the rays. The rib, tee and rounded tee with the
      drill 30 and 100 nm off centre now cut in all 72 cases (27 refused before) within 1.4e-11 of closed forms with
      the sliver (a circular segment of height |off|, the part in the fillet by quadrature); offsets from 0.01 nm to
      10 um either side all cut. Jubilee survey 145 of 145, every drilled volume identical to before.
      Contact along curves, tori cut round the tube, coincident spline faces, written 2026-10-20 (same branch):
      - A torus face whose loops go round its tube (a box face through the axis) is worked in (v, u): the loops of one
        face on a torus all go round the same way. Where the face holds every circle round the tube (a torus with a
        hole drilled through the tube) its mass integrates across the cut it is opened at; it threw before.
      - Surfaces touching along a circle or a curve cut neither face there. Coaxial pairs within the tolerance give one
        circle; a region's point inside is taken from several, skipping any where the other face only touches it (it
        must lie within the tolerance all round to count as on it). Traced pairs: seeds where the normals are parallel
        within 1e-6 are skipped (a meridian lying in the other surface seeds at its rounding errors); a curve crossing
        a curve of touching is walked straight through it and a vertex goes there; within the tolerance of touching
        along a curve, the curves turned back along it a hair from it are cut there and joined across it.
      - Steps are short enough that the middle of each cubic lies within 1e-10 of the model of the curve: where the
        surfaces are nearly tangent a 1 nm stray off them put the two faces' edges 0.2 um apart (volumes 3e-7 off).
      - Spline faces on one surface (a second copy, pieces of one patch with their own control points, a patch carried
        on past the other's edge) overlap as planes do and merge onto a patch that holds them all; an edge found again
        as a plane's curve along it is that edge (their middles by parameter differ).
      Tested against closed forms or quadrature, all three operations: a half and a quarter torus, a torus cut 10 mm off
      its axis, a drilled torus (4e-11 of Gauss quadrature); a ball in a bore and in a torus's tube, a ring on a plane,
      in a bore and round a bore, exactly, 0.1 nm either way and 100 nm or 1 um past (within 1e-11); a cylinder of the
      tube's radius along the torus, exactly and 1e-12 mm to 1e-3 mm either way (within 6e-11 of quadrature); a pipe
      elbow with a pipe running on from its end and 3 mm into it, the pipe's seam through the crossing (2e-11); the
      bump block against a second copy, its halves and middle, the patch carried on to x = 15 and from x = -4, lifted
      0.1 nm and 1 um (exact, or within 3e-10). The slanted hole now cuts within 3e-11 of quadrature 30 nm out and
      beyond (6e-10 before). Jubilee survey 145 of 145 (55 s; main 52 s); 84 drilled volumes moved, by 2.6e-7 at most.
      The five that moved most came nearer: subtract + intersect - part on bodies 83, 29, 31, 28 fell from 2.6e-7,
      1.9e-7, 1.2e-7, 5.7e-8 to 1.4e-8, 2e-14, 3e-9, 3e-12; body 121 stays 2e-5 off (its subtract larger than the part,
      as before).
      Faces apart by more than the tolerance but within their vertices' own, written 2026-10-20
      (claude/xenodochial-neumann-258b52): a vertex lies on the faces it bounds within its own tolerance (a vertex on an
      imported edge a little off its face), on the other solid's faces within the Booleans' 1e-6 of the model alone.
      Before, a curve stopped at any vertex within the vertex's tolerance (1e-7 m unless measured wider) while new
      points merged only within 1e-6 of the model: two boxes side by side, one 30-100 nm taller, got two vertices 50 nm
      apart at each end of the curve the lower top cuts from the taller box's side, and the split left an open chain.
      Now that curve stops where the taller box's edges cross the lower top, and the step is a face of its own. Taking
      the default tolerance as no gap at all instead (tried first) broke an imported edge 38-75 nm off its face, which
      keeps the default. A region thinner than its edges' samples stray from their curves (the bump block against its
      patch carried on and lifted 30-100 nm: a band that wide between two splines whose 128 spans stray 60 nm) is traced
      again with the spans halved where they stray more than an eighth of its width; its point inside lay outside the
      band before. Halving every span 4 to 64 times instead (tried first) cost Jubilee 30% (one body 9x: spline faces
      whose 213 mm edges bend tightly, their spans straying 0.35 mm beside regions 20-100 um wide). Tested: the two
      boxes 20 nm to 1 um apart either way, all three operations exact (within 1e-12, union 8 faces); the bump block
      against its patch carried on to x = 15, 30 nm up and 100 nm down, within 1e-10 of the Gauss integrals (in probes,
      30-100 nm either way on that patch, its middle and the one from x = -4, all within 1.3e-11); the bump block with
      its front edge 38 and 75 nm off the top cut by a box in all three operations. The RangeError test is now a plane
      touching a torus twice (its Villarceau circles go round both ways). Jubilee survey 145 of 145 (50 s), every
      drilled volume identical to 7c0e1d6b's; the drills' Boolean time 5% more (30.4 s against 29.1 s, both in one
      process).
      Left: body 121, Codex's corpus check, OpenCascade comparison.

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
